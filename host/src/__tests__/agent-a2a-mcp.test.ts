import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { splitConnectionManifest } from "@traycer/protocol/framework/capability-manifest";
import { hostFrameSchema } from "@traycer/protocol/framework/ws-protocol";
import {
  createAgentRequestSchemaV30,
  createAgentResponseSchema,
  forkAgentResponseSchema,
  getAgentTranscriptRequestSchema,
  getAgentTranscriptResponseSchema,
  listAgentsRequestSchema,
  listAgentsResponseSchemaV60,
  sendAgentMessageRequestSchema,
  sendAgentMessageResponseSchema,
} from "@traycer/protocol/host/agent/shared";
import {
  chatSubscribeClientFrameSchema,
  chatSubscribeServerFrameSchema,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { createEpicRequestSchema } from "@traycer/protocol/host/epic/unary-schemas";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  createProcessTurnRunner,
  type AgentA2AMcpLaunchContext,
  type TurnRunner,
} from "../cli-runner";
import { startHostServer, type HostServer } from "../server";
import {
  createFakeClaudeA2aFixture,
  FAKE_CLAUDE_AUTONOMOUS_REPLY,
  readFakeClaudeA2aTraces,
} from "./fake-claude-a2a-fixture";

const HOST_ID = "host-local";
const EPIC_ID = "epic-agent-a2a-mcp";
const SENDER_ID = "parent-agent";

