import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type PublishedPidMetadata = {
  readonly pid: number;
  readonly hostId: string;
  readonly version: string;
  readonly websocketUrl: string;
  readonly startedAt: string;
  readonly processStartIdentity: null;
  readonly layer0: {
    readonly status: "acquired";
    readonly attemptId: string;
  };
};

export function pidMetadataPath(hostHome: string): string {
  return join(hostHome, "pid.json");
}

export async function publishPidMetadata(args: {
  readonly hostHome: string;
  readonly hostId: string;
  readonly version: string;
  readonly websocketUrl: string;
}): Promise<string> {
  await mkdir(args.hostHome, { recursive: true, mode: 0o700 });
  const metadata: PublishedPidMetadata = {
    pid: process.pid,
    hostId: args.hostId,
    version: args.version,
    websocketUrl: args.websocketUrl,
    startedAt: new Date().toISOString(),
    processStartIdentity: null,
    layer0: { status: "acquired", attemptId: randomUUID() },
  };
  const path = pidMetadataPath(args.hostHome);
  await writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return path;
}

export async function removePidMetadata(hostHome: string): Promise<void> {
  try {
    await unlink(pidMetadataPath(hostHome));
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}
