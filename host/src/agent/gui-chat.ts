import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  AUTH_ERROR_CODE,
  ENV_CREDENTIAL_AUTH_ERROR_CODE,
} from "@traycer/protocol/host/agent/gui/agent-runtime";
import type { UserMessageAnchorResolvedEvent } from "@traycer/protocol/host/agent/gui/agent-runtime";
import { guiHarnessIdSchema } from "@traycer/protocol/host/agent/shared";
import { assistantRowId } from "@traycer/protocol/persistence/chat-transcript/row-projection";
import type { CheckpointFileOperation } from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import type { ContentBlock } from "@traycer/protocol/persistence/epic/content-blocks";
import { providerIdForHarness } from "../gui/harness-map";
import { envCredentialVarForProvider } from "../providers/service";
import { runGuiPrintTurn } from "../gui/deliver";
import type { QueuedPrompt } from "../gui/queue";
import { LOCAL_USER_ID } from "../local-user";
import type { HostRuntime } from "../runtime";
import type { StoredAgent, StoredChat, StoredTurn } from "../store/host-store";
import { bumpChatIndex } from "../store/host-store";
import type {
  ProviderStreamEvent,
  ProviderTokenUsage,
} from "../gui/provider-stream";
import { notify } from "../gui/notifications";
import { recordUsageFact } from "../gui/usage";
import {
  assistantReasoningBlockId,
  assistantTextBlockId,
  broadcastAccumulatedChanges,
  broadcastBlockDelta,
  broadcastChatSnapshot,
  broadcastEventAppended,
  broadcastQueueChanged,
  broadcastTurnStateChanged,
} from "../stream/chat";

const MAX_HISTORY_CHARS = 80_000;

export type GuiUserTurnInput = {
  readonly epicId: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly prompt: string;
  readonly content: unknown;
  readonly userId: string;
  readonly harnessId: string;
  readonly runSettings: unknown | null;
};

export async function persistGuiUserTurn(
  runtime: HostRuntime,
  input: GuiUserTurnInput,
): Promise<StoredTurn | null> {
  const now = Date.now();
  const turn: StoredTurn = {
    messageId: input.messageId,
    timestamp: now,
    role: "user",
    prompt: input.prompt,
    fromAgentId: input.chatId,
    fromTitle: input.userId,
    fromHarnessId: input.harnessId,
    expectReply: true,
    responseId: null,
    userId: input.userId,
    content: input.content,
    turnId: null,
    blocks: null,
  };
  return runtime.store.mutate((state) => {
    const chat = state.chats.find((row) => row.chatId === input.chatId);
    if (chat === undefined) {
      return null;
    }
    const existing = chat.turns.find(
      (row) => row.messageId === input.messageId,
    );
    if (existing !== undefined) {
      return existing;
    }
    chat.turns.push(turn);
    bumpChatIndex(chat);
    stampAgentHarness(state.agents, input.chatId, input.harnessId);
    const titled = titleFromPrompt(input.prompt);
    const nextTitle =
      chat.title.length === 0 && titled.length > 0 ? titled : chat.title;
    const nextSettings =
      input.runSettings === null ? chat.runSettings : input.runSettings;
    if (nextTitle !== chat.title || input.runSettings !== null) {
      const chatIndex = state.chats.findIndex(
        (row) => row.chatId === input.chatId,
      );
      if (chatIndex >= 0) {
        state.chats[chatIndex] = {
          ...chat,
          title: nextTitle,
          runSettings: nextSettings,
        };
      }
    }
    const epic = state.epics.find((row) => row.id === input.epicId);
    if (epic !== undefined && epic.title.length === 0 && titled.length > 0) {
      const epicIndex = state.epics.findIndex((row) => row.id === epic.id);
      if (epicIndex >= 0) {
        state.epics[epicIndex] = { ...epic, title: titled, updatedAt: now };
      }
    }
    return turn;
  });
}

export async function persistChatRunSettings(
  runtime: HostRuntime,
  input: {
    readonly epicId: string;
    readonly chatId: string;
    readonly settings: unknown;
    readonly harnessId: string | null;
  },
): Promise<boolean> {
  const updated = await runtime.store.mutate((state) => {
    const chatIndex = state.chats.findIndex(
      (row) => row.chatId === input.chatId && row.epicId === input.epicId,
    );
    if (chatIndex < 0) {
      return false;
    }
    const chat = state.chats[chatIndex];
    if (chat === undefined) {
      return false;
    }
    state.chats[chatIndex] = { ...chat, runSettings: input.settings };
    if (input.harnessId !== null) {
      stampAgentHarness(state.agents, input.chatId, input.harnessId);
    }
    return true;
  });
  if (updated) {
    broadcastChatSnapshot(runtime, input.epicId, input.chatId);
  }
  return updated;
}

