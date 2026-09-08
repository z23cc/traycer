import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";
import type { WebSocket } from "ws";
import {
  turnCheckpointManifestSchema,
  type RestoreResultEntry,
  type TurnCheckpointManifest,
  type TurnCheckpointManifestEntry,
} from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import { isInside } from "../agent/artifact-command";
import { LOCAL_USER_ID } from "../local-user";
import { lineCounts, readBlob, snapshotDir } from "../snapshots/snapshots";
import {
  bumpChatIndex,
  type StoredChat,
  type StoredFileChange,
} from "../store/host-store";
import {
  beginGuiPrintTurn,
  deleteTurnsFrom,
  drainGuiQueue,
  extractPlainText,
  persistChatRunSettings,
  persistGuiUserTurn,
  readHarnessId,
  readModelSlug,
  answerInterview,
  failInterview,
  readUserId,
  resolveApproval,
  steerQueuedPrompt,
} from "../agent/gui-chat";
import type { HostRuntime } from "../runtime";
import {
  sendChatJson,
  sendChatRange,
  sendChatSnapshot,
  turnToMessage,
  broadcastAccumulatedChanges,
  broadcastChatFrame,
  broadcastChatSnapshot,
  broadcastChatEvent,
  broadcastErrorNotice,
  broadcastEventAppended,
  broadcastQueueChanged,
  broadcastTurnStateChanged,
  broadcastWorktreeStateChanged,
} from "./chat";

export function handleChatClientFrame(
  parsed: object,
  socket: WebSocket,
  runtime: HostRuntime,
): boolean {
  const kind = Reflect.get(parsed, "kind");
  if (kind === "send") {
    void handleChatSend(parsed, socket, runtime);
    return true;
  }
  if (kind === "stop") {
    handleChatStop(parsed, socket, runtime);
    return true;
  }
  if (kind === "resnapshot") {
    handleChatResnapshot(parsed, socket, runtime);
    return true;
  }
  if (kind === "loadRange") {
    handleChatLoadRange(parsed, socket, runtime);
    return true;
  }
  if (kind === "deleteMessageSuffix") {
    void handleChatDeleteSuffix(parsed, socket, runtime);
    return true;
  }
  if (kind === "editUserMessage") {
    void handleChatEditUser(parsed, socket, runtime);
    return true;
  }
  if (kind === "revertFileChanges") {
    void handleChatRevertFileChanges(parsed, socket, runtime);
    return true;
  }
  if (kind === "approvalDecision" || kind === "fileEditApprovalDecision") {
    void handleChatApprovalDecision(parsed, socket, runtime, kind);
    return true;
  }
  if (kind === "interviewAnswer" || kind === "interviewError") {
    void handleChatInterviewReply(parsed, socket, runtime, kind);
    return true;
  }
  if (kind === "pauseQueue") {
    handleChatPauseQueue(parsed, socket, runtime);
    return true;
  }
  if (kind === "resumeQueue") {
    handleChatResumeQueue(parsed, socket, runtime);
    return true;
  }
  if (kind === "queueCancel") {
    handleChatQueueCancel(parsed, socket, runtime);
    return true;
  }
  if (kind === "queueEdit") {
    handleChatQueueEdit(parsed, socket, runtime);
    return true;
  }
  if (kind === "stopBackgroundItem") {
    handleChatStopBackgroundItem(parsed, socket, runtime);
    return true;
  }
  if (kind === "stopAllBackgroundItems") {
    handleChatStopAllBackgroundItems(parsed, socket, runtime);
    return true;
  }
  if (kind === "stopBackgroundSession") {
    handleChatStopBackgroundSession(parsed, socket, runtime);
    return true;
  }
  if (kind === "queueSteerNow") {
    void handleChatQueueSteerNow(parsed, socket, runtime);
    return true;
  }
  if (kind === "queueAbortSteer") {
    handleChatQueueAbortSteer(parsed, socket, runtime);
    return true;
  }
  if (kind === "queueReorder") {
    handleChatQueueReorder(parsed, socket, runtime);
    return true;
  }
  if (kind === "activePermissionModeUpdate") {
    void handlePermissionModeUpdate(parsed, socket, runtime);
    return true;
  }
  return false;
}

