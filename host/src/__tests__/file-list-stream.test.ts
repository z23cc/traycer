import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceSubscribeFileListServerFrameSchema } from "@traycer/protocol/host/workspace/subscribe";
import { WorkspaceFileListSession } from "../workspace/file-list-stream";

type Frame = { readonly kind: string; readonly [key: string]: unknown };

/** A socket that records what the session sent, in order. */
class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  readonly frames: Frame[] = [];

  send(payload: string): void {
    const parsed: unknown = JSON.parse(payload);
    // Every frame the session emits has to be one the contract names.
    this.frames.push(
      workspaceSubscribeFileListServerFrameSchema.parse(parsed) as Frame,
    );
  }
}

describe("workspace.subscribeFileList", () => {
  let tempDir: string | null = null;
  let session: WorkspaceFileListSession | null = null;

  afterEach(async () => {
    session?.close();
    session = null;
    if (tempDir !== null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("lists the root's first level on open, with directories trailing-slashed", async () => {
    const root = await seed();
    const socket = new FakeSocket();
    session = new WorkspaceFileListSession(socket as never);
    await session.open(root);

    expect(socket.frames).toHaveLength(1);
    const listing = socket.frames[0];
    expect(listing.kind).toBe("listing");
    expect(listing.directoryPath).toBe("");
    expect(listing.truncated).toBe(false);
    const entries = listing.entries as {
      path: string;
      name: string;
      kind: string;
      ignored: boolean;
    }[];
    expect(entries.map((entry) => entry.path).toSorted()).toEqual([
      "README.md",
      "src/",
    ]);
    expect(entries.find((entry) => entry.name === "src")).toMatchObject({
      kind: "directory",
      ignored: false,
    });
  });

  it("covers a watched child and answers ping with pong", async () => {
    const root = await seed();
    const socket = new FakeSocket();
    session = new WorkspaceFileListSession(socket as never);
    await session.open(root);
    // The client hands back exactly the token the listing gave it, and the
    // answer is keyed by that same token - not a stripped variant it would
    // have to parse to match.
    await session.handleFrame({
      kind: "watch",
      directoryPaths: ["src/"],
      hasBinaryPayload: false,
    });
    const listing = socket.frames.at(-1);
    expect(listing).toMatchObject({ kind: "listing", directoryPath: "src/" });
    expect((listing?.entries as { name: string }[]).map((e) => e.name)).toEqual(
      ["main.ts"],
    );

    await session.handleFrame({ kind: "ping", hasBinaryPayload: false });
    expect(socket.frames.at(-1)).toEqual({
      kind: "pong",
      hasBinaryPayload: false,
    });
  });

  it("prunes a directory that is not there", async () => {
    const root = await seed();
    const socket = new FakeSocket();
    session = new WorkspaceFileListSession(socket as never);
    await session.open(root);
    await session.handleFrame({
      kind: "watch",
      directoryPaths: ["nope/"],
      hasBinaryPayload: false,
    });
    expect(socket.frames.at(-1)).toMatchObject({
      kind: "pruned",
      directoryPaths: ["nope/"],
      reason: "missing",
    });
  });

  it("refuses a watch whose parent is not covered", async () => {
    const root = await seed();
    await mkdir(join(root, "src", "deep"), { recursive: true });
    const socket = new FakeSocket();
    session = new WorkspaceFileListSession(socket as never);
    await session.open(root);
    // `src/` was never covered, so its child may not be either.
    await session.handleFrame({
      kind: "watch",
      directoryPaths: ["src/deep/"],
      hasBinaryPayload: false,
    });
    expect(socket.frames.at(-1)).toMatchObject({
      kind: "pruned",
      directoryPaths: ["src/deep/"],
      reason: "error",
    });
    // Naming the parent and the child in ONE frame is legal: ancestors first.
    await session.handleFrame({
      kind: "watch",
      directoryPaths: ["src/deep/", "src/"],
      hasBinaryPayload: false,
    });
    expect(socket.frames.slice(-2).map((frame) => frame.directoryPath)).toEqual(
      ["src/", "src/deep/"],
    );
  });

  it("prunes a covered child its parent no longer lists", async () => {
    const root = await seed();
    const socket = new FakeSocket();
    session = new WorkspaceFileListSession(socket as never);
    await session.open(root);
    await session.handleFrame({
      kind: "watch",
      directoryPaths: ["src/"],
      hasBinaryPayload: false,
    });
    await rm(join(root, "src"), { recursive: true, force: true });
    // The root's own watcher is what discovers it, and the child goes with it.
    const pruned = await waitFor(() =>
      socket.frames.find((frame) => frame.kind === "pruned"),
    );
    expect(pruned).toMatchObject({
      directoryPaths: ["src/"],
      reason: "missing",
    });
  });

  it("prunes an unopenable workspace instead of listing nothing", async () => {
    const socket = new FakeSocket();
    session = new WorkspaceFileListSession(socket as never);
    await session.open(join(tmpdir(), "traycer-not-a-workspace-xyz"));
    expect(socket.frames.at(-1)).toMatchObject({
      kind: "pruned",
      reason: "missing",
    });
  });

  async function waitFor<T>(read: () => T | undefined): Promise<T> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const found = read();
      if (found !== undefined) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("timed out waiting for a frame");
  }

  async function seed(): Promise<string> {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-ws-"));
    await mkdir(join(tempDir, "src"), { recursive: true });
    await writeFile(join(tempDir, "README.md"), "hi\n");
    await writeFile(join(tempDir, "src", "main.ts"), "export {};\n");
    return tempDir;
  }
});
