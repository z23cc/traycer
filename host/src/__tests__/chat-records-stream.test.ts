import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostChatRecordsSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/chat-records";
import { ChatRecordsSubscriber } from "../stream/chat-records";
import { handleEpicSetChatArchived } from "../rpc/handlers/epic-handlers";
import { startHost, type StartedHost } from "../start-host";
import type { StoredChat } from "../store/host-store";

type Frame = { readonly kind: string; readonly [key: string]: unknown };

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  readonly frames: Frame[] = [];

  send(payload: string): void {
    // Every frame has to satisfy the contract's own envelope invariant, which
    // refuses an upsert whose id or revision disagrees with its record.
    this.frames.push(
      hostChatRecordsSubscribeServerFrameSchemaV10.parse(
        JSON.parse(payload),
      ) as Frame,
    );
  }
}

describe("host.chatRecords.subscribe", () => {
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

  it("seeds the current table, then pushes the row that changed", async () => {
    const host = await boot();
    await seed(host);
    const socket = new FakeSocket();
    const subscriber = new ChatRecordsSubscriber(socket as never, host.runtime);
    host.runtime.chatRecords.add(socket as never, subscriber);
    subscriber.seed();

    expect(socket.frames).toHaveLength(1);
    expect(socket.frames[0]).toMatchObject({
      kind: "upsert",
      epicId: "epic-1",
      chatId: "chat-1",
    });
    expect(socket.frames[0].record).toMatchObject({
      title: "Root",
      archived: false,
      archivedAt: null,
      origin: "own",
    });

    const archived = await handleEpicSetChatArchived(
      { epicId: "epic-1", chatId: "chat-1", archived: true },
      host.runtime,
    );
    expect(archived).toMatchObject({ result: { updated: true } });
    const latest = socket.frames.at(-1);
    expect(latest?.record).toMatchObject({ archived: true });
    // Archiving adds no turn, so the revision has to move on its own or the
    // client drops the delta as stale.
    expect(Number(latest?.revision)).toBeGreaterThan(
      Number(socket.frames[0].revision),
    );
  });

  it("removes a row the table no longer holds", async () => {
    const host = await boot();
    await seed(host);
    const socket = new FakeSocket();
    host.runtime.chatRecords.add(
      socket as never,
      new ChatRecordsSubscriber(socket as never, host.runtime),
    );
    await host.runtime.store.mutate((state) => {
      state.chats = [];
    });
    host.runtime.chatRecords.publish(host.runtime, "epic-1", "chat-1");
    expect(socket.frames.at(-1)).toEqual({
      kind: "remove",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      reason: "deleted",
    });
  });

  it("answers ping with pong and leaves other frames alone", async () => {
    const host = await boot();
    const socket = new FakeSocket();
    host.runtime.chatRecords.add(
      socket as never,
      new ChatRecordsSubscriber(socket as never, host.runtime),
    );
    expect(
      host.runtime.chatRecords.handleFrame(socket as never, {
        kind: "ping",
        hasBinaryPayload: false,
      }),
    ).toBe(true);
    expect(socket.frames.at(-1)).toEqual({
      kind: "pong",
      hasBinaryPayload: false,
    });
    expect(
      host.runtime.chatRecords.handleFrame(socket as never, { kind: "watch" }),
    ).toBe(false);
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

async function seed(host: StartedHost): Promise<void> {
  const chat: StoredChat = {
    epicId: "epic-1",
    chatId: "chat-1",
    parentId: null,
    hostId: host.runtime.hostId,
    title: "Root",
    createdAt: 1,
    runSettings: null,
    fastMode: false,
    providerSession: null,
    turns: [],
    events: [],
    transcriptEpoch: 0,
    indexRevision: 0,
    fileChangeCount: 0,
    lastUsage: null,
    archivedAt: null,
  };
  await host.runtime.store.mutate((state) => {
    state.chats.push(chat);
  });
}
