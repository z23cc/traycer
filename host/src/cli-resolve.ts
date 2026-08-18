import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export type HarnessCommand = "claude" | "codex";

export function harnessCommandOf(harnessId: string): HarnessCommand | null {
  if (harnessId === "claude" || harnessId === "codex") {
    return harnessId;
  }
  return null;
}

export function resolveHarnessExecutable(
  harness: HarnessCommand,
  env: NodeJS.ProcessEnv,
): string | null {
  const override = overridePath(harness, env);
  if (override !== null && isExecutableFile(override)) {
    return override;
  }
  const fromPath = lookupOnPath(harness, env.PATH);
  if (fromPath !== null) {
    return fromPath;
  }
  for (const candidate of wellKnownPaths(harness, env.HOME)) {
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

function overridePath(
  harness: HarnessCommand,
  env: NodeJS.ProcessEnv,
): string | null {
  const key =
    harness === "claude" ? "TRAYCER_CLAUDE_PATH" : "TRAYCER_CODEX_PATH";
  const raw = env[key];
  if (raw === undefined || raw.trim().length === 0) {
    return null;
  }
  return raw.trim();
}

function lookupOnPath(
  command: string,
  pathValue: string | undefined,
): string | null {
  if (pathValue === undefined || pathValue.length === 0) {
    return null;
  }
  for (const dir of pathValue.split(delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    const candidate = join(dir, command);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

function wellKnownPaths(
  harness: HarnessCommand,
  home: string | undefined,
): string[] {
  const paths: string[] = [];
  if (home !== undefined && home.length > 0) {
    if (harness === "claude") {
      paths.push(
        join(home, ".local/bin/claude"),
        join(home, ".claude/local/claude"),
        join(home, "bin/claude"),
      );
    } else {
      paths.push(join(home, ".local/bin/codex"), join(home, "bin/codex"));
    }
  }
  if (harness === "claude") {
    paths.push("/opt/homebrew/bin/claude", "/usr/local/bin/claude");
  } else {
    paths.push("/opt/homebrew/bin/codex", "/usr/local/bin/codex");
  }
  return paths;
}

function isExecutableFile(path: string): boolean {
  if (!existsSync(path)) {
    return false;
  }
  try {
    const stat = statSync(path);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform === "win32") {
      return true;
    }
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
