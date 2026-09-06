import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  readonly updatedAt: number;
  readonly createdBy: string;
  readonly version: string;
  readonly ticketCount: number;
  readonly specCount: number;
  readonly storyCount: number;
  readonly reviewCount: number;
  readonly repos: readonly TaskRepoIdentifier[];
  readonly workspaces: readonly string[];
  readonly pinned: boolean;
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
  "providers" | "agents" | "chats" | "tuiAgents"
> & {
  readonly providers?: unknown;
  readonly agents?: unknown;
  readonly chats: unknown;
  readonly tuiAgents?: unknown;
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
    (record.selectionGuide === null || typeof record.selectionGuide === "string") &&
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
      selectedPath: typeof record.selectedPath === "string" ? record.selectedPath : null,
      customPaths: Array.isArray(record.customPaths)
        ? record.customPaths.filter((path): path is string => typeof path === "string")
        : [],
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
      typeof cacheReadInputTokens === "number" ? cacheReadInputTokens : undefined,
    contextTokens: typeof contextTokens === "number" ? contextTokens : undefined,
    contextWindow: typeof contextWindow === "number" ? contextWindow : undefined,
    costUsd: typeof costUsd === "number" ? costUsd : undefined,
  };
}

function readNullableString(record: object, key: string): string | null {
  const value = Reflect.get(record, key);
  return typeof value === "string" ? value : null;
}

function normalizeProviderSession(value: unknown): StoredProviderSession | null {
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
      responseId: typeof record.responseId === "string" ? record.responseId : null,
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
      record.workspaceMode === "inherit" || record.workspaceMode === "folderless"
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
      agentMode: typeof record.agentMode === "string" ? record.agentMode : "regular",
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
