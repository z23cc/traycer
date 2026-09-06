import * as Y from "yjs";
import type { WebSocket } from "ws";
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
