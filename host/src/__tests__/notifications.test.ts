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
import {
  hostNotificationsConfigResponseSchema,
  hostNotificationsListResponseSchemaV22,
} from "@traycer/protocol/host/notifications/host-notifications";
import { notify } from "../gui/notifications";
import { startHost, type StartedHost } from "../start-host";

describe("host.notifications", () => {
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

  it("lists, marks read, and clears rows the host itself recorded", async () => {
    const setup = await boot();
    tempDir = setup.tempDir;
    started = setup.started;
    await notify(started.runtime, {
      id: "agent.stopped:turn-1",
      kind: "agent.stopped",
      epicId: "epic-1",
      chatId: "chat-1",
      severity: "failure",
      outcome: "errored",
      sourceRef: "turn-1",
      message: "provider exited",
    });

    const recent = await call(
      started.rpcUrl,
      "host.notifications.list",
      { major: 2, minor: 2 },
      { filter: "recent", limit: 50 },
    );
    const parsed = hostNotificationsListResponseSchemaV22.parse(recent);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toMatchObject({
      id: "agent.stopped:turn-1",
      kind: "agent.stopped",
      severity: "failure",
      epicId: "epic-1",
      chatId: "chat-1",
      readAt: null,
    });
    expect(parsed.nextCursor).toBeNull();

    // The v1 major keeps its own filter vocabulary; dispatch never upgrades a
    // request before the handler sees it.
    const legacy = await call(
      started.rpcUrl,
      "host.notifications.list",
      { major: 1, minor: 0 },
      { filter: "unread", limit: 10 },
    );
    expect(readEntryIds(legacy)).toEqual(["agent.stopped:turn-1"]);

    const before = await call(
      started.rpcUrl,
      "host.notifications.indicatorState",
      { major: 1, minor: 1 },
      { epicIds: ["epic-1"], chatIds: ["chat-1"] },
    );
    expect(before).toMatchObject({
      chats: { "chat-1": { unreadFailure: true, pendingFork: false } },
      epics: { "epic-1": { unreadFailure: false } },
    });

    await call(
      started.rpcUrl,
      "host.notifications.markRead",
      { major: 1, minor: 0 },
      { kind: "ids", ids: ["agent.stopped:turn-1"] },
    );
    const after = await call(
      started.rpcUrl,
      "host.notifications.indicatorState",
      { major: 1, minor: 1 },
      { epicIds: ["epic-1"], chatIds: ["chat-1"] },
    );
    expect(after).toMatchObject({
      chats: { "chat-1": { unreadFailure: false } },
    });
    expect(
      await call(
        started.rpcUrl,
        "host.notifications.list",
        { major: 2, minor: 2 },
        { filter: "unreadRecent", limit: 50 },
      ),
    ).toMatchObject({ entries: [] });

    await call(
      started.rpcUrl,
      "host.notifications.clearAll",
      { major: 1, minor: 0 },
      { beforeUpdatedAt: Date.now() },
    );
    expect(
      readEntryIds(
        await call(
          started.rpcUrl,
          "host.notifications.list",
          { major: 2, minor: 2 },
          { filter: "recent", limit: 50 },
        ),
      ),
    ).toEqual([]);
  });

  it("keeps a dismissed prompt out of attention and persists the config", async () => {
    const setup = await boot();
    tempDir = setup.tempDir;
    started = setup.started;
    await notify(started.runtime, {
      id: "approval.requested:chat-1",
      kind: "approval.requested",
      epicId: "epic-1",
      chatId: "chat-1",
      severity: "needs_action",
      outcome: null,
      sourceRef: "approval-1",
      message: "may I run rm?",
    });
    const attention = await call(
      started.rpcUrl,
      "host.notifications.list",
      { major: 2, minor: 2 },
      { filter: "attention", limit: 50 },
    );
    expect(readEntryIds(attention)).toEqual(["approval.requested:chat-1"]);
    const occurrence =
      hostNotificationsListResponseSchemaV22.parse(attention).entries[0];
    expect(occurrence).toBeDefined();

    // A stale occurrence token must not resolve a row that has moved on.
    await call(
      started.rpcUrl,
      "host.notifications.resolve",
      { major: 1, minor: 0 },
      {
        occurrences: [
          { id: "approval.requested:chat-1", updatedAt: 1, sourceRef: null },
        ],
      },
    );
    expect(readEntryIds(await listAttention(started.rpcUrl))).toEqual([
      "approval.requested:chat-1",
    ]);

    await call(
      started.rpcUrl,
      "host.notifications.resolve",
      { major: 1, minor: 0 },
      {
        occurrences: [
          {
            id: "approval.requested:chat-1",
            updatedAt: occurrence?.updatedAt ?? 0,
            sourceRef: "approval-1",
          },
        ],
      },
    );
    expect(readEntryIds(await listAttention(started.rpcUrl))).toEqual([]);

    const stored = await call(
      started.rpcUrl,
      "host.notifications.setConfig",
      { major: 1, minor: 0 },
      {
        matrix: {
          info: { renderer: false, email: false },
          needs_action: { renderer: true, email: false },
          failure: { renderer: false, email: false },
          done: { renderer: true, email: false },
        },
        channels: {
          renderer: {},
          email: {
            host: "smtp.example.dev",
            port: 587,
            user: "me",
            from: "me@example.dev",
            password: { kind: "set", value: "secret" },
          },
        },
      },
    );
    expect(hostNotificationsConfigResponseSchema.parse(stored)).toMatchObject({
      matrix: { failure: { renderer: false } },
      channels: {
        email: { host: "smtp.example.dev", credentialConfigured: true },
      },
    });
    const reread = await call(
      started.rpcUrl,
      "host.notifications.getConfig",
      { major: 1, minor: 0 },
      {},
    );
    expect(reread).toMatchObject({
      channels: { email: { host: "smtp.example.dev", port: 587 } },
    });
  });
});

async function listAttention(url: string): Promise<unknown> {
  return call(
    url,
    "host.notifications.list",
    { major: 2, minor: 2 },
    { filter: "attention", limit: 50 },
  );
}

function readEntryIds(result: unknown): readonly string[] {
  return hostNotificationsListResponseSchemaV22
    .parse(result)
    .entries.map((entry) => entry.id);
}

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
