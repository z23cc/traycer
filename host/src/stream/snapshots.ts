import * as Y from "yjs";
import type { WebSocket } from "ws";
import { titleFromPrompt } from "../agent/gui-chat";
import type { HostRuntime } from "../runtime";
import type { StoredEpic } from "../store/host-store";

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
  const epic = runtime.store.snapshot().epics.find((row) => row.id === epicId);
  const doc = new Y.Doc();
  const root = doc.getMap("epic");
  root.set("id", epicId);
  if (epic !== undefined) {
    root.set("title", projectedEpicTitle(epic));
    root.set("status", epic.status);
  }
  const update = Y.encodeStateAsUpdate(doc);
  const stateVector = Y.encodeStateVector(doc);
  sendFrame(
    socket,
    {
      kind: "snapshot",
      epicId,
      meta: snapshotMeta(runtime, epicId, epic, stateVector),
      hasBinaryPayload: true,
    },
    update,
  );
  sendJson(socket, {
    kind: "cloudSyncStatus",
    epicId,
    status: "disconnected",
    hasBinaryPayload: false,
  });
  doc.destroy();
}

function projectedEpicTitle(epic: StoredEpic): string {
  if (epic.title.length > 0) {
    return epic.title;
  }
  return titleFromPrompt(epic.initialUserPrompt);
}

function snapshotMeta(
  runtime: HostRuntime,
  epicId: string,
  epic: StoredEpic | undefined,
  stateVector: Uint8Array,
) {
  const light =
    epic === undefined
      ? null
      : {
          id: epic.id,
          title: projectedEpicTitle(epic),
          initialUserPrompt: epic.initialUserPrompt,
          ticketCount: epic.ticketCount,
          specCount: epic.specCount,
          storyCount: epic.storyCount,
          reviewCount: epic.reviewCount,
          status: epic.status,
          createdAt: epic.createdAt,
          updatedAt: epic.updatedAt,
          createdBy: epic.createdBy,
          version: epic.version,
        };
  const workspaces =
    epic === undefined
      ? []
      : epic.workspaces.map((workspacePath) => ({
          task: { taskId: epic.id, taskType: "epic" as const },
          hostId: runtime.hostId,
          workspacePath,
          createdAt: epic.createdAt,
        }));
  const repos =
    epic === undefined
      ? []
      : epic.repos.map((repo) => ({
          task: { taskId: epic.id, taskType: "epic" as const },
          repoIdentifier: repo,
          createdAt: epic.createdAt,
          createdBy: epic.createdBy,
        }));
  return {
    schemaVersion: epic?.version ?? "2.0.0",
    epicLight: light,
    permissionRole: "owner",
    repos,
    workspaces,
    repoMapping: [],
    workspaceFolders: workspaces.map((workspace) => ({
      workspacePath: workspace.workspacePath,
      hostId: runtime.hostId,
      repoIdentifier: null,
      lastSyncedAt: null,
    })),
    unresolvedRepos: [],
    hostStateVectorBase64: Buffer.from(stateVector).toString("base64"),
    roomId: `local:${epicId}`,
  };
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
