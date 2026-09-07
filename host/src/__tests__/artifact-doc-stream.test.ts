import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { afterEach, describe, expect, it } from "vitest";
import { artifactSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/epic/artifact-subscribe";
import { ArtifactDocLane } from "../stream/artifact-doc";
import { startHost, type StartedHost } from "../start-host";

type Frame = { readonly kind: string; readonly [key: string]: unknown };

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  readonly frames: Frame[] = [];
  readonly binaries: Uint8Array[] = [];

  send(payload: string | Uint8Array): void {
    if (typeof payload !== "string") {
      this.binaries.push(payload);
      return;
    }
    this.frames.push(
      artifactSubscribeServerFrameSchemaV10.parse(JSON.parse(payload)) as Frame,
    );
  }
}

describe("artifact.subscribe", () => {
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

  it("refuses an attach made under a replica this host is not serving", async () => {
    const host = await boot();
    await seed(host);
    const socket = new FakeSocket();
    const lane = new ArtifactDocLane(
      socket as never,
      host.runtime,
      "epic-1",
      "a-1",
    );
    expect(
      await lane.open({
        epicId: "epic-1",
        artifactId: "a-1",
        authorityEpoch: "oss:someone-else:1",
      }),
    ).toBe(true);
    expect(socket.frames[0]).toMatchObject({
      kind: "unavailable",
      code: "staleAuthorityEpoch",
      terminal: true,
    });
    expect(socket.binaries).toHaveLength(0);
  });

  it("refuses a body that is not an artifact of this epic", async () => {
    const host = await boot();
    await seed(host);
    const socket = new FakeSocket();
    await new ArtifactDocLane(
      socket as never,
      host.runtime,
      "epic-1",
      "nope",
    ).open({
      epicId: "epic-1",
      artifactId: "nope",
      authorityEpoch: host.runtime.authorityEpoch,
    });
    expect(socket.frames[0]).toMatchObject({
      kind: "unavailable",
      code: "artifactNotFound",
      terminal: true,
    });
  });

  it("seeds the body, then takes an edit and acknowledges its coverage", async () => {
    const host = await boot();
    await seed(host);
    const socket = new FakeSocket();
    const lane = new ArtifactDocLane(
      socket as never,
      host.runtime,
      "epic-1",
      "a-1",
    );
    await lane.open({
      epicId: "epic-1",
      artifactId: "a-1",
      authorityEpoch: host.runtime.authorityEpoch,
    });
    const doc = socket.frames[0];
    expect(doc).toMatchObject({ kind: "doc", hasBinaryPayload: true });
    // Absence of `seededFromOffer` is what says "full seed"; a client must be
    // free to install these bytes wholesale.
    expect(doc.seededFromOffer).toBeUndefined();
    expect(socket.binaries).toHaveLength(1);
    const guid = String(doc.docGuid);

    // A guid this lane is not serving names a document the host does not have.
    lane.applyUpdate("some-other-guid", update("ignored"));
    expect(socket.frames).toHaveLength(1);

    lane.applyUpdate(guid, update("hello"));
    expect(socket.frames.at(-1)).toMatchObject({
      kind: "docAck",
      docGuid: guid,
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

function update(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("probe").insert(0, text);
  const bytes = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return bytes;
}

async function seed(host: StartedHost): Promise<void> {
  await host.runtime.store.mutate((state) => {
    state.epics.push({
      id: "epic-1",
      title: "Doc lane",
      initialUserPrompt: "",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
      createdBy: "local",
      version: "1",
      ticketCount: 0,
      specCount: 1,
      storyCount: 0,
      reviewCount: 0,
      repos: [],
      workspaces: [],
      pinned: false,
      lastViewedAt: null,
    });
    state.artifacts.push({
      epicId: "epic-1",
      artifactId: "a-1",
      kind: "spec",
      title: "Body",
      parentId: null,
      folderName: "body",
      artifactRoomId: "",
      createdAt: 1,
      updatedAt: 1,
      status: null,
      assignee: null,
    });
  });
}
