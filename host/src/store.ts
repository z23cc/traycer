import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { createTypedMap } from "@traycer/protocol/utils/yjs-utils/factory";
import type {
  CreateChatInitialMessage,
  CreateArtifactRequest,
  CreateArtifactResponse,
  CreateEpicRequest,
  CreateEpicResponse,
  DeleteArtifactRequest,
  DeleteArtifactResponse,
  DeleteChatRequest,
  DeleteChatResponse,
  EpicLight,
  ListTasksResponse,
  RenameArtifactRequest,
  RenameArtifactResponse,
  RenameChatRequest,
  RenameChatResponse,
  ReparentArtifactRequest,
  ReparentArtifactResponse,
  ReparentChatRequest,
  ReparentChatResponse,
  PreparedWorkspaceFolder,
  SetChatArchivedRequest,
  SetChatArchivedResponse,
  TaskRepoAssociation,
  TaskRepoIdentifier,
  UpdateEpicRequest,
  UpdateEpicResponse,
  UpdateChatProfileRequest,
  UpdateChatProfileResponse,
  UpdateChatRunSettingsRequestV11,
  UpdateChatRunSettingsResponse,
  UpdateArtifactStatusRequest,
  UpdateArtifactStatusResponse,
  UserTaskWorkspace,
} from "@traycer/protocol/host/epic/unary-schemas";
import type {
  ChatActiveTurn,
  ChatQueuedPromptItem,
  ChatQueueState,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  guiHarnessIdSchema,
  guiHarnessIdSchemaV60,
  tuiHarnessIdSchema,
  type CreateAgentRequestV30,
  type CreateAgentResponse,
  type CreateAgentWorkspace,
  type ListAgentsRequest,
  type ListAgentsResponse,
  type ProfileSelection,
  type SendAgentMessageRequest,
  type SendAgentMessageResponse,
} from "@traycer/protocol/host/agent/shared";
import type {
  GetChatRunSettingsRequest,
  GetChatRunSettingsResponse,
} from "@traycer/protocol/host/epic/chat-records";
import type { WorkspaceResolvePathsByRepoIdentifiersResponse } from "@traycer/protocol/host/workspace/unary-schemas";
import type {
  WorktreeBinding,
  WorktreeBindingEntry,
  WorktreeBindingOwnerKind,
  WorktreeCreateRequest,
  WorktreeCreateResponse,
  WorktreeCreatePathsRequest,
  WorktreeCreatePathsResponse,
  WorktreeSetEntryModeRequest,
  WorktreeSetEntryModeResponse,
  WorkspaceBindingRemoveEntryRequest,
  WorkspaceBindingRemoveEntryResponse,
} from "@traycer/protocol/host/worktree-schemas";
import type {
  AssistantMessage,
  ChatEvent,
  Message,
  UserMessage,
} from "@traycer/protocol/persistence/epic/schemas";
import {
  chatSchema,
  chatRunSettingsSchema,
  type ChatRunSettings,
} from "@traycer/protocol/persistence/epic/schemas";
import { ArtifactRoomManager } from "./artifact-rooms";
import { directoryExists, isGitRepo } from "./git-probe";
import {
  isLocalGuiHarnessId,
  localGuiModelsFor,
  type LocalGuiHarnessId,
  type LocalGuiModel,
} from "./gui-model-catalog";
import {
  localOrImportedEntry,
  materializeManagedWorktree,
  materializeOwnerlessWorktree,
  type WorktreeMaterialization,
} from "./worktree-create";
import {
  type RepoWorkspaceMapping,
  RepoWorkspacePersistence,
} from "./repo-workspace-persistence";
import { summarizeWorktreeWorkspacePaths } from "./worktree-summary";

export const LOCAL_USER_ID = "local-user";

export type StoredChat = {
  readonly id: string;
  readonly epicId: string;
  parentId: string | null;
  readonly hostId: string;
  readonly userId: string;
  title: string;
  isTitleEditedByUser: boolean;
  readonly createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  settings: ChatRunSettings | null;
  messages: Message[];
  events: ChatEvent[];
  runStatus: "idle" | "running" | "stopping";
  activeTurn: ChatActiveTurn | null;
  turnInProgress: boolean;
  worktreeBinding: WorktreeBinding | null;
  providerSessionId: string | null;
};

export type StoredEpic = {
  light: EpicLight;
  readonly repos: TaskRepoAssociation[];
  readonly workspaces: UserTaskWorkspace[];
  readonly chats: Map<string, StoredChat>;
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly artifactRooms: ArtifactRoomManager;
  readonly syncChatMetadata: () => void;
};

type StoredOwnerBinding = {
  readonly epicId: string;
  readonly ownerId: string;
  readonly ownerKind: WorktreeBindingOwnerKind;
  readonly binding: WorktreeBinding;
};

type OwnerBindingRef = {
  readonly epicId: string;
  readonly ownerId: string;
  readonly ownerKind: WorktreeBindingOwnerKind;
};

type AgentListRecord = {
  readonly id: string;
  readonly parentId: unknown;
  readonly hostId: unknown;
  readonly userId: unknown;
  readonly isLocal: boolean;
  readonly surface: "gui" | "tui";
  readonly harnessId: ListAgentsResponse["agents"][number]["harnessId"];
  readonly title: string | null;
  readonly archived: boolean;
  readonly active: boolean;
  readonly workspaceFolders: readonly string[];
};

type ArchiveRecord = {
  readonly entry: Y.Map<unknown>;
  readonly chat: StoredChat | null;
};

type ChatRecord = {
  readonly epic: StoredEpic;
  readonly entry: Y.Map<unknown>;
  readonly chat: StoredChat | null;
};

type AgentChatRecord = {
  readonly chat: StoredChat | null;
  readonly hostId: string;
  readonly userId: string;
  readonly title: string | null;
  readonly harnessId: string | null;
};

type PendingAgentResponse = {
  readonly responseId: string;
  readonly epicId: string;
  readonly senderAgentId: string;
  readonly receiverAgentId: string;
};

type QueuedAgentMessage = {
  readonly epicId: string;
  readonly chatId: string;
  readonly queueItemId: string;
  readonly createdAt: number;
  readonly message: UserMessage;
  readonly settings: ChatRunSettings;
};

type AgentMessageReply = Extract<
  UserMessage["sender"],
  { readonly type: "agent" }
>["reply"];

export type ChatFrameSink = (frame: unknown) => void;

export type PendingTurn = {
  readonly epicId: string;
  readonly chatId: string;
  readonly userMessageId: string;
  readonly settings: ChatRunSettings;
};

export type CreateEpicOutcome = {
  readonly response: CreateEpicResponse;
  readonly pendingTurn: PendingTurn | null;
};

export type CreateChatRecordRequest = {
  readonly epicId: string;
  readonly chatId: string;
  readonly parentId: string | null;
  readonly hostId: string;
  readonly title: string;
  readonly settings: ChatRunSettings | null | undefined;
  readonly initialMessage: CreateChatInitialMessage | null | undefined;
};

export type CreateChatRecordOutcome = {
  readonly chatId: string;
  readonly created: boolean;
};

export class HostState {
  readonly hostId: string;
  readonly epics = new Map<string, StoredEpic>();
  private readonly notificationsDoc = new Y.Doc();
  private readonly repoWorkspaceMappings = new Map<
    string,
    RepoWorkspaceMapping
  >();
  private readonly worktreeBindings = new Map<string, StoredOwnerBinding>();
  private readonly ownerBindingMutationTails = new Map<string, Promise<void>>();
  private readonly chatActionTails = new Map<string, Promise<void>>();
  private readonly chatSinks = new Map<string, Set<ChatFrameSink>>();
  private readonly pendingAgentResponses = new Map<
    string,
    PendingAgentResponse
  >();
  private readonly pendingAgentResponseIdsByPair = new Map<string, string>();
  private readonly queuedAgentMessages = new Map<
    string,
    QueuedAgentMessage[]
  >();
  private readonly abortByChat = new Map<string, AbortController>();
  private readonly inflight = new Set<string>();
  private readonly idleWaiters = new Map<string, Array<() => void>>();

  constructor(
    hostId: string,
    private readonly repoWorkspacePersistence:
      RepoWorkspacePersistence | undefined,
    private readonly worktreeRoot: string | undefined,
  ) {
    this.hostId = hostId;
    for (const mapping of repoWorkspacePersistence?.listMappings() ?? []) {
      this.repoWorkspaceMappings.set(mapping.workspacePath, mapping);
    }
  }

  getNotificationsDoc(): Y.Doc {
    return this.notificationsDoc;
  }

  createEpic(request: CreateEpicRequest): CreateEpicOutcome {
    const now = Date.now();
    const light: EpicLight = {
      ...request.epic,
      createdAt: request.epic.createdAt || now,
      updatedAt: now,
      createdBy:
        request.epic.createdBy.length > 0
          ? request.epic.createdBy
          : LOCAL_USER_ID,
    };
    const workspaces = request.workspaces.map((workspace) => ({
      task: { taskId: light.id, taskType: "epic" as const },
      hostId: this.hostId,
      workspacePath: workspace.workspacePath,
      createdAt: now,
    }));
    const repos = request.repoIdentifiers.map((repo) => ({
      task: { taskId: light.id, taskType: "epic" as const },
      repoIdentifier: repo,
      createdAt: now,
      createdBy: LOCAL_USER_ID,
    }));
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    awareness.setLocalState(null);
    seedEpicDoc(doc, light);
    const chats = new Map<string, StoredChat>();
    const syncChatMetadata = (): void => {
      synchronizeStoredChatMetadata(doc, chats);
    };
    const stored: StoredEpic = {
      light,
      repos,
      workspaces,
      chats,
      doc,
      awareness,
      artifactRooms: new ArtifactRoomManager(doc),
      syncChatMetadata,
    };
    doc.on("update", syncChatMetadata);
    this.epics.set(light.id, stored);
    let pendingTurn: PendingTurn | null = null;
    if (request.chat !== undefined && request.chat !== null) {
      const chat = this.insertChat(stored, {
        chatId: request.chat.chatId,
        parentId: request.chat.parentId,
        hostId: request.chat.hostId,
        title: request.chat.title,
        settings: request.chat.initialMessage?.settings ?? null,
        initialBinding: "epic",
        isTitleEditedByUser: false,
      });
      if (request.chat.initialMessage !== null) {
        pendingTurn = this.applyInitialMessage(
          chat,
          request.chat.initialMessage,
        );
      }
    }
    return {
      response: {
        roomInfo: {
          roomId: light.id,
          webSocketUrl: "ws://127.0.0.1:1/unused",
          token: null,
        },
        task: this.toTaskLight(stored, projectStoredEpicLight(stored)),
        initialTurnStarted: pendingTurn !== null,
      },
      pendingTurn,
    };
  }

  createArtifact(request: CreateArtifactRequest): CreateArtifactResponse {
    const now = Date.now();
    const epic = this.epics.get(request.epicId);
    if (epic === undefined) {
      throw new StoreError(
        "E_INVALID_ARGUMENT",
        `Unknown epic ${request.epicId}`,
      );
    }
    const artifacts = epic.doc.getMap<unknown>("epic").get("artifacts");
    if (!(artifacts instanceof Y.Map)) {
      throw new StoreError(
        "RPC_ERROR",
        `Epic ${request.epicId} has no artifacts map`,
      );
    }
    if (
      request.parentId !== null &&
      !(artifacts.get(request.parentId) instanceof Y.Map)
    ) {
      throw new StoreError(
        "RPC_ERROR",
        `Parent artifact '${request.parentId}' does not exist in this epic for ${request.artifactType}`,
      );
    }

    const artifactId = randomUUID();
    const folderName = uniqueArtifactFolderName(
      request.title,
      siblingFolderNames(artifacts, request.parentId),
    );
    const artifactRoomId =
      epic.artifactRooms.assignArtifactRoomForCreate(artifactId);
    epic.doc.transact(() => {
      const entry = new Y.Map<unknown>();
      entry.set("kind", request.artifactType);
      entry.set("id", artifactId);
      entry.set("folderName", folderName);
      entry.set("title", request.title);
      entry.set("parentId", request.parentId);
      entry.set("createdAt", now);
      entry.set("updatedAt", now);
      entry.set("createdManually", true);
      entry.set("artifactRoomId", artifactRoomId);
      if (
        request.artifactType === "ticket" ||
        request.artifactType === "story"
      ) {
        entry.set("assignee", "");
        entry.set("status", 0);
      }
      artifacts.set(artifactId, entry);
    });
    return { artifactId };
  }

  updateEpicTitle(request: UpdateEpicRequest): UpdateEpicResponse {
    const delta = request.epicDelta;
    if (delta === null) {
      return { updated: false };
    }
    const epic = this.epics.get(delta.id);
    if (epic === undefined) {
      throw new StoreError("E_INVALID_ARGUMENT", `Unknown epic ${delta.id}`);
    }
    if (delta.title === undefined) {
      return { updated: false };
    }
    epic.doc.transact(() => {
      const root = epic.doc.getMap("epic");
      root.set("title", delta.title);
      root.set("isTitleEditedByUser", true);
      root.set("updatedAt", delta.updatedAt);
    });
    epic.light.title = delta.title;
    epic.light.updatedAt = delta.updatedAt;
    return { updated: true };
  }

  renameArtifact(request: RenameArtifactRequest): RenameArtifactResponse {
    const { epic, entry } = requireArtifact(
      this.epics,
      request.epicId,
      request.artifactId,
    );
    epic.doc.transact(() => {
      entry.set("title", request.title);
      entry.set("updatedAt", Date.now());
    });
    return { updated: true };
  }