async function handleChatSend(
  parsed: object,
  socket: WebSocket,
  runtime: HostRuntime,
): Promise<void> {
  const ids = readActionIds(parsed);
  const messageId = readStringField(parsed, "messageId");
  if (ids === null || messageId === null) {
    return;
  }
  const content = Reflect.get(parsed, "content");
  const prompt = extractPlainText(content);
  const settings = Reflect.get(parsed, "settings");
  const harnessId =
    readHarnessId(settings) ??
    runtime.store.snapshot().agents.find((row) => row.id === ids.chatId)
      ?.harnessId ??
    "claude";
  const model =
    readModelSlug(settings) ??
    readModelSlug(
      runtime.store.snapshot().chats.find((row) => row.chatId === ids.chatId)
        ?.runSettings,
    );
  // A host under a shutdown claim starts no new work, as released: the
  // send is refused with the claim's code, and the refusal is on the
  // timeline as `send.failed`.
  if (runtime.shutdown.current(Date.now()) !== null) {
    const reason = "The host is shutting down and cannot start new work.";
    ack(socket, ids, "send", "rejected", reason, "HOST_SHUTDOWN_CLAIMED");
    broadcastChatEvent(runtime, ids.epicId, ids.chatId, {
      type: "send.failed",
      message: reason,
      turnId: runtime.guiRuns.printState(ids.chatId)?.turnId ?? null,
      messageId,
      queueItemId: null,
      clientActionId: ids.clientActionId,
      severity: "warning",
      metadata: null,
    });
    broadcastErrorNotice(runtime, ids.epicId, ids.chatId, {
      code: "HOST_SHUTDOWN_CLAIMED",
      message: reason,
      severity: "warning",
      clientActionId: ids.clientActionId,
    });
    return;
  }
  const busy =
    runtime.guiRuns.printState(ids.chatId) !== null ||
    runtime.queue.pendingCount(ids.chatId) > 0 ||
    runtime.queue.isPaused(ids.chatId);
  if (busy) {
    const item = runtime.queue.enqueue(ids.chatId, {
      messageId,
      prompt,
      content: content ?? null,
      userId: readUserId(Reflect.get(parsed, "sender")),
      settings: settings === undefined ? null : settings,
      accountContext: Reflect.get(parsed, "accountContext") ?? {
        type: "PERSONAL",
      },
      harnessId,
      model,
    });
    ack(socket, ids, "send", "accepted", null, null);
    broadcastChatEvent(runtime, ids.epicId, ids.chatId, {
      type: "queue.added",
      message: "Queued message accepted.",
      turnId: runtime.guiRuns.printState(ids.chatId)?.turnId ?? null,
      messageId,
      queueItemId: item.queueItemId,
      clientActionId: ids.clientActionId,
      severity: "info",
      metadata: { item: queueWireItem(runtime, ids.chatId, item.queueItemId) },
    });
    broadcastQueueChanged(runtime, ids.epicId, ids.chatId);
    sendChatSnapshot(socket, runtime, ids.epicId, ids.chatId);
    // Mod-Enter: the sender wants this in the running turn, not after it.
    // With no turn running, or one already being steered, it runs next like
    // any other queued item - the released host's "downgrade".
    if (
      Reflect.get(parsed, "deliveryPolicy") === "after_safe_point" &&
      runtime.guiRuns.printState(ids.chatId) !== null &&
      !runtime.guiRuns.wasStopped(ids.chatId) &&
      !runtime.queue.isSteering(ids.chatId)
    ) {
      await steerQueuedPrompt(runtime, ids.epicId, ids.chatId, item);
    }
    return;
  }
  const turn = await persistGuiUserTurn(runtime, {
    epicId: ids.epicId,
    chatId: ids.chatId,
    messageId,
    prompt,
    content: content ?? null,
    userId: readUserId(Reflect.get(parsed, "sender")),
    harnessId,
    runSettings: settings === undefined ? null : settings,
  });
  if (turn === null) {
    ack(socket, ids, "send", "rejected", "Chat not found", "CHAT_NOT_FOUND");
    return;
  }
  beginGuiPrintTurn(runtime, {
    epicId: ids.epicId,
    chatId: ids.chatId,
    harnessId,
    prompt,
    responseId: turn.responseId,
    model,
    autonomous: false,
  });
  broadcastWorktreeStateChanged(runtime, ids.epicId, ids.chatId);
  ack(socket, ids, "send", "accepted", null, null);
  sendChatJson(socket, {
    kind: "messageAccepted",
    hasBinaryPayload: false,
    epicId: ids.epicId,
    chatId: ids.chatId,
    message: turnToMessage(turn),
  });
  broadcastEventAppended(runtime, ids.epicId, ids.chatId, {
    type: "send.accepted",
    message: "Send accepted.",
    turnId: null,
    messageId: turn.messageId,
    clientActionId: ids.clientActionId,
    severity: "info",
  });
  sendChatSnapshot(socket, runtime, ids.epicId, ids.chatId);
}

function handleChatStop(
  parsed: object,
  socket: WebSocket,
  runtime: HostRuntime,
): void {
  const ids = readActionIds(parsed);
  if (ids === null) {
    return;
  }
  const stopped = runtime.guiRuns.requestStop(ids.chatId);
  ack(
    socket,
    ids,
    "stop",
    stopped ? "accepted" : "rejected",
    stopped ? null : "No turn in progress",
    stopped ? null : "TURN_NOT_ACTIVE",
  );
  if (stopped) {
    // `stopping` until the process is gone; its exit is what makes it idle.
    broadcastTurnStateChanged(runtime, ids.epicId, ids.chatId);
  }
  if (!stopped) {
    broadcastErrorNotice(runtime, ids.epicId, ids.chatId, {
      code: "NO_ACTIVE_TURN",
      message: "No turn in progress",
      severity: "warning",
      clientActionId: ids.clientActionId,
    });
  }
}

/**
 * The user's reply to a question the agent asked: answers, or a reason for
 * not answering. Either way the CLI is told and the card settles.
 */
