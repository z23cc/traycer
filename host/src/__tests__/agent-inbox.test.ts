import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { splitConnectionManifest } from "@traycer/protocol/framework/capability-manifest";
import {
  hostFrameSchema,
  type HostFrame,
} from "@traycer/protocol/framework/ws-protocol";
import {
  agentInboxMessageSchemaV12,
  agentInboxReadResponseSchemaV20,
  agentInboxSubscribeServerFrameSchemaV10,
} from "@traycer/protocol/host/agent/inbox";
import {
  sendAgentMessageResponseSchema,
  listAgentsResponseSchemaV60,
} from "@traycer/protocol/host/agent/shared";
import { chatSubscribeServerFrameSchema } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  createEpicRequestSchema,
  createTuiAgentResponseSchema,
} from "@traycer/protocol/host/epic/unary-schemas";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { scriptedTurnRunner } from "../cli-runner";
import { startHostServer, type HostServer } from "../server";

describe("local terminal-agent inbox", () => {
  const servers: HostServer[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    while (servers.length > 0) await servers.pop()?.close();
  });

  it("delivers, reads, and acknowledges a durable message for a Claude terminal agent", async () => {
    const server = await startHostServer(0, "host-inbox", {
      runner: scriptedTurnRunner([]),
    });
    servers.push(server);
    const rpc = await openRpc(server.websocketUrl, sockets);
    const now = Date.now();

    expect(
      await rpc.request(
        "create-epic",
        "epic.create",
        { major: 1, minor: 0 },
        createEpicRequestSchema.parse({
          epic: {
            id: "epic-inbox",
            title: "Inbox task",
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
            chatId: "gui-sender",
            parentId: null,
            hostId: "host-inbox",
            title: "GUI sender",
            workspaceMode: "folderless",
            worktreeIntent: null,
            initialMessage: null,
          },
        }),
      ),
    ).toMatchObject({ error: null });

    const created = await rpc.request(
      "create-tui",
      "epic.createTuiAgent",
      { major: 1, minor: 1 },
      {
        epicId: "epic-inbox",
        parentId: "gui-sender",
        title: "Claude terminal",
        harnessId: "claude",
        harnessSessionId: "claude-session",
        terminalAgentArgs: null,
        terminalShellCommand: "/bin/sh",
        terminalShellArgs: [],
        hostId: "host-inbox",
        workspaceFolders: [],
        workspaceMode: "folderless",
        model: "sonnet",
        reasoningEffort: null,
        agentMode: "regular",
        tuiAgentId: "tui-receiver",
        profileId: null,
        forkSourceHarnessSessionId: null,
      },
    );
    expect(created.error).toBeNull();
    expect(createTuiAgentResponseSchema.parse(created.result)).toEqual({
      tuiAgentId: "tui-receiver",
    });

    const inbox = await openInboxStream(server.websocketUrl, sockets, 2);
    const prompt = "Review the local worktree and report back.";
    const sent = await rpc.request(
      "send-message",
      "agent.sendMessage",
      { major: 1, minor: 0 },
      {
        senderAgentId: "gui-sender",
        epicId: "epic-inbox",
        receiverAgentId: "tui-receiver",
        prompt,
        responseId: null,
        expectReply: true,
      },
    );
    expect(sent.error).toBeNull();
    const response = sendAgentMessageResponseSchema.parse(sent.result);
    expect(response.responseId).not.toBeNull();

    const deliveredFrame = await inbox.next();
    expect(deliveredFrame).toMatchObject({
      kind: "message",
      hasBinaryPayload: false,
    });
    if (!isObject(deliveredFrame) || deliveredFrame.kind !== "message") {
      throw new Error("Expected a terminal-agent inbox message");
    }
    const item = agentInboxMessageSchemaV12.parse(deliveredFrame.item);
    expect(item).toMatchObject({
      fromAgentId: "gui-sender",
      senderTitle: "GUI sender",
      senderHarnessId: null,
      epicId: "epic-inbox",
      prompt,
      reply: { expectsReply: true, responseId: response.responseId },
    });

    await new Promise((resolve) => setTimeout(resolve, 2));
    const followUpPrompt = "Include the repository status in that report.";
    const followUp = await rpc.request(
      "send-follow-up",
      "agent.sendMessage",
      { major: 1, minor: 0 },
      {
        senderAgentId: "gui-sender",
        epicId: "epic-inbox",
        receiverAgentId: "tui-receiver",
        prompt: followUpPrompt,
        responseId: null,
        expectReply: true,
      },
    );
    expect(followUp.error).toBeNull();
    const followUpFrame = await inbox.next();
    if (!isObject(followUpFrame) || followUpFrame.kind !== "message") {
      throw new Error("Expected a terminal-agent inbox follow-up");
    }
    const followUpItem = agentInboxMessageSchemaV12.parse(followUpFrame.item);
    expect(followUpItem.prompt).toBe(followUpPrompt);

    const read = await rpc.request(
      "read-inbox",
      "agent.inbox.read",
      { major: 2, minor: 0 },
      { epicId: "epic-inbox", agentId: "tui-receiver", after: null },
    );
    expect(read.error).toBeNull();
    expect(agentInboxReadResponseSchemaV20.parse(read.result)).toEqual({
      messages: [
        {
          reply: item.reply,
          fromAgentId: item.fromAgentId,
          senderTitle: item.senderTitle,
          senderHarnessId: item.senderHarnessId,
          epicId: item.epicId,
          prompt: item.prompt,
          enqueuedAt: item.enqueuedAt,
        },
      ],
      nextCursor: { createdAt: item.enqueuedAt, eventId: item.eventId },
    });

    const nextPage = await rpc.request(
      "read-next-page",
      "agent.inbox.read",
      { major: 2, minor: 0 },
      {
        epicId: "epic-inbox",
        agentId: "tui-receiver",
        after: { createdAt: item.enqueuedAt, eventId: item.eventId },
      },
    );
    expect(nextPage.error).toBeNull();
    expect(agentInboxReadResponseSchemaV20.parse(nextPage.result)).toEqual({
      messages: [
        {
          reply: followUpItem.reply,
          fromAgentId: followUpItem.fromAgentId,
          senderTitle: followUpItem.senderTitle,
          senderHarnessId: followUpItem.senderHarnessId,
          epicId: followUpItem.epicId,
          prompt: followUpItem.prompt,
          enqueuedAt: followUpItem.enqueuedAt,
        },
      ],
      nextCursor: null,
    });

    const acknowledged = await rpc.request(
      "ack-inbox",
      "agent.inbox.ack",
      { major: 1, minor: 0 },
      {
        epicId: "epic-inbox",
        agentId: "tui-receiver",
        eventIds: [item.eventId, followUpItem.eventId],
      },
    );
    expect(acknowledged).toMatchObject({ error: null, result: {} });

    const empty = await rpc.request(
      "read-empty-inbox",
      "agent.inbox.read",
      { major: 2, minor: 0 },
      { epicId: "epic-inbox", agentId: "tui-receiver", after: null },
    );
    expect(empty.error).toBeNull();
    expect(agentInboxReadResponseSchemaV20.parse(empty.result)).toEqual({
      messages: [],
      nextCursor: null,
    });

    inbox.close();
    const legacyPrompt = "This delivery is consumed by a legacy subscriber.";
    expect(
      await rpc.request(
        "send-legacy-message",
        "agent.sendMessage",
        { major: 1, minor: 0 },
        {
          senderAgentId: "gui-sender",
          epicId: "epic-inbox",
          receiverAgentId: "tui-receiver",
          prompt: legacyPrompt,
          responseId: null,
          expectReply: false,
        },
      ),
    ).toMatchObject({ error: null, result: { responseId: null } });

    const legacyInbox = await openInboxStream(
      server.websocketUrl,
      sockets,
      0,
    );
    const legacyFrame = agentInboxSubscribeServerFrameSchemaV10.parse(
      await legacyInbox.next(),
    );
    expect(legacyFrame).toMatchObject({
      kind: "message",
      item: { prompt: legacyPrompt },
    });
    if (legacyFrame.kind !== "message") {
      throw new Error("Expected a legacy terminal-agent inbox message");
    }
    expect("eventId" in legacyFrame.item).toBe(false);

    const autoAcknowledged = await rpc.request(
      "read-auto-acknowledged-inbox",
      "agent.inbox.read",
      { major: 2, minor: 0 },
      { epicId: "epic-inbox", agentId: "tui-receiver", after: null },
    );
    expect(autoAcknowledged.error).toBeNull();
    expect(agentInboxReadResponseSchemaV20.parse(autoAcknowledged.result)).toEqual(
      { messages: [], nextCursor: null },
    );
  });

  it("lets a Claude terminal agent send to a GUI agent through its advertised capability", async () => {
    const server = await startHostServer(0, "host-inbox-sender", {
      runner: scriptedTurnRunner(["Reply received from the terminal agent."]),
    });
    servers.push(server);
    const rpc = await openRpc(server.websocketUrl, sockets);
    const now = Date.now();
    expect(
      await rpc.request(
        "create-sender-epic",
        "epic.create",
        { major: 1, minor: 0 },
        createEpicRequestSchema.parse({
          epic: {
            id: "epic-tui-sender",
            title: "TUI sender task",
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
            chatId: "gui-receiver",
            parentId: null,
            hostId: "host-inbox-sender",
            title: "GUI receiver",
            workspaceMode: "folderless",
            worktreeIntent: null,
            initialMessage: null,
          },
        }),
      ),
    ).toMatchObject({ error: null });
    expect(
      await rpc.request(
        "configure-gui",
        "epic.updateChatRunSettings",
        { major: 1, minor: 1 },
        {
          epicId: "epic-tui-sender",
          chatId: "gui-receiver",
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
    ).toMatchObject({ error: null });
    expect(
      await rpc.request(
        "create-tui-sender",
        "epic.createTuiAgent",
        { major: 1, minor: 1 },
        {
          epicId: "epic-tui-sender",
          parentId: "gui-receiver",
          title: "Terminal sender",
          harnessId: "claude",
          harnessSessionId: "sender-session",
          terminalAgentArgs: null,
          terminalShellCommand: "/bin/sh",
          terminalShellArgs: [],
          hostId: "host-inbox-sender",
          workspaceFolders: [],
          workspaceMode: "folderless",
          model: "sonnet",
          reasoningEffort: null,
          agentMode: "regular",
          tuiAgentId: "tui-sender",
          profileId: null,
          forkSourceHarnessSessionId: null,
        },
      ),
    ).toMatchObject({ error: null });

    const listed = await rpc.request(
      "list-from-tui",
      "agent.list",
      { major: 6, minor: 0 },
      {
        epicId: "epic-tui-sender",
        senderAgentId: "tui-sender",
        scope: "user",
      },
    );
    expect(listed.error).toBeNull();
    const directory = listAgentsResponseSchemaV60.parse(listed.result);
    expect(directory.caller).toEqual({
      agentId: "tui-sender",
      canSendMessages: true,
    });
    expect(
      directory.agents.find((agent) => agent.id === "tui-sender"),
    ).toMatchObject({
      capabilities: { readTranscript: false, sendMessage: true },
    });

    const chat = await openChatStream(
      server.websocketUrl,
      sockets,
      "epic-tui-sender",
      "gui-receiver",
    );
    expect(await chat.next()).toMatchObject({
      kind: "snapshot",
      snapshot: { chat: { messages: [] } },
    });
    const prompt = "Please inspect this from the terminal session.";
    const sent = await rpc.request(
      "send-from-tui",
      "agent.sendMessage",
      { major: 1, minor: 0 },
      {
        senderAgentId: "tui-sender",
        epicId: "epic-tui-sender",
        receiverAgentId: "gui-receiver",
        prompt,
        responseId: null,
        expectReply: false,
      },
    );
    expect(sent).toMatchObject({ error: null, result: { responseId: null } });
    for (let index = 0; index < 20; index += 1) {
      const frame = chatSubscribeServerFrameSchema.parse(await chat.next());
      if (
        frame.kind === "snapshot" &&
        frame.snapshot.runStatus === "idle" &&
        frame.snapshot.chat.messages.length === 2
      ) {
        expect(frame.snapshot.chat.messages[0]).toMatchObject({
          role: "user",
          sender: {
            type: "agent",
            agentId: "tui-sender",
            harnessId: "claude",
          },
          message: { kind: "agent", fromAgentId: "tui-sender" },
        });
        return;
      }
    }
    throw new Error("Timed out waiting for the GUI receiver turn");
  });
});

type RpcConnection = {
  readonly request: (
    requestId: string,
    method: string,
    schemaVersion: { readonly major: number; readonly minor: number },
    params: unknown,
  ) => Promise<Extract<HostFrame, { kind: "response" }>>;
};

async function openRpc(
  websocketUrl: string,
  sockets: WebSocket[],
): Promise<RpcConnection> {
  const socket = new WebSocket(websocketUrl);
  sockets.push(socket);
  await opened(socket);
  const manifest = splitConnectionManifest(
    hostRpcRegistry,
    RELEASED_FLOOR_METHOD_NAMES,
  );
  socket.send(
    JSON.stringify({
      kind: "open",
      token: "local",
      manifest: manifest.manifest,
      optionalManifest: manifest.optionalManifest,
    }),
  );
  expect(await nextHostFrame(socket)).toMatchObject({
    kind: "openAck",
    manifest: { "agent.inbox.read": { major: 2, minor: 0 } },
  });
  return {
    request: async (requestId, method, schemaVersion, params) => {
      socket.send(
        JSON.stringify({
          kind: "request",
          requestId,
          method,
          schemaVersion,
          params,
        }),
      );
      const frame = await nextHostFrame(socket);
      if (frame.kind !== "response") {
        throw new Error(`Expected response, got ${frame.kind}`);
      }
      expect(frame.requestId).toBe(requestId);
      return frame;
    },
  };
}

async function openInboxStream(
  websocketUrl: string,
  sockets: WebSocket[],
  minor: number,
): Promise<{
  readonly next: () => Promise<unknown>;
  readonly close: () => void;
}> {
  const socket = new WebSocket(websocketUrl.replace("/rpc", "/stream"));
  sockets.push(socket);
  const pump = textPump(socket);
  await opened(socket);
  socket.send(
    JSON.stringify({
      kind: "open",
      token: "local",
      manifest: { "agent.inbox.subscribe": { major: 1, minor } },
    }),
  );
  expect(await pump.next()).toMatchObject({
    kind: "openAck",
    manifest: { "agent.inbox.subscribe": { major: 1, minor: 2 } },
  });
  socket.send(
    JSON.stringify({
      kind: "subscribe",
      method: "agent.inbox.subscribe",
      schemaVersion: { major: 1, minor },
      params: { epicId: "epic-inbox", agentId: "tui-receiver" },
    }),
  );
  return { ...pump, close: () => socket.terminate() };
}

async function openChatStream(
  websocketUrl: string,
  sockets: WebSocket[],
  epicId: string,
  chatId: string,
): Promise<{ readonly next: () => Promise<unknown> }> {
  const socket = new WebSocket(websocketUrl.replace("/rpc", "/stream"));
  sockets.push(socket);
  const pump = textPump(socket);
  await opened(socket);
  socket.send(
    JSON.stringify({
      kind: "open",
      token: "local",
      manifest: { "chat.subscribe": { major: 1, minor: 6 } },
    }),
  );
  await pump.next();
  socket.send(
    JSON.stringify({
      kind: "subscribe",
      method: "chat.subscribe",
      schemaVersion: { major: 1, minor: 6 },
      params: { epicId, chatId },
    }),
  );
  return pump;
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOpen = (): void => {
      socket.off("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      socket.off("open", onOpen);
      reject(error);
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

function nextHostFrame(socket: WebSocket): Promise<HostFrame> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData): void => {
      socket.off("error", onError);
      try {
        resolve(hostFrameSchema.parse(JSON.parse(data.toString())));
      } catch (error) {
        reject(error);
      }
    };
    const onError = (error: Error): void => {
      socket.off("message", onMessage);
      reject(error);
    };
    socket.once("message", onMessage);
    socket.once("error", onError);
  });
}

function textPump(socket: WebSocket): {
  readonly next: () => Promise<unknown>;
} {
  const queue: unknown[] = [];
  const waiters: Array<(value: unknown) => void> = [];
  socket.on("message", (data, isBinary) => {
    if (isBinary) return;
    const value: unknown = JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter === undefined) queue.push(value);
    else waiter(value);
  });
  return {
    next: async () => {
      const queued = queue.shift();
      if (queued !== undefined) return queued;
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timed out waiting for inbox frame")),
          2_000,
        );
        waiters.push((value) => {
          clearTimeout(timeout);
          resolve(value);
        });
      });
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
