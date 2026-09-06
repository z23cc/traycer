import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

export type PtySpawnRequest = {
  readonly sessionId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly extraEnv: { readonly [key: string]: string };
};

type PtyProcess = {
  readonly child: ChildProcessWithoutNullStreams;
  scrollback: string;
};

const MAX_SCROLLBACK = 256 * 1024;

export class PtyManager extends EventEmitter {
  private readonly processes = new Map<string, PtyProcess>();

  spawn(request: PtySpawnRequest): void {
    this.kill(request.sessionId);
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
    const child = spawnPtyProcess(
      request.command,
      request.args,
      request.cwd,
      env,
    );
    const entry: PtyProcess = { child, scrollback: "" };
    this.processes.set(request.sessionId, entry);
    child.stdout.on("data", (chunk: Buffer) => {
      this.emitData(request.sessionId, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.emitData(request.sessionId, chunk.toString("utf8"));
    });
    child.on("exit", (code) => {
      this.processes.delete(request.sessionId);
      this.emit("exit", request.sessionId, code ?? 0);
    });
    child.on("error", () => {
      this.processes.delete(request.sessionId);
      this.emit("exit", request.sessionId, 1);
    });
  }

  write(sessionId: string, data: string): boolean {
    const found = this.processes.get(sessionId);
    if (found === undefined) {
      return false;
    }
    found.child.stdin.write(data);
    return true;
  }

  resize(sessionId: string, cols: number, rows: number): boolean {
    const found = this.processes.get(sessionId);
    if (found === undefined) {
      return false;
    }
    if (found.child.pid !== undefined) {
      try {
        process.kill(found.child.pid, "SIGWINCH");
      } catch {
        return false;
      }
    }
    void cols;
    void rows;
    return true;
  }

  kill(sessionId: string): boolean {
    const found = this.processes.get(sessionId);
    if (found === undefined) {
      return false;
    }
    found.child.kill();
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

  private emitData(sessionId: string, chunk: string): void {
    const found = this.processes.get(sessionId);
    if (found === undefined) {
      return;
    }
    found.scrollback = `${found.scrollback}${chunk}`.slice(-MAX_SCROLLBACK);
    this.emit("data", sessionId, chunk);
  }
}

function spawnPtyProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  env: { readonly [key: string]: string },
): ChildProcessWithoutNullStreams {
  // `script` cannot wrap a piped stdin on current macOS (tcgetattr/ioctl
  // fails and the child never starts). This analog is a piped child, not a
  // real PTY.
  return spawn(command, [...args], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
