import { describe, expect, it } from "vitest";
import {
  assistantReasoningBlockId,
  assistantTextBlockId,
  turnToMessage,
} from "../stream/chat";
import type { StoredTurn } from "../store/host-store";

describe("assistant snapshot blocks", () => {
  it("reuses the live text block id so the GUI does not paint the reply twice", () => {
    const turn: StoredTurn = {
      messageId: "c83c67e5-65b4-4097-81fd-98740cb6cce6",
      timestamp: 1,
      role: "assistant",
      prompt: "你好!有什么我可以帮你的吗?",
      fromAgentId: "chat-1",
      fromTitle: "",
      fromHarnessId: "claude",
      expectReply: false,
      responseId: null,
      userId: null,
      content: null,
      turnId: "turn:b79c69fd-d208-4787-a90e-f49cc33088ea",
      blocks: null,
    };
    const message = turnToMessage(turn);
    expect(message).toMatchObject({
      role: "assistant",
      messageId: turn.messageId,
      turnId: turn.turnId,
      blocks: [
        {
          blockId: assistantTextBlockId(turn.messageId),
          type: "text",
          text: "你好!有什么我可以帮你的吗?",
          status: "completed",
        },
      ],
    });
    expect(assistantTextBlockId(turn.messageId)).toBe(`${turn.messageId}-text`);
    expect(assistantReasoningBlockId(turn.messageId)).toBe(
      `${turn.messageId}-reasoning`,
    );
    expect(assistantTextBlockId(turn.messageId)).not.toBe(
      `${turn.turnId}-text`,
    );
  });

  it("copies the turn timestamp onto snapshot blocks so a completion stamp can outrank live", () => {
    const turn: StoredTurn = {
      messageId: "msg-assistant",
      timestamp: 42,
      role: "assistant",
      prompt: "pong",
      fromAgentId: "chat-1",
      fromTitle: "",
      fromHarnessId: "claude",
      expectReply: false,
      responseId: null,
      userId: null,
      content: null,
      turnId: "turn:1",
      blocks: null,
    };
    expect(turnToMessage(turn)).toMatchObject({
      timestamp: 42,
      blocks: [{ timestamp: 42, text: "pong" }],
    });
  });
});
