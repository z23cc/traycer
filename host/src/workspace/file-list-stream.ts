import { execFileSync } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { WebSocket } from "ws";
import type { WorkspaceFileListEntry } from "@traycer/protocol/host/workspace/subscribe";
import { listDirectory, validateWorkspacePath } from "./workspace";

/**
 * One `workspace.subscribeFileList` session: SINGLE-LEVEL listings of the
 * directories a client has asked to cover, re-sent whenever one changes.
 *
 * ## The coordinate is the token the client already holds
 *
 * A directory is identified by the trailing-slash form (`"src/"`, `""` for the
 * root) - EXACTLY the string it arrived as in its parent's entry `path`. That
 * is what lets an expansion toggle hand the token straight back in a `watch`
 * without parsing it, and it is deliberately NOT the unary
 * `workspace.listDirectory` form, which strips the slash. Echoing the stripped
 * form here would hand a client a `directoryPath` it cannot match against the
 * row it expanded.
 *
 * ## Parent coverage is the invariant
 *
 * The root is covered for the life of the stream, and a `watch` for a
 * directory whose parent is not covered is refused. That is what makes parent
 * coverage the source of truth for child existence: a refresh that no longer
 * lists a covered child prunes that child AND its covered descendants, so a
 * client never holds a listing for something its parent says is gone.
 *
 * A `listing` REPLACES its directory wholesale, so a change re-reads exactly
 * one directory and the watchers stay per-path rather than recursive.
 */
const COVERAGE_LIMIT = 256;
const ENTRY_LIMIT = 2_000;
/** fs events arrive in bursts (one editor save is several); coalesce them. */
const SETTLE_MS = 120;
const ROOT = "";

export class WorkspaceFileListSession {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly covered = new Set<string>();
  private root = "";
  private closed = false;
  /**
   * Client frames are answered IN ORDER. Two `watch` frames racing would let
   * a child be covered before its parent, which is exactly the orphan the
   * parent-coverage rule exists to prevent.
   */
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly socket: WebSocket) {}

  /** Covers the root's first level; no client frame is needed to start. */
  async open(workspacePath: string): Promise<void> {
    const validation = await validateWorkspacePath(workspacePath);
    if (!validation.ok) {
      this.prune([ROOT], "missing");
      return;
    }
    this.root = validation.resolvedPath;
    this.covered.add(ROOT);
    await this.emit(ROOT);
  }

  handleFrame(frame: unknown): Promise<boolean> {
    const queued = this.tail.then(() => this.apply(frame));
    this.tail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private async apply(frame: unknown): Promise<boolean> {
    if (frame === null || typeof frame !== "object") {
      return false;
    }
    const kind = Reflect.get(frame, "kind");
    if (kind === "ping") {
      this.send({ kind: "pong", hasBinaryPayload: false });
      return true;
    }
    if (kind === "watch") {
      await this.watchPaths(readPaths(frame));
      return true;
    }
    if (kind === "unwatch") {
      for (const path of readPaths(frame)) {
        this.dropSubtree(path);
      }
      return true;
    }
    return false;
  }

  close(): void {
    this.closed = true;
    for (const path of [...this.watchers.keys()]) {
      this.stopWatching(path);
    }
    this.covered.clear();
  }

  /**
   * Ancestors-first within the frame, so one frame may legally name a parent
   * and its children together - and a path whose parent was refused is refused
   * with it rather than being covered as an orphan.
   */
  private async watchPaths(paths: readonly string[]): Promise<void> {
    const refusedError: string[] = [];
    const refusedLimit: string[] = [];
    for (const path of [...paths].toSorted((a, b) => a.length - b.length)) {
      if (path === ROOT || this.covered.has(path)) {
        // Idempotent: a `listing` answers a NEWLY covered path only.
        continue;
      }
      if (!this.covered.has(parentOf(path))) {
        refusedError.push(path);
        continue;
      }
      if (this.covered.size >= COVERAGE_LIMIT) {
        refusedLimit.push(path);
        continue;
      }
      this.covered.add(path);
      await this.emit(path);
    }
    if (refusedError.length > 0) {
      this.prune(refusedError, "error");
    }
    if (refusedLimit.length > 0) {
      this.prune(refusedLimit, "limit");
    }
  }

  private async emit(path: string): Promise<void> {
    if (this.closed || !this.covered.has(path)) {
      return;
    }
    const listed = await listDirectory(this.root, unaryForm(path));
    if (!listed.ok) {
      // Never streamed as an error: the stream survives an unreadable path.
      // The two refusals are different sentences to the reader, so a directory
      // that is GONE says so rather than reading as an unreadable one - the
      // common case here, since a deleted directory's own watcher fires before
      // its parent's refresh notices.
      this.prune(
        this.dropSubtree(path),
        (await exists(join(this.root, unaryForm(path)))) ? "error" : "missing",
      );
      return;
    }
    const rows = listed.entries.slice(0, ENTRY_LIMIT);
    const ignored = gitIgnored(
      this.root,
      rows.map((entry) => entry.path),
    );
    const entries: WorkspaceFileListEntry[] = rows.map((entry) => ({
      path: entry.kind === "directory" ? `${entry.path}/` : entry.path,
      name: entry.name,
      kind: entry.kind,
      ignored: ignored.has(entry.path),
    }));
    this.send({
      kind: "listing",
      directoryPath: path,
      entries,
      truncated: listed.entries.length > ENTRY_LIMIT,
      hasBinaryPayload: false,
    });
    this.startWatching(path);
    // Parent coverage is the source of truth for child existence: a covered
    // child this refresh no longer lists is gone, and so is everything under it.
    const present = new Set(
      entries
        .filter((entry) => entry.kind === "directory")
        .map((entry) => entry.path),
    );
    const dropped: string[] = [];
    for (const candidate of [...this.covered]) {
      if (
        candidate !== ROOT &&
        parentOf(candidate) === path &&
        !present.has(candidate)
      ) {
        dropped.push(...this.dropSubtree(candidate));
      }
    }
    this.prune(dropped, "missing");
  }

  private startWatching(path: string): void {
    if (this.watchers.has(path) || this.closed) {
      return;
    }
    try {
      const watcher = watch(join(this.root, unaryForm(path)), () => {
        this.schedule(path);
      });
      watcher.on("error", () => {
        this.stopWatching(path);
      });
      this.watchers.set(path, watcher);
    } catch {
      // A directory that cannot be watched is still listed once; it simply
      // does not update, which beats pruning content the client can see.
    }
  }

  private schedule(path: string): void {
    const existing = this.timers.get(path);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.timers.delete(path);
      void this.emit(path);
    }, SETTLE_MS);
    timer.unref();
    this.timers.set(path, timer);
  }

  /** Drops a path and its covered descendants; returns what it dropped. */
  private dropSubtree(path: string): readonly string[] {
    const dropped = [...this.covered].filter(
      (candidate) => candidate === path || isUnder(candidate, path),
    );
    for (const entry of dropped) {
      this.covered.delete(entry);
      this.stopWatching(entry);
    }
    return dropped;
  }

  private stopWatching(path: string): void {
    this.watchers.get(path)?.close();
    this.watchers.delete(path);
    const timer = this.timers.get(path);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(path);
    }
  }

  private prune(
    directoryPaths: readonly string[],
    reason: "missing" | "limit" | "error",
  ): void {
    if (directoryPaths.length === 0) {
      return;
    }
    this.send({
      kind: "pruned",
      directoryPaths: [...directoryPaths],
      reason,
      hasBinaryPayload: false,
    });
  }

  private send(frame: unknown): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(frame));
  }
}

