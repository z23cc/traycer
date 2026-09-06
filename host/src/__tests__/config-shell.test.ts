import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  CURRENT_CLIENT_COMPATIBILITY_EPOCH,
  SERVES_EVERY_INSTALLED_MAJOR,
  splitConnectionManifest,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { configShellGetResponseSchema } from "@traycer/protocol/host/config/schemas";
import { startHost, type StartedHost } from "../start-host";

const V10 = { major: 1, minor: 0 };

describe("config.shell", () => {
  let started: StartedHost | null = null;
  let tempDir: string | null = null;
  let previousHome: string | undefined;

  afterEach(async () => {
    if (started !== null) {
      await started.close();
      started = null;
    }
    if (previousHome !== undefined) {
      process.env.HOME = previousHome;
      previousHome = undefined;
    }
    if (tempDir !== null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("persists a selected shell to the shared CLI config store", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    // The store is `~/.traycer/cli/config.json`; a temp HOME keeps this test
    // off the developer's real one.
    previousHome = process.env.HOME;
    process.env.HOME = tempDir;
    started = await startHost({
      argv: ["--host-data-dir", join(tempDir, "slot")],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });

    const initial = configShellGetResponseSchema.parse(
      await call(started.rpcUrl, "config.shell.get", V10, {}),
    );
    expect(initial.synthesised).toBe(true);

    expect(
      await call(started.rpcUrl, "config.shell.set", V10, {
        path: "/bin/sh",
        args: ["-l"],
      }),
    ).toEqual({ path: "/bin/sh", args: ["-l"] });

    const selected = configShellGetResponseSchema.parse(
      await call(started.rpcUrl, "config.shell.get", V10, {}),
    );
    expect(selected).toEqual({
      path: "/bin/sh",
      args: ["-l"],
      synthesised: false,
    });

    // A remembered shell shows up in the picker beside the detected ones.
    await call(started.rpcUrl, "config.shell.add", V10, { path: "/bin/sh" });
    const listed = await call(
      started.rpcUrl,
      "config.shell.listDetected",
      V10,
      {},
    );
    expect(readShellPaths(listed)).toContain("/bin/sh");

    expect(
      await call(started.rpcUrl, "config.shell.revertArgs", V10, {
        path: "/bin/sh",
      }),
    ).toEqual({ path: "/bin/sh", reverted: true });

    expect(
      await call(started.rpcUrl, "config.shell.remove", V10, {
        path: "/bin/sh",
      }),
    ).toEqual({ removed: true, path: null });

    await call(started.rpcUrl, "config.shell.set", V10, {
      path: "/bin/sh",
      args: null,
    });
    await call(started.rpcUrl, "config.shell.reset", V10, {});
    expect(
      configShellGetResponseSchema.parse(
        await call(started.rpcUrl, "config.shell.get", V10, {}),
      ).synthesised,
    ).toBe(true);

    // Env overrides live in the same store and reach the PTY environment.
    await call(started.rpcUrl, "config.env.set", V10, {
      key: "TRAYCER_TEST_VAR",
      value: "on",
    });
    expect(await call(started.rpcUrl, "config.env.list", V10, {})).toEqual({
      entries: [{ key: "TRAYCER_TEST_VAR", value: "on" }],
    });
    expect(
      await call(started.rpcUrl, "config.env.delete", V10, {
        key: "TRAYCER_TEST_VAR",
      }),
    ).toEqual({ key: "TRAYCER_TEST_VAR", deleted: true });

    // The setting is what a terminal spawns, not `$SHELL`.
    await call(started.rpcUrl, "config.shell.set", V10, {
      path: "/bin/sh",
      args: ["-l"],
    });
    await call(
      started.rpcUrl,
      "terminal.create",
      { major: 2, minor: 1 },
      {
        desiredSessionId: "session-1",
        scope: { kind: "independent" },
        sessionKind: "terminal",
        cwd: tempDir,
        cols: 80,
        rows: 24,
        shellCommand: null,
        shellArgs: null,
        worktreeBusyPaths: [],
      },
    );
    expect(started.runtime.terminals.get("session-1")).toMatchObject({
      shellCommand: "/bin/sh",
      shellArgs: ["-l"],
    });
  });
});

function readShellPaths(result: unknown): readonly string[] {
  if (result === null || typeof result !== "object") {
    return [];
  }
  const shells = Reflect.get(result, "shells");
  if (!Array.isArray(shells)) {
    return [];
  }
  return shells.map((shell: unknown) => {
    const path = shell === null ? null : Reflect.get(Object(shell), "path");
    return typeof path === "string" ? path : "";
  });
}

async function call(
  url: string,
  method: string,
  schemaVersion: { major: number; minor: number },
  params: unknown,
): Promise<unknown> {
  const clientManifests = splitConnectionManifest(
    hostRpcRegistry,
    RELEASED_FLOOR_METHOD_NAMES,
    SERVES_EVERY_INSTALLED_MAJOR,
  );
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const frames: unknown[] = [];
  const done = new Promise<void>((resolve, reject) => {
    socket.on("message", (data) => {
      frames.push(JSON.parse(String(data)));
      if (frames.length === 1) {
        socket.send(
          JSON.stringify({
            kind: "request",
            requestId: "1",
            method,
            schemaVersion,
            params,
          }),
        );
      }
    });
    socket.once("close", () => resolve());
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      kind: "open",
      token: "test-token",
      manifest: clientManifests.manifest,
      optionalManifest: clientManifests.optionalManifest,
      clientIdentity: {
        kind: "cli",
        compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
        appVersion: "0.1.0",
      },
    }),
  );
  await done;
  const response = frames[1];
  if (
    response === null ||
    typeof response !== "object" ||
    !("kind" in response) ||
    response.kind !== "response"
  ) {
    throw new Error(`expected response, got ${JSON.stringify(response)}`);
  }
  const record = response as Record<string, unknown>;
  if (record.error !== null && record.error !== undefined) {
    throw new Error(`RPC error: ${JSON.stringify(record.error)}`);
  }
  return record.result;
}
