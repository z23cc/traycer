import { userInfo } from "node:os";
import {
  getChatRunSettingsRequestSchema,
  listChatRecordsRequestSchema,
  listChatRecordsRequestV11Schema,
} from "@traycer/protocol/host/epic/chat-records";
import {
  batchDeleteRequestSchema,
  createChatRequestSchema,
  deleteChatRequestSchema,
  createEpicRequestSchema,
  batchUpdateEpicRolesRequestSchema,
  epicMentionEpicsRequestSchema,
  getTaskContextsRequestSchema,
  grantEpicAccessRequestSchema,
  listEpicCollaboratorsRequestSchema,
  reparentChatRequestSchema,
  removeEpicRepoRequestSchema,
  setChatArchivedRequestSchema,
  updateChatProfileRequestSchema,
  revokeEpicCollaboratorRequestSchema,
  listTasksRequestSchema,
  recordEpicViewedRequestSchema,
  renameChatRequestSchema,
  updateChatRunSettingsRequestSchema,
  updateChatRunSettingsRequestSchemaV11,
  updateEpicRequestSchema,
  type CollaboratorEntry,
  type CollaboratorProfile,
  type ListEpicCollaboratorsResponse,
  type PermissionRole,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  beginGuiPrintTurn,
  extractPlainText,
  persistChatRunSettings,
  persistGuiUserTurn,
  derivedChatTitle,
  readHarnessId,
  readModelSlug,
  readUserId,
  seedGuiChat,
  titleFromPrompt,
} from "../../agent/gui-chat";
import { retryMigrationRequestSchema } from "@traycer/protocol/host/epic/lane-unaries";
import { publishEpic } from "../../stream/epic-hub";
import { createWorktreeBinding } from "../../worktree/service";
import { LOCAL_USER_ID } from "../../local-user";
import type { HostRuntime } from "../../runtime";
import type {
  StoredChat,
  StoredCollaborator,
  StoredEpic,
} from "../../store/host-store";
import { isReservedAgentId } from "@traycer/protocol/host/agent/roles";
import { chatRecordSummaryOf } from "../../stream/chat-records";
import type { RpcHandler } from "./types";

const EPIC_VERSION = "2.0.0";

export const handleEpicCreate: RpcHandler = async (params, runtime) => {
  const parsed = createEpicRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const now = Date.now();
  const createdBy =
    parsed.data.epic.createdBy.length > 0
      ? parsed.data.epic.createdBy
      : "local";
  const epic: StoredEpic = {
    id: parsed.data.epic.id,
    title: parsed.data.epic.title,
    initialUserPrompt: parsed.data.epic.initialUserPrompt,
    status: parsed.data.epic.status,
    createdAt: parsed.data.epic.createdAt || now,
    updatedAt: now,
    createdBy,
    version:
      parsed.data.epic.version.length > 0
        ? parsed.data.epic.version
        : EPIC_VERSION,
    ticketCount: parsed.data.epic.ticketCount,
    specCount: parsed.data.epic.specCount,
    storyCount: parsed.data.epic.storyCount,
    reviewCount: parsed.data.epic.reviewCount,
    repos: parsed.data.repoIdentifiers,
    workspaces: parsed.data.workspaces.map(
      (workspace) => workspace.workspacePath,
    ),
    pinned: false,
    lastViewedAt: now,
  };
  const chatSeed = parsed.data.chat;
  if (
    chatSeed !== undefined &&
    chatSeed !== null &&
    isReservedAgentId(chatSeed.chatId)
  ) {
    return reservedIdRefusal(chatSeed.chatId);
  }
  const seedHarness =
    chatSeed === undefined || chatSeed === null
      ? "claude"
      : (readHarnessId(chatSeed.initialMessage?.settings) ?? "claude");
  await runtime.store.mutate((state) => {
    state.epics = state.epics.filter((row) => row.id !== epic.id);
    state.epics.unshift(epic);
    if (chatSeed !== undefined && chatSeed !== null) {
      seedGuiChat(
        state,
        {
          epicId: epic.id,
          chatId: chatSeed.chatId,
          parentId: chatSeed.parentId,
          hostId: chatSeed.hostId,
          title: chatSeed.title,
          createdAt: now,
          runSettings: null,
          providerSession: null,
          turns: [],
          events: [],
          transcriptEpoch: 0,
          indexRevision: 0,
          accumulatedChanges: [],
          lastUsage: null,
          archivedAt: null,
          lastAuthFailureTurnId: null,
          pinnedTodo: null,
          fastMode: false,
        },
        seedHarness,
      );
    }
  });
  if (chatSeed !== undefined && chatSeed !== null) {
    await bindEpicWorkspacesToChat(runtime, epic, chatSeed.chatId);
  }
  const initialTurnStarted = await startFoldedTurn(
    runtime,
    epic.id,
    chatSeed === undefined || chatSeed === null ? null : chatSeed.chatId,
    chatSeed === undefined || chatSeed === null
      ? null
      : chatSeed.initialMessage,
    seedHarness,
  );
  return {
    ok: true,
    result: {
      roomInfo: null,
      task: toTaskLight(epic, runtime.hostId),
      initialTurnStarted,
    },
  };
};