export function beginGuiPrintTurn(
  runtime: HostRuntime,
  input: {
    readonly epicId: string;
    readonly chatId: string;
    readonly harnessId: string;
    readonly prompt: string;
    readonly responseId: string | null;
    readonly model: string | null;
  },
): void {
  const chat = runtime.store
    .snapshot()
    .chats.find((row) => row.chatId === input.chatId);
  let lastUser: StoredTurn | null = null;
  if (chat !== undefined) {
    for (const turn of chat.turns) {
      if (turn.role === "user") {
        lastUser = turn;
      }
    }
  }
  const assistantMessageId = randomUUID();
  const turnId = `turn:${randomUUID()}`;
  const resumed =
    matchingProviderSession(chat?.providerSession ?? null, input.harnessId) !==
    null;
  runtime.guiRuns.beginPrint(input.chatId, {
    harnessId: input.harnessId,
    model: input.model ?? readModelSlug(chat?.runSettings) ?? "default",
    userMessageId: lastUser === null ? null : lastUser.messageId,
    assistantMessageId,
    turnId,
    resumed,
    compact: isManualCompact(input.prompt),
    startedAt: Date.now(),
  });
  broadcastTurnStateChanged(runtime, input.epicId, input.chatId);
  if (isManualCompact(input.prompt)) {
    broadcastBlockDelta(runtime, input.epicId, input.chatId, {
      type: "compaction.started",
      blockId: `${turnId}-compact`,
      timestamp: Date.now(),
      trigger: "manual",
    });
  }
  broadcastEventAppended(runtime, input.epicId, input.chatId, {
    type: "turn.started",
    message: "Turn started.",
    turnId,
    messageId: lastUser === null ? null : lastUser.messageId,
    clientActionId: null,
    severity: "info",
  });
  broadcastBlockDelta(runtime, input.epicId, input.chatId, {
    type: "turn.started",
    blockId: turnId,
    timestamp: Date.now(),
    turnId,
  });
  const work = runAndPersistAssistant(runtime, {
    ...input,
    assistantMessageId,
    turnId,
  }).then(
    () =>
      finishPrint(
        runtime,
        input.epicId,
        input.chatId,
        assistantMessageId,
        null,
      ),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return persistAssistantTurn(runtime, {
        epicId: input.epicId,
        chatId: input.chatId,
        harnessId: input.harnessId,
        prompt: message,
        responseId: input.responseId,
        model: input.model,
        messageId: assistantMessageId,
        turnId,
      }).then(() =>
        finishPrint(
          runtime,
          input.epicId,
          input.chatId,
          assistantMessageId,
          message,
        ),
      );
    },
  );
  runtime.guiRuns.track(work);
}

export function drainGuiQueue(
  runtime: HostRuntime,
  epicId: string,
  chatId: string,
): void {
  if (runtime.guiRuns.isDisposing()) {
    return;
  }
  if (runtime.guiRuns.printState(chatId) !== null) {
    return;
  }
  if (runtime.queue.isPaused(chatId)) {
    broadcastQueueChanged(runtime, epicId, chatId);
    broadcastChatSnapshot(runtime, epicId, chatId);
    return;
  }
  const next = runtime.queue.peek(chatId);
  if (next === null) {
    broadcastQueueChanged(runtime, epicId, chatId);
    broadcastChatSnapshot(runtime, epicId, chatId);
    return;
  }
  void startQueuedPrompt(runtime, epicId, chatId, next);
}

export async function deleteTurnsFrom(
  runtime: HostRuntime,
  input: {
    readonly epicId: string;
    readonly chatId: string;
    readonly fromRowId: string;
  },
): Promise<boolean> {
  runtime.queue.clear(input.chatId);
  runtime.guiRuns.requestStop(input.chatId);
  const removed = await runtime.store.mutate((state) => {
    const chat = state.chats.find((row) => row.chatId === input.chatId);
    if (chat === undefined || chat.epicId !== input.epicId) {
      return false;
    }
    const index = indexOfRow(chat.turns, input.fromRowId);
    if (index < 0) {
      return false;
    }
    chat.turns.splice(index);
    chat.transcriptEpoch += 1;
    bumpChatIndex(chat);
    return true;
  });
  if (removed) {
    broadcastEventAppended(runtime, input.epicId, input.chatId, {
      type: "history.deleted",
      message: "History truncated.",
      turnId: null,
      messageId: input.fromRowId,
      clientActionId: null,
      severity: "info",
    });
    broadcastChatSnapshot(runtime, input.epicId, input.chatId);
    broadcastQueueChanged(runtime, input.epicId, input.chatId);
  }
  return removed;
}

