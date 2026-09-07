import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import * as Y from "yjs";
import { artifactBodyFragmentName } from "@traycer/protocol/persistence/epic/artifacts";
import type { EarlyMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import {
  readArtifactMarkdown,
  seedXmlFragmentFromMarkdown,
  writeArtifactMarkdownFile,
  xmlFragmentToMarkdown,
} from "../epic/artifact-body";
import { LOCAL_USER_ID } from "../local-user";
import type { HostRuntime } from "../runtime";
import type {
  StoredArtifact,
  StoredChat,
  StoredEpic,
  StoredTuiAgent,
} from "../store/host-store";
import { titleFromPrompt } from "../agent/gui-chat";

type EpicSession = {
  readonly epicId: string;
  readonly doc: Y.Doc;
  readonly rooms: Map<string, Y.Doc>;
  readonly sockets: Set<WebSocket>;
};

export class EpicHub {
  private readonly sessions = new Map<string, EpicSession>();

  async bootstrap(
    runtime: HostRuntime,
    epicId: string,
    socket: WebSocket,
  ): Promise<void> {
    await assignRoomIds(runtime, epicId);
    this.add(epicId, socket);
    await this.syncFromStore(runtime, epicId);
    this.sendBootstrap(socket, runtime, epicId);
  }

  add(epicId: string, socket: WebSocket): void {
    const session = this.session(epicId);
    session.sockets.add(socket);
  }

  remove(socket: WebSocket): void {
    for (const session of this.sessions.values()) {
      session.sockets.delete(socket);
    }
  }

  async syncFromStore(runtime: HostRuntime, epicId: string): Promise<void> {
    const session = this.session(epicId);
    const before = Y.encodeStateVector(session.doc);
    seedRoot(session.doc, runtime, epicId);
    const update = Y.encodeStateAsUpdate(session.doc, before);
    if (update.byteLength > 0) {
      broadcastFrame(
        session,
        {
          kind: "update",
          epicId,
          hasBinaryPayload: true,
        },
        update,
      );
    }
    const added = await ensureRooms(session, runtime, epicId);
    for (const roomId of added) {
      for (const socket of session.sockets) {
        sendRoomBootstrap(socket, epicId, roomId, session.rooms.get(roomId));
      }
    }
  }

  sendBootstrap(socket: WebSocket, runtime: HostRuntime, epicId: string): void {
    const session = this.session(epicId);
    const update = Y.encodeStateAsUpdate(session.doc);
    const stateVector = Y.encodeStateVector(session.doc);
    sendFrame(
      socket,
      {
        kind: "snapshot",
        epicId,
        meta: snapshotMeta(runtime, epicId, stateVector),
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
    const rooms: { artifactRoomId: string; dirty: boolean }[] = [];
    for (const [roomId, room] of session.rooms) {
      sendRoomBootstrap(socket, epicId, roomId, room);
      rooms.push({ artifactRoomId: roomId, dirty: false });
    }
    sendJson(socket, {
      kind: "dirtySnapshot",
      epicId,
      rootDirty: false,
      rooms,
      hasBinaryPayload: false,
    });
  }

  applyRootUpdate(epicId: string, bytes: Uint8Array): void {
    const session = this.sessions.get(epicId);
    if (session === undefined) {
      return;
    }
    Y.applyUpdate(session.doc, bytes);
    broadcastFrame(
      session,
      { kind: "update", epicId, hasBinaryPayload: true },
      bytes,
    );
  }

  applyRoomUpdate(
    runtime: HostRuntime,
    epicId: string,
    artifactRoomId: string,
    bytes: Uint8Array,
  ): void {
    const session = this.sessions.get(epicId);
    if (session === undefined) {
      return;
    }
    const room = session.rooms.get(artifactRoomId);
    if (room === undefined) {
      return;
    }
    Y.applyUpdate(room, bytes);
    const stateVector = Y.encodeStateVector(room);
    broadcastFrame(
      session,
      {
        kind: "artifactRoomUpdate",
        epicId,
        artifactRoomId,
        hostArtifactRoomStateVectorBase64:
          Buffer.from(stateVector).toString("base64"),
        hasBinaryPayload: true,
      },
      bytes,
    );
    void persistRoomMarkdown(runtime, epicId, artifactRoomId, room);
  }

  /**
   * The room `Y.Doc` holding one artifact's body, materialized if it is not
   * already resident.
   *
   * `artifact.subscribe` is a per-artifact VIEW onto the same room
   * `epic.subscribe` serves, never a second document: two docs for one body
   * would drift, which is the failure the doc lane exists to prevent.
   */
  async bodyRoom(
    runtime: HostRuntime,
    epicId: string,
    artifactId: string,
  ): Promise<{ readonly room: Y.Doc; readonly roomId: string } | null> {
    await assignRoomIds(runtime, epicId);
    const artifact = runtime.store
      .snapshot()
      .artifacts.find(
        (row) => row.epicId === epicId && row.artifactId === artifactId,
      );
    if (artifact === undefined || artifact.artifactRoomId.length === 0) {
      return null;
    }
    const session = this.session(epicId);
    await ensureRooms(session, runtime, epicId);
    const room = session.rooms.get(artifact.artifactRoomId);
    return room === undefined
      ? null
      : { room, roomId: artifact.artifactRoomId };
  }

  /** Persists a body edited through the doc lane, same path `epic.subscribe` uses. */
  persistRoom(runtime: HostRuntime, epicId: string, roomId: string): void {
    const room = this.sessions.get(epicId)?.rooms.get(roomId);
    if (room === undefined) {
      return;
    }
    void persistRoomMarkdown(runtime, epicId, roomId, room);
  }

  private session(epicId: string): EpicSession {
    const existing = this.sessions.get(epicId);
    if (existing !== undefined) {
      return existing;
    }
    const created: EpicSession = {
      epicId,
      doc: new Y.Doc(),
      rooms: new Map(),
      sockets: new Set(),
    };
    this.sessions.set(epicId, created);
    return created;
  }
}

export async function publishEpic(
  runtime: HostRuntime,
  epicId: string,
): Promise<void> {
  await assignRoomIds(runtime, epicId);
  await runtime.epics.syncFromStore(runtime, epicId);
}

async function assignRoomIds(
  runtime: HostRuntime,
  epicId: string,
): Promise<void> {
  await runtime.store.mutate((state) => {
    state.artifacts = state.artifacts.map((row) => {
      if (row.epicId !== epicId || row.artifactRoomId.length > 0) {
        return row;
      }
      return { ...row, artifactRoomId: randomUUID() };
    });
  });
}

function seedRoot(doc: Y.Doc, runtime: HostRuntime, epicId: string): void {
  const snapshot = runtime.store.snapshot();
  const epic = snapshot.epics.find((row) => row.id === epicId);
  doc.transact(() => {
    const root = doc.getMap("epic");
    root.set("id", epicId);
    if (epic !== undefined) {
      root.set("title", projectedEpicTitle(epic));
      root.set("status", epic.status);
    }
    root.set(
      "artifacts",
      artifactMap(snapshot.artifacts.filter((row) => row.epicId === epicId)),
    );
    root.set(
      "chats",
      chatMap(snapshot.chats.filter((row) => row.epicId === epicId)),
    );
    root.set(
      "tuiAgents",
      tuiMap(snapshot.tuiAgents.filter((row) => row.epicId === epicId)),
    );
  });
}

async function ensureRooms(
  session: EpicSession,
  runtime: HostRuntime,
  epicId: string,
): Promise<readonly string[]> {
  const wanted = new Map<string, StoredArtifact>();
  for (const row of runtime.store.snapshot().artifacts) {
    if (row.epicId !== epicId) {
      continue;
    }
    const roomId =
      row.artifactRoomId.length > 0 ? row.artifactRoomId : randomUUID();
    wanted.set(roomId, row);
  }
  for (const roomId of [...session.rooms.keys()]) {
    if (!wanted.has(roomId)) {
      session.rooms.get(roomId)?.destroy();
      session.rooms.delete(roomId);
    }
  }
  const added: string[] = [];
  for (const [roomId, artifact] of wanted) {
    let room = session.rooms.get(roomId);
    if (room === undefined) {
      room = new Y.Doc();
      session.rooms.set(roomId, room);
      added.push(roomId);
    }
    const fragment = room.getXmlFragment(
      artifactBodyFragmentName(artifact.artifactId),
    );
    if (fragment.length > 0) {
      continue;
    }
    const markdown = await readArtifactMarkdown(runtime, artifact);
    seedXmlFragmentFromMarkdown(fragment, markdown);
  }
  return added;
}

async function persistRoomMarkdown(
  runtime: HostRuntime,
  epicId: string,
  artifactRoomId: string,
  room: Y.Doc,
): Promise<void> {
  const artifact = runtime.store
    .snapshot()
    .artifacts.find(
      (row) => row.epicId === epicId && row.artifactRoomId === artifactRoomId,
    );
  if (artifact === undefined) {
    return;
  }
  const fragment = room.getXmlFragment(
    artifactBodyFragmentName(artifact.artifactId),
  );
  await writeArtifactMarkdownFile(
    runtime,
    artifact,
    xmlFragmentToMarkdown(fragment),
  );
}

function artifactMap(rows: readonly StoredArtifact[]): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const row of rows) {
    const entry = new Y.Map<unknown>();
    entry.set("id", row.artifactId);
    entry.set("kind", row.kind);
    entry.set("title", row.title);
    entry.set("folderName", row.folderName);
    entry.set("parentId", row.parentId);
    entry.set("createdAt", row.createdAt);
    entry.set("updatedAt", row.updatedAt);
    entry.set("createdManually", true);
    entry.set(
      "artifactRoomId",
      row.artifactRoomId.length > 0 ? row.artifactRoomId : "",
    );
    if (row.kind === "ticket" || row.kind === "story") {
      entry.set("status", row.status ?? 0);
      entry.set("assignee", row.assignee ?? "");
    }
    map.set(row.artifactId, entry);
  }
  return map;
}

function chatMap(rows: readonly StoredChat[]): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const row of rows) {
    const last = row.turns[row.turns.length - 1];
    const entry = new Y.Map<unknown>();
    entry.set("id", row.chatId);
    entry.set("title", row.title);
    entry.set("parentId", row.parentId);
    entry.set("createdAt", row.createdAt);
    entry.set("updatedAt", last === undefined ? row.createdAt : last.timestamp);
    entry.set("userId", LOCAL_USER_ID);
    entry.set("hostId", row.hostId);
    entry.set("isTitleEditedByUser", row.title.length > 0);
    entry.set("archivedAt", row.archivedAt);
    map.set(row.chatId, entry);
  }
  return map;
}

