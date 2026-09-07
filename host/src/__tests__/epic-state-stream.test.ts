import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { epicStateSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/state-subscribe";
import { EpicStateHub, EpicStateSubscriber } from "../stream/epic-state";
import { startHost, type StartedHost } from "../start-host";

type Frame = { readonly kind: string; readonly [key: string]: unknown };

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  readonly frames: Frame[] = [];

  send(payload: string): void {
    // Every frame has to satisfy the lane's own union, which refuses a binary
    // payload, an unknown basis, and a negative revision on any row.
    this.frames.push(
      epicStateSubscribeServerFrameSchemaV10.parse(
        JSON.parse(payload),
      ) as Frame,
    );
  }
}

describe("epic.state.subscribe", () => {
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

  it("leads with a cold snapshot carrying the epic's own rows", async () => {
    const host = await boot();
    await host.runtime.store.mutate((state) => {
      state.epics.push({
        id: "epic-1",
        title: "Records",
        initialUserPrompt: "",
        status: "active",
        createdAt: 1,
        updatedAt: 7,
        createdBy: "local",
        version: "1",
        ticketCount: 1,
        specCount: 1,
        storyCount: 0,
        reviewCount: 0,
        repos: [],
        workspaces: [],
        pinned: false,
        lastViewedAt: null,
      });
      state.artifacts.push(
        {
          epicId: "epic-1",
          artifactId: "a-spec",
          kind: "spec",
          title: "Spec",
          parentId: null,
          folderName: "spec",
          artifactRoomId: "",
          createdAt: 1,
          updatedAt: 3,
          status: null,
          assignee: null,
        },
        {
          epicId: "epic-1",
          artifactId: "a-ticket",
          kind: "ticket",
          title: "Ticket",
          parentId: "a-spec",
          folderName: "ticket",
          artifactRoomId: "",
          createdAt: 2,
          updatedAt: 5,
          status: 2,
          assignee: null,
        },
        {
          epicId: "epic-other",
          artifactId: "a-elsewhere",
          kind: "spec",
          title: "Elsewhere",
          parentId: null,
          folderName: "elsewhere",
          artifactRoomId: "",
          createdAt: 1,
          updatedAt: 1,
          status: null,
          assignee: null,
        },
      );
      state.commentThreads.push({
        epicId: "epic-1",
        artifactType: "spec",
        artifactId: "a-spec",
        threadId: "t-1",
        createdAt: 4,
        createdByUserId: "local",
        quotedText: "quote",
        resolved: false,
        comments: [
          {
            commentId: "c-1",
            content: {
              type: "doc",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "hi" }] },
              ],
            },
            createdAt: 4,
            updatedAt: 9,
            authorUserId: "local",
            authorHandle: null,
          },
        ],
      });
    });

    const socket = new FakeSocket();
    new EpicStateSubscriber(socket as never, host.runtime, "epic-1").seed(0);
    const snapshot = socket.frames[0];
    expect(snapshot).toMatchObject({
      kind: "snapshot",
      basis: "cold",
      position: 0,
      reconciledWithCloud: false,
      hasBinaryPayload: false,
      // Carries the process start, so an in-memory position cannot be
      // resumed against a restarted lane.
      authorityEpoch: host.runtime.authorityEpoch,
      // No tombstone store, so an empty list is the whole truth.
      deletedArtifacts: [],
      epicMeta: { revision: 7, meta: { title: "Records", updatedAt: 7 } },
    });
    // Only this epic's rows, and the wire's non-nullable ticket fields filled
    // from the store's nullable columns.
    expect(snapshot.artifactRecords).toEqual([
      {
        kind: "spec",
        id: "a-spec",
        folderName: "spec",
        title: "Spec",
        createdAt: 1,
        updatedAt: 3,
        createdManually: true,
        parentId: null,
        revision: 3,
      },
      {
        kind: "ticket",
        id: "a-ticket",
        folderName: "ticket",
        title: "Ticket",
        createdAt: 2,
        updatedAt: 5,
        createdManually: true,
        parentId: "a-spec",
        revision: 5,
        status: 2,
        assignee: "",
      },
    ]);
    // A thread is dated by its latest comment, not by its own creation.
    expect(snapshot.commentThreads).toMatchObject([
      { threadId: "t-1", artifactId: "a-spec", revision: 9 },
    ]);
  });

  it("answers an unknown epic with an empty snapshot rather than an error", async () => {
    const host = await boot();
    const socket = new FakeSocket();
    new EpicStateSubscriber(socket as never, host.runtime, "nope").seed(0);
    expect(socket.frames[0]).toMatchObject({
      kind: "snapshot",
      artifactRecords: [],
      commentThreads: [],
      roleClaims: { revision: 0, claims: [] },
      epicMeta: { revision: 0, meta: { title: "", updatedAt: 0 } },
    });
  });

  it("commits only what changed, and stays silent for everything else", async () => {
    const host = await boot();
    const socket = new FakeSocket();
    host.runtime.epicState.add(
      socket as never,
      new EpicStateSubscriber(socket as never, host.runtime, "epic-1"),
    );
    expect(socket.frames).toHaveLength(1);

    // A chat turn mutates the store constantly and touches none of this lane's
    // rows, so it must not consume a position.
    await host.runtime.store.mutate((state) => {
      state.chats.push({
        epicId: "epic-1",
        chatId: "c-1",
        parentId: null,
        hostId: host.runtime.hostId,
        title: "",
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
        lastAuthFailureTurnId: null,
        pinnedTodo: null,
      });
    });
    expect(socket.frames).toHaveLength(1);

    await host.runtime.store.mutate((state) => {
      state.artifacts.push({
        epicId: "epic-1",
        artifactId: "a-1",
        kind: "spec",
        title: "Fresh",
        parentId: null,
        folderName: "fresh",
        artifactRoomId: "",
        createdAt: 1,
        updatedAt: 2,
        status: null,
        assignee: null,
      });
    });
    const created = socket.frames.at(-1);
    expect(created).toMatchObject({ kind: "delta", seq: 1 });
    expect(created?.artifactUpserts).toMatchObject([
      { id: "a-1", title: "Fresh" },
    ]);
    expect(created?.artifactTombstones).toEqual([]);

    await host.runtime.store.mutate((state) => {
      const row = state.artifacts.find((entry) => entry.artifactId === "a-1");
      if (row !== undefined) {
        row.title = "Renamed";
        row.updatedAt = 5;
      }
    });
    const renamed = socket.frames.at(-1);
    // A position is consumed only by a real commit, so seq advances by one.
    expect(renamed).toMatchObject({ kind: "delta", seq: 2 });
    expect(renamed?.artifactUpserts).toMatchObject([
      { id: "a-1", title: "Renamed", revision: 5 },
    ]);

    await host.runtime.store.mutate((state) => {
      state.artifacts = [];
    });
    const removed = socket.frames.at(-1);
    expect(removed).toMatchObject({ kind: "delta", seq: 3 });
    expect(removed?.artifactUpserts).toEqual([]);
    // The row is gone from state, so the tombstone comes from what we last sent.
    expect(removed?.artifactTombstones).toMatchObject([
      { id: "a-1", title: "Renamed", revision: 5, kind: "spec" },
    ]);
  });

  it("seats a later subscriber above the positions already spent", async () => {
    const host = await boot();
    const first = new FakeSocket();
    host.runtime.epicState.add(
      first as never,
      new EpicStateSubscriber(first as never, host.runtime, "epic-1"),
    );
    await host.runtime.store.mutate((state) => {
      state.epics.push({
        id: "epic-1",
        title: "Named",
        initialUserPrompt: "",
        status: "active",
        createdAt: 1,
        updatedAt: 3,
        createdBy: "local",
        version: "1",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        repos: [],
        workspaces: [],
        pinned: false,
        lastViewedAt: null,
      });
    });
    expect(first.frames.at(-1)).toMatchObject({ kind: "delta", seq: 1 });

    const second = new FakeSocket();
    host.runtime.epicState.add(
      second as never,
      new EpicStateSubscriber(second as never, host.runtime, "epic-1"),
    );
    // Its high-water mark is the lane's, not zero - a delta at 1 is already in
    // this snapshot and a client must be able to drop it.
    expect(second.frames[0]).toMatchObject({ kind: "snapshot", position: 1 });
  });

  it("answers ping with pong", async () => {
    const host = await boot();
    const socket = new FakeSocket();
    const lane = new EpicStateSubscriber(socket as never, host.runtime, "e");
    lane.pong();
    expect(socket.frames.at(-1)).toEqual({
      kind: "pong",
      hasBinaryPayload: false,
    });
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
