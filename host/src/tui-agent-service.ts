import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { createTypedMap } from "@traycer/protocol/utils/yjs-utils/factory";
import type {
  GenerateTuiAgentTitleRequest,
  GenerateTuiAgentTitleResponse,
  RecordTuiAgentActivityRequestV11,
  RecordTuiAgentActivityResponse,
  TuiAgentTurnEndedRequest,
  TuiAgentTurnEndedResponse,
} from "@traycer/protocol/host/agent/tui/unary-schemas";
import type {
  CreateTuiAgentRequest,
  CreateTuiAgentResponse,
  DeleteTuiAgentRequest,
  DeleteTuiAgentResponse,
  RenameTuiAgentRequest,
  RenameTuiAgentResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  tuiAgentSchema,
  type TuiAgent,
} from "@traycer/protocol/persistence/epic/tui-agents";

export type TuiAgentServiceOptions = {
  readonly hostId: string;
  readonly userId: string;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly generateTitle?: (promptText: string) => Promise<string>;
  readonly onActivityChanged?: (
    epicId: string,
    tuiAgentId: string,
    active: boolean,
  ) => void;
  readonly onTurnEnded?: (epicId: string, tuiAgentId: string) => void;
};

export class TuiAgentServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TuiAgentServiceError";
    this.code = code;
  }
}

type ResolvedRecord = {
  readonly epicId: string;
  readonly tuiAgentId: string;
  readonly entry: Y.Map<unknown>;
  readonly record: TuiAgent;
};

/**
 * Owns the local lifecycle of persisted terminal-agent records. The Y.Doc is
 * supplied by HostState so this service remains independent of epic storage,
 * transport, terminal sessions, and the inter-agent broker.
 */
export class TuiAgentService {
  private readonly activeAgents = new Set<string>();
  private readonly hostId: string;
  private readonly userId: string;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly titleGenerator:
    ((promptText: string) => Promise<string>) | undefined;
  private readonly onActivityChanged:
    ((epicId: string, tuiAgentId: string, active: boolean) => void) | undefined;
  private readonly onTurnEnded:
    ((epicId: string, tuiAgentId: string) => void) | undefined;

  constructor(options: TuiAgentServiceOptions) {
    this.hostId = options.hostId;
    this.userId = options.userId;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.titleGenerator = options.generateTitle;
    this.onActivityChanged = options.onActivityChanged;
    this.onTurnEnded = options.onTurnEnded;
  }

  create(doc: Y.Doc, request: CreateTuiAgentRequest): CreateTuiAgentResponse {
    const epicId = requireEpicId(doc, request.epicId, "epic.createTuiAgent");
    if (request.hostId !== this.hostId) {
      throw new TuiAgentServiceError(
        "TARGET_NOT_LOCAL",
        `epic.createTuiAgent: host '${request.hostId}' is not local to '${this.hostId}'.`,
      );
    }
    if (request.harnessId === "cursor") {
      throw unsupportedHarness("epic.createTuiAgent", request.harnessId);
    }
    const tuiAgentId = request.tuiAgentId ?? this.createId();
    const root = doc.getMap<unknown>("epic");
    const tuiAgents = ensureTuiAgentsMap(doc);
    const chats = root.get("chats");
    if (
      tuiAgents.has(tuiAgentId) ||
      (chats instanceof Y.Map && chats.has(tuiAgentId))
    ) {
      throw new TuiAgentServiceError(
        "E_INVALID_ARGUMENT",
        `epic.createTuiAgent: agent '${tuiAgentId}' already exists in epic '${epicId}'.`,
      );
    }

    const now = this.now();
    const persisted = tuiAgentSchema.safeParse({
      id: tuiAgentId,
      parentId: request.parentId,
      title: request.title,
      isTitleEditedByUser: request.title.length > 0,
      createdAt: now,
      updatedAt: now,
      hostId: request.hostId,
      userId: this.userId,
      workspaceFolders: request.workspaceFolders,
      ...(request.workspaceMode === undefined
        ? {}
        : { workspaceMode: request.workspaceMode }),
      model: request.model,
      reasoningEffort: request.reasoningEffort,
      agentMode: request.agentMode,
      terminalAgentArgs: request.terminalAgentArgs,
      terminalShellCommand: request.terminalShellCommand,
      terminalShellArgs: request.terminalShellArgs,
      profileId: request.profileId,
      archivedAt: null,
      pendingForkSourceHarnessSessionId: request.forkSourceHarnessSessionId,
      pinnedUserProviderHandle: null,
      lastDeliveredRolesDigest: null,
      harnessId: request.harnessId,
      harnessSessionId: request.harnessSessionId,
    });
    if (!persisted.success) {
      throw new TuiAgentServiceError(
        "E_INVALID_ARGUMENT",
        `epic.createTuiAgent: invalid ${request.harnessId} terminal-agent record: ${persisted.error.message}`,
      );
    }
    tuiAgents.set(tuiAgentId, createTypedMap<TuiAgent>(persisted.data));
    return { tuiAgentId };
  }

