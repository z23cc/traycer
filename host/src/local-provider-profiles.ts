import type {
  AgentGetProviderProfileRateLimitsResponse,
  AgentListProviderProfilesResponse,
  AgentProviderProfileSummary,
} from "@traycer/protocol/host/agent/profiles";
import type {
  AgentFacingHarnessId,
  ConcreteProfileSelection,
} from "@traycer/protocol/host/agent/shared";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";

const AMBIENT_PROFILE: AgentProviderProfileSummary = {
  selection: { kind: "ambient" },
  label: "Terminal account",
  authStatus: "unknown",
  rateLimitStatus: "unknown",
  usageUpdatedAt: null,
  isEffectiveLastUsed: true,
};

export function localProviderProfilesFor(
  harnessId: AgentFacingHarnessId,
): AgentListProviderProfilesResponse {
  return {
    providerId: providerIdForHarness(harnessId),
    profiles: [AMBIENT_PROFILE],
  };
}

export function localProviderRateLimitsFor(
  harnessId: AgentFacingHarnessId,
  selection: ConcreteProfileSelection,
): AgentGetProviderProfileRateLimitsResponse {
  const providerId = providerIdForHarness(harnessId);
  if (selection.kind === "profile") {
    throw new Error(
      `No profile "${selection.profileId}" is registered for provider "${providerId}".`,
    );
  }
  return {
    rateLimits: {
      provider: providerId,
      available: false,
      reason: "rate_limits_not_available",
    },
    usageUpdatedAt: null,
  };
}

function providerIdForHarness(harnessId: AgentFacingHarnessId): ProviderId {
  return harnessId === "claude" ? "claude-code" : harnessId;
}