export const handleEpicListTasks: RpcHandler = (params, runtime) => {
  const parsed = listTasksRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const filters = parsed.data.filters;
  let rows = runtime.store.snapshot().epics;
  if (filters !== null && filters !== undefined) {
    if (typeof filters.query === "string" && filters.query.length > 0) {
      const query = filters.query.toLowerCase();
      rows = rows.filter((epic) => epic.title.toLowerCase().includes(query));
    }
    if (typeof filters.hostId === "string" && filters.hostId.length > 0) {
      rows = rows.filter(() => filters.hostId === runtime.hostId);
    }
  }
  const sort = parsed.data.sort ?? "recent";
  const sorted = [...rows].sort((left, right) => {
    if (sort === "oldest") {
      return left.createdAt - right.createdAt;
    }
    if (sort === "title-asc") {
      return left.title.localeCompare(right.title);
    }
    if (sort === "title-desc") {
      return right.title.localeCompare(left.title);
    }
    return right.updatedAt - left.updatedAt;
  });
  const limit = parsed.data.limit;
  const page = sorted.slice(0, limit);
  return {
    ok: true,
    result: {
      tasks: page.map((epic) => toTaskLight(epic, runtime.hostId)),
      hasMore: sorted.length > page.length,
      nextCursor: undefined,
      facets: {
        repos: [],
        workspaces: [],
        ownershipScopes: [],
        chatHosts: [{ hostId: runtime.hostId, count: page.length }],
      },
    },
  };
};

export const handleEpicUpdateTitle: RpcHandler = async (params, runtime) => {
  const parsed = updateEpicRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const delta = parsed.data.epicDelta;
  if (delta === null) {
    return { ok: true, result: { updated: false } };
  }
  const updated = await runtime.store.mutate((state) => {
    const index = state.epics.findIndex((epic) => epic.id === delta.id);
    if (index < 0) {
      return false;
    }
    const current = state.epics[index];
    state.epics[index] = {
      ...current,
      title: delta.title ?? current.title,
      status: delta.status ?? current.status,
      initialUserPrompt: delta.initialUserPrompt ?? current.initialUserPrompt,
      updatedAt: delta.updatedAt,
    };
    return true;
  });
  return { ok: true, result: { updated } };
};

export const handleEpicBatchDelete: RpcHandler = async (params, runtime) => {
  const parsed = batchDeleteRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const results = await runtime.store.mutate((state) =>
    parsed.data.ids.map((id) => {
      const existed = state.epics.some((epic) => epic.id === id);
      state.epics = state.epics.filter((epic) => epic.id !== id);
      state.chats = state.chats.filter((chat) => chat.epicId !== id);
      state.agents = state.agents.filter((agent) => agent.epicId !== id);
      state.tuiAgents = state.tuiAgents.filter((agent) => agent.epicId !== id);
      state.bindings = state.bindings.filter(
        (binding) => binding.epicId !== id,
      );
      state.artifacts = state.artifacts.filter((row) => row.epicId !== id);
      state.commentThreads = state.commentThreads.filter(
        (row) => row.epicId !== id,
      );
      return { taskId: id, success: existed };
    }),
  );
  return { ok: true, result: { results } };
};

