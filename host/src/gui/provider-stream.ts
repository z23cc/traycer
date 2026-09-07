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
  /**
   * A sub-agent the harness spawned. Claude reports the whole life of one on
   * the PARENT's stream - a `task_started`, a rotating `task_progress`, and a
   * terminal `task_notification` - keyed by a task id that is not the id of
   * the tool call that spawned it. Both are carried: the task id owns the
   * card, and the tool id is what lets the GUI drop the duplicate `Task` row
   * in front of it.
   */
  | {
      readonly kind: "subagent_start";
      readonly taskId: string;
      readonly name: string;
      readonly task: string | null;
      readonly agentType: string | null;
      readonly spawnToolId: string | null;
    }
  | {
      readonly kind: "subagent_progress";
      readonly taskId: string;
      readonly update: string;
    }
  | {
      readonly kind: "subagent_end";
      readonly taskId: string;
      readonly outcome: "completed" | "failed" | "stopped";
      readonly result: string | null;
    }
  /**
   * A record from a sub-agent's own transcript, which Claude writes to the
   * PARENT's stream tagged with the tool call that spawned the child. Carried
   * whole rather than flattened: the events inside are the child's, and the
   * reader nests or suppresses them under the child's card by the protocol's
   * own policy (`subagent-nesting.ts`) - never files them as the parent's.
   */
  | {
      readonly kind: "child";
      readonly parentToolUseId: string;
      readonly events: readonly ProviderStreamEvent[];
    }
  /**
   * Claude asking whether a tool may run, over the stdio permission channel
   * (`--permission-prompt-tool stdio`). Recorded live: the request names the
   * tool, its input, a description, and the call's id - and the run waits
   * for a `control_response` on stdin before doing anything else.
   */
  | {
      readonly kind: "permission_request";
      readonly requestId: string;
      readonly toolUseId: string | null;
      readonly toolName: string;
      readonly description: string;
      readonly input: unknown;
    }
  /**
   * The turn is over, with or without a fault: Codex's `turn/completed`, or
   * Claude's `result` record - which is the end even when it counts nothing
   * (`num_turns: 0` and zero usage, recorded live after `/compact`).
   */
  | {
      readonly kind: "turn_end";
      readonly status: string;
      readonly error: string | null;
    }
  /** A JSON-RPC error answering one of this host's own requests. */
  | { readonly kind: "transport_error"; readonly message: string }
  /**
   * A server request this host does not serve. Surfaced rather than dropped
   * so the driver can answer it with an error: an unanswered request holds
   * the turn open forever.
   */
  | {
      readonly kind: "rpc_unsupported";
      readonly requestId: string;
      readonly method: string;
    }
  /**
   * Claude compacting its context, recorded live around `/compact`: a
   * `status: "compacting"` record, then either `compact_result: "failed"`
   * with the reason or a `compact_boundary` carrying the numbers.
   */
  | { readonly kind: "compaction_started" }
  | { readonly kind: "compaction_failed"; readonly error: string }
  | {
      readonly kind: "compaction_completed";
      readonly trigger: "auto" | "manual" | null;
      readonly preTokens: number | null;
      readonly postTokens: number | null;
      readonly durationMs: number | null;
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
  // The app-server's frames are JSON-RPC by shape and not by label: recorded
  // live, neither its responses nor its notifications carry a `jsonrpc`
  // field. A Claude record always has a `type`; a frame with a method, or an
  // id with a result or error, is the server talking.
  if (
    typeof Reflect.get(parsed, "type") !== "string" &&
    (typeof Reflect.get(parsed, "method") === "string" ||
      (Reflect.get(parsed, "id") !== undefined &&
        ("result" in parsed || "error" in parsed)))
  ) {
    return codexRpcEvents(parsed);
  }
  return [
    ...sessionEvents(parsed),
    ...usageEvents(parsed),
    ...claudeEvents(parsed),
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
  // A record belonging to a sub-agent, and not to this turn. The parent's
  // stream carries the child's whole transcript inline; without this wrap the
  // child's tool calls arrive as the main agent's and its closing text is
  // appended to the main reply. Read before the type dispatch: it is a
  // top-level field on every child record, whatever its type, and the
  // `system` task records that DO describe the child never carry it.
  const parentToolUseId = readString(record, "parent_tool_use_id");
  const events = claudeRecordEvents(record);
  if (parentToolUseId === null) {
    return events;
  }
  return events.length === 0
    ? []
    : [{ kind: "child", parentToolUseId, events }];
}

function claudeRecordEvents(record: object): ProviderStreamEvent[] {
  const type = readString(record, "type");
  if (type === "control_request") {
    return claudePermissionRequest(record);
  }
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
  if (type === "result") {
    const subtype = readString(record, "subtype");
    const failed = subtype !== null && subtype !== "success";
    return [
      {
        kind: "turn_end",
        status: failed ? "failed" : "completed",
        error: failed
          ? (readString(record, "result") ?? subtype ?? "Claude turn failed")
          : null,
      },
    ];
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
  const subtype = readString(record, "subtype");
  if (subtype === "task_started") {
    return claudeTaskStarted(record);
  }
  if (subtype === "task_progress") {
    return claudeTaskProgress(record);
  }
  // Both terminal records are read. `task_updated` carries the status and
  // nothing else; `task_notification` carries the summary and arrives after
  // it. The accumulator replaces the block in place and keeps a result it
  // already has, so the two compose into one card rather than fighting.
  if (subtype === "task_updated" || subtype === "task_notification") {
    return claudeTaskEnded(record, subtype);
  }
  if (subtype === "status") {
    if (readString(record, "status") === "compacting") {
      return [{ kind: "compaction_started" }];
    }
    if (readString(record, "compact_result") === "failed") {
      return [
        {
          kind: "compaction_failed",
          error: readString(record, "compact_error") ?? "Compaction failed",
        },
      ];
    }
    return [];
  }
  if (subtype === "compact_boundary") {
    const metadata = Reflect.get(record, "compact_metadata");
    const meta =
      metadata !== null && typeof metadata === "object" ? metadata : {};
    const trigger = readString(meta, "trigger");
    return [
      {
        kind: "compaction_completed",
        trigger: trigger === "auto" || trigger === "manual" ? trigger : null,
        preTokens: readNumber(meta, "pre_tokens"),
        postTokens: readNumber(meta, "post_tokens"),
        durationMs: readNumber(meta, "duration_ms"),
      },
    ];
  }
  if (subtype !== "api_retry") {
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

function claudePermissionRequest(record: object): ProviderStreamEvent[] {
  const requestId = readString(record, "request_id");
  const request = Reflect.get(record, "request");
  if (requestId === null || request === null || typeof request !== "object") {
    return [];
  }
  // The one control subtype this host answers. Anything else on the channel
  // is left unanswered rather than mis-answered.
  if (readString(request, "subtype") !== "can_use_tool") {
    return [];
  }
  const toolName = readString(request, "tool_name");
  if (toolName === null) {
    return [];
  }
  return [
    {
      kind: "permission_request",
      requestId,
      toolUseId: readString(request, "tool_use_id"),
      toolName,
      description:
        readString(request, "description") ?? `Claude wants to use ${toolName}`,
      input: Reflect.get(request, "input") ?? {},
    },
  ];
}

function claudeTaskStarted(record: object): ProviderStreamEvent[] {
  const taskId = readString(record, "task_id");
  if (taskId === null) {
    return [];
  }
  // Every task the CLI runs reports here, a plain Bash call included
  // (`task_type: "local_bash"`, recorded live around a `sleep`). Only one
  // with a prompt of its own is an agent's; the rest are the tool call they
  // belong to, already on its own card.
  const prompt = readString(record, "prompt");
  if (
    prompt === null ||
    prompt.trim().length === 0 ||
    readString(record, "task_type") === "local_workflow" ||
    Reflect.get(record, "skip_transcript") === true
  ) {
    return [];
  }
  const description = readString(record, "description");
  const subagentType = readString(record, "subagent_type");
  return [
    {
      kind: "subagent_start",
      taskId,
      // The card needs a title. The description is the one the agent wrote for
      // this run; the type is what it wrote it for.
      name: description ?? subagentType ?? "Subagent",
      task: readString(record, "prompt"),
      agentType: subagentType,
      spawnToolId: readString(record, "tool_use_id"),
    },
  ];
}

function claudeTaskProgress(record: object): ProviderStreamEvent[] {
  const taskId = readString(record, "task_id");
  const update = readString(record, "description");
  if (taskId === null || update === null) {
    return [];
  }
  return [{ kind: "subagent_progress", taskId, update }];
}

function claudeTaskEnded(
  record: object,
  subtype: string,
): ProviderStreamEvent[] {
  const taskId = readString(record, "task_id");
  if (taskId === null) {
    return [];
  }
  const patch = Reflect.get(record, "patch");
  const status =
    subtype === "task_notification"
      ? readString(record, "status")
      : patch === null || typeof patch !== "object"
        ? null
        : readString(patch, "status");
  if (status === null) {
    return [];
  }
  // Only a terminal status this host can actually read closes the card: a
  // running task reports its status too, and a word we cannot read is not
  // evidence of an ending. Either way the card stays open, and the turn's own
  // terminal event finalizes it - which is the contract's answer for "nobody
  // said how this ended".
  const outcome = subagentOutcome(status);
  if (outcome === null || outcome === "running") {
    return [];
  }
  return [
    {
      kind: "subagent_end",
      taskId,
      outcome,
      result: readString(record, "summary"),
    },
  ];
}

/**
 * The words this host is willing to read off a task status.
 *
 * Anything else is `null`, which leaves the wire field unset and the contract
 * to apply its own default - the alternative being to call an outcome we
 * could not read a completion.
 */
function subagentOutcome(
  status: string,
): "completed" | "failed" | "stopped" | "running" | null {
  const word = status.toLowerCase();
  if (word === "completed" || word === "succeeded" || word === "success") {
    return "completed";
  }
  if (word === "failed" || word === "error" || word === "errored") {
    return "failed";
  }
  if (word === "stopped" || word === "cancelled" || word === "canceled") {
    return "stopped";
  }
  if (word === "running" || word === "in_progress" || word === "pending") {
    return "running";
  }
  return null;
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

/**
 * Codex's app-server, as JSON-RPC over stdio. Three shapes share the pipe:
 * notifications (`method` + `params`), server requests (those plus an `id`,
 * which must be answered), and responses to this host's own requests (`id`
 * + `result` or `error`). The driver in `deliver.ts` owns the requests it
 * sent; this reads everything else. Recorded live against codex-cli 0.153.4.
 */
function codexRpcEvents(record: object): ProviderStreamEvent[] {
  const method = readString(record, "method");
  const id = Reflect.get(record, "id");
  if (method === null) {
    const error = Reflect.get(record, "error");
    if (error !== null && typeof error === "object") {
      return [
        {
          kind: "transport_error",
          message: readString(error, "message") ?? "Codex app-server error",
        },
      ];
    }
    return [];
  }
  const params = Reflect.get(record, "params");
  const paramsRecord =
    params !== null && typeof params === "object" ? params : {};
  if (id !== undefined && id !== null) {
    return codexServerRequest(method, JSON.stringify(id), paramsRecord);
  }
  return codexNotification(method, paramsRecord);
}

/**
 * The server asking this host something. Approvals become permission
 * requests, decided by the same rules as Claude's; the ids are the JSON-RPC
 * ids, carried as text so the answer can quote them back exactly.
 */
function codexServerRequest(
  method: string,
  requestId: string,
  params: object,
): ProviderStreamEvent[] {
  const itemId = readString(params, "itemId");
  if (method === "item/commandExecution/requestApproval") {
    return [
      {
        kind: "permission_request",
        requestId,
        toolUseId: itemId,
        toolName: "command",
        description:
          readString(params, "command") ??
          readString(params, "reason") ??
          "Command execution",
        input: params,
      },
    ];
  }
  if (method === "item/fileChange/requestApproval") {
    // The paths are on the `item/started` that preceded this, not here: the
    // reader pairs them by item id.
    return [
      {
        kind: "permission_request",
        requestId,
        toolUseId: itemId,
        toolName: "apply_patch",
        description: readString(params, "reason") ?? "Apply file changes",
        input: params,
      },
    ];
  }
  if (method === "item/permissions/requestApproval") {
    return [
      {
        kind: "permission_request",
        requestId,
        toolUseId: itemId,
        toolName: "permissions",
        description: readString(params, "reason") ?? "Permissions",
        input: params,
      },
    ];
  }
  if (method === "item/tool/requestUserInput") {
    // Codex's question to the user. The tool name is the released host's,
    // and it is what routes this to an interview rather than an approval.
    return [
      {
        kind: "permission_request",
        requestId,
        toolUseId: itemId ?? requestId,
        toolName: "request_user_input",
        description: "Codex needs your input",
        input: params,
      },
    ];
  }
  return [{ kind: "rpc_unsupported", requestId, method }];
}

function codexNotification(
  method: string,
  params: object,
): ProviderStreamEvent[] {
  if (method === "thread/started") {
    const thread = Reflect.get(params, "thread");
    const sessionId =
      thread !== null && typeof thread === "object"
        ? readString(thread, "id")
        : null;
    return sessionId === null ? [] : [{ kind: "session", sessionId }];
  }
  if (method === "item/agentMessage/delta") {
    const delta = readString(params, "delta");
    return delta === null ? [] : [{ kind: "delta", text: delta }];
  }
  if (
    method === "item/reasoning/textDelta" ||
    method === "item/reasoning/summaryTextDelta"
  ) {
    const delta = readString(params, "delta");
    return delta === null ? [] : [{ kind: "reasoning", text: delta }];
  }
  if (method === "thread/tokenUsage/updated") {
    return codexTokenUsage(params);
  }
  if (method === "turn/completed") {
    const turn = Reflect.get(params, "turn");
    const status =
      turn !== null && typeof turn === "object"
        ? (readString(turn, "status") ?? "completed")
        : "completed";
    const error =
      turn !== null && typeof turn === "object"
        ? Reflect.get(turn, "error")
        : null;
    return [
      {
        kind: "turn_end",
        status,
        error:
          error === null || typeof error !== "object"
            ? typeof error === "string"
              ? error
              : null
            : (readString(error, "message") ?? JSON.stringify(error)),
      },
    ];
  }
  if (method !== "item/started" && method !== "item/completed") {
    return [];
  }
  const item = Reflect.get(params, "item");
  if (item === null || typeof item !== "object") {
    return [];
  }
  const itemType = readString(item, "type");
  const itemId = readString(item, "id") ?? itemType ?? "item";
  const completed = method === "item/completed";
  if (itemType === "agentMessage") {
    // The full text on completion. The deltas already streamed it, and the
    // reader dedupes a full message against what it has - see
    // `lineIncludesFullMessage`.
    const text = readString(item, "text");
    return completed && text !== null ? [{ kind: "delta", text }] : [];
  }
  if (itemType === "commandExecution") {
    const command = readString(item, "command") ?? "shell";
    if (!completed) {
      return [{ kind: "command_start", commandId: itemId, command }];
    }
    return [
      {
        kind: "command_end",
        commandId: itemId,
        command,
        exitCode: readNumber(item, "exitCode"),
      },
    ];
  }
  if (itemType === "fileChange") {
    // Started: one card per file, owned by the item - so the reader can take
    // its before now, ahead of the approval that gates the write. Completed:
    // the item's result, which closes those cards.
    return completed
      ? [{ kind: "tool_end", toolId: itemId }]
      : fileChangeEvents(item, itemId);
  }
  return [];
}

function codexTokenUsage(params: object): ProviderStreamEvent[] {
  const usage = Reflect.get(params, "tokenUsage");
  if (usage === null || typeof usage !== "object") {
    return [];
  }
  const last = Reflect.get(usage, "last");
  const total = Reflect.get(usage, "total");
  if (last === null || typeof last !== "object") {
    return [];
  }
  const inputTokens = readNumber(last, "inputTokens") ?? 0;
  const outputTokens = readNumber(last, "outputTokens") ?? 0;
  const contextTokens =
    total !== null && typeof total !== "undefined" && typeof total === "object"
      ? readNumber(total, "totalTokens")
      : null;
  return [
    {
      kind: "usage",
      usage: {
        inputTokens,
        outputTokens,
        totalTokens:
          readNumber(last, "totalTokens") ?? inputTokens + outputTokens,
        cacheReadInputTokens:
          readNumber(last, "cachedInputTokens") ?? undefined,
        contextTokens: contextTokens ?? undefined,
        contextWindow: readNumber(usage, "modelContextWindow") ?? undefined,
        costUsd: undefined,
      },
    },
  ];
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

function fileChangeEvents(item: object, itemId: string): ProviderStreamEvent[] {
  const changes = Reflect.get(item, "changes");
  if (!Array.isArray(changes)) {
    return [];
  }
  const rows: ProviderStreamEvent[] = [];
  for (const change of changes) {
    if (
      change === null ||
      typeof change !== "object" ||
      Array.isArray(change)
    ) {
      continue;
    }
    const path = readString(change, "path");
    if (path === null) {
      continue;
    }
    // `kind` is `{type: "add" | "delete" | "update"}` on the app-server.
    const kind = Reflect.get(change, "kind");
    const operation =
      kind !== null && typeof kind === "object"
        ? readString(kind, "type")
        : readString(change, "kind");
    rows.push({ kind: "file_change", path, operation, toolId: itemId });
  }
  return rows;
}

function readString(record: object, key: string): string | null {
  const value = Reflect.get(record, key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(record: object, key: string): number | null {
  const value = Reflect.get(record, key);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
