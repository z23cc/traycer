import { spawn as spawnNodeProcess } from "node:child_process";
import { resolve } from "node:path";
import type {
  CanonicalTerminalSessionInfo,
  CanonicalTerminalSessionInfoWithCurrentCwd,
  CreateTerminalRequestV20,
  ListTerminalsRequestV20,
} from "@traycer/protocol/host/terminal/unary-schemas";

type TerminalHandle = {
  readonly write: (data: string | Uint8Array) => number;
  readonly resize: (cols: number, rows: number) => void;
  readonly close: () => void;
};

type TerminalSubprocess = {
  readonly terminal: TerminalHandle | undefined;
  readonly exited: Promise<number>;
  readonly kill: (signal: NodeJS.Signals | number | undefined) => void;
};

type BunRuntime = {
  readonly spawn: (
    command: readonly string[],
    options: {
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly terminal: {
        readonly cols: number;
        readonly rows: number;
        readonly data: (terminal: TerminalHandle, data: Uint8Array) => void;
      };
    },
  ) => TerminalSubprocess;
};

declare const Bun: BunRuntime;

type StoredTerminalSession = {
  info: CanonicalTerminalSessionInfoWithCurrentCwd;
  readonly process: TerminalSubprocess;
  readonly decoder: TextDecoder;
  scrollback: string;
  readonly subscribers: Map<symbol, TerminalSubscriber>;
  readonly worktreeBusyPaths: readonly string[];
};

type TerminalSubscriber = {
  cols: number;
  rows: number;
  readonly sink: (event: TerminalSessionEvent) => void;
};

export type TerminalSessionEvent =
  | { readonly kind: "data"; readonly chunk: string }
  | { readonly kind: "resized"; readonly cols: number; readonly rows: number }
  | { readonly kind: "exit"; readonly exitCode: number }
  | {
      readonly kind: "sessionUpdated";
      readonly session: CanonicalTerminalSessionInfoWithCurrentCwd;
    };

export type TerminalSessionSubscription = {
  readonly session: CanonicalTerminalSessionInfoWithCurrentCwd;
  readonly scrollback: string;
  readonly write: (data: string) => boolean;
  readonly resize: (cols: number, rows: number) => boolean;
  readonly dispose: () => void;
};

const MAX_SCROLLBACK_CHARACTERS = 2 * 1024 * 1024;

export class TerminalSessionManager {
  private readonly sessions = new Map<string, StoredTerminalSession>();

  create(request: CreateTerminalRequestV20): CanonicalTerminalSessionInfo {
    const existing = this.sessions.get(request.desiredSessionId);
    if (existing !== undefined) {
      return withoutCurrentCwd(existing.info);
    }

    const configuredShell = process.env.SHELL?.trim();
    const shellCommand =
      request.shellCommand ??
      (configuredShell === undefined || configuredShell.length === 0
        ? "/bin/sh"
        : configuredShell);
    const shellArgs = request.shellArgs ?? [];
    const pendingData: Uint8Array[] = [];
    let stored: StoredTerminalSession | null = null;
    const subprocess = spawnTerminalProcess(
      [shellCommand, ...shellArgs],
      request.cwd,
      request.cols,
      request.rows,
      terminalEnvironment(request),
      (data) => {
        if (stored === null) {
          pendingData.push(data.slice());
          return;
        }
        this.acceptOutput(stored, data);
      },
    );
    if (subprocess.terminal === undefined) {
      subprocess.kill(undefined);
      throw new Error("Unable to create a PTY for the terminal session");
    }

    stored = {
      process: subprocess,
      decoder: new TextDecoder(),
      scrollback: "",
      subscribers: new Map(),
      worktreeBusyPaths: request.worktreeBusyPaths.map((path) => resolve(path)),
      info: {
        sessionId: request.desiredSessionId,
        scope: request.scope,
        sessionKind: request.sessionKind,
        cwd: request.cwd,
        currentCwd: request.cwd,
        shellCommand,
        shellArgs,
        cols: request.cols,
        rows: request.rows,
        status: "running",
        exitCode: null,
        exitReason: null,
        createdAt: Date.now(),
        title: null,
        activeProcessName: null,
      },
    };
    this.sessions.set(request.desiredSessionId, stored);
    for (const data of pendingData) {
      this.acceptOutput(stored, data);
    }
    void subprocess.exited.then((exitCode) => {
      if (this.sessions.get(request.desiredSessionId) !== stored) {
        return;
      }
      stored.info = {
        ...stored.info,
        status: "exited",
        exitCode,
        exitReason: "process-exit",
        activeProcessName: null,
      };
      this.broadcast(stored, { kind: "exit", exitCode });
    });
    return withoutCurrentCwd(stored.info);
  }

