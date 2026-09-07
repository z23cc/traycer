import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import type { HostRuntime } from "../runtime";

/**
 * One sample of every process on the machine, and the owner attribution this
 * host can honestly make: the PTYs it spawned and the children of its GUI
 * chat turns, plus everything descended from those roots.
 *
 * `cpuPercent` is a RATE, derived from cumulative CPU-time deltas over wall
 * time. `ps`'s own `%cpu` is a lifetime average - a process that burned a core
 * an hour ago reads high forever - which is not what the contract asks for.
 */

export type ProcessRow = {
  readonly pid: number;
  readonly parentPid: number | null;
  readonly name: string;
  readonly command: string | null;
  readonly cpuSeconds: number;
  readonly rssBytes: number;
};

export type OwnerRoot = {
  readonly kind: "chat" | "terminal" | "terminal-agent";
  readonly ownerId: string;
  readonly epicId: string;
  readonly harnessId: string | null;
  readonly rootPid: number;
  readonly activeProcessName: string | null;
};

export function readProcesses(): readonly ProcessRow[] {
  // `args` is last because it contains spaces; everything before it parses
  // positionally.
  const raw = tryExec("ps", ["-axo", "pid=,ppid=,time=,rss=,args="]);
  if (raw === null) {
    return [];
  }
  const rows: ProcessRow[] = [];
  for (const line of raw.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    const command = match[5].trim();
    rows.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      name: basename(command.split(" ")[0] ?? "").slice(0, 120),
      command: command.length === 0 ? null : command.slice(0, 512),
      cpuSeconds: cpuSeconds(match[3]),
      // `ps` reports RSS in kilobytes.
      rssBytes: Number(match[4]) * 1024,
    });
  }
  return rows;
}

/** `[[hh:]mm:]ss[.frac]` as seconds. */
function cpuSeconds(field: string): number {
  const parts = field.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) {
    return 0;
  }
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/**
 * Turns two samples into rates. The FIRST sample of a pid has no predecessor
 * and reports 0 - honest, because a rate needs two points, and better than
 * back-filling a lifetime average that would read high forever.
 */
export class CpuRates {
  private previous = new Map<number, number>();
  private previousAt = 0;

  measure(
    rows: readonly ProcessRow[],
    now: number,
  ): ReadonlyMap<number, number> {
    const elapsed = (now - this.previousAt) / 1000;
    const rates = new Map<number, number>();
    const next = new Map<number, number>();
    for (const row of rows) {
      next.set(row.pid, row.cpuSeconds);
      const was = this.previous.get(row.pid);
      if (was === undefined || elapsed <= 0) {
        rates.set(row.pid, 0);
        continue;
      }
      rates.set(row.pid, Math.max(0, ((row.cpuSeconds - was) / elapsed) * 100));
    }
    this.previous = next;
    this.previousAt = now;
    return rates;
  }
}

/**
 * The owners this host can name. A `managed-command` owner is never produced:
 * this host serves no managed commands, so a row for one would be invented.
 */
export function ownerRoots(
  runtime: HostRuntime,
  scope:
    | { readonly kind: "epic"; readonly epicId: string }
    | { readonly kind: "global" },
): readonly OwnerRoot[] {
  const roots: OwnerRoot[] = [];
  for (const session of runtime.terminals.listAll()) {
    if (session.scope.kind !== "epic") {
      continue;
    }
    if (scope.kind === "epic" && session.scope.epicId !== scope.epicId) {
      continue;
    }
    const pid = runtime.pty.pidOf(session.sessionId);
    if (pid === null) {
      continue;
    }
    roots.push({
      kind: session.sessionKind,
      ownerId: session.sessionId,
      epicId: session.scope.epicId,
      // A session carries no agent link, so the harness behind a
      // `terminal-agent` PTY is not nameable from here. `null` is the
      // contract's own answer for an owner with no harness, and it is the
      // honest one - guessing from the process name would name a wrapper.
      harnessId: null,
      rootPid: pid,
      activeProcessName: session.activeProcessName ?? null,
    });
  }
  for (const agentId of runtime.guiRuns.runningAgentIds()) {
    const pid = runtime.guiRuns.pidOf(agentId);
    const chat = runtime.store
      .snapshot()
      .chats.find((row) => row.chatId === agentId);
    if (pid === null || chat === undefined) {
      continue;
    }
    if (scope.kind === "epic" && chat.epicId !== scope.epicId) {
      continue;
    }
    roots.push({
      kind: "chat",
      ownerId: agentId,
      epicId: chat.epicId,
      harnessId:
        runtime.store.snapshot().agents.find((row) => row.id === agentId)
          ?.harnessId ?? null,
      rootPid: pid,
      activeProcessName: null,
    });
  }
  return roots;
}

/** Every pid reachable from `root` through the parent links in one sample. */
export function treeOf(
  rows: readonly ProcessRow[],
  root: number,
): readonly ProcessRow[] {
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    if (row.parentPid === null) {
      continue;
    }
    const bucket = children.get(row.parentPid);
    if (bucket === undefined) {
      children.set(row.parentPid, [row]);
      continue;
    }
    bucket.push(row);
  }
  const found: ProcessRow[] = [];
  const seen = new Set<number>();
  const queue = rows.filter((row) => row.pid === root);
  while (queue.length > 0) {
    const row = queue.shift();
    if (row === undefined || seen.has(row.pid)) {
      continue;
    }
    seen.add(row.pid);
    found.push(row);
    queue.push(...(children.get(row.pid) ?? []));
  }
  return found;
}

function tryExec(file: string, args: readonly string[]): string | null {
  try {
    return execFileSync(file, [...args], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}
