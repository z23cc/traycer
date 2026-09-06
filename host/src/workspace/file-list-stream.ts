import { execFileSync } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { WebSocket } from "ws";
import type { WorkspaceFileListEntry } from "@traycer/protocol/host/workspace/subscribe";
import { listDirectory, validateWorkspacePath } from "./workspace";

/**
 * One `workspace.subscribeFileList` session: SINGLE-LEVEL listings of the
 * directories a client has asked to cover, re-sent whenever one changes.
 *
 * A `listing` REPLACES the client's state for its directory wholesale - there
 * are no granular add/remove events - so a change only ever has to re-read one
 * directory, and the watcher is per covered path rather than recursive.
 */
const COVERAGE_LIMIT = 256;
const ENTRY_LIMIT = 2_000;
/** fs events arrive in bursts (an editor save is several); coalesce them. */
const SETTLE_MS = 120;

export class WorkspaceFileListSession {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private ignored: ReadonlySet<string> = new Set();
  private root = "";
  private closed = false;

  constructor(private readonly socket: WebSocket) {}

  /** Covers the root's first level; no client frame is needed to start. */
  async open(workspacePath: string): Promise<void> {
    const validation = await validateWorkspacePath(workspacePath);
    if (!validation.ok) {
      this.send({
        kind: "pruned",
        directoryPaths: [""],
        reason: "missing",
        hasBinaryPayload: false,
      });
      return;
    }
    this.root = validation.resolvedPath;
    this.ignored = gitIgnored(this.root);
    await this.cover([""]);
  }

  async handleFrame(frame: unknown): Promise<boolean> {
    if (frame === null || typeof frame !== "object") {
      return false;
    }
    const kind = Reflect.get(frame, "kind");
    if (kind === "ping") {
      this.send({ kind: "pong", hasBinaryPayload: false });
      return true;
    }
    const paths = readPaths(frame);
    if (kind === "watch") {
      await this.cover(paths);
      return true;
    }
    if (kind === "unwatch") {
      for (const path of paths) {
        this.drop(path);
      }
      return true;
    }
    return false;
  }

  close(): void {
    this.closed = true;
    for (const path of [...this.watchers.keys()]) {
      this.drop(path);
    }
  }

  private async cover(paths: readonly string[]): Promise<void> {
    const refused: string[] = [];
    for (const path of paths) {
      if (this.watchers.size >= COVERAGE_LIMIT && !this.watchers.has(path)) {
        refused.push(path);
        continue;
      }
      await this.emit(path);
    }
    if (refused.length > 0) {
      // The budget is spent, so the watch was refused - said plainly rather
      // than by silently never sending a listing for these paths.
      this.send({
        kind: "pruned",
        directoryPaths: refused,
        reason: "limit",
        hasBinaryPayload: false,
      });
    }
  }

  private async emit(path: string): Promise<void> {
    if (this.closed) {
      return;
    }
    const listed = await listDirectory(this.root, path);
    if (!listed.ok) {
      this.drop(path);
      this.send({
        kind: "pruned",
        directoryPaths: [path],
        reason: "error",
        hasBinaryPayload: false,
      });
      return;
    }
    const entries: WorkspaceFileListEntry[] = listed.entries
      .slice(0, ENTRY_LIMIT)
      .map((entry) => ({
        // Trailing-slashed for directories: the same identity every other
        // workspace surface uses, and what `watch` will name this path with.
        path: entry.kind === "directory" ? `${entry.path}/` : entry.path,
        name: entry.name,
        kind: entry.kind,
        ignored: this.ignored.has(entry.path),
      }));
    this.send({
      kind: "listing",
      directoryPath: path,
      entries,
      truncated: listed.entries.length > ENTRY_LIMIT,
      hasBinaryPayload: false,
    });
    this.startWatching(path);
  }

  private startWatching(path: string): void {
    if (this.watchers.has(path) || this.closed) {
      return;
    }
    try {
      const watcher = watch(join(this.root, path), () => {
        this.schedule(path);
      });
      watcher.on("error", () => {
        this.drop(path);
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

  private drop(path: string): void {
    const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
    for (const key of [path, normalized]) {
      this.watchers.get(key)?.close();
      this.watchers.delete(key);
      const timer = this.timers.get(key);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.timers.delete(key);
      }
    }
  }

  private send(frame: unknown): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(frame));
  }
}

/**
 * Paths git ignores, as workspace-relative strings. Outside a git work tree -
 * or when the check fails - the set is empty and every entry reports
 * `ignored: false`, which is what the contract asks for.
 */
function gitIgnored(root: string): ReadonlySet<string> {
  try {
    const raw = execFileSync(
      "git",
      [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 5_000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const paths = new Set<string>();
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        paths.add(trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed);
      }
    }
    return paths;
  } catch {
    return new Set();
  }
}

function readPaths(frame: object): readonly string[] {
  const value = Reflect.get(frame, "directoryPaths");
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => (entry.endsWith("/") ? entry.slice(0, -1) : entry));
}