  reparentArtifact(request: ReparentArtifactRequest): ReparentArtifactResponse {
    const { epic, entry } = requireArtifact(
      this.epics,
      request.epicId,
      request.artifactId,
    );
    const artifacts = epic.doc.getMap<unknown>("epic").get("artifacts");
    if (!(artifacts instanceof Y.Map)) {
      throw new StoreError(
        "RPC_ERROR",
        `Epic ${request.epicId} has no artifacts map`,
      );
    }
    if (entry.get("parentId") !== request.newParentId) {
      validateArtifactParent(
        artifacts,
        request.artifactId,
        entry,
        request.newParentId,
      );
    }
    epic.doc.transact(() => {
      entry.set("parentId", request.newParentId);
      entry.set("updatedAt", Date.now());
    });
    return { updated: true };
  }

  updateArtifactStatus(
    request: UpdateArtifactStatusRequest,
  ): UpdateArtifactStatusResponse {
    const { epic, entry } = requireArtifact(
      this.epics,
      request.epicId,
      request.artifactId,
    );
    epic.doc.transact(() => {
      entry.set("status", request.status);
      entry.set("updatedAt", Date.now());
    });
    return { updated: true };
  }

  deleteArtifact(request: DeleteArtifactRequest): DeleteArtifactResponse {
    const epic = this.epics.get(request.epicId);
    if (epic === undefined) {
      throw new StoreError(
        "E_INVALID_ARGUMENT",
        `Unknown epic ${request.epicId}`,
      );
    }
    const epicMap = epic.doc.getMap<unknown>("epic");
    const artifacts = epicMap.get("artifacts");
    const deletedArtifacts = epicMap.get("deletedArtifacts");
    if (!(artifacts instanceof Y.Map) || !(deletedArtifacts instanceof Y.Map)) {
      throw new StoreError(
        "RPC_ERROR",
        `Epic ${request.epicId} has no artifact collections`,
      );
    }
    const rootEntry = artifacts.get(request.artifactId);
    const rootTombstone = deletedArtifacts.get(request.artifactId);
    const hasLiveRoot = artifacts.has(request.artifactId);
    const rootKind = artifactKindFrom(hasLiveRoot ? rootEntry : rootTombstone);
    if (hasLiveRoot && rootKind === null) {
      throw new StoreError(
        "RPC_ERROR",
        `Artifact '${request.artifactId}' has no kind in epic doc`,
      );
    }
    if (rootKind === null) {
      return { deleted: true };
    }

    const descendants = descendantArtifactIds(artifacts, request.artifactId);
    const deletionPlans: ArtifactDeletionPlan[] = descendants.map(
      (artifactId) => {
        const plan = planLiveArtifactDeletion(artifacts, artifactId);
        if (plan === null) {
          throw new StoreError(
            "RPC_ERROR",
            `Artifact '${artifactId}' not found in epic doc`,
          );
        }
        return plan;
      },
    );
    const rootPlan = planLiveArtifactDeletion(artifacts, request.artifactId);
    if (rootPlan !== null) {
      deletionPlans.push(rootPlan);
    }
    const bodiesToClear = deletionPlans.flatMap((plan) =>
      plan.body === null ? [] : [plan.body],
    );
    if (rootPlan === null && rootTombstone instanceof Y.Map) {
      const rootBody = artifactBodyFromIntegratedEntry(
        rootTombstone,
        request.artifactId,
      );
      if (rootBody !== null) {
        bodiesToClear.push(rootBody);
      }
    }
    epic.doc.transact(() => {
      for (const plan of deletionPlans) {
        deletedArtifacts.set(plan.artifactId, plan.tombstone);
        artifacts.delete(plan.artifactId);
      }
    });
    for (const body of bodiesToClear) {
      try {
        epic.artifactRooms.clearBody(body.roomId, body.artifactId);
      } catch {
        // Root deletion is already committed; room cleanup is best-effort.
      }
    }
    return { deleted: true };
  }

  renameChat(request: RenameChatRequest): RenameChatResponse {
    const { epic, chat, entry } = requireChat(
      this.epics,
      request.epicId,
      request.chatId,
    );
    const now = Date.now();
    epic.doc.transact(() => {
      entry.set("title", request.title);
      entry.set("isTitleEditedByUser", true);
      entry.set("updatedAt", now);
      chat.title = request.title;
      chat.isTitleEditedByUser = true;
      chat.updatedAt = now;
    });
    return { updated: true };
  }

  reparentChat(request: ReparentChatRequest): ReparentChatResponse {
    const { epic, chat, entry } = requireChat(
      this.epics,
      request.epicId,
      request.chatId,
    );
    const now = Date.now();
    epic.doc.transact(() => {
      entry.set("parentId", request.newParentId);
      entry.set("updatedAt", now);
      chat.parentId = request.newParentId;
      chat.updatedAt = now;
    });
    return { updated: true };
  }

  setChatArchived(request: SetChatArchivedRequest): SetChatArchivedResponse {
    const knownEpic = this.epics.get(request.epicId);
    if (knownEpic === undefined) {
      throw new StoreError(
        "E_INVALID_ARGUMENT",
        `Unknown epic ${request.epicId}`,
      );
    }
    const record = resolveArchiveRecord(knownEpic, request.chatId);
    if (record === null) {
      throw archiveRecordMissing(request.epicId, request.chatId);
    }
    if (request.archived) {
      const hostId = record.entry.get("hostId");
      if (typeof hostId !== "string") {
        throw new StoreError(
          "RPC_ERROR",
          archiveMissingHostMessage(request.chatId),
        );
      }
      if (hostId !== this.hostId && hostId !== "legacy") {
        throw new StoreError(
          "RPC_ERROR",
          archiveNotLocalMessage(request.chatId, hostId, this.hostId),
        );
      }
      if (this.inflight.has(chatKey(request.epicId, request.chatId))) {
        throw new StoreError("RPC_ERROR", archiveBusyMessage(request.chatId));
      }
    }
    const persistedArchivedAt = record.entry.get("archivedAt");
    const alreadyArchived = typeof persistedArchivedAt === "number";
    if (alreadyArchived === request.archived) {
      return { updated: false };
    }
    const archivedAt = request.archived ? Date.now() : null;
    const updatedAt = Date.now();
    knownEpic.doc.transact(() => {
      record.entry.set("archivedAt", archivedAt);
      record.entry.set("updatedAt", updatedAt);
      if (record.chat !== null) {
        record.chat.archivedAt = archivedAt;
        record.chat.updatedAt = updatedAt;
      }
    });
    if (record.chat !== null) {
      this.emitChat(
        request.epicId,
        request.chatId,
        this.snapshotFrame(request.epicId, record.chat),
      );
    }
    return { updated: true };
  }

  updateChatRunSettings(
    request: UpdateChatRunSettingsRequestV11,
  ): UpdateChatRunSettingsResponse {
    const record = requireChatRecord(
      this.epics,
      request.epicId,
      request.chatId,
    );
    const updatedAt = Date.now();
    record.epic.doc.transact(() => {
      record.entry.set("settings", createTypedMap(request.settings));
      record.entry.set("updatedAt", updatedAt);
      if (record.chat !== null) {
        record.chat.settings = request.settings;
        record.chat.updatedAt = updatedAt;
      }
    });
    return { updated: true };
  }

  updateChatProfile(
    request: UpdateChatProfileRequest,
  ): UpdateChatProfileResponse {
    const record = requireChatRecord(
      this.epics,
      request.epicId,
      request.chatId,
    );
    const settings =
      record.chat === null
        ? chatRunSettingsFromEntry(record.entry)
        : record.chat.settings;
    if (settings === null) {
      return { updated: false };
    }
    if (settings.profileId === request.profileId) {
      return { updated: true };
    }
    if (request.profileId !== null) {
      assertLocalProfileAvailable(settings.harnessId, request.profileId);
    }
    const nextSettings: ChatRunSettings = {
      ...settings,
      profileId: request.profileId,
    };
    const updatedAt = Date.now();
    record.epic.doc.transact(() => {
      record.entry.set("settings", createTypedMap(nextSettings));
      record.entry.set("updatedAt", updatedAt);
      if (record.chat !== null) {
        record.chat.settings = nextSettings;
        record.chat.updatedAt = updatedAt;
      }
    });
    return { updated: true };
  }

  deleteChat(request: DeleteChatRequest): Promise<DeleteChatResponse> {
    const owner = {
      epicId: request.epicId,
      ownerId: request.chatId,
      ownerKind: "chat" as const,
    };
    return this.withSerializedOwnerBindingMutation(owner, async () => {
      const epic = this.epics.get(request.epicId);
      if (epic === undefined) {
        throw new StoreError(
          "E_INVALID_ARGUMENT",
          `Unknown epic ${request.epicId}`,
        );
      }
      const epicMap = epic.doc.getMap<unknown>("epic");
      const chats = epicMap.get("chats");
      if (!(chats instanceof Y.Map)) {
        throw new StoreError(
          "RPC_ERROR",
          `Epic ${request.epicId} has no chats map`,
        );
      }
      const persisted = chats.get(request.chatId);
      if (persisted !== undefined) {
        if (!(persisted instanceof Y.Map)) {
          throw new StoreError(
            "RPC_ERROR",
            `Chat '${request.chatId}' is corrupt in epic doc`,
          );
        }
        if (persisted.get("userId") !== LOCAL_USER_ID) {
          throw new StoreError("FORBIDDEN", request.chatId);
        }
      }
      const hadStoredChat = epic.chats.has(request.chatId);
      epic.doc.transact(() => {
        purgeRoleClaimsForChat(epicMap, request.chatId);
        chats.delete(request.chatId);
      });
      epic.chats.delete(request.chatId);
      this.queuedAgentMessages.delete(chatKey(request.epicId, request.chatId));
      if (persisted !== undefined || hadStoredChat) {
        this.worktreeBindings.delete(
          ownerBindingKey(request.epicId, "chat", request.chatId),
        );
      }
      return { deleted: true };
    });
  }

  createChat(request: CreateChatRecordRequest): {
    readonly chatId: string;
    readonly initialTurnStarted: boolean;
    readonly pendingTurn: PendingTurn | null;
  } {
    const record = this.createChatRecord(request);
    if (!record.created) {
      return {
        chatId: record.chatId,
        initialTurnStarted: false,
        pendingTurn: null,
      };
    }
    const pendingTurn =
      request.initialMessage === undefined || request.initialMessage === null
        ? null
        : this.startInitialChatTurn(
            request.epicId,
            request.chatId,
            request.initialMessage,
          );
    return {
      chatId: record.chatId,
      initialTurnStarted: pendingTurn !== null,
      pendingTurn,
    };
  }

  createChatRecord(request: CreateChatRecordRequest): CreateChatRecordOutcome {
    const epic = this.epics.get(request.epicId);
    if (epic === undefined) {
      throw new StoreError(
        "E_INVALID_ARGUMENT",
        `Unknown epic ${request.epicId}`,
      );
    }
    const existing = epic.chats.get(request.chatId);
    if (existing !== undefined) {
      return {
        chatId: existing.id,
        created: false,
      };
    }
    if (this.inflight.has(chatKey(request.epicId, request.chatId))) {
      throw new StoreError(
        "E_INVALID_ARGUMENT",
        `Chat ${request.chatId} is still finishing a turn`,
      );
    }
    const chat = this.insertChat(epic, {
      chatId: request.chatId,
      parentId: request.parentId,
      hostId: request.hostId,
      title: request.title,
      settings: request.settings ?? request.initialMessage?.settings ?? null,
      initialBinding: "epic",
      isTitleEditedByUser: false,
    });
    return {
      chatId: chat.id,
      created: true,
    };
  }

  startInitialChatTurn(
    epicId: string,
    chatId: string,
    initialMessage: CreateChatInitialMessage,
  ): PendingTurn {
    const chat = this.getChat(epicId, chatId);
    if (chat === null) {
      throw new StoreError("E_INVALID_ARGUMENT", `Unknown chat ${chatId}`);
    }
    return this.applyInitialMessage(chat, initialMessage);
  }

  async createAgent(
    request: CreateAgentRequestV30,
  ): Promise<CreateAgentResponse> {
    const sender = this.getChat(request.epicId, request.senderAgentId);
    if (sender === null) {
      throw new StoreError(
        "RPC_ERROR",
        `agent.create: sender TUI agent '${request.senderAgentId}' was not found.`,
      );
    }
    if (sender.hostId !== this.hostId) {
      throw new StoreError(
        "RPC_ERROR",
        `agent.create: sender agent '${request.senderAgentId}' is not local to host '${this.hostId}'.`,
      );
    }
    const resolved = resolveGuiAgentSettings(request, sender);
    const epic = this.epics.get(request.epicId);
    if (epic === undefined) {
      throw new StoreError(
        "E_INVALID_ARGUMENT",
        `Unknown epic ${request.epicId}`,
      );
    }
    const agentId = randomUUID();
    await this.withSerializedChatAction(request.epicId, agentId, async () => {
      if (epic.chats.has(agentId)) {
        throw new StoreError(
          "RPC_ERROR",
          `agent.create: generated child id '${agentId}' already exists.`,
        );
      }
      this.insertChat(epic, {
        chatId: agentId,
        parentId: request.senderAgentId,
        hostId: this.hostId,
        title: request.name ?? "",
        settings: resolved.settings,
        initialBinding: "none",
        isTitleEditedByUser: request.name !== null,
      });
      if (request.workspace !== null) {
        await this.bindAgentWorkspace(
          request.epicId,
          agentId,
          request.workspace,
        );
      } else {
        await this.inheritAgentWorkspace(
          request.epicId,
          request.senderAgentId,
          agentId,
        );
      }
    });
    return { agentId, warnings: resolved.warnings };
  }

