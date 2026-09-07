import type { WebSocket } from "ws";
import type {
  EpicArtifactRecord,
  EpicCommentThreadRecord,
} from "@traycer/protocol/host/epic/state-subscribe";
import { visibleClaims } from "../agent/roles";
import { commentThreadWire } from "../epic/comments";
import type { HostRuntime } from "../runtime";
import type { StoredArtifact, StoredCommentThread } from "../store/host-store";

/**
 * `epic.state.subscribe` - the epic's RECORDS lane.
 *
 * The four row populations the lane owns all already exist on this host, each
 * behind the projection its own reader uses: artifacts and comment threads are
 * the same rows `epic.subscribe` and `epic.listCommentThreads` serve, and role
 * claims come from `projectVisibleRoleClaims`, which the contract names as the
 * intended producer. Nothing here is derived a second way.
 *
 * ponytail: snapshot-only - the lane answers every open with a fresh
 * `basis: "cold"` snapshot and never emits a delta, so a row that changes
 * reaches a client on its next subscribe rather than immediately. A delta needs
 * a durable per-epic commit journal (`seq` must survive a restart to be a
 * resume cursor at all), which is a store this host does not keep; add one and
 * the frames follow. A resume offer is answered the same way, which the
 * contract states is legal precisely because serving deltas across a host
 * restart would need that journal.
 */
export class EpicStateSubscriber {
  constructor(
    private readonly socket: WebSocket,
    private readonly runtime: HostRuntime,
    private readonly epicId: string,
  ) {}

  seed(): void {
    const state = this.runtime.store.snapshot();
    const epic = state.epics.find((row) => row.id === this.epicId);
    const claims = visibleClaims(this.runtime, this.epicId);
    this.send({
      kind: "snapshot",
      hasBinaryPayload: false,
      // The same replica identity `epic.status.subscribe` mints, so the two
      // lanes cannot disagree about which replica a client is attached to.
      authorityEpoch: `oss:${this.runtime.hostId}`,
      // Nothing has been committed on this lane, which is what position 0 says.
      position: 0,
      basis: "cold",
      // A local host serves its own replica and reconciles with no cloud. The
      // contract calls this a freshness label, not an error.
      reconciledWithCloud: false,
      epicMeta: {
        revision: epic?.updatedAt ?? 0,
        meta: { title: epic?.title ?? "", updatedAt: epic?.updatedAt ?? 0 },
      },
      artifactRecords: state.artifacts
        .filter((row) => row.epicId === this.epicId)
        .map(artifactRecord),
      // Deletion removes the row outright here, so there is no tombstone to
      // report and an empty list is the whole truth.
      deletedArtifacts: [],
      roleClaims: {
        // The SET's revision, per the contract: a claim is created and
        // destroyed but never updated, so the newest claim dates the set.
        revision: claims.reduce(
          (latest, claim) => Math.max(latest, claim.claimedAt),
          0,
        ),
        claims,
      },
      commentThreads: state.commentThreads
        .filter((row) => row.epicId === this.epicId)
        .map(commentThreadRecord),
    });
  }

  pong(): void {
    this.send({ kind: "pong", hasBinaryPayload: false });
  }

  private send(frame: unknown): void {
    if (this.socket.readyState !== this.socket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(frame));
  }
}

/**
 * `StoredArtifact` as a lane row. `artifactRoomId` is omitted by the lane's own
 * schema - a records frame carries no body routing - and the stored
 * ticket/story fields are nullable where the wire's are not, so they coalesce
 * exactly as the `epic.subscribe` map does.
 */
function artifactRecord(row: StoredArtifact): EpicArtifactRecord {
  const base = {
    id: row.artifactId,
    folderName: row.folderName,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdManually: true,
    parentId: row.parentId,
    revision: row.updatedAt,
  };
  if (row.kind === "ticket" || row.kind === "story") {
    return {
      ...base,
      kind: row.kind,
      status: ticketStatus(row.status),
      assignee: row.assignee ?? "",
    };
  }
  return { ...base, kind: row.kind === "review" ? "review" : "spec" };
}

/**
 * The stored column is a plain number because that is what the store persists;
 * the wire vocabulary is `0 | 1 | 2` and only ever written from it, so anything
 * else - `null` included - reads as the same "not started" the `epic.subscribe`
 * map coalesces to.
 */
function ticketStatus(value: number | null): 0 | 1 | 2 {
  if (value === 1) return 1;
  if (value === 2) return 2;
  return 0;
}

function commentThreadRecord(
  row: StoredCommentThread,
): EpicCommentThreadRecord {
  return {
    ...commentThreadWire(row),
    artifactId: row.artifactId,
    // A thread has no stored `updatedAt`; its latest comment dates it, and a
    // thread with none is dated by its own creation.
    revision: row.comments.reduce(
      (latest, comment) =>
        Math.max(latest, comment.updatedAt ?? comment.createdAt),
      row.createdAt,
    ),
  };
}
