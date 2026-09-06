import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderId } from "@traycer/protocol/host/provider-ids";
import { rateLimitCapableProviderIdSchema } from "@traycer/protocol/host/rate-limit/schemas";
import type { HostRuntime } from "../runtime";
import { HOST_VERSION } from "../version";
import { providerCliIdentity } from "../providers/service";

const RATE_LIMIT_TIMEOUT_MS = 60_000;
const CLAUDE_FIVE_HOUR_MINUTES = 300;
const CLAUDE_SEVEN_DAY_MINUTES = 10_080;
const GROK_MS_PER_MINUTE = 60_000;
const GROK_WEEKLY_PERIOD_TYPE = "USAGE_PERIOD_TYPE_WEEKLY";
const GROK_ACP_INITIALIZE = {
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  },
} as const;
const GROK_BILLING_METHOD = "_x.ai/billing";
const GROK_METHOD_MISSING_PREFIX = "ACP error -32601:";
const GROK_AUTH_REQUIRED_PREFIX = "ACP error -32000: Authentication required";
const CLAUDE_INIT_REQUEST_ID = "init-1";
const CLAUDE_USAGE_REQUEST_ID = "usage-1";
const CURSOR_API_ORIGIN = "https://api2.cursor.sh";
const CURSOR_EXCHANGE_URL = `${CURSOR_API_ORIGIN}/auth/exchange_user_api_key`;
const CURSOR_USAGE_URL = `${CURSOR_API_ORIGIN}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`;
const CURSOR_CENTS_PER_USD = 100;
const CURSOR_KEYCHAIN_SERVICE = "cursor-access-token";

export type ProviderRateLimitSnapshot = {
  readonly provider: string;
  readonly available: boolean;
  readonly [key: string]: unknown;
};

export function unavailableRateLimits(
  providerId: string,
  reason: string,
): ProviderRateLimitSnapshot {
  return { provider: providerId, available: false, reason };
}

export async function readProviderRateLimits(
  runtime: HostRuntime,
  providerId: string,
  _profileId: string | null,
): Promise<ProviderRateLimitSnapshot> {
  const capable = rateLimitCapableProviderIdSchema.safeParse(providerId);
  if (!capable.success) {
    return unavailableRateLimits(providerId, "unsupported_provider");
  }
  if (capable.data === "cursor") {
    return readCursorRateLimits();
  }
  if (capable.data === "grok") {
    const identity = providerCliIdentity(runtime.store, "grok");
    return readGrokRateLimits(identity.path);
  }
  if (capable.data === "codex" || capable.data === "claude-code") {
    const identity = providerCliIdentity(
      runtime.store,
      capable.data as ProviderId,
    );
    if (identity.path === null) {
      return unavailableRateLimits(capable.data, "cli_not_found");
    }
    if (capable.data === "codex") {
      return readCodexRateLimits(identity.path);
    }
    return readClaudeRateLimits(identity.path);
  }
  return unavailableRateLimits(capable.data, "rate_limits_not_available");
}