describe("host-owned traycer_a2a MCP", () => {
  const servers: HostServer[] = [];
  const sockets: WebSocket[] = [];
  const tempRoots: string[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.terminate();
    }
    while (servers.length > 0) {
      const server = servers.pop();
      if (server !== undefined) {
        await server.close();
      }
    }
    for (const root of tempRoots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets a GUI receiver discover traycer_send_message and autonomously reply to its sender", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-agent-a2a-mcp-"));
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const fakeClaude = await createFakeClaudeA2aFixture(root);
    const runner = createProcessTurnRunner({
      ...process.env,
      PATH: process.env.PATH,
      TRAYCER_CLAUDE_PATH: fakeClaude.path,
      TRAYCER_TEST_A2A_MCP_TRACE: fakeClaude.tracePath,
    });
    const server = await startHostServer(0, HOST_ID, { runner });
    servers.push(server);
    const connection = await openRpc(server.websocketUrl, sockets);

    await createParentEpic(connection, null);
    await setClaudeRunSettings(connection, SENDER_ID);
    const receiver = await createClaudeReceiver(
      connection,
      workspace,
      "reply-receiver",
      "Autonomous reply agent",
    );

    const senderStream = await openChatStream(
      server.websocketUrl,
      sockets,
      SENDER_ID,
    );
    expect(
      chatSubscribeServerFrameSchema.parse(
        JSON.parse(await nextWithin(senderStream.pump, "sender snapshot")),
      ),
    ).toMatchObject({
      kind: "snapshot",
      snapshot: { chat: { messages: [] } },
    });
    const receiverStream = await openChatStream(
      server.websocketUrl,
      sockets,
      receiver.agentId,
    );
    expect(
      chatSubscribeServerFrameSchema.parse(
        JSON.parse(await nextWithin(receiverStream.pump, "receiver snapshot")),
      ),
    ).toMatchObject({
      kind: "snapshot",
      snapshot: { chat: { messages: [] } },
    });

    const sent = await rpc(
      connection,
      "open-agent-reply-thread",
      "agent.sendMessage",
      { major: 1, minor: 0 },
      sendAgentMessageRequestSchema.parse({
        senderAgentId: SENDER_ID,
        epicId: EPIC_ID,
        receiverAgentId: receiver.agentId,
        prompt: "Inspect this request, then answer through your Traycer tool.",
        responseId: null,
        expectReply: true,
      }),
    );
    expect(sent).toMatchObject({ kind: "response", error: null });
    const { responseId } = sendAgentMessageResponseSchema.parse(
      responseResult(sent),
    );
    if (responseId === null) {
      throw new Error("Expected agent.sendMessage to open a reply thread");
    }

    await waitForCompletedSnapshot(receiverStream.pump, 2, "receiver MCP turn");
    const traces = await readFakeClaudeA2aTraces(fakeClaude.tracePath);
    const receiverTrace = traces.find(
      (trace) => trace.agentId === receiver.agentId,
    );
    if (receiverTrace === undefined) {
      throw new Error("Fake Claude did not record the receiver turn");
    }
    expect(receiverTrace.error).toBeNull();
    if (receiverTrace.mcpUrl === null) {
      throw new Error("Fake Claude did not discover the Traycer MCP URL");
    }
    const mcpUrl = new URL(receiverTrace.mcpUrl);
    expect(mcpUrl.protocol).toBe("http:");
    expect(mcpUrl.hostname).toBe("127.0.0.1");
    expect(mcpUrl.port).not.toBe("");
    expect(mcpUrl.pathname).toBe("/mcp");
    expect(receiverTrace.discoveredTools).toContain("traycer_send_message");
    expect(receiverTrace.toolCall).toEqual({
      name: "traycer_send_message",
      arguments: {
        toAgentId: SENDER_ID,
        message: FAKE_CLAUDE_AUTONOMOUS_REPLY,
        expectReply: false,
        responseId,
      },
    });
    expect(receiverTrace.toolResult).toEqual({
      jsonrpc: "2.0",
      id: "tools-call-1",
      result: {
        content: [{ type: "text", text: JSON.stringify({ responseId: null }) }],
      },
    });

    const senderCompleted = await waitForCompletedSnapshot(
      senderStream.pump,
      2,
      "sender reply turn",
    );
    expect(senderCompleted.snapshot.chat.messages[0]).toMatchObject({
      role: "user",
      sender: {
        type: "agent",
        agentId: receiver.agentId,
        reply: { expectsReply: false },
        inReplyTo: responseId,
      },
      message: {
        kind: "agent",
        fromAgentId: receiver.agentId,
        reply: { expectsReply: false },
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: FAKE_CLAUDE_AUTONOMOUS_REPLY }],
            },
          ],
        },
      },
    });
  }, 10_000);

  it("lets a GUI agent stop another active GUI agent through its MCP tool", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-agent-stop-mcp-"));
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const controlled = mcpStoppingRunner();
    const server = await startHostServer(0, HOST_ID, {
      runner: controlled.runner,
    });
    servers.push(server);
    const connection = await openRpc(server.websocketUrl, sockets);
    await createParentEpic(connection, null);
    const caller = await createClaudeReceiver(
      connection,
      workspace,
      "stop-caller",
      "Stop caller",
    );
    const target = await createClaudeReceiver(
      connection,
      workspace,
      "stop-target",
      "Stop target",
    );
    controlled.setAgents(caller.agentId, target.agentId);
    const callerStream = await openChatStream(
      server.websocketUrl,
      sockets,
      caller.agentId,
    );
    const targetStream = await openChatStream(
      server.websocketUrl,
      sockets,
      target.agentId,
    );
    for (const stream of [callerStream, targetStream]) {
      expect(
        chatSubscribeServerFrameSchema.parse(
          JSON.parse(await nextWithin(stream.pump, "initial agent snapshot")),
        ),
      ).toMatchObject({
        kind: "snapshot",
        snapshot: { runStatus: "idle", chat: { messages: [] } },
      });
    }

    sendHumanPrompt(targetStream.ws, target.agentId, "target-running");
    await controlled.targetStarted;
    sendHumanPrompt(callerStream.ws, caller.agentId, "caller-stops-target");
    await controlled.toolCalled;

    expect(controlled.discoveredTools()).toContain("traycer_stop_agent");
    expect(controlled.toolResult()).toEqual({
      stoppedAgentIds: [target.agentId],
      archivedAgentIds: [],
      notArchivedAgentIds: [],
      skippedAgentIds: [],
      failedAgentIds: [],
    });
    expect(controlled.targetWasAborted()).toBe(true);
    const targetCompleted = await waitForCompletedSnapshot(
      targetStream.pump,
      2,
      "stopped target turn",
    );
    expect(targetCompleted.snapshot.runStatus).toBe("idle");
    await waitForCompletedSnapshot(callerStream.pump, 2, "stop caller turn");
  });

  it("lets a GUI agent archive itself through its MCP tool while its turn is active", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-agent-archive-mcp-"));
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    execFileSync("git", ["-C", workspace, "init", "-b", "main"]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.name",
      "Traycer Test",
    ]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.email",
      "traycer@example.com",
    ]);
    await writeFile(join(workspace, "README.md"), "base\n");
    execFileSync("git", ["-C", workspace, "add", "README.md"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);
    const customGuide = "# Local guide\n\nUse Codex for review.\n";
    await writeFile(join(root, "agent-selection-guide.md"), customGuide);
    const controlled = mcpSelfArchivingRunner(workspace);
    const server = await startHostServer(0, HOST_ID, {
      runner: controlled.runner,
      hostHome: root,
      worktreeRoot: join(root, "managed-worktrees"),
    });
    servers.push(server);
    const connection = await openRpc(server.websocketUrl, sockets);
    await createParentEpic(connection, workspace);
    const caller = await createClaudeReceiver(
      connection,
      workspace,
      "archive-self",
      "Archive self",
    );
    controlled.setAgent(caller.agentId);
    tempRoots.push(join(tmpdir(), "traycer-chat-refs", caller.agentId));
    const callerStream = await openChatStream(
      server.websocketUrl,
      sockets,
      caller.agentId,
    );
    expect(
      chatSubscribeServerFrameSchema.parse(
        JSON.parse(await nextWithin(callerStream.pump, "archive snapshot")),
      ),
    ).toMatchObject({
      kind: "snapshot",
      snapshot: { runStatus: "idle", chat: { archivedAt: null } },
    });

    sendHumanPrompt(callerStream.ws, caller.agentId, "caller-archives-self");
    await controlled.toolCalled;

    expect(controlled.discoveredTools()).toContain("traycer_archive_agent");
    expect(controlled.discoveredTools()).toEqual(
      expect.arrayContaining(["traycer_list_agents", "traycer_get_self"]),
    );
    expect(controlled.listResult()).toContain(
      `Agents in epic (relative to you):`,
    );
    expect(controlled.listResult()).toContain(caller.agentId);
    expect(controlled.toolResult()).toEqual({
      agentId: caller.agentId,
      archived: true,
      updated: true,
    });
    expect(controlled.selfResult()).toBe(
      [
        caller.agentId,
        "title: Archive self",
        "archived: yes",
        "surface: gui",
        "harness: claude",
        `host: ${HOST_ID}`,
        `dir: ${workspace}`,
      ].join("\n"),
    );
    expect(controlled.discoveredTools()).toContain("traycer_get_transcript");
    expect(controlled.discoveredTools()).toContain(
      "traycer_agent_selection_guide",
    );
    expect(controlled.discoveredTools()).toContain(
      "traycer_list_epic_workspaces",
    );
    expect(controlled.discoveredTools()).toContain("traycer_create_worktree");
    expect(controlled.discoveredTools()).toContain("traycer_configure_agent");
    expect(controlled.discoveredTools()).toContain(
      "traycer_list_comment_threads",
    );
    expect(controlled.discoveredTools()).toContain(
      "traycer_set_comment_thread_status",
    );
    const registeredWorkspace = await realpath(workspace);
    expect(controlled.epicWorkspacesResult()).toMatchObject({
      workspaces: [
        {
          workspacePath: workspace,
          isGitRepo: true,
          mainBranch: "main",
          worktrees: [
            expect.objectContaining({ worktreePath: registeredWorkspace }),
          ],
        },
      ],
    });
    const epicWorkspaces = controlled.epicWorkspacesResult();
    if (!isEpicWorkspacesResult(epicWorkspaces)) {
      throw new Error(
        "traycer_list_epic_workspaces returned an invalid result",
      );
    }
    expect(epicWorkspaces.workspaces[0]).not.toHaveProperty("presence");
    expect(epicWorkspaces.workspaces[0]).not.toHaveProperty("repoBranchPrefix");
    expect(controlled.selectionGuideResult()).toBe(
      [
        `Agent selection instructions from ${join(root, "agent-selection-guide.md")}:`,
        "",
        customGuide.trimEnd(),
        "",
        "Permission mode: Use `full_access` unless the user's agent selection guide explicitly instructs you to use `supervised` or `auto_accept_edits`; never infer a more restrictive permission mode from the task, the current or parent agent's mode, or a general safety preference.",
      ].join("\n"),
    );
    expect(controlled.transcriptResult()).toBe(
      `The agent's transcript has been written to a file at ${join(
        tmpdir(),
        "traycer-chat-refs",
        caller.agentId,
        "agent-transcript-read",
        "transcript.txt",
      )}.`,
    );
    expect(
      await readFile(
        join(
          tmpdir(),
          "traycer-chat-refs",
          caller.agentId,
          "agent-transcript-read",
          "transcript.txt",
        ),
        "utf8",
      ),
    ).toBe("<user_message>\ncaller-archives-self\n</user_message>");
    const created = controlled.createdAgentResult();
    if (!isCreatedAgentResult(created)) {
      throw new Error("traycer_create_agent returned an invalid result");
    }
    const createdWorktree = controlled.createdWorktreeResult();
    if (!isCreatedWorktreeResult(createdWorktree)) {
      throw new Error("traycer_create_worktree returned an invalid result");
    }
    const listedFrame = await rpc(
      connection,
      "list-after-mcp-create",
      "agent.list",
      { major: 6, minor: 0 },
      listAgentsRequestSchema.parse({
        epicId: EPIC_ID,
        senderAgentId: caller.agentId,
        scope: "user",
      }),
    );
    const listed = listAgentsResponseSchemaV60.parse(
      responseResult(listedFrame),
    );
    expect(listed.agents).toContainEqual(
      expect.objectContaining({
        id: created.agentId,
        parentId: caller.agentId,
        surface: "gui",
        harnessId: "codex",
        title: "MCP-created child",
        folderPaths: [createdWorktree.entries[0].path],
      }),
    );
    const forked = forkAgentResponseSchema.parse(
      controlled.forkedAgentResult(),
    );
    expect(forked).toMatchObject({
      sourceAgentId: created.agentId,
      forkedFromMessageId: null,
      warnings: [],
      effectiveProfileId: null,
      profileOverrideApplied: false,
    });
    expect(listed.agents).toContainEqual(
      expect.objectContaining({
        id: forked.agentId,
        parentId: caller.agentId,
        surface: "gui",
        harnessId: "codex",
        title: "MCP checkpoint fork",
        folderPaths: [createdWorktree.entries[0].path],
      }),
    );
    const forkStream = await openChatStream(
      server.websocketUrl,
      sockets,
      forked.agentId,
    );
    expect(
      chatSubscribeServerFrameSchema.parse(
        JSON.parse(await nextWithin(forkStream.pump, "fork snapshot")),
      ),
    ).toMatchObject({
      kind: "snapshot",
      snapshot: {
        chat: {
          parentId: caller.agentId,
          title: "MCP checkpoint fork",
          messages: [],
          settings: {
            harnessId: "codex",
            model: "gpt-5.4",
            permissionMode: "full_access",
          },
        },
        worktreeBinding: {
          entries: [
            {
              workspacePath: registeredWorkspace,
              worktreePath: createdWorktree.entries[0].path,
              isPrimary: true,
            },
          ],
        },
      },
    });
    expect(createdWorktree.perEntry).toEqual([
      expect.objectContaining({
        workspacePath: workspace,
        ok: true,
        branch: "feature/mcp-delegated",
      }),
    ]);
    expect(controlled.configuredAgentResult()).toBe(
      [
        `Agent ${created.agentId} configured for future turns:`,
        "harness: codex",
        "model: gpt-5.4",
        "profile: --profile ambient",
        "reasoningEffort: -",
        "fastMode: off",
        "permissionMode: auto_accept_edits",
        "agentMode: regular",
      ].join("\n"),
    );
    expect(
      execFileSync("git", [
        "-C",
        createdWorktree.entries[0].path,
        "branch",
        "--show-current",
      ])
        .toString()
        .trim(),
    ).toBe("feature/mcp-delegated");
    const completed = await waitForCompletedSnapshot(
      callerStream.pump,
      2,
      "self-archived caller turn",
    );
    expect(completed.snapshot.chat.archivedAt).toEqual(expect.any(Number));
  });

  it("writes a GUI agent transcript through the public agent.getTranscript RPC", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-agent-transcript-rpc-"));
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const runner: TurnRunner = {
      run: () =>
        Promise.resolve({
          text: "Transcript assistant response.",
          sessionId: null,
        }),
    };
    const server = await startHostServer(0, HOST_ID, { runner });
    servers.push(server);
    const connection = await openRpc(server.websocketUrl, sockets);
    await createParentEpic(connection, null);
    const target = await createClaudeReceiver(
      connection,
      workspace,
      "transcript-target",
      "Transcript target",
    );
    tempRoots.push(join(tmpdir(), "traycer-chat-refs", target.agentId));
    const targetStream = await openChatStream(
      server.websocketUrl,
      sockets,
      target.agentId,
    );
    await nextWithin(targetStream.pump, "transcript target snapshot");
    sendHumanPrompt(targetStream.ws, target.agentId, "Transcript user prompt.");
    await waitForCompletedSnapshot(
      targetStream.pump,
      2,
      "transcript target turn",
    );

    const frame = await rpc(
      connection,
      "get-agent-transcript",
      "agent.getTranscript",
      { major: 1, minor: 0 },
      getAgentTranscriptRequestSchema.parse({
        epicId: EPIC_ID,
        agentId: target.agentId.slice(0, 8),
      }),
    );
    expect(frame).toMatchObject({ kind: "response", error: null });
    const response = getAgentTranscriptResponseSchema.parse(
      responseResult(frame),
    );
    const expectedPath = join(
      tmpdir(),
      "traycer-chat-refs",
      target.agentId,
      "agent-transcript-read",
      "transcript.txt",
    );
    expect(response.transcript).toBe(
      `The agent's transcript has been written to a file at ${expectedPath}.`,
    );
    expect(await readFile(expectedPath, "utf8")).toBe(
      [
        "<user_message>",
        "Transcript user prompt.",
        "</user_message>",
        "",
        "<assistant_response>",
        "Transcript assistant response.",
        "</assistant_response>",
      ].join("\n"),
    );
  });
});

