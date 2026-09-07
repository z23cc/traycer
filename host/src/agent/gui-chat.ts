import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  AUTH_ERROR_CODE,
  ENV_CREDENTIAL_AUTH_ERROR_CODE,
} from "@traycer/protocol/host/agent/gui/agent-runtime";
import type {
  RuntimeEvent,
  UserMessageAnchorResolvedEvent,
} from "@traycer/protocol/host/agent/gui/agent-runtime";
import { nestChildRuntimeEvent } from "@traycer/protocol/host/agent/gui/subagent-nesting";
import { guiHarnessIdSchema } from "@traycer/protocol/host/agent/shared";
import { assistantRowId } from "@traycer/protocol/persistence/chat-transcript/row-projection";
import type { CheckpointFileOperation } from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import type {
  ContentBlock,
  FileEditReason,
} from "@traycer/protocol/persistence/epic/content-blocks";
import {
  MAX_SNAPSHOT_BYTES,
  captureFile,
  lineCounts,
  readBlob,
  settleEdit,
  snapshotDir,
  type SnapshotCapture,
} from "../snapshots/snapshots";
import { providerIdForHarness } from "../gui/harness-map";
import { envCredentialVarForProvider } from "../providers/service";
import { runGuiPrintTurn, type PendingApproval } from "../gui/deliver";
import { isAbsolute, relative } from "node:path";
import type { QueuedPrompt } from "../gui/queue";
import { LOCAL_USER_ID } from "../local-user";
import type { HostRuntime } from "../runtime";
import type {
  StoredAgent,
  StoredChat,
  StoredFileChange,
  StoredTurn,
} from "../store/host-store";
import { bumpChatIndex } from "../store/host-store";
import type {
  ProviderStreamEvent,
  ProviderTokenUsage,
} from "../gui/provider-stream";
import { broadcastReadState, notify } from "../gui/notifications";
import { recordUsageFact } from "../gui/usage";
import {
  assistantReasoningBlockId,
  assistantTextBlockId,
  broadcastAccumulatedChanges,
  broadcastChatFrame,
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
  const permissionMode = readPermissionMode(chat?.runSettings);
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
  /** Edit calls whose card is open, waiting on the call's result. */
  const pendingEdits = new Map<string, PendingEdit>();
  /**
   * The sub-agent card each spawning tool call opened, from `task_started`.
   * A child record names the call that spawned it, and this is how that name
   * becomes the card its events nest under.
   */
  const cardByTool = new Map<string, string>();
  /**
   * The spawning call above each tool call a CHILD made. A nested sub-agent's
   * `task_started` names the child's own spawn call, and this is the one hop
   * from there to the card that call was made under. Exact at every depth
   * whose spawn call was seen; a depth whose transcript the stream does not
   * carry (recorded live: the second) leaves its children's cards unparented,
   * which is the contract's "unknown" rather than a guess.
   */
  const spawnParent = new Map<string, string>();
  /** The card the events being handled belong to, while inside a child record. */
  let nestUnder: string | null = null;
  /** The spawning call that child record named, for `spawnParent`. */
  let parentToolOfChild: string | null = null;
  /**
   * Every block delta this turn sends. Under a child record it applies the
   * protocol's own nesting policy - tool and file activity re-homed under the
   * card with a progress line beside it, narration and lifecycle dropped -
   * so a child's event can never surface as the parent's.
   */
  const emit = (event: RuntimeEvent): void => {
    if (nestUnder === null) {
      broadcastBlockDelta(runtime, input.epicId, input.chatId, event);
      return;
    }
    for (const nested of nestChildRuntimeEvent(
      event,
      nestUnder,
      event.timestamp,
    )) {
      broadcastBlockDelta(runtime, input.epicId, input.chatId, nested);
    }
  };
  /**
   * Completions still being read off disk. Awaited before the turn is
   * persisted, or a card could be sealed mid-read as a call that never
   * finished.
   */
  const settling: Promise<void>[] = [];
  const settleEditOf = async (
    toolId: string,
    failed: boolean,
  ): Promise<void> => {
    const edits = [...pendingEdits.values()].filter(
      (candidate) => candidate.toolId === toolId,
    );
    for (const edit of edits) {
      pendingEdits.delete(edit.blockId);
    }
    for (const edit of edits) {
      if (edit.before !== null) {
        // Captured here, not by a hook: the before was read when the item
        // was announced, ahead of the approval; the after is read now, once
        // the item reports done. A refused item never touched the file.
        //
        // ponytail: exact only while an approval sits between the two, which
        // under `untrusted` is every non-trusted change; a change the server
        // applied without asking could land between the announce and the
        // read. The app-server's own diff is the upgrade path.
        const before = await edit.before;
        await completeEdit(
          runtime,
          input,
          edit,
          {
            before,
            after: failed
              ? before
              : await captureFile(
                  snapshotDir(runtime.dataDir),
                  edit.path,
                  MAX_SNAPSHOT_BYTES,
                ),
          },
          "capture_failed",
        );
      }
    }
    const edit = edits.find((candidate) => candidate.before === null);
    if (edit === undefined) {
      return;
    }
    const captured = await settleEdit(snapshotDir(runtime.dataDir), toolId);
    // A call that failed with nothing captured on either side never reached
    // the file: Claude refuses an edit before its hooks run (recorded live -
    // "File has not been read yet"), so there is no before, no after, and no
    // change to describe. No card, and the accumulated set is left alone; the
    // errored tool row carries the error and stays visible in the card's
    // absence. Filing it as `capture_failed` did the opposite on both counts.
    if (failed && captured.before === null && captured.after === null) {
      return;
    }
    // A failed edit tool leaves the file as it found it, and the post hook
    // does not run for it - so the before IS the after, and a diff of the two
    // says "counted, unchanged" rather than guessing at a capture that never
    // happened.
    await completeEdit(
      runtime,
      input,
      edit,
      failed && captured.after === null
        ? { before: captured.before, after: captured.before }
        : captured,
      "capture_failed",
    );
  };
  const print = runtime.guiRuns.printState(input.chatId);
  const handleEvent = (event: ProviderStreamEvent): void => {
    const now = Date.now();
    if (event.kind === "session") {
      if (nestUnder !== null) {
        return;
      }
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
        emit({
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
        emit({
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
      // A child's words are the child's - the policy drops the delta below,
      // and the reply must not grow by it either.
      if (nestUnder === null) {
        assembled += event.text;
      }
      emit({
        type: "text.delta",
        blockId: textBlockId,
        timestamp: now,
        delta: event.text,
      });
      return;
    }
    if (event.kind === "reasoning") {
      if (nestUnder === null) {
        sawReasoning = true;
      }
      emit({
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
      if (!openTools.has(event.toolId) && nestUnder === null) {
        toolCallCount += 1;
      }
      openTools.set(event.toolId, event.toolName);
      if (nestUnder !== null && parentToolOfChild !== null) {
        spawnParent.set(event.toolId, parentToolOfChild);
      }
      emit({
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
      emit({
        type: "tool_call.completed",
        blockId: event.toolId,
        timestamp: now,
        toolName,
        // Empty for the reason given at `tool_call.started` above.
        agentMessageSend: null,
        imageResults: [],
      });
      settling.push(settleEditOf(event.toolId, false));
      return;
    }
    if (event.kind === "tool_error") {
      const toolName = openTools.get(event.toolId) ?? "tool";
      openTools.delete(event.toolId);
      if (nestUnder === null) {
        toolCallErrorCount += 1;
      }
      emit({
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
      settling.push(settleEditOf(event.toolId, true));
      return;
    }
    if (event.kind === "todo") {
      if (nestUnder !== null) {
        return;
      }
      const items = event.items.map((item) => ({
        id: item.id ?? null,
        text: item.text,
        status: item.status,
        priority: item.priority ?? null,
        activeForm: item.activeForm ?? null,
      }));
      emit({
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
      if (event.spawnToolId !== null) {
        cardByTool.set(event.spawnToolId, event.taskId);
      }
      // One hop up: the spawning call was itself made under some card, when
      // it was a child's. Null at the top, and null past the depth the
      // stream stops carrying transcripts for.
      const above =
        event.spawnToolId === null
          ? undefined
          : spawnParent.get(event.spawnToolId);
      const parentBlockId =
        above === undefined ? null : (cardByTool.get(above) ?? null);
      emit({
        type: "subagent.started",
        // The TASK id, not the spawning call's: one `Task` tool call is one
        // sub-agent run, but the ids are different and every later record
        // about this run is keyed by the task.
        blockId: event.taskId,
        timestamp: now,
        ...(parentBlockId === null ? {} : { parentBlockId }),
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
      emit({
        type: "subagent.progress",
        blockId: event.taskId,
        timestamp: now,
        update: event.update,
      });
      return;
    }
    if (event.kind === "subagent_end") {
      emit({
        type: "subagent.completed",
        blockId: event.taskId,
        timestamp: now,
        outcome: event.outcome,
        ...(event.result === null ? {} : { result: event.result }),
      });
      return;
    }
    if (event.kind === "permission_request") {
      // A Codex file-change request names only its item; the files are on
      // the cards that item announced a moment earlier.
      const announced =
        event.toolUseId === null
          ? []
          : [...pendingEdits.values()].filter(
              (edit) => edit.toolId === event.toolUseId,
            );
      void decidePermission(runtime, input, event, permissionMode, cwd, {
        userMessageId: print?.userMessageId ?? null,
        announcedPaths: announced.map((edit) => edit.path),
        announcedOperation: announced[0]?.operation ?? null,
      });
      return;
    }
    if (event.kind === "auth_failure") {
      authFailure = event;
      return;
    }
    if (event.kind === "child") {
      // A child's records never contain another child's - a deeper agent's
      // transcript is not in this stream at all - so there is no nesting to
      // stack here, and a card that was never opened means events with no
      // home, which the policy says must not surface. Dropped, not re-homed.
      const card = cardByTool.get(event.parentToolUseId);
      if (nestUnder !== null || card === undefined) {
        return;
      }
      nestUnder = card;
      parentToolOfChild = event.parentToolUseId;
      try {
        for (const inner of event.events) {
          handleEvent(inner);
        }
      } finally {
        nestUnder = null;
        parentToolOfChild = null;
      }
      return;
    }
    if (event.kind === "command_start") {
      emit({
        type: "command.started",
        blockId: event.commandId,
        timestamp: now,
        command: event.command,
      });
      return;
    }
    if (event.kind === "command_end") {
      emit({
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
      if (event.toolId !== null) {
        // No card yet. The fold keeps the operation a card OPENED with, and
        // at this point the operation is a guess racing the write - so the
        // card opens when the call completes, from what the hooks captured
        // around it. See `completeEdit`.
        pendingEdits.set(blockId, {
          blockId,
          path: event.path,
          operation,
          parentBlockId: nestUnder,
          toolId: event.toolId,
          before:
            input.harnessId === "codex"
              ? captureFile(
                  snapshotDir(runtime.dataDir),
                  event.path,
                  MAX_SNAPSHOT_BYTES,
                )
              : null,
        });
        return;
      }
      // No call to wait for and no hook around it: the provider reported the
      // change after the fact, and nothing stood between the before and the
      // after. `not_intercepted` is the contract's word for that.
      settling.push(
        completeEdit(
          runtime,
          input,
          {
            blockId,
            path: event.path,
            operation,
            parentBlockId: nestUnder,
            toolId: input.turnId,
            before: null,
          },
          { before: null, after: null },
          "not_intercepted",
        ),
      );
      return;
    }
    if (event.kind === "usage") {
      if (nestUnder !== null) {
        return;
      }
      emit({
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
      permissionMode,
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
    await Promise.all(settling);
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
    await Promise.all(settling);
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
  edit: {
    readonly filePath: string;
    readonly operation: CheckpointFileOperation;
    readonly beforeHash: string | null;
    readonly afterHash: string | null;
    readonly reason: FileEditReason;
  },
): StoredFileChange | null {
  const existing = chat.accumulatedChanges.findIndex(
    (row) => row.filePath === edit.filePath,
  );
  const prior = existing < 0 ? null : chat.accumulatedChanges[existing];
  const row: StoredFileChange = {
    filePath: edit.filePath,
    operation:
      prior === null || edit.operation === "delete"
        ? edit.operation
        : prior.operation,
    // The FIRST before and the LATEST after: that is what "since this chat
    // started" means.
    beforeHash: prior === null ? edit.beforeHash : prior.beforeHash,
    afterHash: edit.afterHash,
    reason:
      prior !== null && prior.reason !== "snapshot"
        ? prior.reason
        : edit.reason,
    // Measured by the caller once the hashes are known; null until then.
    counts: null,
  };
  // A file edited back to exactly what it was has not changed since the chat
  // started, and the panel lists files that have.
  if (row.reason === "snapshot" && row.beforeHash === row.afterHash) {
    if (existing >= 0) {
      chat.accumulatedChanges.splice(existing, 1);
    }
    return null;
  }
  if (existing < 0) {
    chat.accumulatedChanges.push(row);
  } else {
    chat.accumulatedChanges[existing] = row;
  }
  return row;
}

/** The tools whose permission question is about files, and the keys their paths ride. */
const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  // Codex's file-change item, whose paths ride its announcement.
  "apply_patch",
]);
const EDIT_PATH_KEYS = [
  "file_path",
  "path",
  "filePath",
  "notebook_path",
  "notebookPath",
] as const;

function editPaths(input: unknown): string[] {
  if (input === null || typeof input !== "object") {
    return [];
  }
  const paths = new Set<string>();
  for (const key of EDIT_PATH_KEYS) {
    const value = Reflect.get(input, key);
    if (typeof value === "string" && value.length > 0) {
      paths.add(value);
    }
  }
  return [...paths];
}

function isInside(root: string, filePath: string): boolean {
  const rel = relative(root, filePath);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * The host's answer to "may this tool run", which is the one place every
 * permission mode is decided - the CLI is always run in `default` and asks.
 *
 * Mirrors the released host's callback: `full_access` allows; an edit tool is
 * a file question, auto-approved under `auto_accept_edits` when every path is
 * inside the workspace and asked otherwise; anything else is asked under
 * every mode but `full_access`. `ExitPlanMode` is refused outright: the
 * released host turns it into a plan card, and this host runs no plan mode,
 * so an allow would hand the CLI a mode nothing here can follow.
 */
async function decidePermission(
  runtime: HostRuntime,
  input: { readonly epicId: string; readonly chatId: string },
  request: {
    readonly requestId: string;
    readonly toolUseId: string | null;
    readonly toolName: string;
    readonly description: string;
    readonly input: unknown;
  },
  permissionMode: string | null,
  cwd: string,
  turn: {
    readonly userMessageId: string | null;
    /** For a Codex file-change item, the files its announcement named. */
    readonly announcedPaths: readonly string[];
    readonly announcedOperation: CheckpointFileOperation | null;
  },
): Promise<void> {
  const answer = (
    response:
      | { readonly behavior: "allow"; readonly updatedInput: unknown }
      | { readonly behavior: "deny"; readonly message: string },
  ): void => {
    runtime.guiRuns.answerPermission(
      input.chatId,
      request.requestId,
      response,
      request,
    );
  };
  if (request.toolName === "ExitPlanMode") {
    answer({
      behavior: "deny",
      message:
        "This host does not run plan mode. Continue without switching modes.",
    });
    return;
  }
  if (isInterviewTool(request.toolName)) {
    // Ahead of `full_access`: a question the agent asks the user is not a
    // permission, and no mode answers it for them.
    const questions = interviewQuestions(request.input);
    if (questions.length === 0) {
      answer({
        behavior: "deny",
        message: "AskUserQuestion did not include any renderable questions.",
      });
      return;
    }
    await openInterview(runtime, input, request, questions, turn);
    return;
  }
  if (permissionMode === "full_access") {
    answer({ behavior: "allow", updatedInput: request.input });
    return;
  }
  const paths = EDIT_TOOLS.has(request.toolName)
    ? request.toolName === "apply_patch"
      ? turn.announcedPaths
      : editPaths(request.input)
    : [];
  const isFileEdit = paths.length > 0;
  if (
    isFileEdit &&
    permissionMode === "auto_accept_edits" &&
    paths.every((path) => isInside(cwd, path))
  ) {
    answer({ behavior: "allow", updatedInput: request.input });
    return;
  }
  const id = request.toolUseId ?? request.requestId;
  const now = Date.now();
  const pending: PendingApproval = isFileEdit
    ? {
        kind: "file_edit",
        approvalId: `${id}:file-edit`,
        requestId: request.requestId,
        toolUseId: request.toolUseId,
        toolName: request.toolName,
        description: request.description,
        input: request.input,
        requestedAt: now,
        paths,
        operation:
          turn.announcedOperation ??
          fileChangeOperation(
            request.toolName === "NotebookEdit" &&
              Reflect.get(request.input ?? {}, "edit_mode") === "delete"
              ? "delete"
              : null,
            paths[0] ?? "",
          ),
      }
    : {
        kind: "tool",
        approvalId: `${id}:approval`,
        requestId: request.requestId,
        toolUseId: request.toolUseId,
        toolName: request.toolName,
        description: request.description,
        input: request.input,
        requestedAt: now,
        paths: [],
        operation: null,
      };
  runtime.guiRuns.addApproval(input.chatId, pending);
  if (pending.kind === "tool") {
    broadcastBlockDelta(runtime, input.epicId, input.chatId, {
      type: "approval.requested",
      blockId: pending.approvalId,
      timestamp: now,
      toolName: pending.toolName,
      description: pending.description,
      input: pending.input,
    });
  }
  broadcastChatFrame(
    runtime,
    input.epicId,
    input.chatId,
    pending.kind === "tool"
      ? { kind: "approvalRequested", approval: approvalState(pending) }
      : {
          kind: "fileEditApprovalRequested",
          approval: fileEditApprovalState(pending),
        },
  );
  broadcastEventAppended(runtime, input.epicId, input.chatId, {
    type: "approval.requested",
    message: pending.description,
    turnId: runtime.guiRuns.printState(input.chatId)?.turnId ?? null,
    messageId: turn.userMessageId,
    clientActionId: null,
    severity: "warning",
  });
  await notify(runtime, {
    id: `approval.requested:${input.chatId}`,
    kind: "approval.requested",
    epicId: input.epicId,
    chatId: input.chatId,
    severity: "needs_action",
    outcome: null,
    sourceRef: pending.approvalId,
    message: `Approval needed: ${pending.description}`,
  });
  broadcastChatSnapshot(runtime, input.epicId, input.chatId);
}

export function approvalState(pending: PendingApproval): {
  readonly approvalId: string;
  readonly toolName: string;
  readonly description: string;
  readonly input: unknown;
  readonly requestedAt: number;
  readonly kind: "tool";
  readonly planId: null;
  readonly actions: readonly never[];
} {
  return {
    approvalId: pending.approvalId,
    toolName: pending.toolName,
    description: pending.description,
    input: pending.input ?? null,
    requestedAt: pending.requestedAt,
    kind: "tool",
    planId: null,
    actions: [],
  };
}

export function fileEditApprovalState(pending: PendingApproval): {
  readonly approvalId: string;
  readonly toolName: string;
  readonly description: string;
  readonly paths: readonly string[];
  readonly operation: CheckpointFileOperation;
  readonly input: unknown;
  readonly requestedAt: number;
} {
  return {
    approvalId: pending.approvalId,
    toolName: pending.toolName,
    description: pending.description,
    paths: pending.paths,
    operation: pending.operation ?? "edit",
    input: pending.input ?? null,
    requestedAt: pending.requestedAt,
  };
}

/**
 * The GUI's decision on one open question, relayed to the CLI. False when
 * there is no such question open - already answered, or abandoned with the
 * turn that asked it.
 */
export async function resolveApproval(
  runtime: HostRuntime,
  input: {
    readonly epicId: string;
    readonly chatId: string;
    readonly approvalId: string;
    readonly decision: {
      readonly approved: boolean;
      readonly reason: string | null;
    };
  },
): Promise<boolean> {
  const pending = runtime.guiRuns.takeApproval(input.chatId, input.approvalId);
  if (pending === null) {
    return false;
  }
  runtime.guiRuns.answerPermission(
    input.chatId,
    pending.requestId,
    input.decision.approved
      ? { behavior: "allow", updatedInput: pending.input }
      : {
          behavior: "deny",
          message: input.decision.reason ?? "Permission denied by user",
        },
    pending,
  );
  await settleApproval(runtime, input.epicId, input.chatId, pending, {
    approved: input.decision.approved,
    reason: input.decision.reason,
    abandoned: false,
  });
  return true;
}

async function abandonApprovals(
  runtime: HostRuntime,
  epicId: string,
  chatId: string,
  reason: string,
): Promise<void> {
  for (const pending of runtime.guiRuns.takeAllApprovals(chatId)) {
    runtime.guiRuns.answerPermission(
      chatId,
      pending.requestId,
      { behavior: "deny", message: reason },
      pending,
    );
    if (pending.kind === "interview") {
      await settleInterview(runtime, epicId, chatId, pending, {
        kind: "error",
        reason,
      });
      continue;
    }
    await settleApproval(runtime, epicId, chatId, pending, {
      approved: false,
      reason,
      abandoned: true,
    });
  }
}

/** The tools whose call is a question for the user, by the released host's list. */
function isInterviewTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
  return normalized === "askuserquestion" || normalized === "requestuserinput";
}

type InterviewQuestion = {
  readonly questionId: string | null;
  readonly question: string;
  readonly header: string | null;
  readonly options: readonly {
    readonly label: string;
    readonly description: string | null;
    readonly preview: string | null;
  }[];
  readonly multiSelect: boolean;
};

type InterviewAnswer = {
  readonly questionId: string | null;
  readonly question: string | null;
  readonly values: readonly string[];
  readonly notes: string | null;
};

function readText(record: object, key: string): string | null {
  const value = Reflect.get(record, key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The tool's `questions`, normalized the way the released host reads them. */
function interviewQuestions(input: unknown): InterviewQuestion[] {
  if (input === null || typeof input !== "object") {
    return [];
  }
  const raw = Reflect.get(input, "questions");
  if (!Array.isArray(raw)) {
    return [];
  }
  const questions: InterviewQuestion[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const question = readText(entry, "question");
    if (question === null) {
      continue;
    }
    const rawOptions = Reflect.get(entry, "options");
    const options = Array.isArray(rawOptions)
      ? rawOptions.flatMap((option: unknown) => {
          if (option === null || typeof option !== "object") {
            return [];
          }
          const label = readText(option, "label");
          return label === null
            ? []
            : [
                {
                  label,
                  description: readText(option, "description"),
                  preview: readText(option, "preview"),
                },
              ];
        })
      : [];
    const multi = Reflect.get(entry, "multiSelect");
    const multiple = Reflect.get(entry, "multiple");
    questions.push({
      questionId: readText(entry, "id") ?? readText(entry, "questionId"),
      question,
      header: readText(entry, "header"),
      options,
      multiSelect:
        typeof multi === "boolean"
          ? multi
          : typeof multiple === "boolean"
            ? multiple
            : false,
    });
  }
  return questions;
}

/**
 * A question for the user, opened as an interview card and held until the
 * GUI answers it or the turn ends. Everything a request leaves behind
 * mirrors the released host: the block, the `interviewRequested` frame, the
 * log event, the notification, and the snapshot's pending entry.
 */
async function openInterview(
  runtime: HostRuntime,
  input: { readonly epicId: string; readonly chatId: string },
  request: {
    readonly requestId: string;
    readonly toolUseId: string | null;
    readonly toolName: string;
    readonly description: string;
    readonly input: unknown;
  },
  questions: readonly InterviewQuestion[],
  turn: { readonly userMessageId: string | null },
): Promise<void> {
  const now = Date.now();
  const pending: PendingApproval = {
    kind: "interview",
    approvalId: `${request.toolUseId ?? request.requestId}:interview`,
    requestId: request.requestId,
    toolUseId: request.toolUseId,
    toolName: request.toolName,
    description: request.description,
    input: request.input,
    requestedAt: now,
    paths: [],
    operation: null,
  };
  runtime.guiRuns.addApproval(input.chatId, pending);
  broadcastBlockDelta(runtime, input.epicId, input.chatId, {
    type: "interview.requested",
    blockId: pending.approvalId,
    timestamp: now,
    toolName: request.toolName,
    title: request.toolName,
    questions: questions.map((question) => ({
      ...question,
      options: [...question.options],
    })),
    input: request.input,
  });
  broadcastChatFrame(runtime, input.epicId, input.chatId, {
    kind: "interviewRequested",
    blockId: pending.approvalId,
    requestedAt: now,
  });
  broadcastEventAppended(runtime, input.epicId, input.chatId, {
    type: "interview.requested",
    message: "Interview requested.",
    turnId: runtime.guiRuns.printState(input.chatId)?.turnId ?? null,
    messageId: turn.userMessageId,
    clientActionId: null,
    severity: "warning",
  });
  await notify(runtime, {
    id: `interview.requested:${input.chatId}`,
    kind: "interview.requested",
    epicId: input.epicId,
    chatId: input.chatId,
    severity: "needs_action",
    outcome: null,
    sourceRef: pending.approvalId,
    message: questions[0]?.question ?? "The agent asked a question.",
  });
  broadcastChatSnapshot(runtime, input.epicId, input.chatId);
}

/**
 * The GUI's answers, relayed as the tool's input plus an `answers` map -
 * the shape the released host hands back, and the one the CLI turns into
 * "The user answered: …" for the model. False when no such question is open.
 */
export async function answerInterview(
  runtime: HostRuntime,
  input: {
    readonly epicId: string;
    readonly chatId: string;
    readonly blockId: string;
    readonly answers: readonly InterviewAnswer[];
  },
): Promise<boolean> {
  const pending = runtime.guiRuns.takeApproval(input.chatId, input.blockId);
  if (pending === null || pending.kind !== "interview") {
    return false;
  }
  const answers: { [question: string]: string } = {};
  const annotations: { [question: string]: { readonly notes: string } } = {};
  for (const answer of input.answers) {
    if (answer.question === null) {
      continue;
    }
    answers[answer.question] = answer.values.join(", ");
    if (answer.notes !== null) {
      annotations[answer.question] = { notes: answer.notes };
    }
  }
  const base =
    pending.input !== null && typeof pending.input === "object"
      ? pending.input
      : {};
  runtime.guiRuns.answerPermission(
    input.chatId,
    pending.requestId,
    {
      behavior: "allow",
      updatedInput: {
        ...base,
        answers,
        ...(Object.keys(annotations).length === 0 ? {} : { annotations }),
      },
    },
    pending,
  );
  await settleInterview(runtime, input.epicId, input.chatId, pending, {
    kind: "success",
    answers: input.answers,
  });
  return true;
}

/** The GUI declining to answer: the tool is refused with the reason. */
export async function failInterview(
  runtime: HostRuntime,
  input: {
    readonly epicId: string;
    readonly chatId: string;
    readonly blockId: string;
    readonly reason: string;
  },
): Promise<boolean> {
  const pending = runtime.guiRuns.takeApproval(input.chatId, input.blockId);
  if (pending === null || pending.kind !== "interview") {
    return false;
  }
  runtime.guiRuns.answerPermission(
    input.chatId,
    pending.requestId,
    { behavior: "deny", message: input.reason },
    pending,
  );
  await settleInterview(runtime, input.epicId, input.chatId, pending, {
    kind: "error",
    reason: input.reason,
  });
  return true;
}

async function settleInterview(
  runtime: HostRuntime,
  epicId: string,
  chatId: string,
  pending: PendingApproval,
  outcome:
    | { readonly kind: "success"; readonly answers: readonly InterviewAnswer[] }
    | { readonly kind: "error"; readonly reason: string },
): Promise<void> {
  const now = Date.now();
  if (outcome.kind === "success") {
    const answers = outcome.answers.map((answer) => ({
      questionId: answer.questionId,
      question: answer.question,
      values: [...answer.values],
      notes: answer.notes,
      selection: null,
    }));
    broadcastBlockDelta(runtime, epicId, chatId, {
      type: "interview.resolved",
      blockId: pending.approvalId,
      timestamp: now,
      answers,
    });
    broadcastChatFrame(runtime, epicId, chatId, {
      kind: "interviewAnswered",
      blockId: pending.approvalId,
      answers,
      resolvedAt: now,
    });
    broadcastEventAppended(runtime, epicId, chatId, {
      type: "interview.resolved",
      message: "Interview completed.",
      turnId: runtime.guiRuns.printState(chatId)?.turnId ?? null,
      messageId: null,
      clientActionId: null,
      severity: "info",
    });
  } else {
    broadcastBlockDelta(runtime, epicId, chatId, {
      type: "interview.errored",
      blockId: pending.approvalId,
      timestamp: now,
      error: outcome.reason,
    });
    broadcastChatFrame(runtime, epicId, chatId, {
      kind: "interviewErrored",
      blockId: pending.approvalId,
      reason: outcome.reason,
      resolvedAt: now,
    });
    broadcastEventAppended(runtime, epicId, chatId, {
      type: "interview.errored",
      message: outcome.reason,
      turnId: runtime.guiRuns.printState(chatId)?.turnId ?? null,
      messageId: null,
      clientActionId: null,
      severity: "warning",
    });
  }
  if (
    runtime.guiRuns
      .approvalsOf(chatId)
      .every((open) => open.kind !== "interview")
  ) {
    await resolveNotification(runtime, `interview.requested:${chatId}`, now);
  }
  broadcastChatSnapshot(runtime, epicId, chatId);
}

/** Everything a decision leaves behind: the block, the frame, the log, the notification. */
async function settleApproval(
  runtime: HostRuntime,
  epicId: string,
  chatId: string,
  pending: PendingApproval,
  outcome: {
    readonly approved: boolean;
    readonly reason: string | null;
    readonly abandoned: boolean;
  },
): Promise<void> {
  const now = Date.now();
  const decision = {
    approved: outcome.approved,
    ...(outcome.reason === null ? {} : { reason: outcome.reason }),
  };
  if (pending.kind === "tool") {
    broadcastBlockDelta(runtime, epicId, chatId, {
      type: "approval.resolved",
      blockId: pending.approvalId,
      timestamp: now,
      decision,
    });
  }
  broadcastChatFrame(runtime, epicId, chatId, {
    kind:
      pending.kind === "tool" ? "approvalResolved" : "fileEditApprovalResolved",
    approvalId: pending.approvalId,
    decision,
    resolvedAt: now,
  });
  if (!outcome.approved) {
    broadcastEventAppended(runtime, epicId, chatId, {
      type: outcome.abandoned ? "approval.abandoned" : "approval.denied",
      message: outcome.reason ?? "Permission denied by user",
      turnId: runtime.guiRuns.printState(chatId)?.turnId ?? null,
      messageId: null,
      clientActionId: null,
      severity: "warning",
    });
  }
  if (runtime.guiRuns.approvalsOf(chatId).length === 0) {
    await resolveNotification(runtime, `approval.requested:${chatId}`, now);
  }
  broadcastChatSnapshot(runtime, epicId, chatId);
}

/** The prompt-kind notification, resolved the way the read-state RPC resolves one. */
async function resolveNotification(
  runtime: HostRuntime,
  id: string,
  now: number,
): Promise<void> {
  const touched = await runtime.store.mutate((state) => {
    const row = state.notifications.find(
      (entry) => entry.id === id && entry.resolvedAt === null,
    );
    if (row === undefined) {
      return false;
    }
    row.resolvedAt = now;
    row.readAt = row.readAt ?? now;
    row.updatedAt = now;
    return true;
  });
  if (touched) {
    broadcastReadState(runtime, [id], now, now);
  }
}

type PendingEdit = {
  readonly blockId: string;
  readonly path: string;
  readonly operation: CheckpointFileOperation;
  /** The sub-agent card this edit was made under, or null at the top. */
  readonly parentBlockId: string | null;
  /** The call (or Codex item) that owns this edit; one item may own several. */
  readonly toolId: string;
  /**
   * The before, captured by this host at the moment the edit was announced
   * - Codex, whose app-server names the files ahead of the approval that
   * gates the write. Null when hooks capture both sides (Claude).
   */
  readonly before: Promise<SnapshotCapture> | null;
};

/**
 * Close one file card from what was captured around its call, and fold the
 * edit into the chat's accumulated set.
 *
 * `missing` is the reason for a side no sidecar was found for: `capture_failed`
 * when the hooks were installed and did not report, `not_intercepted` when
 * nothing was ever asked to. Both are the contract's words.
 */
async function completeEdit(
  runtime: HostRuntime,
  input: { readonly epicId: string; readonly chatId: string },
  edit: PendingEdit,
  captured: {
    readonly before: SnapshotCapture | null;
    readonly after: SnapshotCapture | null;
  },
  missing: FileEditReason,
): Promise<void> {
  const dir = snapshotDir(runtime.dataDir);
  const before = captured.before ?? { hash: null, reason: missing };
  const after = captured.after ?? { hash: null, reason: missing };
  const reason: FileEditReason =
    before.reason !== "snapshot"
      ? before.reason
      : after.reason !== "snapshot"
        ? after.reason
        : "snapshot";
  const snapshot = reason === "snapshot";
  // Existence on both sides is the one thing the captures know better than
  // the call's input did.
  const operation: CheckpointFileOperation = !snapshot
    ? edit.operation
    : before.hash === null && after.hash !== null
      ? "create"
      : before.hash !== null && after.hash === null
        ? "delete"
        : "edit";
  const counts = snapshot
    ? lineCounts(
        before.hash === null ? null : await readBlob(dir, before.hash),
        after.hash === null ? null : await readBlob(dir, after.hash),
      )
    : { additions: 0, deletions: 0 };
  const now = Date.now();
  const nested =
    edit.parentBlockId === null ? {} : { parentBlockId: edit.parentBlockId };
  broadcastBlockDelta(runtime, input.epicId, input.chatId, {
    type: "file_change.started",
    blockId: edit.blockId,
    timestamp: now,
    ...nested,
    filePath: edit.path,
    operation,
  });
  broadcastBlockDelta(runtime, input.epicId, input.chatId, {
    type: "file_change.completed",
    blockId: edit.blockId,
    timestamp: now,
    ...nested,
    filePath: edit.path,
    operation,
    diffSource: snapshot ? "snapshot" : "none",
    beforeHash: snapshot ? before.hash : null,
    afterHash: snapshot ? after.hash : null,
    additions: counts.additions,
    deletions: counts.deletions,
    reason,
  });
  const measured: StoredFileChange | null = await runtime.store.mutate(
    (state) => {
      const row = state.chats.find(
        (chatRow) => chatRow.chatId === input.chatId,
      );
      if (row === undefined) {
        return null;
      }
      const recorded = recordFileChange(row, {
        filePath: edit.path,
        operation,
        beforeHash: snapshot ? before.hash : null,
        afterHash: snapshot ? after.hash : null,
        reason,
      });
      bumpChatIndex(row);
      return recorded;
    },
  );
  // The accumulated counts span the chat, not this edit, so they are measured
  // between the row's own hashes - which may be an older before than this
  // call's.
  if (measured !== null && measured.reason === "snapshot") {
    const spanCounts = lineCounts(
      measured.beforeHash === null
        ? null
        : await readBlob(dir, measured.beforeHash),
      measured.afterHash === null
        ? null
        : await readBlob(dir, measured.afterHash),
    );
    await runtime.store.mutate((state) => {
      const row = state.chats.find(
        (chatRow) => chatRow.chatId === input.chatId,
      );
      const index =
        row?.accumulatedChanges.findIndex(
          (change) => change.filePath === edit.path,
        ) ?? -1;
      if (row === undefined || index < 0) {
        return;
      }
      const current = row.accumulatedChanges[index];
      if (current !== undefined) {
        row.accumulatedChanges[index] = { ...current, counts: spanCounts };
      }
    });
  }
  broadcastAccumulatedChanges(runtime, input.epicId, input.chatId);
}

/**
 * The provider's own word where it has one, and the file system where it does
 * not: a Claude edit tool names a path and a payload, never whether the file
 * was already there.
 *
 * Read at the moment the call is parsed, which is a guess racing the write -
 * so it is the FALLBACK, used only for a change nothing captured. A captured
 * one takes its operation from whether each side existed.
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
  // A question nobody answered before the turn ended is answered for them,
  // in the negative, and said so - the CLI is gone or going, and a card left
  // "pending" would offer a decision with nowhere to land.
  await abandonApprovals(
    runtime,
    epicId,
    chatId,
    failure === null && !stopped ? "Turn ended before a decision." : "Aborted",
  );
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
