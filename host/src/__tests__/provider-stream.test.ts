import { describe, expect, it } from "vitest";
import { parseProviderStdoutLine } from "../gui/provider-stream";

describe("parseProviderStdoutLine", () => {
  it("maps Claude stream-json partials and session ids", () => {
    expect(
      parseProviderStdoutLine(
        '{"type":"system","subtype":"init","session_id":"sess-1"}',
      ),
    ).toEqual([{ kind: "session", sessionId: "sess-1" }]);
    expect(
      parseProviderStdoutLine(
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}}',
      ),
    ).toEqual([{ kind: "delta", text: "Hel" }]);
  });

  it("maps Codex thread and agent_message events", () => {
    expect(
      parseProviderStdoutLine(
        '{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}',
      ),
    ).toEqual([
      {
        kind: "session",
        sessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
      },
    ]);
    expect(
      parseProviderStdoutLine(
        '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"pong"}}',
      ),
    ).toEqual([{ kind: "delta", text: "pong" }]);
  });

  it("maps Claude thinking and tool_use blocks", () => {
    expect(
      parseProviderStdoutLine(
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}}',
      ),
    ).toEqual([{ kind: "reasoning", text: "hmm" }]);
    expect(
      parseProviderStdoutLine(
        '{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}}}',
      ),
    ).toEqual([
      {
        kind: "tool_start",
        toolId: "toolu_1",
        toolName: "Bash",
        input: { command: "ls" },
      },
    ]);
  });

  it("maps Codex reasoning and command_execution items", () => {
    expect(
      parseProviderStdoutLine(
        '{"type":"item.completed","item":{"id":"item_2","type":"reasoning","text":"plan"}}',
      ),
    ).toEqual([{ kind: "reasoning", text: "plan" }]);
    expect(
      parseProviderStdoutLine(
        '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"ls"}}',
      ),
    ).toEqual([
      {
        kind: "command_start",
        commandId: "item_1",
        command: "ls",
      },
    ]);
  });

  it("maps Claude result usage onto usage.updated", () => {
    expect(
      parseProviderStdoutLine(
        '{"type":"result","session_id":"sess-1","usage":{"input_tokens":10,"output_tokens":4},"total_cost_usd":0.01}',
      ),
    ).toEqual([
      { kind: "session", sessionId: "sess-1" },
      {
        kind: "usage",
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          totalTokens: 14,
          cacheReadInputTokens: undefined,
          contextTokens: 10,
          contextWindow: undefined,
          costUsd: 0.01,
        },
      },
    ]);
  });

  it("ignores unstructured CLI text so the plain-stdout path can take over", () => {
    expect(parseProviderStdoutLine("assistant-ok")).toEqual([]);
  });
});
