import { describe, expect, it } from "vitest";
import { messageSchema } from "@traycer/protocol/persistence/epic/schemas";
import { renderAgentTranscript } from "../agent-transcript";

describe("agent transcript rendering", () => {
  it("preserves A2A provenance and merges consecutive assistant rows", () => {
    const messages = [
      messageSchema.parse({
        role: "user",
        messageId: "agent-message",
        sender: {
          type: "agent",
          harnessId: "codex",
          agentId: "peer-agent",
          displayName: "Peer",
          reply: { expectsReply: true, responseId: "response-1" },
          inReplyTo: null,
        },
        message: {
          kind: "agent",
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Please inspect this." }],
              },
            ],
          },
          fromAgentId: "peer-agent",
          senderTitle: "Peer",
          senderHarnessId: "codex",
          reply: { expectsReply: true, responseId: "response-1" },
        },
        timestamp: 1,
        sessionAnchor: null,
      }),
      assistantMessage("assistant-1", [
        textBlock("text-1", "  First answer.  "),
      ]),
      assistantMessage("assistant-2", [
        {
          type: "todo",
          blockId: "todo-1",
          status: "completed",
          timestamp: 3,
          items: [
            {
              id: "todo-item",
              text: "Ship transcript",
              status: "in_progress",
              priority: "high",
              activeForm: "Shipping transcript",
            },
          ],
        },
      ]),
    ];

    expect(renderAgentTranscript(messages)).toBe(
      [
        "<user_message>",
        "Agent message from Peer (agent peer-agent) [codex]",
        'Reply expected with responseId="response-1".',
        "Please inspect this.",
        "</user_message>",
        "",
        "<assistant_response>",
        "First answer.",
        "",
        "Todos:",
        '- [in_progress] Ship transcript priority=high active="Shipping transcript"',
        "</assistant_response>",
      ].join("\n"),
    );
  });
});

function assistantMessage(messageId: string, blocks: unknown[]) {
  return messageSchema.parse({
    role: "assistant",
    messageId,
    sender: {
      type: "agent",
      harnessId: "codex",
      agentId: "gpt-5.4",
      displayName: "gpt-5.4",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks,
    startedAt: 1,
    timestamp: 2,
    turnId: "turn-1",
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    imageResolutions: [],
  });
}

function textBlock(blockId: string, text: string): unknown {
  return {
    type: "text",
    blockId,
    status: "completed",
    timestamp: 2,
    text,
    providerNotice: null,
  };
}