export function printPromptFromTurns(
  turns: readonly StoredTurn[],
  currentPrompt: string,
): string {
  const history: string[] = [];
  const lastIndex = turns.length - 1;
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (turn === undefined) {
      continue;
    }
    if (index === lastIndex && turn.role === "user") {
      continue;
    }
    const text = turn.prompt.trim();
    if (text.length === 0) {
      continue;
    }
    const label = turn.role === "user" ? "User" : "Assistant";
    history.push(`${label}: ${text}`);
  }
  if (history.length === 0) {
    return currentPrompt;
  }
  let body = history.join("\n\n");
  if (body.length > MAX_HISTORY_CHARS) {
    body = body.slice(body.length - MAX_HISTORY_CHARS);
  }
  return `Conversation so far:\n${body}\n\nUser: ${currentPrompt}`;
}

export function extractPlainText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || typeof value !== "object") {
    return "";
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => extractPlainText(entry))
      .filter((part) => part.length > 0)
      .join("\n");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  if ("content" in record) {
    return extractPlainText(record.content);
  }
  return "";
}

export function readHarnessId(settings: unknown): string | null {
  if (settings === null || typeof settings !== "object") {
    return null;
  }
  const harnessId = Reflect.get(settings, "harnessId");
  return typeof harnessId === "string" && harnessId.length > 0
    ? harnessId
    : null;
}

export function readModelSlug(settings: unknown): string | null {
  if (settings === null || typeof settings !== "object") {
    return null;
  }
  const model = Reflect.get(settings, "model");
  return typeof model === "string" && model.length > 0 ? model : null;
}

export function readPermissionMode(settings: unknown): string | null {
  if (settings === null || typeof settings !== "object") {
    return null;
  }
  const permissionMode = Reflect.get(settings, "permissionMode");
  return typeof permissionMode === "string" && permissionMode.length > 0
    ? permissionMode
    : null;
}

export function readUserId(sender: unknown): string {
  if (sender === null || typeof sender !== "object") {
    return LOCAL_USER_ID;
  }
  const userId = Reflect.get(sender, "userId");
  if (typeof userId === "string" && userId.length > 0) {
    return userId;
  }
  return LOCAL_USER_ID;
}

