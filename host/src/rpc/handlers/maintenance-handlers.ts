import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  hostStagedRecordSchema,
  storedCliInstallManifestSchema,
} from "@traycer/protocol/config/installation-records";
import {
  hostAvailableManifestSchema,
  hostServiceStateSchema,
  hostUpdateCheckRequestSchemaV11,
  hostUpdateInstallRequestSchema,
  type HostIncludePreReleasesSource,
} from "@traycer/protocol/host/maintenance/schemas";
import { readCliInvocation } from "../../cli-invocation";
import type { HostRuntime } from "../../runtime";
import type { RpcHandler } from "./types";

/**
 * The host's own service, updates, and installation, answered the released
 * host's way: by running the CLI that installed it. The CLI owns the launchd
 * agent and the release manifest; the host only relays its `--json` result,
 * and says honestly when it could not (`cli-unavailable`, `cli-failed`,
 * `invalid-output`) rather than guessing at an answer.
 */
const CLI_TIMEOUT_MS = 60_000;
const CLI_KILL_GRACE_MS = 2_000;
const CLI_MAX_OUTPUT_BYTES = 1024 * 1024;
/** How long an accepted `host update` owns the host before another may be accepted. */
const UPDATE_CLAIM_MS = 60 * 60_000;

/** `TRAYCER_HOST_UPDATES=external`: something else (the desktop app's login item) owns this host. */
function updatesExternallyManaged(): boolean {
  return process.env.TRAYCER_HOST_UPDATES === "external";
}

type CliOutcome =
  | { readonly kind: "ok"; readonly stdout: string; readonly exitCode: number }
  | { readonly kind: "cli-unavailable" }
  | { readonly kind: "cli-failed" };

async function runHostCli(
  runtime: HostRuntime,
  args: readonly string[],
): Promise<CliOutcome> {
  const invocation = await readCliInvocation(runtime.dataDir);
  if (invocation === null) {
    return { kind: "cli-unavailable" };
  }
  return new Promise((resolve) => {
    const child = spawn(invocation.command, [...invocation.args, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let bytes = 0;
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    const settle = (outcome: CliOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (killTimer !== null) {
        clearTimeout(killTimer);
      }
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      killTimer = setTimeout(() => {
        settle({ kind: "cli-failed" });
      }, CLI_KILL_GRACE_MS);
      killTimer.unref();
    }, CLI_TIMEOUT_MS);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= CLI_MAX_OUTPUT_BYTES) {
        stdout += chunk.toString("utf8");
      }
    });
    child.on("error", () => {
      settle({ kind: "cli-unavailable" });
    });
    child.on("close", (code) => {
      if (timedOut || bytes > CLI_MAX_OUTPUT_BYTES || code === null) {
        settle({ kind: "cli-failed" });
        return;
      }
      settle({ kind: "ok", stdout, exitCode: code });
    });
  });
}

/**
 * Start the CLI and let go of it: the commands that end or replace this
 * very host must outlive the response that accepted them.
 */
async function spawnDetachedHostCli(
  runtime: HostRuntime,
  args: readonly string[],
): Promise<"accepted" | "cli-unavailable" | "cli-failed"> {
  const invocation = await readCliInvocation(runtime.dataDir);
  if (invocation === null) {
    return "cli-unavailable";
  }
  return new Promise((resolve) => {
    const child = spawn(invocation.command, [...invocation.args, ...args], {
      detached: true,
      stdio: "ignore",
    });
    child.once("spawn", () => {
      child.unref();
      resolve("accepted");
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code === "ENOENT" ? "cli-unavailable" : "cli-failed");
    });
  });
}

/**
 * The CLI's terminal `{"type":"result"}` line, which is the LAST such line:
 * progress records precede it (recorded live from `host available --json`).
 */
function lastResult(
  stdout: string,
):
  | { readonly status: "ok"; readonly data: unknown }
  | { readonly status: "error"; readonly message: string | null }
  | null {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .reverse();
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") {
      continue;
    }
    if (Reflect.get(parsed, "type") !== "result") {
      continue;
    }
    const status = Reflect.get(parsed, "status");
    if (status === "ok") {
      return { status: "ok", data: Reflect.get(parsed, "data") };
    }
    if (status === "error") {
      const error = Reflect.get(parsed, "error");
      const message =
        error !== null && typeof error === "object"
          ? Reflect.get(error, "message")
          : null;
      const trimmed = typeof message === "string" ? message.trim() : "";
      return { status: "error", message: trimmed.length > 0 ? trimmed : null };
    }
  }
  return null;
}

/** Bad output from a CLI that exited cleanly is `invalid-output`; otherwise it failed. */
function badOutput(exitCode: number): "invalid-output" | "cli-failed" {
  return exitCode === 0 ? "invalid-output" : "cli-failed";
}

export const handleHostServiceStatus: RpcHandler = async (_params, runtime) => {
  if (updatesExternallyManaged()) {
    return { ok: true, result: { outcome: "externally-managed" } };
  }
  const run = await runHostCli(runtime, [
    "host",
    "service",
    "status",
    "--json",
  ]);
  if (run.kind !== "ok") {
    return { ok: true, result: { outcome: run.kind } };
  }
  const result = lastResult(run.stdout);
  if (result === null || result.status !== "ok") {
    return {
      ok: true,
      result: {
        outcome:
          result?.status === "error" ? "cli-failed" : badOutput(run.exitCode),
      },
    };
  }
  const data = result.data;
  const state = hostServiceStateSchema.safeParse(
    data !== null && typeof data === "object"
      ? Reflect.get(data, "state")
      : null,
  );
  const label =
    data !== null && typeof data === "object"
      ? Reflect.get(data, "label")
      : null;
  const manifestPath =
    data !== null && typeof data === "object"
      ? Reflect.get(data, "manifestPath")
      : null;
  if (
    !state.success ||
    typeof label !== "string" ||
    typeof manifestPath !== "string"
  ) {
    return { ok: true, result: { outcome: badOutput(run.exitCode) } };
  }
  return {
    ok: true,
    result: { outcome: "ok", state: state.data, label, manifestPath },
  };
};

