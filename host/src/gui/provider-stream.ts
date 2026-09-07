import type { RuntimeTodoItem } from "@traycer/protocol/host/agent/gui/agent-runtime";
import { todoStatusFromValue } from "@traycer/protocol/host/agent/gui/task-todo-tools";

export type ProviderTokenUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheReadInputTokens: number | undefined;
  readonly contextTokens: number | undefined;
  readonly contextWindow: number | undefined;
  readonly costUsd: number | undefined;
};

export type ProviderStreamEvent =
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "delta"; readonly text: string }
  | { readonly kind: "reasoning"; readonly text: string }
  | {
      readonly kind: "tool_start";
      readonly toolId: string;
      readonly toolName: string;
      readonly input: unknown;
    }
  /**
   * The tool's RESULT came back. Carries no name: the name was on the call,
   * and the caller already holds it against this id.
   */
  | { readonly kind: "tool_end"; readonly toolId: string }
  | {
      readonly kind: "tool_error";
      readonly toolId: string;
      readonly error: string;
    }
  /**
   * The provider rejected the run's credential. Claude Code announces this on
   * stdout as a retry record with a status, and it retries ten times before
   * giving up - which is a ten-minute wait on a condition that cannot clear.
   */
  | {
      readonly kind: "auth_failure";
      readonly status: number;
      readonly detail: string;
    }
  | {
      readonly kind: "command_start";
      readonly commandId: string;
      readonly command: string;
    }
  | {
      readonly kind: "command_end";
      readonly commandId: string;
      readonly command: string;
      readonly exitCode: number | null;
    }
  | {
      readonly kind: "file_change";
      readonly path: string;
      /**
       * The provider's own word for what happened, or null when only the file
       * system can say - a Claude edit names no operation, so the reader
       * decides from whether the path existed when the call opened.
       */
      readonly operation: string | null;
      /**
       * The tool call this change came out of, or null when the provider
       * reports changes on their own (Codex). Load-bearing for the block id:
       * the GUI replaces an edit TOOL CALL with the file card when the card's
       * id starts with the call's, and shows both when it does not.
       */
      readonly toolId: string | null;
    }
  /**
   * The harness's own todo list, from a `TodoWrite` call's input. Carries the
   * call's id so the block it produces is the one that call owns - a later
   * write replaces it in place rather than stacking a second list.
   */
  | {
      readonly kind: "todo";
      readonly toolId: string;
      readonly items: readonly RuntimeTodoItem[];
    }
  | { readonly kind: "usage"; readonly usage: ProviderTokenUsage };

export function parseProviderStdoutLine(line: string): ProviderStreamEvent[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }
  return [
    ...sessionEvents(parsed),
    ...usageEvents(parsed),
    ...claudeEvents(parsed),
    ...codexEvents(parsed),
  ];
}

function sessionEvents(record: object): ProviderStreamEvent[] {
  const sessionId =
    readString(record, "session_id") ??
    readString(record, "sessionId") ??
    readString(record, "thread_id") ??
    readString(record, "threadId");
  if (sessionId === null) {
    return [];
  }
  return [{ kind: "session", sessionId }];
}

function claudeEvents(record: object): ProviderStreamEvent[] {
  const type = readString(record, "type");
  if (type === "stream_event") {
    const event = Reflect.get(record, "event");
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      return [];
    }
    return claudeStreamEvent(event);
  }
  if (type === "assistant") {
    return claudeAssistantContent(Reflect.get(record, "message"));
  }
  // The half this parser used to drop entirely. Tool RESULTS come back as a
  // `user` record, and `is_error` on the block is the only place a failed tool
  // call is reported - without it a Bash that exited 1 rendered as a tool call
  // that completed.
  if (type === "user") {
    return claudeToolResults(Reflect.get(record, "message"));
  }
  if (type === "system") {
    return claudeSystemEvent(record);
  }
  return [];
}

/**
 * `{"type":"system","subtype":"api_retry","error_status":401,"error":
 * "authentication_failed"}` - the structured signal, rather than a match
 * against prose. Only 401 counts: a 429 or a 500 on the same record IS
 * transient and the retry is the right response to it.
 */