async function runAndPersistAssistant(
  runtime: HostRuntime,
  input: {
    readonly epicId: string;
    readonly chatId: string;
    readonly harnessId: string;
    readonly prompt: string;
    readonly responseId: string | null;
    readonly model: string | null;
    readonly assistantMessageId: string;
    readonly turnId: string;
  },
): Promise<void> {
  const cwd = guiWorkingDirectory(runtime, input.epicId);
  const chat = runtime.store
    .snapshot()
    .chats.find((row) => row.chatId === input.chatId);
  const session = matchingProviderSession(
    chat?.providerSession ?? null,
    input.harnessId,
  );
  const prompt =
    session === null
      ? printPromptFromTurns(chat?.turns ?? [], input.prompt)
      : input.prompt;
  const textBlockId = assistantTextBlockId(input.assistantMessageId);
  const reasoningBlockId = assistantReasoningBlockId(input.assistantMessageId);
  let assembled = "";
  let sawReasoning = false;
  let announcedSession = false;
  let lastUsage: ProviderTokenUsage | null = null;
  let toolCallCount = 0;
  let toolCallErrorCount = 0;
  let authFailure: { readonly status: number; readonly detail: string } | null =
    null;
  const openTools = new Map<string, string>();
  const print = runtime.guiRuns.printState(input.chatId);
  const handleEvent = (event: ProviderStreamEvent): void => {
    const now = Date.now();
    if (event.kind === "session") {
      void persistProviderSession(runtime, {
        chatId: input.chatId,
        harnessId: input.harnessId,
        sessionId: event.sessionId,
      });
      if (announcedSession) {
        return;
      }
      announcedSession = true;
      // The event names a GUI harness, not any string. Every harness this host
      // spawns is one, so a parse failure here means a caller invented an id -
      // and the run itself is still fine, so the session block is what drops.
      const harness = guiHarnessIdSchema.safeParse(input.harnessId);
      if (harness.success) {
        broadcastBlockDelta(runtime, input.epicId, input.chatId, {
          type: print?.resumed === true ? "session.resumed" : "session.created",
          blockId: input.turnId,
          timestamp: now,
          session: {
            id: event.sessionId,
            harnessId: harness.data,
            createdAt: now,
          },
        });
      }
      const userMessageId = print?.userMessageId ?? null;
      const anchor = userMessageAnchor(
        input.harnessId,
        event.sessionId,
        userMessageId ?? input.turnId,
        input.turnId,
      );
      if (userMessageId !== null && anchor !== null) {
        broadcastBlockDelta(runtime, input.epicId, input.chatId, {
          type: "user_message.anchor_resolved",
          blockId: userMessageId,
          timestamp: now,
          messageId: userMessageId,
          anchor,
        });
      }
      return;
    }
    if (event.kind === "delta") {
      assembled += event.text;
      broadcastBlockDelta(runtime, input.epicId, input.chatId, {
        type: "text.delta",
        blockId: textBlockId,
        timestamp: now,
        delta: event.text,
      });
      return;
    }
    if (event.kind === "reasoning") {
      sawReasoning = true;
      broadcastBlockDelta(runtime, input.epicId, input.chatId, {
        type: "reasoning.delta",
        blockId: reasoningBlockId,
        timestamp: now,
        delta: event.text,
      });
      return;
    }
    if (event.kind === "tool_start") {
      // The same call arrives twice under `--include-partial-messages`: once
      // from `content_block_start` with an EMPTY input, then again on the
      // complete `assistant` record with the real one. Both are broadcast, so
      // the block ends up with the arguments; only the first one counts.
      if (!openTools.has(event.toolId)) {
        toolCallCount += 1;
      }
      openTools.set(event.toolId, event.toolName);
      broadcastBlockDelta(runtime, input.epicId, input.chatId, {
        type: "tool_call.started",
        blockId: event.toolId,
        timestamp: now,
        toolName: event.toolName,
        input: event.input,
        // Empty by construction, not unimplemented: the field describes a
        // `traycer_send_message` call the AGENT made, and this host spawns
        // `claude -p` / `codex exec` with no MCP config and serves no
        // `traycer_*` tool, so no tool call reaching here can be one. (This
        // host does serve `agent.sendMessage` - that is the CLIENT-driven A2A
        // path, and it leaves no tool call in a transcript.) The same holds
        // for `agentMessageReceipt` on the completion below, which is the
        // result-side sibling of this field.
        agentMessageSend: null,
      });
      return;
    }
    if (event.kind === "tool_end") {
      const toolName = openTools.get(event.toolId) ?? "tool";
      openTools.delete(event.toolId);
      broadcastBlockDelta(runtime, input.epicId, input.chatId, {
        type: "tool_call.completed",
        blockId: event.toolId,
        timestamp: now,
        toolName,
        // Empty for the reason given at `tool_call.started` above.
        agentMessageSend: null,
        imageResults: [],
      });
      return;
    }
    if (event.kind === "tool_error") {
      const toolName = openTools.get(event.toolId) ?? "tool";
      openTools.delete(event.toolId);
      toolCallErrorCount += 1;
      broadcastBlockDelta(runtime, input.epicId, input.chatId, {
        type: "tool_call.errored",
        blockId: event.toolId,
        timestamp: now,
        toolName,
        error: event.error,
        // The provider reported a failure, not a stop. A stop reaches this
        // host as `guiRuns.wasStopped`, which never produces a tool result at
        // all.
        terminationReason: "error",
        agentMessageSend: null,
      });
      return;
    }
    if (event.kind === "todo") {
      const items = event.items.map((item) => ({
        id: item.id ?? null,
        text: item.text,
        status: item.status,
        priority: item.priority ?? null,
        activeForm: item.activeForm ?? null,
      }));
      broadcastBlockDelta(runtime, input.epicId, input.chatId, {
        type: "todo.updated",
        blockId: event.toolId,
        timestamp: now,
        items: [...event.items],
      });
      // Stored as well as broadcast: the dock is painted from the snapshot,
      // and a block delta is live-only here.
      void runtime.store.mutate((state) => {
        const row = state.chats.find(
          (chatRow) => chatRow.chatId === input.chatId,
        );
        if (row !== undefined) {
          row.pinnedTodo = { id: event.toolId, items };
        }
      });
      return;
    }
    if (event.kind === "subagent_start") {
      broadcastBlockDelta(runtime, input.epicId, input.chatId, {
        type: "subagent.started",
        // The TASK id, not the spawning call's: one `Task` tool call is one
        // sub-agent run, but the ids are different and every later record
        // about this run is keyed by the task.
        blockId: event.taskId,
        timestamp: now,
        name: event.name,
        agentType: event.agentType,
        // Named so the GUI can drop the `Task` tool row this card replaces -
        // the same pairing the file card uses against its edit call.
        ...(event.spawnToolId === null
          ? {}
          : { spawnToolCallId: event.spawnToolId }),
        ...(event.task === null ? {} : { task: event.task }),
      });
      return;
    }
    if (event.kind === "subagent_progress") {
      broadcastBlockDelta(runtime, input.epicId, input.chatId, {
        type: "subagent.progress",
        blockId: event.taskId,
        timestamp: now,
        update: event.update,
      });
      return;
    }
    if (event.kind === "subagent_end") {
      broadcastBlockDelta(runtime, input.epicId, input.chatId, {
        type: "subagent.completed",
        blockId: event.taskId,
        timestamp: now,
        outcome: event.outcome,
        ...(event.result === null ? {} : { result: event.result }),
      });
      return;
    }
    if (event.kind === "auth_failure") {
      authFailure = event;
      return;
    }
    if (event.kind === "command_start") {
      broadcastBlockDelta(runtime, input.epicId, input.chatId, {
        type: "command.started",
        blockId: event.commandId,
        timestamp: now,
        command: event.command,
      });
      return;
    }
    if (event.kind === "command_end") {
      broadcastBlockDelta(runtime, input.epicId, input.chatId, {
        type: "command.completed",
        blockId: event.commandId,
        timestamp: now,
        command: event.command,
        ...(event.exitCode === null ? {} : { exitCode: event.exitCode }),
      });
      return;
    }
    if (event.kind === "file_change") {
      // Prefixed with the CALL's id when there is one, because that is what
      // makes the GUI replace the suppressed edit tool call with this card
      // rather than hiding the edit entirely. Codex reports changes with no
      // call attached, so those keep the turn-scoped id they always had.
      const blockId = `${event.toolId ?? input.turnId}:${event.path}`;
      const operation = fileChangeOperation(event.operation, event.path);
      broadcastBlockDelta(runtime, input.epicId, input.chatId, {
        type: "file_change.started",
        blockId,
        timestamp: now,
        filePath: event.path,
        operation,
      });
      broadcastBlockDelta(runtime, input.epicId, input.chatId, {
        type: "file_change.completed",
        blockId,
        timestamp: now,
        filePath: event.path,
        operation,
        // No before/after was captured, so there is nothing to diff and
        // nothing to count. `not_intercepted` is the contract's word for
        // exactly this host: the agent's CLI wrote the file directly and
        // nothing here stood between the two.
        diffSource: "none",
        beforeHash: null,
        afterHash: null,
        additions: 0,
        deletions: 0,
        reason: "not_intercepted",
      });
      void runtime.store.mutate((state) => {
        const row = state.chats.find(
          (chatRow) => chatRow.chatId === input.chatId,
        );
        if (row === undefined) {
          return;
        }
        recordFileChange(row, event.path, operation);
        bumpChatIndex(row);
      });
      broadcastAccumulatedChanges(runtime, input.epicId, input.chatId);
      return;
    }
    if (event.kind === "usage") {
      broadcastBlockDelta(runtime, input.epicId, input.chatId, {
        type: "usage.updated",
        blockId: input.turnId,
        timestamp: now,
        turnId: input.turnId,
        usage: event.usage,
      });
      lastUsage = event.usage;
      void runtime.store.mutate((state) => {
        const row = state.chats.find(
          (chatRow) => chatRow.chatId === input.chatId,
        );
        if (row === undefined) {
          return;
        }
        row.lastUsage = event.usage;
      });
    }
  };
  try {
    const replyText = await runGuiPrintTurn(runtime, {
      agentId: input.chatId,
      harnessId: input.harnessId,
      prompt,
      cwd,
      model: input.model ?? readModelSlug(chat?.runSettings),
      permissionMode: readPermissionMode(chat?.runSettings),
      sessionId: session,
      onEvent: handleEvent,
    });
    if (sawReasoning) {
      broadcastBlockDelta(runtime, input.epicId, input.chatId, {
        type: "reasoning.completed",
        blockId: reasoningBlockId,
        timestamp: Date.now(),
      });
    }
    for (const [toolId, toolName] of openTools) {
      broadcastBlockDelta(runtime, input.epicId, input.chatId, {
        type: "tool_call.completed",
        blockId: toolId,
        timestamp: Date.now(),
        toolName,
        // Empty for the reason given at `tool_call.started` above.
        agentMessageSend: null,
        imageResults: [],
      });
    }
    await persistAssistantTurn(runtime, {
      epicId: input.epicId,
      chatId: input.chatId,
      model: input.model,
      harnessId: input.harnessId,
      prompt: persistAssistantPrompt(assembled, replyText),
      responseId: input.responseId,
      messageId: input.assistantMessageId,
      turnId: input.turnId,
    });
    // The marker describes the LATEST assistant turn, so a turn that got a
    // reply clears it - otherwise the banner outlives the re-auth that fixed
    // it.
    await markAuthFailure(runtime, input.chatId, null);
    await recordUsageFact(runtime, {
      epicId: input.epicId,
      chatId: input.chatId,
      harnessId: input.harnessId,
      model: input.model,
      usage: lastUsage,
      outcome: "completed",
      toolCallCount,
      toolCallErrorCount,
    });
    await notify(runtime, {
      id: `agent.stopped:${input.turnId}`,
      kind: "agent.stopped",
      epicId: input.epicId,
      chatId: input.chatId,
      severity: "done",
      outcome: "completed",
      sourceRef: input.turnId,
      message: "",
    });
  } catch (error) {
    await recordUsageFact(runtime, {
      epicId: input.epicId,
      chatId: input.chatId,
      harnessId: input.harnessId,
      model: input.model,
      usage: lastUsage,
      outcome: "abnormal_exit",
      toolCallCount,
      toolCallErrorCount,
    });
    await persistProviderSession(runtime, {
      chatId: input.chatId,
      harnessId: input.harnessId,
      sessionId: null,
    });
    const message = error instanceof Error ? error.message : String(error);
    const authCode =
      authFailure === null
        ? null
        : envCredentialVarForProvider(
              runtime.store,
              providerIdForHarness(input.harnessId),
            ) === null
          ? AUTH_ERROR_CODE
          : ENV_CREDENTIAL_AUTH_ERROR_CODE;
    await markAuthFailure(
      runtime,
      input.chatId,
      authCode === null ? null : input.turnId,
    );
    await notify(runtime, {
      id: `agent.stopped:${input.turnId}`,
      kind: "agent.stopped",
      epicId: input.epicId,
      chatId: input.chatId,
      severity: "failure",
      outcome: "errored",
      sourceRef: input.turnId,
      message,
    });
    broadcastBlockDelta(runtime, input.epicId, input.chatId, {
      type: "error",
      blockId: input.turnId,
      timestamp: Date.now(),
      message,
      // A rejected credential is the one failure here the user can repair, and
      // `code` is what mounts the banner offering it. Everything else stays
      // unrecoverable: there is no retry this host could offer for a harness
      // that exited non-zero.
      recoverable: authCode !== null,
      ...(authCode === null ? {} : { code: authCode }),
    });
    throw error;
  }
}

