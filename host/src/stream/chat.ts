import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { WebSocket } from "ws";
import {
  messageSchema,
  type Message,
} from "@traycer/protocol/persistence/epic/messages";
import {
  buildRowSkeleton,
  transcriptPreviewProjection,
} from "@traycer/protocol/persistence/chat-transcript/build-skeleton";
import { assistantRowId } from "@traycer/protocol/persistence/chat-transcript/row-projection";
import {
  ROW_SKELETON_PREVIEW_MAX_CHARS,
  type RowSkeletonEntry,
} from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import {
  finishContentFingerprint,
  pushContentFingerprint,
  startContentFingerprint,
} from "@traycer/protocol/utils/text/digest";
import { guiHarnessIdSchema } from "@traycer/protocol/host/agent/shared";
import type { RuntimeEvent } from "@traycer/protocol/host/agent/gui/agent-runtime";
import type { WorktreeBinding } from "@traycer/protocol/host/worktree-schemas";
import { derivedChatTitle } from "../agent/gui-chat";
import { LOCAL_USER_ID } from "../local-user";
import type { HostRuntime } from "../runtime";
import type {
  StoredChat,
  StoredChatEvent,
  StoredTurn,
} from "../store/host-store";
import { bumpChatIndex } from "../store/host-store";
import type { GuiPrintTurnState } from "../gui/deliver";
import { resolveChatWorktreeBinding } from "../worktree/service";
import { changeDigest } from "../snapshots/snapshots";

type ChatWindowedTranscript = {
  readonly epicId: string;
  readonly chatId: string;
  /**
   * The coordinate space every ordinal in this transcript is numbered in. It
   * is `transcriptEpoch` and nothing else: the client seats its window on the
   * snapshot's `transcriptEpoch` and discards any skeleton chunk, range or
   * locate answer stamped with a different one, so a frame that hard-coded 0
   * went unread from the first turn that advanced the epoch.
   */
  readonly epoch: number;
  readonly messages: readonly Message[];
  readonly skeleton: readonly RowSkeletonEntry[];
  readonly snapshot: unknown;
  readonly skeletonChunk: unknown;
};

export type ChatRangeRequest = {
  readonly epicId: string;
  readonly chatId: string;
  readonly requestId: string;
  readonly fromOrdinal: number;
  readonly toOrdinal: number;
};

export function sendChatSnapshot(
  socket: WebSocket,
  runtime: HostRuntime,
  epicId: string,
  chatId: string,
): void {
  const transcript = chatWindowedTranscript(runtime, epicId, chatId);
  sendJson(socket, transcript.snapshot);
  sendJson(socket, transcript.skeletonChunk);
  sendJson(socket, accumulatedChangesFrame(runtime, epicId, chatId));
}

/**
 * The accumulated-change summaries, which the snapshot promises but does not
 * carry: their count is a property of the chat's HISTORY - one entry per file
 * ever touched - so they ride their own frame.
 *
 * Sent on every snapshot and after every change, always as ONE final chunk
 * from index 0. The chunking protocol exists for a refactor that touched
 * thousands of files; this host has no such volume to split, and a single
 * final chunk is a valid stream of one.
 *
 * A row whose every edit was captured carries its hashes as the digest and
 * its span counts; one that was not carries the reason and `counts: null`,
 * so the panel renders a bare row rather than offering a diff that would
 * come back empty.
 */
function accumulatedChangesFrame(
  runtime: HostRuntime,
  epicId: string,
  chatId: string,
): unknown {
  const chat = runtime.store
    .snapshot()
    .chats.find((row) => row.chatId === chatId && row.epicId === epicId);
  const changes = chat === undefined ? [] : chat.accumulatedChanges;
  return {
    kind: "accumulatedChanges",
    hasBinaryPayload: false,
    epicId,
    chatId,
    chunk: {
      epoch: chat === undefined ? 0 : chat.transcriptEpoch,
      // Monotonic per chat and bumped by every change, so a re-stream after
      // one is a new generation and the client rebuilds instead of extending.
      generation: chat === undefined ? 0 : chat.indexRevision,
      fromIndex: 0,
      summaries: changes.map((row) => ({
        filePath: row.filePath,
        operation: row.operation,
        diffSource:
          row.reason === "snapshot" ? ("snapshot" as const) : ("none" as const),
        reason: row.reason,
        // A before blob is what a restore would write back, and this host
        // serves no restore action yet - so no row claims to be undoable.
        undoable: false,
        hasContents: row.reason === "snapshot",
        // The two hashes ARE the version: a later edit changes the after,
        // and a request naming the old pair is refused as stale.
        digest: changeDigest(row.beforeHash, row.afterHash),
        counts: row.reason === "snapshot" ? row.counts : null,
      })),
      isFinal: true,
    },
  };
}