function mcpStoppingRunner(): {
  readonly runner: TurnRunner;
  readonly targetStarted: Promise<void>;
  readonly toolCalled: Promise<void>;
  readonly setAgents: (callerAgentId: string, targetAgentId: string) => void;
  readonly discoveredTools: () => string[];
  readonly toolResult: () => unknown;
  readonly targetWasAborted: () => boolean;
} {
  const targetStarted = deferredSignal();
  const toolCalled = deferredSignal();
  let callerAgentId: string | null = null;
  let targetAgentId: string | null = null;
  let tools: string[] = [];
  let result: unknown = null;
  let targetAborted = false;
  return {
    targetStarted: targetStarted.promise,
    toolCalled: toolCalled.promise,
    setAgents(caller, target) {
      callerAgentId = caller;
      targetAgentId = target;
    },
    discoveredTools: () => [...tools],
    toolResult: () => result,
    targetWasAborted: () => targetAborted,
    runner: {
      async run(request) {
        const agentId = request.traycerAgentEnv?.agentId;
        if (agentId === targetAgentId) {
          targetStarted.resolve();
          if (!request.signal.aborted) {
            await new Promise<void>((resolve) => {
              request.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          }
          targetAborted = request.signal.aborted;
          return { text: "", sessionId: null };
        }
        if (agentId !== callerAgentId || targetAgentId === null) {
          throw new Error(
            `Unexpected A2A stop runner agent: ${String(agentId)}`,
          );
        }
        const mcp = request.traycerA2AMcp;
        if (mcp === undefined) {
          throw new Error("Caller turn had no host-owned A2A MCP context");
        }
        const initialized = await postMcpTool(mcp, {
          jsonrpc: "2.0",
          id: "initialize-stop-runner",
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "stop-runner", version: "1.0.0" },
          },
        });
        expect(initialized).toMatchObject({
          result: { capabilities: { tools: {} } },
        });
        const listed = await postMcpTool(mcp, {
          jsonrpc: "2.0",
          id: "list-stop-runner",
          method: "tools/list",
          params: {},
        });
        tools = mcpToolNames(listed);
        const called = await postMcpTool(mcp, {
          jsonrpc: "2.0",
          id: "call-stop-runner",
          method: "tools/call",
          params: {
            name: "traycer_stop_agent",
            arguments: {
              agentId: targetAgentId,
              cascade: false,
              archive: false,
            },
          },
        });
        result = mcpToolJsonResult(called);
        toolCalled.resolve();
        return { text: "Stopped the requested agent.", sessionId: null };
      },
    },
  };
}

