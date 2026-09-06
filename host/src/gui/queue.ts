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
  readonly delivery: "next_turn";
  readonly status: "pending" | "paused";
  readonly targetTurnId: null;
  readonly steerRequest: null;
  readonly fallbackReason: null;
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

  enqueue(chatId: string, input: Omit<QueuedPrompt, "queueItemId" | "createdAt" | "updatedAt">): QueuedPrompt {
    const now = Date.now();
    const row: QueuedPrompt = {
      ...input,
      queueItemId: randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    const current = this.items.get(chatId);
    if (current === undefined) {
      this.items.set(chatId, [row]);
    } else {
      current.push(row);
    }
    return row;
  }

  peek(chatId: string): QueuedPrompt | null {
    if (this.paused.has(chatId)) {
      return null;
    }
    const current = this.items.get(chatId);
    if (current === undefined || current.length === 0) {
      return null;
    }
    return current[0] ?? null;
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

  edit(chatId: string, queueItemId: string, content: unknown, prompt: string): boolean {
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
    const before = current.findIndex((row) => row.queueItemId === beforeQueueItemId);
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
    delivery: "next_turn",
    status: paused ? "paused" : "pending",
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
