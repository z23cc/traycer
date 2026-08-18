import { randomUUID } from "node:crypto";
import type { RuntimeEvent } from "@traycer/protocol/host/agent/gui/agent-runtime";
import {
  accumulateTurnContent,
  createTurnContentState,
} from "@traycer/protocol/host/agent/gui/agent-runtime-accumulator";
import type {
  AssistantMessage,
  ChatRunSettings,
} from "@traycer/protocol/persistence/epic/schemas";
import { conversationPrompt, latestUserPrompt } from "./prompt";
import type { TurnChunk, TurnRunner } from "./cli-runner";
import { HostState, StoreError, type PendingTurn } from "./store";
import type { ContentBlock } from "@traycer/protocol/persistence/epic/content-blocks";

export type { PendingTurn };

export function launchChatTurn(
  state: HostState,
  runner: TurnRunner,
  pending: PendingTurn,
): void {
  void runChatTurn(state, runner, pending);
}

async function runChatTurn(
  state: HostState,
  runner: TurnRunner,
  pending: PendingTurn,
): Promise<void> {
  const chat = state.getChat(pending.epicId, pending.chatId);
  if (chat === null) {
    state.releaseTurn(pending.epicId, pending.chatId);
    return;
  }
  const startedAt = Date.now();
  const turnId = `turn:${randomUUID()}`;
  const blockId = randomUUID();
  const messageId = randomUUID();
  let contentState = createTurnContentState();
  const emitEvent = (event: RuntimeEvent): void => {
    contentState = accumulateTurnContent(contentState, event);
    emitRuntimeEvent(state, pending.epicId, pending.chatId, event);
  };
  const signal = state.activateTurn({
    epicId: pending.epicId,
    chatId: pending.chatId,
    turn: {
      turnId,
      status: "starting",
      harnessId: pending.settings.harnessId,
      model: pending.settings.model,
      reasoningEffort: pending.settings.reasoningEffort,
      serviceTier: pending.settings.serviceTier,
      agentMode: pending.settings.agentMode,
      profileId: pending.settings.profileId,
      userMessageId: pending.userMessageId,
      startedAt,
      updatedAt: startedAt,
      sameTurnSteeringSupported: false,
    },
  });
  emitTurnState(state, pending.epicId, pending.chatId);
  emitEvent({
    type: "turn.started",
    blockId: turnId,
    timestamp: startedAt,
    turnId,
  });

  const cwd = state.chatCwd(pending.epicId, pending.chatId);
  const existingSession = chat.providerSessionId;
  const prompt =
    existingSession === null
      ? conversationPrompt(chat.messages)
      : latestUserPrompt(chat.messages);
  let text = "";
  const reasoningBlockId = randomUUID();
  try {
    const result = await runner.run(
      {
        harnessId: pending.settings.harnessId,
        model: pending.settings.model,
        permissionMode: pending.settings.permissionMode,
        reasoningEffort: pending.settings.reasoningEffort,
        serviceTier: pending.settings.serviceTier,
        prompt,
        cwd,
        sessionId: existingSession,
        signal,
        traycerAgentEnv: {
          agentId: pending.chatId,
          epicId: pending.epicId,
          cliSurface: "full",
        },
      },
      (chunk) => {
        if (chunk.kind === "text") {
          text += chunk.text;
        }
        handleTurnChunk(state, pending, {
          chunk,
          textBlockId: blockId,
          reasoningBlockId,
          turnId,
          startedAt,
          existingSession,
          emitEvent,
        });
      },
    );
    text = result.text.length > 0 ? result.text : text;
    if (result.sessionId !== null) {
      state.setProviderSession(
        pending.epicId,
        pending.chatId,
        result.sessionId,
      );
    }
    const completedAt = Date.now();
    if (
      text.length > 0 &&
      !contentState.blocks.some(
        (block) => block.type === "text" && block.blockId === blockId,
      )
    ) {
      emitEvent({
        type: "text.delta",
        blockId,
        timestamp: completedAt,
        delta: text,
      });
    }
    if (
      contentState.blocks.some(
        (block) =>
          block.type === "reasoning" && block.blockId === reasoningBlockId,
      )
    ) {
      emitEvent({
        type: "reasoning.completed",
        blockId: reasoningBlockId,
        timestamp: completedAt,
      });
    }
    if (text.length === 0) {
      text = "The agent produced no text.";
      emitEvent({
        type: "text.delta",
        blockId,
        timestamp: completedAt,
        delta: text,
      });
    }
    emitEvent({
      type: "text.completed",
      blockId,
      timestamp: completedAt,
    });
    const stopped = signal.aborted;
    emitEvent(
      stopped
        ? {
            type: "turn.stopped",
            blockId: turnId,
            timestamp: completedAt,
            turnId,
            reason: "stopped",
          }
        : {
            type: "turn.completed",
            blockId: turnId,
            timestamp: completedAt,
            turnId,
          },
    );
    const assistant = assistantMessage({
      messageId,
      chatId: pending.chatId,
      settings: pending.settings,
      blocks: contentState.blocks,
      startedAt,
      timestamp: completedAt,
      turnId,
    });
    state.persistAssistant(pending.epicId, pending.chatId, assistant);
  } catch (error) {
    const failedAt = Date.now();
    const message = error instanceof Error ? error.message : String(error);
    const stopped = signal.aborted;
    const visible = text.length > 0 ? text : message;
    if (text.length === 0) {
      emitEvent({
        type: "text.delta",
        blockId,
        timestamp: failedAt,
        delta: visible,
      });
    }
    if (stopped) {
      emitEvent({
        type: "turn.stopped",
        blockId: turnId,
        timestamp: failedAt,
        turnId,
        reason: "stopped",
      });
    } else {
      emitEvent({
        type: "error",
        blockId: `${blockId}:error`,
        timestamp: failedAt,
        message,
        recoverable: false,
      });
      emitEvent({
        type: "turn.completed",
        blockId: turnId,
        timestamp: failedAt,
        turnId,
        reason: "error",
      });
    }
    const assistant = assistantMessage({
      messageId,
      chatId: pending.chatId,
      settings: pending.settings,
      blocks: contentState.blocks,
      startedAt,
      timestamp: failedAt,
      turnId,
    });
    state.persistAssistant(pending.epicId, pending.chatId, assistant);
  } finally {
    state.finishTurn(pending.epicId, pending.chatId);
    emitTurnState(state, pending.epicId, pending.chatId);
    const latest = state.getChat(pending.epicId, pending.chatId);
    if (latest !== null) {
      state.emitChat(
        pending.epicId,
        pending.chatId,
        state.snapshotFrame(pending.epicId, latest),
      );
    }
    const next = state.startNextQueuedAgentMessage(
      pending.epicId,
      pending.chatId,
    );
    if (next !== null) {
      launchChatTurn(state, runner, next);
    }
  }
}

