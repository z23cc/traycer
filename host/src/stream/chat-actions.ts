import type { WebSocket } from "ws";
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
} from "../agent/gui-chat";
import type { HostRuntime } from "../runtime";
import {
  sendChatJson,
  sendChatRange,
  sendChatSnapshot,
  turnToMessage,
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
    ack(socket, ids, "editUserMessage", "rejected", "Chat not found", "CHAT_NOT_FOUND");
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
  if (current !== null && typeof current === "object" && !Array.isArray(current)) {
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
