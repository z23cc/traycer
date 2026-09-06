import * as Y from "yjs";
import type { WebSocket } from "ws";
import type { z } from "zod";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { analogFromSchema } from "../rpc/analog-value";
import type { HostRuntime } from "../runtime";

export function sendAgentActivitySnapshot(socket: WebSocket): void {
  sendJson(socket, {
    kind: "state",
    servedBy: "local",
    byEpic: {},
    cloudSyncStatus: null,
    hasBinaryPayload: false,
  });
}

export function sendEpicStatusSnapshot(
  socket: WebSocket,
  runtime: HostRuntime,
  epicId: string,
): void {
  const epic = runtime.store.snapshot().epics.find((row) => row.id === epicId);
  sendJson(socket, {
    kind: "snapshot",
    authorityEpoch: `oss:${runtime.hostId}`,
    securityEpoch: 0,
    permissionRole: epic === undefined ? null : "owner",
    cloudSyncStatus: "disconnected",
    dirty: false,
    migration: null,
    deletion: { state: "none" },
    hasBinaryPayload: false,
  });
}

export function sendNotificationsSnapshot(socket: WebSocket): void {
  const doc = new Y.Doc();
  const update = Y.encodeStateAsUpdate(doc);
  sendFrame(
    socket,
    {
      kind: "snapshot",
      meta: { schemaVersion: "1.0.0" },
      hasBinaryPayload: true,
    },
    update,
  );
  doc.destroy();
}

export function sendEpicSnapshot(
  socket: WebSocket,
  runtime: HostRuntime,
  epicId: string,
): void {
  void runtime.epics.bootstrap(runtime, epicId, socket);
}

export function sendAnalogStreamSnapshot(
  socket: WebSocket,
  method: string,
): void {
  const schema = latestStreamServerFrameSchema(method);
  if (schema === null) {
    return;
  }
  const frame = analogFromSchema(schema);
  sendJson(socket, frame);
  if (isRecord(frame) && frame.hasBinaryPayload === true) {
    const doc = new Y.Doc();
    const update = Y.encodeStateAsUpdate(doc);
    if (socket.readyState === socket.OPEN) {
      socket.send(update);
    }
    doc.destroy();
  }
}

function latestStreamServerFrameSchema(method: string): z.ZodType | null {
  const bag: { readonly [name: string]: unknown } = hostStreamRpcRegistry;
  const found = bag[method];
  if (found === null || typeof found !== "object") {
    return null;
  }
  let major = 0;
  for (const key of Object.keys(found)) {
    const numeric = Number(key);
    if (Number.isInteger(numeric) && numeric > major) {
      major = numeric;
    }
  }
  const line = Reflect.get(found, major);
  if (line === null || typeof line !== "object") {
    return null;
  }
  const latestMinor = Reflect.get(line, "latestMinor");
  const versions = Reflect.get(line, "versions");
  if (versions === null || typeof versions !== "object") {
    return null;
  }
  const version = Reflect.get(versions, latestMinor);
  if (version === null || typeof version !== "object") {
    return null;
  }
  const contract = Reflect.get(version, "contract");
  if (contract === null || typeof contract !== "object") {
    return null;
  }
  const schema = Reflect.get(contract, "serverFrameSchema");
  if (schema === null || typeof schema !== "object") {
    return null;
  }
  if (!("safeParse" in schema)) {
    return null;
  }
  return schema as z.ZodType;
}

function isRecord(
  value: unknown,
): value is { readonly [key: string]: unknown } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sendFrame(
  socket: WebSocket,
  envelope: unknown,
  binary: Uint8Array,
): void {
  sendJson(socket, envelope);
  if (socket.readyState === socket.OPEN) {
    socket.send(binary);
  }
}

function sendJson(socket: WebSocket, frame: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(frame));
  }
}
