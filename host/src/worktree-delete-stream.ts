import type { SchemaVersion } from "@traycer/protocol/framework";
import type { StreamMethodFrameEnvelope } from "@traycer/protocol/framework/stream-ws-protocol";
import {
  worktreeDeleteByPathClientFrameSchema,
  worktreeDeleteByPathOpenRequestSchema,
  worktreeDeleteByPathServerFrameSchema,
  type WorktreeDeleteByPathServerFrame,
} from "@traycer/protocol/host/worktree-delete-stream";
import type { HostState } from "./store";
import { WorktreeDeletionService } from "./worktree-deletion-service";

type StreamSend = (data: string | Uint8Array) => void;

export type WorktreeDeleteStreamBinding = {
  readonly method: "worktree.deleteByPath";
  readonly onFrame: (
    envelope: StreamMethodFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ) => void;
  readonly dispose: () => void;
};

export type OpenWorktreeDeleteStreamResult =
  | { readonly accepted: true; readonly binding: WorktreeDeleteStreamBinding }
  | {
      readonly accepted: false;
      readonly code: "E_HOST_UNSUPPORTED" | "E_INVALID_ARGUMENT";
      readonly reason: string;
    };

export function openWorktreeDeleteStream(
  send: StreamSend,
  state: HostState,
  schemaVersion: SchemaVersion,
  params: unknown,
): OpenWorktreeDeleteStreamResult {
  if (schemaVersion.major !== 1 || schemaVersion.minor !== 0) {
    return {
      accepted: false,
      code: "E_HOST_UNSUPPORTED",
      reason: `worktree.deleteByPath ${schemaVersion.major}.${schemaVersion.minor} is not implemented`,
    };
  }
  const parsed = worktreeDeleteByPathOpenRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      accepted: false,
      code: "E_INVALID_ARGUMENT",
      reason: parsed.error.message,
    };
  }

  let disposed = false;
  const emit = (frame: WorktreeDeleteByPathServerFrame): void => {
    if (!disposed) {
      send(JSON.stringify(worktreeDeleteByPathServerFrameSchema.parse(frame)));
    }
  };
  if (parsed.data.scripts !== null) {
    queueMicrotask(() => {
      emit({
        kind: "failed",
        reason:
          "Worktree teardown scripts are not supported by this local host yet.",
        hasBinaryPayload: false,
      });
    });
  } else {
    const service = new WorktreeDeletionService(state.managedWorktreeRoot());
    void service
      .delete(
        {
          worktreePath: parsed.data.worktreePath,
          expectedRepositoryRoot: null,
        },
        {
          isBusy: ({ worktreePath }) => state.isWorktreePathBusy(worktreePath),
          reportEvent: (event) => {
            if (event.kind === "started") {
              emit({
                kind: "started",
                hasTeardown: false,
                hasBinaryPayload: false,
              });
            } else if (event.kind === "phase") {
              emit({
                kind: "phase",
                phase: event.phase,
                hasBinaryPayload: false,
              });
            } else {
              emit({
                kind: "complete",
                deleted: event.deleted,
                hasBinaryPayload: false,
              });
            }
          },
        },
      )
      .catch((error: unknown) => {
        emit({
          kind: "failed",
          reason: error instanceof Error ? error.message : String(error),
          hasBinaryPayload: false,
        });
      });
  }

  return {
    accepted: true,
    binding: {
      method: "worktree.deleteByPath",
      onFrame: (envelope, binaryPayload) => {
        if (binaryPayload !== null) return;
        const clientFrame =
          worktreeDeleteByPathClientFrameSchema.safeParse(envelope);
        if (clientFrame.success && clientFrame.data.kind === "ping") {
          emit({ kind: "pong", hasBinaryPayload: false });
        }
      },
      dispose: () => {
        disposed = true;
      },
    },
  };
}
