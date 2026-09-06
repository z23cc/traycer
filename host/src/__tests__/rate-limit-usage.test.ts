import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  CURRENT_CLIENT_COMPATIBILITY_EPOCH,
  SERVES_EVERY_INSTALLED_MAJOR,
  splitConnectionManifest,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { startHost, type StartedHost } from "../start-host";
import {
  parseClaudeUsagePayload,
  parseCodexRateLimitsPayload,
  parseCursorUsagePayload,
  parseGrokBillingPayload,
} from "../gui/provider-rate-limits";

describe("provider rate-limit payload mapping", () => {
  it("maps a Codex account/rateLimits/read snapshot onto the GUI windows", () => {
    expect(
      parseCodexRateLimitsPayload({
        rateLimits: {
          planType: "plus",
          limitId: "plus-primary",
          limitName: "Plus",
          primary: {
            usedPercent: 42,
            windowDurationMins: 300,
            resetsAt: 1735689600,
          },
          secondary: null,
          credits: { hasCredits: false, unlimited: false, balance: null },
          individualLimit: null,
          rateLimitReachedType: null,
        },
        rateLimitsByLimitId: {},
        rateLimitResetCredits: { availableCount: 0, credits: [] },
      }),
    ).toMatchObject({
      provider: "codex",
      available: true,
      planType: "plus",
      primary: {
        usedPercent: 42,
        durationMinutes: 300,
        resetsAt: 1735689600000,
      },
    });
  });

  it("maps Claude get_usage windows onto fiveHour / sevenDay", () => {
    expect(
      parseClaudeUsagePayload({
        subscription_type: "pro",
        rate_limits_available: true,
        rate_limits: {
          five_hour: {
            utilization: 12,
            resets_at: "2026-09-06T12:00:00.000Z",
          },
          seven_day: { utilization: 4, resets_at: null },
          seven_day_opus: null,
          seven_day_sonnet: null,
          model_scoped: [],
          extra_usage: null,
        },
      }),
    ).toMatchObject({
      provider: "claude-code",
      available: true,
      subscriptionType: "pro",
      fiveHour: { usedPercent: 12, durationMinutes: 300 },
      sevenDay: { usedPercent: 4, durationMinutes: 10080 },
    });
  });

  it("maps a Grok _x.ai/billing snapshot onto the synthesized period window", () => {
    const periodStart = Date.parse("2026-09-04T12:02:04.709898+00:00");
    const periodEnd = Date.parse("2026-09-11T12:02:04.709898+00:00");
    expect(
      parseGrokBillingPayload({
        subscription_tier: "SuperGrok Heavy",
        config: {
          creditUsagePercent: 24,
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-09-04T12:02:04.709898+00:00",
            end: "2026-09-11T12:02:04.709898+00:00",
          },
          onDemandCap: { val: 0 },
          onDemandUsed: { val: 0 },
          prepaidBalance: { val: 0 },
          billingPeriodStart: "2026-09-04T12:02:04.709898+00:00",
          billingPeriodEnd: "2026-09-11T12:02:04.709898+00:00",
        },
      }),
    ).toEqual({
      provider: "grok",
      available: true,
      subscriptionTier: "SuperGrok Heavy",
      periodType: "USAGE_PERIOD_TYPE_WEEKLY",
      periodStart,
      periodEnd,
      period: {
        usedPercent: 24,
        resetsAt: periodEnd,
        durationMinutes: 10_080,
      },
      monthlyLimit: null,
      onDemandCap: 0,
      onDemandUsed: 0,
      prepaidBalance: 0,
    });
  });

  it("synthesizes a zero-usage Grok window when weekly bounds match billing bounds", () => {
    const periodStart = Date.parse("2026-09-04T12:00:00.000Z");
    const periodEnd = Date.parse("2026-09-11T12:00:00.000Z");
    expect(
      parseGrokBillingPayload({
        subscription_tier: "SuperGrok",
        config: {
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-09-04T12:00:00.000Z",
            end: "2026-09-11T12:00:00.000Z",
          },
          billingPeriodStart: "2026-09-04T12:00:00.000Z",
          billingPeriodEnd: "2026-09-11T12:00:00.000Z",
        },
      }),
    ).toMatchObject({
      provider: "grok",
      available: true,
      periodStart,
      periodEnd,
      period: {
        usedPercent: 0,
        resetsAt: periodEnd,
        durationMinutes: 10_080,
      },
    });
  });

  it("maps Cursor dashboard usage onto Cursor Models / Other Models windows", () => {
    const cycleStart = 1_786_579_256_000;
    const cycleEnd = 1_789_257_656_000;
    expect(
      parseCursorUsagePayload({
        billingCycleStart: String(cycleStart),
        billingCycleEnd: String(cycleEnd),
        displayMessage: "You've hit your usage limit",
        planUsage: {
          totalSpend: 183_660,
          limit: 40_000,
          bonusSpend: 143_660,
          autoPercentUsed: 44.54833333333333,
          apiPercentUsed: 100,
        },
        spendLimitUsage: { limitType: "user" },
      }),
    ).toEqual({
      provider: "cursor",
      available: true,
      cycleStart,
      cycleEnd,
      cursorModels: {
        usedPercent: 44.54833333333333,
        resetsAt: cycleEnd,
        durationMinutes: 44_640,
      },
      otherModels: {
        usedPercent: 100,
        resetsAt: cycleEnd,
        durationMinutes: 44_640,
      },
      includedLimitUsd: 400,
      usedUsd: 1_836.6,
      remainingUsd: null,
      bonusUsedUsd: 1_436.6,
      onDemandLimitType: "user",
      onDemandLimitUsd: null,
      onDemandUsedUsd: null,
      onDemandRemainingUsd: null,
      displayMessage: "You've hit your usage limit",
    });
  });
});

