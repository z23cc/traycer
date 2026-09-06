import { execFileSync } from "node:child_process";
import type { HostRuntime } from "../runtime";

/**
 * Processes this host is ANSWERABLE for in one epic: the PTYs it spawned, plus
 * everything descended from them.
 *
 * This set is the authorization boundary for both methods here. `resources.kill`
 * takes bare pids off the wire, and a pid is not a capability - killing one the
 * host never started would let a client reach any process on the machine,
 * including the user's other hosts and this one's own supervisor. So a pid is
 * killed only if it is in this set, and a port is reported only if it belongs
 * to it.
 */
export function attributedPids(
  runtime: HostRuntime,
  epicId: string,
): ReadonlySet<number> {
  const roots: number[] = [];
  for (const session of runtime.terminals.list({ kind: "epic", epicId })) {
    const pid = runtime.pty.pidOf(session.sessionId);
    if (pid !== null) {
      roots.push(pid);
    }
  }
  return withDescendants(roots);
}

/**
 * Listening TCP ports owned by those processes. On demand rather than on the
 * resource stream: a port scan is only useful while somebody is looking at a
 * blank browser tab.
 */
export function listeningServers(pids: ReadonlySet<number>): readonly {
  readonly pid: number;
  readonly port: number;
  readonly processName: string;
}[] {
  if (pids.size === 0) {
    return [];
  }
  // `-Fpn` is lsof's machine-readable form: one field per line, `p<pid>` then
  // `n<host:port>` per open file. Parsing that beats the columnar output,
  // whose command names contain spaces.
  const raw = tryExec("lsof", [
    "-nP",
    "-Fpn",
    "-iTCP",
    "-sTCP:LISTEN",
    "-a",
    "-p",
    [...pids].join(","),
  ]);
  if (raw === null) {
    return [];
  }
  const names = processNames();
  const servers: {
    readonly pid: number;
    readonly port: number;
    readonly processName: string;
  }[] = [];
  const seen = new Set<string>();
  let pid = 0;
  for (const line of raw.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number.parseInt(line.slice(1), 10);
      continue;
    }
    if (!line.startsWith("n") || pid === 0) {
      continue;
    }
    const port = Number.parseInt(line.slice(line.lastIndexOf(":") + 1), 10);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      continue;
    }
    const key = `${String(pid)}:${String(port)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    servers.push({ pid, port, processName: names.get(pid) ?? "" });
  }
  return servers;
}

/** SIGTERM, and only for pids this host is answerable for. */
export function killAttributed(
  pids: readonly number[],
  attributed: ReadonlySet<number>,
): readonly number[] {
  const killed: number[] = [];
  for (const pid of pids) {
    if (!attributed.has(pid)) {
      continue;
    }
    try {
      process.kill(pid, "SIGTERM");
      killed.push(pid);
    } catch {
      // Already gone: not killed by this call, so not reported as killed.
    }
  }
  return killed;
}

/** One `ps` walk, so a deep tree costs the same as a shallow one. */
function withDescendants(roots: readonly number[]): ReadonlySet<number> {
  const found = new Set<number>(roots);
  if (roots.length === 0) {
    return found;
  }
  const children = new Map<number, number[]>();
  for (const [pid, parent] of processTable()) {
    const siblings = children.get(parent) ?? [];
    siblings.push(pid);
    children.set(parent, siblings);
  }
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) {
      continue;
    }
    for (const child of children.get(current) ?? []) {
      if (!found.has(child)) {
        found.add(child);
        queue.push(child);
      }
    }
  }
  return found;
}

function processTable(): readonly (readonly [number, number])[] {
  const raw = tryExec("ps", ["-axo", "pid=,ppid="]);
  if (raw === null) {
    return [];
  }
  const rows: (readonly [number, number])[] = [];
  for (const line of raw.split("\n")) {
    const parts = line.trim().split(/\s+/u);
    const pid = Number.parseInt(parts[0] ?? "", 10);
    const parent = Number.parseInt(parts[1] ?? "", 10);
    if (Number.isInteger(pid) && Number.isInteger(parent)) {
      rows.push([pid, parent]);
    }
  }
  return rows;
}

function processNames(): ReadonlyMap<number, string> {
  const raw = tryExec("ps", ["-axo", "pid=,comm="]);
  const names = new Map<number, string>();
  if (raw === null) {
    return names;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    const gap = trimmed.indexOf(" ");
    const pid = Number.parseInt(trimmed.slice(0, gap), 10);
    if (Number.isInteger(pid)) {
      names.set(pid, trimmed.slice(gap + 1).trim());
    }
  }
  return names;
}

/** An absent or failing tool is "nothing to report", never a thrown RPC. */
function tryExec(command: string, args: readonly string[]): string | null {
  try {
    return execFileSync(command, [...args], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}
