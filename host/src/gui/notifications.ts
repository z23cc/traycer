import type { WebSocket } from "ws";
import type {
  HostNotificationEntry,
  HostNotificationsConfigResponse,
  HostNotificationsIndicatorState,
  HostNotificationsSummary,
} from "@traycer/protocol/host/notifications/host-notifications";
import type { HostRuntime } from "../runtime";
import {
  NOTIFICATION_LIMIT,
  type StoredNotification,
} from "../store/host-store";

/** Feed subscribers. One room: the local host serves a single account. */
export class NotificationHub {
  private readonly sockets = new Set<WebSocket>();

  add(socket: WebSocket): void {
    this.sockets.add(socket);
  }

  remove(socket: WebSocket): void {
    this.sockets.delete(socket);
  }

  broadcast(frame: unknown): void {
    const encoded = JSON.stringify(frame);
    for (const socket of this.sockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(encoded);
      }
    }
  }
}

export type NotifyInput = {
  readonly id: string;
  readonly kind: StoredNotification["kind"];
  readonly epicId: string | null;
  readonly chatId: string | null;
  readonly severity: StoredNotification["severity"];
  readonly outcome: StoredNotification["outcome"];
  readonly sourceRef: string | null;
  readonly message: string;
};

/**
 * Upserts one row by id and pushes it to every feed subscriber. Ids are
 * per-occurrence for terminal kinds and stable per chat for the prompt kinds,
 * matching how `resolve` guards on `(id, updatedAt, sourceRef)`.
 */
export async function notify(
  runtime: HostRuntime,
  input: NotifyInput,
): Promise<void> {
  const now = Date.now();
  const row: StoredNotification = {
    id: input.id,
    kind: input.kind,
    epicId: input.epicId,
    chatId: input.chatId,
    severity: input.severity,
    outcome: input.outcome,
    sourceRef: input.sourceRef,
    message: input.message,
    updatedAt: now,
    readAt: null,
    resolvedAt: null,
  };
  await runtime.store.mutate((state) => {
    state.notifications = [
      ...state.notifications.filter((existing) => existing.id !== row.id),
      row,
    ].slice(-NOTIFICATION_LIMIT);
  });
  runtime.notifications.broadcast({
    kind: "upserted",
    hasBinaryPayload: false,
    entry: entryOf(row),
    removedIds: [],
    summary: summaryOf(runtime),
  });
}

export function notificationRows(
  runtime: HostRuntime,
): readonly StoredNotification[] {
  return [...runtime.store.snapshot().notifications].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
}

/** Blocking prompts first, then unread failures - the Attention tier. */
export function attentionRows(
  runtime: HostRuntime,
): readonly StoredNotification[] {
  const rows = notificationRows(runtime);
  return [
    ...rows.filter((row) => isBlocking(row)),
    ...rows.filter((row) => row.severity === "failure" && row.readAt === null),
  ];
}

export function summaryOf(runtime: HostRuntime): HostNotificationsSummary {
  const rows = notificationRows(runtime);
  return {
    unreadCount: rows.filter((row) => row.readAt === null).length,
    attentionCount: attentionRows(runtime).length,
  };
}

export function entryOf(row: StoredNotification): HostNotificationEntry {
  const base = {
    id: row.id,
    updatedAt: row.updatedAt,
    readAt: row.readAt,
    sourceRef: row.sourceRef,
    severity: row.severity,
    epicId: row.epicId,
    chatId: row.chatId,
  };
  if (row.kind === "approval.requested" || row.kind === "interview.requested") {
    return {
      ...base,
      kind: row.kind,
      outcome: null,
      resolvedAt: row.resolvedAt,
      payload: { message: row.message },
    };
  }
  if (row.kind === "agent.stopped") {
    return {
      ...base,
      kind: row.kind,
      outcome: row.outcome ?? "completed",
      payload: {
        outcome: row.outcome ?? "completed",
        message: row.message,
      },
    };
  }
  return {
    ...base,
    kind: row.kind,
    outcome: "errored",
    payload: { message: row.message },
  };
}

export function snapshotFrame(runtime: HostRuntime): unknown {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    attention: {
      entries: attentionRows(runtime).map(entryOf),
      nextCursor: null,
    },
    recent: {
      entries: notificationRows(runtime).map(entryOf),
      nextCursor: null,
    },
    summary: summaryOf(runtime),
  };
}

export function indicatorStateFor(
  rows: readonly StoredNotification[],
  match: (row: StoredNotification) => boolean,
): HostNotificationsIndicatorState {
  const scoped = rows.filter(match);
  return {
    pendingApproval: scoped.some(
      (row) => row.kind === "approval.requested" && row.resolvedAt === null,
    ),
    pendingInterview: scoped.some(
      (row) => row.kind === "interview.requested" && row.resolvedAt === null,
    ),
    unreadFailure: scoped.some(
      (row) => row.severity === "failure" && row.readAt === null,
    ),
    unreadDone: scoped.some(
      (row) => row.severity === "done" && row.readAt === null,
    ),
    // No cloud fork lane on the local plane.
    pendingFork: false,
  };
}

export function broadcastReadState(
  runtime: HostRuntime,
  ids: readonly string[],
  readAt: number | null,
  resolvedAt: number | null,
): void {
  if (ids.length === 0) {
    return;
  }
  const rows = runtime.store.snapshot().notifications;
  const entityRefs: { epicId: string; chatId?: string }[] = [];
  for (const row of rows) {
    if (!ids.includes(row.id) || row.epicId === null) {
      continue;
    }
    entityRefs.push(
      row.chatId === null
        ? { epicId: row.epicId }
        : { epicId: row.epicId, chatId: row.chatId },
    );
  }
  runtime.notifications.broadcast({
    kind: "readStateChanged",
    hasBinaryPayload: false,
    ids: [...ids],
    entityRefs,
    readAt,
    resolvedAt,
    removedIds: [],
    summary: summaryOf(runtime),
  });
}

export const DEFAULT_NOTIFICATIONS_CONFIG: HostNotificationsConfigResponse = {
  matrix: {
    info: { renderer: false, email: false },
    needs_action: { renderer: true, email: false },
    failure: { renderer: true, email: false },
    done: { renderer: true, email: false },
  },
  channels: {
    renderer: { lastError: null },
    // No SMTP client on the local plane; the shape is stored so the settings
    // panel round-trips what the user typed.
    email: {
      host: null,
      port: null,
      user: null,
      from: null,
      credentialConfigured: false,
      lastError: null,
    },
  },
};

function isBlocking(row: StoredNotification): boolean {
  return (
    (row.kind === "approval.requested" || row.kind === "interview.requested") &&
    row.resolvedAt === null
  );
}