export function parseCodexRateLimitsPayload(
  payload: unknown,
): ProviderRateLimitSnapshot | null {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const rateLimits = Reflect.get(payload, "rateLimits");
  if (
    rateLimits === null ||
    typeof rateLimits !== "object" ||
    Array.isArray(rateLimits)
  ) {
    return null;
  }
  const extraRaw = Reflect.get(payload, "rateLimitsByLimitId");
  const limitId = readString(rateLimits, "limitId");
  const extraWindows: unknown[] = [];
  if (
    extraRaw !== null &&
    typeof extraRaw === "object" &&
    !Array.isArray(extraRaw)
  ) {
    for (const [key, value] of Object.entries(extraRaw)) {
      if (key === limitId) {
        continue;
      }
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      extraWindows.push({
        limitId: readString(value, "limitId") ?? key,
        limitName: readString(value, "limitName"),
        primary: mapCodexWindow(Reflect.get(value, "primary")),
        secondary: mapCodexWindow(Reflect.get(value, "secondary")),
      });
    }
  }
  const resetCreditsRaw = Reflect.get(payload, "rateLimitResetCredits");
  return {
    provider: "codex",
    available: true,
    planType: readString(rateLimits, "planType"),
    limitId,
    limitName: readString(rateLimits, "limitName"),
    primary: mapCodexWindow(Reflect.get(rateLimits, "primary")),
    secondary: mapCodexWindow(Reflect.get(rateLimits, "secondary")),
    extraWindows,
    credits: parseCodexCredits(Reflect.get(rateLimits, "credits")),
    individualLimit: parseCodexIndividualLimit(
      Reflect.get(rateLimits, "individualLimit"),
    ),
    resetCredits: parseCodexResetCredits(resetCreditsRaw),
    rateLimitReachedType: readString(rateLimits, "rateLimitReachedType"),
  };
}

export function parseClaudeUsagePayload(
  payload: unknown,
): ProviderRateLimitSnapshot {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return unavailableRateLimits("claude-code", "invalid_response");
  }
  const subscriptionType = readString(payload, "subscription_type");
  if (Reflect.get(payload, "rate_limits_available") !== true) {
    return {
      provider: "claude-code",
      available: false,
      reason: "rate_limits_not_available",
    };
  }
  const rateLimits = Reflect.get(payload, "rate_limits");
  if (
    rateLimits === null ||
    typeof rateLimits !== "object" ||
    Array.isArray(rateLimits)
  ) {
    return {
      provider: "claude-code",
      available: false,
      reason: "usage_fetch_failed",
    };
  }
  const modelScopedRaw = Reflect.get(rateLimits, "model_scoped");
  const modelScoped: unknown[] = [];
  if (Array.isArray(modelScopedRaw)) {
    for (const entry of modelScopedRaw) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const window = mapClaudeWindow(entry, null);
      if (window === null) {
        continue;
      }
      modelScoped.push({
        displayName: readString(entry, "display_name") ?? "",
        ...window,
      });
    }
  }
  const extraUsageRaw = Reflect.get(rateLimits, "extra_usage");
  const extraUsage =
    extraUsageRaw === null ||
    typeof extraUsageRaw !== "object" ||
    Array.isArray(extraUsageRaw)
      ? null
      : {
          isEnabled: Reflect.get(extraUsageRaw, "is_enabled") === true,
          monthlyLimit: readNumber(extraUsageRaw, "monthly_limit"),
          usedCredits: readNumber(extraUsageRaw, "used_credits"),
          utilization: readNumber(extraUsageRaw, "utilization"),
        };
  return {
    provider: "claude-code",
    available: true,
    subscriptionType,
    fiveHour: mapClaudeWindow(
      Reflect.get(rateLimits, "five_hour"),
      CLAUDE_FIVE_HOUR_MINUTES,
    ),
    sevenDay: mapClaudeWindow(
      Reflect.get(rateLimits, "seven_day"),
      CLAUDE_SEVEN_DAY_MINUTES,
    ),
    sevenDayOpus: mapClaudeWindow(
      Reflect.get(rateLimits, "seven_day_opus"),
      CLAUDE_SEVEN_DAY_MINUTES,
    ),
    sevenDaySonnet: mapClaudeWindow(
      Reflect.get(rateLimits, "seven_day_sonnet"),
      CLAUDE_SEVEN_DAY_MINUTES,
    ),
    modelScoped,
    extraUsage,
  };
}

export function parseGrokBillingPayload(
  payload: unknown,
): ProviderRateLimitSnapshot | null {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const config = parseGrokBillingConfig(Reflect.get(payload, "config"));
  return {
    provider: "grok",
    available: true,
    subscriptionTier: readString(payload, "subscription_tier"),
    periodType: config.periodType,
    periodStart: config.periodStart,
    periodEnd: config.periodEnd,
    period: synthesizeGrokPeriodWindow(config),
    monthlyLimit: config.monthlyLimit,
    onDemandCap: config.onDemandCap,
    onDemandUsed: config.onDemandUsed,
    prepaidBalance: config.prepaidBalance,
  };
}