  listAgents(request: ListAgentsRequest): ListAgentsResponse {
    const epic = this.epics.get(request.epicId);
    if (epic === undefined) {
      throw new StoreError(
        "E_INVALID_ARGUMENT",
        `Unknown epic ${request.epicId}`,
      );
    }
    const root = epic.doc.getMap<unknown>("epic");
    const records: AgentListRecord[] = [];
    const chats = root.get("chats");
    if (!(chats instanceof Y.Map)) {
      throw new StoreError(
        "RPC_ERROR",
        "agent.list: chat records are invalid.",
      );
    }
    for (const [chatId, value] of chats) {
      if (!(value instanceof Y.Map)) {
        throw invalidAgentListRecord("GUI", chatId);
      }
      const hostId = value.get("hostId");
      const userId = value.get("userId");
      const parentId = value.get("parentId");
      const title = value.get("title");
      const archived = typeof value.get("archivedAt") === "number";
      const isLocal = hostId === this.hostId;
      records.push({
        id: chatId,
        parentId,
        hostId,
        userId,
        isLocal,
        surface: "gui",
        harnessId: guiHarnessIdFromEntry(value),
        title: typeof title === "string" && title.length > 0 ? title : null,
        archived,
        active:
          !archived &&
          isLocal &&
          this.inflight.has(chatKey(request.epicId, chatId)),
        workspaceFolders: [],
      });
    }
    const storedTuiAgents = root.get("tuiAgents");
    const tuiAgents =
      storedTuiAgents instanceof Y.Map ? storedTuiAgents : new Y.Map<unknown>();
    if (!(storedTuiAgents instanceof Y.Map)) {
      root.set("tuiAgents", tuiAgents);
    }
    for (const [agentId, value] of tuiAgents) {
      if (value === null || value === undefined) {
        throw invalidAgentListRecord("TUI", agentId);
      }
      const parsedHarness = tuiHarnessIdSchema.safeParse(
        agentRecordField(value, "harnessId"),
      );
      if (!parsedHarness.success || parsedHarness.data === "cursor") {
        continue;
      }
      const hostId = agentRecordField(value, "hostId");
      const userId = agentRecordField(value, "userId");
      const parentId = agentRecordField(value, "parentId");
      const title = agentRecordField(value, "title");
      const archived =
        typeof agentRecordField(value, "archivedAt") === "number";
      const isLocal = hostId === this.hostId;
      const storedFolders = agentRecordField(value, "workspaceFolders");
      records.push({
        id: agentId,
        parentId,
        hostId,
        userId,
        isLocal,
        surface: "tui",
        harnessId: parsedHarness.data,
        title: typeof title === "string" && title.length > 0 ? title : null,
        archived,
        active:
          !archived &&
          isLocal &&
          this.inflight.has(chatKey(request.epicId, agentId)),
        workspaceFolders: stringArrayFromYjs(storedFolders),
      });
    }
    const caller = records.find(
      (record) => record.id === request.senderAgentId,
    );
    if (caller === undefined) {
      throw new StoreError(
        "RPC_ERROR",
        `agent.list: sender agent '${request.senderAgentId}' was not found.`,
      );
    }
    const visible =
      request.scope === "user"
        ? records.filter((record) => record.userId === caller.userId)
        : records;
    return {
      caller: {
        agentId: request.senderAgentId,
        canSendMessages: canSendAgentMessages(caller, true),
      },
      scope: request.scope,
      agents: visible.map((record) => {
        if (
          typeof record.hostId !== "string" ||
          (record.parentId !== null && typeof record.parentId !== "string")
        ) {
          throw invalidAgentListRecord(
            record.surface === "gui" ? "GUI" : "TUI",
            record.id,
          );
        }
        const sameUser = record.userId === caller.userId;
        const folderContext = this.agentFolderContext(epic, record);
        return {
          id: record.id,
          parentId: record.parentId,
          hostId: record.hostId,
          isLocal: record.isLocal,
          surface: record.surface,
          harnessId: record.harnessId,
          isSelf: record.id === caller.id,
          title: record.title,
          capabilities: {
            readTranscript: canReadAgentTranscript(record, sameUser),
            sendMessage: canSendAgentMessages(record, sameUser),
          },
          active: record.active,
          folderPaths: folderContext.folderPaths,
          isWorktree: folderContext.isWorktree,
          runConfig: null,
        };
      }),
    };
  }

  listTasks(): ListTasksResponse {
    const tasks = [...this.epics.values()]
      .map((epic) => ({ epic, light: projectStoredEpicLight(epic) }))
      .sort((left, right) => right.light.updatedAt - left.light.updatedAt)
      .map(({ epic, light }) => this.toTaskLight(epic, light));
    return { tasks, hasMore: false };
  }

  getEpic(epicId: string): StoredEpic | null {
    return this.epics.get(epicId) ?? null;
  }

  getChat(epicId: string, chatId: string): StoredChat | null {
    return this.epics.get(epicId)?.chats.get(chatId) ?? null;
  }

  getChatRunSettings(
    request: GetChatRunSettingsRequest,
  ): GetChatRunSettingsResponse {
    const record = findChatRecord(this.epics, request.epicId, request.chatId);
    return {
      settings:
        record === null
          ? null
          : record.chat === null
            ? chatRunSettingsFromEntry(record.entry)
            : record.chat.settings,
    };
  }

  hasInflightTurns(): boolean {
    return this.inflight.size > 0;
  }

  chatCwd(epicId: string, chatId: string): string {
    const chat = this.getChat(epicId, chatId);
    if (chat !== null) {
      if (chat.worktreeBinding?.workspaceMode === "folderless") {
        return ensureFolderlessCwdForEpic(epicId);
      }
      const fromBinding = cwdFromBinding(chat.worktreeBinding);
      if (fromBinding !== null) {
        return fromBinding;
      }
    }
    const epic = this.getEpic(epicId);
    if (epic !== null && epic.workspaces[0] !== undefined) {
      return epic.workspaces[0].workspacePath;
    }
    return ensureFolderlessCwdForEpic(epicId);
  }

  missingWorktreePaths(binding: WorktreeBinding | null): string[] {
    if (binding === null) {
      return [];
    }
    const missing: string[] = [];
    for (const entry of binding.entries) {
      const path = entry.worktreePath ?? entry.workspacePath;
      if (!directoryExists(path)) {
        missing.push(entry.workspacePath);
      }
    }
    return missing;
  }

  getBinding(args: {
    readonly epicId: string;
    readonly ownerId: string;
    readonly ownerKind: "chat" | "terminal-agent";
  }): {
    readonly binding: WorktreeBinding | null;
    readonly missingWorktreePaths: string[];
  } {
    const binding = bindingForOwner(
      this.worktreeBindings,
      this.getEpic(args.epicId),
      args.epicId,
      args.ownerKind,
      args.ownerId,
    );
    return {
      binding,
      missingWorktreePaths: this.missingWorktreePaths(binding),
    };
  }

  setWorktreeEntryMode(
    request: WorktreeSetEntryModeRequest,
  ): Promise<WorktreeSetEntryModeResponse> {
    this.guardOwnerBindingMutation(request);
    return this.withSerializedOwnerBindingMutation(request, async () => {
      this.guardOwnerBindingMutation(request);
      const current = bindingForOwner(
        this.worktreeBindings,
        this.getEpic(request.epicId),
        request.epicId,
        request.ownerKind,
        request.ownerId,
      );
      const entries = current?.entries ?? [];
      const existing = entries.find(
        (entry) => entry.workspacePath === request.workspacePath,
      );
      if (existing !== undefined && isFullyLocalEntry(existing)) {
        return { binding: { entries } };
      }
      const local: WorktreeBindingEntry =
        existing === undefined
          ? localEntry(request.workspacePath, entries.length === 0, Date.now())
          : {
              ...existing,
              mode: "local",
              worktreePath: null,
              branch: null,
              isImported: false,
              setupState: "not_required",
              setupTerminalSessionId: null,
              setupExitCode: null,
              setupFailedAt: null,
              ownedSubmodules: [],
            };
      const binding: WorktreeBinding = {
        entries:
          existing === undefined
            ? [...entries, local]
            : entries.map((entry) =>
                entry.workspacePath === request.workspacePath ? local : entry,
              ),
      };
      this.storeOwnerBinding(request, binding);
      return { binding };
    });
  }

