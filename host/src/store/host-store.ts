import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { TaskRepoIdentifier } from "@traycer/protocol/host/epic/unary-schemas";
import type {
  WorktreeBinding,
  WorktreeBindingOwnerKind,
} from "@traycer/protocol/host/worktree-schemas";

export type StoredEpic = {
  readonly id: string;
  readonly title: string;
  readonly initialUserPrompt: string;
  readonly status: string;
  readonly createdAt: number;
  updatedAt: number;
  readonly createdBy: string;
  readonly version: string;
  ticketCount: number;
  specCount: number;
  storyCount: number;
  reviewCount: number;
  readonly repos: readonly TaskRepoIdentifier[];
  readonly workspaces: readonly string[];
  pinned: boolean;
  readonly lastViewedAt: number | null;
};

export type StoredTurn = {
  readonly messageId: string;
  readonly timestamp: number;
  readonly role: "user" | "assistant";
  readonly prompt: string;
  readonly fromAgentId: string;
  readonly fromTitle: string;
  readonly fromHarnessId: string | null;
  readonly expectReply: boolean;
  readonly responseId: string | null;
  readonly userId: string | null;
  readonly content: unknown | null;
  readonly turnId: string | null;
};

export type StoredProviderSession = {
  readonly harnessId: string;
  readonly sessionId: string;
};

export type StoredChatEvent = {
  readonly eventId: string;
  readonly type: string;
  readonly timestamp: number;
  readonly clientActionId: string | null;
  readonly actor: null;
  readonly message: string | null;
  readonly turnId: string | null;
  readonly messageId: string | null;
  readonly queueItemId: null;
  readonly approvalId: null;
  readonly blockId: null;
  readonly severity: "info" | "warning" | "error";
  readonly metadata: null;
};

export type StoredTokenUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheReadInputTokens: number | undefined;
  readonly contextTokens: number | undefined;
  readonly contextWindow: number | undefined;
  readonly costUsd: number | undefined;
};

/**
 * A durable plain terminal. The PTY is ephemeral - this record is what
 * survives a host restart, and `revision` orders a close against a stale
 * cached mutation result.
 */
export type StoredPlainTerminal = {
  readonly terminalId: string;
  readonly hostId: string;
  readonly epicId: string | null;
  readonly cwd: string;
  readonly shellCommand: string;
  readonly shellArgs: readonly string[];
  readonly createdAt: number;
  manualTitle: string | null;
  revision: number;
  updatedAt: number;
};

/**
 * One row of the local notification feed. Payload-bearing detail is kept as a
 * plain message so the row can be projected onto whichever entry arm the
 * caller's negotiated contract carries.
 */
export type StoredNotification = {
  readonly id: string;
  readonly kind:
    | "agent.stopped"
    | "agent.stalled"
    | "workspace.operation.failed"
    | "approval.requested"
    | "interview.requested";
  readonly epicId: string | null;
  readonly chatId: string | null;
  readonly severity: "info" | "needs_action" | "failure" | "done";
  readonly outcome: "completed" | "stopped" | "errored" | null;
  readonly sourceRef: string | null;
  readonly message: string;
  updatedAt: number;
  readAt: number | null;
  resolvedAt: number | null;
};

/**
 * A local access grant. The signed-in owner is never stored - it is
 * synthesized per epic, so an epic always has exactly one owner and no grant
 * can delete it.
 */
export type StoredCollaborator = {
  readonly epicId: string;
  readonly kind: "user" | "team";
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
  readonly handle: string;
  readonly grantedAt: number;
  readonly grantedBy: string;
  role: "owner" | "editor" | "viewer";
};

/**
 * One completed GUI turn, the local stand-in for a cloud usage fact. Written
 * whether or not the provider reported tokens: `usageCompleteness` says which.
 */
export type StoredUsageFact = {
  readonly factId: string;
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
  readonly harnessId: string;
  readonly model: string;
  readonly occurredAt: number;
  readonly uncachedInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number | null;
  readonly outcome: "completed" | "stopped" | "interrupted" | "abnormal_exit";
  readonly usageCompleteness: "measured" | "partial" | "absent";
  readonly toolCallCount: number;
  readonly toolCallErrorCount: number;
};

