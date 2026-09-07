import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { diffLines } from "diff";
import type { FileEditReason } from "@traycer/protocol/persistence/epic/content-blocks";

/**
 * Content-addressed before/after captures of the files an agent's edit tools
 * touch, and the hook that takes them.
 *
 * ## Why a hook, and not a read at tool-call time
 *
 * The edit tool's call rides the provider's stdout, which this host reads
 * asynchronously - by the time the `tool_use` record is parsed the write may
 * already have landed, and a "before" read then is the after. A read timed
 * against a stream is a guess about a file.
 *
 * Claude's `PreToolUse` hook is not: the tool does not run until the hook
 * returns, and `PostToolUse` runs once it has. Recorded live around an `Edit`
 * that changed `one` to `two`, the pre hook read `one` and the post hook read
 * `two`. That is the edit bracketed by something that OWNS the before and the
 * after, which is the claim `diffSource: "snapshot"` makes.
 *
 * ## Layout
 *
 * `<dataDir>/snapshots/blobs/<sha256>` holds file bodies, and
 * `<dataDir>/snapshots/pending/<tool_use_id>.<pre|post>.json` holds what each
 * hook saw - keyed by the tool call's id, which is the same id on the
 * `tool_use` and `tool_result` records this host already pairs. The host reads
 * both sidecars when the result arrives and deletes them.
 */
const SNAPSHOTS_DIRNAME = "snapshots";
/** Above this a body is `too_large`: the read contract's bulk lane is 1 MiB. */
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const BINARY_PROBE_BYTES = 8 * 1024;
export const SNAPSHOT_HOOK_FLAG = "--snapshot-hook";

export type SnapshotCapture = {
  /** Null when this side of the file does not exist (a create's before). */
  readonly hash: string | null;
  /** `snapshot` when `hash` is trustworthy; otherwise why it is not. */
  readonly reason: FileEditReason;
};

export function snapshotDir(dataDir: string): string {
  return join(dataDir, SNAPSHOTS_DIRNAME);
}

function blobPath(dir: string, hash: string): string {
  return join(dir, "blobs", hash);
}

function sidecarPath(
  dir: string,
  toolUseId: string,
  side: "pre" | "post",
): string {
  return join(dir, "pending", `${encodeURIComponent(toolUseId)}.${side}.json`);
}

/**
 * Read one file into the blob store and say what was found.
 *
 * `maxBytes` is a parameter rather than a constant because the cap is the one
 * thing a test of this function has to be able to reach.
 */
export async function captureFile(
  dir: string,
  filePath: string,
  maxBytes: number,
): Promise<SnapshotCapture> {
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    // Absent is a fact about the file, not a failure to read it: it is the
    // before of a create and the after of a delete.
    return { hash: null, reason: "snapshot" };
  }
  if (size > maxBytes) {
    return { hash: null, reason: "too_large" };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch {
    return { hash: null, reason: "capture_failed" };
  }
  if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
    return { hash: null, reason: "binary" };
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  try {
    const target = blobPath(dir, hash);
    if (!existsSync(target)) {
      await mkdir(join(dir, "blobs"), { recursive: true });
      await writeFile(target, bytes);
    }
  } catch {
    return { hash: null, reason: "capture_failed" };
  }
  return { hash, reason: "snapshot" };
}

/** Whether the store still holds this body - cleared blobs make a row non-undoable. */
export function hasBlob(dir: string, hash: string): boolean {
  return existsSync(blobPath(dir, hash));
}

/** Store one text body content-addressed, the way a captured file is; returns its hash. */
export async function writeBlob(dir: string, text: string): Promise<string> {
  const bytes = Buffer.from(text, "utf8");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const target = blobPath(dir, hash);
  if (!existsSync(target)) {
    await mkdir(join(dir, "blobs"), { recursive: true });
    await writeFile(target, bytes);
  }
  return hash;
}

export async function readBlob(
  dir: string,
  hash: string,
): Promise<string | null> {
  try {
    return await readFile(blobPath(dir, hash), "utf8");
  } catch {
    return null;
  }
}

/** Both sides of one edit, consumed: the sidecars are deleted on the way out. */
export async function settleEdit(
  dir: string,
  toolUseId: string,
): Promise<{
  readonly before: SnapshotCapture | null;
  readonly after: SnapshotCapture | null;
}> {
  const [before, after] = await Promise.all([
    readSidecar(dir, toolUseId, "pre"),
    readSidecar(dir, toolUseId, "post"),
  ]);
  return { before, after };
}

async function readSidecar(
  dir: string,
  toolUseId: string,
  side: "pre" | "post",
): Promise<SnapshotCapture | null> {
  const path = sidecarPath(dir, toolUseId, side);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  await rm(path, { force: true });
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") {
      return null;
    }
    const hash = Reflect.get(parsed, "hash");
    const reason = Reflect.get(parsed, "reason");
    if (typeof reason !== "string") {
      return null;
    }
    return {
      hash: typeof hash === "string" ? hash : null,
      reason: readReason(reason),
    };
  } catch {
    return null;
  }
}

function readReason(word: string): FileEditReason {
  switch (word) {
    case "snapshot":
    case "binary":
    case "too_large":
    case "blob_missing":
    case "capture_failed":
    case "not_intercepted":
    case "denied":
      return word;
    default:
      return "capture_failed";
  }
}

