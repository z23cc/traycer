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

  /**
   * Lines recorded from a real `claude -p --output-format stream-json
   * --include-partial-messages` run whose Bash call failed, which is the whole
   * point: the tool RESULT rides a `user` record and this parser used to drop
   * every one of them, so a call that exited 1 reached the GUI as a call that
   * completed.
   */
  it("reads a failed tool result off the user record", () => {
    expect(
      parseProviderStdoutLine(
        '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"Exit code 1\\n[bat error]: no such file","is_error":true,"tool_use_id":"toolu_01SF"}]}}',
      ),
    ).toEqual([
      {
        kind: "tool_error",
        toolId: "toolu_01SF",
        error: "Exit code 1\n[bat error]: no such file",
      },
    ]);
  });

  it("closes a successful tool call only when its result arrives", () => {
    // The call itself no longer closes anything - `content_block_start` and
    // the complete `assistant` record both open it, and neither knows yet
    // whether it worked.
    expect(
      parseProviderStdoutLine(
        '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_2","name":"Read","input":{"file_path":"/tmp/x"}}]}}',
      ),
    ).toEqual([
      {
        kind: "tool_start",
        toolId: "toolu_2",
        toolName: "Read",
        input: { file_path: "/tmp/x" },
      },
    ]);
    expect(
      parseProviderStdoutLine(
        '{"type":"user","message":{"content":[{"type":"tool_result","content":[{"type":"text","text":"ok"}],"tool_use_id":"toolu_2"}]}}',
      ),
    ).toEqual([{ kind: "tool_end", toolId: "toolu_2" }]);
  });

  /**
   * The structured auth signal, recorded from a run with a bad key. Only 401:
   * the same record shape carries 429s and 5xxs, where the retry beside it is
   * the correct response and killing the run would be wrong.
   */
  it("reads a rejected credential off the retry record, and only on a 401", () => {
    expect(
      parseProviderStdoutLine(
        '{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":509,"error_status":401,"error":"authentication_failed"}',
      ),
    ).toEqual([
      { kind: "auth_failure", status: 401, detail: "authentication_failed" },
    ]);
    expect(
      parseProviderStdoutLine(
        '{"type":"system","subtype":"api_retry","attempt":1,"error_status":429,"error":"rate_limited"}',
      ),
    ).toEqual([]);
  });

  /**
   * `TodoWrite` carries the whole list in its input, which is what the pinned
   * dock renders. The tool call is still emitted beside it: the call happened.
   */
  it("lifts a TodoWrite call's list into a todo event", () => {
    expect(
      parseProviderStdoutLine(
        '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_t1","name":"TodoWrite","input":{"todos":[{"content":"read the parser","status":"completed","activeForm":"Reading the parser"},{"content":"write the test","status":"in_progress","activeForm":"Writing the test"}]}}]}}',
      ),
    ).toEqual([
      {
        kind: "tool_start",
        toolId: "toolu_t1",
        toolName: "TodoWrite",
        input: {
          todos: [
            {
              content: "read the parser",
              status: "completed",
              activeForm: "Reading the parser",
            },
            {
              content: "write the test",
              status: "in_progress",
              activeForm: "Writing the test",
            },
          ],
        },
      },
      {
        kind: "todo",
        toolId: "toolu_t1",
        items: [
          {
            id: "toolu_t1:0",
            text: "read the parser",
            status: "completed",
            activeForm: "Reading the parser",
          },
          {
            id: "toolu_t1:1",
            text: "write the test",
            status: "in_progress",
            activeForm: "Writing the test",
          },
        ],
      },
    ]);
    // The partial record opens the call with an empty input, so it produces no
    // list - the complete record above is the one that carries it.
    expect(
      parseProviderStdoutLine(
        '{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_t1","name":"TodoWrite","input":{}}}}',
      ),
    ).toEqual([
      {
        kind: "tool_start",
        toolId: "toolu_t1",
        toolName: "TodoWrite",
        input: {},
      },
    ]);
  });

  /**
   * The GUI hides an edit tool call in favour of the file card and strips the
   * call's bulk input from the persisted detail, so a host that emits no card
   * leaves the edit as a bare row. The card carries the CALL's id, which is
   * what pairs the two.
   */
  it("turns an edit tool call into a file change that owns it", () => {
    expect(
      parseProviderStdoutLine(
        '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_e9","name":"Edit","input":{"file_path":"/tmp/x.ts","old_string":"a","new_string":"b"}}]}}',
      ),
    ).toEqual([
      {
        kind: "tool_start",
        toolId: "toolu_e9",
        toolName: "Edit",
        input: {
          file_path: "/tmp/x.ts",
          old_string: "a",
          new_string: "b",
        },
      },
      {
        kind: "file_change",
        path: "/tmp/x.ts",
        // The input says what to write, never whether the file was there.
        operation: null,
        toolId: "toolu_e9",
      },
    ]);
    // Codex reports its changes on their own, with no call to pair with.
    expect(
      parseProviderStdoutLine(
        '{"type":"item.completed","item":{"id":"item_9","type":"file_change","path":"/tmp/y.ts","operation":"add"}}',
      ),
    ).toEqual([
      {
        kind: "file_change",
        path: "/tmp/y.ts",
        operation: "add",
        toolId: null,
      },
    ]);
  });

  it("ignores unstructured CLI text so the plain-stdout path can take over", () => {
    expect(parseProviderStdoutLine("assistant-ok")).toEqual([]);
  });
});