export const handleEpicCreateChat: RpcHandler = async (params, runtime) => {
  const parsed = createChatRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  if (isReservedAgentId(parsed.data.chatId)) {
    return reservedIdRefusal(parsed.data.chatId);
  }
  const epic = runtime.store
    .snapshot()
    .epics.find((row) => row.id === parsed.data.epicId);
  if (epic === undefined) {
    return { ok: false, code: "RPC_ERROR", message: "Epic not found" };
  }
  const harnessId =
    readHarnessId(parsed.data.initialMessage?.settings) ?? "claude";
  await runtime.store.mutate((state) => {
    seedGuiChat(
      state,
      {
        epicId: parsed.data.epicId,
        chatId: parsed.data.chatId,
        parentId: parsed.data.parentId,
        hostId: parsed.data.hostId,
        title: parsed.data.title,
        createdAt: Date.now(),
        runSettings: null,
        providerSession: null,
        turns: [],
        events: [],
        transcriptEpoch: 0,
        indexRevision: 0,
        accumulatedChanges: [],
        lastUsage: null,
        archivedAt: null,
        lastAuthFailureTurnId: null,
        pinnedTodo: null,
        fastMode: false,
      },
      harnessId,
    );
  });
  await bindEpicWorkspacesToChat(runtime, epic, parsed.data.chatId);
  const initialTurnStarted = await startFoldedTurn(
    runtime,
    parsed.data.epicId,
    parsed.data.chatId,
    parsed.data.initialMessage ?? null,
    harnessId,
  );
  return {
    ok: true,
    result: { chatId: parsed.data.chatId, initialTurnStarted },
  };
};

export const handleEpicRenameChat: RpcHandler = async (params, runtime) => {
  const parsed = renameChatRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const updated = await runtime.store.mutate((state) => {
    const chatIndex = state.chats.findIndex(
      (row) =>
        row.chatId === parsed.data.chatId && row.epicId === parsed.data.epicId,
    );
    if (chatIndex < 0) {
      return false;
    }
    const chat = state.chats[chatIndex];
    if (chat === undefined) {
      return false;
    }
    state.chats[chatIndex] = { ...chat, title: parsed.data.title };
    const agentIndex = state.agents.findIndex(
      (row) => row.id === parsed.data.chatId,
    );
    if (agentIndex >= 0) {
      state.agents[agentIndex] = {
        ...state.agents[agentIndex],
        title: parsed.data.title,
      };
    }
    return true;
  });
  return { ok: true, result: { updated } };
};

export const handleEpicDeleteChat: RpcHandler = async (params, runtime) => {
  const parsed = deleteChatRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  runtime.guiRuns.requestStop(parsed.data.chatId);
  runtime.guiRuns.kill(parsed.data.chatId);
  const deleted = await runtime.store.mutate((state) => {
    const existed = state.chats.some(
      (row) =>
        row.chatId === parsed.data.chatId && row.epicId === parsed.data.epicId,
    );
    state.chats = state.chats.filter(
      (row) => row.chatId !== parsed.data.chatId,
    );
    state.agents = state.agents.filter((row) => row.id !== parsed.data.chatId);
    state.bindings = state.bindings.filter(
      (row) =>
        !(row.ownerKind === "chat" && row.ownerId === parsed.data.chatId),
    );
    return existed;
  });
  runtime.guiRuns.endPrint(parsed.data.chatId, null);
  runtime.queue.clear(parsed.data.chatId);
  return { ok: true, result: { deleted } };
};

export const handleEpicUpdateChatRunSettings: RpcHandler = async (
  params,
  runtime,
) => {
  const latest = updateChatRunSettingsRequestSchemaV11.safeParse(params);
  const parsed = latest.success
    ? latest
    : updateChatRunSettingsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const harnessId = readHarnessId(parsed.data.settings);
  const updated = await persistChatRunSettings(runtime, {
    epicId: parsed.data.epicId,
    chatId: parsed.data.chatId,
    settings: parsed.data.settings,
    harnessId,
  });
  return { ok: true, result: { updated } };
};

