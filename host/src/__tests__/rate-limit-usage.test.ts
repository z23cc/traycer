import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { splitConnectionManifest } from "@traycer/protocol/framework/capability-manifest";
import {
  hostFrameSchema,
  type HostFrame,
} from "@traycer/protocol/framework/ws-protocol";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { rateLimitUsageResponseSchemaV30 } from "@traycer/protocol/host/rate-limit/schemas";
import { startHostServer, type HostServer } from "../server";

describe("host.getRateLimitUsage", () => {
  const servers: HostServer[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    while (servers.length > 0) await servers.pop()?.close();
  });

  it("reports the signed local aperture snapshot over the released v3 wire", async () => {
    const server = await startHostServer(0, "host-rate-limit", undefined);
    servers.push(server);
    const { ws, opened } = await openRpc(server, sockets);
    expect(opened).toMatchObject({
      kind: "openAck",
      manifest: { "host.getRateLimitUsage": { major: 3, minor: 0 } },
    });

    const frame = await requestRateLimits(ws, "rate-limit-1", {});
    expect(frame).toMatchObject({
      kind: "response",
      requestId: "rate-limit-1",
      error: null,
    });
    expect(
      rateLimitUsageResponseSchemaV30.parse(responseResult(frame)),
    ).toEqual({
      totalTokens: 15,
      remainingTokens: 15,
      providerRateLimits: null,
    });
  });

  it("reports an explicit provider as unavailable without fabricating usage", async () => {
    const server = await startHostServer(
      0,
      "host-provider-rate-limit",
      undefined,
    );
    servers.push(server);
    const { ws } = await openRpc(server, sockets);
    const frame = await requestRateLimits(ws, "rate-limit-provider", {
      providerId: "codex",
    });
    expect(frame).toMatchObject({
      kind: "response",
      requestId: "rate-limit-provider",
      error: null,
    });
    expect(
      rateLimitUsageResponseSchemaV30.parse(responseResult(frame)),
    ).toEqual({
      totalTokens: 15,
      remainingTokens: 15,
      providerRateLimits: {
        provider: "codex",
        available: false,
        reason: "rate_limits_not_available",
      },
    });
  });
});

async function openRpc(
  server: HostServer,
  sockets: WebSocket[],
): Promise<{ readonly ws: WebSocket; readonly opened: HostFrame }> {
  const ws = new WebSocket(server.websocketUrl);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
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
  const opened = hostFrameSchema.parse(JSON.parse(await nextMessage(ws)));
  return { ws, opened };
}

async function requestRateLimits(
  ws: WebSocket,
  requestId: string,
  params: unknown,
): Promise<HostFrame> {
  ws.send(
    JSON.stringify({
      kind: "request",
      requestId,
      method: "host.getRateLimitUsage",
      schemaVersion: { major: 3, minor: 0 },
      params,
    }),
  );
  return hostFrameSchema.parse(JSON.parse(await nextMessage(ws)));
}

function responseResult(frame: HostFrame): unknown {
  if (frame.kind !== "response" || frame.error !== null) {
    throw new Error(
      frame.kind === "response"
        ? `${frame.error?.code}: ${frame.error?.message}`
        : "Expected response frame",
    );
  }
  return frame.result;
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData): void => {
      ws.off("error", onError);
      resolve(data.toString());
    };
    const onError = (error: Error): void => {
      ws.off("message", onMessage);
      reject(error);
    };
    ws.once("message", onMessage);
    ws.once("error", onError);
  });
}
