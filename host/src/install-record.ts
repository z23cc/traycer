import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { HOST_VERSION } from "./version";

/**
 * Version the desktop host controller compares against `install.json`.
 *
 * `make dev-desktop` leaves a signed install record (currently 1.2.0) in the
 * slot while this OSS daemon is what actually listens. Publishing 0.1.0 in
 * `pid.json` makes the GUI treat that as activation debt ("Update installed —
 * restart host to finish"). Prefer the install record's runtime stamp so the
 * wrapper + OSS process looks like the installed host to the controller.
 *
 * RPC `host.status` still reports {@link HOST_VERSION}.
 */
export async function publishedRuntimeVersion(dataDir: string): Promise<string> {
  const fromInstall = await readInstallRuntimeVersion(dataDir);
  return fromInstall === null ? HOST_VERSION : fromInstall;
}

export async function readInstallRuntimeVersion(
  dataDir: string,
): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(join(dataDir, "install", "install.json"), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const runtimeVersion = Reflect.get(parsed, "runtimeVersion");
  if (typeof runtimeVersion === "string" && runtimeVersion.length > 0) {
    return runtimeVersion;
  }
  const version = Reflect.get(parsed, "version");
  if (typeof version === "string" && version.length > 0) {
    return version;
  }
  return null;
}