export const handleEpicGetChatRunSettings: RpcHandler = (params, runtime) => {
  const parsed = getChatRunSettingsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const chat = runtime.store
    .snapshot()
    .chats.find(
      (row) =>
        row.chatId === parsed.data.chatId && row.epicId === parsed.data.epicId,
    );
  if (chat === undefined) {
    return { ok: false, code: "RPC_ERROR", message: "Chat not found" };
  }
  return { ok: true, result: { settings: chat.runSettings } };
};

export const handleEpicRecordViewed: RpcHandler = async (params, runtime) => {
  const parsed = recordEpicViewedRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const viewedAt = Date.now();
  const updated = await runtime.store.mutate((state) => {
    const index = state.epics.findIndex(
      (epic) => epic.id === parsed.data.epicId,
    );
    if (index < 0) {
      return false;
    }
    state.epics[index] = { ...state.epics[index], lastViewedAt: viewedAt };
    return true;
  });
  if (!updated) {
    return { ok: false, code: "RPC_ERROR", message: "Epic not found" };
  }
  return { ok: true, result: { viewedAt } };
};

export const handleEpicGetTaskContexts: RpcHandler = (params, runtime) => {
  const parsed = getTaskContextsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const epics = runtime.store.snapshot().epics;
  const tasks: { [taskId: string]: unknown } = {};
  for (const taskId of parsed.data.taskIds) {
    const epic = epics.find((row) => row.id === taskId);
    if (epic === undefined) {
      tasks[taskId] = { status: "confirmed-absent" };
    } else {
      tasks[taskId] = {
        status: "found",
        task: toTaskLight(epic, runtime.hostId),
      };
    }
  }
  return { ok: true, result: { tasks } };
};

export const handleEpicListChatRecords: RpcHandler = (params, runtime) => {
  const parsedV11 = listChatRecordsRequestV11Schema.safeParse(params);
  const parsedV10 = listChatRecordsRequestSchema.safeParse(params);
  let epicId: string;
  if (parsedV11.success) {
    epicId = parsedV11.data.epicId;
  } else if (parsedV10.success) {
    epicId = parsedV10.data.epicId;
  } else {
    return { ok: false, code: "RPC_ERROR", message: parsedV10.error.message };
  }
  const chats = runtime.store
    .snapshot()
    .chats.filter((chat) => chat.epicId === epicId)
    .map((chat) => chatRecordSummaryOf(runtime, chat));
  return { ok: true, result: { chats } };
};

export const handleEpicListCollaborators: RpcHandler = (params, runtime) => {
  const parsed = listEpicCollaboratorsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return { ok: true, result: collaboratorsOf(runtime, parsed.data.epicId) };
};

export const handleEpicMentionEpics: RpcHandler = (params, runtime) => {
  const parsed = epicMentionEpicsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const query = parsed.data.query.toLowerCase();
  const entries = runtime.store
    .snapshot()
    .epics.filter(
      (epic) => query.length === 0 || epic.title.toLowerCase().includes(query),
    )
    .slice(0, parsed.data.limit)
    .map((epic) => ({
      kind: "epic" as const,
      id: `epic:${epic.id}`,
      token: `epic:${epic.id}`,
      epicId: epic.id,
      label: epic.title,
      description: epic.initialUserPrompt,
      status: epic.status,
      updatedAt: epic.updatedAt,
    }));
  return { ok: true, result: { entries } };
};

export const handleEpicGrantAccess: RpcHandler = async (params, runtime) => {
  const parsed = grantEpicAccessRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const epicId = parsed.data.epicId;
  const input = parsed.data.input;
  const now = Date.now();
  await runtime.store.mutate((state) => {
    if (input.kind === "team") {
      upsertCollaborator(state.collaborators, {
        epicId,
        kind: "team",
        id: input.teamId,
        displayName: input.teamId,
        email: "",
        handle: "",
        grantedAt: now,
        grantedBy: LOCAL_USER_ID,
        role: localRole(input.role),
      });
      return;
    }
    for (const invite of input.invites) {
      const identifier = invite.identifier.trim();
      if (identifier.length === 0) {
        continue;
      }
      upsertCollaborator(state.collaborators, {
        epicId,
        kind: "user",
        id: `local:${identifier.toLowerCase()}`,
        displayName: identifier,
        email: invite.identifierType === "email" ? identifier : "",
        handle: invite.identifierType === "github_handle" ? identifier : "",
        grantedAt: now,
        grantedBy: LOCAL_USER_ID,
        role: localRole(invite.role),
      });
    }
  });
  return { ok: true, result: collaboratorsOf(runtime, epicId) };
};