  list(
    request: ListTerminalsRequestV20,
  ): CanonicalTerminalSessionInfoWithCurrentCwd[] {
    return [...this.sessions.values()]
      .filter(({ info }) => scopesEqual(info.scope, request.scope))
      .map(({ info }) => ({ ...info }));
  }

  kill(sessionId: string): boolean {
    const stored = this.sessions.get(sessionId);
    if (stored === undefined) {
      return false;
    }
    this.sessions.delete(sessionId);
    this.broadcast(stored, { kind: "exit", exitCode: 0 });
    stored.subscribers.clear();
    stored.process.kill(undefined);
    stored.process.terminal?.close();
    return true;
  }

  rename(sessionId: string, title: string): boolean {
    const stored = this.sessions.get(sessionId);
    if (stored === undefined || stored.info.title === title) {
      return false;
    }
    stored.info = { ...stored.info, title };
    this.broadcast(stored, {
      kind: "sessionUpdated",
      session: { ...stored.info },
    });
    return true;
  }

  killScope(scope: CanonicalTerminalSessionInfo["scope"]): void {
    for (const { info } of [...this.sessions.values()]) {
      if (scopesEqual(info.scope, scope)) {
        this.kill(info.sessionId);
      }
    }
  }

  isWorktreePathBusy(worktreePath: string): boolean {
    const target = resolve(worktreePath);
    return [...this.sessions.values()].some(
      (session) =>
        session.info.status === "running" &&
        session.worktreeBusyPaths.includes(target),
    );
  }

  runningCount(): number {
    return [...this.sessions.values()].filter(
      (session) => session.info.status === "running",
    ).length;
  }