async function exists(absolute: string): Promise<boolean> {
  try {
    await stat(absolute);
    return true;
  } catch {
    return false;
  }
}

/** `"src/"` -> `"src"`, the form the unary listing helper takes. */
function unaryForm(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

/** `"a/b/"` -> `"a/"`; a top-level directory's parent is the root. */
function parentOf(path: string): string {
  const trimmed = unaryForm(path);
  const cut = trimmed.lastIndexOf("/");
  return cut < 0 ? ROOT : trimmed.slice(0, cut + 1);
}

function isUnder(candidate: string, ancestor: string): boolean {
  return ancestor !== ROOT && candidate.startsWith(ancestor);
}

/**
 * Which of these paths git ignores. Asked per LISTING rather than once per
 * stream: a `dist/` created after the session opened must report `ignored`
 * from the refresh that first lists it, and asking about the exact paths also
 * covers a child of an ignored directory, which a `--directory` sweep collapses
 * away. Outside a git work tree - or when the check fails - nothing is ignored,
 * which is the contract's own answer for that case.
 */
function gitIgnored(
  root: string,
  paths: readonly string[],
): ReadonlySet<string> {
  if (paths.length === 0) {
    return new Set();
  }
  try {
    const raw = execFileSync("git", ["check-ignore", "-z", "--stdin"], {
      cwd: root,
      encoding: "utf8",
      input: paths.join("\0"),
      timeout: 5_000,
      stdio: ["pipe", "pipe", "ignore"],
    });
    return new Set(raw.split("\0").filter((entry) => entry.length > 0));
  } catch (error) {
    // Exit 1 means "none of these are ignored" - a real answer, not a failure -
    // and `execFileSync` throws on it while still carrying its stdout.
    const stdout: unknown = Reflect.get(Object(error), "stdout");
    if (typeof stdout !== "string") {
      return new Set();
    }
    return new Set(stdout.split("\0").filter((entry) => entry.length > 0));
  }
}

function readPaths(frame: object): readonly string[] {
  const value = Reflect.get(frame, "directoryPaths");
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}
