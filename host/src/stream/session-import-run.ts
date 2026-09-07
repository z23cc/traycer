import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { SessionImportSelection } from "@traycer/protocol/host/session-import/candidate";
import {
  sessionImportRunOpenRequestSchema,
  type SessionImportOutcome,
} from "@traycer/protocol/host/session-import/run";
import type { HostRuntime } from "../runtime";
import {
  readableProviders,
  readProvider,
  type DiscoveredSession,
  type ProviderRoots,
} from "../session-import/discover";
import { importSession } from "../session-import/import";

/**
 * `sessionImport.run` - one wizard submission's worth of imports.
 *
 * The run outlives the socket, which is the contract's central claim and the
 * reason this lives on the runtime rather than on a connection: a closed tab,
 * a reload, or a quit must not leave half a submission behind. Frames are
 * retained, so a subscribe that arrives mid-run ATTACHES - it replays
 * `started` and every `progress` so far, then follows live. A subscribe that
 * arrives AFTER the run finished starts a new one with its own selections,
 * which is what makes re-submission the resume: everything already brought
 * over comes straight back as `skipped_already_imported`.
 *
 * At most one run at a time, which is what makes an attach unambiguous: a
 * second submission does not queue, it watches the first, and `runId` is how
 * the client tells the run it is watching from the one it asked for. Its own
 * `selections` and `permissionMode` are ignored, per the contract.
 *
 * Nothing resumes across a host restart, also per the contract: re-submitting
 * is the resume, and it is safe because every finished selection comes back
 * as `skipped_already_imported`.
 */
type RunRecord = {
  readonly runId: string;
  readonly total: number;
  /** `progress` frames produced so far, in order, for replay on attach. */
  readonly progress: unknown[];
  readonly sockets: Set<WebSocket>;
  done: number;
  counts: { imported: number; skippedAlreadyImported: number; failed: number };
  complete: unknown | null;
};

export type SessionImportStatus = {
  readonly active: {
    readonly runId: string;
    readonly done: number;
    readonly total: number;
  } | null;
  readonly lastCompleted: {
    readonly runId: string;
    readonly counts: {
      readonly imported: number;
      readonly skippedAlreadyImported: number;
      readonly failed: number;
    };
    readonly at: number;
  } | null;
};

export class SessionImportRuns {
  private current: RunRecord | null = null;
  private last: SessionImportStatus["lastCompleted"] = null;

  constructor(private readonly roots: ProviderRoots) {}

  /**
   * Answers `sessionImport.status`, which exists precisely so a Settings pane
   * can ask "is anything happening" WITHOUT subscribing and thereby attaching
   * to - or starting - a run.
   */
  status(): SessionImportStatus {
    const run = this.current;
    return {
      active:
        run === null || run.complete !== null
          ? null
          : { runId: run.runId, done: run.done, total: run.total },
      lastCompleted: this.last,
    };
  }

  attach(socket: WebSocket, runtime: HostRuntime, params: unknown): boolean {
    const open = sessionImportRunOpenRequestSchema.safeParse(params);
    if (!open.success) {
      return false;
    }
    const held = this.current;
    if (held !== null && held.complete === null) {
      // Attaching: the run in flight decides the total, and this
      // subscription's own selections never enter it.
      this.send(socket, started(held.runId, held.total, true));
      for (const frame of held.progress) {
        this.send(socket, frame);
      }
      held.sockets.add(socket);
      return true;
    }
    const record: RunRecord = {
      runId: randomUUID(),
      total: open.data.selections.length,
      progress: [],
      sockets: new Set([socket]),
      done: 0,
      counts: { imported: 0, skippedAlreadyImported: 0, failed: 0 },
      complete: null,
    };
    this.current = record;
    this.send(socket, started(record.runId, record.total, false));
    void this.run(
      runtime,
      record,
      open.data.selections,
      open.data.permissionMode,
    );
    return true;
  }

  detach(socket: WebSocket): void {
    this.current?.sockets.delete(socket);
  }

  handleFrame(socket: WebSocket, frame: unknown): boolean {
    const run = this.current;
    if (
      run === null ||
      !run.sockets.has(socket) ||
      frame === null ||
      typeof frame !== "object" ||
      Reflect.get(frame, "kind") !== "ping"
    ) {
      return false;
    }
    this.send(socket, { kind: "pong", hasBinaryPayload: false });
    return true;
  }