  delete(doc: Y.Doc, request: DeleteTuiAgentRequest): DeleteTuiAgentResponse {
    const epicId = requireEpicId(doc, request.epicId, "epic.deleteTuiAgent");
    const entry = findEntry(doc, request.tuiAgentId);
    if (entry === null) {
      return { deleted: false };
    }
    this.requireOwnedRecord(entry, request.tuiAgentId, "epic.deleteTuiAgent");
    this.setActive(epicId, request.tuiAgentId, false);
    ensureTuiAgentsMap(doc).delete(request.tuiAgentId);
    return { deleted: true };
  }

  rename(doc: Y.Doc, request: RenameTuiAgentRequest): RenameTuiAgentResponse {
    requireEpicId(doc, request.epicId, "epic.renameTuiAgent");
    const entry = findEntry(doc, request.tuiAgentId);
    if (entry === null) {
      return { updated: false };
    }
    this.requireOwnedRecord(entry, request.tuiAgentId, "epic.renameTuiAgent");
    entry.set("title", request.title);
    entry.set("isTitleEditedByUser", true);
    entry.set("updatedAt", this.now());
    return { updated: true };
  }

  async generateTitle(
    doc: Y.Doc,
    request: GenerateTuiAgentTitleRequest,
  ): Promise<GenerateTuiAgentTitleResponse> {
    const resolved = this.resolveHookRecord(doc, request);
    if (!this.canGenerateTitle(resolved, request.harnessId)) {
      return { accepted: false };
    }
    const fallback = fallbackTitle(request.promptText);
    let title = fallback;
    if (this.titleGenerator !== undefined) {
      try {
        title = normalizeTitle(await this.titleGenerator(request.promptText));
        if (title.length === 0) {
          title = fallback;
        }
      } catch {
        title = fallback;
      }
    }

    // A manual rename may land while an async generator is running. Resolve
    // and re-check the record so generated text never overwrites user intent.
    const current = this.resolveHookRecord(doc, request);
    if (!this.canGenerateTitle(current, request.harnessId)) {
      return { accepted: false };
    }
    current.entry.set("title", title);
    current.entry.set("updatedAt", this.now());
    return { accepted: true };
  }

  recordActivity(
    doc: Y.Doc,
    request: RecordTuiAgentActivityRequestV11,
  ): RecordTuiAgentActivityResponse {
    const resolved = this.resolveHookRecord(doc, request);
    if (!this.isOwnedHarness(resolved, request.harnessId)) {
      return { accepted: false };
    }
    if (
      request.harnessId === "opencode" &&
      request.harnessSessionId !== null &&
      resolved.record.harnessSessionId !== request.harnessSessionId
    ) {
      return { accepted: false };
    }
    if (
      resolved.record.harnessId === "claude" &&
      request.observedHarnessSessionId !== null &&
      request.observedHarnessSessionId !== resolved.record.harnessSessionId
    ) {
      resolved.entry.set("harnessSessionId", request.observedHarnessSessionId);
      resolved.entry.set("updatedAt", this.now());
    }
    if (request.event !== "resync") {
      this.setActive(
        resolved.epicId,
        resolved.tuiAgentId,
        request.event === "start",
      );
    }
    return { accepted: true };
  }

  turnEnded(
    doc: Y.Doc,
    request: TuiAgentTurnEndedRequest,
  ): TuiAgentTurnEndedResponse {
    const resolved = this.resolveHookRecord(doc, request);
    if (!this.isOwnedHarness(resolved, request.harnessId)) {
      return { accepted: false };
    }
    this.setActive(resolved.epicId, resolved.tuiAgentId, false);
    this.onTurnEnded?.(resolved.epicId, resolved.tuiAgentId);
    return { accepted: true };
  }

  isActive(doc: Y.Doc, tuiAgentId: string): boolean {
    const epicId = docEpicId(doc);
    return (
      epicId !== null && this.activeAgents.has(activityKey(epicId, tuiAgentId))
    );
  }

  private canGenerateTitle(
    resolved: ResolvedRecord | null,
    harnessId: string,
  ): resolved is ResolvedRecord {
    return (
      this.isOwnedHarness(resolved, harnessId) &&
      resolved.record.title.length === 0 &&
      !resolved.record.isTitleEditedByUser
    );
  }

  private isOwnedHarness(
    resolved: ResolvedRecord | null,
    harnessId: string,
  ): resolved is ResolvedRecord {
    return (
      resolved !== null &&
      resolved.record.hostId === this.hostId &&
      resolved.record.userId === this.userId &&
      resolved.record.harnessId === harnessId
    );
  }