export const handleEpicBatchUpdateRoles: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = batchUpdateEpicRolesRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const epicId = parsed.data.epicId;
  await runtime.store.mutate((state) => {
    for (const change of parsed.data.input.changes) {
      const target = state.collaborators.find(
        (row) =>
          row.epicId === epicId &&
          (row.id === change.userId || row.id === change.teamId),
      );
      if (target === undefined) {
        continue;
      }
      target.role = localRole(change.newRole);
    }
  });
  return { ok: true, result: collaboratorsOf(runtime, epicId) };
};

export const handleEpicRevokeCollaborator: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = revokeEpicCollaboratorRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const epicId = parsed.data.epicId;
  const input = parsed.data.input;
  const revokedId = input.kind === "team" ? input.teamId : input.userId;
  await runtime.store.mutate((state) => {
    state.collaborators = state.collaborators.filter(
      (row) => !(row.epicId === epicId && row.id === revokedId),
    );
  });
  return { ok: true, result: collaboratorsOf(runtime, epicId) };
};

/**
 * The local plane has one account, so the owner is synthesized rather than
 * stored: it cannot be revoked or demoted, and every grant below it is a
 * local record with nothing on the other end to notify.
 */
function collaboratorsOf(
  runtime: HostRuntime,
  epicId: string,
): ListEpicCollaboratorsResponse {
  const epic = runtime.store.snapshot().epics.find((row) => row.id === epicId);
  const owner: CollaboratorEntry = {
    role: "owner",
    accessType: "direct",
    grantedAt: epic?.createdAt ?? Date.now(),
    grantedBy: LOCAL_USER_ID,
    user: { userId: LOCAL_USER_ID, profile: localOwnerProfile() },
  };
  const granted = runtime.store
    .snapshot()
    .collaborators.filter((row) => row.epicId === epicId)
    .map((row): CollaboratorEntry => {
      const shared = {
        role: row.role,
        accessType: "direct" as const,
        grantedAt: row.grantedAt,
        grantedBy: row.grantedBy,
      };
      if (row.kind === "team") {
        return {
          ...shared,
          team: { teamId: row.id, teamName: row.displayName, teamMembers: [] },
        };
      }
      return {
        ...shared,
        user: {
          userId: row.id,
          profile: {
            displayName: row.displayName,
            avatarUrl: "",
            email: row.email,
            handle: row.handle,
          },
        },
      };
    });
  return {
    collaborators: [owner, ...granted],
    collaboratorsAvailable: true,
  };
}

function localOwnerProfile(): CollaboratorProfile {
  let name = LOCAL_USER_ID;
  try {
    name = userInfo().username;
  } catch {
    // No OS user record (a sandboxed uid); the id stands in for a name.
  }
  return { displayName: name, avatarUrl: "", email: "", handle: name };
}

/** The owner role is reserved for the local account. */
function localRole(role: PermissionRole): "editor" | "viewer" {
  return role === "viewer" ? "viewer" : "editor";
}

function upsertCollaborator(
  rows: StoredCollaborator[],
  row: StoredCollaborator,
): void {
  const existing = rows.find(
    (candidate) => candidate.epicId === row.epicId && candidate.id === row.id,
  );
  if (existing === undefined) {
    rows.push(row);
    return;
  }
  existing.role = row.role;
}

/** Archiving resolves the id across chats and terminal agents alike. */
export const handleEpicSetChatArchived: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = setChatArchivedRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const archivedAt = parsed.data.archived ? Date.now() : null;
  const updated = await runtime.store.mutate((state) => {
    const chat = state.chats.find(
      (row) =>
        row.epicId === parsed.data.epicId && row.chatId === parsed.data.chatId,
    );
    if (chat !== undefined) {
      if ((chat.archivedAt === null) === (archivedAt === null)) {
        return false;
      }
      chat.archivedAt = archivedAt;
      return true;
    }
    const tui = state.tuiAgents.find(
      (row) =>
        row.epicId === parsed.data.epicId &&
        row.tuiAgentId === parsed.data.chatId,
    );
    if (tui === undefined) {
      return false;
    }
    if ((tui.archivedAt === null) === (archivedAt === null)) {
      return false;
    }
    tui.archivedAt = archivedAt;
    tui.updatedAt = Date.now();
    return true;
  });
  if (updated) {
    await publishEpic(runtime, parsed.data.epicId);
    runtime.chatRecords.publish(
      runtime,
      parsed.data.epicId,
      parsed.data.chatId,
    );
  }
  return { ok: true, result: { updated } };
};