export type StoredChat = {
  readonly epicId: string;
  readonly chatId: string;
  readonly parentId: string | null;
  readonly hostId: string;
  readonly title: string;
  readonly createdAt: number;
  readonly runSettings: unknown | null;
  providerSession: StoredProviderSession | null;
  turns: StoredTurn[];
  events: StoredChatEvent[];
  transcriptEpoch: number;
  indexRevision: number;
  fileChangeCount: number;
  lastUsage: StoredTokenUsage | null;
};

export type StoredAgent = {
  readonly id: string;
  readonly epicId: string;
  readonly parentId: string | null;
  readonly hostId: string;
  readonly surface: "gui" | "tui";
  readonly harnessId: string | null;
  readonly title: string | null;
  readonly createdAt: number;
  stopped: boolean;
};

export type StoredTuiAgent = {
  readonly tuiAgentId: string;
  readonly epicId: string;
  readonly parentId: string | null;
  readonly title: string;
  readonly harnessId: string;
  readonly harnessSessionId: string | null;
  readonly terminalAgentArgs: string | null;
  readonly terminalShellCommand: string | null;
  readonly terminalShellArgs: readonly string[] | null;
  readonly hostId: string;
  readonly workspaceFolders: readonly string[];
  readonly workspaceMode: "inherit" | "folderless" | null;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly agentMode: string;
  readonly profileId: string | null;
  readonly forkSourceHarnessSessionId: string | null;
  readonly titleEditedByUser: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type StoredBinding = {
  readonly epicId: string;
  readonly ownerId: string;
  readonly ownerKind: WorktreeBindingOwnerKind;
  readonly binding: WorktreeBinding;
};

export type StoredRecent = {
  readonly path: string;
  readonly lastOpenedAt: string;
};

export type StoredProviderOverride = {
  providerId: string;
  enabled: boolean | null;
  selectedKind: "bundled" | "path" | "custom";
  selectedPath: string | null;
  customPaths: string[];
  apiKey: string | null;
  terminalAgentArgs: string;
  envOverrides: StoredEnvOverride[];
};

export type StoredEnvOverride = {
  readonly key: string;
  readonly value: string | null;
};

export type StoredArtifact = {
  readonly epicId: string;
  readonly artifactId: string;
  readonly kind: string;
  title: string;
  parentId: string | null;
  folderName: string;
  readonly artifactRoomId: string;
  readonly createdAt: number;
  updatedAt: number;
  status: number | null;
  assignee: string | null;
};

export type StoredComment = {
  readonly commentId: string;
  content: JsonContent;
  readonly createdAt: number;
  updatedAt: number | null;
  readonly authorUserId: string;
  readonly authorHandle: string | null;
};

export type StoredCommentThread = {
  readonly epicId: string;
  readonly artifactType: string;
  readonly artifactId: string;
  readonly threadId: string;
  readonly createdAt: number;
  readonly createdByUserId: string;
  readonly quotedText: string;
  resolved: boolean;
  comments: StoredComment[];
};

export type HostState = {
  recents: StoredRecent[];
  selectionGuide: string | null;
  epics: StoredEpic[];
  chats: StoredChat[];
  bindings: StoredBinding[];
  providers: StoredProviderOverride[];
  agents: StoredAgent[];
  tuiAgents: StoredTuiAgent[];
  artifacts: StoredArtifact[];
  commentThreads: StoredCommentThread[];
  usageFacts: StoredUsageFact[];
  collaborators: StoredCollaborator[];
  notifications: StoredNotification[];
  plainTerminals: StoredPlainTerminal[];
};

const EMPTY_STATE: HostState = {
  recents: [],
  selectionGuide: null,
  epics: [],
  chats: [],
  bindings: [],
  providers: [],
  agents: [],
  tuiAgents: [],
  artifacts: [],
  commentThreads: [],
  usageFacts: [],
  collaborators: [],
  notifications: [],
  plainTerminals: [],
};

export class HostStore {
  private state: HostState;
  private writeTail: Promise<void>;
  private closed: boolean;

  constructor(private readonly filePath: string) {
    this.state = {
      recents: [],
      selectionGuide: null,
      epics: [],
      chats: [],
      bindings: [],
      providers: [],
      agents: [],
      tuiAgents: [],
      artifacts: [],
      commentThreads: [],
      usageFacts: [],
      collaborators: [],
      notifications: [],
      plainTerminals: [],
    };
    this.writeTail = Promise.resolve();
    this.closed = false;
  }

  static async open(dataDir: string): Promise<HostStore> {
    const filePath = join(dataDir, "state.json");
    const store = new HostStore(filePath);
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (isPersistedHostState(parsed)) {
        store.state = {
          recents: parsed.recents,
          selectionGuide: parsed.selectionGuide,
          epics: parsed.epics,
          chats: normalizeChats(parsed.chats),
          bindings: parsed.bindings,
          providers: normalizeProviders(parsed.providers),
          agents: normalizeAgents(parsed.agents),
          tuiAgents: normalizeTuiAgents(parsed.tuiAgents),
          artifacts: normalizeArtifacts(parsed.artifacts),
          commentThreads: normalizeCommentThreads(parsed.commentThreads),
          usageFacts: normalizeUsageFacts(parsed.usageFacts),
          collaborators: normalizeCollaborators(parsed.collaborators),
          notifications: normalizeNotifications(parsed.notifications),
          plainTerminals: normalizePlainTerminals(parsed.plainTerminals),
        };
      }
    } catch {
      store.state = cloneState(EMPTY_STATE);
    }
    return store;
  }

  snapshot(): HostState {
    return cloneState(this.state);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.writeTail;
  }

  async mutate<T>(mutator: (state: HostState) => T): Promise<T> {
    if (this.closed) {
      return mutator(this.state);
    }
    const run = this.writeTail.then(async () => {
      const result = mutator(this.state);
      if (!this.closed) {
        await persist(this.filePath, this.state);
      }
      return result;
    });
    this.writeTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

async function persist(filePath: string, state: HostState): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, filePath);
}

