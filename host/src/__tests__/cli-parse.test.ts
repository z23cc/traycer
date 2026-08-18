import { describe, expect, it } from "vitest";
import { OutputDecoder } from "../cli-parse";

describe("OutputDecoder", () => {
  it("emits incremental suffixes from full assistant snapshots", () => {
    const decoder = new OutputDecoder();
    const deltas: string[] = [];
    const sink = (event: {
      readonly kind: string;
      readonly text?: string;
    }): void => {
      if (event.kind === "text" && event.text !== undefined) {
        deltas.push(event.text);
      }
    };
    decoder.push(
      `${JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hel" }] },
      })}\n`,
      sink,
    );
    decoder.push(
      `${JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello" }] },
      })}\n`,
      sink,
    );
    decoder.push(
      `${JSON.stringify({ type: "result", result: "Hello", subtype: "success" })}\n`,
      sink,
    );
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(decoder.text()).toBe("Hello");
  });

  it("emits content_block_delta and stream_event text", () => {
    const decoder = new OutputDecoder();
    const deltas: string[] = [];
    decoder.push(
      `${JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Hi" },
        },
      })}\n`,
      (event) => {
        if (event.kind === "text") {
          deltas.push(event.text);
        }
      },
    );
    expect(deltas).toEqual(["Hi"]);
  });

  it("treats thinking_delta as reasoning and surfaces control_request", () => {
    const decoder = new OutputDecoder();
    const kinds: string[] = [];
    decoder.push(
      `${JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "hmm" },
        },
      })}\n${JSON.stringify({
        type: "control_request",
        request_id: "req-1",
      })}\n`,
      (event) => {
        kinds.push(event.kind);
      },
    );
    expect(kinds).toEqual(["reasoning", "control_request"]);
  });

  it("emits session and tool_use / tool_result pairs once", () => {
    const decoder = new OutputDecoder();
    const events: string[] = [];
    decoder.push(
      `${JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "sess-9",
      })}\n${JSON.stringify({
        type: "assistant",
        session_id: "sess-9",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Read",
              input: { path: "a" },
            },
          ],
        },
      })}\n${JSON.stringify({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tool-1", content: "ok" },
          ],
        },
      })}\n`,
      (event) => {
        if (event.kind === "session") {
          events.push(`session:${event.sessionId}`);
          return;
        }
        if (event.kind === "tool_start") {
          events.push(`start:${event.name}:${event.blockId}`);
          return;
        }
        if (event.kind === "tool_end") {
          events.push(`end:${event.blockId}`);
        }
      },
    );
    expect(events).toEqual([
      "session:sess-9",
      "start:Read:tool-1",
      "end:tool-1",
    ]);
  });

  it("treats non-JSON lines as plain text", () => {
    const decoder = new OutputDecoder();
    const deltas: string[] = [];
    decoder.push("plain line\n", (event) => {
      if (event.kind === "text") {
        deltas.push(event.text);
      }
    });
    expect(deltas).toEqual(["plain line\n"]);
  });
});
