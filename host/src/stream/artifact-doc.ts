import { Buffer } from "node:buffer";
import * as Y from "yjs";
import type { WebSocket } from "ws";
import { artifactSubscribeOpenRequestSchemaV10 } from "@traycer/protocol/host/epic/artifact-subscribe";
import type { HostRuntime } from "../runtime";

/**
 * `artifact.subscribe` - the DOC lane: one artifact body, bidirectionally
 * synced, and the only lane carrying binary payloads.
 *
 * The body is the room `Y.Doc` `epic.subscribe` already serves, viewed per
 * artifact. Nothing is stored a second time.
 *
 * ponytail: a seed offer is ignored and every attach gets a FULL seed. The
 * contract makes that safe by construction - absence of `seededFromOffer` means
 * "full seed", every non-delta case is deliberately indistinguishable, and a
 * full seed is always installable. Answering the offer with
 * `Y.encodeStateAsUpdate(doc, theirVector)` is the only thing that would make
 * a reattach cheaper; add it when a body is large enough to notice.
 */
export class ArtifactDocLane {
  private guid = "";
  private roomId = "";
  private doc: Y.Doc | null = null;

  constructor(
    private readonly socket: WebSocket,
    private readonly runtime: HostRuntime,
    readonly epicId: string,
    readonly artifactId: string,
  ) {}

  async open(params: unknown): Promise<boolean> {
    const parsed = artifactSubscribeOpenRequestSchemaV10.safeParse(params);
    if (!parsed.success) {
      return false;
    }
    // The attach names the epic replica it was made under. An epoch this
    // process is not serving voids the client's whole epic view, so it is told
    // to re-read the records lane rather than handed a body from a replica it
    // does not know about.
    if (parsed.data.authorityEpoch !== this.runtime.authorityEpoch) {
      this.unavailable(
        "staleAuthorityEpoch",
        "This host is serving a different epic replica.",
        true,
      );
      return true;
    }
    const found = await this.runtime.epics.bodyRoom(
      this.runtime,
      this.epicId,
      this.artifactId,
    );
    if (found === null) {
      this.unavailable(
        "artifactNotFound",
        "No such artifact under this epic.",
        true,
      );
      return true;
    }
    this.roomId = found.roomId;
    this.doc = found.room;
    this.guid = docGuidOf(found.roomId, this.artifactId);
    this.sendDoc(found.room);
    return true;
  }

  /**
   * A local edit from the client. `docGuid` is the WRITE-path generation guard:
   * an update naming a guid this lane is not serving describes a document the
   * host no longer has, and merging it would resurrect replaced content.
   */
  applyUpdate(docGuid: string, bytes: Uint8Array): void {
    const room = this.doc;
    if (docGuid !== this.guid || room === null) {
      return;
    }
    Y.applyUpdate(room, bytes);
    this.runtime.epics.persistRoom(this.runtime, this.epicId, this.roomId);
    this.send({
      kind: "docAck",
      authorityEpoch: this.runtime.authorityEpoch,
      artifactId: this.artifactId,
      docGuid: this.guid,
      coverageStateVectorBase64: base64(Y.encodeStateVector(room)),
      hasBinaryPayload: false,
    });
    this.runtime.artifactDocs.relay(
      this,
      {
        kind: "docUpdate",
        authorityEpoch: this.runtime.authorityEpoch,
        artifactId: this.artifactId,
        docGuid: this.guid,
        hasBinaryPayload: true,
      },
      bytes,
    );
  }

  /** Carets and selections: fire-and-forget, stored nowhere, loss is correct. */
  awareness(bytes: Uint8Array): void {
    this.runtime.artifactDocs.relay(
      this,
      {
        kind: "awareness",
        authorityEpoch: this.runtime.authorityEpoch,
        artifactId: this.artifactId,
        hasBinaryPayload: true,
      },
      bytes,
    );
  }

  pong(): void {
    this.send({ kind: "pong", hasBinaryPayload: false });
  }

  deliver(frame: unknown, bytes: Uint8Array): void {
    this.sendWithBytes(frame, bytes);
  }

  private sendDoc(room: Y.Doc): void {
    const update = Y.encodeStateAsUpdate(room);
    this.sendWithBytes(
      {
        kind: "doc",
        authorityEpoch: this.runtime.authorityEpoch,
        artifactId: this.artifactId,
        docGuid: this.guid,
        // The host's vector AFTER these bytes: the client's coverage watermark
        // for this body.
        stateVectorBase64: base64(Y.encodeStateVector(room)),
        hasBinaryPayload: true,
      },
      update,
    );
  }

  private unavailable(
    code: "staleAuthorityEpoch" | "artifactNotFound" | "bodyUnavailable",
    reason: string,
    terminal: boolean,
  ): void {
    this.send({
      kind: "unavailable",
      authorityEpoch: this.runtime.authorityEpoch,
      artifactId: this.artifactId,
      code,
      reason,
      terminal,
      hasBinaryPayload: false,
    });
  }

  private send(frame: unknown): void {
    if (this.socket.readyState !== this.socket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(frame));
  }

  private sendWithBytes(frame: unknown, bytes: Uint8Array): void {
    if (this.socket.readyState !== this.socket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(frame));
    this.socket.send(bytes);
  }
}

/**
 * Every open tile. A body edited in one tile has to reach the others, and the
 * sender is excluded because its own edit is already applied locally - echoing
 * it back is the round trip `docAck` exists to avoid.
 */
export class ArtifactDocHub {
  private readonly lanes = new Map<WebSocket, ArtifactDocLane>();

  add(socket: WebSocket, lane: ArtifactDocLane): void {
    this.lanes.set(socket, lane);
  }

  remove(socket: WebSocket): void {
    this.lanes.delete(socket);
  }

  relay(from: ArtifactDocLane, frame: unknown, bytes: Uint8Array): void {
    for (const lane of this.lanes.values()) {
      if (
        lane === from ||
        lane.epicId !== from.epicId ||
        lane.artifactId !== from.artifactId
      ) {
        continue;
      }
      lane.deliver(frame, bytes);
    }
  }
}

/**
 * Stable per body, and different after a delete-and-recreate: the room id is
 * minted per artifact and a recreated artifact gets a new one, which is exactly
 * the "is my replica the same document as yours" question the guid answers.
 */
function docGuidOf(roomId: string, artifactId: string): string {
  return `${roomId}:${artifactId}`;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
