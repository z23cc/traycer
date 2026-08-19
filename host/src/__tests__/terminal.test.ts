import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { splitConnectionManifest } from "@traycer/protocol/framework/capability-manifest";
import {
  hostFrameSchema,
  type HostFrame,
} from "@traycer/protocol/framework/ws-protocol";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  createTerminalResponseSchemaV20,
  killTerminalResponseSchema,
  listTerminalsResponseSchemaV22,
} from "@traycer/protocol/host/terminal/unary-schemas";
import { terminalSubscribeServerFrameSchemaV15 } from "@traycer/protocol/host/terminal/subscribe";
import { scriptedTurnRunner } from "../cli-runner";
import { startHostServer, type HostServer } from "../server";

describe("local terminal lifecycle", () => {
  const servers: HostServer[] = [];
  const sockets: WebSocket[] = [];
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.terminate();
    }
    while (servers.length > 0) {
      await servers.pop()?.close();
    }
    while (temporaryDirectories.length > 0) {
      const directory = temporaryDirectories.pop();
      if (directory !== undefined) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("creates, lists, and kills a real independent PTY session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "traycer-terminal-"));
    temporaryDirectories.push(cwd);
    const canonicalCwd = await realpath(cwd);
    const server = await startHostServer(0, "host-terminal", {
      runner: scriptedTurnRunner([]),
    });
    servers.push(server);
    const rpc = await openRpc(server.websocketUrl, sockets);

    const create = await rpc.request(
      "terminal-create",
      "terminal.create",
      {
        major: 2,
        minor: 0,
      },
      {
        scope: { kind: "independent" },
        sessionKind: "terminal",
        tuiHarnessId: null,
        cwd: canonicalCwd,
        shellCommand: "/bin/sh",
        shellArgs: ["-c", "trap 'exit 0' TERM INT; while :; do sleep 1; done"],
        cols: 80,
        rows: 24,
        desiredSessionId: "terminal-public-lifecycle",
        worktreeBusyPaths: [],
      },
    );
    expect(create.error).toBeNull();
    const created = createTerminalResponseSchemaV20.parse(create.result);
    expect(created.session).toMatchObject({
      sessionId: "terminal-public-lifecycle",
      scope: { kind: "independent" },
      sessionKind: "terminal",
      cwd: canonicalCwd,
      shellCommand: "/bin/sh",
      cols: 80,
      rows: 24,
      status: "running",
      exitCode: null,
      exitReason: null,
      title: null,
    });

    const freshRpc = await openRpc(server.websocketUrl, sockets);
    const listed = await freshRpc.request(
      "terminal-list",
      "terminal.list",
      { major: 2, minor: 2 },
      { scope: { kind: "independent" } },
    );
    expect(listed.error).toBeNull();
    expect(listTerminalsResponseSchemaV22.parse(listed.result)).toEqual({
      sessions: [{ ...created.session, currentCwd: canonicalCwd }],
      homeCwd: homedir(),
    });

    const busyStatus = await freshRpc.request(
      "host-status-busy-terminal",
      "host.status",
      { major: 1, minor: 1 },
      {},
    );
    expect(busyStatus.result).toMatchObject({
      busy: true,
      busySessionCount: 1,
    });

    const killed = await rpc.request(
      "terminal-kill",
      "terminal.kill",
      { major: 1, minor: 0 },
      { sessionId: created.session.sessionId },
    );
    expect(killed.error).toBeNull();
    expect(killTerminalResponseSchema.parse(killed.result)).toEqual({
      killed: true,
    });

    const killedAgain = await rpc.request(
      "terminal-kill-again",
      "terminal.kill",
      { major: 1, minor: 0 },
      { sessionId: created.session.sessionId },
    );
    expect(killedAgain.error).toBeNull();
    expect(killTerminalResponseSchema.parse(killedAgain.result)).toEqual({
      killed: false,
    });

    const afterKill = await freshRpc.request(
      "terminal-list-after-kill",
      "terminal.list",
      { major: 2, minor: 2 },
      { scope: { kind: "independent" } },
    );
    expect(afterKill.error).toBeNull();
    expect(listTerminalsResponseSchemaV22.parse(afterKill.result)).toEqual({
      sessions: [],
      homeCwd: homedir(),
    });
    const idleStatus = await freshRpc.request(
      "host-status-idle-terminal",
      "host.status",
      { major: 1, minor: 1 },
      {},
    );
    expect(idleStatus.result).toMatchObject({
      busy: false,
      busySessionCount: 0,
    });
  });

  it("streams terminal input and output through the public subscription", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "traycer-terminal-stream-"));
    temporaryDirectories.push(cwd);
    const server = await startHostServer(0, "host-terminal-stream", {
      runner: scriptedTurnRunner([]),
    });
    servers.push(server);
    const rpc = await openRpc(server.websocketUrl, sockets);
    const createdFrame = await rpc.request(
      "terminal-create-stream",
      "terminal.create",
      { major: 2, minor: 0 },
      {
        scope: { kind: "independent" },
        sessionKind: "terminal",
        tuiHarnessId: null,
        cwd,
        shellCommand: "/bin/sh",
        shellArgs: [],
        cols: 80,
        rows: 24,
        desiredSessionId: "terminal-public-stream",
        worktreeBusyPaths: [],
      },
    );
    expect(createdFrame.error).toBeNull();
    const created = createTerminalResponseSchemaV20.parse(createdFrame.result);

    const stream = new WebSocket(
      server.websocketUrl.replace("/rpc", "/stream"),
    );
    sockets.push(stream);
    const pump = attachTextPump(stream);
    await new Promise<void>((resolve, reject) => {
      stream.once("open", resolve);
      stream.once("error", reject);
    });
    stream.send(
      JSON.stringify({
        kind: "open",
        token: "local",
        manifest: { "terminal.subscribe": { major: 1, minor: 5 } },
      }),
    );
    expect(await pump.next()).toMatchObject({
      kind: "openAck",
      manifest: { "terminal.subscribe": { major: 1, minor: 5 } },
    });
    stream.send(
      JSON.stringify({
        kind: "subscribe",
        method: "terminal.subscribe",
        schemaVersion: { major: 1, minor: 5 },
        params: {
          sessionId: created.session.sessionId,
          cols: 80,
          rows: 24,
        },
      }),
    );
    const snapshot = terminalSubscribeServerFrameSchemaV15.parse(
      await pump.next(),
    );
    expect(snapshot).toMatchObject({
      kind: "snapshot",
      sessionId: created.session.sessionId,
      session: {
        sessionId: created.session.sessionId,
        currentCwd: cwd,
        status: "running",
      },
      ackCreditSupported: true,
    });

    stream.send(
      JSON.stringify({
        kind: "write",
        hasBinaryPayload: false,
        sessionId: created.session.sessionId,
        clientActionId: "terminal-write",
        data: "printf 'terminal-stream-ok\\n'\n",
      }),
    );
    let output = "";
    let accepted = false;
    for (
      let index = 0;
      index < 12 && (!accepted || !output.includes("terminal-stream-ok"));
      index += 1
    ) {
      const frame = terminalSubscribeServerFrameSchemaV15.parse(
        await pump.next(),
      );
      if (
        frame.kind === "actionAck" &&
        frame.clientActionId === "terminal-write"
      ) {
        expect(frame).toMatchObject({
          action: "write",
          status: "accepted",
          reason: null,
          code: null,
        });
        accepted = true;
      }
      if (frame.kind === "data") {
        output += frame.chunk;
      }
    }
    expect(accepted).toBe(true);
    expect(output).toContain("terminal-stream-ok");

    const killed = await rpc.request(
      "terminal-kill-stream",
      "terminal.kill",
      { major: 1, minor: 0 },
      { sessionId: created.session.sessionId },
    );
    expect(killed.error).toBeNull();
    expect(killTerminalResponseSchema.parse(killed.result)).toEqual({
      killed: true,
    });
  });

  it("injects the terminal-agent identity into the real PTY process", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "traycer-terminal-agent-env-"));
    temporaryDirectories.push(cwd);
    const server = await startHostServer(0, "host-terminal-agent-env", {
      runner: scriptedTurnRunner([]),
    });
    servers.push(server);
    const rpc = await openRpc(server.websocketUrl, sockets);
    const createdFrame = await rpc.request(
      "terminal-create-agent-env",
      "terminal.create",
      { major: 2, minor: 0 },
      {
        scope: { kind: "epic", epicId: "epic-terminal-agent-env" },
        sessionKind: "terminal-agent",
        tuiHarnessId: "claude",
        cwd,
        shellCommand: "/bin/sh",
        shellArgs: [
          "-c",
          'printf \'%s|%s|%s\' "$TRAYCER_AGENT_ID" "$TRAYCER_EPIC_ID" "$TRAYCER_AGENT_CLI_SURFACE"',
        ],
        cols: 80,
        rows: 24,
        desiredSessionId: "tui-env-agent",
        worktreeBusyPaths: [],
      },
    );
    expect(createdFrame.error).toBeNull();
    const created = createTerminalResponseSchemaV20.parse(createdFrame.result);
    const stream = new WebSocket(
      server.websocketUrl.replace("/rpc", "/stream"),
    );
    sockets.push(stream);
    const pump = attachTextPump(stream);
    await new Promise<void>((resolve, reject) => {
      stream.once("open", resolve);
      stream.once("error", reject);
    });
    stream.send(
      JSON.stringify({
        kind: "open",
        token: "local",
        manifest: { "terminal.subscribe": { major: 1, minor: 5 } },
      }),
    );
    await pump.next();
    stream.send(
      JSON.stringify({
        kind: "subscribe",
        method: "terminal.subscribe",
        schemaVersion: { major: 1, minor: 5 },
        params: {
          sessionId: created.session.sessionId,
          cols: 80,
          rows: 24,
        },
      }),
    );
    const snapshot = terminalSubscribeServerFrameSchemaV15.parse(
      await pump.next(),
    );
    expect(snapshot).toMatchObject({ kind: "snapshot" });
    if (snapshot.kind !== "snapshot") {
      throw new Error("Expected terminal-agent snapshot");
    }
    let output = snapshot.scrollback;
    for (let index = 0; index < 8 && !output.includes("|full"); index += 1) {
      const frame = terminalSubscribeServerFrameSchemaV15.parse(
        await pump.next(),
      );
      if (frame.kind === "data") output += frame.chunk;
      if (frame.kind === "exit" && !output.includes("|full")) break;
    }
    expect(output).toBe("tui-env-agent|epic-terminal-agent-env|full");
  });
});

