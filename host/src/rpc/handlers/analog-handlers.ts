import { migratePhaseToEpicRequestSchema } from "@traycer/protocol/host/migration/unary-schemas";
import { chatBackupStatusRequestSchema } from "@traycer/protocol/host/epic/chat-backup-status";
import { listChatPublicationTargetsRequestSchema } from "@traycer/protocol/host/epic/chat-publication-identity";
import { listCloudChatsRequestSchema } from "@traycer/protocol/host/epic/cloud-chat";
import {
  hostNotificationsIndicatorStateRequestSchema,
  hostNotificationsMarkReadRequestSchema,
} from "@traycer/protocol/host/notifications/host-notifications";
import type { RpcHandler } from "./types";

const QUIET_INDICATOR = {
  pendingApproval: false,
  pendingInterview: false,
  unreadFailure: false,
  unreadDone: false,
  pendingFork: false,
} as const;

export const handlePhaseMigrateToEpic: RpcHandler = async (params, runtime) => {
  const parsed = migratePhaseToEpicRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const existing = runtime.store
    .snapshot()
    .epics.find((row) => row.id === parsed.data.phaseId);
  if (existing !== undefined) {
    return { ok: true, result: { epicId: existing.id } };
  }
  const now = Date.now();
  await runtime.store.mutate((state) => {
    state.epics.unshift({
      id: parsed.data.phaseId,
      title: "Migrated phase",
      initialUserPrompt: "",
      status: "active",
      createdAt: now,
      updatedAt: now,
      createdBy: "local",
      version: "2.0.0",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      repos: [],
      workspaces: [],
      pinned: false,
      lastViewedAt: now,
    });
  });
  return { ok: true, result: { epicId: parsed.data.phaseId } };
};

export const handleHostChatForkGet: RpcHandler = () => {
  return { ok: true, result: { event: null } };
};

export const handleHostNotificationsIndicatorState: RpcHandler = (params) => {
  const parsed = hostNotificationsIndicatorStateRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const epics: { [epicId: string]: typeof QUIET_INDICATOR } = {};
  for (const epicId of parsed.data.epicIds) {
    epics[epicId] = QUIET_INDICATOR;
  }
  const chats: { [chatId: string]: typeof QUIET_INDICATOR } = {};
  for (const chatId of parsed.data.chatIds) {
    chats[chatId] = QUIET_INDICATOR;
  }
  return { ok: true, result: { epics, chats } };
};

export const handleEpicListCloudChats: RpcHandler = (params) => {
  const parsed = listCloudChatsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return { ok: true, result: { chats: [] } };
};

export const handleEpicChatBackupStatus: RpcHandler = (params) => {
  const parsed = chatBackupStatusRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return { ok: true, result: { chats: [] } };
};

export const handleEpicListChatPublicationTargets: RpcHandler = (params) => {
  const parsed = listChatPublicationTargetsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return { ok: true, result: { redirected: [] } };
};

export const handleHostNotificationsMarkRead: RpcHandler = (params) => {
  const parsed = hostNotificationsMarkReadRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return { ok: true, result: {} };
};

export const handleTerminalPlainList: RpcHandler = (params, runtime) => {
  const scope = readScope(params);
  if (scope === null) {
    return {
      ok: true,
      result: {
        coverage: "complete-local",
        scope: { kind: "independent" },
        terminals: [],
      },
    };
  }
  if (scope.kind === "epic") {
    return {
      ok: true,
      result: {
        coverage: "partial-serving-host",
        scope,
        servingHostId: runtime.hostId,
        terminals: [],
      },
    };
  }
  return {
    ok: true,
    result: {
      coverage: "complete-local",
      scope,
      terminals: [],
    },
  };
};

function readScope(
  params: unknown,
): { kind: "independent" } | { kind: "epic"; epicId: string } | null {
  if (params === null || typeof params !== "object") {
    return null;
  }
  const scope = Reflect.get(params, "scope");
  if (scope === null || typeof scope !== "object") {
    return null;
  }
  const kind = Reflect.get(scope, "kind");
  if (kind === "independent") {
    return { kind: "independent" };
  }
  if (kind === "epic") {
    const epicId = Reflect.get(scope, "epicId");
    if (typeof epicId === "string" && epicId.length > 0) {
      return { kind: "epic", epicId };
    }
  }
  return null;
}
