import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { hostStopIntentPath } from "@traycer/protocol/config/host-stop-intent";
import {
  RESTART_EXIT_CODE,
  exitCodeForShutdownIntent,
  hasExternalRestartIntent,
  restartTombstone,
} from "../lifecycle/shutdown";
import { startHost, type StartedHost } from "../start-host";

/**
 * The host's own lifecycle, aligned with the released host: what it exits
 * with, what it tells its clients first, and what it refuses while busy.
 */
describe("host lifecycle", () => {
  let tempDir: string | null = null;
  let started: StartedHost | null = null;

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

  it("exits 87 for a restart and 0 for a shutdown, as the launchd agent expects", () => {
    // `KeepAlive.SuccessfulExit = false`: only a non-zero exit is started again.
    expect(exitCodeForShutdownIntent("restart")).toBe(RESTART_EXIT_CODE);
    expect(RESTART_EXIT_CODE).toBe(87);
    expect(exitCodeForShutdownIntent("shutdown")).toBe(0);
  });

  it("reads a fresh CLI stop-intent naming a restart, and nothing else", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-lifecycle-"));
    const now = Date.now();
    expect(await hasExternalRestartIntent(tempDir, now)).toBe(false);
    const write = (reason: string, requestedAt: number) =>
      writeFile(
        hostStopIntentPath(tempDir ?? ""),
        JSON.stringify({
          v: 1,
          requestedAt: new Date(requestedAt).toISOString(),
          requestedByPid: 1,
          reason,
        }),
      );
    await write("restart", now);
    expect(await hasExternalRestartIntent(tempDir, now)).toBe(true);
    await write("stop", now);
    expect(await hasExternalRestartIntent(tempDir, now)).toBe(false);
    // Older than the released 30 s window is some earlier transition's.
    await write("restart", now - 31_000);
    expect(await hasExternalRestartIntent(tempDir, now)).toBe(false);
  });

  it("tells every stream client it is restarting before it goes", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-lifecycle-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    const socket = new WebSocket(started.rpcUrl.replace(/\/rpc$/u, "/stream"));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const frames: unknown[] = [];
    const closed = new Promise<void>((resolve) => {
      socket.on("message", (data) => {
        frames.push(JSON.parse(String(data)));
      });
      socket.once("close", () => resolve());
    });
    socket.send(
      JSON.stringify({
        kind: "open",
        token: "test-token",
        manifest: {},
        clientIdentity: {
          kind: "cli",
          compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
          appVersion: "0.1.0",
        },
      }),
    );
    // The ack first, so the announcement lands on an authenticated client.
    await new Promise<void>((resolve) => {
      const poll = (): void => {
        if (frames.length > 0) {
          resolve();
          return;
        }
        setTimeout(poll, 20);
      };
      poll();
    });
    started.runtime.requestShutdown("restart");
    await closed;
    const tombstone = frames.find(
      (frame) => Reflect.get(frame ?? {}, "kind") === "fatalError",
    );
    expect(tombstone).toMatchObject({
      kind: "fatalError",
      details: {
        code: "HOST_RESTARTING",
        reason: "The host is restarting and expects to be back shortly",
        retryable: true,
        restartIntent: { tombstoneId: expect.any(String) },
      },
    });
    const details = restartTombstone(1_000);
    expect(details.restartIntent?.expiresAt).toBe(61_000);
    // Torn down by the shutdown itself; the hook's second close is a no-op.
    started = null;
  });

  it("refuses a shutdown claim while work runs, and a restart while a claim is held", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-lifecycle-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    const shutdowns: string[] = [];
    started.runtime.requestShutdown = (intent) => {
      shutdowns.push(intent);
    };
    const rpcUrl = started.rpcUrl;
    const clientManifests = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    const call = async (
      method: string,
      minor: number,
      params: unknown,
    ): Promise<unknown> => {
      const socket = new WebSocket(rpcUrl);
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", reject);
      });
      return new Promise<unknown>((resolve, reject) => {
        let n = 0;
        socket.on("message", (data) => {
          const frame: unknown = JSON.parse(String(data));
          n += 1;
          if (n === 1) {
            socket.send(
              JSON.stringify({
                kind: "request",
                requestId: "1",
                method,
                schemaVersion: { major: 1, minor },
                params,
              }),
            );
            return;
          }
          socket.close();
          resolve(Reflect.get(frame ?? {}, "result"));
        });
        socket.once("error", reject);
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
      });
    };
    // A turn in flight is busy, to a claim and to a restart alike.
    started.runtime.guiRuns.beginPrint("chat-busy", {
      harnessId: "claude",
      model: "default",
      userMessageId: null,
      assistantMessageId: "a",
      turnId: "turn:busy",
      resumed: false,
      startedAt: Date.now(),
    });
    expect(
      await call("lifecycle.claimShutdown", 1, {
        transitionId: "tr-a",
        ttl: 5_000,
        intent: "shutdown",
      }),
    ).toEqual({ denied: "busy" });
    expect(
      await call("host.restart", 2, { transitionId: "tr-b" }),
    ).toMatchObject({ outcome: "busy", verdict: { busySessionCount: 1 } });
    started.runtime.guiRuns.endPrint("chat-busy", "a");
    // Idle: a claim is granted, and while it is held a restart is busy -
    // two coordinators do not race one host. Released, it runs.
    const granted = await call("lifecycle.claimShutdown", 1, {
      transitionId: "tr-a",
      ttl: 5_000,
      intent: "shutdown",
    });
    expect(granted).toMatchObject({ granted: { token: expect.any(String) } });
    expect(
      await call("host.restart", 2, { transitionId: "tr-b" }),
    ).toMatchObject({ outcome: "busy" });
    const token = String(
      Reflect.get(Reflect.get(granted ?? {}, "granted") ?? {}, "token"),
    );
    expect(await call("lifecycle.releaseShutdown", 0, { token })).toEqual({
      released: true,
    });
    expect(await call("host.restart", 2, { transitionId: "tr-b" })).toEqual({
      outcome: "accepted",
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(shutdowns).toEqual(["restart"]);
    // A committed claim shuts down with the intent it was taken under.
    const again = await call("lifecycle.claimShutdown", 1, {
      transitionId: "tr-c",
      ttl: 5_000,
      intent: "shutdown",
    });
    const token2 = String(
      Reflect.get(Reflect.get(again ?? {}, "granted") ?? {}, "token"),
    );
    expect(
      await call("lifecycle.commitShutdown", 0, { token: token2 }),
    ).toEqual({ committed: true });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(shutdowns).toEqual(["restart", "shutdown"]);
  });
});
