import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatAgentMessageSenderLabel } from "@traycer/protocol/agent/a2a-message-format";
import type { ContentBlock } from "@traycer/protocol/persistence/epic/content-blocks";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import { promptFromJsonContent } from "./prompt";

type TranscriptGroup = {
  readonly role: Message["role"];
  readonly texts: readonly string[];
};

export async function writeAgentTranscript(
  agentId: string,
  messages: readonly Message[],
): Promise<string> {
  const directory = join(
    tmpdir(),
    "traycer-chat-refs",
    safePathSegment(agentId),
    "agent-transcript-read",
  );
  const path = join(directory, "transcript.txt");
  await mkdir(directory, { recursive: true });
  await writeFile(path, renderAgentTranscript(messages), "utf8");
  return `The agent's transcript has been written to a file at ${path}.`;
}

export function renderAgentTranscript(messages: readonly Message[]): string {
  const groups: TranscriptGroup[] = [];
  for (const message of messages) {
    const text = renderMessage(message).trim();
    if (text.length === 0) {
      continue;
    }
    const previous = groups.at(-1);
    if (previous === undefined || previous.role !== message.role) {
      groups.push({ role: message.role, texts: [text] });
      continue;
    }
    if (message.role === "user") {
      groups.push({ role: "user", texts: [text] });
      continue;
    }
    groups[groups.length - 1] = {
      role: "assistant",
      texts: [...previous.texts, text],
    };
  }
  return groups
    .map((group) => {
      const tag = group.role === "user" ? "user_message" : "assistant_response";
      return `<${tag}>\n${group.texts.join("\n\n")}\n</${tag}>`;
    })
    .join("\n\n");
}

function renderMessage(message: Message): string {
  if (message.role === "assistant") {
    return message.blocks
      .flatMap((block) => {
        const text = renderAssistantBlock(block);
        return text.length === 0 ? [] : [text];
      })
      .join("\n\n")
      .trim();
  }
  const body = promptFromJsonContent(message.message.content).trim();
  if (message.message.kind === "user") {
    return body;
  }
  const sender = formatAgentMessageSenderLabel({
    agentId: message.message.fromAgentId,
    title: message.message.senderTitle,
    harnessId: message.message.senderHarnessId,
  });
  const reply = message.message.reply.expectsReply
    ? `Reply expected with responseId="${message.message.reply.responseId}".`
    : "No reply required.";
  return [`Agent message from ${sender}`, reply, body]
    .filter((part) => part.length > 0)
    .join("\n");
}

function renderAssistantBlock(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text.trim();
    case "subagent":
      return nonEmpty([
        "Subagent:",
        block.name === null ? "" : `Name: ${block.name}`,
        block.task === null ? "" : `Task: ${block.task}`,
        bulletSection("Progress:", block.progressUpdates),
        block.result === null ? "" : `Result:\n${block.result.trim()}`,
      ]).join("\n");
    case "interview":
      return nonEmpty([
        "Questions:",
        block.title === null ? "" : `Title: ${block.title}`,
        block.description ?? "",
        block.questions
          .map((question, index) =>
            nonEmpty([
              `${String(index + 1)}. ${question.question}`,
              question.header === null ? "" : `   ${question.header}`,
              question.options.length === 0
                ? ""
                : [
                    "   Options:",
                    ...question.options.map((option) =>
                      nonEmpty([
                        `   - ${option.label}`,
                        option.description === null
                          ? ""
                          : `     ${option.description}`,
                        option.preview === null
                          ? ""
                          : `     Preview: ${option.preview}`,
                      ]).join("\n"),
                    ),
                  ].join("\n"),
              question.multiSelect ? "   Multi-select: true" : "",
            ]).join("\n"),
          )
          .join("\n"),
        block.answers.length === 0
          ? ""
          : [
              "Answers:",
              ...block.answers.map((answer) =>
                nonEmpty([
                  `- ${answer.question ?? answer.questionId ?? "Question"}`,
                  answer.values.length === 0
                    ? ""
                    : `  Answer: ${answer.values.join(", ")}`,
                  answer.notes === null ? "" : `  Notes: ${answer.notes}`,
                ]).join("\n"),
              ),
            ].join("\n"),
      ]).join("\n");
    case "todo":
      return block.items.length === 0
        ? ""
        : [
            "Todos:",
            ...block.items.map((item) => {
              const priority =
                item.priority === null ? "" : ` priority=${item.priority}`;
              const active =
                item.activeForm === null ? "" : ` active="${item.activeForm}"`;
              return `- [${item.status}] ${item.text}${priority}${active}`;
            }),
          ].join("\n");
    default:
      return "";
  }
}

function bulletSection(title: string, values: readonly string[]): string {
  const lines = values.map((value) => value.trim()).filter(isNonEmpty);
  return lines.length === 0
    ? ""
    : [title, ...lines.map((line) => `- ${line}`)].join("\n");
}

function nonEmpty(values: readonly string[]): string[] {
  return values.filter((value) => value.trim().length > 0);
}

function isNonEmpty(value: string): boolean {
  return value.length > 0;
}

function safePathSegment(value: string): string {
  const safe = value
    .trim()
    .replaceAll(/[^A-Za-z0-9._-]+/g, "_")
    .replaceAll(/^_+|_+$/g, "");
  return safe.length === 0 || /^\.+$/.test(safe) ? "chat" : safe.slice(0, 120);
}
