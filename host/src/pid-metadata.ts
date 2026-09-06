import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readProcessStartIdentity } from "./process-start-identity";

export type PublishedPidMetadata = {
  readonly pid: number;
  readonly hostId: string;
  readonly version: string;
  readonly websocketUrl: string;
  readonly startedAt: string;
  readonly processStartTimeMs: number;
  readonly processStartIdentity: string | null;
};

export function pidMetadataPath(dataDir: string): string {
  return join(dataDir, "pid.json");
}

export async function writePidMetadata(
  dataDir: string,
  metadata: PublishedPidMetadata,
): Promise<string> {
  const path = pidMetadataPath(dataDir);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(metadata, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, path);
  return path;
}

export function buildPidMetadata(input: {
  readonly hostId: string;
  readonly version: string;
  readonly websocketUrl: string;
}): PublishedPidMetadata {
  const now = Date.now();
  return {
    pid: process.pid,
    hostId: input.hostId,
    version: input.version,
    websocketUrl: input.websocketUrl,
    startedAt: new Date(now).toISOString(),
    processStartTimeMs: now - Math.round(process.uptime() * 1000),
    processStartIdentity: readProcessStartIdentity(process.pid),
  };
}
