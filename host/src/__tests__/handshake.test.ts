import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  CURRENT_CLIENT_COMPATIBILITY_EPOCH,
  SERVES_EVERY_INSTALLED_MAJOR,
  splitConnectionManifest,
} from "@traycer/protocol/framework/index";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { startHost, type StartedHost } from "../start-host";
import { HOST_VERSION } from "../version";

describe("host handshake", () => {
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

  it("rejects a client that omits compatibilityEpoch", async () => {
    started = await boot();
    const frames = await rpcSession(started.rpcUrl, [
      {
        kind: "open",
        token: "test-token",
        manifest: {},
      },
    ]);
    const fatal = frames[0] as { kind: string; details: { code: string } };
    expect(fatal.kind).toBe("fatalError");
    expect(fatal.details.code).toBe("INCOMPATIBLE");
  });

  it("acks a floor-compatible client and answers host.status", async () => {
    started = await boot();
    const clientManifests = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    const frames = await rpcSession(started.rpcUrl, [
      {
        kind: "open",
        token: "test-token",
        manifest: clientManifests.manifest,
        optionalManifest: clientManifests.optionalManifest,
        clientIdentity: {
          kind: "cli",
          compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
          appVersion: "0.1.0",
        },
      },
      {
        kind: "request",
        requestId: "status-1",
        method: "host.status",
        schemaVersion: { major: 1, minor: 3 },
        params: {},
      },
    ]);
    expect(frames[0]).toMatchObject({ kind: "openAck" });
    const ack = frames[0] as {
      manifest: Record<string, unknown>;
      optionalManifest: Record<string, unknown>;
    };
    expect(ack.manifest["host.status"]).toMatchObject({ major: 1, minor: 3 });
    expect(frames[1]).toMatchObject({
      kind: "response",
      requestId: "status-1",
      method: "host.status",
      error: null,
      result: {
        ready: true,
        hostVersion: HOST_VERSION,
        busy: false,
      },
    });
    const pidRaw = await readFile(
      join(started.runtime.dataDir, "pid.json"),
      "utf8",
    );
    const pid = parsePidFile(pidRaw);
    expect(pid.websocketUrl).toBe(started.rpcUrl);
    expect(pid.hostId).toBe(started.runtime.hostId);
  });

  it("accepts host.restart when idle and is idempotent on the same transitionId", async () => {
    started = await boot();
    let restarts = 0;
    started.runtime.requestShutdown = (intent) => {
      expect(intent).toBe("restart");
      restarts += 1;
    };
    const clientManifests = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    const open = {
      kind: "open",
      token: "test-token",
      manifest: clientManifests.manifest,
      optionalManifest: clientManifests.optionalManifest,
      clientIdentity: {
        kind: "cli",
        compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
        appVersion: "0.1.0",
      },
    };
    const first = await rpcSession(started.rpcUrl, [
      open,
      {
        kind: "request",
        requestId: "restart-1",
        method: "host.restart",
        schemaVersion: { major: 1, minor: 2 },
        params: { transitionId: "tr-1" },
      },
    ]);
    const second = await rpcSession(started.rpcUrl, [
      open,
      {
        kind: "request",
        requestId: "restart-2",
        method: "host.restart",
        schemaVersion: { major: 1, minor: 2 },
        params: { transitionId: "tr-1" },
      },
    ]);
    expect(first[1]).toMatchObject({
      kind: "response",
      requestId: "restart-1",
      result: { outcome: "accepted" },
    });
    expect(second[1]).toMatchObject({
      kind: "response",
      requestId: "restart-2",
      result: { outcome: "accepted" },
    });
    expect(restarts).toBe(1);
  });

  it("advertises analog stream lanes with snapshots", async () => {
    started = await boot();
    const clientStreamManifest = buildStreamManifest(
      hostStreamRpcRegistry,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    const socket = new WebSocket(streamUrl);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const ack = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        socket.once("message", (data) => {
          resolve(JSON.parse(String(data)) as Record<string, unknown>);
        });
        socket.once("error", reject);
        socket.send(
          JSON.stringify({
            kind: "open",
            token: "test-token",
            manifest: clientStreamManifest,
            clientIdentity: {
              kind: "cli",
              compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
              appVersion: "0.1.0",
            },
          }),
        );
      },
    );
    socket.close();
    expect(ack.kind).toBe("openAck");
    const advertised = ack.manifest as Record<string, unknown>;
    expect(advertised["chat.subscribe"]).toMatchObject({ major: 1, minor: 8 });
    expect(advertised["epic.subscribe"]).toMatchObject({ major: 1, minor: 3 });
    expect(advertised["agent.activity.subscribe"]).toMatchObject({
      major: 1,
      minor: 1,
    });
    expect(advertised["epic.status.subscribe"]).toMatchObject({
      major: 1,
      minor: 0,
    });
    expect(advertised["epic.state.subscribe"]).toMatchObject({
      major: 1,
      minor: 0,
    });
    expect(advertised["artifact.subscribe"]).toMatchObject({
      major: 1,
    });
  });

  async function boot(): Promise<StartedHost> {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    return startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
  }
});

async function rpcSession(
  url: string,
  outbound: readonly unknown[],
): Promise<unknown[]> {
  const socket = new WebSocket(url);
  const inbound: unknown[] = [];
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      resolve();
    });
    socket.once("error", reject);
  });
  const done = new Promise<void>((resolve, reject) => {
    socket.on("message", (data) => {
      inbound.push(JSON.parse(String(data)));
      if (inbound.length < outbound.length) {
        socket.send(JSON.stringify(outbound[inbound.length]));
      }
    });
    socket.once("close", () => {
      resolve();
    });
    socket.once("error", reject);
  });
  socket.send(JSON.stringify(outbound[0]));
  await done;
  return inbound;
}

function parsePidFile(raw: string): { websocketUrl: string; hostId: string } {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("pid.json is not an object");
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.websocketUrl !== "string" ||
    typeof record.hostId !== "string"
  ) {
    throw new Error("pid.json missing websocketUrl or hostId");
  }
  return { websocketUrl: record.websocketUrl, hostId: record.hostId };
}
