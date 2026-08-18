/**
 * Port of recovered ClaudeConverter (`S5i` / `bIg` / `_Ig` / `KIg` / `PIg`)
 * from host-bundle.strings.cjs (case 20260810-traycer-host, phase 18).
 *
 * Nested messages with parent_tool_use_id are dropped. Stream events unwrap
 * `.event`. thinking_delta reads `delta.thinking`, not `delta.text`.
 */

export type DecodedEvent =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly blockId: string | null;
    }
  | {
      readonly kind: "reasoning";
      readonly text: string;
      readonly blockId: string | null;
    }
  | { readonly kind: "session"; readonly sessionId: string }
  | {
      readonly kind: "tool_start";
      readonly blockId: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly kind: "tool_end";
      readonly blockId: string;
      readonly name: string;
    }
  | { readonly kind: "control_request"; readonly requestId: string }
  | { readonly kind: "result" };

export type ClaudeConvertState = {
  currentMessageId: string | null;
  readonly contentBlocks: Map<
    number,
    {
      readonly blockId: string;
      readonly type: "text" | "reasoning" | "tool";
      readonly toolName: string | null;
    }
  >;
};

export function createClaudeConvertState(): ClaudeConvertState {
  return { currentMessageId: null, contentBlocks: new Map() };
}

export function convertClaudeMessage(
  value: unknown,
  state: ClaudeConvertState,
): DecodedEvent[] {
  if (!isRecord(value)) {
    return [];
  }
  if (hasParentToolUseId(value)) {
    return [];
  }
  switch (value.type) {
    case "assistant":
      return convertAssistant(value, state);
    case "stream_event":
      return isRecord(value.event)
        ? convertStreamEvent(value.event, state)
        : [];
    case "result":
      return [{ kind: "result" }];
    case "system":
      return sessionEvents(value);
    case "user":
      return convertUserToolResults(value);
    case "tool_progress":
      return [];
    case "control_request":
      return controlRequest(value);
    default:
      return sessionEvents(value);
  }
}

function convertAssistant(
  value: { readonly [key: string]: unknown },
  state: ClaudeConvertState,
): DecodedEvent[] {
  const out: DecodedEvent[] = [...sessionEvents(value)];
  if (!isRecord(value.message) || !Array.isArray(value.message.content)) {
    return out;
  }
  const messageId =
    typeof value.message.id === "string" ? value.message.id : "msg";
  state.currentMessageId = messageId;
  value.message.content.forEach((part, index) => {
    if (!isRecord(part)) {
      return;
    }
    if (part.type === "text" && typeof part.text === "string") {
      const blockId = `${messageId}-text-${String(index)}`;
      out.push({ kind: "text", text: part.text, blockId });
      return;
    }
    if (part.type === "thinking" && typeof part.thinking === "string") {
      out.push({
        kind: "reasoning",
        text: part.thinking,
        blockId: `${messageId}-thinking-${String(index)}`,
      });
      return;
    }
    if (part.type === "tool_use") {
      if (part.name === "ExitPlanMode") {
        return;
      }
      const blockId =
        typeof part.id === "string" ? part.id : `tool-${String(index)}`;
      const name = typeof part.name === "string" ? part.name : "tool";
      out.push({
        kind: "tool_start",
        blockId,
        name,
        input: part.input ?? null,
      });
    }
  });
  return out;
}

function convertStreamEvent(
  event: { readonly [key: string]: unknown },
  state: ClaudeConvertState,
): DecodedEvent[] {
  switch (event.type) {
    case "message_start":
      if (isRecord(event.message) && typeof event.message.id === "string") {
        state.currentMessageId = event.message.id;
      }
      return [];
    case "content_block_start":
      return convertBlockStart(event, state);
    case "content_block_delta":
      return convertBlockDelta(event, state);
    case "content_block_stop":
      return convertBlockStop(event, state);
    case "message_stop":
      state.currentMessageId = null;
      state.contentBlocks.clear();
      return [];
    default:
      return [];
  }
}