function mcpSelfArchivingRunner(workspace: string): {
  readonly runner: TurnRunner;
  readonly toolCalled: Promise<void>;
  readonly setAgent: (agentId: string) => void;
  readonly discoveredTools: () => string[];
  readonly listResult: () => string;
  readonly selfResult: () => string;
  readonly transcriptResult: () => string;
  readonly selectionGuideResult: () => string;
  readonly epicWorkspacesResult: () => unknown;
  readonly createdAgentResult: () => unknown;
  readonly createdWorktreeResult: () => unknown;
  readonly configuredAgentResult: () => string;
  readonly forkedAgentResult: () => unknown;
  readonly toolResult: () => unknown;
} {
  const toolCalled = deferredSignal();
  let callerAgentId: string | null = null;
  let tools: string[] = [];
  let listResult = "";
  let selfResult = "";
  let transcriptResult = "";
  let selectionGuideResult = "";
  let epicWorkspacesResult: unknown = null;
  let createdAgentResult: unknown = null;
  let createdWorktreeResult: unknown = null;
  let configuredAgentResult = "";
  let forkedAgentResult: unknown = null;
  let result: unknown = null;
  return {
    toolCalled: toolCalled.promise,
    setAgent(agentId) {
      callerAgentId = agentId;
    },
    discoveredTools: () => [...tools],
    listResult: () => listResult,
    selfResult: () => selfResult,
    transcriptResult: () => transcriptResult,
    selectionGuideResult: () => selectionGuideResult,
    epicWorkspacesResult: () => epicWorkspacesResult,
    createdAgentResult: () => createdAgentResult,
    createdWorktreeResult: () => createdWorktreeResult,
    configuredAgentResult: () => configuredAgentResult,
    forkedAgentResult: () => forkedAgentResult,
    toolResult: () => result,
    runner: {
      async run(request) {
        const agentId = request.traycerAgentEnv?.agentId;
        if (
          agentId === null ||
          agentId === undefined ||
          agentId !== callerAgentId
        ) {
          throw new Error(
            `Unexpected A2A archive runner agent: ${String(agentId)}`,
          );
        }
        const mcp = request.traycerA2AMcp;
        if (mcp === undefined) {
          throw new Error("Caller turn had no host-owned A2A MCP context");
        }
        await postMcpTool(mcp, {
          jsonrpc: "2.0",
          id: "initialize-archive-runner",
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "archive-runner", version: "1.0.0" },
          },
        });
        const listed = await postMcpTool(mcp, {
          jsonrpc: "2.0",
          id: "list-archive-runner",
          method: "tools/list",
          params: {},
        });
        tools = mcpToolNames(listed);
        try {
          selectionGuideResult = mcpToolTextResult(
            await postMcpTool(mcp, {
              jsonrpc: "2.0",
              id: "call-selection-guide-runner",
              method: "tools/call",
              params: {
                name: "traycer_agent_selection_guide",
                arguments: {},
              },
            }),
          );
          epicWorkspacesResult = mcpToolJsonResult(
            await postMcpTool(mcp, {
              jsonrpc: "2.0",
              id: "call-epic-workspaces-runner",
              method: "tools/call",
              params: {
                name: "traycer_list_epic_workspaces",
                arguments: {},
              },
            }),
          );
          createdWorktreeResult = mcpToolJsonResult(
            await postMcpTool(mcp, {
              jsonrpc: "2.0",
              id: "call-create-worktree-runner",
              method: "tools/call",
              params: {
                name: "traycer_create_worktree",
                arguments: {
                  entries: [
                    {
                      workspacePath: workspace,
                      branch: {
                        type: "new",
                        name: "feature/mcp-delegated",
                        source: "main",
                        carryUncommittedChanges: false,
                      },
                    },
                  ],
                },
              },
            }),
          );
          listResult = mcpToolTextResult(
            await postMcpTool(mcp, {
              jsonrpc: "2.0",
              id: "call-list-runner",
              method: "tools/call",
              params: {
                name: "traycer_list_agents",
                arguments: { scope: null },
              },
            }),
          );
          createdAgentResult = mcpToolJsonResult(
            await postMcpTool(mcp, {
              jsonrpc: "2.0",
              id: "call-create-agent-runner",
              method: "tools/call",
              params: {
                name: "traycer_create_agent",
                arguments: {
                  name: "MCP-created child",
                  profileId: null,
                },
              },
            }),
          );
          if (
            !isCreatedAgentResult(createdAgentResult) ||
            !isCreatedWorktreeResult(createdWorktreeResult)
          ) {
            throw new Error(
              "MCP create tools returned invalid results before configure",
            );
          }
          configuredAgentResult = mcpToolTextResult(
            await postMcpTool(mcp, {
              jsonrpc: "2.0",
              id: "call-configure-agent-runner",
              method: "tools/call",
              params: {
                name: "traycer_configure_agent",
                arguments: {
                  agentId: createdAgentResult.agentId,
                  harnessId: "codex",
                  model: "gpt-5.4",
                  profile: "ambient",
                  permissionMode: "auto_accept_edits",
                  workspace: {
                    entries: [{ path: createdWorktreeResult.entries[0].path }],
                  },
                },
              },
            }),
          );
          forkedAgentResult = mcpToolJsonResult(
            await postMcpTool(mcp, {
              jsonrpc: "2.0",
              id: "call-fork-agent-runner",
              method: "tools/call",
              params: {
                name: "traycer_fork_agent",
                arguments: {
                  agentId: createdAgentResult.agentId,
                  name: "MCP checkpoint fork",
                },
              },
            }),
          );
          const called = await postMcpTool(mcp, {
            jsonrpc: "2.0",
            id: "call-archive-runner",
            method: "tools/call",
            params: {
              name: "traycer_archive_agent",
              arguments: { agentId },
            },
          });
          result = mcpToolJsonResult(called);
          selfResult = mcpToolTextResult(
            await postMcpTool(mcp, {
              jsonrpc: "2.0",
              id: "call-get-self-runner",
              method: "tools/call",
              params: { name: "traycer_get_self", arguments: {} },
            }),
          );
          transcriptResult = mcpToolTextResult(
            await postMcpTool(mcp, {
              jsonrpc: "2.0",
              id: "call-get-transcript-runner",
              method: "tools/call",
              params: {
                name: "traycer_get_transcript",
                arguments: { agentId: agentId.slice(0, 8) },
              },
            }),
          );
        } finally {
          toolCalled.resolve();
        }
        return { text: "Archived this agent.", sessionId: null };
      },
    },
  };
}

