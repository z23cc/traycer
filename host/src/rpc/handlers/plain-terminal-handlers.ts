import {
  closePlainTerminalRequestSchema,
  createPlainTerminalRequestSchema,
  ensurePlainTerminalRunningRequestSchema,
  importLegacyPlainTerminalRequestSchema,
  listPlainTerminalsRequestSchema,
  renamePlainTerminalRequestSchema,
  type PlainTerminalListState,
  type PlainTerminalScope,
} from "@traycer/protocol/host/terminal/plain-schemas";
import {
  configuredShell,
  plainProjection,
  plainTerminalsInScope,
  startPlainPty,
} from "../../terminal/plain";
import type { HostRuntime } from "../../runtime";
import type { StoredPlainTerminal } from "../../store/host-store";
import type { RpcHandler } from "./types";

export const handlePlainTerminalCreate: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = createPlainTerminalRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const request = parsed.data;
  const now = Date.now();
  // Ownership, environment, and the resolved shell are host-derived: the
  // request schema does not let a client supply them.
  const shell = await configuredShell();
  const row: StoredPlainTerminal = {
    terminalId: request.terminalId,
    hostId: runtime.hostId,
    epicId: request.scope.kind === "epic" ? request.scope.epicId : null,
    cwd: request.cwd,
    shellCommand: shell.command,
    shellArgs: [...shell.args],
    createdAt: now,
    manualTitle: null,
    revision: 1,
    updatedAt: now,
  };
  const stored = await runtime.store.mutate((state) => {
    const existing = state.plainTerminals.find(
      (candidate) => candidate.terminalId === row.terminalId,
    );
    if (existing !== undefined) {
      return existing;
    }
    state.plainTerminals.push(row);
    return row;
  });
  startPlainPty(runtime, stored, request.cols, request.rows);
  publishPlainTerminals(runtime);
  return {
    ok: true,
    result: { terminal: plainProjection(runtime, stored) },
  };
};

export const handlePlainTerminalList: RpcHandler = (params, runtime) => {
  const parsed = listPlainTerminalsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return { ok: true, result: listState(runtime, parsed.data.scope) };
};

export const handlePlainTerminalRename: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = renamePlainTerminalRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const updated = await runtime.store.mutate((state) => {
    const row = state.plainTerminals.find(
      (candidate) => candidate.terminalId === parsed.data.terminalId,
    );
    if (row === undefined) {
      return null;
    }
    row.manualTitle = parsed.data.manualTitle;
    row.revision += 1;
    row.updatedAt = Date.now();
    return row;
  });
  if (updated === null) {
    return { ok: false, code: "RPC_ERROR", message: "terminal not found" };
  }
  publishPlainTerminals(runtime);
  return {
    ok: true,
    result: { terminal: plainProjection(runtime, updated) },
  };
};

export const handlePlainTerminalEnsureRunning: RpcHandler = (
  params,
  runtime,
) => {
  const parsed = ensurePlainTerminalRunningRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const row = runtime.store
    .snapshot()
    .plainTerminals.find(
      (candidate) => candidate.terminalId === parsed.data.terminalId,
    );
  if (row === undefined) {
    return { ok: false, code: "RPC_ERROR", message: "terminal not found" };
  }
  startPlainPty(runtime, row, parsed.data.cols, parsed.data.rows);
  publishPlainTerminals(runtime);
  return { ok: true, result: { terminal: plainProjection(runtime, row) } };
};

export const handlePlainTerminalClose: RpcHandler = async (params, runtime) => {
  const parsed = closePlainTerminalRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const terminalId = parsed.data.terminalId;
  runtime.pty.kill(terminalId);
  runtime.terminals.kill(terminalId);
  const revision = await runtime.store.mutate((state) => {
    const row = state.plainTerminals.find(
      (candidate) => candidate.terminalId === terminalId,
    );
    state.plainTerminals = state.plainTerminals.filter(
      (candidate) => candidate.terminalId !== terminalId,
    );
    return row === undefined ? 1 : row.revision + 1;
  });
  publishPlainTerminals(runtime);
  return { ok: true, result: { terminalId, revision } };
};

export const handlePlainTerminalImportLegacy: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = importLegacyPlainTerminalRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const request = parsed.data;
  // The persisted binding is evidence, not client-selected scope: a record
  // that names another host is not this host's to adopt.
  if (request.hostId !== runtime.hostId) {
    return {
      ok: true,
      result: {
        status: "deleted",
        terminalId: request.terminalId,
        revision: 1,
      },
    };
  }
  const existing = runtime.store
    .snapshot()
    .plainTerminals.find((row) => row.terminalId === request.terminalId);
  if (existing !== undefined) {
    return {
      ok: true,
      result: {
        status: "existing",
        terminal: plainProjection(runtime, existing),
      },
    };
  }
  const now = Date.now();
  const shell = await configuredShell();
  const row: StoredPlainTerminal = {
    terminalId: request.terminalId,
    hostId: runtime.hostId,
    epicId: request.scope.kind === "epic" ? request.scope.epicId : null,
    cwd: request.cwd,
    shellCommand: shell.command,
    shellArgs: [...shell.args],
    createdAt: now,
    manualTitle: request.titleSource === "manual" ? request.name : null,
    revision: 1,
    updatedAt: now,
  };
  await runtime.store.mutate((state) => {
    state.plainTerminals.push(row);
  });
  publishPlainTerminals(runtime);
  return {
    ok: true,
    result: { status: "imported", terminal: plainProjection(runtime, row) },
  };
};

/**
 * `complete-local` for the independent collection, `partial-serving-host` for
 * an epic: this host can only speak for its own terminals, and claiming
 * `complete-fleet` would assert that no other host holds any.
 */
export function listState(
  runtime: HostRuntime,
  scope: PlainTerminalScope,
): PlainTerminalListState {
  const terminals = plainTerminalsInScope(runtime, scope).map((row) =>
    plainProjection(runtime, row),
  );
  if (scope.kind === "epic") {
    return {
      coverage: "partial-serving-host",
      scope,
      servingHostId: runtime.hostId,
      terminals,
    };
  }
  return { coverage: "complete-local", scope, terminals };
}

/** Re-sends each subscriber the replacement state for its own scope. */
export function publishPlainTerminals(runtime: HostRuntime): void {
  for (const [socket, scope] of runtime.plainTerminals.scopes()) {
    if (socket.readyState !== socket.OPEN) {
      continue;
    }
    socket.send(
      JSON.stringify({
        kind: "state",
        hasBinaryPayload: false,
        state: listState(runtime, scope),
      }),
    );
  }
}
