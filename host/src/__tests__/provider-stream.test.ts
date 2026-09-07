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
  });

  /**
   * Recorded from a real run whose only instruction was to launch one
   * subagent. Claude reports the whole life of it on the PARENT's stream, and
   * the ids are two: the task owns the card, the tool call spawned it.
   */
  /** Recorded live around `Bash: sleep 3` - a task record, but no agent. */
  it("does not read a Bash call's task record as a subagent", () => {
    expect(
      parseProviderStdoutLine(
        '{"type":"system","subtype":"task_started","task_id":"bdkdss7vl","tool_use_id":"toolu_01V6TaFSyuxKrDmxHGjnBdke","description":"Sleep for 3 seconds","is_backgrounded":false,"task_type":"local_bash","uuid":"751cee38-2d29-40a4-9a53-2d03213ec7ff","session_id":"8ce0aabb-f3b1-4b02-8156-b5f592e5d6d7"}',
      ),
    ).toEqual([
      { kind: "session", sessionId: "8ce0aabb-f3b1-4b02-8156-b5f592e5d6d7" },
    ]);
  });

  it("reads a subagent's life off the parent's task records", () => {
    expect(
      parseProviderStdoutLine(
        '{"type":"system","subtype":"task_started","task_id":"a9da2eb36db32ce2b","tool_use_id":"toolu_01AR","description":"List files in current directory","subagent_type":"Explore","is_backgrounded":true,"spawn_depth":1,"prompt":"list the files here"}',
      ),
    ).toEqual([
      {
        kind: "subagent_start",
        taskId: "a9da2eb36db32ce2b",
        name: "List files in current directory",
        task: "list the files here",
        agentType: "Explore",
        spawnToolId: "toolu_01AR",
      },
    ]);
    expect(
      parseProviderStdoutLine(
        '{"type":"system","subtype":"task_progress","task_id":"a9da2eb36db32ce2b","description":"Running List all files in the working directory","last_tool_name":"Bash"}',
      ),
    ).toEqual([
      {
        kind: "subagent_progress",
        taskId: "a9da2eb36db32ce2b",
        update: "Running List all files in the working directory",
      },
    ]);
    // The status record and the summary record are both terminal, and both
    // are read: one knows how it ended, the other knows what it said.
    expect(
      parseProviderStdoutLine(
        '{"type":"system","subtype":"task_updated","task_id":"a9da2eb36db32ce2b","patch":{"status":"completed","end_time":1788775778365}}',
      ),
    ).toEqual([
      {
        kind: "subagent_end",
        taskId: "a9da2eb36db32ce2b",
        outcome: "completed",
        result: null,
      },
    ]);
    expect(
      parseProviderStdoutLine(
        '{"type":"system","subtype":"task_notification","task_id":"a9da2eb36db32ce2b","tool_use_id":"toolu_01AR","status":"completed","output_file":"/tmp/x.output","summary":"one file"}',
      ),
    ).toEqual([
      {
        kind: "subagent_end",
        taskId: "a9da2eb36db32ce2b",
        outcome: "completed",
        result: "one file",
      },
    ]);
    // A running task reports its status too, and a word this host cannot read
    // is not evidence of an ending. Neither closes the card.
    expect(
      parseProviderStdoutLine(
        '{"type":"system","subtype":"task_updated","task_id":"a9da2eb36db32ce2b","patch":{"status":"running"}}',
      ),
    ).toEqual([]);
    expect(
      parseProviderStdoutLine(
        '{"type":"system","subtype":"task_notification","task_id":"a9da2eb36db32ce2b","status":"reticulating"}',
      ),
    ).toEqual([]);
  });

  /**
   * The child's transcript rides the parent's stream verbatim, tagged with the
   * call that spawned it. The parser keeps that tag and carries the child's
   * events whole, so the reader can nest them under the child's card - and so
   * nothing in them can be mistaken for the parent's.
   */
  it("wraps the records that belong to a subagent under their spawning call", () => {
    expect(
      parseProviderStdoutLine(
        '{"type":"assistant","parent_tool_use_id":"toolu_01AR","message":{"content":[{"type":"tool_use","id":"toolu_016S","name":"Bash","input":{"command":"ls -la"}}]}}',
      ),
    ).toEqual([
      {
        kind: "child",
        parentToolUseId: "toolu_01AR",
        events: [
          {
            kind: "tool_start",
            toolId: "toolu_016S",
            toolName: "Bash",
            input: { command: "ls -la" },
          },
        ],
      },
    ]);
    expect(
      parseProviderStdoutLine(
        '{"type":"assistant","parent_tool_use_id":"toolu_01AR","message":{"content":[{"type":"text","text":"The working directory contains 1 file"}]}}',
      ),
    ).toEqual([
      {
        kind: "child",
        parentToolUseId: "toolu_01AR",
        events: [
          { kind: "delta", text: "The working directory contains 1 file" },
        ],
      },
    ]);
    expect(
      parseProviderStdoutLine(
        '{"type":"user","parent_tool_use_id":"toolu_01AR","message":{"content":[{"type":"tool_result","content":"a.txt","tool_use_id":"toolu_016S"}]}}',
      ),
    ).toEqual([
      {
        kind: "child",
        parentToolUseId: "toolu_01AR",
        events: [{ kind: "tool_end", toolId: "toolu_016S" }],
      },
    ]);
  });

  /**
   * Recorded live with `--permission-prompt-tool stdio`: the CLI asks before
   * a `Write`, names the call, and waits. Only `can_use_tool` is read - the
   * channel carries other control subtypes, and those are left unanswered
   * rather than answered wrong.
   */
  it("reads a permission request off the stdio control channel", () => {
    expect(
      parseProviderStdoutLine(
        '{"type":"control_request","request_id":"d615b557","request":{"subtype":"can_use_tool","tool_name":"Write","display_name":"Write","input":{"file_path":"/tmp/perm-new.txt","content":"hello"},"description":"perm-new.txt","permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}],"tool_use_id":"toolu_01RQ"}}',
      ),
    ).toEqual([
      {
        kind: "permission_request",
        requestId: "d615b557",
        toolUseId: "toolu_01RQ",
        toolName: "Write",
        description: "perm-new.txt",
        input: { file_path: "/tmp/perm-new.txt", content: "hello" },
      },
    ]);
    expect(
      parseProviderStdoutLine(
        '{"type":"control_request","request_id":"x","request":{"subtype":"initialize"}}',
      ),
    ).toEqual([]);
  });

  /**
   * Codex's app-server, recorded live: JSON-RPC notifications on stdout. The
   * thread id is the session; message and reasoning stream as deltas; a
   * command item opens and closes with its exit code; a file-change item
   * announces its files up front, owned by the item, and closes as one.
   */
  it("reads the Codex app-server's thread, deltas, command, and file-change items", () => {
    expect(
      parseProviderStdoutLine(
        // As recorded: no `jsonrpc` label on the wire, an `emittedAtMs` beside it.
        '{"method":"thread/started","params":{"thread":{"id":"01a07bdc-4486-7b80-a6a8-9fef5936d3e9","status":{"type":"idle"}}},"emittedAtMs":1788786268145}',
      ),
    ).toEqual([
      { kind: "session", sessionId: "01a07bdc-4486-7b80-a6a8-9fef5936d3e9" },
    ]);
    expect(
      parseProviderStdoutLine(
        '{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"itemId":"msg_1","delta":"I\u2019ll run"}}',
      ),
    ).toEqual([{ kind: "delta", text: "I’ll run" }]);
    expect(
      parseProviderStdoutLine(
        '{"jsonrpc":"2.0","method":"item/reasoning/summaryTextDelta","params":{"itemId":"rs_1","delta":"plan"}}',
      ),
    ).toEqual([{ kind: "reasoning", text: "plan" }]);
    expect(
      parseProviderStdoutLine(
        '{"jsonrpc":"2.0","method":"item/started","params":{"item":{"type":"commandExecution","id":"exec-52c7","command":"/bin/zsh -lc \'echo PROBE-OK\'","status":"inProgress","exitCode":null},"threadId":"t","turnId":"u"}}',
      ),
    ).toEqual([
      {
        kind: "command_start",
        commandId: "exec-52c7",
        command: "/bin/zsh -lc 'echo PROBE-OK'",
      },
    ]);
    expect(
      parseProviderStdoutLine(
        '{"jsonrpc":"2.0","method":"item/completed","params":{"item":{"type":"commandExecution","id":"exec-52c7","command":"/bin/zsh -lc \'echo PROBE-OK\'","status":"completed","aggregatedOutput":"PROBE-OK\\n","exitCode":0},"threadId":"t","turnId":"u"}}',
      ),
    ).toEqual([
      {
        kind: "command_end",
        commandId: "exec-52c7",
        command: "/bin/zsh -lc 'echo PROBE-OK'",
        exitCode: 0,
      },
    ]);
    expect(
      parseProviderStdoutLine(
        '{"jsonrpc":"2.0","method":"item/started","params":{"item":{"type":"fileChange","id":"exec-7801","changes":[{"path":"/tmp/hello.txt","kind":{"type":"add"},"diff":"hi\\n"}],"status":"inProgress"},"threadId":"t","turnId":"u"}}',
      ),
    ).toEqual([
      {
        kind: "file_change",
        path: "/tmp/hello.txt",
        operation: "add",
        toolId: "exec-7801",
      },
    ]);
    expect(
      parseProviderStdoutLine(
        '{"jsonrpc":"2.0","method":"item/completed","params":{"item":{"type":"fileChange","id":"exec-7801","changes":[{"path":"/tmp/hello.txt","kind":{"type":"add"},"diff":"hi\\n"}],"status":"completed"},"threadId":"t","turnId":"u"}}',
      ),
    ).toEqual([{ kind: "tool_end", toolId: "exec-7801" }]);
  });

  /**
   * The server asking. An approval becomes a permission request keyed by the
   * JSON-RPC id it must answer; a file-change request names only its item,
   * so the reader pairs it with the item's announcement. A request this host
   * does not serve is surfaced so the driver can refuse it rather than leave
   * the turn hanging.
   */
  it("reads the Codex app-server's approval requests, and flags the rest", () => {
    expect(
      parseProviderStdoutLine(
        '{"jsonrpc":"2.0","id":0,"method":"item/fileChange/requestApproval","params":{"threadId":"t","turnId":"u","itemId":"exec-7801","startedAtMs":1788784465333,"reason":null,"grantRoot":null}}',
      ),
    ).toEqual([
      {
        kind: "permission_request",
        requestId: "0",
        toolUseId: "exec-7801",
        toolName: "apply_patch",
        description: "Apply file changes",
        input: {
          threadId: "t",
          turnId: "u",
          itemId: "exec-7801",
          startedAtMs: 1788784465333,
          reason: null,
          grantRoot: null,
        },
      },
    ]);
    expect(
      parseProviderStdoutLine(
        '{"jsonrpc":"2.0","id":"req-9","method":"item/commandExecution/requestApproval","params":{"threadId":"t","turnId":"u","itemId":"exec-1","command":"rm -rf build","reason":null}}',
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "permission_request",
        requestId: '"req-9"',
        toolUseId: "exec-1",
        toolName: "command",
        description: "rm -rf build",
      }),
    ]);
    // Codex's question to the user, by the schema: questions keyed by id.
    expect(
      parseProviderStdoutLine(
        '{"id":4,"method":"item/tool/requestUserInput","params":{"threadId":"t","turnId":"u","itemId":"q-item","isBlocking":true,"questions":[{"id":"q1","header":"Color","question":"Which color?","options":[{"label":"Red","description":"r"}]}]}}',
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "permission_request",
        requestId: "4",
        toolUseId: "q-item",
        toolName: "request_user_input",
        description: "Codex needs your input",
      }),
    ]);
    expect(
      parseProviderStdoutLine(
        '{"id":5,"method":"thread/realtime/negotiate","params":{"threadId":"t"}}',
      ),
    ).toEqual([
      {
        kind: "rpc_unsupported",
        requestId: "5",
        method: "thread/realtime/negotiate",
      },
    ]);
    expect(
      parseProviderStdoutLine(
        '{"jsonrpc":"2.0","method":"thread/tokenUsage/updated","params":{"threadId":"t","turnId":"u","tokenUsage":{"total":{"totalTokens":16234},"last":{"totalTokens":16234,"inputTokens":16062,"cachedInputTokens":6912,"outputTokens":172},"modelContextWindow":258400}}}',
      ),
    ).toEqual([
      {
        kind: "usage",
        usage: {
          inputTokens: 16062,
          outputTokens: 172,
          totalTokens: 16234,
          cacheReadInputTokens: 6912,
          contextTokens: 16234,
          contextWindow: 258400,
          costUsd: undefined,
        },
      },
    ]);
    expect(
      parseProviderStdoutLine(
        '{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"t","turn":{"id":"u","status":"failed","error":{"message":"boom"}}}}',
      ),
    ).toEqual([{ kind: "turn_end", status: "failed", error: "boom" }]);
    expect(
      parseProviderStdoutLine(
        '{"id":2,"error":{"code":-32600,"message":"bad thread"}}',
      ),
    ).toEqual([{ kind: "transport_error", message: "bad thread" }]);
  });

  it("ignores unstructured CLI text so the plain-stdout path can take over", () => {
    expect(parseProviderStdoutLine("assistant-ok")).toEqual([]);
  });
});