function isCreatedAgentResult(
  value: unknown,
): value is { readonly agentId: string; readonly warnings: string[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "agentId") === "string" &&
    Array.isArray(Reflect.get(value, "warnings"))
  );
}

function isCreatedWorktreeResult(value: unknown): value is {
  readonly entries: Array<{ readonly path: string }>;
  readonly perEntry: unknown[];
} {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entries = Reflect.get(value, "entries");
  const first = Array.isArray(entries) ? entries[0] : undefined;
  return (
    typeof first === "object" &&
    first !== null &&
    typeof Reflect.get(first, "path") === "string" &&
    Array.isArray(Reflect.get(value, "perEntry"))
  );
}

function isEpicWorkspacesResult(value: unknown): value is {
  readonly workspaces: unknown[];
} {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray(Reflect.get(value, "workspaces")) &&
    Reflect.get(value, "workspaces").length > 0
  );
}

function sendHumanPrompt(ws: WebSocket, chatId: string, suffix: string): void {
  ws.send(
    JSON.stringify(
      chatSubscribeClientFrameSchema.parse({
        kind: "send",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId,
        clientActionId: `action-${suffix}`,
        messageId: `message-${suffix}`,
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: suffix }],
            },
          ],
        },
        sender: { type: "user", userId: "local-user" },
        settings: {
          harnessId: "claude",
          model: "claude-sonnet-4",
          permissionMode: "full_access",
          reasoningEffort: null,
          serviceTier: null,
          agentMode: "regular",
          profileId: null,
        },
        accountContext: { type: "PERSONAL" },
      }),
    ),
  );
}