function tuiMap(rows: readonly StoredTuiAgent[]): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const row of rows) {
    const entry = new Y.Map<unknown>();
    entry.set("id", row.tuiAgentId);
    entry.set("title", row.title);
    entry.set("parentId", row.parentId);
    entry.set("createdAt", row.createdAt);
    entry.set("updatedAt", row.updatedAt);
    entry.set("userId", LOCAL_USER_ID);
    entry.set("hostId", row.hostId);
    entry.set("harnessId", row.harnessId);
    entry.set("harnessSessionId", row.harnessSessionId);
    entry.set("workspaceFolders", [...row.workspaceFolders]);
    entry.set("workspaceMode", row.workspaceMode);
    entry.set("archivedAt", row.archivedAt);
    entry.set("model", row.model);
    entry.set("reasoningEffort", row.reasoningEffort);
    entry.set("agentMode", row.agentMode);
    entry.set("profileId", row.profileId);
    entry.set("terminalAgentArgs", row.terminalAgentArgs);
    entry.set("terminalShellCommand", row.terminalShellCommand);
    entry.set("terminalShellArgs", row.terminalShellArgs);
    map.set(row.tuiAgentId, entry);
  }
  return map;
}

function sendRoomBootstrap(
  socket: WebSocket,
  epicId: string,
  artifactRoomId: string,
  room: Y.Doc | undefined,
): void {
  if (room === undefined) {
    return;
  }
  sendJson(socket, {
    kind: "artifactRoomState",
    epicId,
    artifactRoomId,
    state: "ready",
    hasBinaryPayload: false,
  });
  const update = Y.encodeStateAsUpdate(room);
  const stateVector = Y.encodeStateVector(room);
  sendFrame(
    socket,
    {
      kind: "artifactRoomSnapshot",
      epicId,
      artifactRoomId,
      hostArtifactRoomStateVectorBase64:
        Buffer.from(stateVector).toString("base64"),
      hasBinaryPayload: true,
    },
    update,
  );
}