export function broadcastAccumulatedChanges(
  runtime: HostRuntime,
  epicId: string,
  chatId: string,
): void {
  const frame = accumulatedChangesFrame(runtime, epicId, chatId);
  for (const socket of runtime.chats.sockets(epicId, chatId)) {
    sendJson(socket, frame);
  }
}

export function broadcastChatSnapshot(
  runtime: HostRuntime,
  epicId: string,
  chatId: string,
): void {
  const transcript = chatWindowedTranscript(runtime, epicId, chatId);
  const changes = accumulatedChangesFrame(runtime, epicId, chatId);
  for (const socket of runtime.chats.sockets(epicId, chatId)) {
    sendJson(socket, transcript.snapshot);
    sendJson(socket, transcript.skeletonChunk);
    sendJson(socket, changes);
  }
  // The chat-records table is the same fact at list granularity, so it moves
  // from the one place that already knows this chat changed rather than from
  // every caller that changes one.
  runtime.chatRecords.publish(runtime, epicId, chatId);
}

export function sendChatRange(
  socket: WebSocket,
  runtime: HostRuntime,
  request: ChatRangeRequest,
): void {
  sendJson(socket, chatRangeFrame(runtime, request));
}

export function sendChatJson(socket: WebSocket, frame: unknown): void {
  sendJson(socket, frame);
}

export function broadcastQueueChanged(
  runtime: HostRuntime,
  epicId: string,
  chatId: string,
): void {
  const queue = runtime.queue.snapshot(chatId);
  for (const socket of runtime.chats.sockets(epicId, chatId)) {
    sendJson(socket, {
      kind: "queueChanged",
      hasBinaryPayload: false,
      epicId,
      chatId,
      queue,
    });
  }
}

export function broadcastTurnStateChanged(
  runtime: HostRuntime,
  epicId: string,
  chatId: string,
): void {
  const print = runtime.guiRuns.printState(chatId);
  const frame = {
    kind: "turnStateChanged",
    hasBinaryPayload: false,
    epicId,
    chatId,
    runStatus: print === null ? "idle" : "running",
    activeTurn: activeTurnFrame(print, chatId),
    backgroundItems: [],
    turnInProgress: print !== null,
  };
  for (const socket of runtime.chats.sockets(epicId, chatId)) {
    sendJson(socket, frame);
  }
}

/**
 * Send one block delta to every subscriber of this chat, and fold it into the
 * turn's block state on the way out.
 *
 * The fold lives HERE rather than at the emission sites because this is the
 * only door: a delta the GUI sees but the fold missed would be a block that
 * exists until the chat is reopened and then does not, which is the exact
 * failure this is closing. Typed as a `RuntimeEvent` for the same reason -
 * the reducer only understands real ones, and a loose shape would have let a
 * near-miss through to be silently ignored.
 */
export function broadcastBlockDelta(
  runtime: HostRuntime,
  epicId: string,
  chatId: string,
  event: RuntimeEvent,
): void {
  runtime.guiRuns.foldTurnBlock(chatId, event);
  const frame = {
    kind: "blockDelta",
    hasBinaryPayload: false,
    epicId,
    chatId,
    event,
  };
  for (const socket of runtime.chats.sockets(epicId, chatId)) {
    sendJson(socket, frame);
  }
}

export function broadcastEventAppended(
  runtime: HostRuntime,
  epicId: string,
  chatId: string,
  event: {
    readonly type: string;
    readonly message: string | null;
    readonly turnId: string | null;
    readonly messageId: string | null;
    readonly clientActionId: string | null;
    readonly severity: "info" | "warning" | "error";
  },
): void {
  const stored: StoredChatEvent = {
    eventId: randomUUID(),
    type: event.type,
    timestamp: Date.now(),
    clientActionId: event.clientActionId,
    actor: null,
    message: event.message,
    turnId: event.turnId,
    messageId: event.messageId,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: event.severity,
    metadata: null,
  };
  void runtime.store.mutate((state) => {
    const chat = state.chats.find((row) => row.chatId === chatId);
    if (chat === undefined) {
      return;
    }
    chat.events.push(stored);
    bumpChatIndex(chat);
  });
  const frame = {
    kind: "eventAppended",
    hasBinaryPayload: false,
    epicId,
    chatId,
    event: stored,
  };
  for (const socket of runtime.chats.sockets(epicId, chatId)) {
    sendJson(socket, frame);
  }
}

