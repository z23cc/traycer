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
import { hostUsageSummaryResponseSchemaV10 } from "@traycer/protocol/host/usage-analytics/schemas";
import { startHost, type StartedHost } from "../start-host";

const MS_PER_DAY = 86_400_000;

describe("host.usage.summary", () => {
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

  it("returns an empty local analog that the GUI schema accepts", async () => {
    const setup = await boot();
    tempDir = setup.tempDir;
    started = setup.started;
    const before = Date.now();
    const result = await call(
      started.rpcUrl,
      "host.usage.summary",
      { major: 1, minor: 0 },
      {
        timezone: "UTC",
        windowDays: 7,
        epicId: null,
      },
    );
    const after = Date.now();
    const parsed = hostUsageSummaryResponseSchemaV10.safeParse(result);
    expect(parsed.success).toBe(true);
    expect(result).toMatchObject({
      servedBy: "local",
      summary: {
        epicId: null,
        chatId: null,
        turnRows: null,
        turnRowsTruncated: false,
        totals: { factCount: 0, knownCostUsd: 0 },
        buckets: [],
        chatBuckets: [],
        hostBuckets: [],
      },
    });
    const record = result as {
      summary: {
        window: { startAtInclusive: number; endAtExclusive: number };
      };
    };
    expect(record.summary.window.endAtExclusive).toBeGreaterThanOrEqual(before);
    expect(record.summary.window.endAtExclusive).toBeLessThanOrEqual(after);
    expect(
      record.summary.window.endAtExclusive -
        record.summary.window.startAtInclusive,
    ).toBe(7 * MS_PER_DAY);
  });

  it("echoes a chat filter as empty turnRows instead of null", async () => {
    const setup = await boot();
    tempDir = setup.tempDir;
    started = setup.started;
    const result = await call(
      started.rpcUrl,
      "host.usage.summary",
      { major: 1, minor: 0 },
      {
        timezone: "America/Los_Angeles",
        windowDays: 30,
        epicId: "epic-1",
        chatId: "chat-1",
      },
    );
    expect(result).toMatchObject({
      servedBy: "local",
      summary: {
        epicId: "epic-1",
        chatId: "chat-1",
        turnRows: [],
        turnRowsTruncated: false,
      },
    });
    expect(hostUsageSummaryResponseSchemaV10.safeParse(result).success).toBe(
      true,
    );
  });

  it("bounds an epic window to the local epic createdAt", async () => {
    const setup = await boot();
    tempDir = setup.tempDir;
    started = setup.started;
    const before = Date.now();
    await call(
      started.rpcUrl,
      "phase.migrateToEpic",
      { major: 1, minor: 0 },
      { phaseId: "phase-1" },
    );
    const result = await call(
      started.rpcUrl,
      "host.usage.summary",
      { major: 1, minor: 0 },
      {
        timezone: "UTC",
        windowDays: 7,
        epicId: "phase-1",
        window: "epic",
      },
    );
    const record = result as {
      summary: {
        window: { startAtInclusive: number; endAtExclusive: number };
        epicId: string;
      };
    };
    expect(record.summary.epicId).toBe("phase-1");
    expect(record.summary.window.startAtInclusive).toBeGreaterThanOrEqual(
      before,
    );
    expect(
      record.summary.window.endAtExclusive -
        record.summary.window.startAtInclusive,
    ).toBeLessThan(60_000);
    expect(hostUsageSummaryResponseSchemaV10.safeParse(result).success).toBe(
      true,
    );
  });

  it("rejects a malformed request without the unimplemented stub", async () => {
    const setup = await boot();
    tempDir = setup.tempDir;
    started = setup.started;
    const frame = await rpcExchange(
      started.rpcUrl,
      "host.usage.summary",
      { major: 1, minor: 0 },
      {},
    );
    expect(frame.error).toMatchObject({ code: "RPC_ERROR" });
    const message =
      frame.error !== null &&
      typeof frame.error === "object" &&
      "message" in frame.error
        ? String(frame.error.message)
        : "";
    expect(message).not.toContain("is not implemented by this OSS host");
  });
});

async function boot(): Promise<{
  readonly started: StartedHost;
  readonly tempDir: string;
}> {
  const tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
  const started = await startHost({
    argv: ["--host-data-dir", tempDir],
    listenHost: "127.0.0.1",
    listenPort: 0,
  });
  return { started, tempDir };
}

async function call(
  url: string,
  method: string,
  schemaVersion: { major: number; minor: number },
  params: unknown,
): Promise<unknown> {
  const frame = await rpcExchange(url, method, schemaVersion, params);
  if (frame.error !== null) {
    throw new Error(`RPC error: ${JSON.stringify(frame.error)}`);
  }
  return frame.result;
}

async function rpcExchange(
  url: string,
  method: string,
  schemaVersion: { major: number; minor: number },
  params: unknown,
): Promise<{ result: unknown; error: unknown }> {
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
  return { result: record.result, error: record.error };
}