export function parseCursorUsagePayload(
  payload: unknown,
): ProviderRateLimitSnapshot {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return unavailableRateLimits("cursor", "invalid_response");
  }
  const cycleStart = readInt64(payload, "billingCycleStart");
  const cycleEnd = readInt64(payload, "billingCycleEnd");
  const planUsage = Reflect.get(payload, "planUsage");
  const plan =
    planUsage !== null &&
    typeof planUsage === "object" &&
    !Array.isArray(planUsage)
      ? planUsage
      : null;
  const spendLimitUsage = Reflect.get(payload, "spendLimitUsage");
  const spend =
    spendLimitUsage !== null &&
    typeof spendLimitUsage === "object" &&
    !Array.isArray(spendLimitUsage)
      ? spendLimitUsage
      : null;
  const displayMessageRaw = Reflect.get(payload, "displayMessage");
  const displayMessage =
    typeof displayMessageRaw === "string" && displayMessageRaw.trim().length > 0
      ? displayMessageRaw.trim()
      : null;
  const limitTypeRaw = spend === null ? null : Reflect.get(spend, "limitType");
  const onDemandLimitType =
    typeof limitTypeRaw === "string" && limitTypeRaw.trim().length > 0
      ? limitTypeRaw.trim()
      : null;
  return {
    provider: "cursor",
    available: true,
    cycleStart,
    cycleEnd,
    cursorModels: buildCursorBucketWindow(
      plan,
      "autoPercentUsed",
      cycleStart,
      cycleEnd,
    ),
    otherModels: buildCursorBucketWindow(
      plan,
      "apiPercentUsed",
      cycleStart,
      cycleEnd,
    ),
    includedLimitUsd: usdFromCents(plan, "limit"),
    usedUsd: usdFromCents(plan, "totalSpend"),
    remainingUsd: usdFromCents(plan, "remaining"),
    bonusUsedUsd: usdFromCents(plan, "bonusSpend"),
    onDemandLimitType,
    onDemandLimitUsd: usdFromCents(spend, "individualLimit"),
    onDemandUsedUsd: usdFromCents(spend, "individualUsed"),
    onDemandRemainingUsd: usdFromCents(spend, "individualRemaining"),
    displayMessage,
  };
}

export function credentialPresent(providerId: ProviderId): boolean {
  const home = homedir();
  if (providerId === "codex") {
    return existsSync(join(home, ".codex", "auth.json"));
  }
  if (providerId === "claude-code") {
    return (
      existsSync(join(home, ".claude", ".credentials.json")) ||
      existsSync(join(home, ".claude.json"))
    );
  }
  if (providerId === "grok") {
    const mode = classifyGrokAuthMode();
    return mode === "oauth" || mode === "api-key";
  }
  if (providerId === "openrouter") {
    return typeof process.env.OPENROUTER_API_KEY === "string";
  }
  if (providerId === "cursor") {
    return cursorApiKeyFromEnv() !== null || cursorKeychainItemPresent();
  }
  if (providerId === "huggingface") {
    return (
      typeof process.env.HF_TOKEN === "string" ||
      typeof process.env.HUGGINGFACE_API_KEY === "string"
    );
  }
  return false;
}

function readCursorRateLimits(): Promise<ProviderRateLimitSnapshot> {
  const controller = new AbortController();
  const timer: NodeJS.Timeout = setTimeout(() => {
    controller.abort();
  }, RATE_LIMIT_TIMEOUT_MS);
  return fetchCursorUsage(controller.signal).then(
    (snapshot) => {
      clearTimeout(timer);
      return snapshot;
    },
    () => {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        return unavailableRateLimits("cursor", "timeout");
      }
      return unavailableRateLimits("cursor", "connection_failed");
    },
  );
}