export function broadcastErrorNotice(
  runtime: HostRuntime,
  epicId: string,
  chatId: string,
  notice: {
    readonly code: string;
    readonly message: string;
    readonly severity: "info" | "warning" | "error";
    readonly clientActionId: string | null;
  },
): void {
  const frame = {
    kind: "errorNotice",
    hasBinaryPayload: false,
    epicId,
    chatId,
    notice,
  };
  for (const socket of runtime.chats.sockets(epicId, chatId)) {
    sendJson(socket, frame);
  }
}

export function broadcastWorktreeStateChanged(
  runtime: HostRuntime,
  epicId: string,
  chatId: string,
): void {
  const worktreeBinding = resolveChatWorktreeBinding(runtime, epicId, chatId);
  const missingWorktreePaths = missingPaths(worktreeBinding);
  const frame = {
    kind: "worktreeStateChanged",
    hasBinaryPayload: false,
    epicId,
    chatId,
    worktreeBinding,
    missingWorktreePaths,
  };
  for (const socket of runtime.chats.sockets(epicId, chatId)) {
    sendJson(socket, frame);
  }
}

export function chatWindowedTranscript(
  runtime: HostRuntime,
  epicId: string,
  chatId: string,
): ChatWindowedTranscript {
  // Keyed by `(epicId, chatId)`, which is how every chat-scoped frame and
  // socket set on this host is keyed: a chat id alone does not address a chat,
  // and matching on it would serve one epic's transcript under another's id.
  const chat =
    runtime.store
      .snapshot()
      .chats.find((row) => row.chatId === chatId && row.epicId === epicId) ??
    emptyChat(runtime.hostId, epicId, chatId);
  const messages = protocolMessages(chat.turns);
  const skeleton = rowSkeleton(chatId, messages);
  const ownerUserId = chatOwnerUserId(chat);
  const rowIds = skeleton.map((entry) => entry.rowId);
  const print = runtime.guiRuns.printState(chatId);
  const worktreeBinding = resolveChatWorktreeBinding(runtime, epicId, chatId);
  const missingWorktreePaths = missingPaths(worktreeBinding);
  return {
    epicId,
    chatId,
    epoch: chat.transcriptEpoch,
    messages,
    skeleton,
    snapshot: {
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId,
      chatId,
      snapshot: {
        chat: {
          parentId: chat.parentId,
          id: chat.chatId,
          userId: ownerUserId,
          hostId: chat.hostId,
          title: derivedChatTitle(chat),
          createdAt: chat.createdAt,
          updatedAt: latestTurnTime(chat),
          isTitleEditedByUser: chat.title.length > 0,
          settings: chat.runSettings,
        },
        access: {
          role: "owner",
          ownerUserId,
          canAct: true,
        },
        queue: runtime.queue.snapshot(chatId),
        runStatus: print === null ? "idle" : "running",
        activeTurn: activeTurnFrame(print, chatId),
        pendingApprovals: [],
        pendingInterviews: [],
        worktreeBinding,
        missingWorktreePaths,
        pendingFileEditApprovals: [],
        // The array's length, never a running tally of edits: the client
        // compares this against the summaries it received and treats a
        // mismatch as a lost delivery worth re-requesting.
        accumulatedFileChangeCount: chat.accumulatedChanges.length,
        managedCommands: [],
        heldUpdates: [],
        turnInProgress: print !== null,
        transcriptEpoch: chat.transcriptEpoch,
        rowCount: skeleton.length,
        indexRevision: chat.indexRevision === 0 ? null : chat.indexRevision,
        tail: {
          fromOrdinal: 0,
          rowIds,
          messages,
          events: chat.events,
        },
        derived: {
          latestAssistantUsage: chat.lastUsage,
          // The client's fold selects the most recent non-empty todo and
          // carries it forward, so the stored one IS that answer. Painted from
          // here rather than from the rows, which on this line are a window.
          pinnedTodo: chat.pinnedTodo,
          // The Traycer task tools (`TaskCreate`/`TaskUpdate`/...) are the
          // other half of that fold, and this host serves none of them - no
          // tool call reaching it can be one.
          pinnedTaskTodoItems: [],
          latestForkableAssistantMessageId: lastAssistantMessageId(messages),
          restorableSetupInterruption: null,
          interviewAnswerability: [],
          // The host's answer is authoritative on this line: the client reads
          // it from the snapshot rather than scanning `messages`, because the
          // window it holds is a subset and a failure a few user rows back
          // falls outside it.
          latestAssistantAuthFailureTurnKey: chat.lastAuthFailureTurnId,
          setupCardWindows: [],
        },
      },
    },
    skeletonChunk: {
      kind: "skeletonChunk",
      hasBinaryPayload: false,
      epicId,
      chatId,
      chunk: {
        epoch: chat.transcriptEpoch,
        fromOrdinal: 0,
        entries: skeleton,
        isFinal: true,
      },
    },
  };
}

