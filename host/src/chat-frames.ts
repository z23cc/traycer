import { randomUUID } from "node:crypto";
import { chatSubscribeClientFrameSchema } from "@traycer/protocol/host/agent/gui/subscribe";
import type { TurnRunner } from "./cli-runner";
import { HostState, StoreError } from "./store";
import { launchChatTurn, requestStopTurn } from "./turn";
import { materializeWorktreeIntentOrThrow } from "./worktree-intent";

export function handleChatClientFrame(
  state: HostState,
  runner: TurnRunner,
  epicId: string,
  chatId: string,
  raw: unknown,
): void {
  const parsed = chatSubscribeClientFrameSchema.safeParse(raw);
  if (!parsed.success) {
    return;
  }
  const frame = parsed.data;
  if (frame.kind === "stop") {
    try {
      requestStopTurn(state, epicId, chatId);
      ack(
        state,
        epicId,
        chatId,
        frame.clientActionId,
        "stop",
        "accepted",
        null,
        null,
      );
    } catch (error) {
      const message =
        error instanceof StoreError ? error.message : String(error);
      ack(
        state,
        epicId,
        chatId,
        frame.clientActionId,
        "stop",
        "rejected",
        message,
        "RPC_ERROR",
      );
      state.emitChat(epicId, chatId, {
        kind: "errorNotice",
        hasBinaryPayload: false,
        epicId,
        chatId,
        notice: {
          code: "NO_ACTIVE_TURN",
          message,
          severity: "warning",
          clientActionId: frame.clientActionId,
        },
      });
    }
    return;
  }
  if (frame.kind !== "send") {
    if ("clientActionId" in frame) {
      ack(
        state,
        epicId,
        chatId,
        frame.clientActionId,
        frame.kind,
        "rejected",
        `${frame.kind} is not implemented on this local host yet`,
        "RPC_ERROR",
      );
    }
    return;
  }
  void state.withSerializedChatAction(epicId, chatId, async () => {
    try {
      await materializeWorktreeIntentOrThrow(state, {
        epicId,
        ownerId: chatId,
        ownerKind: "chat",
        workspaceMode: undefined,
        intent: frame.worktreeIntent,
        wrapThrownErrors: true,
      });
      const accepted = state.acceptUser({
        epicId,
        chatId,
        messageId: frame.messageId,
        content: frame.content,
        sender: frame.sender,
        settings: frame.settings,
      });
      if (frame.worktreeIntent === null) {
        const chat = state.getChat(epicId, chatId);
        state.emitChat(epicId, chatId, {
          kind: "worktreeStateChanged",
          hasBinaryPayload: false,
          epicId,
          chatId,
          worktreeBinding: chat?.worktreeBinding ?? null,
          missingWorktreePaths:
            chat === null
              ? []
              : state.missingWorktreePaths(chat.worktreeBinding),
        });
      }
      ack(
        state,
        epicId,
        chatId,
        frame.clientActionId,
        "send",
        "accepted",
        null,
        null,
      );
      state.emitChat(epicId, chatId, {
        kind: "messageAccepted",
        hasBinaryPayload: false,
        epicId,
        chatId,
        message: accepted.user,
      });
      launchChatTurn(state, runner, accepted.pendingTurn);
    } catch (error) {
      const message =
        error instanceof StoreError ? error.message : String(error);
      const code =
        error instanceof StoreError &&
        error.code === "WORKTREE_CREATE_FAILED"
          ? error.code
          : "RPC_ERROR";
      ack(
        state,
        epicId,
        chatId,
        frame.clientActionId,
        "send",
        "rejected",
        message,
        code,
      );
      if (code === "WORKTREE_CREATE_FAILED") {
        state.appendChatEvent(epicId, chatId, {
          eventId: randomUUID(),
          type: "send.failed",
          timestamp: Date.now(),
          clientActionId: frame.clientActionId,
          actor: frame.sender,
          message,
          turnId:
            state.getChat(epicId, chatId)?.activeTurn?.turnId ?? null,
          messageId: frame.messageId,
          queueItemId: null,
          approvalId: null,
          blockId: null,
          severity: "warning",
          metadata: null,
        });
        state.emitChat(epicId, chatId, {
          kind: "errorNotice",
          hasBinaryPayload: false,
          epicId,
          chatId,
          notice: {
            code,
            message,
            severity: "warning",
            clientActionId: frame.clientActionId,
          },
        });
      }
    }
  });
}

function ack(
  state: HostState,
  epicId: string,
  chatId: string,
  clientActionId: string,
  action: string,
  status: "accepted" | "rejected",
  reason: string | null,
  code: string | null,
): void {
  state.emitChat(epicId, chatId, {
    kind: "actionAck",
    hasBinaryPayload: false,
    epicId,
    chatId,
    clientActionId,
    action,
    status,
    reason,
    code,
    backgroundStopTaskIds: [],
  });
}