async function fetchCursorUsage(
  signal: AbortSignal,
): Promise<ProviderRateLimitSnapshot> {
  const apiKey = cursorApiKeyFromEnv();
  if (apiKey !== null) {
    const exchanged = await cursorPostJson(CURSOR_EXCHANGE_URL, apiKey, signal);
    if (exchanged.kind === "auth-error") {
      return unavailableRateLimits("cursor", "rate_limits_not_available");
    }
    if (exchanged.kind !== "ok") {
      return unavailableRateLimits("cursor", "usage_fetch_failed");
    }
    const accessToken = readCursorAccessToken(exchanged.body);
    if (accessToken === null) {
      return unavailableRateLimits("cursor", "invalid_response");
    }
    return fetchCursorDashboard(accessToken, signal);
  }
  const sessionToken = readCursorKeychainAccessToken();
  if (sessionToken === null) {
    return unavailableRateLimits("cursor", "rate_limits_not_available");
  }
  return fetchCursorDashboard(sessionToken, signal);
}

async function fetchCursorDashboard(
  bearer: string,
  signal: AbortSignal,
): Promise<ProviderRateLimitSnapshot> {
  const usage = await cursorPostJson(CURSOR_USAGE_URL, bearer, signal);
  if (usage.kind === "auth-error") {
    return unavailableRateLimits("cursor", "rate_limits_not_available");
  }
  if (usage.kind === "http-error") {
    return unavailableRateLimits("cursor", "usage_fetch_failed");
  }
  if (usage.kind === "invalid") {
    return unavailableRateLimits("cursor", "invalid_response");
  }
  return parseCursorUsagePayload(usage.body);
}

type CursorHttpResult =
  | { readonly kind: "ok"; readonly body: unknown }
  | { readonly kind: "auth-error" }
  | { readonly kind: "http-error" }
  | { readonly kind: "invalid" };

async function cursorPostJson(
  url: string,
  bearer: string,
  signal: AbortSignal,
): Promise<CursorHttpResult> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: "{}",
    signal,
  });
  if (response.status === 401 || response.status === 403) {
    return { kind: "auth-error" };
  }
  if (!response.ok) {
    return { kind: "http-error" };
  }
  try {
    return { kind: "ok", body: await response.json() };
  } catch {
    return { kind: "invalid" };
  }
}

function readCursorAccessToken(payload: unknown): string | null {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return null;
  }
  return readString(payload, "accessToken");
}