export function requestStopTurn(
  state: HostState,
  epicId: string,
  chatId: string,
): void {
  if (!state.requestStop(epicId, chatId)) {
    throw new StoreError("E_INVALID_ARGUMENT", "No active turn to stop");
  }
}

function emitTurnState(state: HostState, epicId: string, chatId: string): void {
  const chat = state.getChat(epicId, chatId);
  if (chat === null) {
    return;
  }
  state.emitChat(epicId, chatId, {
    kind: "turnStateChanged",
    hasBinaryPayload: false,
    epicId,
    chatId,
    runStatus: chat.runStatus,
    activeTurn: chat.activeTurn,
    turnInProgress: chat.turnInProgress,
  });
}

function emitRuntimeEvent(
  state: HostState,
  epicId: string,
  chatId: string,
  event: RuntimeEvent,
): void {
  state.emitChat(epicId, chatId, {
    kind: "blockDelta",
    hasBinaryPayload: false,
    epicId,
    chatId,
    event,
  });
}

function handleTurnChunk(
  state: HostState,
  pending: PendingTurn,
  args: {
    readonly chunk: TurnChunk;
    readonly textBlockId: string;
    readonly reasoningBlockId: string;
    readonly turnId: string;
    readonly startedAt: number;
    readonly existingSession: string | null;
    readonly emitEvent: (event: RuntimeEvent) => void;
  },
): void {
  const now = Date.now();
  if (args.chunk.kind === "session") {
    state.setProviderSession(
      pending.epicId,
      pending.chatId,
      args.chunk.sessionId,
    );
    args.emitEvent({
      type:
        args.existingSession === null ? "session.created" : "session.resumed",
      blockId: args.turnId,
      timestamp: now,
      session: {
        id: args.chunk.sessionId,
        harnessId: pending.settings.harnessId,
        createdAt: args.startedAt,
      },
    });
    if (pending.settings.harnessId === "claude") {
      args.emitEvent({
        type: "user_message.anchor_resolved",
        blockId: pending.userMessageId,
        timestamp: now,
        messageId: pending.userMessageId,
        anchor: {
          harnessId: "claude",
          sessionId: args.chunk.sessionId,
          claudeMessageUuid: pending.userMessageId,
        },
      });
    }
    return;
  }
  if (args.chunk.kind === "reasoning") {
    args.emitEvent({
      type: "reasoning.delta",
      blockId: args.reasoningBlockId,
      timestamp: now,
      delta: args.chunk.text,
    });
    return;
  }
  if (args.chunk.kind === "tool_start") {
    args.emitEvent({
      type: "tool_call.started",
      blockId: args.chunk.blockId,
      timestamp: now,
      toolName: args.chunk.name,
      input: args.chunk.input,
      agentMessageSend: null,
      startedAt: now,
    });
    return;
  }
  if (args.chunk.kind === "tool_end") {
    args.emitEvent({
      type: "tool_call.completed",
      blockId: args.chunk.blockId,
      timestamp: now,
      toolName: args.chunk.name,
      agentMessageSend: null,
      imageResults: [],
    });
    return;
  }
  if (args.chunk.kind === "tool_error") {
    args.emitEvent({
      type: "tool_call.errored",
      blockId: args.chunk.blockId,
      timestamp: now,
      toolName: args.chunk.name,
      error: args.chunk.error,
      terminationReason: "error",
      agentMessageSend: null,
    });
    return;
  }
  if (args.chunk.kind === "command_start") {
    args.emitEvent({
      type: "command.started",
      blockId: args.chunk.blockId,
      timestamp: now,
      command: args.chunk.command,
      cwd: args.chunk.cwd,
    });
    return;
  }
  if (args.chunk.kind === "command_end") {
    args.emitEvent({
      type: "command.completed",
      blockId: args.chunk.blockId,
      timestamp: now,
      command: args.chunk.command,
      ...(args.chunk.exitCode === null
        ? {}
        : { exitCode: args.chunk.exitCode }),
    });
    return;
  }
  args.emitEvent({
    type: "text.delta",
    blockId: args.textBlockId,
    timestamp: now,
    delta: args.chunk.text,
  });
}

function assistantMessage(args: {
  readonly messageId: string;
  readonly chatId: string;
  readonly settings: ChatRunSettings;
  readonly blocks: ContentBlock[];
  readonly startedAt: number;
  readonly timestamp: number;
  readonly turnId: string;
}): AssistantMessage {
  return {
    role: "assistant",
    messageId: args.messageId,
    sender: {
      type: "agent",
      harnessId: args.settings.harnessId,
      agentId: args.settings.model,
      displayName: args.settings.model,
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: args.blocks,
    startedAt: args.startedAt,
    timestamp: args.timestamp,
    turnId: args.turnId,
    usage: null,
    reasoningEffort: args.settings.reasoningEffort,
    serviceTier: args.settings.serviceTier,
    imageResolutions: [],
  };
}