export function earlyMetaForEpic(
  runtime: HostRuntime,
  epicId: string,
): EarlyMetaEpic | null {
  const epic = runtime.store.snapshot().epics.find((row) => row.id === epicId);
  if (epic === undefined) {
    return null;
  }
  const light = {
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
  const workspaces = epic.workspaces.map((workspacePath) => ({
    task: { taskId: epic.id, taskType: "epic" as const },
    hostId: runtime.hostId,
    workspacePath,
    createdAt: epic.createdAt,
  }));
  const repos = epic.repos.map((repo) => ({
    task: { taskId: epic.id, taskType: "epic" as const },
    repoIdentifier: repo,
    createdAt: epic.createdAt,
    createdBy: epic.createdBy,
  }));
  return {
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
  };
}

function snapshotMeta(
  runtime: HostRuntime,
  epicId: string,
  stateVector: Uint8Array,
) {
  const epic = runtime.store.snapshot().epics.find((row) => row.id === epicId);
  const meta = earlyMetaForEpic(runtime, epicId);
  return {
    schemaVersion: epic?.version ?? "2.0.0",
    epicLight: meta === null ? null : meta.epicLight,
    permissionRole: "owner",
    repos: meta === null ? [] : meta.repos,
    workspaces: meta === null ? [] : meta.workspaces,
    repoMapping: [],
    workspaceFolders: meta === null ? [] : meta.workspaceFolders,
    unresolvedRepos: [],
    hostStateVectorBase64: Buffer.from(stateVector).toString("base64"),
    roomId: `local:${epicId}`,
  };
}

function projectedEpicTitle(epic: StoredEpic): string {
  if (epic.title.length > 0) {
    return epic.title;
  }
  return titleFromPrompt(epic.initialUserPrompt);
}

function broadcastFrame(
  session: EpicSession,
  envelope: unknown,
  binary: Uint8Array,
): void {
  for (const socket of session.sockets) {
    sendFrame(socket, envelope, binary);
  }
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
