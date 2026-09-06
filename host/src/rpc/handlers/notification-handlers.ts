import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  hostNotificationsClearAllRequestSchema,
  hostNotificationsConfigResponseSchema,
  hostNotificationsIndicatorStateRequestSchema,
  hostNotificationsMarkAllReadRequestSchema,
  hostNotificationsMarkReadRequestSchema,
  hostNotificationsResolveRequestSchema,
  hostNotificationsSetConfigRequestSchema,
  notificationHooksSaveRequestSchema,
  notificationHooksTestRequestSchema,
  type HostNotificationsConfigResponse,
} from "@traycer/protocol/host/notifications/host-notifications";
import { z } from "zod";
import {
  broadcastReadState,
  DEFAULT_NOTIFICATIONS_CONFIG,
  entryOf,
  indicatorStateFor,
  notificationRows,
  summaryOf,
} from "../../gui/notifications";
import type { StoredNotification } from "../../store/host-store";
import {
  hasLastResult,
  hooksConfigPath,
  lastResultFor,
  readHooks,
  runHook,
  writeHooks,
} from "../../gui/notification-hooks";
import type { RpcHandler } from "./types";

/**
 * Both list majors in one schema: dispatch hands the handler whatever the
 * caller's own contract parsed, and never upgrades it first. `all`/`unread`
 * are the frozen v1 filters; `recent`/`unreadRecent`/`attention` are v2's.
 */
const listRequestSchema = z.object({
  filter: z.enum(["all", "unread", "recent", "unreadRecent", "attention"]),
  limit: z.number().int().min(1).max(500),
  cursor: z
    .object({ updatedAt: z.number(), id: z.string() })
    .loose()
    .optional(),
});

export const handleNotificationsList: RpcHandler = (params, runtime) => {
  const parsed = listRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const rows = notificationRows(runtime).filter((row) =>
    matchesFilter(row, parsed.data.filter),
  );
  const cursor = parsed.data.cursor;
  const after =
    cursor === undefined
      ? rows
      : rows.filter(
          (row) =>
            row.updatedAt < cursor.updatedAt ||
            (row.updatedAt === cursor.updatedAt && row.id < cursor.id),
        );
  const page = after.slice(0, parsed.data.limit);
  const last = page[page.length - 1];
  const more = after.length > page.length && last !== undefined;
  return {
    ok: true,
    result: {
      entries: page.map(entryOf),
      nextCursor: more
        ? {
            kind:
              parsed.data.filter === "attention"
                ? "attention"
                : "chronological",
            ...(parsed.data.filter === "attention"
              ? { tier: last.severity === "failure" ? "failure" : "blocking" }
              : {}),
            updatedAt: last.updatedAt,
            id: last.id,
          }
        : null,
    },
  };
};

export const handleNotificationsMarkRead: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = hostNotificationsMarkReadRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const request = parsed.data;
  const now = Date.now();
  const touched = await runtime.store.mutate((state) => {
    const ids: string[] = [];
    for (const row of state.notifications) {
      if (row.readAt !== null) {
        continue;
      }
      const hit =
        request.kind === "ids"
          ? request.ids.includes(row.id)
          : addressesEntity(row, request.entity);
      if (!hit) {
        continue;
      }
      row.readAt = now;
      ids.push(row.id);
    }
    return ids;
  });
  broadcastReadState(runtime, touched, now, null);
  return { ok: true, result: {} };
};

export const handleNotificationsMarkAllRead: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = hostNotificationsMarkAllReadRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const now = Date.now();
  const touched = await runtime.store.mutate((state) => {
    const ids: string[] = [];
    for (const row of state.notifications) {
      if (row.readAt !== null || row.updatedAt > parsed.data.beforeUpdatedAt) {
        continue;
      }
      row.readAt = now;
      ids.push(row.id);
    }
    return ids;
  });
  broadcastReadState(runtime, touched, now, null);
  return { ok: true, result: {} };
};

export const handleNotificationsResolve: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = hostNotificationsResolveRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const now = Date.now();
  const touched = await runtime.store.mutate((state) => {
    const ids: string[] = [];
    for (const occurrence of parsed.data.occurrences) {
      const row = state.notifications.find(
        (candidate) =>
          candidate.id === occurrence.id &&
          candidate.updatedAt === occurrence.updatedAt &&
          candidate.sourceRef === occurrence.sourceRef,
      );
      // A dismiss aimed at an occurrence that has since moved on is a no-op:
      // the row reopened for a NEWER prompt and must stay in Attention.
      if (row === undefined || row.resolvedAt !== null) {
        continue;
      }
      row.resolvedAt = now;
      row.readAt = row.readAt ?? now;
      ids.push(row.id);
    }
    return ids;
  });
  broadcastReadState(runtime, touched, now, now);
  return { ok: true, result: {} };
};

