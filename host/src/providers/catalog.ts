import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { ProviderId } from "@traycer/protocol/host/provider-ids";
import { providerIdSchema } from "@traycer/protocol/host/provider-ids";

export const ALL_PROVIDER_IDS: readonly ProviderId[] = providerIdSchema.options;

const BASE_BINARY_NAME: { readonly [id in ProviderId]: string } = {
  "claude-code": "claude",
  codex: "codex",
  opencode: "opencode",
  cursor: "cursor-agent",
  traycer: "opencode",
  grok: "grok",
  qwen: "qwen",
  kiro: "kiro-cli",
  droid: "droid",
  kimi: "kimi",
  copilot: "copilot",
  kilocode: "kilo",
  openrouter: "opencode",
  amp: "amp",
  devin: "devin",
  pi: "pi",
  hermes: "hermes",
  omp: "omp",
  huggingface: "opencode",
  reasonix: "reasonix",
};

const VERSION_TIMEOUT_MS = 15_000;
const VERSION_PATTERN = /\b(\d+\.\d+\.\d+(?:[.-][A-Za-z0-9]+)*)\b/u;

export function pathBinaryName(providerId: ProviderId): string {
  if (providerId === "pi" && process.platform === "win32") {
    return "pi.cmd";
  }
  return BASE_BINARY_NAME[providerId];
}

export function lookPath(binary: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    const candidate = join(dir, binary);
    if (isExecutableFile(candidate)) {
      try {
        return realpathSync(candidate);
      } catch {
        return candidate;
      }
    }
  }
  return null;
}

export function isExecutableFile(path: string): boolean {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) {
      return false;
    }
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function probeCandidateVersion(
  path: string,
): Promise<{ readonly executable: boolean; readonly version: string | null }> {
  if (!isExecutableFile(path)) {
    return { executable: false, version: null };
  }
  return { executable: true, version: await detectBinaryVersion(path) };
}

export async function detectBinaryVersion(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(path, ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    let output = "";
    const onData = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.length > 4096) {
        child.kill();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const timer: NodeJS.Timeout = setTimeout(() => {
      child.kill();
    }, VERSION_TIMEOUT_MS);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once("close", () => {
      clearTimeout(timer);
      resolve(parseVersionFromOutput(output));
    });
  });
}

export function parseVersionFromOutput(output: string): string | null {
  const match = VERSION_PATTERN.exec(output);
  return match === null ? null : match[1];
}
