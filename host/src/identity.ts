import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type HostIdentityRecord = {
  readonly hostId: string;
  readonly createdAt: string;
};

export async function loadOrCreateHostIdentity(
  dataDir: string,
): Promise<HostIdentityRecord> {
  const identityDir = join(dataDir, "identity");
  await mkdir(identityDir, { recursive: true });
  const path = join(identityDir, "identity.json");
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      const record = parsed as Record<string, unknown>;
      if (
        typeof record.hostId === "string" &&
        record.hostId.length > 0 &&
        typeof record.createdAt === "string"
      ) {
        return { hostId: record.hostId, createdAt: record.createdAt };
      }
    }
  } catch {
    // Missing or corrupt — mint a new identity.
  }
  const created: HostIdentityRecord = {
    hostId: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  await writeFile(path, `${JSON.stringify(created, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return created;
}
