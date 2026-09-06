import type { WebSocket } from "ws";
import type { HostRuntime } from "../runtime";
import type { StoredChat } from "../store/host-store";
import { derivedChatTitle } from "../agent/gui-chat";
import { chatOwnerUserId, latestTurnTime } from "./chat";

/**
 * The one chat-record projection. `epic.listChatRecords` and
 * `host.chatRecords.subscribe` are the same table read two ways, and a
 * snapshot that disagreed with the deltas replacing it is the whole failure
 * this shares a function to prevent.
 *
 * `revision` is per-chat monotonic and is the ONLY ordering fact the stream
 * carries: a client applies an `upsert` when its revision strictly exceeds the
 * one it holds. It is derived from the chat's own latest activity, so it moves
 * exactly when the row does.
 */
export function chatRecordSummaryOf(
  runtime: HostRuntime,
  chat: StoredChat,
): {
  readonly chatId: string;
  readonly revision: number;
  readonly [key: string]: unknown;
} {
  const harnessId =
    runtime.store.snapshot().agents.find((agent) => agent.id === chat.chatId)
      ?.harnessId ?? null;
  const updatedAt = latestTurnTime(chat);
  return {
    chatId: chat.chatId,
    ownerUserId: chatOwnerUserId(chat),
    originHostId: chat.hostId,
    title: derivedChatTitle(chat),
    isTitleEditedByUser: chat.title.length > 0,
    parentChatId: chat.parentId,
    createdAt: chat.createdAt,
    updatedAt,
    archived: chat.archivedAt !== null,
    archivedAt: chat.archivedAt,
    runSettingsSummary: harnessId,
    // Archiving changes the row without adding a turn, so the revision has to
    // move for it too - otherwise the delta is dropped as stale.
    revision: Math.max(updatedAt, chat.archivedAt ?? 0),
    visibility: "private" as const,
    origin: "own" as const,
    docResident: false,
  };
}

/**
 * `host.chatRecords.subscribe` - one host-wide subscriber.
 *
 * There is no cursor and no replay: the open request is empty, the host sends
 * the CURRENT table as upserts, and everything after is a live delta. A client
 * that misses frames re-subscribes and re-seeds rather than seeking a log this
 * host does not keep.
 */
export class ChatRecordsSubscriber {
  constructor(
    private readonly socket: WebSocket,
    private readonly runtime: HostRuntime,
  ) {}

  seed(): void {
    for (const chat of this.runtime.store.snapshot().chats) {
      this.upsert(chat);
    }
  }

  upsert(chat: StoredChat): void {
    const record = chatRecordSummaryOf(this.runtime, chat);
    // The envelope repeats the row's own id and revision, and the contract
    // refuses a frame where they disagree - so they are read from the record
    // rather than recomputed beside it.
    this.send({
      kind: "upsert",
      hasBinaryPayload: false,
      epicId: chat.epicId,
      chatId: record.chatId,
      revision: record.revision,
      record,
    });
  }

  remove(epicId: string, chatId: string, reason: "deleted" | "revoked"): void {
    this.send({
      kind: "remove",
      hasBinaryPayload: false,
      epicId,
      chatId,
      reason,
    });
  }

  pong(): void {
    this.send({ kind: "pong", hasBinaryPayload: false });
  }

  private send(frame: unknown): void {
    if (this.socket.readyState !== this.socket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(frame));
  }
}

export class ChatRecordsHub {
  private readonly subscribers = new Map<WebSocket, ChatRecordsSubscriber>();

  add(socket: WebSocket, subscriber: ChatRecordsSubscriber): void {
    this.subscribers.set(socket, subscriber);
  }

  remove(socket: WebSocket): void {
    this.subscribers.delete(socket);
  }

  /** Re-sends one chat's row to every subscriber. */
  publish(runtime: HostRuntime, epicId: string, chatId: string): void {
    const chat = runtime.store
      .snapshot()
      .chats.find((row) => row.chatId === chatId && row.epicId === epicId);
    for (const subscriber of this.subscribers.values()) {
      if (chat === undefined) {
        // Gone from the table with no tombstone to read: `deleted` is the only
        // honest reason on a host where nothing is shared and so nothing can
        // be revoked.
        subscriber.remove(epicId, chatId, "deleted");
        continue;
      }
      subscriber.upsert(chat);
    }
  }

  handleFrame(socket: WebSocket, frame: unknown): boolean {
    const subscriber = this.subscribers.get(socket);
    if (
      subscriber === undefined ||
      frame === null ||
      typeof frame !== "object"
    ) {
      return false;
    }
    if (Reflect.get(frame, "kind") !== "ping") {
      return false;
    }
    subscriber.pong();
    return true;
  }
}
