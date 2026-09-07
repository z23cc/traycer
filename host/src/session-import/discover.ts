import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { GuiHarnessId } from "@traycer/protocol/host/agent/shared";
import type {
  SessionImportCandidate,
  SessionImportGroup,
} from "@traycer/protocol/host/session-import/candidate";

/**
 * Reads the vendors' own session directories so `sessionImport.scan` can offer
 * what is there.
 *
 * Metadata only, and strictly read-only, which the contract states twice: a
 * transcript is parsed once, at import, never here. That is not a style
 * preference - a Claude session file runs to tens of megabytes and there are
 * hundreds of them, so a scan that read them end to end would cost minutes to
 * fill in two nullable fields. Every session is therefore described from a
 * bounded PREFIX of its file, and `messageCount` is reported as `null` rather
 * than counted.
 *
 * ponytail: the walk is synchronous, so a scan blocks the host's loop for as
 * long as it runs (well under a second at the ~300 files on this machine).
 * Chunk it across ticks if someone turns up with a session directory big
 * enough to stall a terminal.
 */

/** How much of a session file describes it. */
const PREFIX_BYTES = 256 * 1024;

/** The providers this host has a reader for. */
const READABLE: readonly GuiHarnessId[] = ["claude", "codex"];

/**
 * One session as discovered, plus where it ran - which the candidate itself
 * has no room for, because the wire carries that on the GROUP.
 */
export type DiscoveredSession = {
  readonly candidate: SessionImportCandidate;
  /** The session's own `cwd`, or null when the file recorded none. */
  readonly folder: string | null;
  /** The vendor's name for the folder holding the file; used when `folder` is null. */
  readonly fallbackLabel: string;
};

export type ProviderRoots = ReadonlyMap<GuiHarnessId, string>;

/**
 * Where each provider keeps its sessions. Only the two this host can actually
 * read: a harness absent here is reported as a FAILED provider rather than an
 * empty one, so the wizard greys its section out instead of telling the user
 * they have never run that CLI.
 */
export function defaultProviderRoots(): ProviderRoots {
  const home = homedir();
  return new Map([
    ["claude", join(home, ".claude", "projects")],
    ["codex", join(home, ".codex", "sessions")],
  ]);
}

export function readableProviders(roots: ProviderRoots): GuiHarnessId[] {
  return READABLE.filter((harness) => roots.has(harness));
}

/**
 * Walks one provider. Throws when a root exists but will not list - the caller
 * turns that into `providerFailed`. A root that is simply absent is a user who
 * has never run that CLI, which is an empty result, not a failure.
 */
export function readProvider(
  harness: GuiHarnessId,
  root: string,
  updatedAfter: number | null,
): DiscoveredSession[] {
  if (!existsSync(root)) {
    return [];
  }
  const found: DiscoveredSession[] = [];
  // Claude keeps one directory per project; Codex nests year/month/day.
  for (const file of jsonlFiles(root, harness === "claude" ? 1 : 3)) {
    const mtimeMs = mtimeOf(file);
    // Filtered during the walk rather than after it: the contract puts the
    // wizard's scan window on the wire precisely so the host never pays to
    // open a file the user will not be shown.
    if (
      mtimeMs === null ||
      (updatedAfter !== null && mtimeMs <= updatedAfter)
    ) {
      continue;
    }
    found.push(describeSession(harness, file, mtimeMs));
  }
  return found;
}

/**
 * Folds sessions into the folders they ran in.
 *
 * Grouping is by REPO ROOT wherever there is one, so two sessions run in
 * different subdirectories of one checkout land in a single group - which is
 * what makes `gitBacked` the host's knowledge rather than a guess a client
 * could make from the path.
 */
