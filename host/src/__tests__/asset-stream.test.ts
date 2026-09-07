import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assetStreamServerFrameSchema,
  assetStreamServerFrameSchemaV11,
} from "@traycer/protocol/host/asset-stream-schemas";
import {
  AssetStreamSession,
  readWorkspaceAsset,
} from "../workspace/asset-stream";

type Frame = { readonly kind: string; readonly [key: string]: unknown };

/** Parses through the minor's OWN union, which is what catches a leaked literal. */
class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  readonly frames: Frame[] = [];
  readonly binaries: Uint8Array[] = [];

  constructor(private readonly minor: number) {}

  send(payload: string | Uint8Array): void {
    if (typeof payload !== "string") {
      this.binaries.push(payload);
      return;
    }
    const schema =
      this.minor >= 1
        ? assetStreamServerFrameSchemaV11
        : assetStreamServerFrameSchema;
    this.frames.push(schema.parse(JSON.parse(payload)) as Frame);
  }
}

// A 4x4 red PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR4nGP8z8Dwn4GBgYERRIAAAwAY9wME0DHRAQAAAABJRU5ErkJggg==",
  "base64",
);
const PDF = Buffer.from("%PDF-1.4\n%any bytes\n");

describe("asset streams", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir !== null) {
      await rm(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it("streams a header with the file's own dimensions, then its bytes", async () => {
    const root = await workspace();
    await writeFile(join(root, "shot.png"), PNG);
    const socket = new FakeSocket(1);
    const asset = await readWorkspaceAsset(root, "shot.png");
    expect(typeof asset).not.toBe("string");
    if (typeof asset === "string") return;
    new AssetStreamSession(socket as never, 1).serve(asset);
    expect(socket.frames.map((f) => f.kind)).toEqual([
      "assetHeader",
      "assetChunk",
      "assetComplete",
    ]);
    expect(socket.frames[0]).toMatchObject({
      mediaType: "image/png",
      width: 4,
      height: 4,
      sizeBytes: PNG.byteLength,
    });
    // A worktree file is identified by its own size and mtime, not a git oid.
    expect(String(socket.frames[0].contentIdentity)).toMatch(/^\d+:[\d.]+$/);
    expect(socket.binaries).toHaveLength(1);
  });

  it("refuses a path that leaves the workspace through a symlink", async () => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "traycer-outside-"));
    await writeFile(join(outside, "secret.png"), PNG);
    await symlink(join(outside, "secret.png"), join(root, "link.png"));
    // Containment is checked after realpath, so the link is not-found rather
    // than a read of a file outside the tree.
    expect(await readWorkspaceAsset(root, "link.png")).toBe("not-found");
    expect(await readWorkspaceAsset(root, "../escape.png")).toBe("not-found");
    expect(await readWorkspaceAsset(root, "missing.png")).toBe("not-found");
    await rm(outside, { recursive: true, force: true });
  });

  it("judges the type by magic bytes, never by the extension", async () => {
    const root = await workspace();
    await writeFile(join(root, "liar.png"), "not an image at all");
    const asset = await readWorkspaceAsset(root, "liar.png");
    if (typeof asset === "string") throw new Error(asset);
    const socket = new FakeSocket(1);
    new AssetStreamSession(socket as never, 1).serve(asset);
    expect(socket.frames).toEqual([
      {
        kind: "assetError",
        hasBinaryPayload: false,
        error: expect.any(String),
        reason: "not-image",
      },
    ]);
    expect(socket.binaries).toHaveLength(0);
  });

  it("keeps the PDF literal away from a peer whose parser predates it", async () => {
    const root = await workspace();
    await writeFile(join(root, "doc.pdf"), PDF);
    const asset = await readWorkspaceAsset(root, "doc.pdf");
    if (typeof asset === "string") throw new Error(asset);

    const old = new FakeSocket(0);
    new AssetStreamSession(old as never, 0).serve(asset);
    expect(old.frames[0]).toMatchObject({
      kind: "assetError",
      reason: "not-image",
    });

    const current = new FakeSocket(1);
    new AssetStreamSession(current as never, 1).serve(asset);
    // Pages have geometry, but the host parses no documents.
    expect(current.frames[0]).toMatchObject({
      kind: "assetHeader",
      mediaType: "application/pdf",
      width: null,
      height: null,
    });
  });

  async function workspace(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "traycer-asset-"));
    return dir;
  }
});