async function handleChatInterviewReply(
  parsed: object,
  socket: WebSocket,
  runtime: HostRuntime,
  action: "interviewAnswer" | "interviewError",
): Promise<void> {
  const ids = readActionIds(parsed);
  const blockId = readStringField(parsed, "blockId");
  if (ids === null || blockId === null) {
    return;
  }
  const open = runtime.guiRuns
    .approvalsOf(ids.chatId)
    .some(
      (pending) =>
        pending.kind === "interview" && pending.approvalId === blockId,
    );
  ack(
    socket,
    ids,
    action,
    open ? "accepted" : "rejected",
    open ? null : "The interview request is no longer pending.",
    open ? null : "INTERVIEW_NOT_FOUND",
  );
  if (!open) {
    return;
  }
  if (action === "interviewError") {
    await failInterview(runtime, {
      epicId: ids.epicId,
      chatId: ids.chatId,
      blockId,
      reason: readStringField(parsed, "reason") ?? "Question dismissed.",
    });
    return;
  }
  const rawAnswers = Reflect.get(parsed, "answers");
  const answers = Array.isArray(rawAnswers)
    ? rawAnswers.flatMap((entry: unknown) => {
        if (entry === null || typeof entry !== "object") {
          return [];
        }
        const values = Reflect.get(entry, "values");
        return [
          {
            questionId: readStringField(entry, "questionId"),
            question: readStringField(entry, "question"),
            values: Array.isArray(values)
              ? values.filter(
                  (value): value is string => typeof value === "string",
                )
              : [],
            notes: readStringField(entry, "notes"),
          },
        ];
      })
    : [];
  await answerInterview(runtime, {
    epicId: ids.epicId,
    chatId: ids.chatId,
    blockId,
    answers,
  });
}

/**
 * The user's answer to a permission question. Both frames land here: the
 * tool and file-edit questions differ in what the GUI shows, not in what
 * the CLI is told.
 */
async function handleChatApprovalDecision(
  parsed: object,
  socket: WebSocket,
  runtime: HostRuntime,
  action: "approvalDecision" | "fileEditApprovalDecision",
): Promise<void> {
  const ids = readActionIds(parsed);
  const approvalId = readStringField(parsed, "approvalId");
  const decision = Reflect.get(parsed, "decision");
  const approved =
    decision === null || typeof decision !== "object"
      ? null
      : Reflect.get(decision, "approved");
  if (ids === null || approvalId === null || typeof approved !== "boolean") {
    return;
  }
  const reason =
    decision === null || typeof decision !== "object"
      ? null
      : readStringField(decision, "reason");
  // The ack goes first, as every action's does: it says the decision was
  // understood, and the resolution frame that follows says what it did.
  const open = runtime.guiRuns
    .approvalsOf(ids.chatId)
    .some((pending) => pending.approvalId === approvalId);
  ack(
    socket,
    ids,
    action,
    open ? "accepted" : "rejected",
    open ? null : "No such approval is open on this chat.",
    open ? null : "APPROVAL_NOT_FOUND",
  );
  if (!open) {
    return;
  }
  await resolveApproval(runtime, {
    epicId: ids.epicId,
    chatId: ids.chatId,
    approvalId,
    decision: { approved, reason },
  });
}

/**
 * The accumulated panel's Undo: write each file's FIRST before back over it.
 *
 * Whole-chat scope only. `fromMessageId` names a turn's checkpoint, and this
 * host keeps no per-turn checkpoints - it keeps one accumulated row per file,
 * which is exactly what `fromMessageId: null` reverts. Refused rather than
 * approximated: a turn-scoped revert that reverted the whole chat would undo
 * work the user asked to keep.
 *
 * The three restore frames are the contract's, in the contract's order. The
 * ack goes first, as every other action's does: it says the request was
 * understood, and the frames say what happened to the files.
 */
