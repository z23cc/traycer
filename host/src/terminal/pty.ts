import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  closeSync,
  createReadStream,
  openSync,
  writeSync,
  type ReadStream,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { spawn as spawnNodePty, type IPty } from "node-pty";

export type PtySpawnRequest = {
  readonly sessionId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly extraEnv: { readonly [key: string]: string };
  /**
   * `~/.traycer/cli/config.json` env overrides. A `null` value UNSETS the
   * variable, which `extraEnv` cannot express - that is why these ride their
   * own field instead of being folded in by the caller.
   */
  readonly envOverrides: { readonly [key: string]: string | null };
};

type NodePtySession = {
  readonly kind: "node-pty";
  readonly pty: IPty;
  scrollback: string;
};

type PosixPtySession = {
  readonly kind: "posix";
  readonly child: ChildProcess;
  readonly masterFd: number;
  readonly reader: ReadStream;
  scrollback: string;
};

type PtySession = NodePtySession | PosixPtySession;

const MAX_SCROLLBACK = 256 * 1024;
const require = createRequire(import.meta.url);

export class PtyManager extends EventEmitter {
  private readonly processes = new Map<string, PtySession>();

  spawn(request: PtySpawnRequest): void {
    this.kill(request.sessionId);
    const env = buildEnv(request);
    if (usePosixBackend()) {
      this.spawnPosix(request, env);
      return;
    }
    this.spawnNodePty(request, env);
  }

  write(sessionId: string, data: string): boolean {
    const found = this.processes.get(sessionId);
    if (found === undefined) {
      return false;
    }
    if (found.kind === "node-pty") {
      found.pty.write(data);
      return true;
    }
    try {
      writeSync(found.masterFd, data);
      return true;
    } catch {
      return false;
    }
  }

  resize(sessionId: string, cols: number, rows: number): boolean {
    const found = this.processes.get(sessionId);
    if (found === undefined) {
      return false;
    }
    if (found.kind === "node-pty") {
      found.pty.resize(cols, rows);
      return true;
    }
    return ioctlWinsize(found.masterFd, cols, rows);
  }

  kill(sessionId: string): boolean {
    const found = this.processes.get(sessionId);
    if (found === undefined) {
      return false;
    }
    if (found.kind === "node-pty") {
      found.pty.kill();
    } else {
      killPosixSession(found);
      closePosixSession(found);
    }
    this.processes.delete(sessionId);
    return true;
  }

  scrollback(sessionId: string): string {
    return this.processes.get(sessionId)?.scrollback ?? "";
  }

  has(sessionId: string): boolean {
    return this.processes.has(sessionId);
  }

  disposeAll(): void {
    for (const sessionId of [...this.processes.keys()]) {
      this.kill(sessionId);
    }
  }

  private spawnNodePty(
    request: PtySpawnRequest,
    env: { readonly [key: string]: string },
  ): void {
    ensureNodePtyHelper();
    let child: IPty;
    try {
      child = spawnNodePty(request.command, [...request.args], {
        name: "xterm-256color",
        cols: request.cols,
        rows: request.rows,
        cwd: request.cwd,
        env,
      });
    } catch {
      this.emit("exit", request.sessionId, 1);
      return;
    }
    const entry: NodePtySession = {
      kind: "node-pty",
      pty: child,
      scrollback: "",
    };
    this.processes.set(request.sessionId, entry);
    child.onData((chunk: string) => {
      this.emitData(request.sessionId, chunk);
    });
    child.onExit((event: { readonly exitCode: number }) => {
      this.processes.delete(request.sessionId);
      this.emit("exit", request.sessionId, event.exitCode);
    });
  }

  private spawnPosix(
    request: PtySpawnRequest,
    env: { readonly [key: string]: string },
  ): void {
    const opened = openPosixPty(request.cols, request.rows);
    if (opened === null) {
      this.emit("exit", request.sessionId, 1);
      return;
    }
    let child: ChildProcess;
    try {
      // `detached` makes the child a session leader (`setsid`), and re-opening
      // the slave from inside that session - without `O_NOCTTY` - is what
      // makes the pty its CONTROLLING terminal. Node cannot run `TIOCSCTTY`
      // between fork and exec (node-pty ships a C helper for exactly this), so
      // the acquisition happens in one line of `sh` that then execs the real
      // command. Without it the shell has a tty on its fds but no session:
      // `tty` works while job control, `^C`, and `SIGWINCH` do not.
      child = spawn(
        "/bin/sh",
        [
          "-c",
          'exec 0<>"$1" 1>&0 2>&0; shift; exec "$@"',
          "sh",
          opened.slavePath,
          request.command,
          ...request.args,
        ],
        {
          cwd: request.cwd,
          env,
          stdio: [opened.slaveFd, opened.slaveFd, opened.slaveFd],
          detached: true,
        },
      );
    } catch {
      closeSync(opened.slaveFd);
      closeSync(opened.masterFd);
      this.emit("exit", request.sessionId, 1);
      return;
    }
    closeSync(opened.slaveFd);
    const reader = createReadStream("", {
      fd: opened.masterFd,
      encoding: "utf8",
    });
    const entry: PosixPtySession = {
      kind: "posix",
      child,
      masterFd: opened.masterFd,
      reader,
      scrollback: "",
    };
    this.processes.set(request.sessionId, entry);
    reader.on("data", (chunk: string | Buffer) => {
      this.emitData(
        request.sessionId,
        typeof chunk === "string" ? chunk : chunk.toString("utf8"),
      );
    });
    child.on("exit", (code) => {
      const current = this.processes.get(request.sessionId);
      if (current !== undefined && current.kind === "posix") {
        closePosixSession(current);
        this.processes.delete(request.sessionId);
      }
      this.emit("exit", request.sessionId, code ?? 0);
    });
    child.on("error", () => {
      const current = this.processes.get(request.sessionId);
      if (current !== undefined && current.kind === "posix") {
        closePosixSession(current);
        this.processes.delete(request.sessionId);
      }
      this.emit("exit", request.sessionId, 1);
    });
  }

