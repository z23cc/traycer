import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostInstallHomeDir } from "@traycer/protocol/config/installation";

export const HOST_PACKAGE_VERSION = "0.0.0";
export const HOST_PROTOCOL_VERSION = { major: 1, minor: 1 } as const;

export type HostRuntimeConfig = {
  readonly environment: string;
  readonly port: number;
  readonly hostId: string;
  readonly hostHome: string;
};

export function resolveEnvironment(env: NodeJS.ProcessEnv): string {
  const raw = env.TRAYCER_HOST_ENV;
  if (raw !== undefined && raw.trim().length > 0) {
    return raw.trim();
  }
  return "dev";
}

export function resolveListenPort(env: NodeJS.ProcessEnv): number {
  const raw = env.TRAYCER_HOST_PORT;
  if (raw === undefined || raw.trim().length === 0) {
    return 0;
  }
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`TRAYCER_HOST_PORT must be an integer 0-65535, got ${raw}`);
  }
  return port;
}

export async function loadRuntimeConfig(
  env: NodeJS.ProcessEnv,
): Promise<HostRuntimeConfig> {
  const environment = resolveEnvironment(env);
  const hostHome = hostInstallHomeDir(environment);
  await mkdir(hostHome, { recursive: true, mode: 0o700 });
  const hostId = await loadOrCreateHostId(hostHome);
  return {
    environment,
    port: resolveListenPort(env),
    hostId,
    hostHome,
  };
}

async function loadOrCreateHostId(hostHome: string): Promise<string> {
  const path = join(hostHome, "identity.json");
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "hostId" in parsed &&
      typeof parsed.hostId === "string" &&
      parsed.hostId.length > 0
    ) {
      return parsed.hostId;
    }
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }
  const hostId = randomUUID();
  await writeFile(path, `${JSON.stringify({ hostId }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return hostId;
}

function isEnoent(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