/**
 * One row per FILE, not per edit, because that is the unit the accumulated
 * panel lists - and because the snapshot's count is this array's length, which
 * the client checks against the summaries it received.
 *
 * A later edit does not overwrite an earlier `create`: the file did not exist
 * when this chat started and still would not if the chat were undone, which is
 * what the row describes. A `delete` does overwrite, for the same reason from
 * the other end.
 */
function recordFileChange(
  chat: StoredChat,
  filePath: string,
  operation: CheckpointFileOperation,
): void {
  const existing = chat.accumulatedChanges.findIndex(
    (row) => row.filePath === filePath,
  );
  if (existing < 0) {
    chat.accumulatedChanges.push({ filePath, operation });
    return;
  }
  if (operation === "delete") {
    chat.accumulatedChanges[existing] = { filePath, operation };
  }
}

/**
 * The provider's own word where it has one, and the file system where it does
 * not: a Claude edit tool names a path and a payload, never whether the file
 * was already there.
 *
 * Read at the moment the call OPENS, which is before the write lands - so an
 * existing path means an edit and a missing one means a create. A path that
 * appears between this read and the write is reported as a create, which is
 * what it was when the agent decided to write it.
 */
function fileChangeOperation(
  reported: string | null,
  filePath: string,
): CheckpointFileOperation {
  if (reported === null) {
    return existsSync(filePath) ? "edit" : "create";
  }
  const word = reported.toLowerCase();
  if (word.includes("del") || word.includes("remove")) {
    return "delete";
  }
  if (word.includes("add") || word.includes("create") || word.includes("new")) {
    return "create";
  }
  return "edit";
}