  private emitData(sessionId: string, chunk: string): void {
    const found = this.processes.get(sessionId);
    if (found === undefined) {
      return;
    }
    found.scrollback = `${found.scrollback}${chunk}`.slice(-MAX_SCROLLBACK);
    this.emit("data", sessionId, chunk);
  }
}

function buildEnv(request: PtySpawnRequest): {
  readonly [key: string]: string;
} {
  const env: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  env.TERM = "xterm-256color";
  env.COLUMNS = String(request.cols);
  env.LINES = String(request.rows);
  for (const [key, value] of Object.entries(request.extraEnv)) {
    env[key] = value;
  }
  for (const [key, value] of Object.entries(request.envOverrides)) {
    if (value === null) {
      delete env[key];
      continue;
    }
    env[key] = value;
  }
  return env;
}

function usePosixBackend(): boolean {
  return process.versions.bun !== undefined && process.platform !== "win32";
}

function ensureNodePtyHelper(): void {
  if (process.platform === "win32") {
    return;
  }
  try {
    const pkg = dirname(require.resolve("node-pty/package.json"));
    const helper = join(
      pkg,
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    );
    chmodSync(helper, 0o755);
  } catch {
    return;
  }
}

function openPosixPty(
  cols: number,
  rows: number,
): {
  readonly masterFd: number;
  readonly slaveFd: number;
  readonly slavePath: string;
} | null {
  const libc = loadLibc();
  if (libc === null) {
    return null;
  }
  const masterFd = libc.posix_openpt(O_RDWR | O_NOCTTY);
  if (masterFd < 0) {
    return null;
  }
  if (libc.grantpt(masterFd) !== 0 || libc.unlockpt(masterFd) !== 0) {
    closeSync(masterFd);
    return null;
  }
  const slavePath = libc.ptsname(masterFd);
  if (slavePath.length === 0) {
    closeSync(masterFd);
    return null;
  }
  let slaveFd: number;
  try {
    slaveFd = openSync(slavePath, "r+");
  } catch {
    closeSync(masterFd);
    return null;
  }
  ioctlWinsize(masterFd, cols, rows);
  return { masterFd, slaveFd, slavePath };
}

type LibcPty = {
  readonly posix_openpt: (flags: number) => number;
  readonly grantpt: (fd: number) => number;
  readonly unlockpt: (fd: number) => number;
  readonly ptsname: (fd: number) => string;
  readonly ioctl: (fd: number, request: number, buf: Uint8Array) => number;
};

function loadLibc(): LibcPty | null {
  try {
    const ffi = require("bun:ffi") as {
      dlopen: (
        name: string,
        symbols: object,
      ) => {
        readonly symbols: {
          posix_openpt: (flags: number) => number;
          grantpt: (fd: number) => number;
          unlockpt: (fd: number) => number;
          ptsname: (fd: number) => unknown;
          ioctl: (fd: number, request: bigint | number, ptr: unknown) => number;
        };
      };
      CString: new (value: unknown) => { toString(): string };
      ptr: (buf: Uint8Array) => unknown;
    };
    const libName =
      process.platform === "linux" ? "libc.so.6" : "libSystem.B.dylib";
    const opened = ffi.dlopen(libName, {
      posix_openpt: { args: ["i32"], returns: "i32" },
      grantpt: { args: ["i32"], returns: "i32" },
      unlockpt: { args: ["i32"], returns: "i32" },
      ptsname: { args: ["i32"], returns: "ptr" },
      ioctl: { args: ["i32", "u64", "ptr"], returns: "i32" },
    });
    return {
      posix_openpt: opened.symbols.posix_openpt,
      grantpt: opened.symbols.grantpt,
      unlockpt: opened.symbols.unlockpt,
      ptsname: (fd: number): string => {
        const raw = opened.symbols.ptsname(fd);
        return String(new ffi.CString(raw));
      },
      ioctl: (fd: number, request: number, buf: Uint8Array): number => {
        return opened.symbols.ioctl(fd, request, ffi.ptr(buf));
      },
    };
  } catch {
    return null;
  }
}

function ioctlWinsize(fd: number, cols: number, rows: number): boolean {
  const libc = loadLibc();
  if (libc === null) {
    return false;
  }
  const buf = Buffer.alloc(8);
  buf.writeUInt16LE(rows, 0);
  buf.writeUInt16LE(cols, 2);
  buf.writeUInt16LE(0, 4);
  buf.writeUInt16LE(0, 6);
  return libc.ioctl(fd, TIOCSWINSZ, buf) === 0;
}

/**
 * The child is its own session leader, so the whole job - the shell and
 * anything it started - hangs up together. `SIGHUP` is what a terminal
 * closing sends; a bare `child.kill()` would leave the shell's children
 * running against a closed pty.
 */
function killPosixSession(session: PosixPtySession): void {
  const pid = session.child.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, "SIGHUP");
      return;
    } catch {
      // The group is already gone, or the child never made it to setsid.
    }
  }
  session.child.kill();
}

function closePosixSession(session: PosixPtySession): void {
  try {
    session.reader.destroy();
  } catch {
    return;
  }
  try {
    closeSync(session.masterFd);
  } catch {
    return;
  }
}

const O_RDWR = 2;
const O_NOCTTY = process.platform === "linux" ? 0x100 : 0x20000;
const TIOCSWINSZ = process.platform === "linux" ? 0x5414 : 0x80087467;