export const handleNotificationsClearAll: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = hostNotificationsClearAllRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const removedIds = await runtime.store.mutate((state) => {
    const ids = state.notifications
      .filter((row) => row.updatedAt <= parsed.data.beforeUpdatedAt)
      .map((row) => row.id);
    state.notifications = state.notifications.filter(
      (row) => row.updatedAt > parsed.data.beforeUpdatedAt,
    );
    return ids;
  });
  runtime.notifications.broadcast({
    kind: "cleared",
    hasBinaryPayload: false,
    beforeUpdatedAt: parsed.data.beforeUpdatedAt,
    removedIds,
    summary: summaryOf(runtime),
  });
  return { ok: true, result: {} };
};

export const handleNotificationsIndicatorState: RpcHandler = (
  params,
  runtime,
) => {
  const parsed = hostNotificationsIndicatorStateRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const rows = notificationRows(runtime);
  const epics: { [epicId: string]: unknown } = {};
  for (const epicId of parsed.data.epicIds) {
    epics[epicId] = indicatorStateFor(
      rows,
      (row) => row.epicId === epicId && row.chatId === null,
    );
  }
  const chats: { [chatId: string]: unknown } = {};
  for (const chatId of parsed.data.chatIds) {
    chats[chatId] = indicatorStateFor(rows, (row) => row.chatId === chatId);
  }
  return { ok: true, result: { epics, chats } };
};

export const handleNotificationsGetConfig: RpcHandler = async (
  _params,
  runtime,
) => {
  return { ok: true, result: await readConfig(runtime.dataDir) };
};

export const handleNotificationsSetConfig: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = hostNotificationsSetConfigRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const current = await readConfig(runtime.dataDir);
  const email = parsed.data.channels.email;
  const next: HostNotificationsConfigResponse = {
    matrix: parsed.data.matrix,
    channels: {
      renderer: { lastError: null },
      email: {
        host: email.host,
        port: email.port,
        user: email.user,
        from: email.from,
        credentialConfigured:
          email.password.kind === "set"
            ? true
            : email.password.kind === "clear"
              ? false
              : current.channels.email.credentialConfigured,
        lastError: null,
      },
    },
  };
  await mkdir(runtime.dataDir, { recursive: true });
  await writeFile(
    configPath(runtime.dataDir),
    `${JSON.stringify(next, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return { ok: true, result: next };
};

function configPath(dataDir: string): string {
  return join(dataDir, "notifications-config.json");
}

async function readConfig(
  dataDir: string,
): Promise<HostNotificationsConfigResponse> {
  try {
    const raw = await readFile(configPath(dataDir), "utf8");
    const parsed = hostNotificationsConfigResponseSchema.safeParse(
      JSON.parse(raw),
    );
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    // Missing, unreadable, or invalid.
  }
  return DEFAULT_NOTIFICATIONS_CONFIG;
}

function matchesFilter(row: StoredNotification, filter: string): boolean {
  if (filter === "unread" || filter === "unreadRecent") {
    return row.readAt === null;
  }
  if (filter === "attention") {
    return (
      (row.severity === "needs_action" && row.resolvedAt === null) ||
      (row.severity === "failure" && row.readAt === null)
    );
  }
  return true;
}

/**
 * `{ epicId }` consumes the epic's own rows; `{ epicId, chatId }` consumes
 * those plus the named chat, never a sibling chat.
 */
function addressesEntity(
  row: StoredNotification,
  entity: { readonly epicId: string; readonly chatId?: string | undefined },
): boolean {
  if (row.epicId !== entity.epicId) {
    return false;
  }
  if (row.chatId === null) {
    return true;
  }
  return entity.chatId !== undefined && row.chatId === entity.chatId;
}

/**
 * Hook identity, filters, and a redacted last-result summary - never a header
 * value. `configPath` is the one deliberate path disclosure here: it is the
 * user's own hand-editable file, which is the point of showing it.
 */
export const handleNotificationHooksStatus: RpcHandler = async (
  _params,
  runtime,
) => {
  const file = await readHooks(runtime);
  return {
    ok: true,
    result: {
      configPath: hooksConfigPath(runtime),
      configError: file.configError,
      hooks: file.hooks.map((hook) => ({
        ...hook,
        lastResult: hasLastResult(hook.id) ? lastResultFor(hook.id) : null,
      })),
    },
  };
};

/** Whole-file rewrite: the form and a hand-edit are two editors over one file. */
export const handleNotificationHooksSave: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = notificationHooksSaveRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  await writeHooks(runtime, parsed.data.hooks);
  return handleNotificationHooksStatus({}, runtime);
};

export const handleNotificationHooksTest: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = notificationHooksTestRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const file = await readHooks(runtime);
  const hook = file.hooks.find((row) => row.id === parsed.data.hookId);
  if (hook === undefined) {
    return {
      ok: true,
      result: { outcome: "not-found", detail: "No hook with that id." },
    };
  }
  if (!hook.enabled) {
    return {
      ok: true,
      result: { outcome: "disabled", detail: "This hook is disabled." },
    };
  }
  const result = await runHook(runtime, hook, {
    event: "hook.test",
    severity: "info",
    message: "Test delivery from the Traycer host.",
    epicId: null,
    chatId: null,
  });
  return {
    ok: true,
    result: {
      outcome: result.ok ? "ok" : "failed",
      detail: result.detail,
    },
  };
};