function convertBlockStart(
  event: { readonly [key: string]: unknown },
  state: ClaudeConvertState,
): DecodedEvent[] {
  if (!isRecord(event.content_block)) {
    return [];
  }
  const index = typeof event.index === "number" ? event.index : 0;
  const messageId = state.currentMessageId ?? "msg";
  const block = event.content_block;
  if (block.type === "text") {
    const blockId = `${messageId}-text-${String(index)}`;
    state.contentBlocks.set(index, {
      blockId,
      type: "text",
      toolName: null,
    });
    const text = typeof block.text === "string" ? block.text : "";
    return text.length > 0 ? [{ kind: "text", text, blockId }] : [];
  }
  if (block.type === "thinking") {
    const blockId = `${messageId}-thinking-${String(index)}`;
    state.contentBlocks.set(index, {
      blockId,
      type: "reasoning",
      toolName: null,
    });
    const thinking = typeof block.thinking === "string" ? block.thinking : "";
    return thinking.length > 0
      ? [{ kind: "reasoning", text: thinking, blockId }]
      : [];
  }
  if (block.type === "tool_use") {
    if (block.name === "ExitPlanMode") {
      return [];
    }
    const blockId =
      typeof block.id === "string" ? block.id : `tool-${String(index)}`;
    const name = typeof block.name === "string" ? block.name : "tool";
    state.contentBlocks.set(index, {
      blockId,
      type: "tool",
      toolName: name,
    });
    return [
      {
        kind: "tool_start",
        blockId,
        name,
        input: block.input ?? null,
      },
    ];
  }
  return [];
}

function convertBlockDelta(
  event: { readonly [key: string]: unknown },
  state: ClaudeConvertState,
): DecodedEvent[] {
  if (!isRecord(event.delta)) {
    return [];
  }
  const index = typeof event.index === "number" ? event.index : 0;
  const messageId = state.currentMessageId ?? "msg";
  const delta = event.delta;
  if (delta.type === "text_delta" && typeof delta.text === "string") {
    const existing = state.contentBlocks.get(index);
    const blockId = existing?.blockId ?? `${messageId}-text-${String(index)}`;
    return [{ kind: "text", text: delta.text, blockId }];
  }
  if (delta.type === "thinking_delta") {
    const thinking =
      typeof delta.thinking === "string"
        ? delta.thinking
        : typeof delta.text === "string"
          ? delta.text
          : "";
    if (thinking.length === 0) {
      return [];
    }
    const existing = state.contentBlocks.get(index);
    const blockId =
      existing?.blockId ?? `${messageId}-thinking-${String(index)}`;
    return [{ kind: "reasoning", text: thinking, blockId }];
  }
  return [];
}

function convertBlockStop(
  event: { readonly [key: string]: unknown },
  state: ClaudeConvertState,
): DecodedEvent[] {
  const index = typeof event.index === "number" ? event.index : 0;
  const existing = state.contentBlocks.get(index);
  state.contentBlocks.delete(index);
  // Recovered qIg: tool blocks do not finalize on content_block_stop.
  if (existing === undefined || existing.type === "tool") {
    return [];
  }
  return [];
}

function convertUserToolResults(value: {
  readonly [key: string]: unknown;
}): DecodedEvent[] {
  const out: DecodedEvent[] = [...sessionEvents(value)];
  if (!isRecord(value.message) || !Array.isArray(value.message.content)) {
    return out;
  }
  for (const part of value.message.content) {
    if (!isRecord(part) || part.type !== "tool_result") {
      continue;
    }
    const blockId =
      typeof part.tool_use_id === "string" ? part.tool_use_id : null;
    if (blockId === null) {
      continue;
    }
    out.push({ kind: "tool_end", blockId, name: "tool" });
  }
  return out;
}

function sessionEvents(value: {
  readonly [key: string]: unknown;
}): DecodedEvent[] {
  const sessionId =
    typeof value.session_id === "string" && value.session_id.length > 0
      ? value.session_id
      : isRecord(value.message) && typeof value.message.session_id === "string"
        ? value.message.session_id
        : null;
  return sessionId === null ? [] : [{ kind: "session", sessionId }];
}

function controlRequest(value: {
  readonly [key: string]: unknown;
}): DecodedEvent[] {
  const requestId =
    typeof value.request_id === "string"
      ? value.request_id
      : isRecord(value.request) && typeof value.request.request_id === "string"
        ? value.request.request_id
        : null;
  return requestId === null ? [] : [{ kind: "control_request", requestId }];
}

function hasParentToolUseId(value: {
  readonly [key: string]: unknown;
}): boolean {
  return (
    typeof value.parent_tool_use_id === "string" &&
    value.parent_tool_use_id.length > 0
  );
}

function isRecord(
  value: unknown,
): value is { readonly [key: string]: unknown } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
