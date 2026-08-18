import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export type GitCapabilities =
  | {
      readonly available: true;
      readonly gitVersion: string | null;
      readonly reason: null;
    }
  | {
      readonly available: false;
      readonly gitVersion: string | null;
      readonly reason: string;
    };

export function probeGitCapabilities(runningDir: string): GitCapabilities {
  const version = gitVersion();
  if (version === null) {
    return {
      available: false,
      gitVersion: null,
      reason: "git was not found on PATH",
    };
  }
  if (runningDir.length > 0 && !existsSync(runningDir)) {
    return {
      available: false,
      gitVersion: version,
      reason: `runningDir does not exist: ${runningDir}`,
    };
  }
  return { available: true, gitVersion: version, reason: null };
}

export function isGitRepo(path: string): boolean {
  const gitPath = join(path, ".git");
  if (!existsSync(gitPath)) {
    return false;
  }
  try {
    const stat = statSync(gitPath);
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

export function directoryExists(path: string): boolean {
  if (!existsSync(path)) {
    return false;
  }
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function gitVersion(): string | null {
  const result = spawnSync("git", ["--version"], {
    encoding: "utf8",
    timeout: 3_000,
  });
  if (result.status !== 0 || result.stdout === null) {
    return null;
  }
  const match = result.stdout.trim().match(/git version\s+(.+)$/i);
  return match?.[1] ?? result.stdout.trim();
}