  async createWorktree(
    request: WorktreeCreateRequest,
  ): Promise<WorktreeCreateResponse> {
    this.guardOwnerBindingMutation(request);
    return this.withSerializedOwnerBindingMutation(request, async () => {
      this.guardOwnerBindingMutation(request);
      let current = bindingForOwner(
        this.worktreeBindings,
        this.getEpic(request.epicId),
        request.epicId,
        request.ownerKind,
        request.ownerId,
      );
      if (request.entries.length === 0) {
        const binding: WorktreeBinding = {
          workspaceMode: "folderless",
          entries: [],
        };
        this.storeOwnerBinding(request, binding);
        return { binding, perEntry: [] };
      }

      const perEntry: WorktreeCreateResponse["perEntry"] = [];
      const worktreeEntries = request.entries.filter(
        (entry) => entry.kind === "worktree",
      );
      const created: WorktreeBindingEntry[] = [];
      for (const intent of worktreeEntries) {
        const existing = current?.entries.find(
          (entry) => entry.workspacePath === intent.workspacePath,
        );
        if (
          existing?.worktreePath !== null &&
          existing?.worktreePath !== undefined &&
          !existing.isImported &&
          existing.branch !== null &&
          existing.branch === intent.branch.name &&
          !(
            intent.branch.type === "new" && intent.branch.collision === "random"
          )
        ) {
          created.push(existing);
          perEntry.push({
            workspacePath: intent.workspacePath,
            ok: true,
            worktreePath: existing.worktreePath,
            branch: existing.branch,
            errorMessage: null,
          });
          continue;
        }
        let materialized: WorktreeMaterialization;
        try {
          materialized = await materializeManagedWorktree(
            intent,
            this.worktreeRoot ?? join(homedir(), ".traycer", "worktrees"),
            Date.now,
          );
        } catch (error) {
          perEntry.push({
            workspacePath: intent.workspacePath,
            ok: false,
            worktreePath: null,
            branch: intent.branch.name,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        perEntry.push(materialized.result);
        if (materialized.entry !== null) {
          created.push(materialized.entry);
        }
      }
      if (created.length > 0) {
        current = mergeOwnerBinding(current, created, undefined);
        this.storeOwnerBinding(request, current);
      }

      const importedOrLocal = request.entries.filter(
        (entry) => entry.kind !== "worktree",
      );
      if (importedOrLocal.length > 0) {
        const replacements: WorktreeBindingEntry[] = [];
        const touchedWorkspacePaths: string[] = [];
        for (const intent of importedOrLocal) {
          const resolved = await localOrImportedEntry(
            intent,
            this.worktreeRoot ?? join(homedir(), ".traycer", "worktrees"),
            Date.now,
          );
          replacements.push(resolved.entry);
          touchedWorkspacePaths.push(...resolved.touchedWorkspacePaths);
          perEntry.push(resolved.result);
        }
        current = mergeOwnerBinding(
          current,
          replacements,
          touchedWorkspacePaths,
        );
        this.storeOwnerBinding(request, current);
      }

      return { binding: current ?? { entries: [] }, perEntry };
    });
  }

  async createWorktreePaths(
    request: WorktreeCreatePathsRequest,
  ): Promise<WorktreeCreatePathsResponse> {
    const entries: WorktreeCreatePathsResponse["entries"] = [];
    const perEntry: WorktreeCreatePathsResponse["perEntry"] = [];
    for (const requested of request.entries) {
      const [summary] = await summarizeWorktreeWorkspacePaths(
        [requested.workspacePath],
        { forceRefresh: true, environment: "omit" },
      );
      if (summary === undefined || !summary.isGitRepo) {
        perEntry.push({
          workspacePath: requested.workspacePath,
          ok: false,
          worktreePath: null,
          branch: null,
          errorMessage:
            summary?.resolvedAt === null
              ? `Could not inspect workspace (git probe failed): ${requested.workspacePath}`
              : `Workspace is not a git repository: ${requested.workspacePath}`,
        });
        continue;
      }
      if (requested.branch.type === "existing") {
        const occupied = summary.worktrees.find(
          (worktree) => worktree.branch === requested.branch.name,
        );
        if (occupied !== undefined) {
          perEntry.push({
            workspacePath: requested.workspacePath,
            ok: false,
            worktreePath: null,
            branch: requested.branch.name,
            errorMessage: `${requested.branch.name} is already checked out in ${occupied.worktreePath}`,
          });
          continue;
        }
      }
      const materialized = await materializeOwnerlessWorktree(
        {
          kind: "worktree",
          workspacePath: requested.workspacePath,
          repoIdentifier: null,
          isPrimary: false,
          branch: requested.branch,
          scripts: null,
        },
        this.worktreeRoot ?? join(homedir(), ".traycer", "worktrees"),
        Date.now,
        summary.repoIdentifier,
      );
      perEntry.push(materialized.result);
      if (
        materialized.entry !== null &&
        materialized.entry.worktreePath !== null
      ) {
        entries.push({
          workspacePath: materialized.entry.workspacePath,
          path: materialized.entry.worktreePath,
          mode: materialized.entry.mode,
          repoIdentifier: materialized.entry.repoIdentifier,
          branch: materialized.entry.branch,
        });
      }
    }
    return { entries, perEntry };
  }

  removeWorktreeBindingEntry(
    request: WorkspaceBindingRemoveEntryRequest,
  ): Promise<WorkspaceBindingRemoveEntryResponse> {
    this.guardOwnerBindingMutation(request);
    return this.withSerializedOwnerBindingMutation(request, async () => {
      this.guardOwnerBindingMutation(request);
      const current = bindingForOwner(
        this.worktreeBindings,
        this.getEpic(request.epicId),
        request.epicId,
        request.ownerKind,
        request.ownerId,
      );
      if (current === null) {
        return { binding: { entries: [] } };
      }
      const entries = current.entries.filter(
        (entry) => entry.workspacePath !== request.workspacePath,
      );
      if (entries.length === current.entries.length) {
        return { binding: current };
      }
      const binding: WorktreeBinding =
        entries.length === 0
          ? { workspaceMode: "folderless", entries: [] }
          : { entries: enforceSinglePrimary(entries) };
      this.storeOwnerBinding(request, binding);
      return { binding };
    });
  }

  listBindingsForEpic(epicId: string): {
    readonly rows: unknown[];
    readonly folderlessCwd: string;
  } {
    const epic = this.getEpic(epicId);
    const folderlessCwd = folderlessCwdForEpic(epicId);
    if (epic === null) {
      return { rows: [], folderlessCwd };
    }
    const rows: unknown[] = [];
    let hasExplicitOwnerBinding = false;
    for (const owner of this.worktreeBindings.values()) {
      if (owner.epicId !== epicId) {
        continue;
      }
      hasExplicitOwnerBinding = true;
      for (const entry of owner.binding.entries) {
        rows.push(
          selectorRow(this.hostId, owner.ownerKind, owner.ownerId, entry),
        );
      }
    }
    if (rows.length === 0 && !hasExplicitOwnerBinding) {
      for (const workspace of epic.workspaces) {
        rows.push(
          selectorRow(
            this.hostId,
            "chat",
            "",
            localEntry(workspace.workspacePath, true, Date.now()),
          ),
        );
      }
    }
    return { rows, folderlessCwd };
  }

  async recordPreparedWorkspaceMappings(
    folders: readonly PreparedWorkspaceFolder[],
  ): Promise<void> {
    if (this.repoWorkspacePersistence !== undefined) {
      const mappings =
        await this.repoWorkspacePersistence.upsertPreparedFolders(folders);
      this.repoWorkspaceMappings.clear();
      for (const mapping of mappings) {
        this.repoWorkspaceMappings.set(mapping.workspacePath, mapping);
      }
      return;
    }
    for (const folder of folders) {
      if (folder.repoIdentifier === null || folder.repoUrl === null) {
        continue;
      }
      this.repoWorkspaceMappings.set(folder.workspacePath, {
        repoIdentifier: folder.repoIdentifier,
        repoUrl: folder.repoUrl,
        workspacePath: folder.workspacePath,
      });
    }
  }

  resolvePathsByRepoIdentifiers(
    repoIdentifiers: readonly TaskRepoIdentifier[],
  ): WorkspaceResolvePathsByRepoIdentifiersResponse {
    const requested = new Map(
      repoIdentifiers.map((identifier) => [
        normalizedRepoIdentifier(identifier),
        identifier,
      ]),
    );
    const mappings: WorkspaceResolvePathsByRepoIdentifiersResponse["mappings"] =
      [];
    for (const mapping of this.repoWorkspaceMappings.values()) {
      const identifier = requested.get(
        normalizedRepoIdentifier(mapping.repoIdentifier),
      );
      if (identifier === undefined) {
        continue;
      }
      mappings.push({
        repoIdentifier: identifier,
        workspacePath: mapping.workspacePath,
      });
    }
    return { mappings };
  }

  acceptUser(args: {
    readonly epicId: string;
    readonly chatId: string;
    readonly messageId: string;
    readonly content: JsonContent;
    readonly sender: UserMessage["sender"];
    readonly settings: ChatRunSettings;
  }): { readonly user: UserMessage; readonly pendingTurn: PendingTurn } {
    const chat = this.getChat(args.epicId, args.chatId);
    if (chat === null) {
      throw new StoreError("E_INVALID_ARGUMENT", `Unknown chat ${args.chatId}`);
    }
    this.reserveTurn(args.epicId, args.chatId);
    try {
      const shouldUnarchive = chat.archivedAt !== null;
      const now = Date.now();
      const user = userMessage(args.messageId, args.sender, args.content, now);
      const { epic, entry } = requireChat(this.epics, args.epicId, args.chatId);
      epic.doc.transact(() => {
        entry.set("settings", createTypedMap(args.settings));
        entry.set("updatedAt", now);
        chat.messages = [...chat.messages, user];
        chat.settings = args.settings;
        chat.updatedAt = now;
      });
      if (shouldUnarchive) {
        try {
          this.setChatArchived({
            epicId: args.epicId,
            chatId: args.chatId,
            archived: false,
          });
        } catch {
          // Message acceptance is durable; auto-unarchive is best-effort.
        }
      }
      return {
        user,
        pendingTurn: {
          epicId: args.epicId,
          chatId: args.chatId,
          userMessageId: user.messageId,
          settings: args.settings,
        },
      };
    } catch (error) {
      this.releaseTurn(args.epicId, args.chatId);
      throw error;
    }
  }

  acceptAgentMessage(request: SendAgentMessageRequest): {
    readonly response: SendAgentMessageResponse;
    readonly pendingTurn: PendingTurn | null;
  } {
    request = this.resolveAgentMessageParticipants(request);
    const epic = this.epics.get(request.epicId);
    if (epic === undefined) {
      throw new StoreError(
        "E_INVALID_ARGUMENT",
        `Unknown epic ${request.epicId}`,
      );
    }
    const sender = agentChatRecord(epic, request.senderAgentId);
    if (sender === null) {
      throw new StoreError(
        "RPC_ERROR",
        `agent.sendMessage: sender agent '${request.senderAgentId}' was not found.`,
      );
    }
    if (sender.hostId !== this.hostId) {
      throw new StoreError(
        "RPC_ERROR",
        `agent.sendMessage: SENDER_NOT_LOCAL - sender '${request.senderAgentId}' is not local to host '${this.hostId}'.`,
      );
    }
    const receiver = agentChatRecord(epic, request.receiverAgentId);
    if (receiver === null) {
      throw new StoreError(
        "RPC_ERROR",
        `agent.sendMessage: RECEIVER_NOT_FOUND - '${request.receiverAgentId}'.`,
      );
    }
    if (receiver.hostId !== this.hostId) {
      throw new StoreError(
        "RPC_ERROR",
        `agent.sendMessage: RECEIVER_NOT_LOCAL - '${request.receiverAgentId}' is not local to host '${this.hostId}'.`,
      );
    }
    if (sender.userId !== receiver.userId) {
      throw new StoreError("FORBIDDEN", request.receiverAgentId);
    }
    const thread = this.settleAgentResponseThread(request);
    const receiverChat =
      receiver.chat ?? this.hydrateLocalGuiChat(epic, request.receiverAgentId);
    if (receiverChat === null) {
      throw new StoreError(
        "RPC_ERROR",
        `agent.sendMessage: RECEIVER_NOT_LOCAL - '${request.receiverAgentId}' is not local to host '${this.hostId}'.`,
      );
    }
    const settings = receiverChat.settings;
    if (settings === null) {
      throw new StoreError(
        "RPC_ERROR",
        `enqueueAgentMessage: chat ${request.receiverAgentId} has no run settings configured.`,
      );
    }
    const binding = receiverChat.worktreeBinding;
    if (binding === null) {
      throw new StoreError(
        "RPC_ERROR",
        "enqueueAgentMessage: Unable to resolve this agent's workspace selection. Choose a workspace before sending a message.",
      );
    }
    const key = chatKey(request.epicId, request.receiverAgentId);
    if (!this.inflight.has(key)) {
      const missingWorkspacePaths = this.missingWorktreePaths(binding);
      if (missingWorkspacePaths.length > 0) {
        throw new StoreError(
          "WORKTREE_MISSING",
          worktreeMissingMessage(missingWorkspacePaths),
        );
      }
    }
    const senderHarness = guiHarnessIdSchema.safeParse(sender.harnessId);
    const persistedHarness = senderHarness.success
      ? senderHarness.data
      : settings.harnessId;
    const messageId = `agent-msg-${randomUUID()}`;
    const queuedAt = Date.now();
    const queued: QueuedAgentMessage = {
      epicId: request.epicId,
      chatId: request.receiverAgentId,
      queueItemId: randomUUID(),
      createdAt: queuedAt,
      message: agentUserMessage({
        messageId,
        timestamp: queuedAt,
        prompt: request.prompt,
        senderAgentId: request.senderAgentId,
        senderTitle: sender.title,
        senderHarnessId: sender.harnessId,
        persistedHarnessId: persistedHarness,
        reply: thread.reply,
        inReplyTo: thread.inReplyTo,
      }),
      settings,
    };
    if (this.inflight.has(key)) {
      const pending = this.queuedAgentMessages.get(key) ?? [];
      pending.push(queued);
      this.queuedAgentMessages.set(key, pending);
      const item = queuedAgentMessageItem(queued);
      this.appendChatEvent(queued.epicId, queued.chatId, {
        eventId: randomUUID(),
        type: "queue.added",
        timestamp: Date.now(),
        clientActionId: null,
        actor: queued.message.sender,
        message: "Queued agent message accepted.",
        turnId: receiverChat.activeTurn?.turnId ?? null,
        messageId: queued.message.messageId,
        queueItemId: queued.queueItemId,
        approvalId: null,
        blockId: null,
        severity: "info",
        metadata: { item },
      });
      this.unarchiveAgentMessageReceiver(queued.epicId, queued.chatId);
      this.emitChat(queued.epicId, queued.chatId, {
        kind: "queueChanged",
        hasBinaryPayload: false,
        epicId: queued.epicId,
        chatId: queued.chatId,
        queue: queuedAgentQueueState(pending),
      });
      return {
        response: { responseId: thread.responseId },
        pendingTurn: null,
      };
    }
    return {
      response: { responseId: thread.responseId },
      pendingTurn: this.acceptQueuedAgentMessage(queued),
    };
  }

  resolveAgentMessageParticipants(
    request: SendAgentMessageRequest,
  ): SendAgentMessageRequest {
    const epic = this.epics.get(request.epicId);
    if (epic === undefined) {
      throw new StoreError(
        "E_INVALID_ARGUMENT",
        `Unknown epic ${request.epicId}`,
      );
    }
    return {
      ...request,
      senderAgentId: resolveAgentId(epic, request.senderAgentId),
      receiverAgentId: resolveAgentId(epic, request.receiverAgentId),
    };
  }

  startNextQueuedAgentMessage(
    epicId: string,
    chatId: string,
  ): PendingTurn | null {
    const key = chatKey(epicId, chatId);
    if (this.getChat(epicId, chatId) === null) {
      this.queuedAgentMessages.delete(key);
      return null;
    }
    if (this.inflight.has(key)) {
      return null;
    }
    const pending = this.queuedAgentMessages.get(key);
    if (pending === undefined) {
      this.queuedAgentMessages.delete(key);
      return null;
    }
    const next = pending[0];
    if (next === undefined) {
      this.queuedAgentMessages.delete(key);
      return null;
    }
    this.reserveTurn(epicId, chatId);
    try {
      pending.shift();
      if (pending.length === 0) {
        this.queuedAgentMessages.delete(key);
      }
      this.appendChatEvent(epicId, chatId, {
        eventId: randomUUID(),
        type: "queue.started",
        timestamp: Date.now(),
        clientActionId: null,
        actor: next.message.sender,
        message: "Queued prompt started.",
        turnId: null,
        messageId: null,
        queueItemId: next.queueItemId,
        approvalId: null,
        blockId: null,
        severity: "info",
        metadata: null,
      });
      this.emitChat(epicId, chatId, {
        kind: "queueChanged",
        hasBinaryPayload: false,
        epicId,
        chatId,
        queue: queuedAgentQueueState(pending),
      });
      return this.persistQueuedAgentMessage(next, next.queueItemId);
    } catch (error) {
      this.releaseTurn(epicId, chatId);
      throw error;
    }
  }

  private acceptQueuedAgentMessage(queued: QueuedAgentMessage): PendingTurn {
    this.reserveTurn(queued.epicId, queued.chatId);
    try {
      return this.persistQueuedAgentMessage(queued, null);
    } catch (error) {
      this.releaseTurn(queued.epicId, queued.chatId);
      throw error;
    }
  }

  private persistQueuedAgentMessage(
    queued: QueuedAgentMessage,
    queueItemId: string | null,
  ): PendingTurn {
    const { chat, entry } = requireChat(
      this.epics,
      queued.epicId,
      queued.chatId,
    );
    const message: UserMessage = {
      ...queued.message,
      timestamp: Date.now(),
    };
    entry.set("updatedAt", message.timestamp);
    chat.messages = [...chat.messages, message];
    chat.updatedAt = message.timestamp;
    this.unarchiveAgentMessageReceiver(queued.epicId, queued.chatId);
    const acceptedEvent: ChatEvent = {
      eventId: randomUUID(),
      type: "send.accepted",
      timestamp: Date.now(),
      clientActionId: null,
      actor: message.sender,
      message: "Message accepted.",
      turnId: chat.activeTurn?.turnId ?? null,
      messageId: message.messageId,
      queueItemId,
      approvalId: null,
      blockId: null,
      severity: "info",
      metadata: null,
    };
    this.recordChatEvent(queued.epicId, queued.chatId, acceptedEvent);
    this.emitChat(queued.epicId, queued.chatId, {
      kind: "messageAccepted",
      hasBinaryPayload: false,
      epicId: queued.epicId,
      chatId: queued.chatId,
      message,
    });
    this.emitChatEvent(queued.epicId, queued.chatId, acceptedEvent);
    return {
      epicId: queued.epicId,
      chatId: queued.chatId,
      userMessageId: message.messageId,
      settings: queued.settings,
    };
  }

  private unarchiveAgentMessageReceiver(epicId: string, chatId: string): void {
    const chat = this.getChat(epicId, chatId);
    if (chat?.archivedAt === null) {
      return;
    }
    try {
      this.setChatArchived({ epicId, chatId, archived: false });
    } catch {
      // Delivery is accepted; auto-unarchive is best-effort.
    }
  }

  private settleAgentResponseThread(request: SendAgentMessageRequest): {
    readonly reply: AgentMessageReply;
    readonly responseId: string | null;
    readonly inReplyTo: string | null;
  } {
    const resolvedResponseId = this.resolveAgentResponseId(request.responseId);
    if (resolvedResponseId !== null) {
      const pending = this.pendingAgentResponses.get(resolvedResponseId);
      if (pending !== undefined) {
        if (
          pending.senderAgentId !== request.receiverAgentId ||
          pending.receiverAgentId !== request.senderAgentId
        ) {
          throw new StoreError(
            "RPC_ERROR",
            `agent.sendMessage: RESPONSE_ID_MISMATCH - '${resolvedResponseId}' belongs to a different (sender, receiver) pair.`,
          );
        }
        this.guardAgentReplyReceiverCancelling(request);
        this.pendingAgentResponses.delete(resolvedResponseId);
        this.pendingAgentResponseIdsByPair.delete(
          agentResponsePairKey(pending.senderAgentId, pending.receiverAgentId),
        );
      } else {
        this.guardAgentReplyReceiverCancelling(request);
      }
    }
    if (!request.expectReply) {
      return {
        reply: { expectsReply: false },
        responseId: null,
        inReplyTo: resolvedResponseId,
      };
    }
    const pairKey = agentResponsePairKey(
      request.senderAgentId,
      request.receiverAgentId,
    );
    let responseId = this.pendingAgentResponseIdsByPair.get(pairKey);
    if (responseId === undefined) {
      responseId = randomUUID();
      this.pendingAgentResponseIdsByPair.set(pairKey, responseId);
      this.pendingAgentResponses.set(responseId, {
        responseId,
        epicId: request.epicId,
        senderAgentId: request.senderAgentId,
        receiverAgentId: request.receiverAgentId,
      });
    }
    return {
      reply: { expectsReply: true, responseId },
      responseId,
      inReplyTo: resolvedResponseId,
    };
  }

  private guardAgentReplyReceiverCancelling(
    request: SendAgentMessageRequest,
  ): void {
    if (
      this.getChat(request.epicId, request.receiverAgentId)?.runStatus !==
      "stopping"
    ) {
      return;
    }
    throw new StoreError(
      "RPC_ERROR",
      `agent.sendMessage: RECEIVER_CANCELLING - '${request.receiverAgentId}' is being stopped; the message was not delivered.`,
    );
  }

  private resolveAgentResponseId(responseId: string | null): string | null {
    if (
      responseId === null ||
      responseId.length < 4 ||
      this.pendingAgentResponses.has(responseId)
    ) {
      return responseId;
    }
    const matches = [...this.pendingAgentResponses.keys()].filter((candidate) =>
      candidate.startsWith(responseId),
    );
    if (matches.length === 1) {
      return matches[0] ?? responseId;
    }
    if (matches.length > 1) {
      throw new StoreError(
        "RPC_ERROR",
        `agent.sendMessage: AMBIGUOUS_RESPONSE_ID - '${responseId}' matches multiple pending responses; provide more characters.`,
      );
    }
    return responseId;
  }

  async withSerializedChatAction<T>(
    epicId: string,
    chatId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = chatKey(epicId, chatId);
    const previous = this.chatActionTails.get(key) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.chatActionTails.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.chatActionTails.get(key) === tail) {
        this.chatActionTails.delete(key);
      }
    }
  }

  setProviderSession(epicId: string, chatId: string, sessionId: string): void {
    const chat = this.getChat(epicId, chatId);
    if (chat === null) {
      return;
    }
    chat.providerSessionId = sessionId;
  }

  persistAssistant(
    epicId: string,
    chatId: string,
    assistant: AssistantMessage,
  ): void {
    const chat = this.getChat(epicId, chatId);
    if (chat === null) {
      return;
    }
    chat.messages = [...chat.messages, assistant];
    chat.updatedAt = assistant.timestamp;
  }

  appendChatEvent(epicId: string, chatId: string, event: ChatEvent): void {
    if (!this.recordChatEvent(epicId, chatId, event)) {
      return;
    }
    this.emitChatEvent(epicId, chatId, event);
  }

  private recordChatEvent(
    epicId: string,
    chatId: string,
    event: ChatEvent,
  ): boolean {
    const chat = this.getChat(epicId, chatId);
    if (chat === null) {
      return false;
    }
    chat.events = [...chat.events, event];
    chat.updatedAt = event.timestamp;
    return true;
  }

  private emitChatEvent(
    epicId: string,
    chatId: string,
    event: ChatEvent,
  ): void {
    this.emitChat(epicId, chatId, {
      kind: "eventAppended",
      hasBinaryPayload: false,
      epicId,
      chatId,
      event,
    });
  }

  reserveTurn(epicId: string, chatId: string): void {
    const key = chatKey(epicId, chatId);
    if (this.inflight.has(key)) {
      throw new StoreError(
        "E_INVALID_ARGUMENT",
        "A turn is already in progress",
      );
    }
    this.inflight.add(key);
  }

  releaseTurn(epicId: string, chatId: string): void {
    this.finishTurn(epicId, chatId);
  }

  activateTurn(args: {
    readonly epicId: string;
    readonly chatId: string;
    readonly turn: ChatActiveTurn;
  }): AbortSignal {
    const chat = this.getChat(args.epicId, args.chatId);
    const key = chatKey(args.epicId, args.chatId);
    const existing = this.abortByChat.get(key);
    if (existing !== undefined) {
      existing.abort();
    }
    const controller = new AbortController();
    this.abortByChat.set(key, controller);
    this.inflight.add(key);
    if (chat !== null) {
      chat.runStatus = "running";
      chat.activeTurn = args.turn;
      chat.turnInProgress = true;
    }
    return controller.signal;
  }

  requestStop(epicId: string, chatId: string): boolean {
    const chat = this.getChat(epicId, chatId);
    const controller = this.abortByChat.get(chatKey(epicId, chatId));
    if (controller === undefined) {
      return false;
    }
    if (chat !== null) {
      chat.runStatus = "stopping";
      if (chat.activeTurn !== null) {
        chat.activeTurn = {
          ...chat.activeTurn,
          status: "stopping",
          updatedAt: Date.now(),
        };
      }
    }
    controller.abort();
    return true;
  }

  finishTurn(epicId: string, chatId: string): void {
    const key = chatKey(epicId, chatId);
    this.abortByChat.delete(key);
    this.inflight.delete(key);
    const chat = this.getChat(epicId, chatId);
    if (chat !== null) {
      chat.runStatus = "idle";
      chat.activeTurn = null;
      chat.turnInProgress = false;
    }
    const waiters = this.idleWaiters.get(key);
    this.idleWaiters.delete(key);
    if (waiters !== undefined) {
      for (const waiter of waiters) {
        waiter();
      }
    }
  }

  waitForIdle(epicId: string, chatId: string): Promise<void> {
    const key = chatKey(epicId, chatId);
    if (!this.inflight.has(key)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const waiters = this.idleWaiters.get(key) ?? [];
      waiters.push(resolve);
      this.idleWaiters.set(key, waiters);
    });
  }