/**
 * Records (or clears) the chat's rejected-credential marker.
 *
 * Written to the store rather than only broadcast because the banner is
 * mounted from the SNAPSHOT: a turn can fail with no subscriber attached - a
 * headless A2A send, a tab that was closed - and the frame the user gets when
 * they come back is the only place that failure can still be reported.
 */
async function markAuthFailure(
  runtime: HostRuntime,
  chatId: string,
  turnId: string | null,
): Promise<void> {
  const chat = runtime.store
    .snapshot()
    .chats.find((row) => row.chatId === chatId);
  if (chat === undefined || chat.lastAuthFailureTurnId === turnId) {
    return;
  }
  await runtime.store.mutate((state) => {
    const row = state.chats.find((entry) => entry.chatId === chatId);
    if (row !== undefined) {
      row.lastAuthFailureTurnId = turnId;
    }
  });
}

export function persistAssistantPrompt(
  assembled: string,
  replyText: string,
): string {
  return assembled.length > 0 ? assembled : replyText;
}

async function persistAssistantTurn(
  runtime: HostRuntime,
  input: {
    readonly epicId: string;
    readonly chatId: string;
    readonly harnessId: string;
    readonly prompt: string;
    readonly responseId: string | null;
    readonly model: string | null;
    readonly messageId: string;
    readonly turnId: string;
  },
): Promise<void> {
  const print = runtime.guiRuns.printState(input.chatId);
  if (print !== null && print.assistantMessageId !== input.messageId) {
    return;
  }
  const agent = runtime.store
    .snapshot()
    .agents.find((row) => row.id === input.chatId);
  const reply: StoredTurn = {
    messageId: input.messageId,
    timestamp: Date.now(),
    role: "assistant",
    prompt: input.prompt,
    fromAgentId: input.chatId,
    fromTitle: agent?.title ?? input.chatId,
    fromHarnessId: input.harnessId,
    expectReply: false,
    responseId: input.responseId,
    userId: null,
    content: null,
    turnId: input.turnId,
    blocks: null,
  };
  await runtime.store.mutate((state) => {
    const chat = state.chats.find((row) => row.chatId === input.chatId);
    if (chat === undefined) {
      return;
    }
    const existing = chat.turns.findIndex(
      (row) => row.messageId === input.messageId,
    );
    if (existing >= 0) {
      chat.turns[existing] = reply;
      return;
    }
    chat.turns.push(reply);
    bumpChatIndex(chat);
  });
}