type RpcConnection = {
  readonly request: (
    requestId: string,
    method: string,
    schemaVersion: { readonly major: number; readonly minor: number },
    params: unknown,
  ) => Promise<Extract<HostFrame, { kind: "response" }>>;
};

async function openRpc(
  websocketUrl: string,
  sockets: WebSocket[],
): Promise<RpcConnection> {
  const socket = new WebSocket(websocketUrl);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const clientManifest = splitConnectionManifest(
    hostRpcRegistry,
    RELEASED_FLOOR_METHOD_NAMES,
  );
  socket.send(
    JSON.stringify({
      kind: "open",
      token: "local",
      manifest: clientManifest.manifest,
      optionalManifest: clientManifest.optionalManifest,
    }),
  );
  expect(await nextHostFrame(socket)).toMatchObject({
    kind: "openAck",
    manifest: {
      "terminal.create": { major: 2, minor: 0 },
      "terminal.list": { major: 2, minor: 2 },
      "terminal.kill": { major: 1, minor: 0 },
    },
  });
  return {
    request: async (requestId, method, schemaVersion, params) => {
      socket.send(
        JSON.stringify({
          kind: "request",
          requestId,
          method,
          schemaVersion,
          params,
        }),
      );
      const frame = await nextHostFrame(socket);
      expect(frame.kind).toBe("response");
      if (frame.kind !== "response") {
        throw new Error(`Expected response, got ${frame.kind}`);
      }
      expect(frame.requestId).toBe(requestId);
      return frame;
    },
  };
}

async function nextHostFrame(socket: WebSocket): Promise<HostFrame> {
  return await new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(hostFrameSchema.parse(JSON.parse(data.toString())));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

function attachTextPump(socket: WebSocket): {
  readonly next: () => Promise<unknown>;
} {
  const queued: unknown[] = [];
  const waiters: Array<(value: unknown) => void> = [];
  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      return;
    }
    const value: unknown = JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter === undefined) {
      queued.push(value);
      return;
    }
    waiter(value);
  });
  return {
    next: async () => {
      const value = queued.shift();
      if (value !== undefined) {
        return value;
      }
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timed out waiting for terminal frame")),
          2_000,
        );
        waiters.push((nextValue) => {
          clearTimeout(timeout);
          resolve(nextValue);
        });
      });
    },
  };
}
