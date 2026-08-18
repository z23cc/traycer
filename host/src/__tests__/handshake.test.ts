import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { splitConnectionManifest } from "@traycer/protocol/framework/capability-manifest";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { hostFrameSchema } from "@traycer/protocol/framework/ws-protocol";
import { HOST_PACKAGE_VERSION } from "../config";
import { hostConnectionManifest } from "../manifest";
import { publishPidMetadata, removePidMetadata } from "../pid";
import { startHostServer, type HostServer } from "../server";

async function openAck(
  url: string,
): Promise<{ readonly ws: WebSocket; readonly ack: unknown }> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const split = splitConnectionManifest(
    hostRpcRegistry,
    RELEASED_FLOOR_METHOD_NAMES,
  );
  ws.send(
    JSON.stringify({
      kind: "open",
      token: "local",
      manifest: split.manifest,
      optionalManifest: split.optionalManifest,
    }),
  );
  const raw = await nextMessage(ws);
  return { ws, ack: JSON.parse(raw) };
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(data.toString()));
    ws.once("error", reject);
  });
}

describe("local host handshake", () => {
  const servers: HostServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      if (server !== undefined) {
        await server.close();
      }
    }
  });

  it("advertises every floor method", () => {
    const split = hostConnectionManifest();
    expect(Object.keys(split.manifest).sort()).toEqual(
      [...RELEASED_FLOOR_METHOD_NAMES].sort(),
    );
  });

  it("advertises only the signed prepare-folders v1.0 surface", () => {
    expect(
      hostConnectionManifest().manifest["workspace.prepareFolders"],
    ).toEqual({ major: 1, minor: 0 });
  });

  it("advertises the signed workspace-summary v1.3 surface", () => {
    expect(
      hostConnectionManifest().manifest["worktree.listByWorkspacePaths"],
    ).toEqual({ major: 1, minor: 3 });
  });

  it("advertises only the signed worktree-create v1.0 surface", () => {
    expect(hostConnectionManifest().manifest["worktree.create"]).toEqual({
      major: 1,
      minor: 0,
    });
  });

  it("advertises only optional unary methods with local resolvers", () => {
    expect(hostConnectionManifest().optionalManifest).toEqual({
      "epic.getChatRunSettings": { major: 1, minor: 0 },
      "epic.setChatArchived": { major: 1, minor: 0 },
      "epic.updateChatProfile": { major: 1, minor: 0 },
      "epic.updateChatRunSettings": { major: 1, minor: 1 },
      "host.notifications.list": { major: 2, minor: 1 },
    });
  });

  it("acks a local-bearer open and answers host.status", async () => {
    const server = await startHostServer(0, "host-test", undefined);
    servers.push(server);
    const { ws, ack } = await openAck(server.websocketUrl);
    const parsedAck = hostFrameSchema.parse(ack);
    expect(parsedAck.kind).toBe("openAck");
    if (parsedAck.kind !== "openAck") {
      return;
    }
    expect(parsedAck.manifest["host.status"]).toEqual({ major: 1, minor: 1 });

    ws.send(
      JSON.stringify({
        kind: "request",
        requestId: "req-1",
        method: "host.status",
        schemaVersion: { major: 1, minor: 1 },
        params: {},
      }),
    );
    const response = hostFrameSchema.parse(JSON.parse(await nextMessage(ws)));
    expect(response).toMatchObject({
      kind: "response",
      requestId: "req-1",
      method: "host.status",
      error: null,
      result: {
        ready: true,
        hostVersion: HOST_PACKAGE_VERSION,
        busy: false,
      },
    });
    ws.close();
  });

  it("lists Claude models so the GUI picker can send", async () => {
    const server = await startHostServer(0, "host-test", undefined);
    servers.push(server);
    const { ws, ack } = await openAck(server.websocketUrl);
    expect(hostFrameSchema.parse(ack).kind).toBe("openAck");
    ws.send(
      JSON.stringify({
        kind: "request",
        requestId: "req-models",
        method: "agent.gui.listModels",
        schemaVersion: { major: 1, minor: 0 },
        params: { harnessId: "claude", workingDirectory: null },
      }),
    );
    const response = hostFrameSchema.parse(JSON.parse(await nextMessage(ws)));
    expect(response).toEqual(
      expect.objectContaining({
        kind: "response",
        error: null,
        result: expect.objectContaining({
          harnessId: "claude",
          models: expect.arrayContaining([
            expect.objectContaining({ slug: "claude-sonnet-4" }),
          ]),
        }),
      }),
    );
    ws.close();
  });

  it("rejects an empty bearer", async () => {
    const server = await startHostServer(0, "host-test", undefined);
    servers.push(server);
    const ws = new WebSocket(server.websocketUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(
      JSON.stringify({
        kind: "open",
        token: "",
        manifest: hostConnectionManifest().manifest,
      }),
    );
    const frame = hostFrameSchema.parse(JSON.parse(await nextMessage(ws)));
    expect(frame.kind).toBe("fatalError");
    if (frame.kind === "fatalError") {
      expect(frame.details.code).toBe("UNAUTHORIZED");
    }
    ws.close();
  });

  it("writes pid.json the desktop discovery path can read", async () => {
    const hostHome = await mkdtemp(join(tmpdir(), "traycer-host-"));
    try {
      const path = await publishPidMetadata({
        hostHome,
        hostId: "host-test",
        version: HOST_PACKAGE_VERSION,
        websocketUrl: "ws://127.0.0.1:4917/rpc",
      });
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      expect(parsed).toMatchObject({
        hostId: "host-test",
        version: HOST_PACKAGE_VERSION,
        websocketUrl: "ws://127.0.0.1:4917/rpc",
      });
      await removePidMetadata(hostHome);
    } finally {
      await rm(hostHome, { recursive: true, force: true });
    }
  });
});
