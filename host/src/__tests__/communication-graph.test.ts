import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { epicCommunicationGraphSubscribeServerFrameSchema } from "@traycer/protocol/host/epic/communication-graph";
import {
  CommunicationGraphSubscriber,
  graphEvents,
} from "../stream/communication-graph";
import { startHost, type StartedHost } from "../start-host";
import type { StoredChat, StoredTurn } from "../store/host-store";

type Frame = { readonly kind: string; readonly [key: string]: unknown };

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  readonly frames: Frame[] = [];

  send(payload: string): void {
    this.frames.push(
      epicCommunicationGraphSubscribeServerFrameSchema.parse(
        JSON.parse(payload),
      ) as Frame,
    );
  }
}

describe("epic.communicationGraph.subscribe", () => {
  let started: StartedHost | null = null;
  let tempDir: string | null = null;

  afterEach(async () => {
    if (started !== null) {
      await started.close();
      started = null;
    }
    if (tempDir !== null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("projects only turns that came from another agent", async () => {
    const host = await boot();
    await seed(host);
    const events = graphEvents(host.runtime, "epic-1");
    // The chat's own turns are not A2A traffic; the one from `chat-2` is.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: 1,
      kind: "a2a_message",
      senderAgentId: "chat-2",
      receiverAgentId: "chat-1",
      responseId: "thread-1",
      inReplyTo: null,
      expectReply: true,
      messageText: "please review",
      originKind: "gui_message",
      originChatId: "chat-1",
      originRefId: "m-2",
    });
    expect(graphEvents(host.runtime, "epic-other")).toEqual([]);
  });

  it("seeds above the cursor and reports the boundary at open", async () => {
    const host = await boot();
    await seed(host);
    const socket = new FakeSocket();
    new CommunicationGraphSubscriber(
      socket as never,
      host.runtime,
      "epic-1",
      0,
    ).seed();
    expect(socket.frames[0]).toMatchObject({
      kind: "snapshot",
      epicId: "epic-1",
      headId: 1,
    });
    expect((socket.frames[0].events as unknown[]).length).toBe(1);

    // A resume above the last row delivers nothing, but `headId` is still the
    // log's boundary rather than the snapshot's own last row.
    const resumed = new FakeSocket();
    new CommunicationGraphSubscriber(
      resumed as never,
      host.runtime,
      "epic-1",
      1,
    ).seed();
    expect(resumed.frames[0]).toMatchObject({ events: [], headId: 1 });
  });

  it("keeps the delivery that created its own receiver", async () => {
    const host = await boot();
    // A2A to an agent with no chat yet: the host creates the chat to hold the
    // turn, so the receiver must not be dated after the delivery it exists for.
    await host.runtime.store.mutate((state) => {
      const now = Date.now();
      state.chats.push({
        ...blankChat(host.runtime.hostId),
        chatId: "chat-new",
        createdAt: now,
        turns: [turn("m-9", now, "chat-2", "thread-9", true)],
      });
    });
    const events = graphEvents(host.runtime, "epic-1");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: 1,
      senderAgentId: "chat-2",
      receiverAgentId: "chat-new",
    });
  });

  it("ignores a transcript the chat inherited instead of received", async () => {
    const host = await boot();
    await seed(host);
    // `agent.fork` clones the source turns verbatim into a chat with a new id,
    // so every inherited row names some other agent. None of it was delivered
    // here, and the fork is younger than all of it.
    await host.runtime.store.mutate((state) => {
      const source = state.chats[0];
      state.chats.push({
        ...source,
        chatId: "chat-1-fork",
        createdAt: 10,
        turns: source.turns.map((turn) => ({ ...turn })),
      });
    });
    const events = graphEvents(host.runtime, "epic-1");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ receiverAgentId: "chat-1" });

    // What the fork is actually sent afterwards is still real traffic.
    await host.runtime.store.mutate((state) => {
      const fork = state.chats.find((row) => row.chatId === "chat-1-fork");
      fork?.turns.push(turn("m-3", 11, "chat-2", "thread-2", false));
    });
    expect(
      graphEvents(host.runtime, "epic-1").map((event) => event.originRefId),
    ).toEqual(["m-2", "m-3"]);
  });

  it("reports an empty log with a null boundary", async () => {
    const host = await boot();
    const socket = new FakeSocket();
    new CommunicationGraphSubscriber(
      socket as never,
      host.runtime,
      "epic-1",
      0,
    ).seed();
    expect(socket.frames[0]).toMatchObject({ events: [], headId: null });
  });

  async function boot(): Promise<StartedHost> {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    return started;
  }
});

function blankChat(hostId: string): StoredChat {
  return {
    epicId: "epic-1",
    chatId: "chat-1",
    parentId: null,
    hostId,
    title: "Root",
    createdAt: 1,
    runSettings: null,
    fastMode: false,
    providerSession: null,
    turns: [],
    events: [],
    transcriptEpoch: 0,
    indexRevision: 0,
    accumulatedChanges: [],
    lastUsage: null,
    archivedAt: null,
    lastAuthFailureTurnId: null,
    pinnedTodo: null,
  };
}

async function seed(host: StartedHost): Promise<void> {
  const chat: StoredChat = {
    ...blankChat(host.runtime.hostId),
    turns: [
      turn("m-1", 1, "chat-1", null, false),
      turn("m-2", 2, "chat-2", "thread-1", true),
    ],
  };
  await host.runtime.store.mutate((state) => {
    state.chats.push(chat);
  });
}

function turn(
  messageId: string,
  timestamp: number,
  fromAgentId: string,
  responseId: string | null,
  expectReply: boolean,
): StoredTurn {
  return {
    messageId,
    timestamp,
    role: "user",
    prompt: fromAgentId === "chat-1" ? "own turn" : "please review",
    fromAgentId,
    fromTitle: "",
    fromHarnessId: null,
    expectReply,
    responseId,
    userId: "local",
    content: null,
    turnId: null,
    blocks: null,
  };
}
