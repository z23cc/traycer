import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import type { WebSocket } from "ws";
import {
  MAX_ASSET_BYTES,
  type AssetMediaType,
  type AssetStreamErrorReason,
} from "@traycer/protocol/host/asset-stream-schemas";
import { sniffMediaType } from "../epic/attachments";
import { runGit } from "../git/git";

/**
 * `workspace.streamAsset` and `git.streamFileAsset` - one file's bytes as a
 * preview asset, streamed `assetHeader -> N x assetChunk -> assetComplete`.
 *
 * The two methods differ only in where the bytes come from, so the frame
 * sequence and every validation rule live here once. Validation is
 * ALL-OR-NOTHING by contract: an asset that fails any check answers
 * `assetError` in place of the header and never a partial body.
 */

/** 64 KiB: comfortably under the mux's frame cap, and few enough frames for 20 MiB. */
const CHUNK_BYTES = 64 * 1024;

/**
 * ponytail: a fixed raster ceiling rather than a memory-derived one. The
 * client decodes what we send, so the cap exists to stop a decompression bomb
 * from reaching it; 100 MP is far above any screenshot and far below a bomb.
 */
const MAX_PIXELS = 100_000_000;

/** PDF joins the media-type set at `@1.1`; a 1.0 peer must never see the literal. */
const PDF_MINOR = 1;

const GIT_ASSET_TIMEOUT_MS = 10_000;

export type AssetBytes = {
  readonly bytes: Uint8Array;
  /** Git OID for an object side, else `size:mtimeMs` for a worktree file. */
  readonly contentIdentity: string;
};

export class AssetStreamSession {
  constructor(
    private readonly socket: WebSocket,
    private readonly minor: number,
  ) {}

  /** Sends the whole sequence for `asset`, or one `assetError`. */
  serve(asset: AssetBytes): void {
    const mediaType = mediaTypeOf(asset.bytes, this.minor);
    if (mediaType === null) {
      this.fail(
        "not-image",
        "The file is not one of the supported preview formats.",
      );
      return;
    }
    if (asset.bytes.byteLength > MAX_ASSET_BYTES) {
      this.fail("too-large", "The file is larger than the preview limit.");
      return;
    }
    const size = intrinsicSize(asset.bytes, mediaType);
    if (size !== null && size.width * size.height > MAX_PIXELS) {
      this.fail("too-many-pixels", "The image has too many pixels to preview.");
      return;
    }
    this.send({
      kind: "assetHeader",
      hasBinaryPayload: false,
      sizeBytes: asset.bytes.byteLength,
      width: size?.width ?? null,
      height: size?.height ?? null,
      contentIdentity: asset.contentIdentity,
      mediaType,
    });
    // `byteLength` is positive by schema, so an empty file is header plus
    // complete with no chunk between them.
    let index = 0;
    for (
      let offset = 0;
      offset < asset.bytes.byteLength;
      offset += CHUNK_BYTES
    ) {
      const chunk = asset.bytes.subarray(offset, offset + CHUNK_BYTES);
      this.send({
        kind: "assetChunk",
        hasBinaryPayload: true,
        index,
        byteLength: chunk.byteLength,
      });
      this.sendBytes(chunk);
      index += 1;
    }
    this.send({ kind: "assetComplete", hasBinaryPayload: false });
  }

  fail(reason: AssetStreamErrorReason, error: string): void {
    this.send({ kind: "assetError", hasBinaryPayload: false, error, reason });
  }

  pong(): void {
    this.send({ kind: "pong", hasBinaryPayload: false });
  }

  private send(frame: unknown): void {
    if (this.socket.readyState !== this.socket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(frame));
  }

  private sendBytes(bytes: Uint8Array): void {
    if (this.socket.readyState !== this.socket.OPEN) {
      return;
    }
    this.socket.send(bytes);
  }
}

/**
 * A workspace file's bytes, refusing anything that is not a real file inside
 * the workspace. Containment is checked AFTER `realpath`, so a symlink
 * pointing out of the tree is not-found rather than a read.
 */
export async function readWorkspaceAsset(
  workspacePath: string,
  filePath: string,
): Promise<AssetBytes | AssetStreamErrorReason> {
  if (!isAbsolute(workspacePath)) {
    return "not-found";
  }
  try {
    const root = await realpath(workspacePath);
    const target = await realpath(resolve(root, filePath));
    const inside = relative(root, target);
    if (inside.startsWith("..") || isAbsolute(inside)) {
      return "not-found";
    }
    const stats = await stat(target);
    if (!stats.isFile()) {
      return "not-found";
    }
    // Refused on the stat rather than after buffering: the cap exists so the
    // host never holds an oversized file in memory at all.
    if (stats.size > MAX_ASSET_BYTES) {
      return "too-large";
    }
    return {
      bytes: await readFile(target),
      contentIdentity: `${String(stats.size)}:${String(stats.mtimeMs)}`,
    };
  } catch {
    return "not-found";
  }
}

/**
 * Host-authoritative, derived from magic bytes and never from the requested
 * extension. Below `@1.1` a PDF is simply not a supported type, which is what
 * `not-image` has always meant.
 */
function mediaTypeOf(bytes: Uint8Array, minor: number): AssetMediaType | null {
  if (starts(bytes, [0x25, 0x50, 0x44, 0x46])) {
    return minor >= PDF_MINOR ? "application/pdf" : null;
  }
  return sniffMediaType(bytes);
}

type Size = { readonly width: number; readonly height: number };