async function handleChatRevertFileChanges(
  parsed: object,
  socket: WebSocket,
  runtime: HostRuntime,
): Promise<void> {
  const ids = readActionIds(parsed);
  if (ids === null) {
    return;
  }
  const rawFrom = Reflect.get(parsed, "fromMessageId");
  const fromMessageId = typeof rawFrom === "string" ? rawFrom : null;
  const filePaths = readStringArrayField(parsed, "filePaths");
  const includeArtifacts = Reflect.get(parsed, "revertArtifacts") !== false;
  // The GUI disables Undo while a turn runs, but the host is the authority
  // and the two can race - seen live, where a revert accepted mid-turn wrote
  // the first before back under an agent that was still working on the file.
  if (runtime.guiRuns.printState(ids.chatId) !== null) {
    ack(
      socket,
      ids,
      "revertFileChanges",
      "rejected",
      "Wait for the active chat turn to finish or stop it before reverting file changes.",
      "CHECKPOINT_RESTORE_ACTIVE_TURN",
    );
    return;
  }
  const chat = runtime.store
    .snapshot()
    .chats.find(
      (row) => row.chatId === ids.chatId && row.epicId === ids.epicId,
    );
  if (chat === undefined) {
    ack(
      socket,
      ids,
      "revertFileChanges",
      "rejected",
      "Chat not found",
      "CHAT_NOT_FOUND",
    );
    return;
  }
  const manifests = scopedCheckpoints(chat, fromMessageId);
  if (
    manifests.some((manifest) => manifest.capturingHostId !== runtime.hostId)
  ) {
    ack(
      socket,
      ids,
      "revertFileChanges",
      "rejected",
      "These changes can only be reverted on the host that captured them.",
      "CHECKPOINT_DEVICE_MISMATCH",
    );
    return;
  }
  // The earliest record of each path is the way back: a file edited in three
  // turns is restored once, to what it was before the first of them.
  const targets = [...earliestEntriesByPath(manifests).values()].filter(
    ({ entry }) =>
      (filePaths === null || filePaths.includes(entry.filePath)) &&
      (includeArtifacts || !entry.artifact),
  );
  ack(socket, ids, "revertFileChanges", "accepted", null, null);
  // The revert is named by the action that asked for it, as released - the
  // same click retried is the same revert.
  const checkpointId = ids.clientActionId;
  const started = {
    checkpointId,
    restoringUserId: LOCAL_USER_ID,
    restoringHostId: runtime.hostId,
    startedAt: Date.now(),
  };
  broadcastChatFrame(runtime, ids.epicId, ids.chatId, {
    kind: "restoreStarted",
    ...started,
  });
  broadcastChatEvent(runtime, ids.epicId, ids.chatId, {
    type: "checkpoint.restoreStarted",
    message: "File-change revert started.",
    turnId: checkpointId,
    messageId: null,
    queueItemId: null,
    clientActionId: ids.clientActionId,
    severity: "info",
    metadata: started,
  });
  const dir = snapshotDir(runtime.dataDir);
  const results: RestoreResultEntry[] = [];
  for (const { manifest, entry } of targets) {
    results.push(await restoreEntry(dir, manifest, entry));
    broadcastChatFrame(runtime, ids.epicId, ids.chatId, {
      kind: "restoreProgress",
      checkpointId,
      processedCount: results.length,
      totalCount: targets.length,
    });
  }
  await refreshAccumulatedAfterRestore(
    runtime,
    ids.chatId,
    dir,
    targets,
    results,
  );
  const restored = { checkpointId, restoredAt: Date.now(), results };
  broadcastChatFrame(runtime, ids.epicId, ids.chatId, {
    kind: "restoreCompleted",
    checkpointId,
    finishedAt: restored.restoredAt,
    results,
  });
  broadcastChatEvent(runtime, ids.epicId, ids.chatId, {
    type: "checkpoint.restored",
    message: "File changes reverted.",
    turnId: checkpointId,
    messageId: null,
    queueItemId: null,
    clientActionId: ids.clientActionId,
    severity: results.some((entry) => entry.status === "failed")
      ? "warning"
      : "info",
    metadata: restored,
  });
  broadcastAccumulatedChanges(runtime, ids.epicId, ids.chatId);
  broadcastChatSnapshot(runtime, ids.epicId, ids.chatId);
}

type ScopedEntry = {
  readonly manifest: TurnCheckpointManifest;
  readonly entry: TurnCheckpointManifestEntry;
};

/**
 * The turns' checkpoints a revert reads, in the order they were captured:
 * all of them, or - from a message on - those of the user messages at and
 * after it. A message this chat does not have scopes nothing, as released.
 */
function scopedCheckpoints(
  chat: StoredChat,
  fromMessageId: string | null,
): TurnCheckpointManifest[] {
  const manifests = chat.events
    .filter((event) => event.type === "checkpoint.captured")
    .map((event) => ({
      messageId: event.messageId,
      parsed: turnCheckpointManifestSchema.safeParse(event.metadata),
    }));
  if (fromMessageId === null) {
    return manifests.flatMap((row) =>
      row.parsed.success ? [row.parsed.data] : [],
    );
  }
  const from = chat.turns.findIndex((turn) => turn.messageId === fromMessageId);
  if (from < 0) {
    return [];
  }
  const inScope = new Set(
    chat.turns
      .slice(from)
      .filter((turn) => turn.role === "user")
      .map((turn) => turn.messageId),
  );
  return manifests.flatMap((row) =>
    row.parsed.success && row.messageId !== null && inScope.has(row.messageId)
      ? [row.parsed.data]
      : [],
  );
}

/**
 * The entry a cumulative revert restores each path to: the earliest turn's,
 * as the released host picks it - except that a later turn's entry replaces
 * one that could not be undone, and a later turn's artifact tag is carried
 * onto an earlier entry that has none.
 */
export function earliestEntriesByPath(
  manifests: readonly TurnCheckpointManifest[],
): Map<string, ScopedEntry> {
  const chosen = new Map<string, ScopedEntry>();
  for (const manifest of manifests) {
    for (const entry of manifest.entries) {
      if (entry.filePath.length === 0) {
        continue;
      }
      const held = chosen.get(entry.filePath);
      if (held === undefined) {
        chosen.set(entry.filePath, { manifest, entry });
        continue;
      }
      if (!held.entry.undoable && entry.undoable) {
        chosen.set(entry.filePath, { manifest, entry });
        continue;
      }
      const tag = entry.artifact ?? null;
      const heldTag = held.entry.artifact ?? null;
      if (
        tag !== null &&
        tag.artifactId !== null &&
        (heldTag === null || heldTag.artifactId === null)
      ) {
        chosen.set(entry.filePath, {
          manifest: held.manifest,
          entry: { ...held.entry, artifact: tag },
        });
      }
    }
  }
  return chosen;
}

/**
 * One entry back to its before, with the released host's outcomes: outside
 * the turn's roots or not captured is `skipped`, a before this store no
 * longer holds is `failed`, and a created file goes back to not existing.
 */