export function bumpChatIndex(chat: StoredChat): void {
  chat.indexRevision += 1;
}

function cloneState(state: HostState): HostState {
  return structuredClone(state);
}

type PersistedHostState = Omit<
  HostState,
  | "providers"
  | "agents"
  | "chats"
  | "tuiAgents"
  | "artifacts"
  | "commentThreads"
  | "usageFacts"
  | "collaborators"
  | "notifications"
  | "plainTerminals"
> & {
  readonly providers?: unknown;
  readonly agents?: unknown;
  readonly chats: unknown;
  readonly tuiAgents?: unknown;
  readonly artifacts?: unknown;
  readonly commentThreads?: unknown;
  readonly usageFacts?: unknown;
  readonly collaborators?: unknown;
  readonly notifications?: unknown;
  readonly plainTerminals?: unknown;
};

function isPersistedHostState(value: unknown): value is PersistedHostState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.recents) &&
    Array.isArray(record.epics) &&
    Array.isArray(record.chats) &&
    Array.isArray(record.bindings) &&
    (record.selectionGuide === null ||
      typeof record.selectionGuide === "string") &&
    (record.providers === undefined || Array.isArray(record.providers)) &&
    (record.agents === undefined || Array.isArray(record.agents)) &&
    (record.tuiAgents === undefined || Array.isArray(record.tuiAgents))
  );
}

function normalizeProviders(value: unknown): StoredProviderOverride[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rows: StoredProviderOverride[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.providerId !== "string") {
      continue;
    }
    const selectedKind =
      record.selectedKind === "bundled" ||
      record.selectedKind === "path" ||
      record.selectedKind === "custom"
        ? record.selectedKind
        : "path";
    rows.push({
      providerId: record.providerId,
      enabled: typeof record.enabled === "boolean" ? record.enabled : null,
      selectedKind,
      selectedPath:
        typeof record.selectedPath === "string" ? record.selectedPath : null,
      customPaths: Array.isArray(record.customPaths)
        ? record.customPaths.filter(
            (path): path is string => typeof path === "string",
          )
        : [],
      apiKey:
        typeof record.apiKey === "string" && record.apiKey.length > 0
          ? record.apiKey
          : null,
      terminalAgentArgs:
        typeof record.terminalAgentArgs === "string"
          ? record.terminalAgentArgs
          : "",
      envOverrides: normalizeEnvOverrides(record.envOverrides),
    });
  }
  return rows;
}

