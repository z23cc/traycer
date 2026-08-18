import {
  convertClaudeMessage,
  createClaudeConvertState,
  type ClaudeConvertState,
  type DecodedEvent,
} from "./claude-converter";

export type { DecodedEvent };

export type DecodedSink = (event: DecodedEvent) => void;

/**
 * NDJSON pump. Claude lines go through the recovered ClaudeConverter.
 * Non-JSON / Codex --json lines stay on the previous incremental-text path.
 */
export class OutputDecoder {
  private buffer = "";
  private emitted = "";
  private sessionEmitted = false;
  private readonly claude: ClaudeConvertState = createClaudeConvertState();

  push(chunk: string, sink: DecodedSink): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.consumeLine(line, sink);
      newline = this.buffer.indexOf("\n");
    }
  }

  flush(sink: DecodedSink): void {
    if (this.buffer.length === 0) {
      return;
    }
    this.consumeLine(this.buffer, sink);
    this.buffer = "";
  }

  text(): string {
    return this.emitted;
  }

  private consumeLine(line: string, sink: DecodedSink): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    const parsed = parseJson(trimmed);
    if (parsed === null) {
      this.emitText(`${line}\n`, null, sink);
      return;
    }
    if (isRecord(parsed) && isClaudeEnvelope(parsed)) {
      for (const event of convertClaudeMessage(parsed, this.claude)) {
        this.emitConverted(event, sink);
      }
      return;
    }
    this.consumeLegacyJson(parsed, sink);
  }

  private emitConverted(event: DecodedEvent, sink: DecodedSink): void {
    if (event.kind === "session") {
      if (this.sessionEmitted) {
        return;
      }
      this.sessionEmitted = true;
      sink(event);
      return;
    }
    if (event.kind === "text") {
      this.emitAbsolute(event.text, event.blockId, sink);
      return;
    }
    sink(event);
  }

  private consumeLegacyJson(value: unknown, sink: DecodedSink): void {
    if (!isRecord(value)) {
      return;
    }
    if (value.type === "item.delta" && isRecord(value.delta)) {
      const text = value.delta.text;
      if (typeof text === "string") {
        this.emitText(text, null, sink);
      }
      return;
    }
    if (value.type === "item.completed" && isRecord(value.item)) {
      const text = value.item.text;
      if (typeof text === "string") {
        this.emitAbsolute(text, null, sink);
      }
      return;
    }
    if (typeof value.text === "string" && value.type === "agent_message") {
      this.emitAbsolute(value.text, null, sink);
    }
  }

  private emitAbsolute(
    full: string,
    blockId: string | null,
    sink: DecodedSink,
  ): void {
    if (full === this.emitted) {
      return;
    }
    if (full.startsWith(this.emitted)) {
      this.emitText(full.slice(this.emitted.length), blockId, sink);
      return;
    }
    this.emitText(full, blockId, sink);
  }

  private emitText(
    delta: string,
    blockId: string | null,
    sink: DecodedSink,
  ): void {
    if (delta.length === 0) {
      return;
    }
    this.emitted += delta;
    sink({ kind: "text", text: delta, blockId });
  }
}

function isClaudeEnvelope(value: { readonly [key: string]: unknown }): boolean {
  return (
    value.type === "assistant" ||
    value.type === "stream_event" ||
    value.type === "result" ||
    value.type === "system" ||
    value.type === "tool_progress" ||
    value.type === "control_request" ||
    value.type === "user"
  );
}

function parseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isRecord(
  value: unknown,
): value is { readonly [key: string]: unknown } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