async function restoreEntry(
  dir: string,
  manifest: TurnCheckpointManifest,
  entry: TurnCheckpointManifestEntry,
): Promise<RestoreResultEntry> {
  const result = (
    status: RestoreResultEntry["status"],
    reason: string | null,
  ): RestoreResultEntry => ({
    filePath: entry.filePath,
    status,
    operation: entry.operation,
    reason,
  });
  if (!isPathInAllowedRoots(entry.filePath, manifest.allowedRoots)) {
    return result("skipped", "outside_root");
  }
  if (!entry.undoable) {
    return result("skipped", "not_undoable");
  }
  if (entry.operation === "create") {
    try {
      await rm(entry.filePath, { force: true, recursive: false });
      return result("restored", null);
    } catch {
      return result("failed", "fs_error");
    }
  }
  if (entry.beforeHash === null) {
    return result("skipped", "not_undoable");
  }
  const body = await readBlob(dir, entry.beforeHash);
  if (body === null) {
    return result("failed", "blob_missing");
  }
  try {
    await mkdir(dirname(entry.filePath), { recursive: true });
    await writeFile(entry.filePath, body);
    return result("restored", null);
  } catch {
    return result("failed", "fs_error");
  }
}

export function isPathInAllowedRoots(
  filePath: string,
  roots: readonly string[],
): boolean {
  return roots.some((root) => isInside(root, filePath));
}

/**
 * The accumulated panel after a revert: a restored file is at the before
 * its entry named, so its row's after moves there - and a row whose after
 * is now its before is a file that has not changed since the chat started,
 * which the panel does not list.
 */
async function refreshAccumulatedAfterRestore(
  runtime: HostRuntime,
  chatId: string,
  dir: string,
  targets: readonly ScopedEntry[],
  results: readonly RestoreResultEntry[],
): Promise<void> {
  const restoredTo = new Map<string, string | null>();
  targets.forEach(({ entry }, index) => {
    if (results[index]?.status === "restored") {
      restoredTo.set(
        entry.filePath,
        entry.operation === "create" ? null : entry.beforeHash,
      );
    }
  });
  if (restoredTo.size === 0) {
    return;
  }
  const chat = runtime.store
    .snapshot()
    .chats.find((row) => row.chatId === chatId);
  const next: StoredFileChange[] = [];
  for (const row of chat?.accumulatedChanges ?? []) {
    if (!restoredTo.has(row.filePath)) {
      next.push(row);
      continue;
    }
    const afterHash = restoredTo.get(row.filePath) ?? null;
    if (afterHash === row.beforeHash) {
      continue;
    }
    next.push({
      ...row,
      afterHash,
      operation:
        row.beforeHash === null
          ? "create"
          : afterHash === null
            ? "delete"
            : "edit",
      counts:
        row.reason === "snapshot"
          ? lineCounts(
              row.beforeHash === null
                ? null
                : await readBlob(dir, row.beforeHash),
              afterHash === null ? null : await readBlob(dir, afterHash),
            )
          : row.counts,
    });
  }
  await runtime.store.mutate((state) => {
    const row = state.chats.find((entry) => entry.chatId === chatId);
    if (row === undefined) {
      return;
    }
    row.accumulatedChanges = next;
    bumpChatIndex(row);
  });
}

