import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliInvocationRecordOwnedTransactionBasename } from "@traycer/protocol/config/cli-invocation-record";
import {
  handleDiagnosticsLogsList,
  handleDiagnosticsLogsTail,
  handleHostDoctor,
} from "../rpc/handlers/diagnostics-handlers";
import { startHost, type StartedHost } from "../start-host";

describe("diagnostics", () => {
  let started: StartedHost | null = null;
  let tempDir: string | null = null;

  afterEach(async () => {
    if (started !== null) {
      await started.close();
      started = null;
    }
    if (tempDir !== null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("lists both host-owned logs by their real paths", async () => {
    const setup = await boot();
    tempDir = setup.tempDir;
    started = setup.started;
    const result = await handleDiagnosticsLogsList({}, started.runtime);
    if (!result.ok) {
      throw new Error(result.message);
    }
    const logs = (result.result as { logs: { target: string; path: string }[] })
      .logs;
    expect(logs.map((row) => row.target)).toEqual(["host", "cli"]);
    expect(logs[0].path).toBe(join(started.runtime.dataDir, "host.log"));
  });

  it("tails the host log and clamps the window", async () => {
    const setup = await boot();
    tempDir = setup.tempDir;
    started = setup.started;
    const lines = Array.from({ length: 12 }, (_, i) => `line ${String(i)}`);
    await writeFile(
      join(started.runtime.dataDir, "host.log"),
      `${lines.join("\n")}\n`,
    );
    const tail = await handleDiagnosticsLogsTail(
      { target: "host", tailLines: 3 },
      started.runtime,
    );
    if (!tail.ok) {
      throw new Error(tail.message);
    }
    expect(tail.result).toMatchObject({
      status: "available",
      target: "host",
      lines: ["line 9", "line 10", "line 11"],
      truncated: true,
    });
    // A request past the 500-line ceiling reads the whole file, not an error.
    const all = await handleDiagnosticsLogsTail(
      { target: "host", tailLines: 100_000 },
      started.runtime,
    );
    if (!all.ok) {
      throw new Error(all.message);
    }
    expect(all.result).toMatchObject({ truncated: false });
  });

  it("reports an unwritten host log as an empty tail, never as missing", async () => {
    const setup = await boot();
    tempDir = setup.tempDir;
    started = setup.started;
    const tail = await handleDiagnosticsLogsTail(
      { target: "host", tailLines: 10 },
      started.runtime,
    );
    if (!tail.ok) {
      throw new Error(tail.message);
    }
    expect(tail.result).toMatchObject({ status: "available", lines: [] });
  });

  it("answers cli-unavailable when no invocation vector is recorded", async () => {
    const setup = await boot();
    tempDir = setup.tempDir;
    started = setup.started;
    const doctor = await handleHostDoctor({}, started.runtime);
    if (!doctor.ok) {
      throw new Error(doctor.message);
    }
    expect(doctor.result).toEqual({ status: "cli-unavailable" });
  });

  it("ignores a recorded vector while the CLI holds a transaction marker", async () => {
    const setup = await boot();
    tempDir = setup.tempDir;
    started = setup.started;
    const dir = join(started.runtime.dataDir, "cli-invocation");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "cli-invocation.json"),
      JSON.stringify({
        schemaVersion: 1,
        command: "/bin/echo",
        args: [],
        source: {
          kind: "service-registration",
          platform: "macos",
          serviceLabel: "test",
        },
        recoveredAt: new Date().toISOString(),
      }),
    );
    await writeFile(
      join(
        dir,
        cliInvocationRecordOwnedTransactionBasename(
          "0f2b8c1a-4d5e-4f60-8a1b-2c3d4e5f6071",
        ),
      ),
      "{}",
    );
    const doctor = await handleHostDoctor({}, started.runtime);
    if (!doctor.ok) {
      throw new Error(doctor.message);
    }
    expect(doctor.result).toEqual({ status: "cli-unavailable" });
  });
});

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
