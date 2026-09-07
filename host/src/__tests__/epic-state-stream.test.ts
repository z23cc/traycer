import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { epicStateSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/state-subscribe";
import { EpicStateSubscriber } from "../stream/epic-state";
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
    new EpicStateSubscriber(socket as never, host.runtime, "epic-1").seed();
    const snapshot = socket.frames[0];
    expect(snapshot).toMatchObject({
      kind: "snapshot",
      basis: "cold",
      position: 0,
      reconciledWithCloud: false,
      hasBinaryPayload: false,
      authorityEpoch: `oss:${host.runtime.hostId}`,
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
    new EpicStateSubscriber(socket as never, host.runtime, "nope").seed();
    expect(socket.frames[0]).toMatchObject({
      kind: "snapshot",
      artifactRecords: [],
      commentThreads: [],
      roleClaims: { revision: 0, claims: [] },
      epicMeta: { revision: 0, meta: { title: "", updatedAt: 0 } },
    });
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