export function groupSessions(
  sessions: readonly DiscoveredSession[],
): SessionImportGroup[] {
  const roots = new Map<string, string | null>();
  const groups = new Map<string, SessionImportGroup>();
  for (const session of sessions) {
    const folder = session.folder;
    if (folder === null || !existsSync(folder)) {
      // No recorded cwd, or a folder that is gone: either way this work has no
      // location left but a label, and the wizard imports it folderless.
      const path = folder ?? session.fallbackLabel;
      group(groups, `missing:${path}`, {
        location: { kind: "missing_folder", path },
        gitBacked: false,
        sessions: [],
      }).push(session.candidate);
      continue;
    }
    let root = roots.get(folder);
    if (root === undefined) {
      root = repoRootOf(folder);
      roots.set(folder, root);
    }
    const path = root ?? folder;
    group(groups, `folder:${path}`, {
      location: {
        kind: "folder",
        path,
        // This host adopts a folder at import, through the same registration
        // "add folder" uses, so it looks nothing up here.
        workspaceId: null,
      },
      gitBacked: root !== null,
      sessions: [],
    }).push(session.candidate);
  }
  // Newest work first, both in the group list and inside each group.
  const ordered = [...groups.values()];
  for (const row of ordered) {
    row.sessions.sort((left, right) => right.updatedAt - left.updatedAt);
  }
  ordered.sort((left, right) => newest(right) - newest(left));
  return ordered;
}

function group(
  groups: Map<string, SessionImportGroup>,
  key: string,
  fresh: SessionImportGroup,
): SessionImportCandidate[] {
  const held = groups.get(key);
  if (held !== undefined) {
    return held.sessions;
  }
  groups.set(key, fresh);
  return fresh.sessions;
}

function newest(row: SessionImportGroup): number {
  return row.sessions.reduce(
    (latest, session) => Math.max(latest, session.updatedAt),
    0,
  );
}

/**
 * The nearest ancestor holding a `.git`, or null.
 *
 * Walked here rather than asked of `git rev-parse`, which would be one
 * subprocess per distinct working directory - a hundred of them on this
 * machine - to answer what `existsSync` already answers. `.git` is a file in a
 * worktree and a directory in a checkout; both count.
 */
function repoRootOf(folder: string): string | null {
  let dir = folder;
  for (;;) {
    if (existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** Throws for the root itself; a subdirectory that will not list is skipped. */
function jsonlFiles(root: string, depth: number): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) {
        files.push(...nestedJsonlFiles(path, depth - 1));
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(path);
    }
  }
  return files;
}

function nestedJsonlFiles(root: string, depth: number): string[] {
  try {
    return jsonlFiles(root, depth);
  } catch {
    return [];
  }
}

function mtimeOf(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    // Listed a moment ago and gone now - the vendor owns this directory and
    // may rotate it under us.
    return null;
  }
}