function normalizeEnvOverrides(value: unknown): StoredEnvOverride[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rows: StoredEnvOverride[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.key !== "string" || record.key.length === 0) {
      continue;
    }
    rows.push({
      key: record.key,
      value: typeof record.value === "string" ? record.value : null,
    });
  }
  return rows;
}

function normalizeArtifacts(value: unknown): StoredArtifact[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rows: StoredArtifact[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.epicId !== "string" ||
      typeof record.artifactId !== "string" ||
      typeof record.kind !== "string" ||
      typeof record.title !== "string" ||
      typeof record.folderName !== "string" ||
      typeof record.createdAt !== "number"
    ) {
      continue;
    }
    rows.push({
      epicId: record.epicId,
      artifactId: record.artifactId,
      kind: record.kind,
      title: record.title,
      parentId: typeof record.parentId === "string" ? record.parentId : null,
      folderName: record.folderName,
      artifactRoomId:
        typeof record.artifactRoomId === "string" &&
        record.artifactRoomId.length > 0
          ? record.artifactRoomId
          : "",
      createdAt: record.createdAt,
      updatedAt:
        typeof record.updatedAt === "number"
          ? record.updatedAt
          : record.createdAt,
      status: typeof record.status === "number" ? record.status : null,
      assignee: typeof record.assignee === "string" ? record.assignee : null,
    });
  }
  return rows;
}

function normalizeCommentThreads(value: unknown): StoredCommentThread[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rows: StoredCommentThread[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.epicId !== "string" ||
      typeof record.artifactType !== "string" ||
      typeof record.artifactId !== "string" ||
      typeof record.threadId !== "string" ||
      typeof record.createdAt !== "number" ||
      typeof record.createdByUserId !== "string"
    ) {
      continue;
    }
    rows.push({
      epicId: record.epicId,
      artifactType: record.artifactType,
      artifactId: record.artifactId,
      threadId: record.threadId,
      createdAt: record.createdAt,
      createdByUserId: record.createdByUserId,
      quotedText:
        typeof record.quotedText === "string" ? record.quotedText : "",
      resolved: record.resolved === true,
      comments: normalizeComments(record.comments),
    });
  }
  return rows;
}

function normalizeComments(value: unknown): StoredComment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rows: StoredComment[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.commentId !== "string" ||
      typeof record.createdAt !== "number" ||
      typeof record.authorUserId !== "string"
    ) {
      continue;
    }
    rows.push({
      commentId: record.commentId,
      content: isJsonContent(record.content)
        ? record.content
        : { type: "doc", content: [] },
      createdAt: record.createdAt,
      updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : null,
      authorUserId: record.authorUserId,
      authorHandle:
        typeof record.authorHandle === "string" ? record.authorHandle : null,
    });
  }
  return rows;
}

function normalizeChats(value: unknown): StoredChat[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rows: StoredChat[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.epicId !== "string" ||
      typeof record.chatId !== "string" ||
      typeof record.hostId !== "string" ||
      typeof record.title !== "string" ||
      typeof record.createdAt !== "number"
    ) {
      continue;
    }
    rows.push({
      epicId: record.epicId,
      chatId: record.chatId,
      parentId: typeof record.parentId === "string" ? record.parentId : null,
      hostId: record.hostId,
      title: record.title,
      createdAt: record.createdAt,
      runSettings: record.runSettings === undefined ? null : record.runSettings,
      providerSession: normalizeProviderSession(record.providerSession),
      turns: normalizeTurns(record.turns),
      events: normalizeChatEvents(record.events),
      transcriptEpoch:
        typeof record.transcriptEpoch === "number" ? record.transcriptEpoch : 0,
      indexRevision:
        typeof record.indexRevision === "number" ? record.indexRevision : 0,
      fileChangeCount:
        typeof record.fileChangeCount === "number" ? record.fileChangeCount : 0,
      lastUsage: normalizeUsage(record.lastUsage),
    });
  }
  return rows;
}

