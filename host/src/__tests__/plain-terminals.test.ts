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
  createPlainTerminalResponseSchema,
  listPlainTerminalsResponseSchema,
} from "@traycer/protocol/host/terminal/plain-schemas";
import { startHost, type StartedHost } from "../start-host";

const V21 = { major: 2, minor: 1 };

describe("terminal.plain", () => {
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

  it("creates, renames, and closes a durable terminal backed by a PTY", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    const created = createPlainTerminalResponseSchema.parse(
      await call(started.rpcUrl, "terminal.plain.create", V21, {
        terminalId: "term-1",
        scope: { kind: "independent" },
        cwd: tempDir,
        cols: 80,
        rows: 24,
      }),
    );
    expect(created.terminal.record).toMatchObject({
      terminalId: "term-1",
      hostId: started.runtime.hostId,
      manualTitle: null,
      revision: 1,
    });
    expect(created.terminal.runtime).toMatchObject({
      status: "running",
      sessionId: "term-1",
      cols: 80,
    });
    // The generic terminal stream reads this session, so the plain terminal
    // has to be registered under its own terminalId.
    expect(started.runtime.terminals.get("term-1")?.status).toBe("running");

    const listed = listPlainTerminalsResponseSchema.parse(
      await call(started.rpcUrl, "terminal.plain.list", V21, {
        scope: { kind: "independent" },
      }),
    );
    expect(listed.coverage).toBe("complete-local");
    expect(listed.terminals).toHaveLength(1);

    const renamed = await call(started.rpcUrl, "terminal.plain.rename", V21, {
      terminalId: "term-1",
      manualTitle: "build",
    });
    expect(renamed).toMatchObject({
      terminal: { record: { manualTitle: "build", revision: 2 } },
    });

    // An epic-scoped list speaks only for this host's terminals.
    const epicScoped = listPlainTerminalsResponseSchema.parse(
      await call(started.rpcUrl, "terminal.plain.list", V21, {
        scope: { kind: "epic", epicId: "epic-1" },
      }),
    );
    expect(epicScoped).toMatchObject({
      coverage: "partial-serving-host",
      servingHostId: started.runtime.hostId,
      terminals: [],
    });

    expect(
      await call(started.rpcUrl, "terminal.plain.close", V21, {
        terminalId: "term-1",
      }),
    ).toEqual({ terminalId: "term-1", revision: 3 });
    expect(
      listPlainTerminalsResponseSchema.parse(
        await call(started.rpcUrl, "terminal.plain.list", V21, {
          scope: { kind: "independent" },
        }),
      ).terminals,
    ).toEqual([]);
  });

  it("keeps a dormant record across a host restart", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    await call(started.rpcUrl, "terminal.plain.create", V21, {
      terminalId: "term-2",
      scope: { kind: "epic", epicId: "epic-1" },
      cwd: tempDir,
      cols: 100,
      rows: 30,
    });
    await started.close();
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    const listed = listPlainTerminalsResponseSchema.parse(
      await call(started.rpcUrl, "terminal.plain.list", V21, {
        scope: { kind: "epic", epicId: "epic-1" },
      }),
    );
    expect(listed.terminals[0]?.record.terminalId).toBe("term-2");
    expect(listed.terminals[0]?.runtime.status).toBe("dormant");

    const revived = createPlainTerminalResponseSchema.parse(
      await call(started.rpcUrl, "terminal.plain.ensureRunning", V21, {
        terminalId: "term-2",
        cols: 90,
        rows: 20,
      }),
    );
    expect(revived.terminal.runtime).toMatchObject({
      status: "running",
      cols: 90,
    });
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
  if (record.error !== null && record.error !== undefined) {
    throw new Error(`RPC error: ${JSON.stringify(record.error)}`);
  }
  return record.result;
}
