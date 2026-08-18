import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProcessTurnRunner } from "../cli-runner";

async function createFakeCodexAppServer(): Promise<{
  readonly dir: string;
  readonly path: string;
  readonly tracePath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "traycer-codex-runner-"));
  const path = join(dir, "codex");
  const tracePath = join(dir, "trace.json");
  await writeFile(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const tracePath = process.env.TRAYCER_TEST_CODEX_TRACE;
const scenario = process.env.TRAYCER_TEST_CODEX_SCENARIO || "text";
const trace = {
  args: process.argv.slice(2),
  a2aToken: process.env.TRAYCER_A2A_MCP_TOKEN || null,
  requests: [],
};
let completionTimer = null;
function save() { fs.writeFileSync(tracePath, JSON.stringify(trace)); }
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
save();
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  trace.requests.push(request);
  save();
  if (request.id === "approval-1" && request.method === undefined) {
    if (completionTimer !== null) clearTimeout(completionTimer);
    send({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    });
    return;
  }
  if (request.method === "initialize") {
    if (scenario === "init-crash") {
      process.stderr.write("codex state database is locked");
      setImmediate(() => process.exit(17));
      return;
    }
    if (scenario === "hang-initialize") {
      return;
    }
    send({ jsonrpc: "2.0", id: request.id, result: {} });
    return;
  }
  if (request.method === "thread/start" || request.method === "thread/resume") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: { thread: { id: "thread-1", sessionId: "session-1" } },
    });
    return;
  }
  if (request.method === "turn/start") {
    if (scenario === "crash-before-turn-response") {
      setImmediate(() => process.exit(29));
      return;
    }
    if (scenario === "hang-before-turn-response") {
      return;
    }
    send({ jsonrpc: "2.0", id: request.id, result: { turn: { id: "turn-1" } } });
    send({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    });
    if (scenario === "wait-for-interrupt") {
      send({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "message-1", delta: "waiting" },
      });
      completionTimer = setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1" } },
        });
      }, 100);
      return;
    }
    if (scenario === "crash-after-start") {
      setImmediate(() => process.exit(23));
      return;
    }
    if (scenario === "stderr-flood") {
      let remaining = 2 * 1024 * 1024;
      const write = () => {
        while (remaining > 0) {
          const size = Math.min(remaining, 64 * 1024);
          remaining -= size;
          if (!process.stderr.write("x".repeat(size))) {
            process.stderr.once("drain", write);
            return;
          }
        }
        send({
          jsonrpc: "2.0",
          method: "item/agentMessage/delta",
          params: { threadId: "thread-1", turnId: "turn-1", itemId: "message-1", delta: "after-stderr" },
        });
        send({
          jsonrpc: "2.0",
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1" } },
        });
      };
      write();
      return;
    }
    if (scenario === "retrying-error") {
      send({
        jsonrpc: "2.0",
        method: "error",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          willRetry: true,
          error: { message: "temporary transport failure" },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "message-1", delta: "recovered" },
      });
      send({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
      });
      return;
    }
    if (scenario === "failed-turn") {
      send({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: "failed",
            error: { message: "model request failed" },
          },
        },
      });
      return;
    }
    if (scenario === "foreign-events") {
      send({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { threadId: "thread-foreign", turnId: "turn-foreign", itemId: "message-foreign", delta: "foreign" },
      });
      send({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { threadId: "thread-foreign", turn: { id: "turn-foreign", status: "completed" } },
      });
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "item/agentMessage/delta",
          params: { threadId: "thread-1", turnId: "turn-1", itemId: "message-1", delta: "current" },
        });
        send({
          jsonrpc: "2.0",
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
        });
      }, 25);
      return;
    }
    if (scenario === "approval") {
      send({
        jsonrpc: "2.0",
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: { itemId: "command-1", command: "pwd", reason: "needs approval" },
      });
      completionTimer = setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1" } },
        });
      }, 100);
      return;
    }
    if (scenario === "events") {
      send({
        jsonrpc: "2.0",
        method: "item/reasoning/textDelta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "reasoning-1", delta: "thinking" },
      });
      send({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "commandExecution", id: "command-1", command: "pwd", cwd: "/workspace" },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "commandExecution", id: "command-1", command: "pwd", cwd: "/workspace", exitCode: 0 },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "mcpToolCall", id: "mcp-1", server: "files", tool: "read", arguments: { path: "a.txt" } },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "mcpToolCall", id: "mcp-1", server: "files", tool: "read", arguments: { path: "a.txt" }, status: "completed" },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "dynamicToolCall", id: "dynamic-1", namespace: "tools", tool: "search", arguments: { query: "needle" } },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "dynamicToolCall", id: "dynamic-1", namespace: "tools", tool: "search", arguments: { query: "needle" }, status: "failed", success: false, error: { message: "search failed" } },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "webSearch", id: "web-1", query: "Traycer host" },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "webSearch", id: "web-1", query: "Traycer host" },
        },
      });
    }
    send({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "message-1", delta: "from-app-server" },
    });
    send({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    });
    return;
  }
  if (request.method === "turn/interrupt") {
    if (completionTimer !== null) clearTimeout(completionTimer);
    send({ jsonrpc: "2.0", id: request.id, result: {} });
    return;
  }
  if (request.method === "shutdown") {
    send({ jsonrpc: "2.0", id: request.id, result: {} });
    setImmediate(() => process.exit(0));
  }
});
`,
    { mode: 0o755 },
  );
  await chmod(path, 0o755);
  return { dir, path, tracePath };
}

describe("createProcessTurnRunner", () => {
  it("streams text from a fake Claude CLI", async () => {
    const dir = await mkdtemp(join(tmpdir(), "traycer-runner-"));
    const path = join(dir, "claude");
    await writeFile(
      path,
      `#!/usr/bin/env node