describe("host.getRateLimitUsage", () => {
  let started: StartedHost | null = null;
  let tempDir: string | null = null;

  afterEach(async () => {
    if (started !== null) {
      await started.close();
      started = null;
    }
    if (tempDir !== null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("returns the signed aperture snapshot so Traycer Inference can paint remaining tokens", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    const unscoped = await call(started.rpcUrl, {
      accountContext: { type: "PERSONAL" },
      profileId: null,
    });
    expect(unscoped).toEqual({
      totalTokens: 15,
      remainingTokens: 15,
      providerRateLimits: null,
    });
    const scoped = await call(started.rpcUrl, {
      accountContext: { type: "PERSONAL" },
      profileId: null,
      providerId: "amp",
    });
    expect(scoped).toEqual({
      totalTokens: 0,
      remainingTokens: 0,
      providerRateLimits: {
        provider: "amp",
        available: false,
        reason: "unsupported_provider",
      },
    });
  });
});

async function call(url: string, params: unknown): Promise<unknown> {
  const clientManifests = splitConnectionManifest(
    hostRpcRegistry,
    RELEASED_FLOOR_METHOD_NAMES,
    SERVES_EVERY_INSTALLED_MAJOR,
  );
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const frames: unknown[] = [];
  const done = new Promise<void>((resolve, reject) => {
    socket.on("message", (data) => {
      frames.push(JSON.parse(String(data)));
      if (frames.length === 1) {
        socket.send(
          JSON.stringify({
            kind: "request",
            requestId: "1",
            method: "host.getRateLimitUsage",
            schemaVersion: { major: 4, minor: 0 },
            params,
          }),
        );
      }
    });
    socket.once("close", () => resolve());
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      kind: "open",
      token: "local-dev-token",
      manifest: clientManifests.manifest,
      optionalManifest: clientManifests.optionalManifest,
      clientIdentity: {
        kind: "cli",
        compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
        appVersion: "0.1.0",
      },
    }),
  );
  await done;
  const response = frames[1];
  if (
    response === null ||
    typeof response !== "object" ||
    !("kind" in response) ||
    response.kind !== "response"
  ) {
    throw new Error(`expected response, got ${JSON.stringify(response)}`);
  }
  const record = response as Record<string, unknown>;
  if (record.error !== null) {
    throw new Error(`RPC error: ${JSON.stringify(record.error)}`);
  }
  return record.result;
}