function normalizeChatEvents(value: unknown): StoredChatEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rows: StoredChatEvent[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const eventId = Reflect.get(entry, "eventId");
    const type = Reflect.get(entry, "type");
    const timestamp = Reflect.get(entry, "timestamp");
    if (
      typeof eventId !== "string" ||
      typeof type !== "string" ||
      typeof timestamp !== "number"
    ) {
      continue;
    }
    const severity = Reflect.get(entry, "severity");
    rows.push({
      eventId,
      type,
      timestamp,
      clientActionId: readNullableString(entry, "clientActionId"),
      actor: null,
      message: readNullableString(entry, "message"),
      turnId: readNullableString(entry, "turnId"),
      messageId: readNullableString(entry, "messageId"),
      queueItemId: null,
      approvalId: null,
      blockId: null,
      severity:
        severity === "warning" || severity === "error" || severity === "info"
          ? severity
          : "info",
      metadata: null,
    });
  }
  return rows;
}

function normalizeUsage(value: unknown): StoredTokenUsage | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const inputTokens = Reflect.get(value, "inputTokens");
  const outputTokens = Reflect.get(value, "outputTokens");
  const totalTokens = Reflect.get(value, "totalTokens");
  if (
    typeof inputTokens !== "number" ||
    typeof outputTokens !== "number" ||
    typeof totalTokens !== "number"
  ) {
    return null;
  }
  const cacheReadInputTokens = Reflect.get(value, "cacheReadInputTokens");
  const contextTokens = Reflect.get(value, "contextTokens");
  const contextWindow = Reflect.get(value, "contextWindow");
  const costUsd = Reflect.get(value, "costUsd");
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadInputTokens:
      typeof cacheReadInputTokens === "number"
        ? cacheReadInputTokens
        : undefined,
    contextTokens:
      typeof contextTokens === "number" ? contextTokens : undefined,
    contextWindow:
      typeof contextWindow === "number" ? contextWindow : undefined,
    costUsd: typeof costUsd === "number" ? costUsd : undefined,
  };
}

function readNullableString(record: object, key: string): string | null {
  const value = Reflect.get(record, key);
  return typeof value === "string" ? value : null;
}

function normalizeProviderSession(
  value: unknown,
): StoredProviderSession | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const harnessId = Reflect.get(value, "harnessId");
  const sessionId = Reflect.get(value, "sessionId");
  if (typeof harnessId !== "string" || typeof sessionId !== "string") {
    return null;
  }
  if (harnessId.length === 0 || sessionId.length === 0) {
    return null;
  }
  return { harnessId, sessionId };
}

function normalizeTurns(value: unknown): StoredTurn[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rows: StoredTurn[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.messageId !== "string" ||
      typeof record.timestamp !== "number" ||
      typeof record.prompt !== "string" ||
      typeof record.fromAgentId !== "string"
    ) {
      continue;
    }
    rows.push({
      messageId: record.messageId,
      timestamp: record.timestamp,
      role: record.role === "assistant" ? "assistant" : "user",
      prompt: record.prompt,
      fromAgentId: record.fromAgentId,
      fromTitle: typeof record.fromTitle === "string" ? record.fromTitle : "",
      fromHarnessId:
        typeof record.fromHarnessId === "string" ? record.fromHarnessId : null,
      expectReply: record.expectReply === true,
      responseId:
        typeof record.responseId === "string" ? record.responseId : null,
      userId: typeof record.userId === "string" ? record.userId : null,
      content: record.content === undefined ? null : record.content,
      turnId: typeof record.turnId === "string" ? record.turnId : null,
    });
  }
  return rows;
}