  subscribe(
    sessionId: string,
    cols: number,
    rows: number,
    sink: (event: TerminalSessionEvent) => void,
  ): TerminalSessionSubscription | null {
    const stored = this.sessions.get(sessionId);
    if (stored === undefined) {
      return null;
    }
    const subscriberId = Symbol(sessionId);
    this.resizeForSubscribers(stored, cols, rows);
    stored.subscribers.set(subscriberId, { cols, rows, sink });
    let disposed = false;
    return {
      session: { ...stored.info },
      scrollback: stored.scrollback,
      write: (data) => {
        if (stored.info.status !== "running") {
          return false;
        }
        stored.process.terminal?.write(data);
        return true;
      },
      resize: (nextCols, nextRows) => {
        const subscriber = stored.subscribers.get(subscriberId);
        if (subscriber === undefined || stored.info.status !== "running") {
          return false;
        }
        subscriber.cols = nextCols;
        subscriber.rows = nextRows;
        this.recomputeSize(stored);
        return true;
      },
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        stored.subscribers.delete(subscriberId);
        this.recomputeSize(stored);
      },
    };
  }

  dispose(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.kill(sessionId);
    }
  }

  private acceptOutput(stored: StoredTerminalSession, data: Uint8Array): void {
    const chunk = stored.decoder.decode(data, { stream: true });
    if (chunk.length === 0) {
      return;
    }
    stored.scrollback = `${stored.scrollback}${chunk}`.slice(
      -MAX_SCROLLBACK_CHARACTERS,
    );
    this.broadcast(stored, { kind: "data", chunk });
  }

  private resizeForSubscribers(
    stored: StoredTerminalSession,
    cols: number,
    rows: number,
  ): void {
    const effectiveCols = Math.min(
      cols,
      ...[...stored.subscribers.values()].map((subscriber) => subscriber.cols),
    );
    const effectiveRows = Math.min(
      rows,
      ...[...stored.subscribers.values()].map((subscriber) => subscriber.rows),
    );
    this.applySize(stored, effectiveCols, effectiveRows);
  }

  private recomputeSize(stored: StoredTerminalSession): void {
    if (stored.subscribers.size === 0) {
      return;
    }
    this.applySize(
      stored,
      Math.min(
        ...[...stored.subscribers.values()].map(
          (subscriber) => subscriber.cols,
        ),
      ),
      Math.min(
        ...[...stored.subscribers.values()].map(
          (subscriber) => subscriber.rows,
        ),
      ),
    );
  }

  private applySize(
    stored: StoredTerminalSession,
    cols: number,
    rows: number,
  ): void {
    if (stored.info.cols === cols && stored.info.rows === rows) {
      return;
    }
    stored.process.terminal?.resize(cols, rows);
    stored.info = { ...stored.info, cols, rows };
    this.broadcast(stored, { kind: "resized", cols, rows });
  }

  private broadcast(
    stored: StoredTerminalSession,
    event: TerminalSessionEvent,
  ): void {
    for (const subscriber of stored.subscribers.values()) {
      subscriber.sink(event);
    }
  }
}

function spawnTerminalProcess(
  command: readonly string[],
  cwd: string,
  cols: number,
  rows: number,
  env: NodeJS.ProcessEnv,
  onData: (data: Uint8Array) => void,
): TerminalSubprocess {
  if (typeof Bun !== "undefined") {
    return Bun.spawn(command, {
      cwd,
      env,
      terminal: {
        cols,
        rows,
        data: (_terminal, data) => onData(data),
      },
    });
  }

  const [executable, ...args] = command;
  if (executable === undefined) {
    throw new Error("Terminal command is empty");
  }
  const child = spawnNodeProcess(executable, args, {
    cwd,
    env,
    stdio: "pipe",
  });
  const terminal: TerminalHandle = {
    write: (data) => {
      child.stdin.write(data);
      return typeof data === "string" ? Buffer.byteLength(data) : data.length;
    },
    resize: () => {},
    close: () => child.stdin.end(),
  };
  child.stdout.on("data", (data: Uint8Array) => onData(data));
  child.stderr.on("data", (data: Uint8Array) => onData(data));
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  return {
    terminal,
    exited,
    kill: (signal) => child.kill(signal),
  };
}

function terminalEnvironment(
  request: CreateTerminalRequestV20,
): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (
    request.sessionKind !== "terminal-agent" ||
    request.scope.kind !== "epic"
  ) {
    return env;
  }
  env.TRAYCER_AGENT_ID = request.desiredSessionId;
  env.TRAYCER_EPIC_ID = request.scope.epicId;
  env.TRAYCER_AGENT_CLI_SURFACE =
    request.tuiHarnessId === "claude" ? "full" : "readonly";
  const configuredCli = process.env.TRAYCER_CLI;
  env.TRAYCER_CLI =
    configuredCli === undefined || configuredCli.trim().length === 0
      ? "traycer"
      : configuredCli;
  return env;
}

function withoutCurrentCwd(
  info: CanonicalTerminalSessionInfoWithCurrentCwd,
): CanonicalTerminalSessionInfo {
  const { currentCwd: _currentCwd, ...session } = info;
  return session;
}

function scopesEqual(
  left: CanonicalTerminalSessionInfo["scope"],
  right: CanonicalTerminalSessionInfo["scope"],
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  return (
    left.kind === "independent" ||
    (right.kind === "epic" && left.epicId === right.epicId)
  );
}