function claudeSystemEvent(record: object): ProviderStreamEvent[] {
  if (readString(record, "subtype") !== "api_retry") {
    return [];
  }
  const status = readNumber(record, "error_status");
  if (status !== 401) {
    return [];
  }
  return [
    {
      kind: "auth_failure",
      status,
      detail: readString(record, "error") ?? "authentication_failed",
    },
  ];
}

/**
 * Claude's file-editing tools, and the input key each names its target with.
 *
 * The GUI SUPPRESSES these tool calls in favour of the `file_change` card
 * (`suppressEditToolCalls`) and drops their bulk inputs from the persisted
 * detail (`tool-input-detail.ts`), so a host that never emits the card leaves
 * an edit as a bare tool row with its arguments stripped. Emitted here from
 * the same records that open the call.
 */
const CLAUDE_EDIT_TOOL_PATH_KEYS: ReadonlyMap<string, string> = new Map([
  ["edit", "file_path"],
  ["write", "file_path"],
  ["multiedit", "file_path"],
  ["notebookedit", "notebook_path"],
]);

function claudeFileChangeEvents(
  toolId: string,
  toolName: string,
  input: unknown,
): ProviderStreamEvent[] {
  const key = CLAUDE_EDIT_TOOL_PATH_KEYS.get(toolName.toLowerCase());
  if (key === undefined) {
    return [];
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return [];
  }
  const path = readString(input, key);
  if (path === null) {
    return [];
  }
  // `operation: null` on purpose: the input says what to write, never whether
  // the file was already there.
  return [{ kind: "file_change", path, operation: null, toolId }];
}

/**
 * `TodoWrite` is Claude Code's own checklist tool, and its input IS the list -
 * the whole list, every time, which is why a later call replaces the block
 * rather than merging into it.
 *
 * Emitted BESIDE the tool call rather than instead of it: the call happened,
 * and the pinned dock is a projection of it. The partial
 * `content_block_start` record carries `input: {}` and so produces nothing
 * here; the complete `assistant` record carries the list.
 */
function todoEvents(
  toolId: string,
  toolName: string,
  input: unknown,
): ProviderStreamEvent[] {
  if (toolName.toLowerCase() !== "todowrite") {
    return [];
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return [];
  }
  const todos = Reflect.get(input, "todos");
  if (!Array.isArray(todos)) {
    return [];
  }
  const items: RuntimeTodoItem[] = [];
  for (const entry of todos) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const text = readString(entry, "content") ?? readString(entry, "text");
    const status = todoStatusFromValue(Reflect.get(entry, "status"));
    if (text === null || status === null) {
      continue;
    }
    const activeForm = readString(entry, "activeForm");
    items.push({
      id: `${toolId}:${String(items.length)}`,
      text,
      status,
      ...(activeForm === null ? {} : { activeForm }),
    });
  }
  return items.length === 0 ? [] : [{ kind: "todo", toolId, items }];
}

function claudeToolResults(message: unknown): ProviderStreamEvent[] {
  if (
    message === null ||
    typeof message !== "object" ||
    Array.isArray(message)
  ) {
    return [];
  }
  const content = Reflect.get(message, "content");
  if (!Array.isArray(content)) {
    return [];
  }
  const events: ProviderStreamEvent[] = [];
  for (const entry of content) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    if (readString(entry, "type") !== "tool_result") {
      continue;
    }
    const toolId = readString(entry, "tool_use_id");
    if (toolId === null) {
      continue;
    }
    if (Reflect.get(entry, "is_error") !== true) {
      events.push({ kind: "tool_end", toolId });
      continue;
    }
    events.push({
      kind: "tool_error",
      toolId,
      error: toolResultText(Reflect.get(entry, "content")),
    });
  }
  return events;
}

/**
 * A tool result is a string or a list of blocks, and either can be the whole
 * output of a command.
 *
 * ponytail: truncated at a fixed ceiling rather than summarized - the field is
 * an unbounded `z.string()` on a frame every subscriber receives, and a failed
 * `cat` of a large file would otherwise put the file on the wire. Raise it if a
 * real error is ever cut off mid-sentence.
 */