function normalizeAgents(value: unknown): StoredAgent[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rows: StoredAgent[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      typeof record.epicId !== "string" ||
      typeof record.hostId !== "string" ||
      typeof record.createdAt !== "number"
    ) {
      continue;
    }
    const surface = record.surface === "tui" ? "tui" : "gui";
    rows.push({
      id: record.id,
      epicId: record.epicId,
      parentId: typeof record.parentId === "string" ? record.parentId : null,
      hostId: record.hostId,
      surface,
      harnessId: typeof record.harnessId === "string" ? record.harnessId : null,
      title: typeof record.title === "string" ? record.title : null,
      createdAt: record.createdAt,
      stopped: record.stopped === true,
    });
  }
  return rows;
}

function normalizeTuiAgents(value: unknown): StoredTuiAgent[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rows: StoredTuiAgent[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.tuiAgentId !== "string" ||
      typeof record.epicId !== "string" ||
      typeof record.title !== "string" ||
      typeof record.harnessId !== "string" ||
      typeof record.hostId !== "string" ||
      typeof record.createdAt !== "number" ||
      typeof record.updatedAt !== "number"
    ) {
      continue;
    }
    const workspaceMode =
      record.workspaceMode === "inherit" ||
      record.workspaceMode === "folderless"
        ? record.workspaceMode
        : null;
    rows.push({
      tuiAgentId: record.tuiAgentId,
      epicId: record.epicId,
      parentId: typeof record.parentId === "string" ? record.parentId : null,
      title: record.title,
      harnessId: record.harnessId,
      harnessSessionId:
        typeof record.harnessSessionId === "string"
          ? record.harnessSessionId
          : null,
      terminalAgentArgs:
        typeof record.terminalAgentArgs === "string"
          ? record.terminalAgentArgs
          : null,
      terminalShellCommand:
        typeof record.terminalShellCommand === "string"
          ? record.terminalShellCommand
          : null,
      terminalShellArgs: stringArrayOrNull(record.terminalShellArgs),
      hostId: record.hostId,
      workspaceFolders: stringArray(record.workspaceFolders),
      workspaceMode,
      model: typeof record.model === "string" ? record.model : null,
      reasoningEffort:
        typeof record.reasoningEffort === "string"
          ? record.reasoningEffort
          : null,
      agentMode:
        typeof record.agentMode === "string" ? record.agentMode : "regular",
      profileId: typeof record.profileId === "string" ? record.profileId : null,
      forkSourceHarnessSessionId:
        typeof record.forkSourceHarnessSessionId === "string"
          ? record.forkSourceHarnessSessionId
          : null,
      titleEditedByUser: record.titleEditedByUser === true,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }
  return rows;
}

function isJsonContent(value: unknown): value is JsonContent {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function stringArrayOrNull(value: unknown): string[] | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

// ponytail: newest USAGE_FACT_LIMIT facts only - state.json is rewritten
// whole on every mutation, so the ledger is capped rather than paged. Move it
// to its own append-only file if a window longer than this is ever wanted.
export const USAGE_FACT_LIMIT = 5000;

const USAGE_OUTCOMES = [
  "completed",
  "stopped",
  "interrupted",
  "abnormal_exit",
] as const;

const USAGE_COMPLETENESS = ["measured", "partial", "absent"] as const;

function normalizeUsageFacts(value: unknown): StoredUsageFact[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rows: StoredUsageFact[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.factId !== "string" ||
      typeof record.epicId !== "string" ||
      typeof record.chatId !== "string" ||
      typeof record.hostId !== "string" ||
      typeof record.harnessId !== "string" ||
      typeof record.model !== "string" ||
      typeof record.occurredAt !== "number"
    ) {
      continue;
    }
    const outcome = USAGE_OUTCOMES.find((row) => row === record.outcome);
    const completeness = USAGE_COMPLETENESS.find(
      (row) => row === record.usageCompleteness,
    );
    rows.push({
      factId: record.factId,
      epicId: record.epicId,
      chatId: record.chatId,
      hostId: record.hostId,
      harnessId: record.harnessId,
      model: record.model,
      occurredAt: record.occurredAt,
      uncachedInputTokens: countOf(record.uncachedInputTokens),
      cacheReadInputTokens: countOf(record.cacheReadInputTokens),
      cacheCreationTokens: countOf(record.cacheCreationTokens),
      outputTokens: countOf(record.outputTokens),
      costUsd: typeof record.costUsd === "number" ? record.costUsd : null,
      outcome: outcome ?? "completed",
      usageCompleteness: completeness ?? "absent",
      toolCallCount: countOf(record.toolCallCount),
      toolCallErrorCount: countOf(record.toolCallErrorCount),
    });
  }
  return rows.slice(-USAGE_FACT_LIMIT);
}

/** Every token field on the wire is a non-negative integer. */
export function countOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.round(value));
}