function chatRangeFrame(
  runtime: HostRuntime,
  request: ChatRangeRequest,
): unknown {
  const transcript = chatWindowedTranscript(
    runtime,
    request.epicId,
    request.chatId,
  );
  const lastOrdinal = transcript.skeleton.length - 1;
  const fromOrdinal = request.fromOrdinal < 0 ? 0 : request.fromOrdinal;
  const toOrdinal = request.toOrdinal;
  const served =
    transcript.skeleton.length === 0 || fromOrdinal > lastOrdinal
      ? []
      : transcript.skeleton.slice(
          fromOrdinal,
          Math.min(toOrdinal, lastOrdinal) + 1,
        );
  const servedIds = new Set(served.map((entry) => entry.rowId));
  const messages = transcript.messages.filter((message) =>
    servedIds.has(rowIdForMessage(message)),
  );
  return {
    kind: "range",
    hasBinaryPayload: false,
    epicId: request.epicId,
    chatId: request.chatId,
    range: {
      requestId: request.requestId,
      epoch: transcript.epoch,
      fromOrdinal,
      rowIds: served.map((entry) => entry.rowId),
      messages,
      events: [],
      rowContext: {},
      reachedStart: fromOrdinal <= 0,
      reachedEnd: toOrdinal >= lastOrdinal,
    },
  };
}

export function protocolMessages(turns: readonly StoredTurn[]): Message[] {
  const messages: Message[] = [];
  for (const turn of turns) {
    const parsed = messageSchema.safeParse(turnToMessage(turn));
    if (parsed.success) {
      messages.push(parsed.data);
    }
  }
  return messages;
}

export function rowSkeleton(
  chatId: string,
  messages: readonly Message[],
): readonly RowSkeletonEntry[] {
  try {
    return buildRowSkeleton(
      {
        messages,
        events: [],
        activeTurnId: null,
        chatId,
      },
      transcriptPreviewProjection,
    );
  } catch {
    return fallbackSkeleton(messages);
  }
}

function fallbackSkeleton(
  messages: readonly Message[],
): readonly RowSkeletonEntry[] {
  return messages.map((message) => {
    const rowId = rowIdForMessage(message);
    const digest = startContentFingerprint();
    pushContentFingerprint(digest, message.messageId);
    const preview =
      message.role === "user" && message.sender.type === "user"
        ? collapsedPreview(plainTextFromUnknown(message.message))
        : undefined;
    return {
      rowId,
      createdAt: message.timestamp,
      role: message.role === "assistant" ? "assistant" : "user",
      byteLength: 0,
      bodyDigest: finishContentFingerprint(digest),
      ...(preview === undefined ? {} : { preview }),
    };
  });
}

function rowIdForMessage(message: Message): string {
  if (message.role === "assistant") {
    return assistantRowId(message.turnId ?? message.messageId);
  }
  return message.messageId;
}

function lastAssistantMessageId(messages: readonly Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && message.role === "assistant") {
      return message.messageId;
    }
  }
  return null;
}

function collapsedPreview(text: string): string | undefined {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) {
    return undefined;
  }
  return collapsed.slice(0, ROW_SKELETON_PREVIEW_MAX_CHARS);
}

function plainTextFromUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || typeof value !== "object") {
    return "";
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => plainTextFromUnknown(entry))
      .filter((part) => part.length > 0)
      .join(" ");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  if ("content" in record) {
    return plainTextFromUnknown(record.content);
  }
  return "";
}