type Pump = { readonly next: () => Promise<string> };
type RpcConnection = {
  readonly ws: WebSocket;
  readonly pump: Pump;
};

function attachPump(ws: WebSocket): Pump {
  const pending: string[] = [];
  const waiters: Array<(value: string) => void> = [];
  ws.on("message", (data) => {
    const value = data.toString();
    const waiter = waiters.shift();
    if (waiter === undefined) {
      pending.push(value);
      return;
    }
    waiter(value);
  });
  return {
    next: () =>
      new Promise((resolve) => {
        const value = pending.shift();
        if (value === undefined) {
          waiters.push(resolve);
          return;
        }
        resolve(value);
      }),
  };
}

function nextWithin(pump: Pump, description: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${description}`));
    }, 3_000);
    void pump.next().then((value) => {
      clearTimeout(timeoutId);
      resolve(value);
    });
  });
}

async function waitForOpen(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

async function openRpc(
  url: string,
  sockets: WebSocket[],
): Promise<RpcConnection> {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const pump = attachPump(ws);
  await waitForOpen(ws);
  const split = splitConnectionManifest(
    hostRpcRegistry,
    RELEASED_FLOOR_METHOD_NAMES,
  );
  ws.send(
    JSON.stringify({
      kind: "open",
      token: "local",
      manifest: split.manifest,
      optionalManifest: split.optionalManifest,
    }),
  );
  expect(hostFrameSchema.parse(JSON.parse(await pump.next()))).toMatchObject({
    kind: "openAck",
  });
  return { ws, pump };
}

async function openChatStream(
  rpcUrl: string,
  sockets: WebSocket[],
  chatId: string,
): Promise<{ readonly ws: WebSocket; readonly pump: Pump }> {
  const ws = new WebSocket(rpcUrl.replace("/rpc", "/stream"));
  sockets.push(ws);
  const pump = attachPump(ws);
  await waitForOpen(ws);
  const schemaVersion = { major: 1, minor: 6 } as const;
  ws.send(
    JSON.stringify({
      kind: "open",
      token: "local",
      manifest: { "chat.subscribe": schemaVersion },
    }),
  );
  expect(
    JSON.parse(await nextWithin(pump, "stream open acknowledgement")),
  ).toMatchObject({ kind: "openAck" });
  ws.send(
    JSON.stringify({
      kind: "subscribe",
      method: "chat.subscribe",
      schemaVersion,
      params: { epicId: EPIC_ID, chatId },
    }),
  );
  return { ws, pump };
}

async function rpc(
  connection: RpcConnection,
  requestId: string,
  method: string,
  schemaVersion: { readonly major: number; readonly minor: number },
  params: unknown,
): Promise<unknown> {
  connection.ws.send(
    JSON.stringify({
      kind: "request",
      requestId,
      method,
      schemaVersion,
      params,
    }),
  );
  return hostFrameSchema.parse(
    JSON.parse(await nextWithin(connection.pump, `${method} response`)),
  );
}

async function createParentEpic(
  connection: RpcConnection,
  workspacePath: string | null,
): Promise<void> {
  const now = Date.now();
  const frame = await rpc(
    connection,
    "create-epic",
    "epic.create",
    { major: 1, minor: 0 },
    createEpicRequestSchema.parse({
      epic: {
        id: EPIC_ID,
        title: "Autonomous MCP reply task",
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "active",
        createdAt: now,
        updatedAt: now,
        createdBy: "local-user",
        version: "1.0.0",
      },
      repoIdentifiers: [],
      workspaces:
        workspacePath === null
          ? []
          : [
              {
                task: null,
                hostId: HOST_ID,
                workspacePath,
                createdAt: now,
              },
            ],
      chat: {
        chatId: SENDER_ID,
        parentId: null,
        hostId: HOST_ID,
        title: "Parent agent",
        workspaceMode: "folderless",
        worktreeIntent: null,
        initialMessage: null,
      },
    }),
  );
  expect(frame).toMatchObject({ kind: "response", error: null });
}

async function setClaudeRunSettings(
  connection: RpcConnection,
  chatId: string,
): Promise<void> {
  const frame = await rpc(
    connection,
    `settings-${chatId}`,
    "epic.updateChatRunSettings",
    { major: 1, minor: 1 },
    {
      epicId: EPIC_ID,
      chatId,
      settings: {
        harnessId: "claude",
        model: "claude-sonnet-4",
        permissionMode: "full_access",
        reasoningEffort: null,
        serviceTier: null,
        agentMode: "regular",
        profileId: null,
      },
    },
  );
  expect(frame).toMatchObject({ kind: "response", error: null });
}

async function createClaudeReceiver(
  connection: RpcConnection,
  workspace: string,
  requestSuffix: string,
  name: string,
) {
  const frame = await rpc(
    connection,
    `create-claude-receiver-${requestSuffix}`,
    "agent.create",
    { major: 3, minor: 0 },
    createAgentRequestSchemaV30.parse({
      senderAgentId: SENDER_ID,
      epicId: EPIC_ID,
      name,
      surface: "gui",
      harnessId: "claude",
      model: "claude-sonnet-4",
      agentMode: "regular",
      reasoningEffort: null,
      fastMode: null,
      permissionMode: "full_access",
      profileSelection: { kind: "ambient" },
      workspace: { entries: [{ path: workspace }] },
    }),
  );
  expect(frame).toMatchObject({ kind: "response", error: null });
  return createAgentResponseSchema.parse(responseResult(frame));
}

async function postMcpTool(
  mcp: AgentA2AMcpLaunchContext,
  payload: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const response = await fetch(mcp.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${mcp.token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`MCP request failed: ${String(response.status)} ${raw}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    const data = raw
      .split(/\r?\n/)
      .find((line) => line.startsWith("data:"))
      ?.slice("data:".length)
      .trim();
    if (data === undefined || data.length === 0) {
      throw new Error("MCP response contained no JSON or SSE data frame");
    }
    return JSON.parse(data);
  }
}

