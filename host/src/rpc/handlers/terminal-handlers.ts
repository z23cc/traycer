import { homedir } from "node:os";
import {
  createTerminalRequestSchemaV21,
  killTerminalRequestSchema,
  listTerminalsRequestSchema,
  listTerminalsRequestSchemaV20,
  renameTerminalRequestSchema,
  type TerminalScope,
} from "@traycer/protocol/host/terminal/unary-schemas";
import type { RpcHandler } from "./types";

export const handleTerminalList: RpcHandler = (params, runtime) => {
  const scope = readTerminalScope(params);
  const home = homedir();
  return {
    ok: true,
    result: {
      sessions: runtime.terminals.list(scope),
      homeCwd: home.length > 0 ? home : null,
    },
  };
};

export const handleTerminalCreate: RpcHandler = (params, runtime) => {
  const parsed = createTerminalRequestSchemaV21.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  if (
    parsed.data.sessionKind === "terminal-agent" &&
    parsed.data.scope.kind !== "epic"
  ) {
    return {
      ok: false,
      code: "RPC_ERROR",
      message: "terminal-agent sessions require an epic scope",
    };
  }
  const existing = runtime.terminals.get(parsed.data.desiredSessionId);
  if (existing !== null && existing.status === "running") {
    return { ok: true, result: { session: existing } };
  }
  const now = Date.now();
  const shellCommand =
    parsed.data.shellCommand ?? process.env.SHELL ?? "/bin/zsh";
  const shellArgs = parsed.data.shellArgs ?? [];
  const session = {
    sessionId: parsed.data.desiredSessionId,
    scope: parsed.data.scope,
    sessionKind: parsed.data.sessionKind,
    cwd: parsed.data.cwd,
    currentCwd: parsed.data.cwd,
    shellCommand,
    shellArgs,
    cols: parsed.data.cols,
    rows: parsed.data.rows,
    status: "running" as const,
    exitCode: null,
    exitReason: null,
    createdAt: now,
    title: null,
    activeProcessName: null,
    lifecycleOwner: "manager" as const,
  };
  runtime.terminals.put(session);
  runtime.pty.spawn({
    sessionId: session.sessionId,
    command: shellCommand,
    args: shellArgs,
    cwd: parsed.data.cwd,
    cols: parsed.data.cols,
    rows: parsed.data.rows,
    extraEnv: {},
  });
  return { ok: true, result: { session } };
};

export const handleTerminalKill: RpcHandler = (params, runtime) => {
  const parsed = killTerminalRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  runtime.pty.kill(parsed.data.sessionId);
  return {
    ok: true,
    result: { killed: runtime.terminals.kill(parsed.data.sessionId) },
  };
};

export const handleTerminalRename: RpcHandler = (params, runtime) => {
  const parsed = renameTerminalRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const existing = runtime.terminals.get(parsed.data.sessionId);
  if (existing === null) {
    return { ok: true, result: { updated: false } };
  }
  runtime.terminals.put({ ...existing, title: parsed.data.title });
  return { ok: true, result: { updated: true } };
};

function readTerminalScope(params: unknown): TerminalScope {
  const scoped = listTerminalsRequestSchemaV20.safeParse(params);
  if (scoped.success) {
    return scoped.data.scope;
  }
  const legacy = listTerminalsRequestSchema.safeParse(params);
  if (legacy.success) {
    return { kind: "epic", epicId: legacy.data.epicId };
  }
  return { kind: "independent" };
}
