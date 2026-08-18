import { execFile } from "node:child_process";
import { resolve } from "node:path";

const GIT_READ_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

export async function gitRepositoryRoot(
  workspacePath: string,
): Promise<string | null> {
  const output = await readGit(workspacePath, ["rev-parse", "--show-toplevel"]);
  return output === null ? null : resolve(output);
}

export function readGit(
  cwd: string,
  args: readonly string[],
): Promise<string | null> {
  return new Promise((resolveOutput) => {
    try {
      execFile(
        "git",
        ["-C", cwd, ...args],
        {
          cwd,
          encoding: "utf8",
          timeout: GIT_READ_TIMEOUT_MS,
          maxBuffer: GIT_MAX_BUFFER_BYTES,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error !== null) {
            resolveOutput(null);
            return;
          }
          const output = stdout.replace(/\s+$/u, "");
          resolveOutput(output.length === 0 ? null : output);
        },
      );
    } catch {
      resolveOutput(null);
    }
  });
}

export function runGitBoolean(
  cwd: string,
  args: readonly string[],
): Promise<boolean> {
  return new Promise((resolveResult) => {
    try {
      execFile(
        "git",
        ["-C", cwd, ...args],
        {
          cwd,
          timeout: GIT_READ_TIMEOUT_MS,
          maxBuffer: GIT_MAX_BUFFER_BYTES,
          windowsHide: true,
        },
        (error) => resolveResult(error === null),
      );
    } catch {
      resolveResult(false);
    }
  });
}