const COLLABORATOR_ROLES = ["owner", "editor", "viewer"] as const;

function normalizeCollaborators(value: unknown): StoredCollaborator[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rows: StoredCollaborator[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.epicId !== "string" ||
      typeof record.id !== "string" ||
      typeof record.grantedAt !== "number"
    ) {
      continue;
    }
    const role = COLLABORATOR_ROLES.find((row) => row === record.role);
    rows.push({
      epicId: record.epicId,
      kind: record.kind === "team" ? "team" : "user",
      id: record.id,
      displayName:
        typeof record.displayName === "string" ? record.displayName : record.id,
      email: typeof record.email === "string" ? record.email : "",
      handle: typeof record.handle === "string" ? record.handle : "",
      grantedAt: record.grantedAt,
      grantedBy:
        typeof record.grantedBy === "string" ? record.grantedBy : "local",
      role: role ?? "viewer",
    });
  }
  return rows;
}

// ponytail: newest NOTIFICATION_LIMIT rows only, same reason the usage ledger
// is capped - `state.json` is rewritten whole on every mutation.
export const NOTIFICATION_LIMIT = 500;

const NOTIFICATION_KINDS = [
  "agent.stopped",
  "agent.stalled",
  "workspace.operation.failed",
  "approval.requested",
  "interview.requested",
] as const;

const NOTIFICATION_SEVERITIES = [
  "info",
  "needs_action",
  "failure",
  "done",
] as const;

const NOTIFICATION_OUTCOMES = ["completed", "stopped", "errored"] as const;

function normalizeNotifications(value: unknown): StoredNotification[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rows: StoredNotification[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const kind = NOTIFICATION_KINDS.find((row) => row === record.kind);
    const severity = NOTIFICATION_SEVERITIES.find(
      (row) => row === record.severity,
    );
    if (
      typeof record.id !== "string" ||
      typeof record.updatedAt !== "number" ||
      kind === undefined ||
      severity === undefined
    ) {
      continue;
    }
    rows.push({
      id: record.id,
      kind,
      epicId: typeof record.epicId === "string" ? record.epicId : null,
      chatId: typeof record.chatId === "string" ? record.chatId : null,
      severity,
      outcome:
        NOTIFICATION_OUTCOMES.find((row) => row === record.outcome) ?? null,
      sourceRef: typeof record.sourceRef === "string" ? record.sourceRef : null,
      message: typeof record.message === "string" ? record.message : "",
      updatedAt: record.updatedAt,
      readAt: typeof record.readAt === "number" ? record.readAt : null,
      resolvedAt:
        typeof record.resolvedAt === "number" ? record.resolvedAt : null,
    });
  }
  return rows.slice(-NOTIFICATION_LIMIT);
}

function normalizePlainTerminals(value: unknown): StoredPlainTerminal[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rows: StoredPlainTerminal[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.terminalId !== "string" ||
      typeof record.hostId !== "string" ||
      typeof record.cwd !== "string" ||
      typeof record.shellCommand !== "string" ||
      typeof record.createdAt !== "number"
    ) {
      continue;
    }
    rows.push({
      terminalId: record.terminalId,
      hostId: record.hostId,
      epicId: typeof record.epicId === "string" ? record.epicId : null,
      cwd: record.cwd,
      shellCommand: record.shellCommand,
      shellArgs: Array.isArray(record.shellArgs)
        ? record.shellArgs.filter((arg) => typeof arg === "string")
        : [],
      createdAt: record.createdAt,
      manualTitle:
        typeof record.manualTitle === "string" ? record.manualTitle : null,
      revision: countOf(record.revision),
      updatedAt:
        typeof record.updatedAt === "number"
          ? record.updatedAt
          : record.createdAt,
    });
  }
  return rows;
}