/**
 * Write the finished turn's blocks onto it, and stamp it.
 *
 * Both happen here and not at persist time because both are only true once
 * the terminal event has gone out: the blocks are still streaming until then,
 * and the stamp has to beat the live `text.completed` beside it.
 *
 * An empty fold leaves the stored blocks alone rather than clearing them. A
 * turn that produced no delta at all has nothing to say, and the reader falls
 * back to a lone text block from the prompt - which is what such a turn is.
 */
async function sealAssistantTurn(
  runtime: HostRuntime,
  chatId: string,
  messageId: string,
  timestamp: number,
  blocks: readonly ContentBlock[],
): Promise<void> {
  await runtime.store.mutate((state) => {
    const chat = state.chats.find((row) => row.chatId === chatId);
    if (chat === undefined) {
      return;
    }
    const index = chat.turns.findIndex((row) => row.messageId === messageId);
    if (index < 0) {
      return;
    }
    const turn = chat.turns[index];
    if (turn === undefined) {
      return;
    }
    chat.turns[index] = {
      ...turn,
      timestamp,
      blocks: blocks.length === 0 ? turn.blocks : [...blocks],
    };
  });
}

export function titleFromPrompt(prompt: string): string {
  const collapsed = prompt.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) {
    return "";
  }
  if (collapsed.length <= 48) {
    return collapsed;
  }
  return collapsed.slice(0, 48);
}

export function derivedChatTitle(chat: StoredChat): string {
  if (chat.title.length > 0) {
    return chat.title;
  }
  for (const turn of chat.turns) {
    if (turn.role === "user" && turn.prompt.length > 0) {
      return titleFromPrompt(turn.prompt);
    }
  }
  return "";
}

async function persistProviderSession(
  runtime: HostRuntime,
  input: {
    readonly chatId: string;
    readonly harnessId: string;
    readonly sessionId: string | null;
  },
): Promise<void> {
  await runtime.store.mutate((state) => {
    const chatIndex = state.chats.findIndex(
      (row) => row.chatId === input.chatId,
    );
    if (chatIndex < 0) {
      return;
    }
    const chat = state.chats[chatIndex];
    if (chat === undefined) {
      return;
    }
    state.chats[chatIndex] = {
      ...chat,
      providerSession:
        input.sessionId === null
          ? null
          : { harnessId: input.harnessId, sessionId: input.sessionId },
    };
  });
}

function isManualCompact(prompt: string): boolean {
  const trimmed = prompt.trim();
  return trimmed === "/compact" || trimmed.startsWith("/compact ");
}

function matchingProviderSession(
  session: StoredChat["providerSession"],
  harnessId: string,
): string | null {
  if (session === null || session.harnessId !== harnessId) {
    return null;
  }
  return session.sessionId;
}

/**
 * Close out a turn: finalize its blocks, persist them, and let the next
 * queued prompt run.
 *
 * `failure` is the message the run rejected with, and it decides which
 * terminal event goes out. That is not cosmetic: every block still streaming
 * adopts a status from this event, so a turn whose harness died mid-tool-call
 * used to stamp that call `completed` - and now that the blocks are kept, it
 * would stamp it completed forever.
 */
