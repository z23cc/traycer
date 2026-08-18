import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { artifactBodyFragmentName } from "@traycer/protocol/persistence/epic/artifacts";

export type StoredArtifactRoom = {
  readonly id: string;
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
};

type RoomAddedListener = (room: StoredArtifactRoom) => void;

const MAX_ARTIFACTS_PER_ROOM = 100;

export class ArtifactRoomManager {
  private readonly rooms = new Map<string, StoredArtifactRoom>();
  private readonly roomAddedListeners = new Set<RoomAddedListener>();
  private disposed = false;
  private scanning = false;
  private rescanRequested = false;

  constructor(private readonly rootDoc: Y.Doc) {
    this.rootDoc.on("update", this.handleRootUpdate);
    this.rescanRootReferences();
  }

  listRooms(): readonly StoredArtifactRoom[] {
    return [...this.rooms.values()];
  }

  getRoom(roomId: string): StoredArtifactRoom | null {
    return this.rooms.get(roomId) ?? null;
  }

  assignArtifactRoomForCreate(artifactId: string): string {
    if (this.disposed) {
      throw new Error("Artifact room manager is disposed");
    }
    const reusableRoomId = this.findReusableRoomId();
    const roomId = reusableRoomId ?? randomUUID();
    let room = this.rooms.get(roomId);
    let added = false;
    if (room === undefined) {
      room = createRoom(roomId);
      this.rooms.set(roomId, room);
      added = true;
    }
    if (reusableRoomId === null) {
      this.appendMetadataRoomId(roomId);
    }
    room.doc.getXmlFragment(artifactBodyFragmentName(artifactId));
    if (added) {
      this.emitRoomAdded(room);
    }
    return roomId;
  }

  clearBody(roomId: string, artifactId: string): void {
    const room = this.rooms.get(roomId);
    if (room === undefined) {
      return;
    }
    const fragment = room.doc.getXmlFragment(
      artifactBodyFragmentName(artifactId),
    );
    if (fragment.length === 0) {
      return;
    }
    room.doc.transact(() => {
      fragment.delete(0, fragment.length);
    });
  }

  onRoomAdded(listener: RoomAddedListener): () => void {
    this.roomAddedListeners.add(listener);
    return () => {
      this.roomAddedListeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.rootDoc.off("update", this.handleRootUpdate);
    this.roomAddedListeners.clear();
    for (const room of this.rooms.values()) {
      room.doc.destroy();
    }
    this.rooms.clear();
  }

  private readonly handleRootUpdate = (): void => {
    this.rescanRootReferences();
  };

  private rescanRootReferences(): void {
    if (this.disposed) {
      return;
    }
    if (this.scanning) {
      this.rescanRequested = true;
      return;
    }
    do {
      this.rescanRequested = false;
      this.scanning = true;
      try {
        this.scanRootReferences();
      } finally {
        this.scanning = false;
      }
    } while (this.rescanRequested && !this.disposed);
  }

  private scanRootReferences(): void {
    if (this.disposed) {
      return;
    }
    const references = artifactRoomReferences(this.rootDoc);
    const added: StoredArtifactRoom[] = [];
    for (const roomId of references.keys()) {
      if (this.rooms.has(roomId)) {
        continue;
      }
      const room = createRoom(roomId);
      this.rooms.set(roomId, room);
      added.push(room);
    }
    for (const [roomId, artifactIds] of references) {
      const room = this.rooms.get(roomId);
      if (room === undefined) {
        continue;
      }
      for (const artifactId of artifactIds) {
        room.doc.getXmlFragment(artifactBodyFragmentName(artifactId));
      }
    }
    for (const room of added) {
      this.emitRoomAdded(room);
    }
    this.repairRoomlessArtifacts();
  }

  private emitRoomAdded(room: StoredArtifactRoom): void {
    for (const listener of this.roomAddedListeners) {
      try {
        listener(room);
      } catch {
        this.roomAddedListeners.delete(listener);
      }
    }
  }

  private findReusableRoomId(): string | null {
    const artifactCounts = artifactCountsByRoom(this.rootDoc);
    for (const roomId of metadataRoomIds(this.rootDoc)) {
      if ((artifactCounts.get(roomId) ?? 0) < MAX_ARTIFACTS_PER_ROOM) {
        return roomId;
      }
    }
    return null;
  }

  private appendMetadataRoomId(roomId: string): void {
    const meta = this.rootDoc.getMap<unknown>("meta");
    const stored = meta.get("artifactRoomIds");
    if (stringValues(stored).includes(roomId)) {
      return;
    }
    this.rootDoc.transact(() => {
      if (stored instanceof Y.Array) {
        stored.push([roomId]);
        return;
      }
      const roomIds = new Y.Array<string>();
      meta.set("artifactRoomIds", roomIds);
      roomIds.push([...stringValues(stored), roomId]);
    });
  }

  private repairRoomlessArtifacts(): void {
    const artifacts = this.rootDoc.getMap<unknown>("epic").get("artifacts");
    if (!(artifacts instanceof Y.Map)) {
      return;
    }
    for (const [artifactId, value] of artifacts) {
      if (!(value instanceof Y.Map) || value.has("content")) {
        continue;
      }
      const currentRoomId = value.get("artifactRoomId");
      if (typeof currentRoomId === "string" && currentRoomId.length > 0) {
        continue;
      }
      const roomId = this.assignArtifactRoomForCreate(artifactId);
      this.rootDoc.transact(() => {
        value.set("artifactRoomId", roomId);
      });
    }
  }
}

function createRoom(roomId: string): StoredArtifactRoom {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  awareness.setLocalState(null);
  return { id: roomId, doc, awareness };
}

function artifactRoomReferences(rootDoc: Y.Doc): Map<string, Set<string>> {
  const references = new Map<string, Set<string>>();
  for (const roomId of metadataRoomIds(rootDoc)) {
    references.set(roomId, new Set());
  }

  const artifacts = rootDoc.getMap<unknown>("epic").get("artifacts");
  if (!(artifacts instanceof Y.Map)) {
    return references;
  }
  for (const [artifactId, value] of artifacts) {
    if (!(value instanceof Y.Map)) {
      continue;
    }
    const roomId = value.get("artifactRoomId");
    if (typeof roomId !== "string" || roomId.length === 0) {
      continue;
    }
    const artifactIds = references.get(roomId) ?? new Set<string>();
    artifactIds.add(artifactId);
    references.set(roomId, artifactIds);
  }
  return references;
}

function metadataRoomIds(rootDoc: Y.Doc): string[] {
  return stringValues(rootDoc.getMap<unknown>("meta").get("artifactRoomIds"));
}

function artifactCountsByRoom(rootDoc: Y.Doc): Map<string, number> {
  const counts = new Map<string, number>();
  const artifacts = rootDoc.getMap<unknown>("epic").get("artifacts");
  if (!(artifacts instanceof Y.Map)) {
    return counts;
  }
  for (const value of artifacts.values()) {
    if (!(value instanceof Y.Map)) {
      continue;
    }
    const roomId = value.get("artifactRoomId");
    if (typeof roomId !== "string" || roomId.length === 0) {
      continue;
    }
    counts.set(roomId, (counts.get(roomId) ?? 0) + 1);
  }
  return counts;
}

function stringValues(value: unknown): string[] {
  const values = value instanceof Y.Array ? value.toArray() : value;
  if (!Array.isArray(values)) {
    return [];
  }
  return values.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
}