function activeTurnFrame(print: GuiPrintTurnState | null, chatId: string) {
  if (print === null) {
    return null;
  }
  const harness = guiHarnessIdSchema.safeParse(print.harnessId);
  if (!harness.success) {
    return null;
  }
  return {
    turnId: print.turnId,
    status: "running" as const,
    harnessId: harness.data,
    model: print.model.length > 0 ? print.model : "default",
    reasoningEffort: null,
    serviceTier: null,
    agentMode: "regular" as const,
    profileId: null,
    userMessageId: print.userMessageId,
    startedAt: print.startedAt,
    updatedAt: Date.now(),
    sameTurnSteeringSupported: false,
  };
}

export function chatOwnerUserId(chat: StoredChat): string {
  for (const turn of chat.turns) {
    if (turn.userId !== null && turn.userId.length > 0) {
      return turn.userId;
    }
  }
  return LOCAL_USER_ID;
}

function missingPaths(worktreeBinding: WorktreeBinding | null): string[] {
  if (worktreeBinding === null) {
    return [];
  }
  return worktreeBinding.entries
    .map((entry) => entry.worktreePath ?? entry.workspacePath)
    .filter((path) => !existsSync(path));
}

function emptyChat(hostId: string, epicId: string, chatId: string): StoredChat {
  return {
    epicId,
    chatId,
    parentId: null,
    hostId,
    title: "",
    createdAt: Date.now(),
    runSettings: null,
    providerSession: null,
    turns: [],
    events: [],
    transcriptEpoch: 0,
    indexRevision: 0,
    accumulatedChanges: [],
    lastUsage: null,
    archivedAt: null,
    lastAuthFailureTurnId: null,
    pinnedTodo: null,
    fastMode: false,
  };
}

export function latestTurnTime(chat: StoredChat): number {
  const last = chat.turns[chat.turns.length - 1];
  return last === undefined ? chat.createdAt : last.timestamp;
}

export function assistantTextBlockId(messageId: string): string {
  return `${messageId}-text`;
}

export function assistantReasoningBlockId(messageId: string): string {
  return `${messageId}-reasoning`;
}

export function turnToMessage(turn: StoredTurn) {
  const reply = turn.expectReply
    ? {
        expectsReply: true as const,
        responseId: turn.responseId ?? turn.messageId,
      }
    : { expectsReply: false as const };
  const harnessId = turn.fromHarnessId ?? "claude";
  const agentSender = {
    type: "agent" as const,
    harnessId,
    agentId: turn.fromAgentId,
    displayName: turn.fromTitle,
    reply,
    inReplyTo: null,
  };
  if (turn.role === "assistant") {
    return {
      role: "assistant" as const,
      messageId: turn.messageId,
      sender: agentSender,
      // What the turn actually did, when the run recorded it. The lone text
      // block is the fallback for a turn that recorded nothing - one written
      // before this host folded blocks, or one whose harness produced no
      // stream at all - and it is why every tool call, edit and error used to
      // vanish the moment a chat was reopened.
      blocks: turn.blocks ?? [
        {
          blockId: assistantTextBlockId(turn.messageId),
          status: "completed" as const,
          timestamp: turn.timestamp,
          type: "text" as const,
          text: turn.prompt,
          providerNotice: null,
        },
      ],
      startedAt: turn.timestamp,
      timestamp: turn.timestamp,
      turnId: turn.turnId ?? turn.messageId,
      usage: null,
      reasoningEffort: null,
      serviceTier: null,
      envCredentialVar: null,
      imageResolutions: [],
    };
  }
  if (turn.userId !== null) {
    return {
      role: "user" as const,
      messageId: turn.messageId,
      sender: { type: "user" as const, userId: turn.userId },
      message: {
        kind: "user" as const,
        content: turn.content ?? promptDoc(turn.prompt),
      },
      timestamp: turn.timestamp,
      sessionAnchor: null,
    };
  }
  return {
    role: "user" as const,
    messageId: turn.messageId,
    sender: agentSender,
    message: {
      kind: "agent" as const,
      content: promptDoc(turn.prompt),
      fromAgentId: turn.fromAgentId,
      senderTitle: turn.fromTitle,
      senderHarnessId: harnessId,
      reply,
    },
    timestamp: turn.timestamp,
    sessionAnchor: null,
  };
}

function promptDoc(prompt: string) {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: prompt }],
      },
    ],
  };
}

function sendJson(socket: WebSocket, frame: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(frame));
  }
}
