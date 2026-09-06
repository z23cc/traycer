import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
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
import { getWorkspaceContextRequestSchema } from "@traycer/protocol/host/epic/lane-unaries";
import { browserSavedLoginSitesRequestSchema } from "@traycer/protocol/host/browser/contracts";
import {
  configLogLevelsGetRequestSchema,
  configLogLevelsResponseSchema,
  configLogLevelsSetRequestSchema,
  type ConfigLogLevelsResponse,
} from "@traycer/protocol/host/config/schemas";
import {
  hostIdentityGetRequestSchema,
  hostIdentitySetRequestSchema,
  type HostIdentity,
} from "@traycer/protocol/host/identity/schemas";
import {
  hostGetInstallationInfoRequestSchema,
  hostServiceStatusRequestSchema,
  hostUpdateCheckRequestSchemaV11,
} from "@traycer/protocol/host/maintenance/schemas";
import { hostInstallRecordSchema } from "@traycer/protocol/config/installation-records";
import { earlyMetaForEpic } from "../../stream/epic-hub";
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

export const handleEpicGetWorkspaceContext: RpcHandler = (params, runtime) => {
  const parsed = getWorkspaceContextRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const context = earlyMetaForEpic(runtime, parsed.data.epicId);
  if (context === null) {
    return {
      ok: false,
      code: "RPC_ERROR",
      message: `Epic ${parsed.data.epicId} not found`,
    };
  }
  return { ok: true, result: { context } };
};

export const handleBrowserSavedLoginSites: RpcHandler = (params) => {
  const parsed = browserSavedLoginSitesRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return { ok: true, result: { kind: "sites", sites: [] } };
};

const fileWriteQueues = new Map<string, Promise<void>>();

async function serializeFileOperation<T>(
  filePath: string,
  op: () => Promise<T>,
): Promise<T> {
  const previous = fileWriteQueues.get(filePath) ?? Promise.resolve();
  const run = previous.then(async () => op());
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  fileWriteQueues.set(filePath, tail);
  try {
    return await run;
  } finally {
    if (fileWriteQueues.get(filePath) === tail) {
      fileWriteQueues.delete(filePath);
    }
  }
}

const DEFAULT_LOG_LEVELS: ConfigLogLevelsResponse = {
  cliLogLevel: "info",
  hostLogLevel: "info",
};

async function readLogLevels(
  dataDir: string,
): Promise<ConfigLogLevelsResponse> {
  const filePath = join(dataDir, "log-levels.json");
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const validated = configLogLevelsResponseSchema.safeParse(parsed);
    if (validated.success) {
      return validated.data;
    }
  } catch {
    // Missing, unreadable, or invalid
  }
  return DEFAULT_LOG_LEVELS;
}

