import type { WebSocket } from "ws";
import type {
  EpicArtifactRecord,
  EpicCommentThreadRecord,
  EpicDeletedArtifactRecord,
  EpicMeta,
} from "@traycer/protocol/host/epic/state-subscribe";
import type { RoleClaim } from "@traycer/protocol/persistence/epic/role-claims";
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
/** The four row populations the lane owns, as one comparable value. */
type LaneRows = {
  readonly epicMeta: { readonly revision: number; readonly meta: EpicMeta };
  readonly artifacts: readonly EpicArtifactRecord[];
  readonly claims: {
    readonly revision: number;
    readonly claims: readonly RoleClaim[];
  };
  readonly threads: readonly EpicCommentThreadRecord[];
};

export function laneRows(runtime: HostRuntime, epicId: string): LaneRows {
  const state = runtime.store.snapshot();
  const epic = state.epics.find((row) => row.id === epicId);
  const claims = visibleClaims(runtime, epicId);
  return {
    epicMeta: {
      revision: epic?.updatedAt ?? 0,
      meta: { title: epic?.title ?? "", updatedAt: epic?.updatedAt ?? 0 },
    },
    artifacts: state.artifacts
      .filter((row) => row.epicId === epicId)
      .map(artifactRecord),
    claims: {
      // The SET's revision, per the contract: a claim is created and destroyed
      // but never updated, so the newest claim dates the set.
      revision: claims.reduce(
        (latest, claim) => Math.max(latest, claim.claimedAt),
        0,
      ),
      claims,
    },
    threads: state.commentThreads
      .filter((row) => row.epicId === epicId)
      .map(commentThreadRecord),
  };
}

export class EpicStateSubscriber {
  private sent: LaneRows | null = null;

  constructor(
    private readonly socket: WebSocket,
    private readonly runtime: HostRuntime,
    readonly epicId: string,
  ) {}

  seed(position: number): void {
    const rows = laneRows(this.runtime, this.epicId);
    this.sent = rows;
    this.send({
      kind: "snapshot",
      hasBinaryPayload: false,
      authorityEpoch: this.runtime.authorityEpoch,
      // The lane's CURRENT high-water mark, not zero: a delta minted before
      // this frame reached the client would otherwise look already-contained
      // and be dropped.
      position,
      basis: "cold",
      // A local host serves its own replica and reconciles with no cloud. The
      // contract calls this a freshness label, not an error.
      reconciledWithCloud: false,
      epicMeta: rows.epicMeta,
      artifactRecords: rows.artifacts,
      // Deletion removes the row outright here, so a snapshot has no tombstone
      // to carry and an empty list is the whole truth.
      deletedArtifacts: [],
      roleClaims: rows.claims,
      commentThreads: rows.threads,
    });
  }

  /**
   * Emits one commit for whatever changed since the last frame, or nothing.
   * Returns whether a position was consumed - an empty envelope is refused by
   * the contract precisely because it would burn a cursor for a non-event.
   */
  publish(seq: number): boolean {
    const held = this.sent;
    if (held === null) {
      return false;
    }
    const rows = laneRows(this.runtime, this.epicId);
    const artifactUpserts = rows.artifacts.filter(
      (row) => !held.artifacts.some((was) => same(was, row)),
    );
    // A deleted row is gone from state, so its tombstone can only be read off
    // the projection we last sent.
    const artifactTombstones = held.artifacts
      .filter((was) => !rows.artifacts.some((row) => row.id === was.id))
      .map((was) => tombstoneOf(was, new Date().toISOString()));
    const commentThreadUpserts = rows.threads.filter(
      (row) => !held.threads.some((was) => same(was, row)),
    );
    const commentThreadRemovals = held.threads
      .filter(
        (was) =>
          !rows.threads.some(
            (row) =>
              row.threadId === was.threadId &&
              row.artifactId === was.artifactId,
          ),
      )
      .map((was) => ({
        artifactId: was.artifactId,
        threadId: was.threadId,
        revision: was.revision,
      }));
    const epicMeta = same(held.epicMeta, rows.epicMeta) ? null : rows.epicMeta;
    const roleClaims = same(held.claims, rows.claims) ? null : rows.claims;
    this.sent = rows;
    if (
      artifactUpserts.length === 0 &&
      artifactTombstones.length === 0 &&
      commentThreadUpserts.length === 0 &&
      commentThreadRemovals.length === 0 &&
      epicMeta === null &&
      roleClaims === null
    ) {
      return false;
    }
    this.send({
      kind: "delta",
      hasBinaryPayload: false,
      authorityEpoch: this.runtime.authorityEpoch,
      seq,
      artifactUpserts,
      artifactTombstones,
      commentThreadUpserts,
      commentThreadRemovals,
      epicMeta,
      roleClaims,
    });
    return true;
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
 * Every subscriber, and the lane position they share.
 *
 * One counter for the whole host rather than one per epic: the contract asks
 * only that a position strictly increase within its epoch, and a single
 * counter satisfies that for every epic at once without a map to keep.
 */
export class EpicStateHub {
  private readonly subscribers = new Map<WebSocket, EpicStateSubscriber>();
  private position = 0;

  add(socket: WebSocket, subscriber: EpicStateSubscriber): void {
    this.subscribers.set(socket, subscriber);
    subscriber.seed(this.position);
  }

  remove(socket: WebSocket): void {
    this.subscribers.delete(socket);
  }

  /**
   * Called after every store commit. Each subscriber decides for itself whether
   * its epic changed, so a chat turn - which mutates the store constantly and
   * touches none of this lane's rows - moves nothing.
   */
  publish(): void {
    const next = this.position + 1;
    let consumed = false;
    for (const subscriber of this.subscribers.values()) {
      consumed = subscriber.publish(next) || consumed;
    }
    if (consumed) {
      this.position = next;
    }
  }

  handleFrame(socket: WebSocket, frame: unknown): boolean {
    const subscriber = this.subscribers.get(socket);
    if (
      subscriber === undefined ||
      frame === null ||
      typeof frame !== "object" ||
      Reflect.get(frame, "kind") !== "ping"
    ) {
      return false;
    }
    subscriber.pong();
    return true;
  }
}

/**
 * Both sides are built by `laneRows`, so key order is fixed and a string
 * compare is a value compare here.
 */
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * The store deletes a row outright, so a tombstone is minted from the
 * projection we last sent plus the moment we noticed - there is no recorded
 * deletion time to read back.
 */
function tombstoneOf(
  row: EpicArtifactRecord,
  deletedAt: string,
): EpicDeletedArtifactRecord {
  const base = {
    id: row.id,
    title: row.title,
    deletedAt,
    revision: row.revision,
  };
  if (row.kind === "ticket" || row.kind === "story") {
    return { ...base, kind: row.kind, status: row.status };
  }
  return { ...base, kind: row.kind };
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
