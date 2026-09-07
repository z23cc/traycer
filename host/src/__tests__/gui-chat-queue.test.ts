import { describe, expect, it } from "vitest";
import {
  persistAssistantPrompt,
  printPromptFromTurns,
} from "../agent/gui-chat";
import { ChatQueue } from "../gui/queue";
import type { StoredTurn } from "../store/host-store";

describe("persistAssistantPrompt", () => {
  it("keeps live assembled text so the snapshot matches the stream", () => {
    expect(persistAssistantPrompt("hello\n", "hello")).toBe("hello\n");
  });

  it("falls back to the print result when no deltas arrived", () => {
    expect(persistAssistantPrompt("", "Stopped.")).toBe("Stopped.");
  });
});

describe("printPromptFromTurns", () => {
  it("returns the current prompt when there is no prior history", () => {
    expect(printPromptFromTurns([user("u1", "hello")], "hello")).toBe("hello");
  });

  it("prefixes earlier turns and skips the current user message", () => {
    const prompt = printPromptFromTurns(
      [user("u1", "first"), assistant("a1", "ok"), user("u2", "second")],
      "second",
    );
    expect(prompt).toContain("Conversation so far:");
    expect(prompt).toContain("User: first");
    expect(prompt).toContain("Assistant: ok");
    expect(prompt).toContain("User: second");
    expect(prompt.endsWith("User: second")).toBe(true);
  });

  it("drops empty assistant placeholders", () => {
    const prompt = printPromptFromTurns(
      [user("u1", "hi"), assistant("a1", "   "), user("u2", "again")],
      "again",
    );
    expect(prompt).not.toContain("Assistant:");
    expect(prompt).toContain("User: hi");
  });
});

describe("ChatQueue", () => {
  it("enqueues, peeks, reorders, and cancels", () => {
    const queue = new ChatQueue();
    const first = queue.enqueue("chat", prompt("m1", "one"));
    const second = queue.enqueue("chat", prompt("m2", "two"));
    expect(queue.snapshot("chat").status).toBe("running");
    expect(queue.peek("chat")?.queueItemId).toBe(first.queueItemId);
    expect(queue.reorder("chat", second.queueItemId, first.queueItemId)).toBe(
      true,
    );
    expect(queue.peek("chat")?.messageId).toBe("m2");
    expect(queue.cancel("chat", second.queueItemId)).toBe(true);
    expect(queue.peek("chat")?.messageId).toBe("m1");
    expect(queue.shift("chat")?.messageId).toBe("m1");
    expect(queue.snapshot("chat")).toEqual({ status: "idle", items: [] });
  });

  it("pauses drain until resumed", () => {
    const queue = new ChatQueue();
    queue.enqueue("chat", prompt("m1", "one"));
    expect(queue.pause("chat")).toBe(true);
    expect(queue.peek("chat")).toBeNull();
    expect(queue.snapshot("chat").status).toBe("paused");
    expect(queue.snapshot("chat").items[0]?.status).toBe("paused");
    expect(queue.resume("chat")).toBe(true);
    expect(queue.peek("chat")?.messageId).toBe("m1");
  });
});

function user(messageId: string, prompt: string): StoredTurn {
  return {
    messageId,
    timestamp: 1,
    role: "user",
    prompt,
    fromAgentId: "chat",
    fromTitle: "user",
    fromHarnessId: "codex",
    expectReply: true,
    responseId: null,
    userId: "local",
    content: null,
    turnId: null,
    blocks: null,
  };
}

function assistant(messageId: string, prompt: string): StoredTurn {
  return {
    messageId,
    timestamp: 2,
    role: "assistant",
    prompt,
    fromAgentId: "chat",
    fromTitle: "chat",
    fromHarnessId: "codex",
    expectReply: false,
    responseId: null,
    userId: null,
    content: null,
    turnId: "turn:a1",
    blocks: null,
  };
}

function prompt(messageId: string, text: string) {
  return {
    messageId,
    prompt: text,
    content: { type: "doc", content: [] },
    userId: "local",
    settings: { harnessId: "claude", model: "default" },
    accountContext: { type: "PERSONAL" },
    harnessId: "claude",
    model: "default",
  };
}
