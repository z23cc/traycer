import type { WebSocket } from "ws";
import {
  worktreeDeleteBatchByPathOpenRequestSchemaV11,
  type WorktreeDeleteBatchTargetV11,
} from "@traycer/protocol/host/worktree-delete-batch-stream";
import {
  worktreeDeleteByPathOpenRequestSchemaV11,
  worktreeDeleteByPathOpenRequestSchemaV12,
} from "@traycer/protocol/host/worktree-delete-stream";
import type { HostRuntime } from "../runtime";
import {
  runWorktreeDelete,
  type DeleteEvent,
  type DeleteTarget,
} from "../worktree/delete-stream";

/** `holders` on `failed` lands at `@1.1`; a `@1.0` client never sees it. */
const HOLDERS_MINOR = 1;
/** `expectedHoldersRevision` is accepted and ignored from `@1.2`. */
const CONSENT_MINOR = 2;

/**
 * `worktree.deleteByPath` - one target, one socket, frames as it goes.
 */
export async function serveWorktreeDelete(
  socket: WebSocket,
  runtime: HostRuntime,
  params: unknown,
  minor: number,
): Promise<boolean> {
  const target = readSingleTarget(params, minor);
  if (target === null) {
    return false;
  }
  const send = (frame: unknown): void => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
  };
  await runWorktreeDelete(runtime, target, (event) => {
    send(singleFrame(event, minor));
  });
  return true;
}

function readSingleTarget(params: unknown, minor: number): DeleteTarget | null {
  // `@1.2`'s refine requires `stopOwners: true` alongside a consent revision,
  // so a legitimate 1.2 request only parses against its own schema.
  const parsed =
    minor >= CONSENT_MINOR
      ? worktreeDeleteByPathOpenRequestSchemaV12.safeParse(params)
      : worktreeDeleteByPathOpenRequestSchemaV11.safeParse(params);
  if (!parsed.success) {
    return null;
  }
  return {
    worktreePath: parsed.data.worktreePath,
    scripts: parsed.data.scripts,
    stopOwners: parsed.data.stopOwners,
  };
}

function singleFrame(event: DeleteEvent, minor: number): unknown {
  if (event.kind !== "failed") {
    return { ...event, hasBinaryPayload: false };
  }
  return {
    kind: "failed",
    reason: event.reason,
    hasBinaryPayload: false,
    // Below `@1.1` the frame has only `reason`, and `holdersRevision` /
    // `WORKTREE_HOLDERS_CHANGED` are never emitted at any minor: consent now
    // covers the worktree rather than a holder snapshot.
    ...(minor >= HOLDERS_MINOR && event.busy
      ? { holders: event.holders, code: "WORKTREE_BUSY" }
      : {}),
  };
}

type CommandRecord = {
  readonly frames: unknown[];
  readonly sockets: Set<WebSocket>;
  done: boolean;
};

/**
 * `worktree.deleteBatchByPath` - a command OUTLIVES its socket.
 *
 * `observe` re-attaches to a command this process already accepted and carries
 * no targets, so the runner has to live here rather than on the subscriber.
 * Frames are retained for the command's life: an `observe` that arrives after
 * the work finished replays the terminal frame instead of hanging forever on a
 * delete that already happened.
 */
export class WorktreeDeleteCommands {
  private readonly commands = new Map<string, CommandRecord>();

  attach(socket: WebSocket, runtime: HostRuntime, params: unknown): boolean {
    const parsed =
      worktreeDeleteBatchByPathOpenRequestSchemaV11.safeParse(params);
    if (!parsed.success) {
      return false;
    }
    const existing = this.commands.get(parsed.data.commandId);
    if (existing !== undefined) {
      // A repeated `start` is the single-flight case the client-minted UUID
      // exists to make detectable; it observes rather than deleting twice.
      this.replay(existing, socket);
      return true;
    }
    if (parsed.data.mode === "observe") {
      this.send(socket, {
        kind: "command.failed",
        reason: "No such delete command on this host.",
        hasBinaryPayload: false,
      });
      return true;
    }
    const record: CommandRecord = {
      frames: [],
      sockets: new Set([socket]),
      done: false,
    };
    this.commands.set(parsed.data.commandId, record);
    void this.run(runtime, record, parsed.data.targets);
    return true;
  }

  detach(socket: WebSocket): void {
    for (const record of this.commands.values()) {
      record.sockets.delete(socket);
    }
  }

  handleFrame(socket: WebSocket, frame: unknown): boolean {
    if (
      frame === null ||
      typeof frame !== "object" ||
      Reflect.get(frame, "kind") !== "ping"
    ) {
      return false;
    }
    for (const record of this.commands.values()) {
      if (record.sockets.has(socket)) {
        this.send(socket, { kind: "pong", hasBinaryPayload: false });
        return true;
      }
    }
    return false;
  }

  private async run(
    runtime: HostRuntime,
    record: CommandRecord,
    targets: readonly WorktreeDeleteBatchTargetV11[],
  ): Promise<void> {
    for (const target of targets) {
      await runWorktreeDelete(
        runtime,
        {
          worktreePath: target.worktreePath,
          scripts: target.scripts,
          stopOwners: target.stopOwners,
        },
        (event) => {
          this.publish(record, batchFrame(event, target.worktreePath));
        },
      );
    }
    this.publish(record, { kind: "command.complete", hasBinaryPayload: false });
    record.done = true;
  }

  private publish(record: CommandRecord, frame: unknown): void {
    record.frames.push(frame);
    for (const socket of record.sockets) {
      this.send(socket, frame);
    }
  }

  private replay(record: CommandRecord, socket: WebSocket): void {
    for (const frame of record.frames) {
      this.send(socket, frame);
    }
    if (!record.done) {
      record.sockets.add(socket);
    }
  }

  private send(socket: WebSocket, frame: unknown): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
  }
}

function batchFrame(event: DeleteEvent, worktreePath: string): unknown {
  if (event.kind === "failed") {
    return {
      kind: "target.failed",
      worktreePath,
      reason: event.reason,
      hasBinaryPayload: false,
      ...(event.busy ? { holders: event.holders, code: "WORKTREE_BUSY" } : {}),
    };
  }
  return {
    ...event,
    kind: `target.${event.kind}`,
    worktreePath,
    hasBinaryPayload: false,
  };
}