/**
 * The version an accumulated-change row is at, for the read contract's
 * digest: both hashes, each cut to 128 bits so the pair fits the contract's
 * cap. Opaque to the client, which echoes it back - so a request for any other
 * pair is a request for a version this host no longer describes.
 */
export function changeDigest(
  beforeHash: string | null,
  afterHash: string | null,
): string {
  const short = (hash: string | null): string =>
    hash === null ? "-" : hash.slice(0, 32);
  return `${short(beforeHash)}:${short(afterHash)}`;
}

/** `+N / -M` between two bodies, by the same line diff the GUI renders with. */
export function lineCounts(
  before: string | null,
  after: string | null,
): { readonly additions: number; readonly deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const change of diffLines(before ?? "", after ?? "")) {
    if (change.added) {
      additions += change.count ?? 0;
    } else if (change.removed) {
      deletions += change.count ?? 0;
    }
  }
  return { additions, deletions };
}

export async function storageBytes(dir: string): Promise<number> {
  let names: readonly string[];
  try {
    names = await readdir(join(dir, "blobs"));
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of names) {
    try {
      total += (await stat(blobPath(dir, name))).size;
    } catch {
      // A blob removed between the listing and the stat weighs nothing.
    }
  }
  return total;
}

export async function clearBlobs(dir: string): Promise<number> {
  const bytes = await storageBytes(dir);
  await rm(join(dir, "blobs"), { recursive: true, force: true });
  return bytes;
}

/**
 * The `--settings` JSON that makes Claude run this host's own binary around
 * every edit tool call.
 *
 * The hook re-enters the host: `process.execPath` is the runtime, and
 * `process.argv[1]` is the script when there is one on disk (`bun run
 * src/index.ts`) and nothing when the host is a compiled binary whose entry
 * lives inside it. Everything else the hook needs arrives on stdin.
 */
export function snapshotHookSettings(dataDir: string): string {
  const script = process.argv[1];
  const vector = [
    process.execPath,
    ...(script !== undefined && existsSync(script) ? [script] : []),
    SNAPSHOT_HOOK_FLAG,
    snapshotDir(dataDir),
  ];
  const command = vector
    .map((part) => `"${part.replaceAll('"', '\\"')}"`)
    .join(" ");
  const hook = {
    matcher: "Edit|Write|MultiEdit|NotebookEdit",
    hooks: [{ type: "command", command }],
  };
  // The same re-entry after a compaction: the CLI hands the hook the summary
  // it wrote (`compact_summary`, recorded live), which is the one place that
  // text exists outside the transcript.
  const compact = { hooks: [{ type: "command", command }] };
  return JSON.stringify({
    hooks: { PreToolUse: [hook], PostToolUse: [hook], PostCompact: [compact] },
  });
}

function compactSidecarPath(dir: string, sessionId: string): string {
  return join(dir, "pending", `compact.${encodeURIComponent(sessionId)}.json`);
}

/**
 * The summary the PostCompact hook left for this session, consumed: the
 * sidecar is deleted on the way out. Null when there is none, or it is empty.
 */
export async function takeCompactSummary(
  dir: string,
  sessionId: string,
): Promise<string | null> {
  const path = compactSidecarPath(dir, sessionId);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  await rm(path, { force: true });
  try {
    const parsed: unknown = JSON.parse(raw);
    const summary =
      parsed !== null && typeof parsed === "object"
        ? Reflect.get(parsed, "summary")
        : null;
    return typeof summary === "string" && summary.length > 0 ? summary : null;
  } catch {
    return null;
  }
}

/**
 * The hook's whole job, given what Claude wrote to its stdin. Never throws
 * and never prints: a hook that fails must not fail the edit, and a hook that
 * prints is read as a verdict on it.
 */
export async function runSnapshotHook(
  stdin: string,
  dir: string,
): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(stdin);
  } catch {
    return;
  }
  if (payload === null || typeof payload !== "object") {
    return;
  }
  const event = Reflect.get(payload, "hook_event_name");
  if (event === "PostCompact") {
    const sessionId = Reflect.get(payload, "session_id");
    const summary = Reflect.get(payload, "compact_summary");
    if (typeof sessionId !== "string" || typeof summary !== "string") {
      return;
    }
    try {
      await mkdir(join(dir, "pending"), { recursive: true });
      await writeFile(
        compactSidecarPath(dir, sessionId),
        JSON.stringify({ summary }),
      );
    } catch {
      // The card then shows the numbers without the words.
    }
    return;
  }
  const toolUseId = Reflect.get(payload, "tool_use_id");
  const input = Reflect.get(payload, "tool_input");
  const side =
    event === "PreToolUse" ? "pre" : event === "PostToolUse" ? "post" : null;
  if (side === null || typeof toolUseId !== "string" || input === null) {
    return;
  }
  if (typeof input !== "object") {
    return;
  }
  const filePath =
    Reflect.get(input, "file_path") ?? Reflect.get(input, "notebook_path");
  if (typeof filePath !== "string" || filePath.length === 0) {
    return;
  }
  const capture = await captureFile(dir, filePath, MAX_SNAPSHOT_BYTES);
  try {
    await mkdir(join(dir, "pending"), { recursive: true });
    await writeFile(sidecarPath(dir, toolUseId, side), JSON.stringify(capture));
  } catch {
    // Nothing to do: the host reads a missing sidecar as `capture_failed`.
  }
}