async function writeLogLevels(
  dataDir: string,
  levels: ConfigLogLevelsResponse,
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const filePath = join(dataDir, "log-levels.json");
  const tmp = `${filePath}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(levels, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmp, filePath);
  } catch (error: unknown) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

export const handleConfigLogLevelsGet: RpcHandler = async (params, runtime) => {
  const parsed = configLogLevelsGetRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const levels = await readLogLevels(runtime.dataDir);
  return { ok: true, result: levels };
};

export const handleConfigLogLevelsSet: RpcHandler = async (params, runtime) => {
  const parsed = configLogLevelsSetRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const filePath = join(runtime.dataDir, "log-levels.json");
  const updated = await serializeFileOperation(
    filePath,
    async (): Promise<ConfigLogLevelsResponse> => {
      const current = await readLogLevels(runtime.dataDir);
      const next: ConfigLogLevelsResponse = {
        cliLogLevel:
          parsed.data.scope === "cli" ? parsed.data.level : current.cliLogLevel,
        hostLogLevel:
          parsed.data.scope === "host"
            ? parsed.data.level
            : current.hostLogLevel,
      };
      await writeLogLevels(runtime.dataDir, next);
      return next;
    },
  );
  return { ok: true, result: updated };
};

const MAX_HOST_NAME_LENGTH = 80;

const hostNameFileSchema = z.object({
  customName: z.string().nullable().optional(),
});

function resolveSystemName(): string {
  const host = hostname().trim();
  return host.length > 0 ? host : "traycer-host";
}

function computeEffectiveHostName(
  customName: string | null,
  systemName: string,
): string {
  if (customName !== null) {
    return customName;
  }
  const envLabel = process.env.TRAYCER_HOST_LABEL?.trim();
  if (envLabel !== undefined && envLabel.length > 0) {
    return envLabel;
  }
  return systemName;
}

type NormalizeCustomHostNameOutcome =
  | { readonly ok: true; readonly name: string | null }
  | { readonly ok: false; readonly error: string };

function normalizeCustomHostName(
  raw: string | null,
): NormalizeCustomHostNameOutcome {
  if (raw === null) {
    return { ok: true, name: null };
  }
  const normalized = raw.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) {
    return { ok: true, name: null };
  }
  if (normalized.length > MAX_HOST_NAME_LENGTH) {
    return {
      ok: false,
      error: "Custom name exceeds maximum length of 80 characters",
    };
  }
  return { ok: true, name: normalized };
}

async function readCustomHostName(dataDir: string): Promise<string | null> {
  const filePath = join(dataDir, "host-name.json");
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const validated = hostNameFileSchema.safeParse(parsed);
    if (validated.success && typeof validated.data.customName === "string") {
      const normalized = normalizeCustomHostName(validated.data.customName);
      if (normalized.ok) {
        return normalized.name;
      }
    }
  } catch {
    // Missing or invalid
  }
  return null;
}

async function writeCustomHostName(
  dataDir: string,
  customName: string | null,
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const filePath = join(dataDir, "host-name.json");
  const tmp = `${filePath}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify({ customName }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmp, filePath);
  } catch (error: unknown) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

export const handleHostIdentityGet: RpcHandler = async (params, runtime) => {
  const parsed = hostIdentityGetRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const systemName = resolveSystemName();
  const customName = await readCustomHostName(runtime.dataDir);
  const effectiveName = computeEffectiveHostName(customName, systemName);
  const identity: HostIdentity = {
    systemName,
    customName,
    effectiveName,
  };
  return { ok: true, result: identity };
};

export const handleHostIdentitySet: RpcHandler = async (params, runtime) => {
  const parsed = hostIdentitySetRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const normalized = normalizeCustomHostName(parsed.data.customName);
  if (!normalized.ok) {
    return { ok: false, code: "RPC_ERROR", message: normalized.error };
  }
  const filePath = join(runtime.dataDir, "host-name.json");
  await serializeFileOperation(filePath, async (): Promise<void> => {
    await writeCustomHostName(runtime.dataDir, normalized.name);
  });
  const systemName = resolveSystemName();
  const effectiveName = computeEffectiveHostName(normalized.name, systemName);
  const identity: HostIdentity = {
    systemName,
    customName: normalized.name,
    effectiveName,
  };
  return { ok: true, result: identity };
};

export const handleHostUpdateCheck: RpcHandler = (params) => {
  const parsed = hostUpdateCheckRequestSchemaV11.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return { ok: true, result: { outcome: "cli-unavailable" } };
};

export const handleHostGetInstallationInfo: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = hostGetInstallationInfoRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const installPath = join(runtime.dataDir, "install", "install.json");
  try {
    const raw = await readFile(installPath, "utf8");
    const parsedJson: unknown = JSON.parse(raw);
    const validated = hostInstallRecordSchema.safeParse(parsedJson);
    if (validated.success) {
      return {
        ok: true,
        result: {
          status: "managed",
          installRecord: validated.data,
          stagedRecord: null,
          cliManifest: null,
        },
      };
    }
  } catch {
    // Missing, unreadable, or invalid JSON
  }
  return {
    ok: true,
    result: { status: "unmanaged" },
  };
};

export const handleHostServiceStatus: RpcHandler = (params) => {
  const parsed = hostServiceStatusRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return { ok: true, result: { outcome: "externally-managed" } };
};