  private resolveHookRecord(
    doc: Y.Doc,
    request: {
      readonly epicId?: string | null;
      readonly tuiAgentId?: string | null;
      readonly harnessSessionId?: string | null;
    },
  ): ResolvedRecord | null {
    const epicId = docEpicId(doc);
    if (
      epicId === null ||
      (request.epicId !== undefined &&
        request.epicId !== null &&
        request.epicId !== epicId)
    ) {
      return null;
    }
    const tuiAgents = ensureTuiAgentsMap(doc);
    if (request.tuiAgentId !== undefined && request.tuiAgentId !== null) {
      const entry = tuiAgents.get(request.tuiAgentId);
      const parsed = parseEntry(entry, request.tuiAgentId);
      return parsed === null
        ? null
        : {
            epicId,
            tuiAgentId: request.tuiAgentId,
            entry: parsed.entry,
            record: parsed.record,
          };
    }
    if (
      request.harnessSessionId === undefined ||
      request.harnessSessionId === null
    ) {
      return null;
    }
    for (const [tuiAgentId, value] of tuiAgents) {
      const parsed = parseEntry(value, tuiAgentId);
      if (parsed?.record.harnessSessionId === request.harnessSessionId) {
        return { epicId, tuiAgentId, ...parsed };
      }
    }
    return null;
  }

  private requireOwnedRecord(
    entry: Y.Map<unknown>,
    tuiAgentId: string,
    method: string,
  ): TuiAgent {
    const parsed = parseEntry(entry, tuiAgentId);
    if (parsed === null) {
      throw new TuiAgentServiceError(
        "RPC_ERROR",
        `${method}: terminal-agent '${tuiAgentId}' is invalid.`,
      );
    }
    if (parsed.record.hostId !== this.hostId) {
      throw new TuiAgentServiceError(
        "TARGET_NOT_LOCAL",
        `${method}: terminal-agent '${tuiAgentId}' belongs to host '${parsed.record.hostId}', not '${this.hostId}'.`,
      );
    }
    if (parsed.record.userId !== this.userId) {
      throw new TuiAgentServiceError(
        "FORBIDDEN",
        `${method}: terminal-agent '${tuiAgentId}' belongs to another user.`,
      );
    }
    return parsed.record;
  }

  private setActive(epicId: string, tuiAgentId: string, active: boolean): void {
    const key = activityKey(epicId, tuiAgentId);
    const changed = active
      ? !this.activeAgents.has(key)
      : this.activeAgents.has(key);
    if (active) {
      this.activeAgents.add(key);
    } else {
      this.activeAgents.delete(key);
    }
    if (changed) {
      this.onActivityChanged?.(epicId, tuiAgentId, active);
    }
  }
}

export function ensureTuiAgentsMap(doc: Y.Doc): Y.Map<unknown> {
  const root = doc.getMap<unknown>("epic");
  const existing = root.get("tuiAgents");
  if (existing instanceof Y.Map) {
    return existing;
  }
  const tuiAgents = new Y.Map<unknown>();
  root.set("tuiAgents", tuiAgents);
  return tuiAgents;
}

function requireEpicId(doc: Y.Doc, expected: string, method: string): string {
  const actual = docEpicId(doc);
  if (actual === null || actual !== expected) {
    throw new TuiAgentServiceError(
      "E_INVALID_ARGUMENT",
      `${method}: epic '${expected}' does not match the supplied document.`,
    );
  }
  return actual;
}

function docEpicId(doc: Y.Doc): string | null {
  const id = doc.getMap<unknown>("epic").get("id");
  return typeof id === "string" ? id : null;
}

function findEntry(doc: Y.Doc, tuiAgentId: string): Y.Map<unknown> | null {
  const value = ensureTuiAgentsMap(doc).get(tuiAgentId);
  return value instanceof Y.Map ? value : null;
}

function parseEntry(
  value: unknown,
  expectedId: string,
): { readonly entry: Y.Map<unknown>; readonly record: TuiAgent } | null {
  if (!(value instanceof Y.Map)) {
    return null;
  }
  const parsed = tuiAgentSchema.safeParse(value.toJSON());
  if (!parsed.success || parsed.data.id !== expectedId) {
    return null;
  }
  return { entry: value, record: parsed.data };
}

function unsupportedHarness(method: string, harnessId: string): Error {
  return new TuiAgentServiceError(
    "E_HOST_UNSUPPORTED",
    `${method}: terminal harness '${harnessId}' is not supported by this local host.`,
  );
}

function activityKey(epicId: string, tuiAgentId: string): string {
  return `${epicId}:${tuiAgentId}`;
}

function fallbackTitle(promptText: string): string {
  const normalized = normalizeTitle(promptText);
  if (normalized.length <= 80) {
    return normalized;
  }
  return `${Array.from(normalized).slice(0, 79).join("").trimEnd()}…`;
}

function normalizeTitle(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}
