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
    // The client names the directory the way the listing spelled it.
    await session.handleFrame({
      kind: "watch",
      directoryPaths: ["src/"],
      hasBinaryPayload: false,
    });
    const listing = socket.frames.at(-1);
    expect(listing).toMatchObject({ kind: "listing", directoryPath: "src" });
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
      directoryPaths: ["nope"],
      hasBinaryPayload: false,
    });
    expect(socket.frames.at(-1)).toMatchObject({
      kind: "pruned",
      directoryPaths: ["nope"],
      reason: "error",
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

  async function seed(): Promise<string> {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-ws-"));
    await mkdir(join(tempDir, "src"), { recursive: true });
    await writeFile(join(tempDir, "README.md"), "hi\n");
    await writeFile(join(tempDir, "src", "main.ts"), "export {};\n");
    return tempDir;
  }
});