  subscribeChat(
    epicId: string,
    chatId: string,
    sink: ChatFrameSink,
  ): () => void {
    const key = chatKey(epicId, chatId);
    const sinks = this.chatSinks.get(key) ?? new Set<ChatFrameSink>();
    sinks.add(sink);
    this.chatSinks.set(key, sinks);
    return () => {
      sinks.delete(sink);
      if (sinks.size === 0) {
        this.chatSinks.delete(key);
      }
    };
  }

  emitChat(epicId: string, chatId: string, frame: unknown): void {
    const sinks = this.chatSinks.get(chatKey(epicId, chatId));
    if (sinks === undefined) {
      return;
    }
    for (const sink of sinks) {
      try {
        sink(frame);
      } catch {
        sinks.delete(sink);
      }
    }
    if (sinks.size === 0) {
      this.chatSinks.delete(chatKey(epicId, chatId));
    }
  }

  snapshotFrame(epicId: string, chat: StoredChat): unknown {
    return {
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId,
      chatId: chat.id,
      snapshot: {
        chat: {
          parentId: chat.parentId,
          id: chat.id,
          userId: chat.userId,
          hostId: chat.hostId,
          title: chat.title,
          createdAt: chat.createdAt,
          updatedAt: chat.updatedAt,
          isTitleEditedByUser: chat.isTitleEditedByUser,
          settings: chat.settings,
          activeSessionChain: null,
          claudePendingWakes: [],
          messages: chat.messages,
          events: chat.events,
          archivedAt: chat.archivedAt,
          pinnedUserProviderHandle: null,
          lastDeliveredRolesDigest: null,
        },
        access: {
          role: "owner",
          ownerUserId: LOCAL_USER_ID,
          canAct: true,
        },
        queue: queuedAgentQueueState(
          this.queuedAgentMessages.get(chatKey(epicId, chat.id)) ?? [],
        ),
        runStatus: chat.runStatus,
        activeTurn: chat.activeTurn,
        pendingApprovals: [],
        pendingInterviews: [],
        worktreeBinding: chat.worktreeBinding,
        missingWorktreePaths: this.missingWorktreePaths(chat.worktreeBinding),
        pendingFileEditApprovals: [],
        accumulatedFileChanges: [],
        backgroundItems: [],
        managedCommands: [],
        heldUpdates: [],
        turnInProgress: chat.turnInProgress,
      },
    };
  }

  dispose(): void {
    for (const controller of this.abortByChat.values()) {
      controller.abort();
    }
    this.abortByChat.clear();
    for (const [key, waiters] of this.idleWaiters) {
      this.inflight.delete(key);
      for (const waiter of waiters) {
        waiter();
      }
    }
    this.idleWaiters.clear();
    this.inflight.clear();
    this.queuedAgentMessages.clear();
    this.pendingAgentResponses.clear();
    this.pendingAgentResponseIdsByPair.clear();
    this.chatSinks.clear();
    for (const epic of this.epics.values()) {
      epic.doc.off("update", epic.syncChatMetadata);
      epic.artifactRooms.dispose();
      epic.awareness.destroy();
    }
    this.notificationsDoc.destroy();
  }

  private insertChat(
    epic: StoredEpic,
    request: {
      readonly chatId: string;
      readonly parentId: string | null;
      readonly hostId: string;
      readonly title: string;
      readonly settings: ChatRunSettings | null;
      readonly initialBinding: "epic" | "none";
      readonly isTitleEditedByUser: boolean;
    },
  ): StoredChat {
    const now = Date.now();
    const bindingKey = ownerBindingKey(epic.light.id, "chat", request.chatId);
    const worktreeBinding =
      this.worktreeBindings.get(bindingKey)?.binding ??
      (request.initialBinding === "epic"
        ? bindingFromWorkspaces(epic.workspaces, now)
        : null);
    const chat: StoredChat = {
      id: request.chatId,
      epicId: epic.light.id,
      parentId: request.parentId,
      hostId: request.hostId,
      userId: LOCAL_USER_ID,
      title: request.title,
      isTitleEditedByUser: request.isTitleEditedByUser,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settings: request.settings,
      messages: [],
      events: [],
      runStatus: "idle",
      activeTurn: null,
      turnInProgress: false,
      worktreeBinding,
      providerSessionId: null,
    };
    epic.chats.set(chat.id, chat);
    if (worktreeBinding !== null) {
      this.worktreeBindings.set(bindingKey, {
        epicId: epic.light.id,
        ownerId: chat.id,
        ownerKind: "chat",
        binding: worktreeBinding,
      });
    }
    epic.light.updatedAt = now;
    seedChatInDoc(epic.doc, chat);
    return chat;
  }