/** Reads at most `PREFIX_BYTES` from the head of a file, whole lines only. */
function readPrefix(path: string): string[] {
  const fd = openSync(path, "r");
  let text: string;
  try {
    const buffer = Buffer.alloc(PREFIX_BYTES);
    const read = readSync(fd, buffer, 0, PREFIX_BYTES, 0);
    text = buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
  const lines = text.split("\n");
  // The last line is whole only when the read stopped on a newline; dropping
  // it costs one session line and saves a parse error on every truncated file.
  lines.pop();
  return lines.filter((line) => line.length > 0);
}

type SessionBase = {
  readonly harness: GuiHarnessId;
  readonly nativeSessionId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messageCount: null;
  readonly hasSubagents: boolean;
};

function describeSession(
  harness: GuiHarnessId,
  file: string,
  mtimeMs: number,
): DiscoveredSession {
  const fallbackLabel = basename(dirname(file));
  const base: SessionBase = {
    harness,
    nativeSessionId: basename(file).replace(/\.jsonl$/u, ""),
    createdAt: mtimeMs,
    updatedAt: mtimeMs,
    // Nullable by design: neither provider publishes a count anywhere cheaper
    // than the transcript, and the scan does not open one.
    messageCount: null,
    // Claude marks a subagent turn with `isSidechain` on the turn itself, deep
    // in the file; Codex does not mark one at all. Neither is visible from a
    // prefix, so the badge stays off rather than being guessed.
    hasSubagents: false,
  };
  let lines: string[];
  try {
    lines = readPrefix(file);
  } catch (error) {
    return unreadable(
      base,
      fallbackLabel,
      null,
      "source_unreadable",
      String(error),
    );
  }
  const head =
    harness === "claude" ? readClaudeHead(lines) : readCodexHead(lines);
  if (!head.sawMessage) {
    // Still grouped by its own `cwd`: an abandoned session file is a row the
    // user recognizes best next to the work it was abandoned beside.
    return unreadable(
      base,
      fallbackLabel,
      head.cwd,
      "source_empty",
      "No session message was recorded.",
    );
  }
  return {
    candidate: {
      ...base,
      nativeSessionId:
        head.sessionId === null ? base.nativeSessionId : head.sessionId,
      title: head.title,
      firstPrompt: head.firstPrompt,
      createdAt: head.createdAt === null ? mtimeMs : head.createdAt,
      // This host keeps no native-session index yet, so it cannot know a
      // session was already brought in; every readable one is offered.
      state: { kind: "importable" },
    },
    folder: head.cwd,
    fallbackLabel,
  };
}

type Head = {
  /** False when the prefix held no message at all - an abandoned session file. */
  readonly sawMessage: boolean;
  readonly sessionId: string | null;
  readonly cwd: string | null;
  readonly title: string | null;
  readonly firstPrompt: string | null;
  readonly createdAt: number | null;
};

function readClaudeHead(lines: readonly string[]): Head {
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let title: string | null = null;
  let firstPrompt: string | null = null;
  let createdAt: number | null = null;
  let sawMessage = false;
  for (const line of lines) {
    const row = parse(line);
    if (row === null) {
      continue;
    }
    const type = text(row, "type");
    sessionId = sessionId ?? text(row, "sessionId");
    cwd = cwd ?? text(row, "cwd");
    createdAt = createdAt ?? epoch(text(row, "timestamp"));
    if (type === "ai-title") {
      title = title ?? text(row, "aiTitle");
      continue;
    }
    if (type !== "user" && type !== "assistant" && type !== "message") {
      continue;
    }
    sawMessage = true;
    if (
      type !== "user" ||
      firstPrompt !== null ||
      // `isMeta` marks a line Claude wrote for itself - the resume caveat, a
      // command's expansion - so it is a message but never the user's prompt.
      Reflect.get(row, "isMeta") === true ||
      Reflect.get(row, "isSidechain") === true
    ) {
      continue;
    }
    firstPrompt = promptOf(Reflect.get(row, "message"));
  }
  return { sawMessage, sessionId, cwd, title, firstPrompt, createdAt };
}

function readCodexHead(lines: readonly string[]): Head {
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let firstPrompt: string | null = null;
  let createdAt: number | null = null;
  let sawMessage = false;
  for (const line of lines) {
    const row = parse(line);
    if (row === null) {
      continue;
    }
    createdAt = createdAt ?? epoch(text(row, "timestamp"));
    const payload = Reflect.get(row, "payload");
    if (payload === null || typeof payload !== "object") {
      continue;
    }
    if (text(row, "type") === "session_meta") {
      sessionId =
        sessionId ?? text(payload, "id") ?? text(payload, "session_id");
      cwd = cwd ?? text(payload, "cwd");
      continue;
    }
    if (text(payload, "type") !== "message") {
      continue;
    }
    sawMessage = true;
    if (text(payload, "role") === "user" && firstPrompt === null) {
      firstPrompt = promptOf(payload);
    }
  }
  // Codex names a session by its rollout file alone; it stores no title.
  return { sawMessage, sessionId, cwd, title: null, firstPrompt, createdAt };
}

/**
 * A prompt out of either vendor's message shape: a bare string, or the content
 * blocks both use, of which only the text ones read as a prompt.
 */
function promptOf(message: unknown): string | null {
  if (message === null || typeof message !== "object") {
    return null;
  }
  const content = Reflect.get(message, "content");
  if (typeof content === "string") {
    return content.length > 0 ? content : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") {
      continue;
    }
    const value = Reflect.get(block, "text");
    if (typeof value === "string" && value.length > 0) {
      parts.push(value);
    }
  }
  return parts.length === 0 ? null : parts.join("\n");
}

function unreadable(
  base: SessionBase,
  fallbackLabel: string,
  folder: string | null,
  reason: "source_unreadable" | "source_empty",
  detail: string,
): DiscoveredSession {
  return {
    candidate: {
      ...base,
      title: null,
      firstPrompt: null,
      state: { kind: "unreadable", reason, detail },
    },
    folder,
    fallbackLabel,
  };
}

function parse(line: string): object | null {
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function text(row: object, key: string): string | null {
  const value = Reflect.get(row, key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function epoch(stamp: string | null): number | null {
  if (stamp === null) {
    return null;
  }
  const at = Date.parse(stamp);
  return Number.isNaN(at) ? null : at;
}
