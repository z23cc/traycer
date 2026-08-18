import {
  chmod,
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
import { z } from "zod";
import { formatAgentMessage } from "@traycer/protocol/agent/a2a-message-format";
import { splitConnectionManifest } from "@traycer/protocol/framework/capability-manifest";
import { hostFrameSchema } from "@traycer/protocol/framework/ws-protocol";
import {
  A2A_MESSAGE_MAX_UTF8_BYTES,
  createAgentRequestSchemaV30,
  createAgentResponseSchema,
  listAgentsRequestSchema,
  listAgentsResponseSchemaV60,
  sendAgentMessageRequestSchema,
  sendAgentMessageResponseSchema,
} from "@traycer/protocol/host/agent/shared";
import {
  chatSubscribeClientFrameSchema,
  chatSubscribeServerFrameSchema,
  chatSubscribeV13,
  chatSubscribeV15,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { createEpicRequestSchema } from "@traycer/protocol/host/epic/unary-schemas";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import type { ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";
import {
  createProcessTurnRunner,
  scriptedTurnRunner,
  type TurnRequest,
  type TurnRunner,
} from "../cli-runner";
import { startHostServer, type HostServer } from "../server";

const HOST_ID = "host-local";
const EPIC_ID = "epic-agent-send";
const SENDER_ID = "parent-agent";
const MESSAGE = "Inspect the delegated workspace.";
const RUNNER_REPLY = "A2A child reply";
const QUEUED_MESSAGE = "Handle this peer instruction after the current turn.";
const EXPECTED_QUEUED_PROMPT = `[traycer:agent-message] from Parent agent (agent parent-agent) [codex]
[traycer:agent-message] No reply is required.

${QUEUED_MESSAGE}`;
const EXPECTED_RUNNER_PROMPT = `[traycer:agent-message] from Parent agent (agent parent-agent) [codex]
[traycer:agent-message] No reply is required.

${MESSAGE}`;

const fakeCodexTraceSchema = z.object({
  cwd: z.string(),
  agentId: z.string().nullable(),
  epicId: z.string().nullable(),
  surface: z.string().nullable(),
  cli: z.string().nullable(),
  requests: z.array(
    z.object({
      method: z.string().optional(),
      params: z
        .object({
          cwd: z.string().nullable().optional(),
          input: z
            .array(
              z.object({
                type: z.string(),
                text: z.string(),
              }),
            )
            .optional(),
        })
        .passthrough()
        .optional(),
    }),
  ),
});

describe("agent.sendMessage", () => {
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

  it("delivers a peer message to a GUI child's bound runtime context", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-agent-send-"));
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const canonicalWorkspace = await realpath(workspace);
    const fakeCodex = await createFakeCodexAppServer(root);
    const runner = createProcessTurnRunner({
      ...process.env,
      PATH: process.env.PATH,
      TRAYCER_CODEX_PATH: fakeCodex.path,
      TRAYCER_TEST_A2A_TRACE: fakeCodex.tracePath,
      // Poison inherited identity so only per-turn receiver injection can pass.
      TRAYCER_AGENT_ID: "wrong-inherited-agent",
      TRAYCER_EPIC_ID: "wrong-inherited-epic",
      TRAYCER_AGENT_CLI_SURFACE: "readonly",
      TRAYCER_CLI: "  ",
    });
    const server = await startHostServer(0, HOST_ID, { runner });
    servers.push(server);
    const rpcConnection = await openRpc(server.websocketUrl, sockets);
    expect(rpcConnection.openAck).toMatchObject({
      kind: "openAck",
      manifest: { "agent.sendMessage": { major: 1, minor: 0 } },
    });

    await createParentEpic(rpcConnection);
    expect(
      await rpc(
        rpcConnection,
        "sender-settings",
        "epic.updateChatRunSettings",
        { major: 1, minor: 1 },
        {
          epicId: EPIC_ID,
          chatId: SENDER_ID,
          settings: {
            harnessId: "codex",
            model: "gpt-5.4",
            permissionMode: "full_access",
            reasoningEffort: null,
            serviceTier: null,
            agentMode: "regular",
            profileId: null,
          },
        },
      ),
    ).toMatchObject({ kind: "response", error: null });

    const createFrame = await rpc(
      rpcConnection,
      "create-receiver",
      "agent.create",
      { major: 3, minor: 0 },
      createAgentRequestSchemaV30.parse({
        senderAgentId: SENDER_ID,
        epicId: EPIC_ID,
        name: "Child agent",
        surface: "gui",
        harnessId: "codex",
        model: "gpt-5.4",
        agentMode: "regular",
        reasoningEffort: null,
        fastMode: null,
        permissionMode: "full_access",
        profileSelection: { kind: "ambient" },
        workspace: { entries: [{ path: workspace }] },
      }),
    );
    expect(createFrame).toMatchObject({ kind: "response", error: null });
    const receiver = createAgentResponseSchema.parse(
      responseResult(createFrame),
    );

    const receiverStream = await openChatStream(
      server.websocketUrl,
      sockets,
      receiver.agentId,
    );
    const initialSnapshot = chatSubscribeServerFrameSchema.parse(
      JSON.parse(await receiverStream.pump.next()),
    );
    expect(initialSnapshot).toMatchObject({
      kind: "snapshot",
      snapshot: { chat: { id: receiver.agentId, messages: [] } },
    });

    const sendFrame = await rpc(
      rpcConnection,
      "send-to-receiver",
      "agent.sendMessage",
      { major: 1, minor: 0 },
      sendAgentMessageRequestSchema.parse({
        senderAgentId: SENDER_ID,
        epicId: EPIC_ID,
        receiverAgentId: receiver.agentId,
        prompt: MESSAGE,
        responseId: null,
        expectReply: false,
      }),
    );
    expect(sendFrame).toMatchObject({ kind: "response", error: null });
    expect(
      sendAgentMessageResponseSchema.parse(responseResult(sendFrame)),
    ).toEqual({ responseId: null });

    const completedSnapshot = await waitForCompletedSnapshot(
      receiverStream.pump,
      2,
    );
    expect(completedSnapshot.snapshot.chat.messages[0]).toMatchObject({
      role: "user",
      sender: {
        type: "agent",
        harnessId: "codex",
        agentId: SENDER_ID,
        displayName: "Parent agent",
        reply: { expectsReply: false },
        inReplyTo: null,
      },
      message: {
        kind: "agent",
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: MESSAGE }],
            },
          ],
        },
        fromAgentId: SENDER_ID,
        senderTitle: "Parent agent",
        senderHarnessId: "codex",
        reply: { expectsReply: false },
      },
    });
    expect(completedSnapshot.snapshot.chat.messages[1]).toMatchObject({
      role: "assistant",
      blocks: [expect.objectContaining({ type: "text", text: RUNNER_REPLY })],
    });

    const trace = fakeCodexTraceSchema.parse(
      JSON.parse(await readFile(fakeCodex.tracePath, "utf8")),
    );
    expect(trace).toMatchObject({
      cwd: canonicalWorkspace,
      agentId: receiver.agentId,
      epicId: EPIC_ID,
      surface: "full",
      cli: "traycer",
    });
    const turnStart = trace.requests.find(
      (request) => request.method === "turn/start",
    );
    expect(turnStart?.params).toMatchObject({
      cwd: workspace,
      input: [{ type: "text", text: EXPECTED_RUNNER_PROMPT }],
    });
  });

  it("delivers an empty peer prompt with the canonical envelope and empty paragraph shape", async () => {
    const requests: TurnRequest[] = [];
    const runnerReply = "empty prompt reply";
    const runner: TurnRunner = {
      async run(request, emit) {
        requests.push(request);
        emit({ kind: "text", text: runnerReply });
        return { text: runnerReply, sessionId: null };
      },
    };
    const server = await startHostServer(0, HOST_ID, { runner });
    servers.push(server);
    const connection = await openRpc(server.websocketUrl, sockets);
    await createParentEpic(connection);
    expect(
      await rpc(
        connection,
        "empty-sender-settings",
        "epic.updateChatRunSettings",
        { major: 1, minor: 1 },
        {
          epicId: EPIC_ID,
          chatId: SENDER_ID,
          settings: {
            harnessId: "codex",
            model: "gpt-5.4",
            permissionMode: "full_access",
            reasoningEffort: null,
            serviceTier: null,
            agentMode: "regular",
            profileId: null,
          },
        },
      ),
    ).toMatchObject({ kind: "response", error: null });

    const createFrame = await rpc(
      connection,
      "empty-create-receiver",
      "agent.create",
      { major: 3, minor: 0 },
      createAgentRequestSchemaV30.parse({
        senderAgentId: SENDER_ID,
        epicId: EPIC_ID,
        name: "Child agent",
        surface: "gui",
        harnessId: "codex",
        model: "gpt-5.4",
        agentMode: "regular",
        reasoningEffort: null,
        fastMode: null,
        permissionMode: "full_access",
        profileSelection: { kind: "ambient" },
        workspace: { entries: [{ path: process.cwd() }] },
      }),
    );
    expect(createFrame).toMatchObject({ kind: "response", error: null });
    const receiver = createAgentResponseSchema.parse(
      responseResult(createFrame),
    );
    const receiverStream = await openChatStream(
      server.websocketUrl,
      sockets,
      receiver.agentId,
    );
    expect(
      chatSubscribeServerFrameSchema.parse(
        JSON.parse(await receiverStream.pump.next()),
      ),
    ).toMatchObject({
      kind: "snapshot",
      snapshot: { chat: { messages: [] } },
    });

    const sendFrame = await rpc(
      connection,
      "empty-send",
      "agent.sendMessage",
      { major: 1, minor: 0 },
      sendAgentMessageRequestSchema.parse({
        senderAgentId: SENDER_ID,
        epicId: EPIC_ID,
        receiverAgentId: receiver.agentId,
        prompt: "",
        responseId: null,
        expectReply: false,
      }),
    );
    expect(sendFrame).toMatchObject({ kind: "response", error: null });
    expect(
      sendAgentMessageResponseSchema.parse(responseResult(sendFrame)),
    ).toEqual({ responseId: null });

    const completed = await waitForCompletedSnapshot(receiverStream.pump, 2);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.prompt).toBe(
      formatAgentMessage({
        receiverChannel: "gui",
        sender: {
          agentId: SENDER_ID,
          title: "Parent agent",
          harnessId: "codex",
        },
        reply: { expectsReply: false },
        body: "",
      }),
    );
    const delivered = completed.snapshot.chat.messages[0];
    if (
      delivered === undefined ||
      delivered.role !== "user" ||
      delivered.message.kind !== "agent"
    ) {
      throw new Error("Expected an agent-authored user message");
    }
    expect(delivered.message.content).toEqual({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
    expect(completed.snapshot.chat.messages[1]).toMatchObject({
      role: "assistant",
      blocks: [expect.objectContaining({ type: "text", text: runnerReply })],
    });
  });

  it("rejects an oversized UTF-8 prompt before resolving participants or mutating the receiver", async () => {
    const requests: TurnRequest[] = [];
    const runner: TurnRunner = {
      async run(request) {
        requests.push(request);
        return { text: "must not run", sessionId: null };
      },
    };
    const server = await startHostServer(0, HOST_ID, { runner });
    servers.push(server);
    const connection = await openRpc(server.websocketUrl, sockets);
    await createParentEpic(connection);

    const createFrame = await rpc(
      connection,
      "size-create-receiver",
      "agent.create",
      { major: 3, minor: 0 },
      createAgentRequestSchemaV30.parse({
        senderAgentId: SENDER_ID,
        epicId: EPIC_ID,
        name: "Size limit child",
        surface: "gui",
        harnessId: "codex",
        model: "gpt-5.4",
        agentMode: "regular",
        reasoningEffort: null,
        fastMode: null,
        permissionMode: "full_access",
        profileSelection: { kind: "ambient" },
        workspace: { entries: [{ path: process.cwd() }] },
      }),
    );
    expect(createFrame).toMatchObject({ kind: "response", error: null });
    const receiver = createAgentResponseSchema.parse(
      responseResult(createFrame),
    );
    const receiverStream = await openChatStream(
      server.websocketUrl,
      sockets,
      receiver.agentId,
    );
    expect(
      chatSubscribeServerFrameSchema.parse(
        JSON.parse(await receiverStream.pump.next()),
      ),
    ).toMatchObject({
      kind: "snapshot",
      snapshot: { chat: { messages: [], events: [] } },
    });

    const exactLimitPrompt = "é".repeat(A2A_MESSAGE_MAX_UTF8_BYTES / 2);
    const boundaryFrame = await rpc(
      connection,
      "size-exact-limit",
      "agent.sendMessage",
      { major: 1, minor: 0 },
      sendAgentMessageRequestSchema.parse({
        senderAgentId: "missing-sender",
        epicId: EPIC_ID,
        receiverAgentId: receiver.agentId,
        prompt: exactLimitPrompt,
        responseId: null,
        expectReply: true,
      }),
    );
    expect(boundaryFrame).toMatchObject({
      kind: "response",
      result: null,
      error: {
        code: "RPC_ERROR",
        message:
          "agent.sendMessage: sender agent 'missing-sender' was not found.",
      },
    });

    const oversizedFrame = await rpc(
      connection,
      "size-over-limit",
      "agent.sendMessage",
      { major: 1, minor: 0 },
      sendAgentMessageRequestSchema.parse({
        senderAgentId: "missing-sender",
        epicId: EPIC_ID,
        receiverAgentId: receiver.agentId,
        prompt: `${exactLimitPrompt}a`,
        responseId: null,
        expectReply: true,
      }),
    );
    expect(oversizedFrame).toMatchObject({
      kind: "response",
      result: null,
      error: {
        code: "MESSAGE_TOO_LARGE",
        message: "Message exceeds the maximum size.",
      },
    });
    expect(requests).toEqual([]);

    const receiverProbe = await openChatStream(
      server.websocketUrl,
      sockets,
      receiver.agentId,
    );
    expect(
      chatSubscribeServerFrameSchema.parse(
        JSON.parse(await receiverProbe.pump.next()),
      ),
    ).toMatchObject({
      kind: "snapshot",
      snapshot: {
        chat: { messages: [], events: [] },
        runStatus: "idle",
        activeTurn: null,
      },
    });
  });

  it("publishes an accepted peer message after its message frame and persists the event", async () => {
    const controlled = controlledTwoTurnRunner();
    const server = await startHostServer(0, HOST_ID, {
      runner: controlled.runner,
    });
    servers.push(server);
    const connection = await openRpc(server.websocketUrl, sockets);
    await createParentEpic(connection);
    expect(
      await rpc(
        connection,
        "accepted-sender-settings",
        "epic.updateChatRunSettings",
        { major: 1, minor: 1 },
        {
          epicId: EPIC_ID,
          chatId: SENDER_ID,
          settings: {
            harnessId: "codex",
            model: "gpt-5.4",
            permissionMode: "full_access",
            reasoningEffort: null,
            serviceTier: null,
            agentMode: "regular",
            profileId: null,
          },
        },
      ),
    ).toMatchObject({ kind: "response", error: null });

    const createFrame = await rpc(
      connection,
      "accepted-create-receiver",
      "agent.create",
      { major: 3, minor: 0 },
      createAgentRequestSchemaV30.parse({
        senderAgentId: SENDER_ID,
        epicId: EPIC_ID,
        name: "Child agent",
        surface: "gui",
        harnessId: "codex",
        model: "gpt-5.4",
        agentMode: "regular",
        reasoningEffort: null,
        fastMode: null,
        permissionMode: "full_access",
        profileSelection: { kind: "ambient" },
        workspace: { entries: [{ path: process.cwd() }] },
      }),
    );
    expect(createFrame).toMatchObject({ kind: "response", error: null });
    const receiver = createAgentResponseSchema.parse(
      responseResult(createFrame),
    );
    const receiverStream = await openChatStream(
      server.websocketUrl,
      sockets,
      receiver.agentId,
    );
    expect(
      chatSubscribeServerFrameSchema.parse(
        JSON.parse(await receiverStream.pump.next()),
      ),
    ).toMatchObject({
      kind: "snapshot",
      snapshot: { chat: { messages: [], events: [] } },
    });

    try {
      const sendFrame = await rpc(
        connection,
        "accepted-send",
        "agent.sendMessage",
        { major: 1, minor: 0 },
        sendAgentMessageRequestSchema.parse({
          senderAgentId: SENDER_ID,
          epicId: EPIC_ID,
          receiverAgentId: receiver.agentId,
          prompt: "Publish the accepted lifecycle event.",
          responseId: null,
          expectReply: false,
        }),
      );
      expect(sendFrame).toMatchObject({ kind: "response", error: null });
      expect(
        sendAgentMessageResponseSchema.parse(responseResult(sendFrame)),
      ).toEqual({ responseId: null });
      await controlled.firstStarted;

      const listConnection = await openRpc(server.websocketUrl, sockets);
      const activeListFrame = await rpc(
        listConnection,
        "accepted-list-active",
        "agent.list",
        { major: 6, minor: 0 },
        listAgentsRequestSchema.parse({
          epicId: EPIC_ID,
          senderAgentId: SENDER_ID,
          scope: "all",
        }),
      );
      expect(activeListFrame).toMatchObject({
        kind: "response",
        error: null,
      });
      const activeList = listAgentsResponseSchemaV60.parse(
        responseResult(activeListFrame),
      );
      expect(
        activeList.agents.find((agent) => agent.id === receiver.agentId),
      ).toMatchObject({
        id: receiver.agentId,
        active: true,
        folderPaths: [process.cwd()],
      });

      let acceptedMessageId: string | null = null;
      for (let index = 0; index < 40; index += 1) {
        const frame = chatSubscribeServerFrameSchema.parse(
          JSON.parse(
            await nextPumpWithin(
              receiverStream.pump,
              "the peer messageAccepted frame",
            ),
          ),
        );
        if (
          frame.kind === "eventAppended" &&
          frame.event.type === "send.accepted"
        ) {
          throw new Error("send.accepted preceded messageAccepted");
        }
        if (frame.kind !== "messageAccepted") {
          continue;
        }
        expect(frame.message).toMatchObject({
          role: "user",
          sender: {
            type: "agent",
            agentId: SENDER_ID,
            reply: { expectsReply: false },
            inReplyTo: null,
          },
        });
        acceptedMessageId = frame.message.messageId;
        break;
      }
      if (acceptedMessageId === null) {
        throw new Error("Expected messageAccepted before send.accepted");
      }
      expect(acceptedMessageId).toMatch(/^agent-msg-/);

      const activeProbe = await openChatStream(
        server.websocketUrl,
        sockets,
        receiver.agentId,
      );
      const activeSnapshot = chatSubscribeServerFrameSchema.parse(
        JSON.parse(await activeProbe.pump.next()),
      );
      if (activeSnapshot.kind !== "snapshot") {
        throw new Error("Expected an active receiver snapshot");
      }
      const persistedEvent = activeSnapshot.snapshot.chat.events.find(
        (event) =>
          event.type === "send.accepted" &&
          event.messageId === acceptedMessageId,
      );
      expect(persistedEvent).toEqual({
        eventId: expect.any(String),
        type: "send.accepted",
        timestamp: expect.any(Number),
        clientActionId: null,
        actor: {
          type: "agent",
          harnessId: "codex",
          agentId: SENDER_ID,
          displayName: "Parent agent",
          reply: { expectsReply: false },
          inReplyTo: null,
        },
        message: "Message accepted.",
        turnId: null,
        messageId: acceptedMessageId,
        queueItemId: null,
        approvalId: null,
        blockId: null,
        severity: "info",
        metadata: null,
      });
      if (persistedEvent === undefined) {
        throw new Error("Expected send.accepted in the fresh snapshot");
      }

      let sawStreamedEvent = false;
      for (let index = 0; index < 40; index += 1) {
        const frame = chatSubscribeServerFrameSchema.parse(
          JSON.parse(
            await nextPumpWithin(
              receiverStream.pump,
              "send.accepted after messageAccepted",
            ),
          ),
        );
        if (
          frame.kind === "eventAppended" &&
          frame.event.type === "send.accepted"
        ) {
          expect(frame.event).toEqual(persistedEvent);
          sawStreamedEvent = true;
          break;
        }
      }
      expect(sawStreamedEvent).toBe(true);

      controlled.releaseFirst();
      const completed = await waitForCompletedSnapshot(receiverStream.pump, 2);
      expect(
        completed.snapshot.chat.events.find(
          (event) => event.eventId === persistedEvent.eventId,
        ),
      ).toEqual(persistedEvent);
      expect(completed.snapshot.chat.messages[1]).toMatchObject({
        role: "assistant",
        blocks: [
          expect.objectContaining({ type: "text", text: "human turn reply" }),
        ],
      });
      const idleListFrame = await rpc(
        listConnection,
        "accepted-list-idle",
        "agent.list",
        { major: 6, minor: 0 },
        listAgentsRequestSchema.parse({
          epicId: EPIC_ID,
          senderAgentId: SENDER_ID,
          scope: "all",
        }),
      );
      expect(idleListFrame).toMatchObject({ kind: "response", error: null });
      const idleList = listAgentsResponseSchemaV60.parse(
        responseResult(idleListFrame),
      );
      expect(
        idleList.agents.find((agent) => agent.id === receiver.agentId),
      ).toMatchObject({
        id: receiver.agentId,
        active: false,
        folderPaths: [process.cwd()],
      });
    } finally {
      controlled.releaseFirst();
    }
  });

  it("reuses an expected-reply thread and persists the reverse reply on the requester", async () => {
    const server = await startHostServer(0, HOST_ID, {
      runner: scriptedTurnRunner(["runtime ack"]),
    });
    servers.push(server);
    const connection = await openRpc(server.websocketUrl, sockets);
    await createParentEpic(connection);
    expect(
      await rpc(
        connection,
        "thread-sender-settings",
        "epic.updateChatRunSettings",
        { major: 1, minor: 1 },
        {
          epicId: EPIC_ID,
          chatId: SENDER_ID,
          settings: {
            harnessId: "codex",
            model: "gpt-5.4",
            permissionMode: "full_access",
            reasoningEffort: null,
            serviceTier: null,
            agentMode: "regular",
            profileId: null,
          },
        },
      ),
    ).toMatchObject({ kind: "response", error: null });

    const createFrame = await rpc(
      connection,
      "thread-create-receiver",
      "agent.create",
      { major: 3, minor: 0 },
      createAgentRequestSchemaV30.parse({
        senderAgentId: SENDER_ID,
        epicId: EPIC_ID,
        name: "Child agent",
        surface: "gui",
        harnessId: "codex",
        model: "gpt-5.4",
        agentMode: "regular",
        reasoningEffort: null,
        fastMode: null,
        permissionMode: "full_access",
        profileSelection: { kind: "ambient" },
        workspace: { entries: [{ path: process.cwd() }] },
      }),
    );
    expect(createFrame).toMatchObject({ kind: "response", error: null });
    const receiver = createAgentResponseSchema.parse(
      responseResult(createFrame),
    );
    const senderStream = await openChatStream(
      server.websocketUrl,
      sockets,
      SENDER_ID,
    );
    const receiverStream = await openChatStream(
      server.websocketUrl,
      sockets,
      receiver.agentId,
    );
    expect(
      chatSubscribeServerFrameSchema.parse(
        JSON.parse(await senderStream.pump.next()),
      ),
    ).toMatchObject({
      kind: "snapshot",
      snapshot: { chat: { messages: [] } },
    });
    expect(
      chatSubscribeServerFrameSchema.parse(
        JSON.parse(await receiverStream.pump.next()),
      ),
    ).toMatchObject({
      kind: "snapshot",
      snapshot: { chat: { messages: [] } },
    });

    const openedFrame = await rpc(
      connection,
      "thread-open",
      "agent.sendMessage",
      { major: 1, minor: 0 },
      sendAgentMessageRequestSchema.parse({
        senderAgentId: SENDER_ID,
        epicId: EPIC_ID,
        receiverAgentId: receiver.agentId,
        prompt: "Please investigate and reply.",
        responseId: null,
        expectReply: true,
      }),
    );
    expect(openedFrame).toMatchObject({ kind: "response", error: null });
    const opened = sendAgentMessageResponseSchema.parse(
      responseResult(openedFrame),
    );
    expect(opened.responseId).not.toBeNull();
    if (opened.responseId === null) {
      throw new Error("Expected agent.sendMessage to open a reply thread");
    }
    const responseId = opened.responseId;
    expect(responseId.length).toBeGreaterThan(0);

    const firstReceiverSnapshot = await waitForCompletedSnapshot(
      receiverStream.pump,
      2,
    );
    expect(firstReceiverSnapshot.snapshot.chat.messages[0]).toMatchObject({
      role: "user",
      sender: {
        type: "agent",
        agentId: SENDER_ID,
        reply: { expectsReply: true, responseId },
        inReplyTo: null,
      },
      message: {
        kind: "agent",
        fromAgentId: SENDER_ID,
        reply: { expectsReply: true, responseId },
      },
    });

    const followUpFrame = await rpc(
      connection,
      "thread-follow-up",
      "agent.sendMessage",
      { major: 1, minor: 0 },
      sendAgentMessageRequestSchema.parse({
        senderAgentId: SENDER_ID,
        epicId: EPIC_ID,
        receiverAgentId: receiver.agentId,
        prompt: "One more detail for the same request.",
        responseId: null,
        expectReply: true,
      }),
    );
    expect(followUpFrame).toMatchObject({ kind: "response", error: null });
    expect(
      sendAgentMessageResponseSchema.parse(responseResult(followUpFrame)),
    ).toEqual({ responseId });
    const secondReceiverSnapshot = await waitForCompletedSnapshot(
      receiverStream.pump,
      4,
    );
    expect(secondReceiverSnapshot.snapshot.chat.messages[2]).toMatchObject({
      role: "user",
      sender: {
        type: "agent",
        agentId: SENDER_ID,
        reply: { expectsReply: true, responseId },
        inReplyTo: null,
      },
    });

    const replyFrame = await rpc(
      connection,
      "thread-reply",
      "agent.sendMessage",
      { major: 1, minor: 0 },
      sendAgentMessageRequestSchema.parse({
        senderAgentId: receiver.agentId,
        epicId: EPIC_ID,
        receiverAgentId: SENDER_ID,
        prompt: "Investigation complete.",
        responseId,
        expectReply: false,
      }),
    );
    expect(replyFrame).toMatchObject({ kind: "response", error: null });
    expect(
      sendAgentMessageResponseSchema.parse(responseResult(replyFrame)),
    ).toEqual({ responseId: null });

    const senderSnapshot = await waitForCompletedSnapshot(senderStream.pump, 2);
    expect(senderSnapshot.snapshot.chat.messages[0]).toMatchObject({
      role: "user",
      sender: {
        type: "agent",
        agentId: receiver.agentId,
        displayName: "Child agent",
        reply: { expectsReply: false },
        inReplyTo: responseId,
      },
      message: {
        kind: "agent",
        fromAgentId: receiver.agentId,
        senderTitle: "Child agent",
        reply: { expectsReply: false },
      },
    });

    const legacySenderStream = await openChatStreamAtVersion(
      server.websocketUrl,
      sockets,
      SENDER_ID,
      { major: 1, minor: 3 },
    );
    const legacySenderRaw = JSON.parse(await legacySenderStream.pump.next());
    expect(
      chatSubscribeV13.serverFrameSchema.safeParse(legacySenderRaw).success,
    ).toBe(true);
    if (
      typeof legacySenderRaw !== "object" ||
      legacySenderRaw === null ||
      !("kind" in legacySenderRaw) ||
      legacySenderRaw.kind !== "snapshot" ||
      !("snapshot" in legacySenderRaw) ||
      typeof legacySenderRaw.snapshot !== "object" ||
      legacySenderRaw.snapshot === null ||
      !("chat" in legacySenderRaw.snapshot) ||
      typeof legacySenderRaw.snapshot.chat !== "object" ||
      legacySenderRaw.snapshot.chat === null ||
      !("messages" in legacySenderRaw.snapshot.chat) ||
      !Array.isArray(legacySenderRaw.snapshot.chat.messages)
    ) {
      throw new Error("Expected a chat.subscribe@1.3 snapshot");
    }
    const legacyReply = legacySenderRaw.snapshot.chat.messages[0];
    if (
      typeof legacyReply !== "object" ||
      legacyReply === null ||
      !("sender" in legacyReply) ||
      typeof legacyReply.sender !== "object" ||
      legacyReply.sender === null
    ) {
      throw new Error("Expected an agent sender on the legacy snapshot");
    }
    expect("inReplyTo" in legacyReply.sender).toBe(false);
  });

  it("defers a peer message behind an active GUI turn without persisting or running it early", async () => {
    const controlled = controlledTwoTurnRunner();
    const server = await startHostServer(0, HOST_ID, {
      runner: controlled.runner,
    });
    servers.push(server);
    const connection = await openRpc(server.websocketUrl, sockets);
    await createParentEpic(connection);
    expect(
      await rpc(
        connection,
        "queue-sender-settings",
        "epic.updateChatRunSettings",
        { major: 1, minor: 1 },
        {
          epicId: EPIC_ID,
          chatId: SENDER_ID,
          settings: {
            harnessId: "codex",
            model: "gpt-5.4",
            permissionMode: "full_access",
            reasoningEffort: null,
            serviceTier: null,
            agentMode: "regular",
            profileId: null,
          },
        },
      ),
    ).toMatchObject({ kind: "response", error: null });

    const createFrame = await rpc(
      connection,
      "queue-create-receiver",
      "agent.create",
      { major: 3, minor: 0 },
      createAgentRequestSchemaV30.parse({
        senderAgentId: SENDER_ID,
        epicId: EPIC_ID,
        name: "Child agent",
        surface: "gui",
        harnessId: "codex",
        model: "gpt-5.4",
        agentMode: "regular",
        reasoningEffort: null,
        fastMode: null,
        permissionMode: "full_access",
        profileSelection: { kind: "ambient" },
        workspace: { entries: [{ path: process.cwd() }] },
      }),
    );
    expect(createFrame).toMatchObject({ kind: "response", error: null });
    const receiver = createAgentResponseSchema.parse(
      responseResult(createFrame),
    );
    const receiverStream = await openChatStream(
      server.websocketUrl,
      sockets,
      receiver.agentId,
    );
    expect(
      chatSubscribeServerFrameSchema.parse(
        JSON.parse(await receiverStream.pump.next()),
      ),
    ).toMatchObject({
      kind: "snapshot",
      snapshot: { chat: { messages: [] }, runStatus: "idle" },
    });

    receiverStream.ws.send(
      JSON.stringify(
        chatSubscribeClientFrameSchema.parse({
          kind: "send",
          hasBinaryPayload: false,
          epicId: EPIC_ID,
          chatId: receiver.agentId,
          clientActionId: "queue-human-action",
          messageId: "queue-human-message",
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Human turn still running." }],
              },
            ],
          },
          sender: { type: "user", userId: "local-user" },
          settings: {
            harnessId: "codex",
            model: "gpt-5.4",
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
    await controlled.firstStarted;

    try {
      const queuedFrame = await rpc(
        connection,
        "queue-peer-message",
        "agent.sendMessage",
        { major: 1, minor: 0 },
        sendAgentMessageRequestSchema.parse({
          senderAgentId: SENDER_ID,
          epicId: EPIC_ID,
          receiverAgentId: receiver.agentId,
          prompt: QUEUED_MESSAGE,
          responseId: null,
          expectReply: false,
        }),
      );
      expect(queuedFrame).toMatchObject({ kind: "response", error: null });
      expect(
        sendAgentMessageResponseSchema.parse(responseResult(queuedFrame)),
      ).toEqual({ responseId: null });
      expect(controlled.requests).toHaveLength(1);

      const activeProbe = await openChatStream(
        server.websocketUrl,
        sockets,
        receiver.agentId,
      );
      const activeSnapshot = chatSubscribeServerFrameSchema.parse(
        JSON.parse(await activeProbe.pump.next()),
      );
      if (activeSnapshot.kind !== "snapshot") {
        throw new Error("Expected an active receiver snapshot");
      }
      expect(activeSnapshot.snapshot.runStatus).toBe("running");
      expect(activeSnapshot.snapshot.chat.messages).toHaveLength(1);
      expect(activeSnapshot.snapshot.chat.messages[0]).toMatchObject({
        role: "user",
        messageId: "queue-human-message",
        sender: { type: "user", userId: "local-user" },
      });
      expect(activeSnapshot.snapshot.queue.items).toHaveLength(1);
      const queuedItem = activeSnapshot.snapshot.queue.items[0];
      if (queuedItem === undefined || queuedItem.kind !== "prompt") {
        throw new Error("Expected one queued prompt item");
      }
      expect(typeof queuedItem.queueItemId).toBe("string");
      expect(queuedItem.messageId).toMatch(/^agent-msg-/);
      expect(queuedItem).toMatchObject({
        kind: "prompt",
        message: {
          kind: "agent",
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: QUEUED_MESSAGE }],
              },
            ],
          },
          fromAgentId: SENDER_ID,
          senderTitle: "Parent agent",
          senderHarnessId: "codex",
          reply: { expectsReply: false },
        },
        sender: {
          type: "agent",
          harnessId: "codex",
          agentId: SENDER_ID,
          displayName: "Parent agent",
          reply: { expectsReply: false },
          inReplyTo: null,
        },
        settings: {
          harnessId: "codex",
          model: "gpt-5.4",
          permissionMode: "full_access",
          reasoningEffort: null,
          serviceTier: null,
          agentMode: "regular",
          profileId: null,
        },
        delivery: "next_turn",
        status: "pending",
        targetTurnId: null,
        steerRequest: null,
        fallbackReason: null,
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
      });
      expect(controlled.requests).toHaveLength(1);

      const legacyQueueStream = await openChatStreamAtVersion(
        server.websocketUrl,
        sockets,
        receiver.agentId,
        { major: 1, minor: 5 },
      );
      const legacyQueueRaw = JSON.parse(await legacyQueueStream.pump.next());
      expect(
        chatSubscribeV15.serverFrameSchema.safeParse(legacyQueueRaw).success,
      ).toBe(true);
      if (
        typeof legacyQueueRaw !== "object" ||
        legacyQueueRaw === null ||
        !("kind" in legacyQueueRaw) ||
        legacyQueueRaw.kind !== "snapshot" ||
        !("snapshot" in legacyQueueRaw) ||
        typeof legacyQueueRaw.snapshot !== "object" ||
        legacyQueueRaw.snapshot === null ||
        !("queue" in legacyQueueRaw.snapshot) ||
        typeof legacyQueueRaw.snapshot.queue !== "object" ||
        legacyQueueRaw.snapshot.queue === null ||
        !("items" in legacyQueueRaw.snapshot.queue) ||
        !Array.isArray(legacyQueueRaw.snapshot.queue.items)
      ) {
        throw new Error("Expected a chat.subscribe@1.5 queue snapshot");
      }
      const legacyQueueItem = legacyQueueRaw.snapshot.queue.items[0];
      if (typeof legacyQueueItem !== "object" || legacyQueueItem === null) {
        throw new Error("Expected a legacy queued prompt");
      }
      expect("kind" in legacyQueueItem).toBe(false);

      let sawQueueChanged = false;
      let sawQueueAdded = false;
      for (
        let index = 0;
        index < 40 && (!sawQueueChanged || !sawQueueAdded);
        index += 1
      ) {
        const frame = chatSubscribeServerFrameSchema.parse(
          JSON.parse(
            await nextPumpWithin(
              receiverStream.pump,
              "the queued peer-message stream frames",
            ),
          ),
        );
        if (frame.kind === "queueChanged") {
          expect(frame.queue.items).toEqual([queuedItem]);
          sawQueueChanged = true;
        }
        if (
          frame.kind === "eventAppended" &&
          frame.event.type === "queue.added"
        ) {
          expect(frame.event).toMatchObject({
            type: "queue.added",
            messageId: queuedItem.messageId,
            queueItemId: queuedItem.queueItemId,
          });
          sawQueueAdded = true;
        }
      }
      expect(sawQueueChanged).toBe(true);
      expect(sawQueueAdded).toBe(true);

      controlled.releaseFirst();
      await controlled.secondStarted;
      expect(controlled.requests).toHaveLength(2);
      expect(controlled.requests[1]?.prompt).toBe(EXPECTED_QUEUED_PROMPT);

      const dequeueSequence: string[] = [];
      let queueStartedEvent: ChatEvent | null = null;
      let acceptedEvent: ChatEvent | null = null;
      for (
        let index = 0;
        index < 80 && dequeueSequence.length < 4;
        index += 1
      ) {
        const frame = chatSubscribeServerFrameSchema.parse(
          JSON.parse(
            await nextPumpWithin(
              receiverStream.pump,
              "the queued peer-message dequeue lifecycle",
            ),
          ),
        );
        if (
          frame.kind === "eventAppended" &&
          frame.event.type === "queue.started"
        ) {
          dequeueSequence.push("eventAppended(queue.started)");
          expect(frame.event).toMatchObject({
            type: "queue.started",
            queueItemId: queuedItem.queueItemId,
          });
          queueStartedEvent = frame.event;
          continue;
        }
        if (frame.kind === "queueChanged") {
          dequeueSequence.push("queueChanged");
          expect(frame.queue.items).toEqual([]);
          continue;
        }
        if (
          frame.kind === "messageAccepted" &&
          frame.message.role === "user" &&
          frame.message.sender.type === "agent"
        ) {
          dequeueSequence.push("messageAccepted(agent)");
          expect(frame.message.messageId).toBe(queuedItem.messageId);
          expect(frame.message.sender).toEqual(queuedItem.sender);
          expect(frame.message.message).toEqual(queuedItem.message);
          continue;
        }
        if (
          frame.kind === "eventAppended" &&
          frame.event.type === "send.accepted"
        ) {
          dequeueSequence.push("eventAppended(send.accepted)");
          expect(frame.event).toEqual({
            eventId: expect.any(String),
            type: "send.accepted",
            timestamp: expect.any(Number),
            clientActionId: null,
            actor: {
              type: "agent",
              harnessId: "codex",
              agentId: SENDER_ID,
              displayName: "Parent agent",
              reply: { expectsReply: false },
              inReplyTo: null,
            },
            message: "Message accepted.",
            turnId: null,
            messageId: queuedItem.messageId,
            queueItemId: queuedItem.queueItemId,
            approvalId: null,
            blockId: null,
            severity: "info",
            metadata: null,
          });
          acceptedEvent = frame.event;
        }
      }
      expect(dequeueSequence).toEqual([
        "eventAppended(queue.started)",
        "queueChanged",
        "messageAccepted(agent)",
        "eventAppended(send.accepted)",
      ]);
      if (queueStartedEvent === null || acceptedEvent === null) {
        throw new Error("Expected both queued-message lifecycle events");
      }

      const completed = await waitForCompletedSnapshot(receiverStream.pump, 4);
      expect(completed.snapshot.queue.items).toEqual([]);
      expect(completed.snapshot.chat.events).toEqual(
        expect.arrayContaining([queueStartedEvent, acceptedEvent]),
      );
      expect(
        completed.snapshot.chat.messages.map((message) => message.role),
      ).toEqual(["user", "assistant", "user", "assistant"]);
      const timestamps = completed.snapshot.chat.messages.map(
        (message) => message.timestamp,
      );
      expect(timestamps).toEqual(
        [...timestamps].sort((left, right) => left - right),
      );
      expect(completed.snapshot.chat.messages[0]).toMatchObject({
        role: "user",
        messageId: "queue-human-message",
        sender: { type: "user" },
      });
      expect(completed.snapshot.chat.messages[1]).toMatchObject({
        role: "assistant",
        blocks: [
          expect.objectContaining({
            type: "text",
            text: "human turn reply",
          }),
        ],
      });
      expect(completed.snapshot.chat.messages[2]).toMatchObject({
        role: "user",
        sender: {
          type: "agent",
          agentId: SENDER_ID,
          reply: { expectsReply: false },
          inReplyTo: null,
        },
        message: {
          kind: "agent",
          fromAgentId: SENDER_ID,
          reply: { expectsReply: false },
        },
      });
      expect(completed.snapshot.chat.messages[3]).toMatchObject({
        role: "assistant",
        blocks: [
          expect.objectContaining({
            type: "text",
            text: "queued A2A reply",
          }),
        ],
      });
    } finally {
      controlled.releaseFirst();
    }
  });

  it("resolves unique sender and receiver ID prefixes before persisting provenance", async () => {
    const server = await startHostServer(0, HOST_ID, {
      runner: scriptedTurnRunner(["prefix delivered"]),
    });
    servers.push(server);
    const connection = await openRpc(server.websocketUrl, sockets);
    await createParentEpic(connection);
    expect(
      await rpc(
        connection,
        "prefix-sender-settings",
        "epic.updateChatRunSettings",
        { major: 1, minor: 1 },
        {
          epicId: EPIC_ID,
          chatId: SENDER_ID,
          settings: {
            harnessId: "codex",
            model: "gpt-5.4",
            permissionMode: "full_access",
            reasoningEffort: null,
            serviceTier: null,
            agentMode: "regular",
            profileId: null,
          },
        },
      ),
    ).toMatchObject({ kind: "response", error: null });

    const createFrame = await rpc(
      connection,
      "prefix-create-receiver",
      "agent.create",
      { major: 3, minor: 0 },
      createAgentRequestSchemaV30.parse({
        senderAgentId: SENDER_ID,
        epicId: EPIC_ID,
        name: "Child agent",
        surface: "gui",
        harnessId: "codex",
        model: "gpt-5.4",
        agentMode: "regular",
        reasoningEffort: null,
        fastMode: null,
        permissionMode: "full_access",
        profileSelection: { kind: "ambient" },
        workspace: { entries: [{ path: process.cwd() }] },
      }),
    );
    expect(createFrame).toMatchObject({ kind: "response", error: null });
    const receiver = createAgentResponseSchema.parse(
      responseResult(createFrame),
    );
    const receiverPrefix = receiver.agentId.slice(0, 8);
    expect(receiverPrefix).toHaveLength(8);
    const receiverStream = await openChatStream(
      server.websocketUrl,
      sockets,
      receiver.agentId,
    );
    expect(
      chatSubscribeServerFrameSchema.parse(
        JSON.parse(await receiverStream.pump.next()),
      ),
    ).toMatchObject({
      kind: "snapshot",
      snapshot: { chat: { messages: [] } },
    });

    const sendFrame = await rpc(
      connection,
      "prefix-send",
      "agent.sendMessage",
      { major: 1, minor: 0 },
      sendAgentMessageRequestSchema.parse({
        senderAgentId: "pare",
        epicId: EPIC_ID,
        receiverAgentId: receiverPrefix,
        prompt: "Resolve both unique prefixes.",
        responseId: null,
        expectReply: false,
      }),
    );
    expect(sendFrame).toMatchObject({ kind: "response", error: null });
    expect(
      sendAgentMessageResponseSchema.parse(responseResult(sendFrame)),
    ).toEqual({ responseId: null });

    const completed = await waitForCompletedSnapshot(receiverStream.pump, 2);
    expect(completed.snapshot.chat.messages[0]).toMatchObject({
      role: "user",
      sender: {
        type: "agent",
        agentId: SENDER_ID,
        displayName: "Parent agent",
        reply: { expectsReply: false },
        inReplyTo: null,
      },
      message: {
        kind: "agent",
        fromAgentId: SENDER_ID,
        senderTitle: "Parent agent",
        reply: { expectsReply: false },
      },
    });
    expect(completed.snapshot.chat.messages[1]).toMatchObject({
      role: "assistant",
      blocks: [
        expect.objectContaining({ type: "text", text: "prefix delivered" }),
      ],
    });
  });

  it("rejects an idle GUI reply without a workspace before persistence but settles its response thread", async () => {
    const requests: TurnRequest[] = [];
    const runner: TurnRunner = {
      async run(request, emit) {
        requests.push(request);
        const text = `runner reply ${requests.length}`;
        emit({ kind: "text", text });
        return { text, sessionId: null };
      },
    };
    const server = await startHostServer(0, HOST_ID, { runner });
    servers.push(server);
    const connection = await openRpc(server.websocketUrl, sockets);
    await createUnboundParentEpic(connection);
    expect(
      await rpc(
        connection,
        "workspace-null-sender-settings",
        "epic.updateChatRunSettings",
        { major: 1, minor: 1 },
        {
          epicId: EPIC_ID,
          chatId: SENDER_ID,
          settings: {
            harnessId: "codex",
            model: "gpt-5.4",
            permissionMode: "full_access",
            reasoningEffort: null,
            serviceTier: null,
            agentMode: "regular",
            profileId: null,
          },
        },
      ),
    ).toMatchObject({ kind: "response", error: null });

    const createFrame = await rpc(
      connection,
      "workspace-null-create-receiver",
      "agent.create",
      { major: 3, minor: 0 },
      createAgentRequestSchemaV30.parse({
        senderAgentId: SENDER_ID,
        epicId: EPIC_ID,
        name: "Bound child agent",
        surface: "gui",
        harnessId: "codex",
        model: "gpt-5.4",
        agentMode: "regular",
        reasoningEffort: null,
        fastMode: null,
        permissionMode: "full_access",
        profileSelection: { kind: "ambient" },
        workspace: { entries: [{ path: process.cwd() }] },
      }),
    );
    expect(createFrame).toMatchObject({ kind: "response", error: null });
    const receiver = createAgentResponseSchema.parse(
      responseResult(createFrame),
    );
    const receiverStream = await openChatStream(
      server.websocketUrl,
      sockets,
      receiver.agentId,
    );
    expect(
      chatSubscribeServerFrameSchema.parse(
        JSON.parse(await receiverStream.pump.next()),
      ),
    ).toMatchObject({
      kind: "snapshot",
      snapshot: { chat: { messages: [] } },
    });

    const openThreadFrame = await rpc(
      connection,
      "workspace-null-open-thread",
      "agent.sendMessage",
      { major: 1, minor: 0 },
      sendAgentMessageRequestSchema.parse({
        senderAgentId: SENDER_ID,
        epicId: EPIC_ID,
        receiverAgentId: receiver.agentId,
        prompt: "Open a thread before replying to the unbound parent.",
        responseId: null,
        expectReply: true,
      }),
    );
    expect(openThreadFrame).toMatchObject({ kind: "response", error: null });
    const opened = sendAgentMessageResponseSchema.parse(
      responseResult(openThreadFrame),
    );
    if (opened.responseId === null) {
      throw new Error("Expected a non-null response thread id");
    }
    const responseId = opened.responseId;
    await waitForCompletedSnapshot(receiverStream.pump, 2);
    expect(requests).toHaveLength(1);

    const rejectedReplyFrame = await rpc(
      connection,
      "workspace-null-reply",
      "agent.sendMessage",
      { major: 1, minor: 0 },
      sendAgentMessageRequestSchema.parse({
        senderAgentId: receiver.agentId,
        epicId: EPIC_ID,
        receiverAgentId: SENDER_ID,
        prompt: "This reply cannot run without a receiver workspace.",
        responseId,
        expectReply: false,
      }),
    );
    expect(rejectedReplyFrame).toMatchObject({
      kind: "response",
      result: null,
      error: {
        code: "RPC_ERROR",
        message:
          "enqueueAgentMessage: Unable to resolve this agent's workspace selection. " +
          "Choose a workspace before sending a message.",
      },
    });
    expect(requests).toHaveLength(1);

    const parentStream = await openChatStream(
      server.websocketUrl,
      sockets,
      SENDER_ID,
    );
    expect(
      chatSubscribeServerFrameSchema.parse(
        JSON.parse(await parentStream.pump.next()),
      ),
    ).toMatchObject({
      kind: "snapshot",
      snapshot: {
        chat: { messages: [] },
        runStatus: "idle",
        activeTurn: null,
      },
    });

    const settledLiteralFrame = await rpc(
      connection,
      "workspace-null-settled-literal",
      "agent.sendMessage",
      { major: 1, minor: 0 },
      sendAgentMessageRequestSchema.parse({
        senderAgentId: SENDER_ID,
        epicId: EPIC_ID,
        receiverAgentId: receiver.agentId,
        prompt: "The failed reverse delivery already settled this id.",
        responseId,
        expectReply: false,
      }),
    );
    expect(settledLiteralFrame).toMatchObject({
      kind: "response",
      error: null,
    });
    expect(
      sendAgentMessageResponseSchema.parse(responseResult(settledLiteralFrame)),
    ).toEqual({ responseId: null });
    const completed = await waitForCompletedSnapshot(receiverStream.pump, 4);
    expect(completed.snapshot.chat.messages[2]).toMatchObject({
      role: "user",
      sender: { type: "agent", inReplyTo: responseId },
    });
    expect(requests).toHaveLength(2);
  });

  it("rejects an idle GUI delivery whose bound folder is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-agent-send-missing-"));
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const requests: TurnRequest[] = [];
    const runner: TurnRunner = {
      async run(request) {
        requests.push(request);
        return { text: "must not run", sessionId: null };
      },
    };
    const server = await startHostServer(0, HOST_ID, { runner });
    servers.push(server);
    const connection = await openRpc(server.websocketUrl, sockets);
    await createParentEpic(connection);

    const createFrame = await rpc(
      connection,
      "workspace-missing-create-receiver",
      "agent.create",
      { major: 3, minor: 0 },
      createAgentRequestSchemaV30.parse({
        senderAgentId: SENDER_ID,
        epicId: EPIC_ID,
        name: "Missing workspace child",
        surface: "gui",
        harnessId: "codex",
        model: "gpt-5.4",
        agentMode: "regular",
        reasoningEffort: null,
        fastMode: null,
        permissionMode: "full_access",
        profileSelection: { kind: "ambient" },
        workspace: { entries: [{ path: workspace }] },
      }),
    );
    expect(createFrame).toMatchObject({ kind: "response", error: null });
    const receiver = createAgentResponseSchema.parse(
      responseResult(createFrame),
    );
    const receiverStream = await openChatStream(
      server.websocketUrl,
      sockets,
      receiver.agentId,
    );
    expect(
      chatSubscribeServerFrameSchema.parse(
        JSON.parse(await receiverStream.pump.next()),
      ),
    ).toMatchObject({
      kind: "snapshot",
      snapshot: { chat: { messages: [] } },
    });
    await rm(workspace, { recursive: true });

    const sendFrame = await rpc(
      connection,
      "workspace-missing-send",
      "agent.sendMessage",
      { major: 1, minor: 0 },
      sendAgentMessageRequestSchema.parse({
        senderAgentId: SENDER_ID,
        epicId: EPIC_ID,
        receiverAgentId: receiver.agentId,
        prompt: "This must not run in a missing folder.",
        responseId: null,
        expectReply: false,
      }),
    );
    expect(sendFrame).toMatchObject({
      kind: "response",
      result: null,
      error: {
        code: "WORKTREE_MISSING",
        message:
          `A bound folder is missing on disk: ${workspace}. ` +
          "Restore it, re-bind to another folder, or remove it to continue.",
      },
    });
    expect(requests).toEqual([]);

    const receiverProbe = await openChatStream(
      server.websocketUrl,
      sockets,
      receiver.agentId,
    );
    expect(
      chatSubscribeServerFrameSchema.parse(
        JSON.parse(await receiverProbe.pump.next()),
      ),
    ).toMatchObject({
      kind: "snapshot",
      snapshot: {
        chat: { messages: [] },
        runStatus: "idle",
        activeTurn: null,
      },
    });
  });

  it("rejects a response thread used in the wrong direction without rejecting an unknown literal", async () => {
    const server = await startHostServer(0, HOST_ID, {
      runner: scriptedTurnRunner(["thread delivery"]),
    });
    servers.push(server);
    const connection = await openRpc(server.websocketUrl, sockets);
    await createParentEpic(connection);
    expect(
      await rpc(
        connection,
        "mismatch-sender-settings",
        "epic.updateChatRunSettings",
        { major: 1, minor: 1 },
        {
          epicId: EPIC_ID,
          chatId: SENDER_ID,
          settings: {
            harnessId: "codex",
            model: "gpt-5.4",
            permissionMode: "full_access",
            reasoningEffort: null,
            serviceTier: null,
            agentMode: "regular",
            profileId: null,
          },
        },
      ),
    ).toMatchObject({ kind: "response", error: null });

    const createFrame = await rpc(
      connection,
      "mismatch-create-receiver",
      "agent.create",
      { major: 3, minor: 0 },
      createAgentRequestSchemaV30.parse({
        senderAgentId: SENDER_ID,
        epicId: EPIC_ID,
        name: "Child agent",
        surface: "gui",
        harnessId: "codex",
        model: "gpt-5.4",
        agentMode: "regular",
        reasoningEffort: null,
        fastMode: null,
        permissionMode: "full_access",
        profileSelection: { kind: "ambient" },
        workspace: { entries: [{ path: process.cwd() }] },
      }),
    );
    expect(createFrame).toMatchObject({ kind: "response", error: null });
    const receiver = createAgentResponseSchema.parse(
      responseResult(createFrame),
    );
    const senderStream = await openChatStream(
      server.websocketUrl,
      sockets,
      SENDER_ID,
    );
    const receiverStream = await openChatStream(
      server.websocketUrl,
      sockets,
      receiver.agentId,
    );
    expect(
      chatSubscribeServerFrameSchema.parse(
        JSON.parse(await senderStream.pump.next()),
      ),
    ).toMatchObject({
      kind: "snapshot",
      snapshot: { chat: { messages: [] } },
    });
    expect(
      chatSubscribeServerFrameSchema.parse(
        JSON.parse(await receiverStream.pump.next()),
      ),
    ).toMatchObject({
      kind: "snapshot",
      snapshot: { chat: { messages: [] } },
    });

    const openThreadFrame = await rpc(
      connection,
      "mismatch-open-thread",
      "agent.sendMessage",
      { major: 1, minor: 0 },
      sendAgentMessageRequestSchema.parse({
        senderAgentId: SENDER_ID,
        epicId: EPIC_ID,
        receiverAgentId: receiver.agentId,
        prompt: "Open a response thread.",
        responseId: null,
        expectReply: true,
      }),
    );
    expect(openThreadFrame).toMatchObject({ kind: "response", error: null });
    const opened = sendAgentMessageResponseSchema.parse(
      responseResult(openThreadFrame),
    );
    if (opened.responseId === null) {
      throw new Error("Expected a non-null response thread id");
    }
    const responseId = opened.responseId;
    await waitForCompletedSnapshot(receiverStream.pump, 2);

    const mismatchFrame = await rpc(
      connection,
      "mismatch-same-direction",
      "agent.sendMessage",
      { major: 1, minor: 0 },
      sendAgentMessageRequestSchema.parse({
        senderAgentId: SENDER_ID,
        epicId: EPIC_ID,
        receiverAgentId: receiver.agentId,
        prompt: "This must not be delivered.",
        responseId,
        expectReply: false,
      }),
    );
    expect(mismatchFrame).toMatchObject({
      kind: "response",
      result: null,
      error: {
        code: "RPC_ERROR",
        message:
          `agent.sendMessage: RESPONSE_ID_MISMATCH - '${responseId}' ` +
          "belongs to a different (sender, receiver) pair.",
      },
    });

    const receiverProbe = await openChatStream(
      server.websocketUrl,
      sockets,
      receiver.agentId,
    );
    const receiverSnapshot = chatSubscribeServerFrameSchema.parse(
      JSON.parse(await receiverProbe.pump.next()),
    );
    if (receiverSnapshot.kind !== "snapshot") {
      throw new Error("Expected a receiver snapshot after the rejected send");
    }
    expect(receiverSnapshot.snapshot.chat.messages).toHaveLength(2);
    expect(receiverSnapshot.snapshot.chat.messages[0]).toMatchObject({
      role: "user",
      message: {
        kind: "agent",
        content: {
          content: [
            {
              content: [{ type: "text", text: "Open a response thread." }],
            },
          ],
        },
      },
    });

    const unknownResponseId = "unknown-thread-id";
    const unknownReplyFrame = await rpc(
      connection,
      "mismatch-unknown-reverse",
      "agent.sendMessage",
      { major: 1, minor: 0 },
      sendAgentMessageRequestSchema.parse({
        senderAgentId: receiver.agentId,
        epicId: EPIC_ID,
        receiverAgentId: SENDER_ID,
        prompt: "A reply carrying an unknown literal thread id.",
        responseId: unknownResponseId,
        expectReply: false,
      }),
    );
    expect(unknownReplyFrame).toMatchObject({
      kind: "response",
      error: null,
    });
    expect(
      sendAgentMessageResponseSchema.parse(responseResult(unknownReplyFrame)),
    ).toEqual({ responseId: null });

    const senderSnapshot = await waitForCompletedSnapshot(senderStream.pump, 2);
    expect(senderSnapshot.snapshot.chat.messages[0]).toMatchObject({
      role: "user",
      sender: {
        type: "agent",
        agentId: receiver.agentId,
        reply: { expectsReply: false },
        inReplyTo: unknownResponseId,
      },
      message: {
        kind: "agent",
        fromAgentId: receiver.agentId,
        reply: { expectsReply: false },
      },
    });
    expect(
      await rpc(
        connection,
        "mismatch-socket-still-open",
        "host.status",
        { major: 1, minor: 0 },
        {},
      ),
    ).toMatchObject({
      kind: "response",
      result: { ready: true },
      error: null,
    });
  });
});