  private hydrateLocalGuiChat(
    epic: StoredEpic,
    chatId: string,
  ): StoredChat | null {
    const existing = epic.chats.get(chatId);
    if (existing !== undefined) {
      return existing;
    }
    const chats = epic.doc.getMap<unknown>("epic").get("chats");
    const entry = chats instanceof Y.Map ? chats.get(chatId) : undefined;
    if (!(entry instanceof Y.Map)) {
      return null;
    }
    const parsed = chatSchema.safeParse(entry.toJSON());
    if (
      !parsed.success ||
      parsed.data.id !== chatId ||
      parsed.data.hostId !== this.hostId
    ) {
      return null;
    }
    const persisted = parsed.data;
    const storedBinding = this.worktreeBindings.get(
      ownerBindingKey(epic.light.id, "chat", chatId),
    );
    const chat: StoredChat = {
      id: persisted.id,
      epicId: epic.light.id,
      parentId: persisted.parentId,
      hostId: persisted.hostId,
      userId: persisted.userId,
      title: persisted.title,
      isTitleEditedByUser: persisted.isTitleEditedByUser,
      createdAt: persisted.createdAt,
      updatedAt: persisted.updatedAt,
      archivedAt: persisted.archivedAt,
      settings: persisted.settings,
      messages: [...persisted.messages],
      events: [...persisted.events],
      runStatus: "idle",
      activeTurn: null,
      turnInProgress: false,
      worktreeBinding:
        storedBinding?.binding ??
        bindingFromWorkspaces(epic.workspaces, persisted.createdAt),
      providerSessionId: persisted.activeSessionChain?.sessionId ?? null,
    };
    epic.chats.set(chat.id, chat);
    return chat;
  }

  private async bindAgentWorkspace(
    epicId: string,
    agentId: string,
    workspace: NonNullable<CreateAgentWorkspace>,
  ): Promise<void> {
    if (workspace.entries.length === 0) {
      return;
    }
    await this.createWorktree({
      epicId,
      ownerId: agentId,
      ownerKind: "chat",
      entries: workspace.entries.map((entry, index) => {
        const workspacePath = entry.workspacePath ?? entry.path;
        const base = {
          workspacePath,
          repoIdentifier: null,
          isPrimary: index === 0,
        };
        return entry.path === workspacePath
          ? { ...base, kind: "local" as const }
          : {
              ...base,
              kind: "import" as const,
              worktreePath: entry.path,
            };
      }),
    });
  }

  private agentFolderContext(
    epic: StoredEpic,
    record: AgentListRecord,
  ): { readonly folderPaths: string[]; readonly isWorktree: boolean } {
    const ownerKind = record.surface === "tui" ? "terminal-agent" : "chat";
    const binding = record.isLocal
      ? bindingForOwner(
          this.worktreeBindings,
          epic,
          epic.light.id,
          ownerKind,
          record.id,
        )
      : null;
    if (binding !== null && binding.entries.length > 0) {
      return {
        folderPaths: dedupeNonEmptyStrings(
          binding.entries.map(
            (entry) => entry.worktreePath ?? entry.workspacePath,
          ),
        ),
        isWorktree: binding.entries.every((entry) => entry.mode === "worktree"),
      };
    }
    if (record.surface === "tui") {
      return {
        folderPaths: dedupeNonEmptyStrings(record.workspaceFolders),
        isWorktree: false,
      };
    }
    return {
      folderPaths: record.isLocal
        ? dedupeNonEmptyStrings(
            epic.workspaces.map((workspace) => workspace.workspacePath),
          )
        : [],
      isWorktree: false,
    };
  }

  private async inheritAgentWorkspace(
    epicId: string,
    senderAgentId: string,
    agentId: string,
  ): Promise<void> {
    try {
      const parent = this.getBinding({
        epicId,
        ownerId: senderAgentId,
        ownerKind: "chat",
      }).binding;
      if (parent === null || parent.entries.length === 0) {
        return;
      }
      const inheritedEntries = parent.entries.filter(
        (entry) => entry.workspacePath.trim().length > 0,
      );
      if (inheritedEntries.length === 0) {
        return;
      }
      await this.createWorktree({
        epicId,
        ownerId: agentId,
        ownerKind: "chat",
        entries: inheritedEntries.map((entry) => {
          const base = {
            workspacePath: entry.workspacePath,
            repoIdentifier: entry.repoIdentifier,
            isPrimary: entry.isPrimary,
          };
          return entry.worktreePath === null
            ? { ...base, kind: "local" as const }
            : {
                ...base,
                kind: "import" as const,
                worktreePath: entry.worktreePath,
              };
        }),
      });
    } catch {
      // Signed hosts treat inherited workspace state as a best-effort default:
      // the child record remains usable even when a stale parent binding can no
      // longer be imported. Explicit workspace requests still fail the RPC.
    }
  }

  private guardOwnerBindingMutation(owner: OwnerBindingRef): void {
    if (
      owner.ownerKind !== "terminal-agent" &&
      this.inflight.has(chatKey(owner.epicId, owner.ownerId))
    ) {
      throw new StoreError(
        "WORKTREE_REBIND_BLOCKED",
        `Stop the active ${owner.ownerKind} run before rebinding its worktree.`,
      );
    }
  }

  private async withSerializedOwnerBindingMutation<T>(
    owner: OwnerBindingRef,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = ownerBindingKey(owner.epicId, owner.ownerKind, owner.ownerId);
    const previous =
      this.ownerBindingMutationTails.get(key) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.ownerBindingMutationTails.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.ownerBindingMutationTails.get(key) === tail) {
        this.ownerBindingMutationTails.delete(key);
      }
    }
  }

  private storeOwnerBinding(
    owner: OwnerBindingRef,
    binding: WorktreeBinding,
  ): void {
    this.worktreeBindings.set(
      ownerBindingKey(owner.epicId, owner.ownerKind, owner.ownerId),
      {
        epicId: owner.epicId,
        ownerId: owner.ownerId,
        ownerKind: owner.ownerKind,
        binding,
      },
    );
    if (owner.ownerKind !== "chat") {
      return;
    }
    const chat = this.getChat(owner.epicId, owner.ownerId);
    if (chat === null) {
      return;
    }
    chat.worktreeBinding = binding;
    this.emitChat(owner.epicId, owner.ownerId, {
      kind: "worktreeStateChanged",
      hasBinaryPayload: false,
      epicId: owner.epicId,
      chatId: owner.ownerId,
      worktreeBinding: binding,
      missingWorktreePaths: this.missingWorktreePaths(binding),
    });
  }

  private applyInitialMessage(
    chat: StoredChat,
    initial: CreateChatInitialMessage,
  ): PendingTurn {
    const now = Date.now();
    chat.messages = [
      userMessage(initial.messageId, initial.sender, initial.content, now),
    ];
    chat.updatedAt = now;
    this.reserveTurn(chat.epicId, chat.id);
    return {
      epicId: chat.epicId,
      chatId: chat.id,
      userMessageId: initial.messageId,
      settings: initial.settings,
    };
  }

  private toTaskLight(
    epic: StoredEpic,
    light: EpicLight,
  ): ListTasksResponse["tasks"][number] {
    return {
      epic: {
        light,
        permission: {
          role: "owner",
          accessType: "direct",
          userId: LOCAL_USER_ID,
          grantedBy: LOCAL_USER_ID,
          grantedAt: light.createdAt,
        },
        repos: epic.repos,
        workspaces: epic.workspaces,
        roomInfo: {
          roomId: epic.light.id,
          webSocketUrl: "ws://127.0.0.1:1/unused",
          token: null,
        },
      },
      phase: null,
      pinned: false,
    };
  }
}

export class StoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

type ResolvedGuiAgentSettings = {
  readonly settings: ChatRunSettings;
  readonly warnings: string[];
};

function resolveGuiAgentSettings(
  request: CreateAgentRequestV30,
  sender: StoredChat,
): ResolvedGuiAgentSettings {
  if (request.surface === "tui") {
    throw new StoreError(
      "E_HOST_UNSUPPORTED",
      "agent.create: TUI agents are not supported by this local host yet.",
    );
  }
  if (request.surface === "gui" && request.harnessId === null) {
    throw new StoreError(
      "RPC_ERROR",
      "agent.create: harnessId is required when surface is set.",
    );
  }
  const inheritedHarness = sender.settings?.harnessId ?? null;
  const requestedHarness = request.harnessId ?? inheritedHarness;
  if (requestedHarness === null) {
    throw new StoreError(
      "RPC_ERROR",
      "agent.create: sender gui agent does not have chat run settings to inherit.",
    );
  }
  const parsedHarness = guiHarnessIdSchema.safeParse(requestedHarness);
  if (!parsedHarness.success) {
    throw new StoreError(
      "RPC_ERROR",
      `agent.create: harness '${requestedHarness}' does not support gui surface.`,
    );
  }
  if (!isLocalGuiHarnessId(parsedHarness.data)) {
    throw new StoreError(
      "E_HOST_UNSUPPORTED",
      `agent.create: gui harness '${parsedHarness.data}' is not supported by this local host.`,
    );
  }
  const harnessId = parsedHarness.data;
  const sameHarness = inheritedHarness === harnessId;
  const resolvedModel = resolveAgentModel(
    request.model,
    sameHarness ? (sender.settings?.model ?? null) : null,
    harnessId,
  );
  const permissionMode =
    request.permissionMode ??
    (sender.settings === null ? null : sender.settings.permissionMode);
  if (permissionMode === null) {
    throw new StoreError(
      "RPC_ERROR",
      "agent.create: sender gui agent does not have chat run settings to inherit permission mode.",
    );
  }
  const warnings: string[] = [];
  let reasoningEffort =
    request.reasoningEffort ??
    (sameHarness ? (sender.settings?.reasoningEffort ?? null) : null);
  if (
    request.reasoningEffort !== null &&
    (resolvedModel.catalogModel === null ||
      !resolvedModel.catalogModel.supportedReasoningEfforts.some(
        (effort) => effort.id === request.reasoningEffort,
      ))
  ) {
    warnings.push(
      `reasoningEffort '${request.reasoningEffort}' is not available for model '${resolvedModel.model}' and was ignored.`,
    );
    reasoningEffort = null;
  }
  if (request.fastMode === true) {
    warnings.push(
      `fastMode is not available for model '${resolvedModel.model}' and was ignored.`,
    );
  }
  return {
    settings: {
      harnessId,
      model: resolvedModel.model,
      permissionMode,
      reasoningEffort,
      serviceTier: null,
      agentMode: "regular",
      profileId: resolveAgentProfileId(
        request.profileSelection,
        sameHarness ? sender.settings : null,
        harnessId,
      ),
    },
    warnings,
  };
}

function resolveAgentModel(
  requested: string | null,
  inherited: string | null,
  harnessId: LocalGuiHarnessId,
): { readonly model: string; readonly catalogModel: LocalGuiModel | null } {
  const catalog = localGuiModelsFor(harnessId);
  if (requested !== null && requested.length > 0) {
    const catalogModel = catalog.find((model) => model.slug === requested);
    if (catalogModel === undefined) {
      throw new StoreError(
        "RPC_ERROR",
        `agent.create: model '${requested}' is not available for harness '${harnessId}'.`,
      );
    }
    return { model: catalogModel.slug, catalogModel };
  }
  if (requested === null && inherited !== null && inherited.length > 0) {
    return {
      model: inherited,
      catalogModel:
        catalog.find((candidate) => candidate.slug === inherited) ?? null,
    };
  }
  const catalogModel = catalog[0];
  if (catalogModel === undefined) {
    throw new StoreError(
      "E_HOST_UNSUPPORTED",
      `agent.create: no models are available for harness '${harnessId}'.`,
    );
  }
  return { model: catalogModel.slug, catalogModel };
}

function resolveAgentProfileId(
  selection: ProfileSelection,
  senderSettings: ChatRunSettings | null,
  harnessId: LocalGuiHarnessId,
): string | null {
  if (selection.kind === "profile") {
    assertLocalProfileAvailable(harnessId, selection.profileId);
    return selection.profileId;
  }
  if (selection.kind === "inherit_sender") {
    return senderSettings?.profileId ?? null;
  }
  return null;
}

export function projectStoredEpicLight(epic: StoredEpic): EpicLight {
  const root = epic.doc.getMap<unknown>("epic");
  const title = root.get("title");
  const updatedAt = root.get("updatedAt");
  return {
    ...epic.light,
    title: typeof title === "string" ? title : epic.light.title,
    updatedAt: typeof updatedAt === "number" ? updatedAt : epic.light.updatedAt,
    ...artifactCountsFromDoc(epic.doc),
  };
}

function chatKey(epicId: string, chatId: string): string {
  return `${epicId}:${chatId}`;
}

function normalizedRepoIdentifier(identifier: TaskRepoIdentifier): string {
  return `${identifier.owner}/${identifier.repo}`.toLowerCase();
}

function archiveRecordMissing(epicId: string, chatId: string): StoreError {
  return new StoreError(
    "RPC_ERROR",
    `RECORD_NOT_FOUND: epic.setChatArchived found no chat or terminal-agent '${chatId}' in epic '${epicId}'.`,
  );
}

function resolveArchiveRecord(
  epic: StoredEpic,
  recordId: string,
): ArchiveRecord | null {
  const root = epic.doc.getMap<unknown>("epic");
  const chats = root.get("chats");
  const chatEntry = chats instanceof Y.Map ? chats.get(recordId) : undefined;
  if (chatEntry !== undefined) {
    if (!(chatEntry instanceof Y.Map)) {
      throw new StoreError(
        "RPC_ERROR",
        `Chat '${recordId}' is corrupt in epic doc`,
      );
    }
    return { entry: chatEntry, chat: epic.chats.get(recordId) ?? null };
  }
  const tuiAgents = root.get("tuiAgents");
  const tuiEntry =
    tuiAgents instanceof Y.Map ? tuiAgents.get(recordId) : undefined;
  if (tuiEntry === undefined) {
    return null;
  }
  if (!(tuiEntry instanceof Y.Map)) {
    throw new StoreError(
      "RPC_ERROR",
      `Terminal-agent '${recordId}' is corrupt in epic doc`,
    );
  }
  return { entry: tuiEntry, chat: null };
}

