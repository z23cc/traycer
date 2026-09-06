import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyEnvOverrides,
  listEnvOverrides,
} from "@traycer/protocol/config/store";
import {
  notificationHookConfigSchema,
  type HostNotificationSeverity,
  type NotificationHookConfig,
  type NotificationHookLastResult,
} from "@traycer/protocol/host/notifications/host-notifications";
import { z } from "zod";
import type { HostRuntime } from "../runtime";

/**
 * The host's notification hooks: HTTP posts and local commands fired when a
 * notification is raised.
 *
 * `notification-hooks.json` is the single source of truth and stays
 * HAND-EDITABLE - `save` rewrites it whole from the client's list, so the
 * settings form and a text editor are two equal editors over one file, last
 * write wins. Nothing else caches its contents.
 */
const HOOKS_FILENAME = "notification-hooks.json";
/** A hook that has not answered by now is a failed delivery, not a hang. */
const HOOK_TIMEOUT_MS = 10_000;
const DETAIL_MAX_CHARS = 500;

const hooksFileSchema = z.object({
  hooks: z.array(notificationHookConfigSchema),
});

/**
 * Last delivery per hook id, in memory on purpose: it describes what THIS
 * process observed, and writing it back would put host-generated state into a
 * file the user hand-edits.
 */
const lastResults = new Map<string, NotificationHookLastResult>();

export function hooksConfigPath(runtime: HostRuntime): string {
  return join(runtime.dataDir, HOOKS_FILENAME);
}

export type HooksFile = {
  readonly hooks: readonly NotificationHookConfig[];
  /** Non-null when the file exists but this host could not read it. */
  readonly configError: string | null;
};

export async function readHooks(runtime: HostRuntime): Promise<HooksFile> {
  let raw: string;
  try {
    raw = await readFile(hooksConfigPath(runtime), "utf8");
  } catch {
    // An absent file is "no hooks configured", never a config error: the user
    // has simply not written one.
    return { hooks: [], configError: null };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    return { hooks: [], configError: messageOf(error) };
  }
  const parsed = hooksFileSchema.safeParse(payload);
  if (!parsed.success) {
    return { hooks: [], configError: parsed.error.message };
  }
  return { hooks: parsed.data.hooks, configError: null };
}

export async function writeHooks(
  runtime: HostRuntime,
  hooks: readonly NotificationHookConfig[],
): Promise<void> {
  await writeFile(
    hooksConfigPath(runtime),
    `${JSON.stringify({ hooks }, null, 2)}\n`,
  );
}

export function lastResultFor(hookId: string): NotificationHookLastResult {
  return lastResults.get(hookId) ?? nullResult();
}

function nullResult(): NotificationHookLastResult {
  return { at: 0, ok: false, detail: "" };
}

export function hasLastResult(hookId: string): boolean {
  return lastResults.has(hookId);
}

/**
 * Fires every enabled hook whose severity filter matches. Failures are
 * recorded and never propagated: a notification is not held up by a webhook.
 */
export async function deliverHooks(
  runtime: HostRuntime,
  payload: {
    readonly event: string;
    readonly severity: HostNotificationSeverity;
    readonly message: string;
    readonly epicId: string | null;
    readonly chatId: string | null;
  },
): Promise<void> {
  const file = await readHooks(runtime);
  const matching = file.hooks.filter(
    (hook) =>
      hook.enabled &&
      (hook.severities === null || hook.severities.includes(payload.severity)),
  );
  await Promise.all(
    matching.map(async (hook) => {
      await runHook(runtime, hook, payload);
    }),
  );
}

export async function runHook(
  runtime: HostRuntime,
  hook: NotificationHookConfig,
  payload: {
    readonly event: string;
    readonly severity: HostNotificationSeverity;
    readonly message: string;
    readonly epicId: string | null;
    readonly chatId: string | null;
  },
): Promise<NotificationHookLastResult> {
  const body = JSON.stringify({ ...payload, hostId: runtime.hostId });
  const result = await (hook.action.type === "http"
    ? post(hook.action.url, hook.action.headers, body)
    : run(hook.action.command, hook.action.args, body));
  const stamped: NotificationHookLastResult = {
    at: Date.now(),
    ok: result.ok,
    detail: result.detail.slice(0, DETAIL_MAX_CHARS),
  };
  lastResults.set(hook.id, stamped);
  return stamped;
}

/**
 * Header VALUES are resolved HERE and never cross the wire: the config file
 * holds templates (`Bearer $TOKEN`), and the environment they resolve against
 * is the CLI's own override set layered over this process's.
 */
async function post(
  url: string,
  headers: { readonly [name: string]: string },
  body: string,
): Promise<{ readonly ok: boolean; readonly detail: string }> {
  const env = applyEnvOverrides(process.env, await listEnvOverrides());
  const resolved: { [name: string]: string } = {
    "content-type": "application/json",
  };
  for (const [name, template] of Object.entries(headers)) {
    resolved[name] = expand(template, env);
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: resolved,
      body,
      signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
    });
    return {
      ok: response.ok,
      detail: `HTTP ${String(response.status)}`,
    };
  } catch (error) {
    return { ok: false, detail: messageOf(error) };
  }
}

function run(
  command: string,
  args: readonly string[],
  body: string,
): Promise<{ readonly ok: boolean; readonly detail: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;
    const settle = (value: {
      readonly ok: boolean;
      readonly detail: string;
    }): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ ok: false, detail: "timed out" });
    }, HOOK_TIMEOUT_MS);
    timer.unref();
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      settle({ ok: false, detail: messageOf(error) });
    });
    child.on("close", (code) => {
      settle(
        code === 0
          ? { ok: true, detail: "exit 0" }
          : { ok: false, detail: `exit ${String(code)} ${stderr}`.trim() },
      );
    });
    child.stdin.on("error", () => {
      // A hook that closes stdin early is not a delivery failure.
    });
    child.stdin.end(body);
  });
}

/** `$NAME` and `${NAME}`; an unset variable expands to the empty string. */
function expand(
  template: string,
  env: { readonly [name: string]: string | undefined },
): string {
  return template.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu,
    (_match, braced: string | undefined, bare: string | undefined) =>
      env[braced ?? bare ?? ""] ?? "",
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
