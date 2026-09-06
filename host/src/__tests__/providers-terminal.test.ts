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
import { providerIdSchema } from "@traycer/protocol/host/provider-ids";
import { startHost, type StartedHost } from "../start-host";

describe("providers and terminal", () => {
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

  it("lists every provider and probes a PATH binary", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    const listed = await call(
      started.rpcUrl,
      "providers.list",
      {
        major: 8,
        minor: 0,
      },
      {
        forceAuthRefresh: false,
        native: null,
      },
    );
    const record = listed as {
      providers: readonly {
        providerId: string;
        candidates: readonly unknown[];
      }[];
    };
    expect(record.providers.map((row) => row.providerId).sort()).toEqual(
      [...providerIdSchema.options].sort(),
    );
    const probed = await call(
      started.rpcUrl,
      "providers.detectVersion",
      {
        major: 1,
        minor: 0,
      },
      {
        candidatePath: "/usr/bin/git",
      },
    );
    expect(probed).toMatchObject({ executable: true });

    const disabled = await call(
      started.rpcUrl,
      "providers.setEnabled",
      {
        major: 2,
        minor: 1,
      },
      {
        providerId: "claude-code",
        enabled: false,
        profileAction: null,
      },
    );
    expect(disabled).toMatchObject({
      state: { providerId: "claude-code", enabled: false },
    });

    const keyed = await call(
      started.rpcUrl,
      "providers.setApiKey",
      {
        major: 2,
        minor: 1,
      },
      {
        providerId: "openrouter",
        apiKey: "sk-or-test",
      },
    );
    expect(keyed).toMatchObject({
      state: {
        providerId: "openrouter",
        apiKey: { supported: true, configured: true, source: "stored" },
        auth: { status: "authenticated" },
      },
    });
    const cleared = await call(
      started.rpcUrl,
      "providers.clearApiKey",
      {
        major: 2,
        minor: 1,
      },
      {
        providerId: "openrouter",
      },
    );
    expect(cleared).toMatchObject({
      state: {
        providerId: "openrouter",
        apiKey: { supported: true, configured: false, source: null },
      },
    });
  });

  it("spawns a PTY and answers terminal.subscribe with a snapshot", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    const created = await call(
      started.rpcUrl,
      "terminal.create",
      {
        major: 2,
        minor: 1,
      },
      {
        scope: { kind: "independent" },
        sessionKind: "terminal",
        tuiHarnessId: null,
        cwd: tempDir,
        shellCommand: "/bin/zsh",
        shellArgs: [],
        cols: 80,
        rows: 24,
        desiredSessionId: "term-1",
        worktreeBusyPaths: [],
        themeHint: null,
      },
    );
    expect(created).toMatchObject({
      session: { sessionId: "term-1", status: "running" },
    });
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    const snapshot = await subscribeTerminal(streamUrl, "term-1");
    expect(snapshot).toMatchObject({
      kind: "snapshot",
      sessionId: "term-1",
      session: { sessionId: "term-1" },
    });
    const killed = await call(
      started.rpcUrl,
      "terminal.kill",
      {
        major: 1,
        minor: 0,
      },
      {
        sessionId: "term-1",
      },
    );
    expect(killed).toMatchObject({ killed: true });
  });
});

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
  if (record.error !== null) {
    throw new Error(`RPC error: ${JSON.stringify(record.error)}`);
  }
  return record.result;
}

async function subscribeTerminal(
  url: string,
  sessionId: string,
): Promise<unknown> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const frames: unknown[] = [];
  const done = new Promise<void>((resolve, reject) => {
    socket.on("message", (data) => {
      const parsed: unknown = JSON.parse(String(data));
      frames.push(parsed);
      if (frames.length === 1) {
        socket.send(
          JSON.stringify({
            kind: "subscribe",
            method: "terminal.subscribe",
            schemaVersion: { major: 1, minor: 6 },
            params: { sessionId, cols: 80, rows: 24, viewer: "presentation" },
          }),
        );
        return;
      }
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "kind" in parsed &&
        parsed.kind === "snapshot"
      ) {
        socket.close();
      }
    });
    socket.once("close", () => resolve());
    socket.once("error", reject);
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
  await done;
  const snapshot = frames.find(
    (frame) =>
      frame !== null &&
      typeof frame === "object" &&
      "kind" in frame &&
      frame.kind === "snapshot",
  );
  if (snapshot === undefined) {
    throw new Error(`expected snapshot, got ${JSON.stringify(frames)}`);
  }
  return snapshot;
}