function archiveMissingHostMessage(chatId: string): string {
  return (
    `TARGET_NOT_LOCAL: epic.setChatArchived refused to archive agent '${chatId}' - ` +
    "its record carries no usable host id, so which host runs it cannot be " +
    "determined from here. Only the host that runs an agent can observe " +
    "whether it is still working, so archiving it from here could hide a " +
    "live run. Archive it from its own host instead."
  );
}

function archiveBusyMessage(chatId: string): string {
  return (
    `AGENT_BUSY: epic.setChatArchived refused to archive agent '${chatId}' - ` +
    "nothing was changed. Archiving would force the agent inactive in every " +
    "list while its run kept going. A turn is in progress, or one is about " +
    "to start. Stopping the agent clears a turn - but NOT a detached subagent, " +
    "workflow or scheduled wake, which all survive a stop. Wait for it to go " +
    "idle - or stop the agent - and retry."
  );
}

function archiveNotLocalMessage(
  chatId: string,
  chatHostId: string,
  localHostId: string,
): string {
  return (
    `TARGET_NOT_LOCAL: epic.setChatArchived refused to archive agent '${chatId}' - ` +
    `it runs on host '${chatHostId}', not on this host ('${localHostId}'). ` +
    "Only the host that runs an agent can observe whether it is still working, " +
    "so archiving it from here could hide a live run. Archive it from its own " +
    "host instead."
  );
}

function assertLocalProfileAvailable(
  harnessId: ChatRunSettings["harnessId"],
  profileId: string,
): void {
  const providerId = providerIdForHarness(harnessId);
  if (providerId === null) {
    throw new StoreError(
      "RPC_ERROR",
      `Harness "${harnessId}" does not support profiles.`,
    );
  }
  if (profileId === "ambient") {
    return;
  }
  if (providerId !== "claude-code" && providerId !== "codex") {
    throw new StoreError(
      "RPC_ERROR",
      `Provider "${providerId}" does not support managed profiles.`,
    );
  }
  throw new StoreError(
    "RPC_ERROR",
    `No profile "${profileId}" is registered for provider "${providerId}".`,
  );
}

function providerIdForHarness(
  harnessId: ChatRunSettings["harnessId"],
): string | null {
  if (harnessId === "claude") {
    return "claude-code";
  }
  if (harnessId === "huggingface") {
    return null;
  }
  return harnessId;
}

function bindingFromWorkspaces(
  workspaces: readonly UserTaskWorkspace[],
  createdAt: number,
): WorktreeBinding | null {
  if (workspaces.length === 0) {
    return null;
  }
  return {
    workspaceMode: "inherit",
    entries: workspaces.map((workspace, index) =>
      localEntry(workspace.workspacePath, index === 0, createdAt),
    ),
  };
}

function localEntry(
  workspacePath: string,
  isPrimary: boolean,
  createdAt: number,
): WorktreeBindingEntry {
  return {
    workspacePath,
    mode: "local",
    repoIdentifier: null,
    worktreePath: null,
    branch: null,
    isPrimary,
    isImported: false,
    setupState: "not_required",
    setupTerminalSessionId: null,
    setupExitCode: null,
    setupFailedAt: null,
    createdAt,
    ownedSubmodules: [],
  };
}

function isFullyLocalEntry(entry: WorktreeBindingEntry): boolean {
  return (
    entry.mode === "local" &&
    entry.worktreePath === null &&
    entry.branch === null &&
    !entry.isImported &&
    entry.setupState === "not_required" &&
    entry.setupTerminalSessionId === null &&
    entry.setupExitCode === null &&
    entry.setupFailedAt === null
  );
}

function enforceSinglePrimary(
  entries: readonly WorktreeBindingEntry[],
): WorktreeBindingEntry[] {
  let hasPrimary = false;
  const normalized = entries.map((entry) => {
    if (!entry.isPrimary) {
      return entry;
    }
    if (!hasPrimary) {
      hasPrimary = true;
      return entry;
    }
    return { ...entry, isPrimary: false };
  });
  if (hasPrimary) {
    return normalized;
  }
  return normalized.map((entry, index) =>
    index === 0 ? { ...entry, isPrimary: true } : entry,
  );
}

function mergeOwnerBinding(
  current: WorktreeBinding | null,
  replacements: readonly WorktreeBindingEntry[],
  touchedWorkspacePaths: readonly string[] | undefined,
): WorktreeBinding {
  if (replacements.length === 0) {
    return current ?? { entries: [] };
  }
  const touched = new Set(
    touchedWorkspacePaths ?? replacements.map((entry) => entry.workspacePath),
  );
  const replacementHasPrimary = replacements.some((entry) => entry.isPrimary);
  const survivors = (current?.entries ?? [])
    .filter((entry) => !touched.has(entry.workspacePath))
    .map((entry) =>
      replacementHasPrimary && entry.isPrimary
        ? { ...entry, isPrimary: false }
        : entry,
    );
  return { entries: enforceSinglePrimary([...survivors, ...replacements]) };
}

function ownerBindingKey(
  epicId: string,
  ownerKind: WorktreeBindingOwnerKind,
  ownerId: string,
): string {
  return `${epicId}:${ownerKind}:${ownerId}`;
}

function bindingForOwner(
  bindings: ReadonlyMap<string, StoredOwnerBinding>,
  epic: StoredEpic | null,
  epicId: string,
  ownerKind: WorktreeBindingOwnerKind,
  ownerId: string,
): WorktreeBinding | null {
  const stored = bindings.get(ownerBindingKey(epicId, ownerKind, ownerId));
  if (stored !== undefined) {
    return stored.binding;
  }
  return ownerKind === "chat"
    ? (epic?.chats.get(ownerId)?.worktreeBinding ?? null)
    : null;
}

function folderlessCwdForEpic(epicId: string): string {
  const configuredHome = process.env.HOME;
  const home =
    configuredHome === undefined || configuredHome.length === 0
      ? homedir()
      : configuredHome;
  const encodedEpicId = encodeURIComponent(epicId).replaceAll(".", "%2E");
  return join(
    home,
    ".traycer",
    "epics",
    encodedEpicId.length === 0 ? "%00" : encodedEpicId,
  );
}

function ensureFolderlessCwdForEpic(epicId: string): string {
  const cwd = folderlessCwdForEpic(epicId);
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  return cwd;
}

function cwdFromBinding(binding: WorktreeBinding | null): string | null {
  if (binding === null || binding.entries[0] === undefined) {
    return null;
  }
  const entry =
    binding.entries.find((candidate) => candidate.isPrimary) ??
    binding.entries[0];
  return entry.worktreePath ?? entry.workspacePath;
}

function dedupeNonEmptyStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function worktreeMissingMessage(
  missingWorkspacePaths: readonly string[],
): string {
  const paths = missingWorkspacePaths.join(", ");
  return missingWorkspacePaths.length === 1
    ? `A bound folder is missing on disk: ${paths}. Restore it, re-bind to another folder, or remove it to continue.`
    : `Bound folders are missing on disk: ${paths}. Restore them, re-bind, or remove them to continue.`;
}