const MAX_TOOL_ERROR_CHARS = 4_000;

function toolResultText(content: unknown): string {
  if (typeof content === "string") {
    return clampToolError(content);
  }
  if (!Array.isArray(content)) {
    return "Tool call failed.";
  }
  const parts: string[] = [];
  for (const entry of content) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const text = readString(entry, "text");
    if (text !== null) {
      parts.push(text);
    }
  }
  return parts.length === 0
    ? "Tool call failed."
    : clampToolError(parts.join("\n"));
}

function clampToolError(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return "Tool call failed.";
  }
  return trimmed.length <= MAX_TOOL_ERROR_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_TOOL_ERROR_CHARS)}…`;
}

function claudeStreamEvent(event: object): ProviderStreamEvent[] {
  const eventType = readString(event, "type");
  if (eventType === "content_block_start") {
    const block = Reflect.get(event, "content_block");
    if (block === null || typeof block !== "object" || Array.isArray(block)) {
      return [];
    }
    if (readString(block, "type") !== "tool_use") {
      return [];
    }
    const toolId =
      readString(block, "id") ?? readString(event, "index") ?? "tool";
    const toolName = readString(block, "name") ?? "tool";
    return [
      {
        kind: "tool_start",
        toolId,
        toolName,
        input: Reflect.get(block, "input") ?? null,
      },
    ];
  }
  if (eventType === "content_block_delta") {
    const delta = Reflect.get(event, "delta");
    if (delta === null || typeof delta !== "object" || Array.isArray(delta)) {
      return [];
    }
    const deltaType = readString(delta, "type");
    if (deltaType === "thinking_delta") {
      const text = readString(delta, "thinking") ?? readString(delta, "text");
      if (text !== null && text.length > 0) {
        return [{ kind: "reasoning", text }];
      }
    }
    const text = readString(delta, "text");
    if (text !== null && text.length > 0) {
      return [{ kind: "delta", text }];
    }
  }
  if (eventType === "content_block_stop") {
    return [];
  }
  const nested = Reflect.get(event, "delta");
  if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
    const text = readString(nested, "text");
    if (text !== null && text.length > 0) {
      return [{ kind: "delta", text }];
    }
  }
  return [];
}

function claudeAssistantContent(message: unknown): ProviderStreamEvent[] {
  if (
    message === null ||
    typeof message !== "object" ||
    Array.isArray(message)
  ) {
    return [];
  }
  const content = Reflect.get(message, "content");
  if (!Array.isArray(content)) {
    const text = readString(message, "text");
    return text === null ? [] : [{ kind: "delta", text }];
  }
  const events: ProviderStreamEvent[] = [];
  for (const entry of content) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const entryType = readString(entry, "type");
    if (entryType === "text") {
      const text = readString(entry, "text");
      if (text !== null && text.length > 0) {
        events.push({ kind: "delta", text });
      }
      continue;
    }
    if (entryType === "thinking") {
      const text = readString(entry, "thinking") ?? readString(entry, "text");
      if (text !== null && text.length > 0) {
        events.push({ kind: "reasoning", text });
      }
      continue;
    }
    if (entryType === "tool_use") {
      const toolId = readString(entry, "id") ?? "tool";
      const toolName = readString(entry, "name") ?? "tool";
      // Opened only. It closes when its `tool_result` arrives, which is the
      // only record that knows whether the call actually worked.
      const input = Reflect.get(entry, "input") ?? null;
      events.push({ kind: "tool_start", toolId, toolName, input });
      events.push(...todoEvents(toolId, toolName, input));
      events.push(...claudeFileChangeEvents(toolId, toolName, input));
    }
  }
  return events;
}

function codexEvents(record: object): ProviderStreamEvent[] {
  const type = readString(record, "type");
  if (type === "item.delta") {
    const delta = readString(record, "delta") ?? nestedItemText(record);
    if (delta !== null && delta.length > 0) {
      return [{ kind: "delta", text: delta }];
    }
    return [];
  }
  if (
    type !== "item.completed" &&
    type !== "item.updated" &&
    type !== "item.started"
  ) {
    return [];
  }
  const item = Reflect.get(record, "item");
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    return [];
  }
  const itemType = readString(item, "type");
  const itemId = readString(item, "id") ?? itemType ?? "item";
  if (itemType === "agent_message") {
    const text = readString(item, "text");
    if (text !== null && text.length > 0) {
      return [{ kind: "delta", text }];
    }
    return [];
  }
  if (itemType === "reasoning") {
    const text = readString(item, "text") ?? readString(item, "content");
    if (text !== null && text.length > 0) {
      return [{ kind: "reasoning", text }];
    }
    return [];
  }
  if (itemType === "command_execution") {
    const command = readString(item, "command") ?? "bash";
    if (type === "item.started" || type === "item.updated") {
      return [
        {
          kind: "command_start",
          commandId: itemId,
          command,
        },
      ];
    }
    const exitCode =
      readNumber(item, "exit_code") ?? readNumber(item, "exitCode");
    return [
      {
        kind: "command_end",
        commandId: itemId,
        command,
        exitCode,
      },
    ];
  }
  if (itemType === "file_change" || itemType === "file_change") {
    return fileChangeEvents(item);
  }
  return [];
}

function usageEvents(record: object): ProviderStreamEvent[] {
  const type = readString(record, "type");
  if (type === "result" || type === "turn.completed") {
    const usage = parseUsage(Reflect.get(record, "usage"), record);
    if (usage !== null) {
      return [{ kind: "usage", usage }];
    }
  }
  if (type === "token_usage" || type === "thread/tokenUsage/updated") {
    const usage = parseUsage(
      Reflect.get(record, "usage") ?? Reflect.get(record, "tokenUsage"),
      record,
    );
    if (usage !== null) {
      return [{ kind: "usage", usage }];
    }
  }
  return [];
}

function parseUsage(value: unknown, record: object): ProviderTokenUsage | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const inputTokens =
    readNumber(value, "input_tokens") ?? readNumber(value, "inputTokens") ?? 0;
  const outputTokens =
    readNumber(value, "output_tokens") ??
    readNumber(value, "outputTokens") ??
    0;
  const cacheRead =
    readNumber(value, "cache_read_input_tokens") ??
    readNumber(value, "cached_input_tokens") ??
    readNumber(value, "cacheReadInputTokens");
  const totalTokens =
    readNumber(value, "total_tokens") ??
    readNumber(value, "totalTokens") ??
    inputTokens + outputTokens;
  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) {
    return null;
  }
  const costUsd =
    readNumber(record, "total_cost_usd") ?? readNumber(value, "costUsd");
  const contextWindow =
    readNumber(value, "modelContextWindow") ??
    readNumber(record, "modelContextWindow");
  const contextTokens = cacheRead === null ? inputTokens : inputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadInputTokens: cacheRead ?? undefined,
    contextTokens,
    contextWindow: contextWindow ?? undefined,
    costUsd: costUsd ?? undefined,
  };
}

function fileChangeEvents(item: object): ProviderStreamEvent[] {
  const changes = Reflect.get(item, "changes");
  if (Array.isArray(changes) && changes.length > 0) {
    const rows: ProviderStreamEvent[] = [];
    for (const change of changes) {
      if (
        change === null ||
        typeof change !== "object" ||
        Array.isArray(change)
      ) {
        continue;
      }
      const path =
        readString(change, "path") ??
        readString(change, "filePath") ??
        readString(change, "filename");
      if (path === null) {
        continue;
      }
      rows.push({
        kind: "file_change",
        path,
        operation:
          readString(change, "kind") ?? readString(change, "operation"),
        toolId: null,
      });
    }
    return rows;
  }
  const path = readString(item, "path") ?? readString(item, "filePath");
  if (path === null) {
    return [];
  }
  return [
    {
      kind: "file_change",
      path,
      operation: readString(item, "operation"),
      toolId: null,
    },
  ];
}

function nestedItemText(record: object): string | null {
  const item = Reflect.get(record, "item");
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }
  return readString(item, "text") ?? readString(item, "delta");
}

function readString(record: object, key: string): string | null {
  const value = Reflect.get(record, key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(record: object, key: string): number | null {
  const value = Reflect.get(record, key);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
