import type { WebSocket } from "ws";
import type { EpicCommunicationGraphEvent } from "@traycer/protocol/host/epic/communication-graph";
import type { HostRuntime } from "../runtime";
import type { StoredChat, StoredTurn } from "../store/host-store";

/**
 * The epic's agent-to-agent timeline, projected from the turns this host
 * already persists.
 *
 * A turn whose `fromAgentId` is not the chat it landed in came from ANOTHER
 * agent - that is the whole capture rule, and it is why no separate log is
 * kept: the transcript already records every A2A delivery, sender and thread
 * id included, so a second table could only drift from it.
 *
 * `id` is an ordering cursor, not an identity: rows are numbered by their
 * position in one deterministic sort, so the same history numbers the same way
 * on every subscription. It is only comparable within this host, which is what
 * the contract says a cursor is.
 */
export function graphEvents(
  runtime: HostRuntime,
  epicId: string,
): readonly EpicCommunicationGraphEvent[] {
  const rows: { readonly chat: StoredChat; readonly turn: StoredTurn }[] = [];
  for (const chat of runtime.store.snapshot().chats) {
    if (chat.epicId !== epicId) {
      continue;
    }
    for (const turn of chat.turns) {
      if (turn.fromAgentId !== chat.chatId && turn.fromAgentId.length > 0) {
        rows.push({ chat, turn });
      }
    }
  }
  return rows
    .toSorted(
      (left, right) =>
        left.turn.timestamp - right.turn.timestamp ||
        left.turn.messageId.localeCompare(right.turn.messageId),
    )
    .map((row, index) => ({
      id: index + 1,
      kind: "a2a_message" as const,
      timestamp: row.turn.timestamp,
      senderAgentId: row.turn.fromAgentId,
      receiverAgentId: row.chat.chatId,
      responseId: row.turn.responseId,
      // A reply carries the thread it answers; a fresh request opens one.
      inReplyTo: row.turn.role === "assistant" ? row.turn.responseId : null,
      expectReply: row.turn.expectReply,
      messageText: row.turn.prompt,
      noticeReason: null,
      originKind: "gui_message" as const,
      originChatId: row.chat.chatId,
      originRefId: row.turn.messageId,
    }));
}

/**
 * One subscriber. The snapshot is the batch above the caller's cursor and the
 * `headId` is the log's highest row AT OPEN - the arrival boundary, which is
 * deliberately not the snapshot's own last row: anything at or below it is
 * history the client is only now learning, however it was framed.
 */
export class CommunicationGraphSubscriber {
  constructor(
    private readonly socket: WebSocket,
    private readonly runtime: HostRuntime,
    private readonly epicId: string,
    private readonly sinceCursor: number,
  ) {}

  seed(): void {
    const events = graphEvents(this.runtime, this.epicId);
    const above = events.filter((event) => event.id > this.sinceCursor);
    this.send({
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId: this.epicId,
      events: above,
      headId: events.length === 0 ? null : events[events.length - 1].id,
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

export class CommunicationGraphHub {
  private readonly subscribers = new Map<
    WebSocket,
    CommunicationGraphSubscriber
  >();

  add(socket: WebSocket, subscriber: CommunicationGraphSubscriber): void {
    this.subscribers.set(socket, subscriber);
  }

  remove(socket: WebSocket): void {
    this.subscribers.delete(socket);
  }

  handleFrame(socket: WebSocket, frame: unknown): boolean {
    const subscriber = this.subscribers.get(socket);
    if (
      subscriber === undefined ||
      frame === null ||
      typeof frame !== "object" ||
      Reflect.get(frame, "kind") !== "ping"
    ) {
      return false;
    }
    subscriber.pong();
    return true;
  }
}