function readStringArrayField(record: object, key: string): string[] | null {
  const value = Reflect.get(record, key);
  if (!Array.isArray(value)) {
    return null;
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function handleChatResnapshot(
  parsed: object,
  socket: WebSocket,
  runtime: HostRuntime,
): void {
  const epicId = readStringField(parsed, "epicId");
  const chatId = readStringField(parsed, "chatId");
  if (epicId === null || chatId === null) {
    return;
  }
  sendChatSnapshot(socket, runtime, epicId, chatId);
}

function handleChatLoadRange(
  parsed: object,
  socket: WebSocket,
  runtime: HostRuntime,
): void {
  const epicId = readStringField(parsed, "epicId");
  const chatId = readStringField(parsed, "chatId");
  const request = readRangeRequest(Reflect.get(parsed, "request"));
  if (epicId === null || chatId === null || request === null) {
    return;
  }
  sendChatRange(socket, runtime, {
    epicId,
    chatId,
    requestId: request.requestId,
    fromOrdinal: request.fromOrdinal,
    toOrdinal: request.toOrdinal,
  });
}

async function handleChatDeleteSuffix(
  parsed: object,
  socket: WebSocket,
  runtime: HostRuntime,
): Promise<void> {
  const ids = readActionIds(parsed);
  const fromMessageId = readStringField(parsed, "fromMessageId");
  if (ids === null || fromMessageId === null) {
    return;
  }
  const removed = await deleteTurnsFrom(runtime, {
    epicId: ids.epicId,
    chatId: ids.chatId,
    fromRowId: fromMessageId,
  });
  ack(
    socket,
    ids,
    "deleteMessageSuffix",
    removed ? "accepted" : "rejected",
    removed ? null : "Message not found",
    removed ? null : "MESSAGE_NOT_FOUND",
  );
}

async function handleChatEditUser(
  parsed: object,
  socket: WebSocket,
  runtime: HostRuntime,
): Promise<void> {
  const ids = readActionIds(parsed);
  const targetMessageId = readStringField(parsed, "targetMessageId");
  const messageId = readStringField(parsed, "messageId");
  if (ids === null || targetMessageId === null || messageId === null) {
    return;
  }
  const removed = await deleteTurnsFrom(runtime, {
    epicId: ids.epicId,
    chatId: ids.chatId,
    fromRowId: targetMessageId,
  });
  if (!removed) {
    ack(
      socket,
      ids,
      "editUserMessage",
      "rejected",
      "Message not found",
      "MESSAGE_NOT_FOUND",
    );
    return;
  }
  const content = Reflect.get(parsed, "content");
  const prompt = extractPlainText(content);
  const settings = Reflect.get(parsed, "settings");
  const harnessId =
    readHarnessId(settings) ??
    runtime.store.snapshot().agents.find((row) => row.id === ids.chatId)
      ?.harnessId ??
    "claude";
  const model =
    readModelSlug(settings) ??
    readModelSlug(
      runtime.store.snapshot().chats.find((row) => row.chatId === ids.chatId)
        ?.runSettings,
    );
  const turn = await persistGuiUserTurn(runtime, {
    epicId: ids.epicId,
    chatId: ids.chatId,
    messageId,
    prompt,
    content: content ?? null,
    userId: readUserId(Reflect.get(parsed, "sender")),
    harnessId,
    runSettings: settings === undefined ? null : settings,
  });
  if (turn === null) {
    ack(
      socket,
      ids,
      "editUserMessage",
      "rejected",
      "Chat not found",
      "CHAT_NOT_FOUND",
    );
    return;
  }
  ack(socket, ids, "editUserMessage", "accepted", null, null);
  sendChatJson(socket, {
    kind: "messageAccepted",
    hasBinaryPayload: false,
    epicId: ids.epicId,
    chatId: ids.chatId,
    message: turnToMessage(turn),
  });
  sendChatSnapshot(socket, runtime, ids.epicId, ids.chatId);
  beginGuiPrintTurn(runtime, {
    epicId: ids.epicId,
    chatId: ids.chatId,
    harnessId,
    prompt,
    responseId: turn.responseId,
    model,
    autonomous: false,
  });
}

/** One queued item as the wire shows it, for an event's `{item}` metadata. */
function queueWireItem(
  runtime: HostRuntime,
  chatId: string,
  queueItemId: string,
): unknown {
  return (
    runtime.queue
      .snapshot(chatId)
      .items.find((item) => item.queueItemId === queueItemId) ?? null
  );
}

/**
 * An accepted queue mutation's timeline entry, the released host's: the
 * event names the action's item, and its metadata carries the whole queue
 * as it now stands (`{items}`), so a replay can rebuild it.
 */
function recordQueueMutation(
  runtime: HostRuntime,
  ids: ActionIds,
  type: string,
  message: string,
  queueItemId: string | null,
): void {
  broadcastChatEvent(runtime, ids.epicId, ids.chatId, {
    type,
    message,
    turnId: runtime.guiRuns.printState(ids.chatId)?.turnId ?? null,
    messageId: null,
    queueItemId,
    clientActionId: ids.clientActionId,
    severity: "info",
    metadata: { items: [...runtime.queue.snapshot(ids.chatId).items] },
  });
}

function handleChatPauseQueue(
  parsed: object,
  socket: WebSocket,
  runtime: HostRuntime,
): void {
  const ids = readActionIds(parsed);
  if (ids === null) {
    return;
  }
  const paused = runtime.queue.pause(ids.chatId);
  ack(
    socket,
    ids,
    "pauseQueue",
    paused ? "accepted" : "rejected",
    paused ? null : "Queue already paused",
    paused ? null : "QUEUE_NOT_ACTIVE",
  );
  if (paused) {
    recordQueueMutation(runtime, ids, "queue.paused", "Queue paused.", null);
    broadcastQueueChanged(runtime, ids.epicId, ids.chatId);
    sendChatSnapshot(socket, runtime, ids.epicId, ids.chatId);
  }
}

function handleChatResumeQueue(
  parsed: object,
  socket: WebSocket,
  runtime: HostRuntime,
): void {
  const ids = readActionIds(parsed);
  if (ids === null) {
    return;
  }
  const resumed = runtime.queue.resume(ids.chatId);
  ack(
    socket,
    ids,
    "resumeQueue",
    resumed ? "accepted" : "rejected",
    resumed ? null : "Queue is not paused",
    resumed ? null : "QUEUE_NOT_PAUSED",
  );
  if (resumed) {
    recordQueueMutation(runtime, ids, "queue.resumed", "Queue resumed.", null);
    drainGuiQueue(runtime, ids.epicId, ids.chatId);
  }
}

function handleChatQueueCancel(
  parsed: object,
  socket: WebSocket,
  runtime: HostRuntime,
): void {
  const ids = readActionIds(parsed);
  const queueItemId = readStringField(parsed, "queueItemId");
  if (ids === null || queueItemId === null) {
    return;
  }
  const cancelled = runtime.queue.cancel(ids.chatId, queueItemId);
  ack(
    socket,
    ids,
    "queueCancel",
    cancelled ? "accepted" : "rejected",
    cancelled ? null : "Queue item not found",
    cancelled ? null : "QUEUE_ITEM_NOT_FOUND",
  );
  if (cancelled) {
    recordQueueMutation(
      runtime,
      ids,
      "queue.cancelled",
      "Queue updated.",
      queueItemId,
    );
    broadcastQueueChanged(runtime, ids.epicId, ids.chatId);
    sendChatSnapshot(socket, runtime, ids.epicId, ids.chatId);
  }
}

function handleChatQueueEdit(
  parsed: object,
  socket: WebSocket,
  runtime: HostRuntime,
): void {
  const ids = readActionIds(parsed);
  const queueItemId = readStringField(parsed, "queueItemId");
  if (ids === null || queueItemId === null) {
    return;
  }
  const content = Reflect.get(parsed, "content");
  const edited = runtime.queue.edit(
    ids.chatId,
    queueItemId,
    content ?? null,
    extractPlainText(content),
  );
  ack(
    socket,
    ids,
    "queueEdit",
    edited ? "accepted" : "rejected",
    edited ? null : "Queue item not found",
    edited ? null : "QUEUE_ITEM_NOT_FOUND",
  );
  if (edited) {
    recordQueueMutation(
      runtime,
      ids,
      "queue.edited",
      "Queue updated.",
      queueItemId,
    );
    broadcastQueueChanged(runtime, ids.epicId, ids.chatId);
    sendChatSnapshot(socket, runtime, ids.epicId, ids.chatId);
  }
}

/**
 * The panel's stop on one background command: a `stop_task` to the CLI that
 * runs it. The set of running tasks it reports back is what takes the row
 * off the panel. Words and codes are the released host's.
 */
function handleChatStopBackgroundItem(
  parsed: object,
  socket: WebSocket,
  runtime: HostRuntime,
): void {
  const ids = readActionIds(parsed);
  const taskId = readStringField(parsed, "taskId");
  if (ids === null || taskId === null) {
    return;
  }
  const stopped = runtime.guiRuns.stopBackgroundTask(ids.chatId, taskId);
  ack(
    socket,
    ids,
    "stopBackgroundItem",
    stopped ? "accepted" : "rejected",
    stopped ? null : "Background item is no longer running.",
    stopped ? null : "BACKGROUND_ITEM_NOT_FOUND",
  );
}

function handleChatStopAllBackgroundItems(
  parsed: object,
  socket: WebSocket,
  runtime: HostRuntime,
): void {
  const ids = readActionIds(parsed);
  if (ids === null) {
    return;
  }
  const accepted = runtime.guiRuns
    .backgroundItemsOf(ids.chatId)
    .map((item) => item.taskId)
    .filter((taskId) => runtime.guiRuns.stopBackgroundTask(ids.chatId, taskId));
  sendChatJson(socket, {
    kind: "actionAck",
    hasBinaryPayload: false,
    epicId: ids.epicId,
    chatId: ids.chatId,
    clientActionId: ids.clientActionId,
    action: "stopAllBackgroundItems",
    status: accepted.length > 0 ? "accepted" : "rejected",
    reason: accepted.length > 0 ? null : "No background work is running.",
    code: accepted.length > 0 ? null : "BACKGROUND_ITEM_NOT_FOUND",
    backgroundStopTaskIds: accepted,
  });
}

/**
 * The session-scoped stop exists for provider builds that cannot stop one
 * command; every command this host lists can be stopped on its own, so the
 * answer is the released host's for that case.
 */
function handleChatStopBackgroundSession(
  parsed: object,
  socket: WebSocket,
  runtime: HostRuntime,
): void {
  const ids = readActionIds(parsed);
  if (ids === null) {
    return;
  }
  const running = runtime.guiRuns.backgroundItemsOf(ids.chatId).length > 0;
  ack(
    socket,
    ids,
    "stopBackgroundSession",
    "rejected",
    running
      ? "No background command requires a session-scoped stop."
      : "No background work is running.",
    running ? "BACKGROUND_STOP_UNSUPPORTED" : "BACKGROUND_ITEM_NOT_FOUND",
  );
}

/**
 * "Steer now" on a queued item. The checks and their words are the released
 * host's; what follows an accepted ack is `steerQueuedPrompt`. `newSettings`
 * is read and ignored: a steer here always folds into the running turn, and
 * the settings that would need a restart (model, effort, tier) are baked into
 * the turn that already runs.
 */
async function handleChatQueueSteerNow(
  parsed: object,
  socket: WebSocket,
  runtime: HostRuntime,
): Promise<void> {
  const ids = readActionIds(parsed);
  const queueItemId = readStringField(parsed, "queueItemId");
  if (ids === null || queueItemId === null) {
    return;
  }
  const reject = (reason: string, code: string): void => {
    ack(socket, ids, "queueSteerNow", "rejected", reason, code);
  };
  if (
    runtime.guiRuns.printState(ids.chatId) === null ||
    runtime.guiRuns.wasStopped(ids.chatId)
  ) {
    reject("There is no active turn to steer.", "NO_ACTIVE_TURN");
    return;
  }
  const item = runtime.queue.find(ids.chatId, queueItemId);
  if (item === null) {
    reject("Queue item not found", "QUEUE_ITEM_NOT_FOUND");
    return;
  }
  if (item.status === "steering") {
    reject(
      "The queued prompt is already being submitted.",
      "QUEUE_ITEM_STEERING",
    );
    return;
  }
  if (runtime.queue.isSteering(ids.chatId)) {
    reject(
      "A queued prompt is already being steered.",
      "QUEUE_STEER_IN_FLIGHT",
    );
    return;
  }
  if (runtime.queue.isPaused(ids.chatId)) {
    reject(
      "Resume the queue before steering this queued prompt.",
      "QUEUE_ITEM_PAUSED",
    );
    return;
  }
  ack(socket, ids, "queueSteerNow", "accepted", null, null);
  await steerQueuedPrompt(runtime, ids.epicId, ids.chatId, item);
}

/**
 * A steer can only be called off while it is still waiting to be handed
 * over, and this host hands one over as soon as it is asked for - so there
 * is never one to abort, and the answer is the released host's for that case.
 */
function handleChatQueueAbortSteer(
  parsed: object,
  socket: WebSocket,
  runtime: HostRuntime,
): void {
  const ids = readActionIds(parsed);
  const queueItemId = readStringField(parsed, "queueItemId");
  if (ids === null || queueItemId === null) {
    return;
  }
  const item = runtime.queue.find(ids.chatId, queueItemId);
  if (item === null) {
    ack(
      socket,
      ids,
      "queueAbortSteer",
      "rejected",
      "Queue item not found",
      "QUEUE_ITEM_NOT_FOUND",
    );
    return;
  }
  ack(
    socket,
    ids,
    "queueAbortSteer",
    "rejected",
    item.status === "steering"
      ? "The queued prompt is already being submitted."
      : "The queued prompt is not waiting to steer.",
    item.status === "steering"
      ? "QUEUE_ITEM_STEERING"
      : "QUEUE_ITEM_NOT_STEERING",
  );
}

function handleChatQueueReorder(
  parsed: object,
  socket: WebSocket,
  runtime: HostRuntime,
): void {
  const ids = readActionIds(parsed);
  const queueItemId = readStringField(parsed, "queueItemId");
  if (ids === null || queueItemId === null) {
    return;
  }
  const beforeRaw = Reflect.get(parsed, "beforeQueueItemId");
  const beforeQueueItemId =
    typeof beforeRaw === "string" && beforeRaw.length > 0 ? beforeRaw : null;
  const reordered = runtime.queue.reorder(
    ids.chatId,
    queueItemId,
    beforeQueueItemId,
  );
  ack(
    socket,
    ids,
    "queueReorder",
    reordered ? "accepted" : "rejected",
    reordered ? null : "Queue item not found",
    reordered ? null : "QUEUE_ITEM_NOT_FOUND",
  );
  if (reordered) {
    recordQueueMutation(
      runtime,
      ids,
      "queue.reordered",
      "Queue updated.",
      queueItemId,
    );
    broadcastQueueChanged(runtime, ids.epicId, ids.chatId);
    sendChatSnapshot(socket, runtime, ids.epicId, ids.chatId);
  }
}

async function handlePermissionModeUpdate(
  parsed: object,
  socket: WebSocket,
  runtime: HostRuntime,
): Promise<void> {
  const ids = readActionIds(parsed);
  const permissionMode = readStringField(parsed, "permissionMode");
  if (ids === null || permissionMode === null) {
    return;
  }
  const chat = runtime.store
    .snapshot()
    .chats.find((row) => row.chatId === ids.chatId);
  if (chat === undefined || chat.epicId !== ids.epicId) {
    ack(
      socket,
      ids,
      "activePermissionModeUpdate",
      "rejected",
      "Chat not found",
      "CHAT_NOT_FOUND",
    );
    return;
  }
  const settings: { [key: string]: unknown } = { permissionMode };
  const current = chat.runSettings;
  if (
    current !== null &&
    typeof current === "object" &&
    !Array.isArray(current)
  ) {
    for (const key of Object.keys(current)) {
      settings[key] = Reflect.get(current, key);
    }
    settings.permissionMode = permissionMode;
  }
  const harnessId = readHarnessId(settings);
  const updated = await persistChatRunSettings(runtime, {
    epicId: ids.epicId,
    chatId: ids.chatId,
    settings,
    harnessId,
  });
  ack(
    socket,
    ids,
    "activePermissionModeUpdate",
    updated ? "accepted" : "rejected",
    updated ? null : "Chat not found",
    updated ? null : "CHAT_NOT_FOUND",
  );
}

function ack(
  socket: WebSocket,
  ids: ActionIds,
  action: string,
  status: "accepted" | "rejected",
  reason: string | null,
  code: string | null,
): void {
  sendChatJson(socket, {
    kind: "actionAck",
    hasBinaryPayload: false,
    epicId: ids.epicId,
    chatId: ids.chatId,
    clientActionId: ids.clientActionId,
    action,
    status,
    reason,
    code,
    backgroundStopTaskIds: [],
  });
}

type ActionIds = {
  readonly epicId: string;
  readonly chatId: string;
  readonly clientActionId: string;
};

function readActionIds(parsed: object): ActionIds | null {
  const epicId = readStringField(parsed, "epicId");
  const chatId = readStringField(parsed, "chatId");
  const clientActionId = readStringField(parsed, "clientActionId");
  if (epicId === null || chatId === null || clientActionId === null) {
    return null;
  }
  return { epicId, chatId, clientActionId };
}

function readStringField(record: object, key: string): string | null {
  const value = Reflect.get(record, key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readRangeRequest(value: unknown): {
  readonly requestId: string;
  readonly fromOrdinal: number;
  readonly toOrdinal: number;
} | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const requestId = readStringField(value, "requestId");
  const fromOrdinal = Reflect.get(value, "fromOrdinal");
  const toOrdinal = Reflect.get(value, "toOrdinal");
  if (
    requestId === null ||
    typeof fromOrdinal !== "number" ||
    typeof toOrdinal !== "number" ||
    !Number.isInteger(fromOrdinal) ||
    !Number.isInteger(toOrdinal) ||
    fromOrdinal < 0 ||
    toOrdinal < 0
  ) {
    return null;
  }
  return { requestId, fromOrdinal, toOrdinal };
}