function mcpToolNames(response: unknown): string[] {
  if (
    typeof response !== "object" ||
    response === null ||
    !("result" in response) ||
    typeof response.result !== "object" ||
    response.result === null ||
    !("tools" in response.result) ||
    !Array.isArray(response.result.tools)
  ) {
    throw new Error("Expected an MCP tools/list response");
  }
  return response.result.tools.flatMap((tool) =>
    typeof tool === "object" &&
    tool !== null &&
    "name" in tool &&
    typeof tool.name === "string"
      ? [tool.name]
      : [],
  );
}

function mcpToolJsonResult(response: unknown): unknown {
  return JSON.parse(mcpToolTextResult(response));
}

function mcpToolTextResult(response: unknown): string {
  if (
    typeof response !== "object" ||
    response === null ||
    !("result" in response) ||
    typeof response.result !== "object" ||
    response.result === null ||
    !("content" in response.result) ||
    !Array.isArray(response.result.content)
  ) {
    throw new Error("Expected an MCP tools/call response");
  }
  const first = response.result.content[0];
  if (
    typeof first !== "object" ||
    first === null ||
    !("text" in first) ||
    typeof first.text !== "string"
  ) {
    throw new Error("Expected text content from MCP tool");
  }
  return first.text;
}

function deferredSignal(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolver: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolver = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (resolver === undefined) {
        throw new Error("Deferred signal was not initialized");
      }
      resolver();
    },
  };
}

function responseResult(frame: unknown): unknown {
  if (
    typeof frame !== "object" ||
    frame === null ||
    !("kind" in frame) ||
    frame.kind !== "response" ||
    !("result" in frame)
  ) {
    throw new Error("Expected an RPC response with a result");
  }
  return frame.result;
}

async function waitForCompletedSnapshot(
  pump: Pump,
  expectedMessageCount: number,
  description: string,
) {
  for (let index = 0; index < 40; index += 1) {
    const frame = chatSubscribeServerFrameSchema.parse(
      JSON.parse(await nextWithin(pump, description)),
    );
    if (
      frame.kind === "snapshot" &&
      frame.snapshot.runStatus === "idle" &&
      frame.snapshot.chat.messages.length === expectedMessageCount
    ) {
      return frame;
    }
  }
  throw new Error(`Timed out waiting for ${description}`);
}