export const handleHostServiceRegister: RpcHandler = async (
  _params,
  runtime,
) => {
  if (updatesExternallyManaged()) {
    return { ok: true, result: { outcome: "externally-managed" } };
  }
  const run = await runHostCli(runtime, [
    "host",
    "service",
    "install",
    "--json",
  ]);
  if (run.kind !== "ok") {
    return {
      ok: true,
      result:
        run.kind === "cli-unavailable"
          ? { outcome: "cli-unavailable" }
          : { outcome: "cli-failed", message: null },
    };
  }
  const result = lastResult(run.stdout);
  if (result === null) {
    return {
      ok: true,
      result:
        run.exitCode === 0
          ? { outcome: "invalid-output" }
          : { outcome: "cli-failed", message: null },
    };
  }
  return {
    ok: true,
    result:
      result.status === "ok"
        ? { outcome: "ok" }
        : { outcome: "cli-failed", message: result.message },
  };
};

export const handleHostServiceDeregister: RpcHandler = async (
  _params,
  runtime,
) => {
  if (updatesExternallyManaged()) {
    return { ok: true, result: { outcome: "externally-managed" } };
  }
  // Detached: uninstalling the service ends this host, and the answer has
  // to be on the wire before that.
  const outcome = await spawnDetachedHostCli(runtime, [
    "host",
    "service",
    "uninstall",
  ]);
  return { ok: true, result: { outcome } };
};

export const handleHostUpdateCheck: RpcHandler = async (params, runtime) => {
  const parsed = hostUpdateCheckRequestSchemaV11.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  // `1.1` says where the pre-release choice came from; a `1.0` caller sent
  // an explicit boolean and reads only the manifest.
  const requested = parsed.data.includePreReleases;
  const installedRc = /-/u.test(runtime.hostVersion);
  const source: HostIncludePreReleasesSource =
    requested === true
      ? "explicit-include"
      : requested === false
        ? "explicit-exclude"
        : installedRc
          ? "installed-rc"
          : "stable-default";
  const include = requested ?? installedRc;
  const run = await runHostCli(runtime, [
    "host",
    "available",
    "--json",
    ...(include ? ["--include-pre-releases"] : []),
  ]);
  if (run.kind !== "ok") {
    return { ok: true, result: { outcome: run.kind } };
  }
  const result = lastResult(run.stdout);
  if (result === null || result.status !== "ok") {
    return {
      ok: true,
      result: {
        outcome:
          result?.status === "error" ? "cli-failed" : badOutput(run.exitCode),
      },
    };
  }
  const manifest = hostAvailableManifestSchema.safeParse(
    result.data !== null && typeof result.data === "object"
      ? Reflect.get(result.data, "manifest")
      : null,
  );
  if (!manifest.success) {
    return { ok: true, result: { outcome: badOutput(run.exitCode) } };
  }
  return {
    ok: true,
    result: {
      outcome: "ok",
      manifest: manifest.data,
      effectiveIncludePreReleases: include,
      includePreReleasesSource: source,
    },
  };
};

/** When an update this host accepted was started, by the process clock; null when none is running. */
let updateClaimedAt: number | null = null;

export const handleHostUpdateInstall: RpcHandler = async (params, runtime) => {
  const parsed = hostUpdateInstallRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  if (updatesExternallyManaged()) {
    return { ok: true, result: { outcome: "externally-managed" } };
  }
  const now = performance.now();
  if (updateClaimedAt !== null && now - updateClaimedAt < UPDATE_CLAIM_MS) {
    return {
      ok: true,
      result: { outcome: "already-updating", attemptId: null },
    };
  }
  updateClaimedAt = now;
  const outcome = await spawnDetachedHostCli(runtime, [
    "host",
    "update",
    "--version",
    parsed.data.version,
    ...(parsed.data.force ? ["--force"] : []),
  ]);
  if (outcome !== "accepted") {
    updateClaimedAt = null;
    return { ok: true, result: { outcome } };
  }
  return { ok: true, result: { outcome: "accepted", attemptId: null } };
};

/**
 * The staged (downloaded, not yet swapped in) host beside the install, if
 * any - its executable must live under the staging directory, as released.
 */
export async function readStagedRecord(dataDir: string): Promise<unknown> {
  const dir = join(dataDir, "staged");
  let raw: string;
  try {
    raw = await readFile(join(dir, "staged.json"), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = hostStagedRecordSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return null;
    }
    const executable = parsed.data.executablePath;
    if (executable.length === 0 || isAbsolute(executable)) {
      return null;
    }
    const rel = relative(dir, join(dir, executable));
    return rel.startsWith("..") || isAbsolute(rel) ? null : parsed.data;
  } catch {
    return null;
  }
}

/** The CLI's own install manifest, found beside the CLI that runs this host. */
export async function readCliManifest(dataDir: string): Promise<unknown> {
  const invocation = await readCliInvocation(dataDir);
  if (invocation === null || !isAbsolute(invocation.command)) {
    return null;
  }
  try {
    const raw = await readFile(
      join(dirname(dirname(invocation.command)), "manifest.json"),
      "utf8",
    );
    const parsed = storedCliInstallManifestSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