async function finishPrint(
  runtime: HostRuntime,
  epicId: string,
  chatId: string,
  assistantMessageId: string,
  failure: string | null,
): Promise<void> {
  const print = runtime.guiRuns.printState(chatId);
  const stopped = runtime.guiRuns.wasStopped(chatId);
  const now = Date.now();
  const turnId = print?.turnId ?? assistantMessageId;
  if (print?.compact === true) {
    broadcastBlockDelta(runtime, epicId, chatId, {
      type: "compaction.completed",
      blockId: `${turnId}-compact`,
      timestamp: now,
      trigger: "manual",
    });
  }
  broadcastBlockDelta(runtime, epicId, chatId, {
    type: "text.completed",
    blockId: assistantTextBlockId(assistantMessageId),
    timestamp: now,
  });
  // A stop is a stop even though it also makes the run reject: the user asked
  // for it, and `turn.stopped` is the word for that.
  const outcome = stopped
    ? "turn.stopped"
    : failure === null
      ? "turn.completed"
      : "turn.interrupted";
  broadcastBlockDelta(
    runtime,
    epicId,
    chatId,
    outcome === "turn.interrupted"
      ? {
          type: outcome,
          blockId: turnId,
          timestamp: now,
          turnId,
          reason: failure ?? "",
        }
      : { type: outcome, blockId: turnId, timestamp: now, turnId },
  );
  broadcastEventAppended(runtime, epicId, chatId, {
    type: outcome,
    message:
      outcome === "turn.stopped"
        ? "Turn stopped."
        : outcome === "turn.completed"
          ? "Turn completed."
          : "Turn interrupted.",
    turnId,
    messageId: assistantMessageId,
    clientActionId: null,
    severity: outcome === "turn.interrupted" ? "error" : "info",
  });
  // Read before `endPrint`, which is what a next turn resets.
  const blocks = runtime.guiRuns.blocksOf(chatId);
  runtime.guiRuns.endPrint(chatId, assistantMessageId);
  // Live `text.completed` uses `now`. Equal stamps keep live when snapshot
  // blocks differ, so the persisted turn must be strictly newer.
  await sealAssistantTurn(runtime, chatId, assistantMessageId, now + 1, blocks);
  broadcastTurnStateChanged(runtime, epicId, chatId);
  broadcastChatSnapshot(runtime, epicId, chatId);
  drainGuiQueue(runtime, epicId, chatId);
}

function userMessageAnchor(
  harnessId: string,
  sessionId: string,
  userMessageId: string,
  turnId: string,
): UserMessageAnchorResolvedEvent["anchor"] | null {
  if (harnessId === "claude") {
    return {
      harnessId: "claude",
      sessionId,
      claudeMessageUuid: userMessageId,
    };
  }
  if (harnessId === "codex") {
    return {
      harnessId: "codex",
      sessionId,
      codexTurnId: turnId,
      codexUserMessageId: userMessageId,
    };
  }
  if (harnessId === "grok") {
    return {
      harnessId: "grok",
      sessionId,
      grokSessionId: sessionId,
    };
  }
  if (harnessId === "opencode") {
    return {
      harnessId: "opencode",
      sessionId,
      opencodeUserMessageId: userMessageId,
    };
  }
  return null;
}

async function startQueuedPrompt(
  runtime: HostRuntime,
  epicId: string,
  chatId: string,
  item: QueuedPrompt,
): Promise<void> {
  if (!runtime.queue.has(chatId, item.queueItemId)) {
    drainGuiQueue(runtime, epicId, chatId);
    return;
  }
  const turn = await persistGuiUserTurn(runtime, {
    epicId,
    chatId,
    messageId: item.messageId,
    prompt: item.prompt,
    content: item.content,
    userId: item.userId,
    harnessId: item.harnessId,
    runSettings: item.settings,
  });
  if (turn === null || !runtime.queue.has(chatId, item.queueItemId)) {
    runtime.queue.cancel(chatId, item.queueItemId);
    drainGuiQueue(runtime, epicId, chatId);
    return;
  }
  beginGuiPrintTurn(runtime, {
    epicId,
    chatId,
    harnessId: item.harnessId,
    prompt: item.prompt,
    responseId: turn.responseId,
    model: item.model,
  });
  runtime.queue.cancel(chatId, item.queueItemId);
  broadcastQueueChanged(runtime, epicId, chatId);
}

function indexOfRow(turns: readonly StoredTurn[], rowId: string): number {
  return turns.findIndex(
    (turn) => turn.messageId === rowId || rowIdForTurn(turn) === rowId,
  );
}

function rowIdForTurn(turn: StoredTurn): string {
  if (turn.role === "assistant") {
    return assistantRowId(turn.turnId ?? turn.messageId);
  }
  return turn.messageId;
}

function stampAgentHarness(
  agents: StoredAgent[],
  chatId: string,
  harnessId: string,
): void {
  const index = agents.findIndex((row) => row.id === chatId);
  if (index < 0) {
    return;
  }
  const current = agents[index];
  agents[index] = { ...current, harnessId };
}

function guiWorkingDirectory(runtime: HostRuntime, epicId: string): string {
  const epic = runtime.store.snapshot().epics.find((row) => row.id === epicId);
  const first = epic?.workspaces[0];
  if (first !== undefined && first.length > 0) {
    return first;
  }
  return runtime.dataDir;
}

export function seedGuiChat(
  state: {
    chats: StoredChat[];
    agents: StoredAgent[];
  },
  chat: StoredChat,
  harnessId: string,
): void {
  state.chats = state.chats.filter((row) => row.chatId !== chat.chatId);
  state.chats.push(chat);
  state.agents = state.agents.filter((row) => row.id !== chat.chatId);
  state.agents.push({
    id: chat.chatId,
    epicId: chat.epicId,
    parentId: chat.parentId,
    hostId: chat.hostId,
    surface: "gui",
    harnessId,
    title: chat.title,
    createdAt: chat.createdAt,
    stopped: false,
  });
}
