import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { splitConnectionManifest } from "@traycer/protocol/framework/capability-manifest";
import { hostFrameSchema } from "@traycer/protocol/framework/ws-protocol";
import {
  createAgentRequestSchemaV30,
  createAgentResponseSchema,
  sendAgentMessageRequestSchema,
  sendAgentMessageResponseSchema,
} from "@traycer/protocol/host/agent/shared";
import { chatSubscribeServerFrameSchema } from "@traycer/protocol/host/agent/gui/subscribe";
import { createEpicRequestSchema } from "@traycer/protocol/host/epic/unary-schemas";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { createProcessTurnRunner } from "../cli-runner";
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

    await createParentEpic(connection);
    await setClaudeRunSettings(connection, SENDER_ID);
    const receiver = await createClaudeReceiver(connection, workspace);

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
});

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

async function createParentEpic(connection: RpcConnection): Promise<void> {
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
      workspaces: [],
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
) {
  const frame = await rpc(
    connection,
    "create-claude-receiver",
    "agent.create",
    { major: 3, minor: 0 },
    createAgentRequestSchemaV30.parse({
      senderAgentId: SENDER_ID,
      epicId: EPIC_ID,
      name: "Autonomous reply agent",
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