const payload = {
  type: "assistant",
  message: { content: [{ type: "text", text: "from-cli" }] },
};
process.stdout.write(JSON.stringify(payload) + "\\n");
`,
      { mode: 0o755 },
    );
    await chmod(path, 0o755);
    const runner = createProcessTurnRunner({
      ...process.env,
      TRAYCER_CLAUDE_PATH: path,
      PATH: process.env.PATH,
    });
    const deltas: string[] = [];
    const result = await runner.run(
      {
        harnessId: "claude",
        model: "claude-sonnet-4",
        permissionMode: "supervised",
        reasoningEffort: null,
        serviceTier: null,
        prompt: "hi",
        cwd: dir,
        sessionId: null,
        signal: new AbortController().signal,
      },
      (chunk) => {
        if (chunk.kind === "text") {
          deltas.push(chunk.text);
        }
      },
    );
    expect(deltas.join("")).toBe("from-cli");
    expect(result.text).toBe("from-cli");
  });

  it("returns a missing-binary notice when the CLI is absent", async () => {
    const runner = createProcessTurnRunner({
      PATH: "/nonexistent",
      HOME: "/nonexistent-home",
    });
    const result = await runner.run(
      {
        harnessId: "codex",
        model: "gpt-5-codex",
        permissionMode: "supervised",
        reasoningEffort: null,
        serviceTier: null,
        prompt: "hi",
        cwd: null,
        sessionId: null,
        signal: new AbortController().signal,
      },
      () => {
        return;
      },
    );
    expect(result.text).toContain("codex was not found");
  });

  it("runs a fresh Codex turn through the recovered app-server protocol", async () => {
    const { dir, path, tracePath } = await createFakeCodexAppServer();
    const runner = createProcessTurnRunner({
      ...process.env,
      TRAYCER_CODEX_PATH: path,
      TRAYCER_TEST_CODEX_TRACE: tracePath,
      PATH: process.env.PATH,
    });
    const deltas: string[] = [];
    const result = await runner.run(
      {
        harnessId: "codex",
        model: "gpt-5-codex",
        permissionMode: "supervised",
        reasoningEffort: "high",
        serviceTier: "priority",
        prompt: "hello",
        cwd: dir,
        sessionId: null,
        signal: new AbortController().signal,
      },
      (chunk) => {
        if (chunk.kind === "text") {
          deltas.push(chunk.text);
        }
      },
    );

    expect(deltas).toEqual(["from-app-server"]);
    expect(result).toEqual({
      text: "from-app-server",
      sessionId: "thread-1",
    });
    const trace = JSON.parse(await readFile(tracePath, "utf8")) as {
      readonly args: string[];
      readonly requests: Array<{
        readonly method: string;
        readonly params?: unknown;
      }>;
    };
    expect(trace.args).toEqual(["app-server", "--listen", "stdio://"]);
    expect(trace.requests.slice(0, 3).map((request) => request.method)).toEqual(
      ["initialize", "thread/start", "turn/start"],
    );
    expect(trace.requests[0]?.params).toEqual({
      protocolVersion: "2025-01-01",
      capabilities: { experimentalApi: true },
      clientInfo: { name: "traycer-agents", version: "1.0.0" },
    });
    expect(trace.requests[1]?.params).toEqual({
      cwd: dir,
      runtimeWorkspaceRoots: [dir],
      model: "gpt-5-codex",
      serviceTier: "priority",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
    });
    expect(trace.requests[2]?.params).toEqual({
      threadId: "thread-1",
      input: [{ type: "text", text: "hello", text_elements: [] }],
      cwd: dir,
      runtimeWorkspaceRoots: [dir],
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
      effort: "high",
      summary: "auto",
    });
  });

  it("injects the host-owned A2A MCP into a Codex app-server turn", async () => {
    const { dir, path, tracePath } = await createFakeCodexAppServer();
    const runner = createProcessTurnRunner({
      ...process.env,
      TRAYCER_CODEX_PATH: path,
      TRAYCER_TEST_CODEX_TRACE: tracePath,
      TRAYCER_A2A_MCP_TOKEN: "wrong-inherited-token",
      PATH: process.env.PATH,
    });

    const result = await runner.run(
      {
        harnessId: "codex",
        model: "gpt-5-codex",
        permissionMode: "supervised",
        reasoningEffort: null,
        serviceTier: null,
        prompt: "reply to the parent",
        cwd: dir,
        sessionId: null,
        signal: new AbortController().signal,
        traycerAgentEnv: {
          agentId: "receiver-agent",
          epicId: "epic-a2a",
          cliSurface: "full",
        },
        traycerA2AMcp: {
          url: "http://127.0.0.1:43210/mcp",
          token: "secret-token",
        },
      },
      () => {
        return;
      },
    );
    expect(result.text).toBe("from-app-server");

    const trace = JSON.parse(await readFile(tracePath, "utf8")) as {
      readonly args: string[];
      readonly a2aToken: string | null;
    };
    expect(trace.args).toEqual([
      "-c",
      'mcp_servers.traycer_a2a.url="http://127.0.0.1:43210/mcp"',
      "-c",
      'mcp_servers.traycer_a2a.bearer_token_env_var="TRAYCER_A2A_MCP_TOKEN"',
      "app-server",
      "--listen",
      "stdio://",
    ]);
    expect(trace.a2aToken).toBe("secret-token");
  });

  it("resumes the existing Codex thread before starting a follow-up turn", async () => {
    const { dir, path, tracePath } = await createFakeCodexAppServer();
    const runner = createProcessTurnRunner({
      ...process.env,
      TRAYCER_CODEX_PATH: path,
      TRAYCER_TEST_CODEX_TRACE: tracePath,
      PATH: process.env.PATH,
    });

    const result = await runner.run(
      {
        harnessId: "codex",
        model: "gpt-5-codex",
        permissionMode: "supervised",
        reasoningEffort: null,
        serviceTier: null,
        prompt: "again",
        cwd: dir,
        sessionId: "thread-existing",
        signal: new AbortController().signal,
      },
      () => {
        return;
      },
    );

    const trace = JSON.parse(await readFile(tracePath, "utf8")) as {
      readonly requests: Array<{
        readonly method: string;
        readonly params?: unknown;
      }>;
    };
    expect(trace.requests.slice(0, 3).map((request) => request.method)).toEqual(
      ["initialize", "thread/resume", "turn/start"],
    );
    expect(trace.requests[1]?.params).toEqual({
      threadId: "thread-existing",
      cwd: dir,
      runtimeWorkspaceRoots: [dir],
      model: "gpt-5-codex",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
    });
    expect(result.sessionId).toBe("thread-1");
  });

  it("maps Codex reasoning and tool lifecycle notifications", async () => {
    const { dir, path, tracePath } = await createFakeCodexAppServer();
    const runner = createProcessTurnRunner({
      ...process.env,
      TRAYCER_CODEX_PATH: path,
      TRAYCER_TEST_CODEX_TRACE: tracePath,
      TRAYCER_TEST_CODEX_SCENARIO: "events",
      PATH: process.env.PATH,
    });
    const events: string[] = [];

    await runner.run(
      {
        harnessId: "codex",
        model: "gpt-5-codex",
        permissionMode: "supervised",
        reasoningEffort: null,
        serviceTier: null,
        prompt: "inspect",
        cwd: dir,
        sessionId: null,
        signal: new AbortController().signal,
      },
      (chunk) => {
        if (chunk.kind === "reasoning") {
          events.push(`reasoning:${chunk.text}`);
          return;
        }
        if (chunk.kind === "command_start") {
          events.push(`command-start:${chunk.blockId}:${chunk.command}`);
          return;
        }
        if (chunk.kind === "command_end") {
          events.push(
            `command-end:${chunk.blockId}:${chunk.command}:${String(chunk.exitCode)}`,
          );
          return;
        }
        if (chunk.kind === "tool_start") {
          events.push(`tool-start:${chunk.blockId}:${chunk.name}`);
          return;
        }
        if (chunk.kind === "tool_end") {
          events.push(`tool-end:${chunk.blockId}:${chunk.name}`);
          return;
        }
        if (chunk.kind === "tool_error") {
          events.push(
            `tool-error:${chunk.blockId}:${chunk.name}:${chunk.error}`,
          );
        }
      },
    );

    expect(events).toEqual([
      "reasoning:thinking",
      "command-start:command-1:pwd",
      "command-end:command-1:pwd:0",
      "tool-start:mcp-1:files/read",
      "tool-end:mcp-1:files/read",
      "tool-start:dynamic-1:tools/search",
      "tool-error:dynamic-1:tools/search:search failed",
      "tool-start:web-1:web_search",
      "tool-end:web-1:web_search",
    ]);
  });

  it("rejects the turn when a Codex notification consumer throws", async () => {
    const { dir, path, tracePath } = await createFakeCodexAppServer();
    const runner = createProcessTurnRunner({
      ...process.env,
      TRAYCER_CODEX_PATH: path,
      TRAYCER_TEST_CODEX_TRACE: tracePath,
      PATH: process.env.PATH,
    });

    await expect(
      runner.run(
        {
          harnessId: "codex",
          model: "gpt-5-codex",
          permissionMode: "supervised",
          reasoningEffort: null,
          serviceTier: null,
          prompt: "emit",
          cwd: dir,
          sessionId: null,
          signal: new AbortController().signal,
        },
        (chunk) => {
          if (chunk.kind === "text") {
            throw new Error("notification consumer failed");
          }
        },
      ),
    ).rejects.toThrow("notification consumer failed");
  });

  it("interrupts the active Codex turn when the request is aborted", async () => {
    const { dir, path, tracePath } = await createFakeCodexAppServer();
    const runner = createProcessTurnRunner({
      ...process.env,
      TRAYCER_CODEX_PATH: path,
      TRAYCER_TEST_CODEX_TRACE: tracePath,
      TRAYCER_TEST_CODEX_SCENARIO: "wait-for-interrupt",
      PATH: process.env.PATH,
    });
    const controller = new AbortController();

    const running = runner.run(
      {
        harnessId: "codex",
        model: "gpt-5-codex",
        permissionMode: "supervised",
        reasoningEffort: null,
        serviceTier: null,
        prompt: "wait",
        cwd: dir,
        sessionId: null,
        signal: controller.signal,
      },
      (chunk) => {
        if (chunk.kind === "text" && chunk.text === "waiting") {
          controller.abort();
        }
      },
    );

    await expect(running).rejects.toThrow("Turn was stopped");
    const trace = JSON.parse(await readFile(tracePath, "utf8")) as {
      readonly requests: Array<{
        readonly method: string;
        readonly params?: unknown;
      }>;
    };
    const interrupt = trace.requests.find(
      (request) => request.method === "turn/interrupt",
    );
    expect(interrupt?.params).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
    });
  });

  it("rejects when the Codex app-server exits before turn completion", async () => {
    const { dir, path, tracePath } = await createFakeCodexAppServer();
    const runner = createProcessTurnRunner({
      ...process.env,
      TRAYCER_CODEX_PATH: path,
      TRAYCER_TEST_CODEX_TRACE: tracePath,
      TRAYCER_TEST_CODEX_SCENARIO: "crash-after-start",
      PATH: process.env.PATH,
    });

    await expect(
      runner.run(
        {
          harnessId: "codex",
          model: "gpt-5-codex",
          permissionMode: "supervised",
          reasoningEffort: null,
          serviceTier: null,
          prompt: "crash",
          cwd: dir,
          sessionId: null,
          signal: new AbortController().signal,
        },
        () => {
          return;
        },
      ),
    ).rejects.toThrow("codex app-server exited with code 23");
  }, 1_500);

  it("rejects cleanly when Codex exits while turn/start is pending", async () => {
    const { dir, path, tracePath } = await createFakeCodexAppServer();
    const runner = createProcessTurnRunner({
      ...process.env,
      TRAYCER_CODEX_PATH: path,
      TRAYCER_TEST_CODEX_TRACE: tracePath,
      TRAYCER_TEST_CODEX_SCENARIO: "crash-before-turn-response",
      PATH: process.env.PATH,
    });

    await expect(
      runner.run(
        {
          harnessId: "codex",
          model: "gpt-5-codex",
          permissionMode: "supervised",
          reasoningEffort: null,
          serviceTier: null,
          prompt: "crash during start",
          cwd: dir,
          sessionId: null,
          signal: new AbortController().signal,
        },
        () => {
          return;
        },
      ),
    ).rejects.toThrow("codex app-server exited with code 29");
  }, 1_500);

  it("stops promptly when aborted while turn/start is pending", async () => {
    const { dir, path, tracePath } = await createFakeCodexAppServer();
    const runner = createProcessTurnRunner({
      ...process.env,
      TRAYCER_CODEX_PATH: path,
      TRAYCER_TEST_CODEX_TRACE: tracePath,
      TRAYCER_TEST_CODEX_SCENARIO: "hang-before-turn-response",
      PATH: process.env.PATH,
    });
    const controller = new AbortController();
    const running = runner.run(
      {
        harnessId: "codex",
        model: "gpt-5-codex",
        permissionMode: "supervised",
        reasoningEffort: null,
        serviceTier: null,
        prompt: "stop during start",
        cwd: dir,
        sessionId: null,
        signal: controller.signal,
      },
      () => {
        return;
      },
    );

    setTimeout(() => controller.abort(), 25);
    await expect(running).rejects.toThrow("Turn was stopped");
  }, 1_500);

  it("stops promptly when aborted while initialize is pending", async () => {
    const { dir, path, tracePath } = await createFakeCodexAppServer();
    const runner = createProcessTurnRunner({
      ...process.env,
      TRAYCER_CODEX_PATH: path,
      TRAYCER_TEST_CODEX_TRACE: tracePath,
      TRAYCER_TEST_CODEX_SCENARIO: "hang-initialize",
      PATH: process.env.PATH,
    });
    const controller = new AbortController();
    const running = runner.run(
      {
        harnessId: "codex",
        model: "gpt-5-codex",
        permissionMode: "supervised",
        reasoningEffort: null,
        serviceTier: null,
        prompt: "stop during initialize",
        cwd: dir,
        sessionId: null,
        signal: controller.signal,
      },
      () => {
        return;
      },
    );

    setTimeout(() => controller.abort(), 25);
    await expect(running).rejects.toThrow("Turn was stopped");
  }, 1_500);

  it("includes the Codex stderr tail when initialization exits", async () => {
    const { dir, path, tracePath } = await createFakeCodexAppServer();
    const runner = createProcessTurnRunner({
      ...process.env,
      TRAYCER_CODEX_PATH: path,
      TRAYCER_TEST_CODEX_TRACE: tracePath,
      TRAYCER_TEST_CODEX_SCENARIO: "init-crash",
      PATH: process.env.PATH,
    });

    await expect(
      runner.run(
        {
          harnessId: "codex",
          model: "gpt-5-codex",
          permissionMode: "supervised",
          reasoningEffort: null,
          serviceTier: null,
          prompt: "initialize",
          cwd: dir,
          sessionId: null,
          signal: new AbortController().signal,
        },
        () => {
          return;
        },
      ),
    ).rejects.toThrow("codex state database is locked");
  });

  it("keeps consuming Codex stderr while a turn is running", async () => {
    const { dir, path, tracePath } = await createFakeCodexAppServer();
    const runner = createProcessTurnRunner({
      ...process.env,
      TRAYCER_CODEX_PATH: path,
      TRAYCER_TEST_CODEX_TRACE: tracePath,
      TRAYCER_TEST_CODEX_SCENARIO: "stderr-flood",
      PATH: process.env.PATH,
    });

    const result = await runner.run(
      {
        harnessId: "codex",
        model: "gpt-5-codex",
        permissionMode: "supervised",
        reasoningEffort: null,
        serviceTier: null,
        prompt: "write diagnostics",
        cwd: dir,
        sessionId: null,
        signal: new AbortController().signal,
      },
      () => {
        return;
      },
    );

    expect(result.text).toBe("after-stderr");
  }, 1_500);

  it("keeps the turn alive when Codex reports a retryable error", async () => {
    const { dir, path, tracePath } = await createFakeCodexAppServer();
    const runner = createProcessTurnRunner({
      ...process.env,
      TRAYCER_CODEX_PATH: path,
      TRAYCER_TEST_CODEX_TRACE: tracePath,
      TRAYCER_TEST_CODEX_SCENARIO: "retrying-error",
      PATH: process.env.PATH,
    });

    const result = await runner.run(
      {
        harnessId: "codex",
        model: "gpt-5-codex",
        permissionMode: "supervised",
        reasoningEffort: null,
        serviceTier: null,
        prompt: "retry",
        cwd: dir,
        sessionId: null,
        signal: new AbortController().signal,
      },
      () => {
        return;
      },
    );

    expect(result.text).toBe("recovered");
  });

  it("ignores Codex notifications from a different thread and turn", async () => {
    const { dir, path, tracePath } = await createFakeCodexAppServer();
    const runner = createProcessTurnRunner({
      ...process.env,
      TRAYCER_CODEX_PATH: path,
      TRAYCER_TEST_CODEX_TRACE: tracePath,
      TRAYCER_TEST_CODEX_SCENARIO: "foreign-events",
      PATH: process.env.PATH,
    });

    const result = await runner.run(
      {
        harnessId: "codex",
        model: "gpt-5-codex",
        permissionMode: "supervised",
        reasoningEffort: null,
        serviceTier: null,
        prompt: "route events",
        cwd: dir,
        sessionId: null,
        signal: new AbortController().signal,
      },
      () => {
        return;
      },
    );

    expect(result.text).toBe("current");
  });

  it("does not start a Codex turn after the session callback aborts", async () => {
    const { dir, path, tracePath } = await createFakeCodexAppServer();
    const runner = createProcessTurnRunner({
      ...process.env,
      TRAYCER_CODEX_PATH: path,
      TRAYCER_TEST_CODEX_TRACE: tracePath,
      PATH: process.env.PATH,
    });
    const controller = new AbortController();

    await expect(
      runner.run(
        {
          harnessId: "codex",
          model: "gpt-5-codex",
          permissionMode: "supervised",
          reasoningEffort: null,
          serviceTier: null,
          prompt: "do not start",
          cwd: dir,
          sessionId: null,
          signal: controller.signal,
        },
        (chunk) => {
          if (chunk.kind === "session") {
            controller.abort();
          }
        },
      ),
    ).rejects.toThrow("Turn was stopped");

    const trace = JSON.parse(await readFile(tracePath, "utf8")) as {
      readonly requests: Array<{ readonly method?: string }>;
    };
    expect(
      trace.requests.some((request) => request.method === "turn/start"),
    ).toBe(false);
  });

  it("rejects a Codex turn that completes with failed status", async () => {
    const { dir, path, tracePath } = await createFakeCodexAppServer();
    const runner = createProcessTurnRunner({
      ...process.env,
      TRAYCER_CODEX_PATH: path,
      TRAYCER_TEST_CODEX_TRACE: tracePath,
      TRAYCER_TEST_CODEX_SCENARIO: "failed-turn",
      PATH: process.env.PATH,
    });

    await expect(
      runner.run(
        {
          harnessId: "codex",
          model: "gpt-5-codex",
          permissionMode: "supervised",
          reasoningEffort: null,
          serviceTier: null,
          prompt: "fail",
          cwd: dir,
          sessionId: null,
          signal: new AbortController().signal,
        },
        () => {
          return;
        },
      ),
    ).rejects.toThrow("model request failed");
  });

  it("answers Codex approval server requests in full-access mode", async () => {
    const { dir, path, tracePath } = await createFakeCodexAppServer();
    const runner = createProcessTurnRunner({
      ...process.env,
      TRAYCER_CODEX_PATH: path,
      TRAYCER_TEST_CODEX_TRACE: tracePath,
      TRAYCER_TEST_CODEX_SCENARIO: "approval",
      PATH: process.env.PATH,
    });

    await runner.run(
      {
        harnessId: "codex",
        model: "gpt-5-codex",
        permissionMode: "full_access",
        reasoningEffort: null,
        serviceTier: null,
        prompt: "approve",
        cwd: dir,
        sessionId: null,
        signal: new AbortController().signal,
      },
      () => {
        return;
      },
    );

    const trace = JSON.parse(await readFile(tracePath, "utf8")) as {
      readonly requests: Array<{
        readonly id?: string;
        readonly method?: string;
        readonly result?: unknown;
      }>;
    };
    const approvalResponse = trace.requests.find(
      (request) => request.id === "approval-1" && request.method === undefined,
    );
    expect(approvalResponse).toEqual({
      jsonrpc: "2.0",
      id: "approval-1",
      result: { decision: "accept" },
    });
  });
});
