import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WebSocket } from "ws";
import type { RestoreResultEntry } from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import { LOCAL_USER_ID } from "../local-user";
import { hasBlob, readBlob, snapshotDir } from "../snapshots/snapshots";
import { bumpChatIndex, type StoredFileChange } from "../store/host-store";
import {
  beginGuiPrintTurn,
  deleteTurnsFrom,
  drainGuiQueue,
  extractPlainText,
  persistChatRunSettings,
  persistGuiUserTurn,
  readHarnessId,
  readModelSlug,
  readUserId,
  resolveApproval,
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
  broadcastErrorNotice,
  broadcastEventAppended,
  broadcastQueueChanged,
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
  const busy =
    runtime.guiRuns.printState(ids.chatId) !== null ||
    runtime.queue.pendingCount(ids.chatId) > 0 ||
    runtime.queue.isPaused(ids.chatId);
  if (busy) {
    runtime.queue.enqueue(ids.chatId, {
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
    broadcastQueueChanged(runtime, ids.epicId, ids.chatId);
    sendChatSnapshot(socket, runtime, ids.epicId, ids.chatId);
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
  const fromMessageId = Reflect.get(parsed, "fromMessageId");
  if (typeof fromMessageId === "string") {
    ack(
      socket,
      ids,
      "revertFileChanges",
      "rejected",
      "This host keeps no per-turn checkpoints; only a whole-chat revert is available.",
      "TURN_SCOPE_UNSUPPORTED",
    );
    return;
  }
  // The GUI disables Undo while a turn runs, but the host is the authority
  // and the two can race - seen live, where a revert accepted mid-turn wrote
  // the first before back under an agent that was still working on the file.
  if (runtime.guiRuns.printState(ids.chatId) !== null) {
    ack(
      socket,
      ids,
      "revertFileChanges",
      "rejected",
      "Wait for the active turn to finish before reverting.",
      "TURN_IN_PROGRESS",
    );
    return;
  }
  const filePaths = readStringArrayField(parsed, "filePaths");
  const chat = runtime.store
    .snapshot()
    .chats.find(
      (row) => row.chatId === ids.chatId && row.epicId === ids.epicId,
    );
  const dir = snapshotDir(runtime.dataDir);
  const targets = (chat?.accumulatedChanges ?? []).filter(
    (row) =>
      row.reason === "snapshot" &&
      (filePaths === null || filePaths.includes(row.filePath)) &&
      (row.beforeHash === null || hasBlob(dir, row.beforeHash)),
  );
  if (chat === undefined || targets.length === 0) {
    ack(
      socket,
      ids,
      "revertFileChanges",
      "rejected",
      "Nothing here can be reverted.",
      "NOTHING_TO_REVERT",
    );
    return;
  }
  ack(socket, ids, "revertFileChanges", "accepted", null, null);
  const checkpointId = randomUUID();
  const startedAt = Date.now();
  broadcastChatFrame(runtime, ids.epicId, ids.chatId, {
    kind: "restoreStarted",
    checkpointId,
    restoringUserId: LOCAL_USER_ID,
    restoringHostId: runtime.hostId,
    startedAt,
  });
  broadcastEventAppended(runtime, ids.epicId, ids.chatId, {
    type: "checkpoint.restoreStarted",
    message: `Reverting ${String(targets.length)} file${targets.length === 1 ? "" : "s"}.`,
    turnId: null,
    messageId: null,
    clientActionId: ids.clientActionId,
    severity: "info",
  });
  const results: RestoreResultEntry[] = [];
  for (const row of targets) {
    results.push(await revertOne(dir, row));
    broadcastChatFrame(runtime, ids.epicId, ids.chatId, {
      kind: "restoreProgress",
      checkpointId,
      processedCount: results.length,
      totalCount: targets.length,
    });
  }
  const restored = new Set(
    results
      .filter((entry) => entry.status === "restored")
      .map((entry) => entry.filePath),
  );
  await runtime.store.mutate((state) => {
    const row = state.chats.find((entry) => entry.chatId === ids.chatId);
    if (row === undefined) {
      return;
    }
    // A reverted file is back at its first before, which is the one state
    // the accumulated panel does not list.
    row.accumulatedChanges = row.accumulatedChanges.filter(
      (change) => !restored.has(change.filePath),
    );
    bumpChatIndex(row);
  });
  broadcastChatFrame(runtime, ids.epicId, ids.chatId, {
    kind: "restoreCompleted",
    checkpointId,
    finishedAt: Date.now(),
    results,
  });
  const failed = results.length - restored.size;
  broadcastEventAppended(runtime, ids.epicId, ids.chatId, {
    type: "checkpoint.restored",
    message:
      failed === 0
        ? `Reverted ${String(restored.size)} file${restored.size === 1 ? "" : "s"}.`
        : `Reverted ${String(restored.size)}, failed ${String(failed)}.`,
    turnId: null,
    messageId: null,
    clientActionId: ids.clientActionId,
    severity: failed === 0 ? "info" : "warning",
  });
  broadcastAccumulatedChanges(runtime, ids.epicId, ids.chatId);
  broadcastChatSnapshot(runtime, ids.epicId, ids.chatId);
}

/**
 * One file back to its first before. No before means the chat created it,
 * and the way back is its removal - `unlink` of a path already gone is the
 * same outcome, not a failure.
 */
async function revertOne(
  dir: string,
  row: StoredFileChange,
): Promise<RestoreResultEntry> {
  const entry = { filePath: row.filePath, operation: row.operation };
  try {
    if (row.beforeHash === null) {
      await rm(row.filePath, { force: true });
      return { ...entry, status: "restored", reason: null };
    }
    const body = await readBlob(dir, row.beforeHash);
    if (body === null) {
      return { ...entry, status: "failed", reason: "blob_missing" };
    }
    await mkdir(dirname(row.filePath), { recursive: true });
    await writeFile(row.filePath, body);
    return { ...entry, status: "restored", reason: null };
  } catch (error) {
    return {
      ...entry,
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
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
    broadcastQueueChanged(runtime, ids.epicId, ids.chatId);
    sendChatSnapshot(socket, runtime, ids.epicId, ids.chatId);
  }
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