/**
 * Patches the profile inside the chat's persisted run settings. A chat that
 * has never been configured has no tuple to patch - its first send stamps the
 * whole thing, profile included - so this answers `updated: false`.
 */
export const handleEpicUpdateChatProfile: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = updateChatProfileRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const updated = await runtime.store.mutate((state) => {
    const index = state.chats.findIndex(
      (row) =>
        row.epicId === parsed.data.epicId && row.chatId === parsed.data.chatId,
    );
    const chat = index < 0 ? undefined : state.chats[index];
    if (chat === undefined || chat.runSettings === null) {
      return false;
    }
    if (typeof chat.runSettings !== "object") {
      return false;
    }
    state.chats[index] = {
      ...chat,
      runSettings: { ...chat.runSettings, profileId: parsed.data.profileId },
    };
    return true;
  });
  if (updated) {
    runtime.chatRecords.publish(
      runtime,
      parsed.data.epicId,
      parsed.data.chatId,
    );
  }
  return { ok: true, result: { updated } };
};

/**
 * There is no migration lane on the local plane - an epic is already here in
 * its final form - so a retry is an existence check.
 */
export const handleEpicRetryMigration: RpcHandler = (params, runtime) => {
  const parsed = retryMigrationRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const epic = runtime.store
    .snapshot()
    .epics.find((row) => row.id === parsed.data.epicId);
  if (epic === undefined) {
    return {
      ok: false,
      code: "RPC_ERROR",
      message: `Epic ${parsed.data.epicId} not found`,
    };
  }
  return { ok: true, result: { ok: true } };
};

export const handleEpicRemoveRepo: RpcHandler = async (params, runtime) => {
  const parsed = removeEpicRepoRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const success = await runtime.store.mutate((state) => {
    const index = state.epics.findIndex(
      (epic) => epic.id === parsed.data.epicId,
    );
    if (index < 0) {
      return false;
    }
    const epic = state.epics[index];
    if (epic === undefined) {
      return false;
    }
    const before = epic.repos.length;
    state.epics[index] = {
      ...epic,
      repos: epic.repos.filter(
        (repo) =>
          repo.owner !== parsed.data.repoIdentifier.owner ||
          repo.repo !== parsed.data.repoIdentifier.repo,
      ),
    };
    return state.epics[index]?.repos.length !== before;
  });
  return { ok: true, result: { success } };
};

export const handleEpicReparentChat: RpcHandler = async (params, runtime) => {
  const parsed = reparentChatRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const updated = await runtime.store.mutate((state) => {
    const tuiIndex = state.tuiAgents.findIndex(
      (row) =>
        row.epicId === parsed.data.epicId &&
        row.tuiAgentId === parsed.data.chatId,
    );
    if (tuiIndex >= 0) {
      const agent = state.tuiAgents[tuiIndex];
      if (agent === undefined) {
        return false;
      }
      state.tuiAgents[tuiIndex] = {
        ...agent,
        parentId: parsed.data.newParentId,
        updatedAt: Date.now(),
      };
      return true;
    }
    const chatIndex = state.chats.findIndex(
      (row) =>
        row.epicId === parsed.data.epicId && row.chatId === parsed.data.chatId,
    );
    if (chatIndex < 0) {
      return false;
    }
    const chat = state.chats[chatIndex];
    if (chat === undefined) {
      return false;
    }
    state.chats[chatIndex] = {
      ...chat,
      parentId: parsed.data.newParentId,
    };
    return true;
  });
  return { ok: true, result: { updated } };
};

async function bindEpicWorkspacesToChat(
  runtime: HostRuntime,
  epic: StoredEpic,
  chatId: string,
): Promise<void> {
  await bindEpicWorkspaces(runtime, epic.id, epic.workspaces, chatId);
}

