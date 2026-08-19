import * as Y from "yjs";
import { randomUUID } from "node:crypto";
import { createTypedMap } from "@traycer/protocol/utils/yjs-utils/factory";
import {
  agentInboxMessageSchemaV12,
  type AgentInboxAckRequest,
  type AgentInboxMessage,
  type AgentInboxMessageV12,
  type AgentInboxReadRequestV20,
  type AgentInboxReadResponseV20,
} from "@traycer/protocol/host/agent/inbox";
import { tuiAgentSchema } from "@traycer/protocol/persistence/epic/tui-agents";

type InboxSink = (message: AgentInboxMessageV12) => void;

export class AgentInboxServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentInboxServiceError";
    this.code = code;
  }
}

export class AgentInboxService {
  private readonly sinks = new Map<string, Set<InboxSink>>();

  constructor(
    private readonly hostId: string,
    private readonly userId: string,
    private readonly now: () => number,
  ) {}

  enqueue(
    doc: Y.Doc,
    receiverAgentId: string,
    message: Omit<AgentInboxMessageV12, "eventId" | "enqueuedAt">,
  ): AgentInboxMessageV12 {
    const epicId = requireEpicId(doc);
    this.requireLocalClaudeAgent(doc, epicId, receiverAgentId);
    const item = agentInboxMessageSchemaV12.parse({
      ...message,
      epicId,
      eventId: randomUUID(),
      enqueuedAt: this.now(),
    });
    inboxForAgent(doc, receiverAgentId).set(
      item.eventId,
      createTypedMap<AgentInboxMessageV12>(item),
    );
    for (const sink of this.sinks.get(inboxKey(epicId, receiverAgentId)) ??
      []) {
      sink(item);
    }
    return item;
  }

  read(
    doc: Y.Doc,
    request: AgentInboxReadRequestV20,
  ): AgentInboxReadResponseV20 {
    const epicId = requireEpicId(doc);
    this.requireLocalClaudeAgent(doc, request.epicId, request.agentId);
    if (request.epicId !== epicId) {
      throw invalidInboxAgent(request.agentId);
    }
    const rows = inboxRows(doc, request.agentId);
    const start =
      request.after === null
        ? 0
        : rows.findIndex(
            (row) =>
              compareCursor(
                row,
                request.after?.createdAt ?? 0,
                request.after?.eventId ?? "",
              ) > 0,
          );
    if (start < 0 || start >= rows.length) {
      return { messages: [], nextCursor: null };
    }
    const row = rows[start];
    if (row === undefined) return { messages: [], nextCursor: null };
    return {
      messages: [withoutEventId(row)],
      nextCursor:
        start + 1 < rows.length
          ? { createdAt: row.enqueuedAt, eventId: row.eventId }
          : null,
    };
  }

  ack(doc: Y.Doc, request: AgentInboxAckRequest): void {
    const epicId = requireEpicId(doc);
    this.requireLocalClaudeAgent(doc, request.epicId, request.agentId);
    if (request.epicId !== epicId) {
      throw invalidInboxAgent(request.agentId);
    }
    const inbox = inboxForAgent(doc, request.agentId);
    doc.transact(() => {
      for (const eventId of request.eventIds) inbox.delete(eventId);
    });
  }

  subscribe(
    doc: Y.Doc,
    epicId: string,
    agentId: string,
    sink: InboxSink,
  ): () => void {
    this.requireLocalClaudeAgent(doc, epicId, agentId);
    const key = inboxKey(epicId, agentId);
    const subscribers = this.sinks.get(key) ?? new Set<InboxSink>();
    subscribers.add(sink);
    this.sinks.set(key, subscribers);
    for (const row of inboxRows(doc, agentId)) sink(row);
    return () => {
      subscribers.delete(sink);
      if (subscribers.size === 0) this.sinks.delete(key);
    };
  }

  remove(doc: Y.Doc, epicId: string, agentId: string): void {
    const root = ensureInboxRoot(doc);
    root.delete(agentId);
    this.sinks.delete(inboxKey(epicId, agentId));
  }

  private requireLocalClaudeAgent(
    doc: Y.Doc,
    epicId: string,
    agentId: string,
  ): void {
    if (requireEpicId(doc) !== epicId) throw invalidInboxAgent(agentId);
    const root = doc.getMap<unknown>("epic");
    const agents = root.get("tuiAgents");
    const value = agents instanceof Y.Map ? agents.get(agentId) : undefined;
    const parsed = tuiAgentSchema.safeParse(
      value instanceof Y.Map ? value.toJSON() : value,
    );
    if (
      !parsed.success ||
      parsed.data.id !== agentId ||
      parsed.data.hostId !== this.hostId ||
      parsed.data.userId !== this.userId
    ) {
      throw invalidInboxAgent(agentId);
    }
    if (parsed.data.harnessId !== "claude") {
      throw new AgentInboxServiceError(
        "E_HOST_UNSUPPORTED",
        `agent inbox is unavailable for terminal harness '${parsed.data.harnessId}'.`,
      );
    }
  }
}

function ensureInboxRoot(doc: Y.Doc): Y.Map<unknown> {
  const root = doc.getMap<unknown>("epic");
  const existing = root.get("agentInbox");
  if (existing instanceof Y.Map) return existing;
  const inbox = new Y.Map<unknown>();
  root.set("agentInbox", inbox);
  return inbox;
}

function inboxForAgent(doc: Y.Doc, agentId: string): Y.Map<unknown> {
  const root = ensureInboxRoot(doc);
  const existing = root.get(agentId);
  if (existing instanceof Y.Map) return existing;
  const inbox = new Y.Map<unknown>();
  root.set(agentId, inbox);
  return inbox;
}

function inboxRows(doc: Y.Doc, agentId: string): AgentInboxMessageV12[] {
  const rows: AgentInboxMessageV12[] = [];
  for (const value of inboxForAgent(doc, agentId).values()) {
    const parsed = agentInboxMessageSchemaV12.safeParse(
      value instanceof Y.Map ? value.toJSON() : value,
    );
    if (parsed.success) rows.push(parsed.data);
  }
  rows.sort((left, right) =>
    left.enqueuedAt === right.enqueuedAt
      ? left.eventId.localeCompare(right.eventId)
      : left.enqueuedAt - right.enqueuedAt,
  );
  return rows;
}

function compareCursor(
  row: AgentInboxMessageV12,
  createdAt: number,
  eventId: string,
): number {
  return row.enqueuedAt === createdAt
    ? row.eventId.localeCompare(eventId)
    : row.enqueuedAt - createdAt;
}

function withoutEventId(row: AgentInboxMessageV12): AgentInboxMessage {
  const { eventId: _eventId, ...message } = row;
  return message;
}

function requireEpicId(doc: Y.Doc): string {
  const epicId = doc.getMap<unknown>("epic").get("id");
  if (typeof epicId !== "string") {
    throw new AgentInboxServiceError("E_INVALID_ARGUMENT", "Invalid epic");
  }
  return epicId;
}

function invalidInboxAgent(agentId: string): AgentInboxServiceError {
  return new AgentInboxServiceError(
    "E_INVALID_ARGUMENT",
    `agent inbox: terminal agent '${agentId}' was not found on this host.`,
  );
}

function inboxKey(epicId: string, agentId: string): string {
  return `${epicId}:${agentId}`;
}