function cursorApiKeyFromEnv(): string | null {
  const value = process.env.CURSOR_API_KEY;
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cursorKeychainItemPresent(): boolean {
  if (process.platform !== "darwin") {
    return false;
  }
  try {
    execFileSync(
      "security",
      ["find-generic-password", "-s", CURSOR_KEYCHAIN_SERVICE],
      {
        timeout: 3_000,
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    return true;
  } catch {
    return false;
  }
}

function readCursorKeychainAccessToken(): string | null {
  if (process.platform !== "darwin") {
    return null;
  }
  try {
    const raw = execFileSync(
      "security",
      ["find-generic-password", "-s", CURSOR_KEYCHAIN_SERVICE, "-w"],
      {
        encoding: "utf8",
        timeout: 3_000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const token = raw.trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function readCodexRateLimits(
  binaryPath: string,
): Promise<ProviderRateLimitSnapshot> {
  return jsonRpcCall(
    binaryPath,
    ["app-server", "--listen", "stdio://"],
    [
      {
        method: "initialize",
        params: {
          protocolVersion: "2025-01-01",
          capabilities: { experimentalApi: true },
          clientInfo: { name: "traycer-host", version: HOST_VERSION },
        },
      },
      { method: "account/rateLimits/read", params: {} },
    ],
    {
      env: process.env,
      cwd: process.cwd(),
      timeoutMs: RATE_LIMIT_TIMEOUT_MS,
    },
  ).then(
    (outcome) => {
      if (outcome.kind !== "result") {
        return unavailableRateLimits("codex", "timeout");
      }
      return (
        parseCodexRateLimitsPayload(outcome.value) ??
        unavailableRateLimits("codex", "invalid_response")
      );
    },
    () => unavailableRateLimits("codex", "connection_failed"),
  );
}

function readGrokRateLimits(
  binaryPath: string | null,
): Promise<ProviderRateLimitSnapshot> {
  const mode = classifyGrokAuthMode();
  if (mode !== "oauth") {
    return Promise.resolve(
      unavailableRateLimits("grok", "rate_limits_not_available"),
    );
  }
  if (binaryPath === null) {
    return Promise.resolve(unavailableRateLimits("grok", "cli_not_found"));
  }
  return jsonRpcCall(
    binaryPath,
    ["agent", "stdio"],
    [
      { method: "initialize", params: GROK_ACP_INITIALIZE },
      { method: GROK_BILLING_METHOD, params: {} },
    ],
    {
      env: {
        ...process.env,
        GROK_OAUTH2_REFERRER: "traycer",
        GROK_DISABLE_AUTOUPDATER: "1",
        GROK_AUTO_UPDATE: "0",
      },
      cwd: process.cwd(),
      timeoutMs: RATE_LIMIT_TIMEOUT_MS,
    },
  ).then(
    (outcome) => {
      if (outcome.kind === "timeout") {
        return unavailableRateLimits("grok", "timeout");
      }
      if (outcome.kind === "error") {
        return mapGrokRpcError(outcome.message, outcome.code);
      }
      return (
        parseGrokBillingPayload(outcome.value) ??
        unavailableRateLimits("grok", "invalid_response")
      );
    },
    () => unavailableRateLimits("grok", "connection_failed"),
  );
}

function readClaudeRateLimits(
  binaryPath: string,
): Promise<ProviderRateLimitSnapshot> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(
        binaryPath,
        [
          "--output-format",
          "stream-json",
          "--input-format",
          "stream-json",
          "--verbose",
          "--setting-sources=user,project",
        ],
        {
          cwd: homedir(),
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "sdk-ts" },
        },
      );
    } catch {
      resolve(unavailableRateLimits("claude-code", "connection_failed"));
      return;
    }
    let buffer = "";
    let settled = false;
    let sentInit = false;
    let sentUsage = false;
    const finish = (snapshot: ProviderRateLimitSnapshot): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve(snapshot);
    };
    const timer: NodeJS.Timeout = setTimeout(() => {
      finish(unavailableRateLimits("claude-code", "timeout"));
    }, RATE_LIMIT_TIMEOUT_MS);
    const writeControl = (requestId: string, subtype: string): void => {
      child.stdin?.write(
        `${JSON.stringify({
          type: "control_request",
          request_id: requestId,
          request: { subtype },
        })}\n`,
      );
    };
    const sendInit = (): void => {
      if (sentInit) {
        return;
      }
      sentInit = true;
      writeControl(CLAUDE_INIT_REQUEST_ID, "initialize");
    };
    const sendUsage = (): void => {
      if (sentUsage) {
        return;
      }
      sentUsage = true;
      writeControl(CLAUDE_USAGE_REQUEST_ID, "get_usage");
    };
    sendInit();
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length === 0) {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed === null || typeof parsed !== "object") {
          continue;
        }
        const type = Reflect.get(parsed, "type");
        const subtype = Reflect.get(parsed, "subtype");
        if (type === "system" && subtype === "init") {
          sendInit();
          continue;
        }
        if (type !== "control_response") {
          continue;
        }
        const response = Reflect.get(parsed, "response");
        if (
          response === null ||
          typeof response !== "object" ||
          Array.isArray(response)
        ) {
          continue;
        }
        const requestId = readString(response, "request_id");
        const responseSubtype = Reflect.get(response, "subtype");
        if (responseSubtype === "error") {
          finish(unavailableRateLimits("claude-code", "usage_fetch_failed"));
          return;
        }
        if (requestId === CLAUDE_INIT_REQUEST_ID) {
          sendUsage();
          continue;
        }
        if (requestId === CLAUDE_USAGE_REQUEST_ID) {
          finish(parseClaudeUsagePayload(Reflect.get(response, "response")));
        }
      }
    });
    child.once("error", () => {
      finish(unavailableRateLimits("claude-code", "connection_failed"));
    });
    child.once("close", () => {
      finish(unavailableRateLimits("claude-code", "connection_failed"));
    });
  });
}

