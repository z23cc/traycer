import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  handleHostServiceDeregister,
  handleHostServiceRegister,
  handleHostServiceStatus,
  handleHostUpdateCheck,
  handleHostUpdateInstall,
} from "../rpc/handlers/maintenance-handlers";
import { startHost, type StartedHost } from "../start-host";

/**
 * The host's service, updates, and installation, answered by running its
 * own CLI as released. The CLI is played by `sh`: the recorded invocation's
 * vector prints a fixed stdout and exits with a fixed code, whatever the
 * handler appends.
 */
describe("host maintenance", () => {
  let started: StartedHost | null = null;
  let tempDir: string | null = null;
  const envBefore = process.env.TRAYCER_HOST_UPDATES;

  afterEach(async () => {
    if (envBefore === undefined) {
      delete process.env.TRAYCER_HOST_UPDATES;
    } else {
      process.env.TRAYCER_HOST_UPDATES = envBefore;
    }
    if (started !== null) {
      await started.close();
      started = null;
    }
    if (tempDir !== null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  /** Recorded from `traycer host service status --json` on the dev slot. */
  const statusLine =
    '{"type":"result","status":"ok","data":{"label":"ai.traycer.host.dev.traycer-714e61fd","environment":"dev","displayName":"Traycer Host (Dev traycer-714e61fd)","manifestPath":"/Users/x/Library/LaunchAgents/ai.traycer.host.dev.traycer-714e61fd.plist","state":"running","pid":20419,"listenUrl":"ws://127.0.0.1:50037/rpc","version":"1.2.0"},"timestamp":"2026-09-07T16:20:27.079Z"}';

  it("relays the CLI's service status, reading its last result line", async () => {
    const booted = await boot();
    started = booted.started;
    tempDir = booted.tempDir;
    // A progress line precedes the result, as `host available --json` does.
    await recordCli(
      tempDir,
      `${'{"type":"progress","stage":"x","message":"working"}'}\n${statusLine}\n`,
      0,
    );
    expect(await result(handleHostServiceStatus, started, {})).toEqual({
      outcome: "ok",
      state: "running",
      label: "ai.traycer.host.dev.traycer-714e61fd",
      manifestPath:
        "/Users/x/Library/LaunchAgents/ai.traycer.host.dev.traycer-714e61fd.plist",
    });
  });

  it("says what went wrong with the CLI, in the released words", async () => {
    const booted = await boot();
    started = booted.started;
    tempDir = booted.tempDir;
    // Nothing recorded: no CLI to run.
    expect(await result(handleHostServiceStatus, started, {})).toEqual({
      outcome: "cli-unavailable",
    });
    // Clean exit, no result line: the output is what is wrong.
    await recordCli(tempDir, "not json\n", 0);
    expect(await result(handleHostServiceStatus, started, {})).toEqual({
      outcome: "invalid-output",
    });
    // Non-zero exit with no result line: the CLI is.
    await recordCli(tempDir, "boom\n", 3);
    expect(await result(handleHostServiceStatus, started, {})).toEqual({
      outcome: "cli-failed",
    });
    // An error result carries its message on register.
    await recordCli(
      tempDir,
      '{"type":"result","status":"error","error":{"message":"launchd said no"}}\n',
      1,
    );
    expect(await result(handleHostServiceRegister, started, {})).toEqual({
      outcome: "cli-failed",
      message: "launchd said no",
    });
    await recordCli(tempDir, '{"type":"result","status":"ok","data":{}}\n', 0);
    expect(await result(handleHostServiceRegister, started, {})).toEqual({
      outcome: "ok",
    });
    // Uninstall is started and let go of; the answer precedes its effect.
    expect(await result(handleHostServiceDeregister, started, {})).toEqual({
      outcome: "accepted",
    });
  });

  it("leaves an externally managed host to its manager", async () => {
    const booted = await boot();
    started = booted.started;
    tempDir = booted.tempDir;
    await recordCli(tempDir, `${statusLine}\n`, 0);
    process.env.TRAYCER_HOST_UPDATES = "external";
    expect(await result(handleHostServiceStatus, started, {})).toEqual({
      outcome: "externally-managed",
    });
    expect(await result(handleHostServiceRegister, started, {})).toEqual({
      outcome: "externally-managed",
    });
    expect(await result(handleHostServiceDeregister, started, {})).toEqual({
      outcome: "externally-managed",
    });
    expect(
      await result(handleHostUpdateInstall, started, {
        version: "1.2.1",
        force: false,
      }),
    ).toEqual({ outcome: "externally-managed" });
  });

  it("checks for updates through the CLI and says where the pre-release choice came from", async () => {
    const booted = await boot();
    started = booted.started;
    tempDir = booted.tempDir;
    const manifest = {
      schemaVersion: 1,
      generatedAt: "2026-09-05T23:28:12.631Z",
      latest: "1.2.0",
      versions: [
        {
          version: "1.2.0",
          releasedAt: "2026-08-24T13:39:01.452Z",
          releaseNotesUrl: "https://example.test/notes",
          yanked: false,
          deprecationReason: null,
          requiredCliVersion: "1.2.0-rc.1",
          platforms: {},
        },
      ],
    };
    await recordCli(
      tempDir,
      `${'{"type":"progress","stage":"registry-manifest-attempt","message":"fetching manifest (attempt 1/4)"}'}\n${JSON.stringify({ type: "result", status: "ok", data: { manifest } })}\n`,
      0,
    );
    expect(await result(handleHostUpdateCheck, started, {})).toEqual({
      outcome: "ok",
      manifest,
      effectiveIncludePreReleases: false,
      includePreReleasesSource: "stable-default",
    });
    expect(
      await result(handleHostUpdateCheck, started, {
        includePreReleases: true,
      }),
    ).toMatchObject({
      outcome: "ok",
      effectiveIncludePreReleases: true,
      includePreReleasesSource: "explicit-include",
    });
  });

  it("accepts one update at a time", async () => {
    const booted = await boot();
    started = booted.started;
    tempDir = booted.tempDir;
    await recordCli(tempDir, "", 0);
    expect(
      await result(handleHostUpdateInstall, started, {
        version: "1.2.1",
        force: true,
      }),
    ).toEqual({ outcome: "accepted", attemptId: null });
    expect(
      await result(handleHostUpdateInstall, started, {
        version: "1.2.1",
        force: false,
      }),
    ).toEqual({ outcome: "already-updating", attemptId: null });
  });
});

async function result(
  handler: (params: unknown, runtime: StartedHost["runtime"]) => unknown,
  host: StartedHost,
  params: unknown,
): Promise<unknown> {
  const outcome: unknown = await handler(params, host.runtime);
  if (outcome === null || typeof outcome !== "object") {
    throw new Error("handler returned nothing");
  }
  if (Reflect.get(outcome, "ok") !== true) {
    throw new Error(String(Reflect.get(outcome, "message")));
  }
  return Reflect.get(outcome, "result");
}

/** A CLI vector this host may spawn: prints `output`, exits `code`, ignores its arguments. */
async function recordCli(
  dataDir: string,
  output: string,
  code: number,
): Promise<void> {
  const dir = join(dataDir, "cli-invocation");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "cli-invocation.json"),
    JSON.stringify({
      schemaVersion: 1,
      command: "/bin/sh",
      args: ["-c", 'printf %s "$1"; exit "$2"', "sh", output, String(code)],
      source: {
        kind: "service-registration",
        platform: "macos",
        serviceLabel: "test",
      },
      recoveredAt: new Date().toISOString(),
    }),
  );
}

async function boot(): Promise<{
  readonly tempDir: string;
  readonly started: StartedHost;
}> {
  const dir = await mkdtemp(join(tmpdir(), "traycer-host-"));
  return {
    tempDir: dir,
    started: await startHost({
      argv: ["--host-data-dir", dir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    }),
  };
}