function stringArrayFromYjs(value: unknown): string[] {
  const values = value instanceof Y.Array ? value.toArray() : value;
  return Array.isArray(values)
    ? values.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function agentRecordField(value: unknown, field: string): unknown {
  if (value instanceof Y.Map) {
    return value.get(field);
  }
  return typeof value === "object" && value !== null
    ? Reflect.get(value, field)
    : undefined;
}

function invalidAgentListRecord(
  surface: "GUI" | "TUI",
  agentId: string,
): StoreError {
  return new StoreError(
    "RPC_ERROR",
    `agent.list: ${surface} agent '${agentId}' record is invalid.`,
  );
}

function guiHarnessIdFromEntry(
  entry: Y.Map<unknown>,
): ListAgentsResponse["agents"][number]["harnessId"] {
  const settings = entry.get("settings");
  const harnessId =
    settings instanceof Y.Map
      ? settings.get("harnessId")
      : typeof settings === "object" && settings !== null
        ? Reflect.get(settings, "harnessId")
        : null;
  const parsed = guiHarnessIdSchemaV60.safeParse(harnessId);
  return parsed.success ? parsed.data : null;
}

function canSendAgentMessages(
  record: AgentListRecord,
  sameUser: boolean,
): boolean {
  return (
    sameUser &&
    record.isLocal &&
    (record.surface === "gui" || record.harnessId === "claude")
  );
}

function canReadAgentTranscript(
  record: AgentListRecord,
  sameUser: boolean,
): boolean {
  return sameUser && (record.surface === "gui" || record.isLocal);
}

function selectorRow(
  hostId: string,
  ownerKind: WorktreeBindingOwnerKind,
  ownerId: string,
  entry: WorktreeBindingEntry,
): unknown {
  const runningDir = entry.worktreePath ?? entry.workspacePath;
  const present = directoryExists(runningDir);
  return {
    hostId,
    runningDir,
    workspacePath: entry.workspacePath,
    worktreePath: entry.worktreePath,
    mode: entry.mode,
    isGitRepo: present && isGitRepo(runningDir),
    repoIdentifier: entry.repoIdentifier,
    branch: entry.branch,
    isPrimary: entry.isPrimary,
    isImported: entry.isImported,
    setupState: entry.setupState,
    disabledReason: present ? null : "missing_worktree_path",
    sources:
      ownerId.length === 0
        ? []
        : [
            {
              ownerKind,
              ownerId,
              workspacePath: entry.workspacePath,
              isPrimary: entry.isPrimary,
              mode: entry.mode,
            },
          ],
    isGitResolvePending: false,
  };
}

function seedEpicDoc(doc: Y.Doc, light: EpicLight): void {
  const epic = doc.getMap("epic");
  epic.set("id", light.id);
  epic.set("title", light.title);
  epic.set("isTitleEditedByUser", false);
  epic.set("createdAt", light.createdAt);
  epic.set("updatedAt", light.updatedAt);
  epic.set("artifacts", new Y.Map());
  epic.set("deletedArtifacts", new Y.Map());
  epic.set("chats", new Y.Map());
  epic.set("tuiAgents", new Y.Map());
}

function requireArtifact(
  epics: ReadonlyMap<string, StoredEpic>,
  epicId: string,
  artifactId: string,
): { readonly epic: StoredEpic; readonly entry: Y.Map<unknown> } {
  const epic = epics.get(epicId);
  if (epic === undefined) {
    throw new StoreError("E_INVALID_ARGUMENT", `Unknown epic ${epicId}`);
  }
  const artifacts = epic.doc.getMap<unknown>("epic").get("artifacts");
  const entry =
    artifacts instanceof Y.Map ? artifacts.get(artifactId) : undefined;
  if (!(entry instanceof Y.Map)) {
    throw new StoreError(
      "RPC_ERROR",
      `Artifact '${artifactId}' not found in epic doc`,
    );
  }
  return { epic, entry };
}

function requireChat(
  epics: ReadonlyMap<string, StoredEpic>,
  epicId: string,
  chatId: string,
): {
  readonly epic: StoredEpic;
  readonly chat: StoredChat;
  readonly entry: Y.Map<unknown>;
} {
  const record = requireChatRecord(epics, epicId, chatId);
  if (record.chat === null) {
    throw new StoreError("RPC_ERROR", `Chat '${chatId}' not found in epic doc`);
  }
  return { epic: record.epic, chat: record.chat, entry: record.entry };
}

function requireChatRecord(
  epics: ReadonlyMap<string, StoredEpic>,
  epicId: string,
  chatId: string,
): ChatRecord {
  if (!epics.has(epicId)) {
    throw new StoreError("E_INVALID_ARGUMENT", `Unknown epic ${epicId}`);
  }
  const record = findChatRecord(epics, epicId, chatId);
  if (record === null) {
    throw new StoreError("RPC_ERROR", `Chat '${chatId}' not found in epic doc`);
  }
  return record;
}

function findChatRecord(
  epics: ReadonlyMap<string, StoredEpic>,
  epicId: string,
  chatId: string,
): ChatRecord | null {
  const epic = epics.get(epicId);
  if (epic === undefined) {
    return null;
  }
  const chats = epic.doc.getMap<unknown>("epic").get("chats");
  const entry = chats instanceof Y.Map ? chats.get(chatId) : undefined;
  if (entry === undefined) {
    return null;
  }
  if (!(entry instanceof Y.Map)) {
    throw new StoreError(
      "RPC_ERROR",
      `Chat '${chatId}' is corrupt in epic doc`,
    );
  }
  return { epic, entry, chat: epic.chats.get(chatId) ?? null };
}

function agentChatRecord(
  epic: StoredEpic,
  agentId: string,
): AgentChatRecord | null {
  const chats = epic.doc.getMap<unknown>("epic").get("chats");
  const entry = chats instanceof Y.Map ? chats.get(agentId) : undefined;
  if (!(entry instanceof Y.Map)) {
    return null;
  }
  const hostId = entry.get("hostId");
  const userId = entry.get("userId");
  if (typeof hostId !== "string" || typeof userId !== "string") {
    return null;
  }
  const title = entry.get("title");
  const settings = chatRunSettingsFromEntry(entry);
  return {
    chat: epic.chats.get(agentId) ?? null,
    hostId,
    userId,
    title: typeof title === "string" && title.length > 0 ? title : null,
    harnessId: settings?.harnessId ?? null,
  };
}

function resolveAgentId(epic: StoredEpic, agentId: string): string {
  const root = epic.doc.getMap<unknown>("epic");
  const chats = root.get("chats");
  const tuiAgents = root.get("tuiAgents");
  const ids = new Set<string>();
  if (chats instanceof Y.Map) {
    for (const id of chats.keys()) {
      ids.add(id);
    }
  }
  if (tuiAgents instanceof Y.Map) {
    for (const id of tuiAgents.keys()) {
      ids.add(id);
    }
  }
  if (ids.has(agentId) || agentId.length < 4) {
    return agentId;
  }
  const matches = [...ids].filter((candidate) => candidate.startsWith(agentId));
  if (matches.length === 1) {
    return matches[0] ?? agentId;
  }
  if (matches.length > 1) {
    throw new StoreError(
      "RPC_ERROR",
      `agent.sendMessage: AMBIGUOUS_AGENT_ID - '${agentId}' matches multiple agents; provide more characters.`,
    );
  }
  return agentId;
}

function agentResponsePairKey(
  senderAgentId: string,
  receiverAgentId: string,
): string {
  return `${senderAgentId} ${receiverAgentId}`;
}

function chatRunSettingsFromEntry(
  entry: Y.Map<unknown>,
): ChatRunSettings | null {
  const stored = entry.get("settings");
  if (stored === undefined || stored === null) {
    return null;
  }
  const value = stored instanceof Y.Map ? stored.toJSON() : stored;
  const parsed = chatRunSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function purgeRoleClaimsForChat(epicMap: Y.Map<unknown>, chatId: string): void {
  const roleClaims = epicMap.get("roleClaims");
  if (!(roleClaims instanceof Y.Map)) {
    return;
  }
  for (const [claimId, value] of roleClaims) {
    if (value instanceof Y.Map && value.get("agentId") === chatId) {
      roleClaims.delete(claimId);
    }
  }
}

type ArtifactKind = CreateArtifactRequest["artifactType"];

type ArtifactCounts = Pick<
  EpicLight,
  "ticketCount" | "specCount" | "storyCount" | "reviewCount"
>;

type ArtifactBodyRef = {
  readonly artifactId: string;
  readonly roomId: string;
};

type ArtifactDeletionPlan = {
  readonly artifactId: string;
  readonly tombstone: Y.Map<unknown>;
  readonly body: ArtifactBodyRef | null;
};

function artifactCountsFromDoc(doc: Y.Doc): ArtifactCounts {
  let ticketCount = 0;
  let specCount = 0;
  let storyCount = 0;
  let reviewCount = 0;
  const artifacts = doc.getMap<unknown>("epic").get("artifacts");
  if (!(artifacts instanceof Y.Map)) {
    return { ticketCount, specCount, storyCount, reviewCount };
  }
  for (const value of artifacts.values()) {
    switch (artifactKindForCount(value)) {
      case "ticket":
        ticketCount += 1;
        break;
      case "spec":
        specCount += 1;
        break;
      case "story":
        storyCount += 1;
        break;
      case "review":
        reviewCount += 1;
        break;
      case null:
        break;
    }
  }
  return { ticketCount, specCount, storyCount, reviewCount };
}

function artifactKindForCount(value: unknown): ArtifactKind | null {
  let kind: unknown;
  if (value instanceof Y.Map) {
    kind = value.get("type") ?? value.get("kind");
  } else if (typeof value === "object" && value !== null) {
    kind = Reflect.get(value, "type") ?? Reflect.get(value, "kind");
  }
  if (
    kind === "ticket" ||
    kind === "spec" ||
    kind === "story" ||
    kind === "review"
  ) {
    return kind;
  }
  return null;
}

function validateArtifactParent(
  artifacts: Y.Map<unknown>,
  artifactId: string,
  entry: Y.Map<unknown>,
  newParentId: string | null,
): void {
  if (newParentId === null) {
    return;
  }
  if (!(artifacts.get(newParentId) instanceof Y.Map)) {
    const kind = entry.get("kind");
    throw new StoreError(
      "RPC_ERROR",
      `Parent artifact '${newParentId}' does not exist in this epic for ${String(kind)}`,
    );
  }
  const visited = new Set<string>();
  let ancestorId: string | null = newParentId;
  while (ancestorId !== null && !visited.has(ancestorId)) {
    if (ancestorId === artifactId) {
      throw new StoreError(
        "RPC_ERROR",
        `Circular parent reference detected: moving '${artifactId}' would make it an ancestor of its proposed parent`,
      );
    }
    visited.add(ancestorId);
    const ancestor = artifacts.get(ancestorId);
    if (!(ancestor instanceof Y.Map)) {
      break;
    }
    const parentId = ancestor.get("parentId");
    ancestorId = typeof parentId === "string" ? parentId : null;
  }
}

function artifactKindFrom(value: unknown): ArtifactKind | null {
  if (!(value instanceof Y.Map)) {
    return null;
  }
  const kind = value.get("kind");
  if (
    kind === "spec" ||
    kind === "ticket" ||
    kind === "story" ||
    kind === "review"
  ) {
    return kind;
  }
  return null;
}

function descendantArtifactIds(
  artifacts: Y.Map<unknown>,
  rootArtifactId: string,
): string[] {
  const queue = [rootArtifactId];
  const seen = new Set(queue);
  const descendants: string[] = [];
  while (queue.length > 0) {
    const parentId = queue.shift();
    if (parentId === undefined) {
      break;
    }
    for (const [artifactId, value] of artifacts) {
      if (!(value instanceof Y.Map) || value.get("parentId") !== parentId) {
        continue;
      }
      if (seen.has(artifactId)) {
        continue;
      }
      seen.add(artifactId);
      descendants.push(artifactId);
      queue.push(artifactId);
    }
  }
  return descendants.reverse();
}

function planLiveArtifactDeletion(
  artifacts: Y.Map<unknown>,
  artifactId: string,
): ArtifactDeletionPlan | null {
  const entry = artifacts.get(artifactId);
  if (!(entry instanceof Y.Map)) {
    return null;
  }
  const body = artifactBodyFromIntegratedEntry(entry, artifactId);
  const tombstone = deletedArtifactTombstone(entry, artifactId);
  return {
    artifactId,
    tombstone,
    body,
  };
}

function deletedArtifactTombstone(
  entry: Y.Map<unknown>,
  artifactId: string,
): Y.Map<unknown> {
  const kind = artifactKindFrom(entry);
  if (kind === null) {
    throw new StoreError(
      "RPC_ERROR",
      `Artifact '${artifactId}' has no kind in epic doc`,
    );
  }
  const storedId = entry.get("id");
  const title = entry.get("title");
  const roomId = entry.get("artifactRoomId");
  const tombstone = new Y.Map<unknown>();
  tombstone.set("kind", kind);
  tombstone.set(
    "id",
    typeof storedId === "string" && storedId.length > 0 ? storedId : artifactId,
  );
  tombstone.set("title", typeof title === "string" ? title : "");
  tombstone.set(
    "artifactRoomId",
    typeof roomId === "string" && roomId.length > 0 ? roomId : null,
  );
  tombstone.set("deletedAt", new Date().toISOString());
  if (kind === "ticket" || kind === "story") {
    tombstone.set("status", entry.get("status"));
  }
  return tombstone;
}

function artifactBodyFromIntegratedEntry(
  entry: Y.Map<unknown>,
  artifactId: string,
): ArtifactBodyRef | null {
  const roomId = entry.get("artifactRoomId");
  if (typeof roomId !== "string" || roomId.length === 0) {
    return null;
  }
  return { artifactId, roomId };
}

function siblingFolderNames(
  artifacts: Y.Map<unknown>,
  parentId: string | null,
): Set<string> {
  const names = new Set<string>();
  for (const value of artifacts.values()) {
    if (!(value instanceof Y.Map)) {
      continue;
    }
    if ((value.get("parentId") ?? null) !== parentId) {
      continue;
    }
    const folderName = value.get("folderName");
    if (typeof folderName === "string") {
      names.add(folderName);
    }
  }
  return names;
}

function uniqueArtifactFolderName(
  title: string,
  siblings: Set<string>,
): string {
  const base = artifactFolderSlug(title);
  if (!siblings.has(base)) {
    return base;
  }
  for (let suffixNumber = 2; ; suffixNumber += 1) {
    const suffix = `-${suffixNumber}`;
    const prefix = trimHyphenEdges(base.slice(0, 64 - suffix.length));
    const candidate = `${prefix.length === 0 ? "untitled" : prefix}${suffix}`;
    if (!siblings.has(candidate)) {
      return candidate;
    }
  }
}

function artifactFolderSlug(title: string): string {
  const normalized = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  const truncated = trimHyphenEdges(normalized).slice(0, 64);
  const slug = trimHyphenEdges(truncated);
  return slug.length === 0 ? "untitled" : slug;
}

function trimHyphenEdges(value: string): string {
  return value.replace(/^-+|-+$/g, "");
}

function seedChatInDoc(doc: Y.Doc, chat: StoredChat): void {
  const epic = doc.getMap("epic");
  const chats = epic.get("chats");
  if (!(chats instanceof Y.Map)) {
    return;
  }
  const entry = new Y.Map<unknown>();
  entry.set("id", chat.id);
  entry.set("title", chat.title);
  entry.set("parentId", chat.parentId);
  entry.set("createdAt", chat.createdAt);
  entry.set("updatedAt", chat.updatedAt);
  entry.set("archivedAt", chat.archivedAt);
  entry.set("userId", chat.userId);
  entry.set("hostId", chat.hostId);
  entry.set("isTitleEditedByUser", chat.isTitleEditedByUser);
  if (chat.settings !== null) {
    entry.set("settings", createTypedMap(chat.settings));
  }
  chats.set(chat.id, entry);
}

function synchronizeStoredChatMetadata(
  doc: Y.Doc,
  storedChats: ReadonlyMap<string, StoredChat>,
): void {
  const chats = doc.getMap<unknown>("epic").get("chats");
  if (!(chats instanceof Y.Map)) {
    return;
  }
  for (const [chatId, stored] of storedChats) {
    const entry = chats.get(chatId);
    if (!(entry instanceof Y.Map)) {
      continue;
    }
    const title = entry.get("title");
    if (typeof title === "string") {
      stored.title = title;
    }
    const parentId = entry.get("parentId");
    if (parentId === null || typeof parentId === "string") {
      stored.parentId = parentId;
    }
    const isTitleEditedByUser = entry.get("isTitleEditedByUser");
    if (typeof isTitleEditedByUser === "boolean") {
      stored.isTitleEditedByUser = isTitleEditedByUser;
    }
    const archivedAt = entry.get("archivedAt");
    if (archivedAt === null || typeof archivedAt === "number") {
      stored.archivedAt = archivedAt;
    }
    const updatedAt = entry.get("updatedAt");
    if (
      typeof updatedAt === "number" &&
      Number.isFinite(updatedAt) &&
      updatedAt > stored.updatedAt
    ) {
      stored.updatedAt = updatedAt;
    }
  }
}

function userMessage(
  messageId: string,
  sender: UserMessage["sender"],
  content: JsonContent,
  timestamp: number,
): UserMessage {
  return {
    role: "user",
    messageId,
    sender,
    message: { kind: "user", content },
    timestamp,
    sessionAnchor: null,
  };
}

function agentUserMessage(args: {
  readonly messageId: string;
  readonly timestamp: number;
  readonly prompt: string;
  readonly senderAgentId: string;
  readonly senderTitle: string | null;
  readonly senderHarnessId: string | null;
  readonly persistedHarnessId: Extract<
    UserMessage["sender"],
    { readonly type: "agent" }
  >["harnessId"];
  readonly reply: AgentMessageReply;
  readonly inReplyTo: string | null;
}): UserMessage {
  const content: JsonContent = {
    type: "doc",
    content: [
      args.prompt.length === 0
        ? { type: "paragraph" }
        : {
            type: "paragraph",
            content: [{ type: "text", text: args.prompt }],
          },
    ],
  };
  return {
    role: "user",
    messageId: args.messageId,
    sender: {
      type: "agent",
      harnessId: args.persistedHarnessId,
      agentId: args.senderAgentId,
      displayName: args.senderTitle,
      reply: args.reply,
      inReplyTo: args.inReplyTo,
    },
    message: {
      kind: "agent",
      content,
      fromAgentId: args.senderAgentId,
      senderTitle: args.senderTitle,
      senderHarnessId: args.senderHarnessId,
      reply: args.reply,
    },
    timestamp: args.timestamp,
    sessionAnchor: null,
  };
}

function queuedAgentMessageItem(
  queued: QueuedAgentMessage,
): ChatQueuedPromptItem {
  return {
    kind: "prompt",
    queueItemId: queued.queueItemId,
    messageId: queued.message.messageId,
    message: queued.message.message,
    sender: queued.message.sender,
    settings: queued.settings,
    accountContext: { type: "PERSONAL" },
    delivery: "next_turn",
    status: "pending",
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: queued.createdAt,
    updatedAt: queued.createdAt,
  };
}

function queuedAgentQueueState(
  queued: readonly QueuedAgentMessage[],
): ChatQueueState {
  const items = queued.map(queuedAgentMessageItem);
  return {
    status: items.length === 0 ? "idle" : "running",
    items,
  };
}
