import * as Y from "yjs";
import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import type { SchemaVersion } from "@traycer/protocol/framework";
import type { StreamMethodFrameEnvelope } from "@traycer/protocol/framework/stream-ws-protocol";
import {
  epicSubscribeClientFrameSchema,
  epicSubscribeOpenRequestSchema,
} from "@traycer/protocol/host/epic/subscribe";
import type { StoredArtifactRoom } from "./artifact-rooms";
import { HostState, projectStoredEpicLight } from "./store";

type StreamSend = (data: string | Uint8Array) => void;
type EpicFrameSink = (frame: unknown, binaryPayload: Uint8Array | null) => void;

type AwarenessUpdate = {
  readonly added: number[];
  readonly updated: number[];
  readonly removed: number[];
};

export type EpicStreamBinding = {
  readonly method: "epic.subscribe";
  readonly epicId: string;
  readonly onFrame: (
    envelope: StreamMethodFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ) => void;
  readonly dispose: () => void;
};

export type OpenEpicStreamResult =
  | { readonly accepted: true; readonly binding: EpicStreamBinding }
  | {
      readonly accepted: false;
      readonly code: "E_INVALID_ARGUMENT";
      readonly reason: string;
    };

export function openEpicStream(
  send: StreamSend,
  state: HostState,
  schemaVersion: SchemaVersion,
  params: unknown,
): OpenEpicStreamResult {
  const parsed = epicSubscribeOpenRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      accepted: false,
      code: "E_INVALID_ARGUMENT",
      reason: parsed.error.message,
    };
  }
  const epic = state.getEpic(parsed.data.epicId);
  if (epic === null) {
    return {
      accepted: false,
      code: "E_INVALID_ARGUMENT",
      reason: `Unknown epic ${parsed.data.epicId}`,
    };
  }

  const earlyMeta = {
    epicLight: epic.light,
    permissionRole: "owner",
    repos: epic.repos,
    workspaces: epic.workspaces,
    repoMapping: [],
    workspaceFolders: epic.workspaces.map((workspace) => ({
      workspacePath: workspace.workspacePath,
      hostId: workspace.hostId,
      repoIdentifier: null,
      lastSyncedAt: workspace.createdAt,
    })),
    unresolvedRepos: [],
  };
  const sink: EpicFrameSink = (frame, binaryPayload) => {
    sendJson(send, frame);
    if (binaryPayload !== null) {
      send(binaryPayload);
    }
  };
  const onDocUpdate = (update: Uint8Array): void => {
    sink(
      {
        kind: "update",
        epicId: epic.light.id,
        hasBinaryPayload: true,
      },
      update,
    );
  };
  const awarenessOrigin = Symbol("epic-stream/awareness");
  const emitAwareness = (clientIds: number[]): void => {
    if (clientIds.length === 0) {
      return;
    }
    sink(
      {
        kind: "awareness",
        epicId: epic.light.id,
        hasBinaryPayload: true,
      },
      encodeAwarenessUpdate(epic.awareness, clientIds),
    );
  };
  const onAwarenessUpdate = (
    update: AwarenessUpdate,
    origin: unknown,
  ): void => {
    if (origin === awarenessOrigin) {
      return;
    }
    emitAwareness([
      ...new Set([...update.added, ...update.updated, ...update.removed]),
    ]);
  };
  const artifactRoomDisposers = new Map<string, () => void>();
  const artifactRoomUpdateOrigin = Symbol("epic-stream/artifact-room-update");
  const artifactRoomAwarenessOrigin = Symbol(
    "epic-stream/artifact-room-awareness",
  );
  const attachArtifactRoom = (room: StoredArtifactRoom): void => {
    if (artifactRoomDisposers.has(room.id)) {
      return;
    }
    const onRoomDocUpdate = (update: Uint8Array, origin: unknown): void => {
      if (origin === artifactRoomUpdateOrigin) {
        return;
      }
      sink(
        {
          kind: "artifactRoomUpdate",
          epicId: epic.light.id,
          artifactRoomId: room.id,
          hostArtifactRoomStateVectorBase64: stateVectorBase64(room.doc),
          hasBinaryPayload: true,
        },
        update,
      );
    };
    const onRoomAwarenessUpdate = (
      update: AwarenessUpdate,
      origin: unknown,
    ): void => {
      if (origin === artifactRoomAwarenessOrigin) {
        return;
      }
      const clientIds = [
        ...new Set([...update.added, ...update.updated, ...update.removed]),
      ];
      if (clientIds.length === 0) {
        return;
      }
      sink(
        {
          kind: "artifactRoomAwareness",
          epicId: epic.light.id,
          artifactRoomId: room.id,
          hasBinaryPayload: true,
        },
        encodeAwarenessUpdate(room.awareness, clientIds),
      );
    };
    room.doc.on("update", onRoomDocUpdate);
    room.awareness.on("update", onRoomAwarenessUpdate);
    artifactRoomDisposers.set(room.id, () => {
      room.doc.off("update", onRoomDocUpdate);
      room.awareness.off("update", onRoomAwarenessUpdate);
    });
    sendJson(send, {
      kind: "artifactRoomState",
      epicId: epic.light.id,
      artifactRoomId: room.id,
      state: "ready",
      hasBinaryPayload: false,
    });
    sink(
      {
        kind: "artifactRoomSnapshot",
        epicId: epic.light.id,
        artifactRoomId: room.id,
        hostArtifactRoomStateVectorBase64: stateVectorBase64(room.doc),
        hasBinaryPayload: true,
      },
      Y.encodeStateAsUpdate(room.doc),
    );
  };

  epic.doc.on("update", onDocUpdate);
  epic.awareness.on("update", onAwarenessUpdate);
  const unsubscribeRoomAdded =
    epic.artifactRooms.onRoomAdded(attachArtifactRoom);
  sendJson(send, {
    kind: "earlyMeta",
    epicId: epic.light.id,
    meta: earlyMeta,
    hasBinaryPayload: false,
  });
  const snapshotBytes = Y.encodeStateAsUpdate(epic.doc);
  sendJson(send, {
    kind: "snapshot",
    epicId: epic.light.id,
    meta: {
      ...earlyMeta,
      epicLight: projectStoredEpicLight(epic),
      schemaVersion: "1.0.0",
      hostStateVectorBase64: Buffer.from(
        Y.encodeStateVector(epic.doc),
      ).toString("base64"),
    },
    hasBinaryPayload: true,
  });
  send(snapshotBytes);
  emitAwareness(
    [...epic.awareness.getStates()]
      .filter(([, awarenessState]) => Object.keys(awarenessState).length > 0)
      .map(([clientId]) => clientId),
  );
  if (schemaVersion.major === 1 && schemaVersion.minor >= 1) {
    sendJson(send, {
      kind: "dirtySnapshot",
      epicId: epic.light.id,
      rootDirty: false,
      rooms: epic.artifactRooms.listRooms().map((room) => ({
        artifactRoomId: room.id,
        dirty: false,
      })),
      hasBinaryPayload: false,
    });
  }
  sendJson(send, {
    kind: "cloudSyncStatus",
    epicId: epic.light.id,
    status: "disconnected",
    hasBinaryPayload: false,
  });
  for (const room of epic.artifactRooms.listRooms()) {
    attachArtifactRoom(room);
  }

  let disposed = false;
  return {
    accepted: true,
    binding: {
      method: "epic.subscribe",
      epicId: epic.light.id,
      onFrame: (envelope, binaryPayload) => {
        const frame = epicSubscribeClientFrameSchema.safeParse(envelope);
        if (!frame.success) {
          return;
        }
        if (!frame.data.hasBinaryPayload || binaryPayload === null) {
          return;
        }
        if (frame.data.kind === "applyUpdate") {
          try {
            Y.applyUpdate(epic.doc, binaryPayload);
          } catch {
            return;
          }
          return;
        }
        if (frame.data.kind === "artifactRoomApplyUpdate") {
          const room = epic.artifactRooms.getRoom(frame.data.artifactRoomId);
          if (room === null) {
            return;
          }
          try {
            Y.applyUpdate(room.doc, binaryPayload, artifactRoomUpdateOrigin);
          } catch {
            return;
          }
          sink(
            {
              kind: "artifactRoomUpdate",
              epicId: epic.light.id,
              artifactRoomId: room.id,
              hostArtifactRoomStateVectorBase64: stateVectorBase64(room.doc),
              hasBinaryPayload: true,
            },
            binaryPayload,
          );
          return;
        }
        if (frame.data.kind === "artifactRoomAwareness") {
          const room = epic.artifactRooms.getRoom(frame.data.artifactRoomId);
          if (room === null) {
            return;
          }
          try {
            applyAwarenessUpdate(
              room.awareness,
              binaryPayload,
              artifactRoomAwarenessOrigin,
            );
          } catch {
            return;
          }
          return;
        }
        if (frame.data.kind === "awareness") {
          try {
            applyAwarenessUpdate(
              epic.awareness,
              binaryPayload,
              awarenessOrigin,
            );
          } catch {
            return;
          }
        }
      },
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        epic.doc.off("update", onDocUpdate);
        epic.awareness.off("update", onAwarenessUpdate);
        unsubscribeRoomAdded();
        for (const detach of artifactRoomDisposers.values()) {
          detach();
        }
        artifactRoomDisposers.clear();
      },
    },
  };
}

function sendJson(send: StreamSend, frame: unknown): void {
  send(JSON.stringify(frame));
}

function stateVectorBase64(doc: Y.Doc): string {
  return Buffer.from(Y.encodeStateVector(doc)).toString("base64");
}
