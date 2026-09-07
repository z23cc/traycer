import { randomUUID } from "node:crypto";

export type QueuedPrompt = {
  readonly queueItemId: string;
  readonly messageId: string;
  readonly prompt: string;
  readonly content: unknown;
  readonly userId: string;
  readonly settings: unknown;
  readonly accountContext: unknown;
  readonly harnessId: string;
  readonly model: string | null;
  readonly createdAt: number;
  updatedAt: number;
  /**
   * `steering` while the item is being handed to the running turn; `fallback`
   * once a steer failed and the item waits for the next turn instead, with
   * `fallbackReason` saying why.
   */
  status: "pending" | "steering" | "fallback";
  fallbackReason: string | null;
  /** The turn a steering item targets; null otherwise. */
  targetTurnId: string | null;
};

export type ChatQueueSnapshot = {
  readonly status: "idle" | "running" | "paused";
  readonly items: readonly QueueWireItem[];
};

type QueueWireItem = {
  readonly kind: "prompt";
  readonly queueItemId: string;
  readonly messageId: string;
  readonly message: {
    readonly kind: "user";
    readonly content: unknown;
    readonly browserAnnotations: readonly [];
  };
  readonly sender: { readonly type: "user"; readonly userId: string };
  readonly settings: unknown;
  readonly accountContext: unknown;
  readonly delivery: "same_turn" | "next_turn";
  readonly status: "pending" | "steering" | "fallback" | "paused";
  readonly targetTurnId: string | null;
  readonly steerRequest: {
    readonly mode: "safe_point";
    readonly targetTurnId: string;
    readonly requestedAt: number;
  } | null;
  readonly fallbackReason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export class ChatQueue {
  private readonly items = new Map<string, QueuedPrompt[]>();
  private readonly paused = new Set<string>();

  snapshot(chatId: string): ChatQueueSnapshot {
    const rows = this.items.get(chatId) ?? [];
    const paused = this.paused.has(chatId);
    return {
      status: paused ? "paused" : rows.length > 0 ? "running" : "idle",
      items: rows.map((row) => toWireItem(row, paused)),
    };
  }

  enqueue(
    chatId: string,
    input: Omit<
      QueuedPrompt,
      | "queueItemId"
      | "createdAt"
      | "updatedAt"
      | "status"
      | "fallbackReason"
      | "targetTurnId"
    >,
  ): QueuedPrompt {
    const now = Date.now();
    const row: QueuedPrompt = {
      ...input,
      queueItemId: randomUUID(),
      createdAt: now,
      updatedAt: now,
      status: "pending",
      fallbackReason: null,
      targetTurnId: null,
    };
    const current = this.items.get(chatId);
    if (current === undefined) {
      this.items.set(chatId, [row]);
    } else {
      current.push(row);
    }
    return row;
  }

  /** The next item to run as a turn of its own - never one mid-steer. */
  peek(chatId: string): QueuedPrompt | null {
    if (this.paused.has(chatId)) {
      return null;
    }
    const current = this.items.get(chatId);
    if (current === undefined || current.length === 0) {
      return null;
    }
    return current.find((row) => row.status !== "steering") ?? null;
  }

  find(chatId: string, queueItemId: string): QueuedPrompt | null {
    return (
      this.items.get(chatId)?.find((row) => row.queueItemId === queueItemId) ??
      null
    );
  }

  /** Whether any item of this chat is being steered right now. */
  isSteering(chatId: string): boolean {
    return (
      this.items.get(chatId)?.some((row) => row.status === "steering") === true
    );
  }

  /** Move an item between the steer states; false when it is gone. */
  setStatus(
    chatId: string,
    queueItemId: string,
    status: "pending" | "steering" | "fallback",
    fallbackReason: string | null,
    targetTurnId: string | null,
  ): boolean {
    const row = this.find(chatId, queueItemId);
    if (row === null) {
      return false;
    }
    row.status = status;
    row.fallbackReason = fallbackReason;
    row.targetTurnId = targetTurnId;
    row.updatedAt = Date.now();
    return true;
  }

  has(chatId: string, queueItemId: string): boolean {
    const current = this.items.get(chatId);
    if (current === undefined) {
      return false;
    }
    return current.some((row) => row.queueItemId === queueItemId);
  }

  shift(chatId: string): QueuedPrompt | null {
    if (this.paused.has(chatId)) {
      return null;
    }
    const current = this.items.get(chatId);
    if (current === undefined || current.length === 0) {
      return null;
    }
    const next = current.shift();
    if (current.length === 0) {
      this.items.delete(chatId);
    }
    return next ?? null;
  }

  cancel(chatId: string, queueItemId: string): boolean {
    const current = this.items.get(chatId);
    if (current === undefined) {
      return false;
    }
    const next = current.filter((row) => row.queueItemId !== queueItemId);
    if (next.length === current.length) {
      return false;
    }
    if (next.length === 0) {
      this.items.delete(chatId);
    } else {
      this.items.set(chatId, next);
    }
    return true;
  }

  edit(
    chatId: string,
    queueItemId: string,
    content: unknown,
    prompt: string,
  ): boolean {
    const current = this.items.get(chatId);
    if (current === undefined) {
      return false;
    }
    const index = current.findIndex((row) => row.queueItemId === queueItemId);
    if (index < 0) {
      return false;
    }
    const existing = current[index];
    if (existing === undefined) {
      return false;
    }
    current[index] = {
      ...existing,
      content,
      prompt,
      updatedAt: Date.now(),
    };
    return true;
  }

  reorder(
    chatId: string,
    queueItemId: string,
    beforeQueueItemId: string | null,
  ): boolean {
    const current = this.items.get(chatId);
    if (current === undefined) {
      return false;
    }
    const from = current.findIndex((row) => row.queueItemId === queueItemId);
    if (from < 0) {
      return false;
    }
    const [moved] = current.splice(from, 1);
    if (moved === undefined) {
      return false;
    }
    if (beforeQueueItemId === null) {
      current.push(moved);
      return true;
    }
    const before = current.findIndex(
      (row) => row.queueItemId === beforeQueueItemId,
    );
    if (before < 0) {
      current.push(moved);
      return true;
    }
    current.splice(before, 0, moved);
    return true;
  }

  pause(chatId: string): boolean {
    if (this.paused.has(chatId)) {
      return false;
    }
    this.paused.add(chatId);
    return true;
  }

  resume(chatId: string): boolean {
    if (!this.paused.has(chatId)) {
      return false;
    }
    this.paused.delete(chatId);
    return true;
  }

  isPaused(chatId: string): boolean {
    return this.paused.has(chatId);
  }

  pendingCount(chatId: string): number {
    return this.items.get(chatId)?.length ?? 0;
  }

  clear(chatId: string): void {
    this.items.delete(chatId);
    this.paused.delete(chatId);
  }
}

function toWireItem(row: QueuedPrompt, paused: boolean): QueueWireItem {
  return {
    kind: "prompt",
    queueItemId: row.queueItemId,
    messageId: row.messageId,
    message: {
      kind: "user",
      content: row.content,
      browserAnnotations: [],
    },
    sender: { type: "user", userId: row.userId },
    settings: row.settings,
    accountContext: row.accountContext,
    delivery: row.status === "steering" ? "same_turn" : "next_turn",
    status: paused ? "paused" : row.status,
    targetTurnId: row.targetTurnId,
    steerRequest:
      row.status === "steering" && row.targetTurnId !== null
        ? {
            mode: "safe_point",
            targetTurnId: row.targetTurnId,
            requestedAt: row.updatedAt,
          }
        : null,
    fallbackReason: row.fallbackReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
