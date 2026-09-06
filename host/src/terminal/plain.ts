import { homedir } from "node:os";
import type { WebSocket } from "ws";
import type {
  PlainTerminalProjection,
  PlainTerminalScope,
} from "@traycer/protocol/host/terminal/plain-schemas";
import type { HostRuntime } from "../runtime";
import type { StoredPlainTerminal } from "../store/host-store";

/**
 * A durable plain terminal is a record plus whatever PTY is alive for it right
 * now. The two are deliberately separate: the record survives restarts, the
 * PTY does not, and `terminal.plain.ensureRunning` is what re-attaches them.
 * `sessionId` is the `terminalId` by contract, so the existing generic
 * `terminal.subscribe` stream carries a plain terminal's bytes unchanged.
 */
export function plainProjection(
  runtime: HostRuntime,
  row: StoredPlainTerminal,
): PlainTerminalProjection {
  const session = runtime.terminals.get(row.terminalId);
  const record = {
    terminalId: row.terminalId,
    hostId: row.hostId,
    scope: scopeOf(row),
    launch: {
      cwd: row.cwd,
      shellCommand: row.shellCommand,
      shellArgs: [...row.shellArgs],
    },
    manualTitle: row.manualTitle,
    revision: row.revision,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
  if (session === null || session.status !== "running") {
    return { record, runtime: { status: "dormant" } };
  }
  return {
    record,
    runtime: {
      status: "running",
      sessionId: row.terminalId,
      currentCwd: session.currentCwd.length > 0 ? session.currentCwd : row.cwd,
      activeProcessName: session.activeProcessName ?? null,
      cols: session.cols,
      rows: session.rows,
    },
  };
}

export function scopeOf(row: StoredPlainTerminal): PlainTerminalScope {
  return row.epicId === null
    ? { kind: "independent" }
    : { kind: "epic", epicId: row.epicId };
}

export function plainTerminalsInScope(
  runtime: HostRuntime,
  scope: PlainTerminalScope,
): readonly StoredPlainTerminal[] {
  return runtime.store
    .snapshot()
    .plainTerminals.filter((row) =>
      scope.kind === "epic" ? row.epicId === scope.epicId : row.epicId === null,
    );
}

/** Spawns the PTY and registers the session the terminal stream reads. */
export function startPlainPty(
  runtime: HostRuntime,
  row: StoredPlainTerminal,
  cols: number,
  rows: number,
): void {
  const existing = runtime.terminals.get(row.terminalId);
  if (existing !== null && existing.status === "running") {
    return;
  }
  runtime.terminals.put({
    sessionId: row.terminalId,
    scope: scopeOf(row),
    sessionKind: "terminal",
    cwd: row.cwd,
    currentCwd: row.cwd,
    shellCommand: row.shellCommand,
    shellArgs: [...row.shellArgs],
    cols,
    rows,
    status: "running",
    exitCode: null,
    exitReason: null,
    createdAt: Date.now(),
    title: row.manualTitle,
    activeProcessName: null,
    lifecycleOwner: "manager",
  });
  runtime.pty.spawn({
    sessionId: row.terminalId,
    command: row.shellCommand,
    args: [...row.shellArgs],
    cwd: row.cwd,
    cols,
    rows,
    extraEnv: {},
  });
}

export function defaultShell(): string {
  const shell = process.env.SHELL;
  return shell !== undefined && shell.length > 0 ? shell : "/bin/zsh";
}

export function defaultCwd(): string {
  const home = homedir();
  return home.length > 0 ? home : "/";
}

/**
 * `terminal.plain.subscribeList` subscribers, each pinned to the scope it
 * asked for. Every accepted frame is a full replacement state, so a mutation
 * republishes rather than emitting a tombstone.
 */
export class PlainTerminalHub {
  private readonly subscribers = new Map<WebSocket, PlainTerminalScope>();

  add(socket: WebSocket, scope: PlainTerminalScope): void {
    this.subscribers.set(socket, scope);
  }

  remove(socket: WebSocket): void {
    this.subscribers.delete(socket);
  }

  scopes(): readonly (readonly [WebSocket, PlainTerminalScope])[] {
    return [...this.subscribers.entries()];
  }
}
