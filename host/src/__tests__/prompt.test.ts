import { describe, expect, it } from "vitest";
import { formatAgentMessage } from "@traycer/protocol/agent/a2a-message-format";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import { conversationPrompt, latestUserPrompt } from "../prompt";

describe("agent-authored prompts", () => {
  it("normalizes the peer body before formatting the provider envelope", () => {
    const body = "  keep *literal* edges  ";
    const normalizedBody = "keep *literal* edges";
    const message: Message = {
      role: "user",
      messageId: "agent-msg-whitespace",
      sender: {
        type: "agent",
        harnessId: "codex",
        agentId: "sender-agent",
        displayName: "Sender",
        reply: { expectsReply: false },
        inReplyTo: null,
      },
      message: {
        kind: "agent",
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: body }],
            },
          ],
        },
        fromAgentId: "sender-agent",
        senderTitle: "Sender",
        senderHarnessId: "codex",
        reply: { expectsReply: false },
      },
      timestamp: 1,
      sessionAnchor: null,
    };
    const expected = formatAgentMessage({
      receiverChannel: "gui",
      sender: {
        agentId: "sender-agent",
        title: "Sender",
        harnessId: "codex",
      },
      reply: { expectsReply: false },
      body: normalizedBody,
    });

    expect(conversationPrompt([message])).toBe(expected);
    expect(latestUserPrompt([message])).toBe(expected);
  });
});
