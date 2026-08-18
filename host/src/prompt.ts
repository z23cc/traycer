import { jsonContentToMarkdown } from "@traycer/protocol/common/json-content-serializer";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { formatAgentMessage } from "@traycer/protocol/agent/a2a-message-format";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";

export function promptFromJsonContent(content: JsonContent): string {
  return jsonContentToMarkdown(content, {
    mentionFormat: "llm",
    platform: process.platform === "win32" ? "WINDOWS" : "POSIX",
  });
}

export function conversationPrompt(messages: Message[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text = userPrompt(message);
      if (text !== null) {
        parts.push(message.message.kind === "agent" ? text : `User:\n${text}`);
      }
      continue;
    }
    const text = assistantText(message.blocks).trim();
    if (text.length > 0) {
      parts.push(`Assistant:\n${text}`);
    }
  }
  return parts.join("\n\n");
}

export function latestUserPrompt(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.role !== "user") {
      continue;
    }
    const text = userPrompt(message);
    if (text !== null) {
      return text;
    }
  }
  return "";
}

function userPrompt(
  message: Extract<Message, { readonly role: "user" }>,
): string | null {
  if (message.message.kind === "agent") {
    return formatAgentMessage({
      receiverChannel: "gui",
      sender: {
        agentId: message.message.fromAgentId,
        title: message.message.senderTitle,
        harnessId: message.message.senderHarnessId,
      },
      reply: message.message.reply,
      body: promptFromJsonContent(message.message.content),
    });
  }
  const text = promptFromJsonContent(message.message.content).trim();
  return text.length > 0 ? text : null;
}

function assistantText(
  blocks: ReadonlyArray<{ readonly type: string; readonly text?: string }>,
): string {
  const chunks: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      chunks.push(block.text);
    }
  }
  return chunks.join("\n");
}
