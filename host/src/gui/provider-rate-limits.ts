import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderId } from "@traycer/protocol/host/provider-ids";
import type { ProviderApiKeyState } from "@traycer/protocol/host/provider-schemas";
import { rateLimitCapableProviderIdSchema } from "@traycer/protocol/host/rate-limit/schemas";
import type { HostRuntime } from "../runtime";
import type { StoredProviderOverride } from "../store/host-store";
import { HOST_VERSION } from "../version";
import { providerCliIdentity, spawnEnvForProvider } from "../providers/service";

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
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const HUGGINGFACE_USAGE_URL =
  "https://huggingface.co/api/settings/billing/usage-v2";
const HUGGINGFACE_USAGE_DAYS = 35;
const HUGGINGFACE_NANO_USD = 1_000_000_000;
const KILO_API_ORIGIN = "https://api.kilo.ai";
const KILO_PROFILE_URL = `${KILO_API_ORIGIN}/api/profile`;
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const OPENCODE_FIVE_HOUR_MINUTES = 300;
const API_KEY_ENV: { readonly [id in ProviderId]?: readonly string[] } = {
  cursor: ["CURSOR_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  huggingface: ["HF_TOKEN", "HUGGINGFACE_API_KEY"],
  kiro: ["KIRO_API_KEY"],
  droid: ["FACTORY_API_KEY"],
  amp: ["AMP_API_KEY"],
  kilocode: ["KILO_API_KEY"],
};

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
  const storedApiKey = storedApiKeyFor(runtime, capable.data);
  if (capable.data === "cursor") {
    return readCursorRateLimits(storedApiKey);
  }
  if (capable.data === "openrouter") {
    return readOpenRouterRateLimits(storedApiKey);
  }
  if (capable.data === "huggingface") {
    return readHuggingFaceRateLimits(storedApiKey);
  }
  if (capable.data === "kilocode") {
    return readKiloCodeRateLimits(storedApiKey);
  }
  if (capable.data === "opencode") {
    return readOpenCodeGoRateLimits();
  }
  if (capable.data === "grok") {
    const identity = providerCliIdentity(runtime.store, "grok");
    return readGrokRateLimits(
      identity.path,
      overlaySpawnEnv(runtime, "grok", {
        GROK_OAUTH2_REFERRER: "traycer",
        GROK_DISABLE_AUTOUPDATER: "1",
        GROK_AUTO_UPDATE: "0",
      }),
    );
  }
  if (capable.data === "codex" || capable.data === "claude-code") {
    const identity = providerCliIdentity(runtime.store, capable.data);
    if (identity.path === null) {
      return unavailableRateLimits(capable.data, "cli_not_found");
    }
    if (capable.data === "codex") {
      return readCodexRateLimits(
        identity.path,
        overlaySpawnEnv(runtime, "codex", {}),
      );
    }
    return readClaudeRateLimits(
      identity.path,
      overlaySpawnEnv(runtime, "claude-code", {
        CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      }),
    );
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

export function storedApiKeyFromOverride(
  override: StoredProviderOverride | null,
): string | null {
  if (override === null || override.apiKey === null) {
    return null;
  }
  const trimmed = override.apiKey.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function apiKeyStateForProvider(
  providerId: ProviderId,
  storedApiKey: string | null,
): ProviderApiKeyState {
  if (API_KEY_ENV[providerId] === undefined) {
    return { supported: false, configured: false, source: null };
  }
  const resolved = resolveStoredOrEnvApiKey(providerId, storedApiKey);
  if (resolved === null) {
    return { supported: true, configured: false, source: null };
  }
  return { supported: true, configured: true, source: resolved.source };
}

export function credentialPresent(
  providerId: ProviderId,
  storedApiKey: string | null,
): boolean {
  if (resolveStoredOrEnvApiKey(providerId, storedApiKey) !== null) {
    return true;
  }
  if (providerId === "codex") {
    return existsSync(join(homedir(), ".codex", "auth.json"));
  }
  if (providerId === "claude-code") {
    return (
      existsSync(join(homedir(), ".claude", ".credentials.json")) ||
      existsSync(join(homedir(), ".claude.json"))
    );
  }
  if (providerId === "grok") {
    const mode = classifyGrokAuthMode();
    return mode === "oauth" || mode === "api-key";
  }
  if (providerId === "cursor") {
    return cursorKeychainItemPresent();
  }
  if (providerId === "kilocode") {
    return kiloCodeBearerToken() !== null;
  }
  if (providerId === "opencode") {
    return openCodeGoApiKey() !== null;
  }
  return false;
}

export function parseOpenRouterRateLimitsPayload(
  keyBody: unknown,
  creditsBody: unknown,
): ProviderRateLimitSnapshot | null {
  const key = readOpenRouterKeyData(keyBody);
  const credits = readOpenRouterCreditsData(creditsBody);
  if (key === null || credits === null) {
    return null;
  }
  const totalCredits = credits.totalCredits;
  const totalUsage = credits.totalUsage;
  return {
    provider: "openrouter",
    available: true,
    limit: key.limit,
    limitRemaining: key.limitRemaining,
    dailySpend: key.dailySpend,
    weeklySpend: key.weeklySpend,
    monthlySpend: key.monthlySpend,
    totalCredits,
    totalUsage,
    balance:
      totalCredits === null || totalUsage === null
        ? null
        : totalCredits - totalUsage,
  };
}

export function parseHuggingFaceUsagePayload(
  payload: unknown,
): ProviderRateLimitSnapshot | null {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const usage = Reflect.get(payload, "usage");
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
    return null;
  }
  const inference = Reflect.get(usage, "inferenceProviders");
  if (
    inference === null ||
    typeof inference !== "object" ||
    Array.isArray(inference)
  ) {
    return null;
  }
  const usedUsd = nanoUsdToUsd(inference, "usedNanoUsd");
  if (usedUsd === null) {
    return null;
  }
  const includedUsd = nanoUsdToUsd(inference, "includedNanoUsd");
  const limitUsd = nanoUsdToUsd(inference, "limitNanoUsd");
  return {
    provider: "huggingface",
    available: true,
    includedUsd,
    usedUsd,
    remainingIncludedUsd: remainingUsd(includedUsd, usedUsd),
    limitUsd,
    remainingLimitUsd: remainingUsd(limitUsd, usedUsd),
    numRequests: readNumber(inference, "numRequests"),
    periodStart: readString(inference, "periodStart"),
    periodEnd: readString(inference, "periodEnd"),
  };
}

export function parseOpenCodeGoUsagePayload(
  payload: unknown,
  credentialGeneration: string,
): ProviderRateLimitSnapshot | null {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const usage = Reflect.get(payload, "usage");
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
    return null;
  }
  const fiveHour = parseOpenCodeGoWindow(
    Reflect.get(usage, "rolling"),
    OPENCODE_FIVE_HOUR_MINUTES,
  );
  const weekly = parseOpenCodeGoWindow(
    Reflect.get(usage, "weekly"),
    CLAUDE_SEVEN_DAY_MINUTES,
  );
  const monthly = parseOpenCodeGoWindow(Reflect.get(usage, "monthly"), null);
  if (fiveHour === null || weekly === null || monthly === null) {
    return null;
  }
  return {
    provider: "opencode",
    available: true,
    credentialGeneration,
    fiveHour,
    weekly,
    monthly,
  };
}

export function parseKiloCodeUsagePayload(
  creditBalance: number | null,
  passState: string | null,
): ProviderRateLimitSnapshot {
  return {
    provider: "kilocode",
    available: true,
    creditBalance,
    passState,
  };
}

function readCursorRateLimits(
  storedApiKey: string | null,
): Promise<ProviderRateLimitSnapshot> {
  const controller = new AbortController();
  const timer: NodeJS.Timeout = setTimeout(() => {
    controller.abort();
  }, RATE_LIMIT_TIMEOUT_MS);
  return fetchCursorUsage(storedApiKey, controller.signal).then(
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
  storedApiKey: string | null,
  signal: AbortSignal,
): Promise<ProviderRateLimitSnapshot> {
  const apiKey =
    resolveStoredOrEnvApiKey("cursor", storedApiKey)?.value ?? null;
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

function storedApiKeyFor(
  runtime: HostRuntime,
  providerId: string,
): string | null {
  const row = runtime.store
    .snapshot()
    .providers.find((entry) => entry.providerId === providerId);
  return storedApiKeyFromOverride(row === undefined ? null : row);
}

function resolveStoredOrEnvApiKey(
  providerId: ProviderId,
  storedApiKey: string | null,
): { readonly value: string; readonly source: "stored" | "env" } | null {
  if (storedApiKey !== null) {
    return { value: storedApiKey, source: "stored" };
  }
  const names = API_KEY_ENV[providerId];
  if (names === undefined) {
    return null;
  }
  for (const name of names) {
    const value = process.env[name];
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return { value: trimmed, source: "env" };
    }
  }
  return null;
}

function readOpenRouterRateLimits(
  storedApiKey: string | null,
): Promise<ProviderRateLimitSnapshot> {
  const resolved = resolveStoredOrEnvApiKey("openrouter", storedApiKey);
  if (resolved === null) {
    return Promise.resolve(
      unavailableRateLimits("openrouter", "rate_limits_not_available"),
    );
  }
  return withHttpTimeout(
    "openrouter",
    (signal) => fetchOpenRouterUsage(resolved.value, signal),
    null,
  );
}

async function fetchOpenRouterUsage(
  apiKey: string,
  signal: AbortSignal,
): Promise<ProviderRateLimitSnapshot> {
  const [keyResult, creditsResult] = await Promise.all([
    httpGetJson(OPENROUTER_KEY_URL, apiKey, signal),
    httpGetJson(OPENROUTER_CREDITS_URL, apiKey, signal),
  ]);
  if (
    keyResult.kind === "auth-error" ||
    keyResult.kind === "forbidden" ||
    creditsResult.kind === "auth-error" ||
    creditsResult.kind === "forbidden"
  ) {
    return unavailableRateLimits("openrouter", "rate_limits_not_available");
  }
  if (keyResult.kind !== "ok" || creditsResult.kind !== "ok") {
    return unavailableRateLimits("openrouter", "invalid_response");
  }
  return (
    parseOpenRouterRateLimitsPayload(keyResult.body, creditsResult.body) ??
    unavailableRateLimits("openrouter", "invalid_response")
  );
}

function readHuggingFaceRateLimits(
  storedApiKey: string | null,
): Promise<ProviderRateLimitSnapshot> {
  const resolved = resolveStoredOrEnvApiKey("huggingface", storedApiKey);
  if (resolved === null) {
    return Promise.resolve(
      unavailableRateLimits("huggingface", "rate_limits_not_available"),
    );
  }
  return withHttpTimeout(
    "huggingface",
    (signal) => fetchHuggingFaceUsage(resolved.value, signal),
    null,
  );
}

async function fetchHuggingFaceUsage(
  apiKey: string,
  signal: AbortSignal,
): Promise<ProviderRateLimitSnapshot> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const startDate = nowSeconds - HUGGINGFACE_USAGE_DAYS * 24 * 60 * 60;
  const url = `${HUGGINGFACE_USAGE_URL}?startDate=${String(startDate)}&endDate=${String(nowSeconds)}`;
  const result = await httpGetJson(url, apiKey, signal);
  if (result.kind === "auth-error" || result.kind === "forbidden") {
    return unavailableRateLimits("huggingface", "rate_limits_not_available");
  }
  if (result.kind !== "ok") {
    return unavailableRateLimits("huggingface", "invalid_response");
  }
  return (
    parseHuggingFaceUsagePayload(result.body) ??
    unavailableRateLimits("huggingface", "invalid_response")
  );
}

function readKiloCodeRateLimits(
  storedApiKey: string | null,
): Promise<ProviderRateLimitSnapshot> {
  const bearer =
    resolveStoredOrEnvApiKey("kilocode", storedApiKey)?.value ??
    kiloCodeBearerToken();
  if (bearer === null) {
    return Promise.resolve(
      unavailableRateLimits("kilocode", "rate_limits_not_available"),
    );
  }
  return withHttpTimeout(
    "kilocode",
    (signal) => fetchKiloCodeUsage(bearer, signal),
    null,
  );
}

async function fetchKiloCodeUsage(
  bearer: string,
  signal: AbortSignal,
): Promise<ProviderRateLimitSnapshot> {
  const profile = await httpGetJson(KILO_PROFILE_URL, bearer, signal);
  if (profile.kind === "auth-error" || profile.kind === "forbidden") {
    return unavailableRateLimits("kilocode", "rate_limits_not_available");
  }
  const results: HttpGetResult[] = [profile];
  let creditBalance =
    profile.kind === "ok" ? readKiloCreditBalance(profile.body) : null;
  let passState =
    profile.kind === "ok" ? readKiloPassState(profile.body) : null;
  if (creditBalance === null) {
    const credits = await httpGetJson(
      kiloTrpcUrl("user.getCreditBlocks"),
      bearer,
      signal,
    );
    results.push(credits);
    if (credits.kind === "ok") {
      creditBalance = readKiloCreditBalance(unwrapTrpc(credits.body));
    }
  }
  if (passState === null) {
    const pass = await httpGetJson(
      kiloTrpcUrl("kiloPass.getState"),
      bearer,
      signal,
    );
    results.push(pass);
    if (pass.kind === "ok") {
      passState = readKiloPassState(unwrapTrpc(pass.body));
    }
  }
  if (results.some((row) => row.kind === "ok")) {
    return parseKiloCodeUsagePayload(creditBalance, passState);
  }
  return unavailableRateLimits(
    "kilocode",
    results.some((row) => row.kind === "auth-error" || row.kind === "forbidden")
      ? "rate_limits_not_available"
      : "invalid_response",
  );
}

function readOpenCodeGoRateLimits(): Promise<ProviderRateLimitSnapshot> {
  const apiKey = openCodeGoApiKey();
  if (apiKey === null) {
    return Promise.resolve(
      unavailableOpenCode("rate_limits_not_available", "none"),
    );
  }
  const generation = createHash("sha256").update(apiKey).digest("hex");
  return withHttpTimeout(
    "opencode",
    async (signal) => {
      const result = await httpGetJson(OPENCODE_GO_USAGE_URL, apiKey, signal);
      if (result.kind === "auth-error") {
        return unavailableOpenCode("insufficient_permissions", generation);
      }
      if (result.kind === "forbidden") {
        return unavailableOpenCode("rate_limits_not_available", generation);
      }
      if (result.kind !== "ok") {
        return unavailableOpenCode("usage_fetch_failed", generation);
      }
      return (
        parseOpenCodeGoUsagePayload(result.body, generation) ??
        unavailableOpenCode("usage_fetch_failed", generation)
      );
    },
    generation,
  );
}

function withHttpTimeout(
  providerId: string,
  run: (signal: AbortSignal) => Promise<ProviderRateLimitSnapshot>,
  credentialGeneration: string | null,
): Promise<ProviderRateLimitSnapshot> {
  const controller = new AbortController();
  const timer: NodeJS.Timeout = setTimeout(() => {
    controller.abort();
  }, RATE_LIMIT_TIMEOUT_MS);
  return run(controller.signal).then(
    (snapshot) => {
      clearTimeout(timer);
      return snapshot;
    },
    () => {
      clearTimeout(timer);
      const reason = controller.signal.aborted
        ? "timeout"
        : "connection_failed";
      if (providerId === "opencode" && credentialGeneration !== null) {
        return unavailableOpenCode(reason, credentialGeneration);
      }
      return unavailableRateLimits(providerId, reason);
    },
  );
}

function unavailableOpenCode(
  reason: string,
  credentialGeneration: string,
): ProviderRateLimitSnapshot {
  return {
    provider: "opencode",
    available: false,
    reason,
    credentialGeneration,
  };
}

type HttpGetResult =
  | { readonly kind: "ok"; readonly body: unknown }
  | { readonly kind: "auth-error" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "http-error" }
  | { readonly kind: "invalid" };

async function httpGetJson(
  url: string,
  bearer: string,
  signal: AbortSignal,
): Promise<HttpGetResult> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${bearer}`,
      Accept: "application/json",
    },
    redirect: "error",
    signal,
  });
  if (response.status === 401) {
    return { kind: "auth-error" };
  }
  if (response.status === 403) {
    return { kind: "forbidden" };
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

function kiloTrpcUrl(method: string): string {
  return `${KILO_API_ORIGIN}/api/trpc/${method}?input=${encodeURIComponent(JSON.stringify({}))}`;
}

function unwrapTrpc(payload: unknown): unknown {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return payload;
  }
  const result = Reflect.get(payload, "result");
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return payload;
  }
  const data = Reflect.get(result, "data");
  if (
    data !== null &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    "json" in data
  ) {
    return Reflect.get(data, "json");
  }
  return data;
}

function readKiloCreditBalance(payload: unknown): number | null {
  if (typeof payload === "number" && Number.isFinite(payload)) {
    return payload;
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const direct =
    readNumber(payload, "creditBalance") ??
    readNumber(payload, "balance") ??
    readNumber(payload, "credits");
  if (direct !== null) {
    return direct;
  }
  const nested = Reflect.get(payload, "data");
  return readKiloCreditBalance(nested);
}

function readKiloPassState(payload: unknown): string | null {
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const direct =
    readString(payload, "passState") ?? readString(payload, "state");
  if (direct !== null) {
    return direct;
  }
  return readKiloPassState(Reflect.get(payload, "data"));
}

function kiloCodeBearerToken(): string | null {
  const envContent = process.env.KILO_AUTH_CONTENT;
  if (typeof envContent === "string" && envContent.trim().length > 0) {
    const fromEnv = kiloBearerFromAuthStore(parseJsonObject(envContent.trim()));
    if (fromEnv !== null) {
      return fromEnv;
    }
  }
  return kiloBearerFromAuthStore(
    readJsonFile(join(xdgDataHome(), "kilo", "auth.json")),
  );
}

function kiloBearerFromAuthStore(parsed: unknown): string | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const kilo = kiloAuthEntry(Reflect.get(parsed, "kilo"));
  if (kilo === null) {
    return null;
  }
  if (kilo.type === "api") {
    return kilo.key;
  }
  return kilo.access;
}

function kiloAuthEntry(
  value: unknown,
):
  | { readonly type: "api"; readonly key: string }
  | { readonly type: "oauth"; readonly access: string | null }
  | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const type = Reflect.get(value, "type");
  if (type === "api") {
    const key = readString(value, "key");
    return key === null ? null : { type: "api", key };
  }
  if (type === "oauth") {
    return { type: "oauth", access: readString(value, "access") };
  }
  return null;
}

function openCodeGoApiKey(): string | null {
  const envContent = process.env.OPENCODE_AUTH_CONTENT;
  if (typeof envContent === "string" && envContent.trim().length > 0) {
    const fromEnv = openCodeGoKeyFromAuth(parseJsonObject(envContent.trim()));
    if (fromEnv !== null) {
      return fromEnv;
    }
  }
  return openCodeGoKeyFromAuth(
    readJsonFile(join(xdgDataHome(), "opencode", "auth.json")),
  );
}

function openCodeGoKeyFromAuth(parsed: unknown): string | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const go = Reflect.get(parsed, "opencode-go");
  if (go === null || typeof go !== "object" || Array.isArray(go)) {
    return null;
  }
  if (Reflect.get(go, "type") !== "api") {
    return null;
  }
  return readString(go, "key");
}

function xdgDataHome(): string {
  const override = process.env.XDG_DATA_HOME;
  if (typeof override === "string" && override.trim().length > 0) {
    return override.trim();
  }
  return join(homedir(), ".local", "share");
}

function readJsonFile(path: string): unknown {
  try {
    return parseJsonObject(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function parseJsonObject(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readOpenRouterKeyData(payload: unknown): {
  readonly limit: number | null;
  readonly limitRemaining: number | null;
  readonly dailySpend: number | null;
  readonly weeklySpend: number | null;
  readonly monthlySpend: number | null;
} | null {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const data = Reflect.get(payload, "data");
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  return {
    limit: readNumber(data, "limit"),
    limitRemaining: readNumber(data, "limit_remaining"),
    dailySpend: readNumber(data, "usage_daily"),
    weeklySpend: readNumber(data, "usage_weekly"),
    monthlySpend: readNumber(data, "usage_monthly"),
  };
}

function readOpenRouterCreditsData(payload: unknown): {
  readonly totalCredits: number | null;
  readonly totalUsage: number | null;
} | null {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const data = Reflect.get(payload, "data");
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  return {
    totalCredits: readNumber(data, "total_credits"),
    totalUsage: readNumber(data, "total_usage"),
  };
}

function parseOpenCodeGoWindow(
  value: unknown,
  durationMinutes: number | null,
): {
  readonly status: "ok" | "rate-limited";
  readonly usedPercent: number;
  readonly resetsAt: number | null;
  readonly durationMinutes: number | null;
} | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const status = Reflect.get(value, "status");
  const usedPercent = readNumber(value, "percent");
  if (
    (status !== "ok" && status !== "rate-limited") ||
    usedPercent === null ||
    usedPercent < 0 ||
    usedPercent > 100
  ) {
    return null;
  }
  const resetsAtRaw = readString(value, "resetsAt");
  if (resetsAtRaw === null) {
    return null;
  }
  const resetsAt = Date.parse(resetsAtRaw);
  if (!Number.isFinite(resetsAt)) {
    return null;
  }
  return { status, usedPercent, resetsAt, durationMinutes };
}

function nanoUsdToUsd(record: object, key: string): number | null {
  const nano = readNumber(record, key);
  return nano === null ? null : nano / HUGGINGFACE_NANO_USD;
}

function remainingUsd(base: number | null, used: number): number | null {
  return base === null ? null : Math.max(0, base - used);
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

function overlaySpawnEnv(
  runtime: HostRuntime,
  providerId: ProviderId,
  extra: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return { ...spawnEnvForProvider(runtime.store, providerId), ...extra };
}

function readCodexRateLimits(
  binaryPath: string,
  env: NodeJS.ProcessEnv,
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
      env,
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
  env: NodeJS.ProcessEnv,
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
      env,
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
  env: NodeJS.ProcessEnv,
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
          env,
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
