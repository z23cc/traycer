import { describe, expect, it } from "vitest";
import {
  convertClaudeMessage,
  createClaudeConvertState,
} from "../claude-converter";

describe("convertClaudeMessage (recovered S5i)", () => {
  it("drops nested parent_tool_use_id messages", () => {
    const events = convertClaudeMessage(
      {
        type: "assistant",
        parent_tool_use_id: "nested",
        message: { id: "m1", content: [{ type: "text", text: "nope" }] },
      },
      createClaudeConvertState(),
    );
    expect(events).toEqual([]);
  });

  it("maps assistant thinking and tool_use like bIg", () => {
    const events = convertClaudeMessage(
      {
        type: "assistant",
        session_id: "sess-1",
        message: {
          id: "m1",
          content: [
            { type: "thinking", thinking: "plan" },
            { type: "tool_use", id: "t1", name: "Read", input: { path: "a" } },
            { type: "tool_use", id: "t2", name: "ExitPlanMode", input: {} },
          ],
        },
      },
      createClaudeConvertState(),
    );
    expect(events).toEqual([
      { kind: "session", sessionId: "sess-1" },
      { kind: "reasoning", text: "plan", blockId: "m1-thinking-0" },
      {
        kind: "tool_start",
        blockId: "t1",
        name: "Read",
        input: { path: "a" },
      },
    ]);
  });

  it("reads thinking_delta.thinking not delta.text", () => {
    const state = createClaudeConvertState();
    convertClaudeMessage(
      {
        type: "stream_event",
        event: { type: "message_start", message: { id: "m9" } },
      },
      state,
    );
    const events = convertClaudeMessage(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "hmm" },
        },
      },
      state,
    );
    expect(events).toEqual([
      { kind: "reasoning", text: "hmm", blockId: "m9-thinking-0" },
    ]);
  });
});