/**
 * Intrinsic raster dimensions read from the file's own header. A format with
 * no declared geometry - an SVG without width/height, a PDF - reports `null`,
 * which the contract already carries as a first-class answer, so a header this
 * cannot parse degrades to "unknown" rather than failing the stream.
 */
function intrinsicSize(
  bytes: Uint8Array,
  mediaType: AssetMediaType,
): Size | null {
  try {
    if (mediaType === "image/png") {
      return readPng(bytes);
    }
    if (mediaType === "image/gif") {
      return readGif(bytes);
    }
    if (mediaType === "image/jpeg") {
      return readJpeg(bytes);
    }
    if (mediaType === "image/webp") {
      return readWebp(bytes);
    }
    if (mediaType === "image/svg+xml") {
      return readSvg(bytes);
    }
    return null;
  } catch {
    return null;
  }
}

function readPng(bytes: Uint8Array): Size | null {
  // IHDR is the first chunk, so width and height sit at a fixed offset.
  if (bytes.byteLength < 24) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return positive(view.getUint32(16), view.getUint32(20));
}

function readGif(bytes: Uint8Array): Size | null {
  if (bytes.byteLength < 10) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return positive(view.getUint16(6, true), view.getUint16(8, true));
}

function readJpeg(bytes: Uint8Array): Size | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 2;
  while (at + 9 < bytes.byteLength) {
    if (view.getUint8(at) !== 0xff) {
      return null;
    }
    const marker = view.getUint8(at + 1);
    // Every SOFn carries the frame geometry except the four that are not
    // start-of-frame markers at all (DHT, JPG, DAC, and the RSTn block).
    const isFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isFrame) {
      return positive(view.getUint16(at + 7), view.getUint16(at + 5));
    }
    at += 2 + view.getUint16(at + 2);
  }
  return null;
}

function readWebp(bytes: Uint8Array): Size | null {
  if (bytes.byteLength < 30) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = Buffer.from(bytes.subarray(12, 16)).toString("ascii");
  if (format === "VP8 ") {
    return positive(
      view.getUint16(26, true) & 0x3fff,
      view.getUint16(28, true) & 0x3fff,
    );
  }
  if (format === "VP8L") {
    const packed = view.getUint32(21, true);
    return positive((packed & 0x3fff) + 1, ((packed >> 14) & 0x3fff) + 1);
  }
  if (format === "VP8X") {
    const width =
      1 +
      (view.getUint8(24) |
        (view.getUint8(25) << 8) |
        (view.getUint8(26) << 16));
    const height =
      1 +
      (view.getUint8(27) |
        (view.getUint8(28) << 8) |
        (view.getUint8(29) << 16));
    return positive(width, height);
  }
  return null;
}

function readSvg(bytes: Uint8Array): Size | null {
  const head = Buffer.from(bytes.subarray(0, 4096)).toString("utf8");
  const width = svgLength(head, "width");
  const height = svgLength(head, "height");
  if (width !== null && height !== null) {
    return positive(width, height);
  }
  const box = /viewBox\s*=\s*"[\s\d.+-]*?([\d.]+)[\s,]+([\d.]+)\s*"/.exec(head);
  return box === null
    ? null
    : positive(Math.round(Number(box[1])), Math.round(Number(box[2])));
}

function svgLength(head: string, attribute: string): number | null {
  const found = new RegExp(`${attribute}\\s*=\\s*"([\\d.]+)(px)?"`).exec(head);
  return found === null ? null : Math.round(Number(found[1]));
}

function positive(width: number, height: number): Size | null {
  return Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0
    ? { width, height }
    : null;
}

function starts(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

/**
 * One side of a git-tracked file. The revision follows the diff each stage
 * describes: an unstaged diff runs index -> worktree, a staged one runs
 * HEAD -> index, so `old` and `new` name different objects per stage and only
 * the unstaged `new` side is a file on disk at all.
 *
 * `previousPath` is the pre-rename path and therefore addresses the `old`
 * side only - reading the new name out of an old revision would miss.
 */
export async function readGitAsset(input: {
  readonly runningDir: string;
  readonly filePath: string;
  readonly previousPath: string | null;
  readonly side: "old" | "new";
  readonly stage: "staged" | "unstaged";
}): Promise<AssetBytes | AssetStreamErrorReason> {
  const root = runGit(["rev-parse", "--show-toplevel"], input.runningDir);
  if (root === null) {
    return "not-found";
  }
  if (input.side === "new" && input.stage === "unstaged") {
    return readWorkspaceAsset(root, input.filePath);
  }
  const path =
    input.side === "old" && input.previousPath !== null
      ? input.previousPath
      : input.filePath;
  const revision =
    input.side === "new" || input.stage === "unstaged" ? "" : "HEAD";
  const object = `${revision}:${path}`;
  const oid = runGit(["rev-parse", object], root);
  if (oid === null) {
    return "not-found";
  }
  const blob = spawnSync("git", ["cat-file", "blob", object], {
    cwd: root,
    // Raw bytes: an asset is binary and a string round trip would corrupt it.
    encoding: "buffer",
    timeout: GIT_ASSET_TIMEOUT_MS,
    maxBuffer: MAX_ASSET_BYTES,
  });
  if (blob.status !== 0 || blob.stdout === null) {
    // `maxBuffer` overruns land here too, which is the honest reading: the
    // object is larger than a previewable asset.
    return blob.error === undefined ? "read-failed" : "too-large";
  }
  return { bytes: blob.stdout, contentIdentity: oid };
}
