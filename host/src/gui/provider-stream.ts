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
  | {
      readonly kind: "tool_end";
      readonly toolId: string;
      readonly toolName: string;
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
      readonly operation: string;
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
  return [];
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
    const toolId = readString(block, "id") ?? readString(event, "index") ?? "tool";
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
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
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
      events.push({
        kind: "tool_start",
        toolId,
        toolName,
        input: Reflect.get(entry, "input") ?? null,
      });
      events.push({ kind: "tool_end", toolId, toolName });
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
  if (type !== "item.completed" && type !== "item.updated" && type !== "item.started") {
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
    const exitCode = readNumber(item, "exit_code") ?? readNumber(item, "exitCode");
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
    readNumber(value, "input_tokens") ??
    readNumber(value, "inputTokens") ??
    0;
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
      if (change === null || typeof change !== "object" || Array.isArray(change)) {
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
          readString(change, "kind") ??
          readString(change, "operation") ??
          "update",
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
      operation: readString(item, "operation") ?? "update",
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
