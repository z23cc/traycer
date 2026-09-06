import { migratePhaseToEpicRequestSchema } from "@traycer/protocol/host/migration/unary-schemas";
import {
  hostUsageSummaryRequestSchemaV10,
  type HostUsageSummaryResponseV10,
} from "@traycer/protocol/host/usage-analytics/schemas";
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

const EMPTY_TOKENS = {
  uncachedInputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
};

const EMPTY_PROVENANCE_ENTRY = {
  costUsd: 0,
  factCount: 0,
  tokenCount: 0,
};

const EMPTY_PROVENANCE_SPLIT = {
  unpriced: EMPTY_PROVENANCE_ENTRY,
  modelPriced: EMPTY_PROVENANCE_ENTRY,
  providerReported: EMPTY_PROVENANCE_ENTRY,
};

const MS_PER_DAY = 86_400_000;

export const handleHostUsageSummary: RpcHandler = (params, runtime) => {
  const parsed = hostUsageSummaryRequestSchemaV10.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const now = Date.now();
  const chatId = parsed.data.chatId === undefined ? null : parsed.data.chatId;
  const epic =
    parsed.data.epicId === null
      ? null
      : (runtime.store
          .snapshot()
          .epics.find((row) => row.id === parsed.data.epicId) ?? null);
  const startAtInclusive =
    parsed.data.window === "epic" && epic !== null
      ? epic.createdAt
      : now - parsed.data.windowDays * MS_PER_DAY;
  return {
    ok: true,
    result: emptyUsageSummary(parsed.data.timezone, parsed.data.windowDays, {
      epicId: parsed.data.epicId,
      chatId,
      now,
      startAtInclusive,
    }),
  };
};

function emptyUsageSummary(
  timezone: string,
  windowDays: number,
  bounds: {
    readonly epicId: string | null;
    readonly chatId: string | null;
    readonly now: number;
    readonly startAtInclusive: number;
  },
): HostUsageSummaryResponseV10 {
  return {
    servedBy: "local" as const,
    summary: {
      window: {
        timezone,
        windowDays,
        startAtInclusive: bounds.startAtInclusive,
        endAtExclusive: bounds.now,
      },
      epicId: bounds.epicId,
      chatId: bounds.chatId,
      totals: {
        factCount: 0,
        tokens: EMPTY_TOKENS,
        knownCostUsd: 0,
        knownCacheSavingsUsd: 0,
        knownReasoningTokens: 0,
        costProvenance: null,
        provenanceSplit: EMPTY_PROVENANCE_SPLIT,
      },
      buckets: [],
      chatBuckets: [],
      hostBuckets: [],
      distinctEpicCount: 0,
      distinctChatCount: 0,
      outcomeBreakdown: {
        completed: 0,
        stopped: 0,
        interrupted: 0,
        abnormal_exit: 0,
      },
      usageCompletenessBreakdown: {
        measured: 0,
        partial: 0,
        absent: 0,
      },
      turnRows: bounds.chatId === null ? null : [],
      turnRowsTruncated: false,
    },
    coverage: {
      pricedFactCount: 0,
      unpricedFactCount: 0,
      pricedTokenCount: 0,
      unpricedTokenCount: 0,
    },
  };
}

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