type JsonRpcCallResult =
  | { readonly kind: "result"; readonly value: unknown }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly code: number | null;
    }
  | { readonly kind: "timeout" };

function jsonRpcCall(
  binaryPath: string,
  args: readonly string[],
  calls: readonly { readonly method: string; readonly params: unknown }[],
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
    readonly timeoutMs: number;
  },
): Promise<JsonRpcCallResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(binaryPath, [...args], {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    let buffer = "";
    let nextIndex = 0;
    let settled = false;
    const finish = (value: JsonRpcCallResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve(value);
    };
    const timer: NodeJS.Timeout = setTimeout(() => {
      finish({ kind: "timeout" });
    }, options.timeoutMs);
    const sendNext = (): void => {
      const call = calls[nextIndex];
      if (call === undefined) {
        return;
      }
      child.stdin?.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: String(nextIndex + 1),
          method: call.method,
          params: call.params,
        })}\n`,
      );
    };
    sendNext();
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length === 0) {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed === null || typeof parsed !== "object") {
          continue;
        }
        const expectedId = String(nextIndex + 1);
        if (String(Reflect.get(parsed, "id")) !== expectedId) {
          continue;
        }
        const rpcError = Reflect.get(parsed, "error");
        if (rpcError !== undefined) {
          finish(readJsonRpcError(rpcError));
          return;
        }
        if (nextIndex === calls.length - 1) {
          finish({ kind: "result", value: Reflect.get(parsed, "result") });
          return;
        }
        nextIndex += 1;
        sendNext();
      }
    });
    child.once("error", reject);
    child.once("close", () => {
      finish({ kind: "timeout" });
    });
  });
}

function readJsonRpcError(value: unknown): JsonRpcCallResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "error", message: "rpc_error", code: null };
  }
  const message = readString(value, "message") ?? "rpc_error";
  return {
    kind: "error",
    message,
    code: readNumber(value, "code"),
  };
}

function mapGrokRpcError(
  message: string,
  code: number | null,
): ProviderRateLimitSnapshot {
  if (code === -32601 || message.startsWith(GROK_METHOD_MISSING_PREFIX)) {
    return unavailableRateLimits("grok", "sdk_incompatible");
  }
  if (
    code === -32000 ||
    message.startsWith(GROK_AUTH_REQUIRED_PREFIX) ||
    message.includes("Authentication required")
  ) {
    return unavailableRateLimits("grok", "rate_limits_not_available");
  }
  return unavailableRateLimits("grok", "usage_fetch_failed");
}

type GrokBillingConfig = {
  readonly periodType: string | null;
  readonly periodStart: number | null;
  readonly periodEnd: number | null;
  readonly billingPeriodStart: number | null;
  readonly billingPeriodEnd: number | null;
  readonly creditUsagePercent: number | null;
  readonly monthlyLimit: number | null;
  readonly onDemandCap: number | null;
  readonly onDemandUsed: number | null;
  readonly prepaidBalance: number | null;
};

function classifyGrokAuthMode(): "api-key" | "oauth" | "signed-out" {
  const apiKey = process.env.XAI_API_KEY;
  if (typeof apiKey === "string" && apiKey.trim().length > 0) {
    return "api-key";
  }
  try {
    const raw = readFileSync(join(homedir(), ".grok", "auth.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (hasGrokCredential(parsed)) {
      return "oauth";
    }
  } catch {
    return "signed-out";
  }
  return "signed-out";
}

function hasGrokCredential(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).some((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    return (
      isNonEmptyString(Reflect.get(entry, "refresh_token")) ||
      isNonEmptyString(Reflect.get(entry, "key"))
    );
  });
}

function parseGrokBillingConfig(value: unknown): GrokBillingConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return emptyGrokBillingConfig();
  }
  const currentPeriod = Reflect.get(value, "currentPeriod");
  const period =
    currentPeriod !== null &&
    typeof currentPeriod === "object" &&
    !Array.isArray(currentPeriod)
      ? currentPeriod
      : null;
  return {
    periodType: period === null ? null : readString(period, "type"),
    periodStart:
      period === null ? null : isoToEpochMs(Reflect.get(period, "start")),
    periodEnd:
      period === null ? null : isoToEpochMs(Reflect.get(period, "end")),
    billingPeriodStart: isoToEpochMs(Reflect.get(value, "billingPeriodStart")),
    billingPeriodEnd: isoToEpochMs(Reflect.get(value, "billingPeriodEnd")),
    creditUsagePercent: readNumericField(
      Reflect.get(value, "creditUsagePercent"),
    ),
    monthlyLimit: readNumericField(Reflect.get(value, "monthlyLimit")),
    onDemandCap: readNumericField(Reflect.get(value, "onDemandCap")),
    onDemandUsed: readNumericField(Reflect.get(value, "onDemandUsed")),
    prepaidBalance: readNumericField(Reflect.get(value, "prepaidBalance")),
  };
}

function emptyGrokBillingConfig(): GrokBillingConfig {
  return {
    periodType: null,
    periodStart: null,
    periodEnd: null,
    billingPeriodStart: null,
    billingPeriodEnd: null,
    creditUsagePercent: null,
    monthlyLimit: null,
    onDemandCap: null,
    onDemandUsed: null,
    prepaidBalance: null,
  };
}

function inferWeeklyZeroUsagePercent(config: GrokBillingConfig): number | null {
  if (
    config.periodType === GROK_WEEKLY_PERIOD_TYPE &&
    config.periodStart !== null &&
    config.periodEnd !== null &&
    config.billingPeriodStart !== null &&
    config.billingPeriodEnd !== null &&
    config.periodStart === config.billingPeriodStart &&
    config.periodEnd === config.billingPeriodEnd
  ) {
    return 0;
  }
  return null;
}

function synthesizeGrokPeriodWindow(config: GrokBillingConfig): {
  readonly usedPercent: number;
  readonly resetsAt: number | null;
  readonly durationMinutes: number | null;
} | null {
  const usedPercent =
    config.creditUsagePercent ?? inferWeeklyZeroUsagePercent(config);
  if (usedPercent === null || config.periodEnd === null) {
    return null;
  }
  const durationMinutes =
    config.periodStart === null
      ? null
      : (config.periodEnd - config.periodStart) / GROK_MS_PER_MINUTE;
  return {
    usedPercent,
    resetsAt: config.periodEnd,
    durationMinutes,
  };
}

function readNumericField(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return readNumber(value, "val");
}

function isoToEpochMs(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function buildCursorBucketWindow(
  plan: object | null,
  field: string,
  cycleStart: number | null,
  cycleEnd: number | null,
): {
  readonly usedPercent: number;
  readonly resetsAt: number | null;
  readonly durationMinutes: number | null;
} | null {
  const usedPercent = plan === null ? null : readNumber(plan, field);
  if (usedPercent === null) {
    return null;
  }
  const durationMinutes =
    cycleStart === null || cycleEnd === null || cycleEnd <= cycleStart
      ? null
      : (cycleEnd - cycleStart) / GROK_MS_PER_MINUTE;
  return {
    usedPercent,
    resetsAt: cycleEnd,
    durationMinutes,
  };
}

function usdFromCents(record: object | null, key: string): number | null {
  if (record === null) {
    return null;
  }
  const cents = readNumber(record, key);
  return cents === null ? null : cents / CURSOR_CENTS_PER_USD;
}

function readInt64(record: object, key: string): number | null {
  const value = Reflect.get(record, key);
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapCodexWindow(value: unknown): {
  readonly usedPercent: number;
  readonly resetsAt: number | null;
  readonly durationMinutes: number | null;
} | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const usedPercent = readNumber(value, "usedPercent");
  if (usedPercent === null) {
    return null;
  }
  const resetsAtSeconds = readNumber(value, "resetsAt");
  return {
    usedPercent,
    resetsAt: resetsAtSeconds === null ? null : resetsAtSeconds * 1000,
    durationMinutes: readNumber(value, "windowDurationMins"),
  };
}

function mapClaudeWindow(
  value: unknown,
  durationMinutes: number | null,
): {
  readonly usedPercent: number;
  readonly resetsAt: number | null;
  readonly durationMinutes: number | null;
} | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const usedPercent = readNumber(value, "utilization");
  if (usedPercent === null) {
    return null;
  }
  const resetsAtRaw = Reflect.get(value, "resets_at");
  let resetsAt: number | null = null;
  if (typeof resetsAtRaw === "string") {
    const parsed = Date.parse(resetsAtRaw);
    resetsAt = Number.isNaN(parsed) ? null : parsed;
  }
  return { usedPercent, resetsAt, durationMinutes };
}

function parseCodexCredits(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const hasCredits = Reflect.get(value, "hasCredits");
  const unlimited = Reflect.get(value, "unlimited");
  if (typeof hasCredits !== "boolean" || typeof unlimited !== "boolean") {
    return null;
  }
  return {
    hasCredits,
    unlimited,
    balance: readString(value, "balance"),
  };
}

function parseCodexIndividualLimit(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const limit = readString(value, "limit");
  const used = readString(value, "used");
  const remainingPercent = readNumber(value, "remainingPercent");
  const resetsAt = readNumber(value, "resetsAt");
  if (
    limit === null ||
    used === null ||
    remainingPercent === null ||
    resetsAt === null
  ) {
    return null;
  }
  return { limit, used, remainingPercent, resetsAt: resetsAt * 1000 };
}

function parseCodexResetCredits(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const availableCount = readNumber(value, "availableCount");
  if (availableCount === null) {
    return null;
  }
  const creditsRaw = Reflect.get(value, "credits");
  const credits = Array.isArray(creditsRaw)
    ? creditsRaw.flatMap((entry) => {
        if (
          entry === null ||
          typeof entry !== "object" ||
          Array.isArray(entry)
        ) {
          return [];
        }
        const id = readString(entry, "id");
        const grantedAt = readNumber(entry, "grantedAt");
        if (id === null || grantedAt === null) {
          return [];
        }
        const expiresAt = readNumber(entry, "expiresAt");
        return [
          {
            id,
            resetType:
              Reflect.get(entry, "resetType") === "codexRateLimits"
                ? "codexRateLimits"
                : "unknown",
            status:
              Reflect.get(entry, "status") === "available" ||
              Reflect.get(entry, "status") === "redeeming" ||
              Reflect.get(entry, "status") === "redeemed"
                ? Reflect.get(entry, "status")
                : "unknown",
            grantedAt: grantedAt * 1000,
            expiresAt: expiresAt === null ? null : expiresAt * 1000,
            title: readString(entry, "title"),
            description: readString(entry, "description"),
          },
        ];
      })
    : null;
  return { availableCount, credits };
}

function readString(record: object, key: string): string | null {
  const value = Reflect.get(record, key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(record: object, key: string): number | null {
  const value = Reflect.get(record, key);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