/**
 * Binds an epic's folders to the chat that will work in them - the same
 * registration "add folder" performs, taken by its pieces so a caller holding
 * an epic it has just written does not have to read it back.
 */
export async function bindEpicWorkspaces(
  runtime: HostRuntime,
  epicId: string,
  workspaces: readonly string[],
  chatId: string,
): Promise<void> {
  if (workspaces.length === 0) {
    return;
  }
  await createWorktreeBinding(runtime, {
    epicId,
    ownerId: chatId,
    ownerKind: "chat",
    entries: workspaces.map((workspacePath, index) => ({
      kind: "local" as const,
      workspacePath,
      repoIdentifier: null,
      isPrimary: index === 0,
    })),
  });
}

async function startFoldedTurn(
  runtime: HostRuntime,
  epicId: string,
  chatId: string | null,
  initialMessage: {
    readonly messageId: string;
    readonly content: unknown;
    readonly sender: unknown;
    readonly settings: unknown;
  } | null,
  harnessId: string,
): Promise<boolean> {
  if (chatId === null || initialMessage === null) {
    return false;
  }
  const prompt = extractPlainText(initialMessage.content);
  const turn = await persistGuiUserTurn(runtime, {
    epicId,
    chatId,
    messageId: initialMessage.messageId,
    prompt,
    content: initialMessage.content,
    userId: readUserId(initialMessage.sender),
    harnessId,
    runSettings: initialMessage.settings,
  });
  if (turn === null) {
    return false;
  }
  beginGuiPrintTurn(runtime, {
    epicId,
    chatId,
    harnessId,
    prompt,
    responseId: turn.responseId,
    model: readModelSlug(initialMessage.settings),
  });
  return true;
}

function latestTurnTime(chat: StoredChat): number {
  const last = chat.turns[chat.turns.length - 1];
  return last === undefined ? chat.createdAt : last.timestamp;
}

function chatOwnerUserId(chat: StoredChat): string {
  for (const turn of chat.turns) {
    if (turn.userId !== null && turn.userId.length > 0) {
      return turn.userId;
    }
  }
  return LOCAL_USER_ID;
}

function toTaskLight(epic: StoredEpic, hostId: string) {
  return {
    pinned: epic.pinned,
    chatHostIds: [hostId],
    epic: {
      light: {
        id: epic.id,
        title:
          epic.title.length > 0
            ? epic.title
            : titleFromPrompt(epic.initialUserPrompt),
        initialUserPrompt: epic.initialUserPrompt,
        ticketCount: epic.ticketCount,
        specCount: epic.specCount,
        storyCount: epic.storyCount,
        reviewCount: epic.reviewCount,
        status: epic.status,
        createdAt: epic.createdAt,
        updatedAt: epic.updatedAt,
        createdBy: epic.createdBy,
        version: epic.version,
      },
      permission: {
        role: "owner",
        accessType: "direct",
        grantedBy: epic.createdBy,
        grantedAt: epic.createdAt,
      },
      repos: epic.repos.map((repo) => ({
        task: { taskId: epic.id, taskType: "epic" as const },
        repoIdentifier: repo,
        createdAt: epic.createdAt,
        createdBy: epic.createdBy,
      })),
      workspaces: epic.workspaces.map((workspacePath) => ({
        task: { taskId: epic.id, taskType: "epic" as const },
        hostId,
        workspacePath,
        createdAt: epic.createdAt,
      })),
      roomInfo: null,
    },
    phase: null,
  };
}

/**
 * `traycer:system` is the sender identity every platform notice is attributed
 * to, and the persisted sender envelope is agent-shaped - there is no `system`
 * variant of it. So the reservation IS the provenance: an agent allowed to
 * take that id could forge any system message this host sends, including the
 * role-awareness notices. Refused before persistence, which is the only place
 * the guarantee can live.
 */
function reservedIdRefusal(id: string): {
  readonly ok: false;
  readonly code: "RPC_ERROR";
  readonly message: string;
} {
  return {
    ok: false,
    code: "RPC_ERROR",
    message: `'${id}' is a reserved agent id and may not be created.`,
  };
}
