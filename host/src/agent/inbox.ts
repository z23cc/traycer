import { randomUUID } from "node:crypto";

export type InboxEnvelope = {
  readonly eventId: string;
  readonly epicId: string;
  readonly toAgentId: string;
  readonly fromAgentId: string;
  readonly senderTitle: string | null;
  readonly senderHarnessId: string | null;
  readonly prompt: string;
  readonly enqueuedAt: number;
  readonly expectsReply: boolean;
  readonly responseId: string | null;
};

export type InboxReadPage = {
  readonly messages: readonly InboxWireMessage[];
  readonly nextCursor: { readonly createdAt: number; readonly eventId: string } | null;
};

export type InboxWireMessage = {
  readonly reply:
    | { readonly expectsReply: true; readonly responseId: string }
    | { readonly expectsReply: false };
  readonly fromAgentId: string;
  readonly senderTitle: string | null;
  readonly senderHarnessId: string | null;
  readonly epicId: string;
  readonly prompt: string;
  readonly enqueuedAt: number;
  readonly eventId: string;
};

export class AgentInbox {
  private readonly byAgent = new Map<string, InboxEnvelope[]>();

  enqueue(input: {
    readonly epicId: string;
    readonly toAgentId: string;
    readonly fromAgentId: string;
    readonly senderTitle: string | null;
    readonly senderHarnessId: string | null;
    readonly prompt: string;
    readonly expectsReply: boolean;
    readonly responseId: string | null;
  }): InboxEnvelope {
    const envelope: InboxEnvelope = {
      eventId: randomUUID(),
      epicId: input.epicId,
      toAgentId: input.toAgentId,
      fromAgentId: input.fromAgentId,
      senderTitle: input.senderTitle,
      senderHarnessId: input.senderHarnessId,
      prompt: input.prompt,
      enqueuedAt: Date.now(),
      expectsReply: input.expectsReply,
      responseId: input.responseId,
    };
    const current = this.byAgent.get(input.toAgentId) ?? [];
    current.push(envelope);
    this.byAgent.set(input.toAgentId, current);
    return envelope;
  }

  read(
    agentId: string,
    after: { readonly createdAt: number; readonly eventId: string } | null,
  ): InboxReadPage {
    const rows = this.byAgent.get(agentId) ?? [];
    const start =
      after === null
        ? 0
        : rows.findIndex(
            (row) =>
              row.enqueuedAt > after.createdAt ||
              (row.enqueuedAt === after.createdAt && row.eventId > after.eventId),
          );
    const sliced = start < 0 ? [] : rows.slice(start);
    const page = sliced.slice(0, 50);
    const last = page[page.length - 1];
    const nextCursor =
      last === undefined || page.length === sliced.length
        ? null
        : { createdAt: last.enqueuedAt, eventId: last.eventId };
    return {
      messages: page.map(toWire),
      nextCursor,
    };
  }
}

function toWire(envelope: InboxEnvelope): InboxWireMessage {
  return {
    reply:
      envelope.expectsReply && envelope.responseId !== null
        ? { expectsReply: true, responseId: envelope.responseId }
        : { expectsReply: false },
    fromAgentId: envelope.fromAgentId,
    senderTitle: envelope.senderTitle,
    senderHarnessId: envelope.senderHarnessId,
    epicId: envelope.epicId,
    prompt: envelope.prompt,
    enqueuedAt: envelope.enqueuedAt,
    eventId: envelope.eventId,
  };
}