  private async run(
    runtime: HostRuntime,
    record: RunRecord,
    selections: readonly SessionImportSelection[],
    permissionMode: string,
  ): Promise<void> {
    try {
      await this.importAll(runtime, record, selections, permissionMode);
    } finally {
      // ALWAYS terminal. There is at most one run, so a record left without a
      // `complete` would report itself in flight forever and every later
      // subscribe would attach to it and hang until the host restarted.
      this.finish(record);
    }
  }

  private async importAll(
    runtime: HostRuntime,
    record: RunRecord,
    selections: readonly SessionImportSelection[],
    permissionMode: string,
  ): Promise<void> {
    // The vendors' directories are walked ONCE for the whole submission: a
    // per-selection lookup would re-walk hundreds of files per import.
    const found = locate(this.roots, selections);
    for (const [index, selection] of selections.entries()) {
      // One selection cannot take the submission down with it: an unexpected
      // throw is that selection's `internal_error`, which is the reason the
      // enum carries one, and the rest of the run continues.
      const outcome = await importSession(
        runtime,
        selection,
        permissionMode,
        found.get(keyOf(selection)) ?? null,
      ).catch((error: unknown): SessionImportOutcome => ({
        kind: "failed",
        reason: "internal_error",
        detail: String(error),
      }));
      record.done = index + 1;
      count(record, outcome);
      this.publish(record, {
        kind: "progress",
        runId: record.runId,
        index,
        total: record.total,
        harness: selection.harness,
        nativeSessionId: selection.nativeSessionId,
        outcome,
        hasBinaryPayload: false,
      });
      // One import reads a whole transcript and rewrites the store; yielding
      // between them is what keeps a long submission from stalling terminals.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  private finish(record: RunRecord): void {
    if (record.complete !== null) {
      return;
    }
    const complete = {
      kind: "complete",
      runId: record.runId,
      counts: record.counts,
      hasBinaryPayload: false,
    };
    record.complete = complete;
    // ponytail: in memory, so a host that HAS imported answers `null` after a
    // restart, which the contract reads as "never imported". Persist it beside
    // the store if the Settings summary is ever worth surviving a restart.
    this.last = { runId: record.runId, counts: record.counts, at: Date.now() };
    for (const socket of record.sockets) {
      this.send(socket, complete);
    }
  }

  private publish(record: RunRecord, frame: unknown): void {
    record.progress.push(frame);
    for (const socket of record.sockets) {
      this.send(socket, frame);
    }
  }

  private send(socket: WebSocket, frame: unknown): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
  }
}

function started(runId: string, total: number, attached: boolean): unknown {
  return { kind: "started", runId, total, attached, hasBinaryPayload: false };
}

function count(record: RunRecord, outcome: SessionImportOutcome): void {
  if (outcome.kind === "imported") {
    record.counts = {
      ...record.counts,
      imported: record.counts.imported + 1,
    };
    return;
  }
  if (outcome.kind === "skipped_already_imported") {
    record.counts = {
      ...record.counts,
      skippedAlreadyImported: record.counts.skippedAlreadyImported + 1,
    };
    return;
  }
  record.counts = { ...record.counts, failed: record.counts.failed + 1 };
}

/**
 * Every selected session, found by walking only the providers the submission
 * actually names. `updatedAfter` is null here on purpose: the user picked
 * these rows, so a scan window that has since moved must not hide one.
 */
function locate(
  roots: ProviderRoots,
  selections: readonly SessionImportSelection[],
): Map<string, DiscoveredSession> {
  const wanted = new Set(selections.map((selection) => selection.harness));
  const found = new Map<string, DiscoveredSession>();
  for (const harness of readableProviders(roots)) {
    const root = roots.get(harness);
    if (root === undefined || !wanted.has(harness)) {
      continue;
    }
    try {
      for (const session of readProvider(harness, root, null)) {
        found.set(
          keyOf({
            harness,
            nativeSessionId: session.candidate.nativeSessionId,
          }),
          session,
        );
      }
    } catch {
      // A provider that will not walk leaves its selections unlocated, and
      // each one fails on its own terms rather than taking the run down.
      continue;
    }
  }
  return found;
}

function keyOf(selection: SessionImportSelection): string {
  return `${selection.harness}:${selection.nativeSessionId}`;
}