function controlledTwoTurnRunner(): {
  readonly runner: TurnRunner;
  readonly requests: TurnRequest[];
  readonly firstStarted: Promise<void>;
  readonly secondStarted: Promise<void>;
  readonly releaseFirst: () => void;
} {
  const requests: TurnRequest[] = [];
  const firstStarted = deferredSignal();
  const secondStarted = deferredSignal();
  const firstRelease = deferredSignal();
  let released = false;
  return {
    requests,
    firstStarted: firstStarted.promise,
    secondStarted: secondStarted.promise,
    releaseFirst: () => {
      if (released) {
        return;
      }
      released = true;
      firstRelease.resolve();
    },
    runner: {
      async run(request, emit) {
        requests.push(request);
        if (requests.length === 1) {
          firstStarted.resolve();
          await firstRelease.promise;
          emit({ kind: "text", text: "human turn reply" });
          return { text: "human turn reply", sessionId: "thread-human" };
        }
        if (requests.length === 2) {
          secondStarted.resolve();
          emit({ kind: "text", text: "queued A2A reply" });
          return { text: "queued A2A reply", sessionId: null };
        }
        throw new Error("Unexpected third runner invocation");
      },
    },
  };
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

type Pump = { readonly next: () => Promise<string> };
type RpcConnection = {
  readonly ws: WebSocket;
  readonly pump: Pump;
  readonly openAck: unknown;
};

function nextPumpWithin(pump: Pump, description: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${description}`));
    }, 2_000);
    void pump.next().then((value) => {
      clearTimeout(timeoutId);
      resolve(value);
    });
  });
}

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
  const openAck = hostFrameSchema.parse(JSON.parse(await pump.next()));
  return { ws, pump, openAck };
}

async function openChatStream(
  rpcUrl: string,
  sockets: WebSocket[],
  chatId: string,
): Promise<{ readonly ws: WebSocket; readonly pump: Pump }> {
  return openChatStreamAtVersion(rpcUrl, sockets, chatId, {
    major: 1,
    minor: 6,
  });
}

async function openChatStreamAtVersion(
  rpcUrl: string,
  sockets: WebSocket[],
  chatId: string,
  schemaVersion: { readonly major: number; readonly minor: number },
): Promise<{ readonly ws: WebSocket; readonly pump: Pump }> {
  const ws = new WebSocket(rpcUrl.replace("/rpc", "/stream"));
  sockets.push(ws);
  const pump = attachPump(ws);
  await waitForOpen(ws);
  ws.send(
    JSON.stringify({
      kind: "open",
      token: "local",
      manifest: { "chat.subscribe": schemaVersion },
    }),
  );
  expect(JSON.parse(await pump.next())).toMatchObject({ kind: "openAck" });
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
  return hostFrameSchema.parse(JSON.parse(await connection.pump.next()));
}

async function createParentEpic(connection: RpcConnection): Promise<void> {
  return createParentEpicWithWorkspaceMode(connection, "folderless");
}

async function createUnboundParentEpic(
  connection: RpcConnection,
): Promise<void> {
  return createParentEpicWithWorkspaceMode(connection, undefined);
}

async function createParentEpicWithWorkspaceMode(
  connection: RpcConnection,
  workspaceMode: "folderless" | undefined,
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
        title: "Agent send task",
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
        workspaceMode,
        worktreeIntent: null,
        initialMessage: null,
      },
    }),
  );
  expect(frame).toMatchObject({ kind: "response", error: null });
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
) {
  for (let index = 0; index < 40; index += 1) {
    const frame = chatSubscribeServerFrameSchema.parse(
      JSON.parse(await pump.next()),
    );
    if (
      frame.kind === "snapshot" &&
      frame.snapshot.runStatus === "idle" &&
      frame.snapshot.chat.messages.length === expectedMessageCount
    ) {
      return frame;
    }
  }
  throw new Error("Timed out waiting for the completed receiver snapshot");
}

async function createFakeCodexAppServer(root: string): Promise<{
  readonly path: string;
  readonly tracePath: string;
}> {
  const path = join(root, "codex");
  const tracePath = join(root, "codex-trace.json");
  await writeFile(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const tracePath = process.env.TRAYCER_TEST_A2A_TRACE;
const trace = {
  cwd: process.cwd(),
  agentId: process.env.TRAYCER_AGENT_ID || null,
  epicId: process.env.TRAYCER_EPIC_ID || null,
  surface: process.env.TRAYCER_AGENT_CLI_SURFACE || null,
  cli: process.env.TRAYCER_CLI || null,
  requests: [],
};
function save() { fs.writeFileSync(tracePath, JSON.stringify(trace)); }
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
save();
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  trace.requests.push(request);
  save();
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: {} });
    return;
  }
  if (request.method === "thread/start") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: { thread: { id: "thread-a2a", sessionId: "thread-a2a" } },
    });
    return;
  }
  if (request.method === "turn/start") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: { turn: { id: "turn-a2a" } },
    });
    send({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "thread-a2a", turn: { id: "turn-a2a" } },
    });
    send({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-a2a",
        turnId: "turn-a2a",
        itemId: "message-a2a",
        delta: ${JSON.stringify(RUNNER_REPLY)},
      },
    });
    send({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "thread-a2a", turn: { id: "turn-a2a" } },
    });
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
  return { path, tracePath };
}
