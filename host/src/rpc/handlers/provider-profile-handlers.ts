import {
  agentGetProviderProfileRateLimitsRequestSchema,
  agentListProviderProfilesRequestSchema,
} from "@traycer/protocol/host/agent/profiles";
import type { ProviderId } from "@traycer/protocol/host/provider-ids";
import {
  PROVIDER_DISPLAY_NAMES,
  providersAwaitMcpAuthRequestSchema,
  providersAwaitModelProviderAuthRequestSchema,
  providersCancelMcpAuthRequestSchema,
  providersCancelModelProviderAuthRequestSchema,
  providersListModelProvidersRequestSchema,
  providersMcpAuthRequestSchema,
  providersModelProviderAuthRequestSchema,
  providersSetProfileEnabledRequestSchema,
} from "@traycer/protocol/host/provider-schemas";
import {
  providersConsumeRateLimitResetCreditRequestSchema,
  providersRefreshProfileStatusRequestSchema,
} from "@traycer/protocol/host/rate-limit/schemas";
import { providerIdForHarness } from "../../gui/harness-map";
import {
  credentialPresent,
  readProviderRateLimits,
  storedApiKeyFromOverride,
} from "../../gui/provider-rate-limits";
import {
  providerCliIdentity,
  setProviderEnabled,
} from "../../providers/service";
import type { HostRuntime } from "../../runtime";
import type { RpcHandler, RpcHandlerResult } from "./types";

/**
 * Provider PROFILES, of which this host has exactly one kind: the ambient CLI
 * login.
 *
 * A managed profile is a Traycer-held subscription - minted, refreshed and
 * billed by a cloud this host does not talk to - so the managed half of every
 * method here is unreachable by construction, the same way `managedCommands`
 * is empty because no tool can create one. What is left is real and local: the
 * credential files each vendor CLI already wrote, which this host reads for
 * `providers.list` and `host.getRateLimitUsage` today.
 *
 * The analogs these replace were not merely vague, they answered questions
 * wrongly: `listProviderProfiles` said `claude-code` whatever harness was
 * asked about and reported no logins at all; `getProviderProfileRateLimits`
 * and `refreshProfileStatus` both answered `available: true` with every limit
 * null, which reads as "you are well within your limits"; `setProfileEnabled`
 * echoed a profile called `oss` and ignored the flag it was handed; and
 * `consumeRateLimitResetCredit` answered `reset` - telling the user their
 * Codex rate limit had just been cleared and a credit spent.
 *
 * The GUI addresses the ambient login by the literal profile id `"ambient"`
 * (`profileId ?? "ambient"` at its call sites), which is the sentinel every
 * method here narrows on.
 */
const AMBIENT = "ambient";

function noSuchProfile(
  providerId: ProviderId,
  profileId: string,
): {
  readonly ok: false;
  readonly code: "RPC_ERROR";
  readonly message: string;
} {
  return {
    ok: false,
    code: "RPC_ERROR",
    message: `No managed profile '${profileId}' for provider '${providerId}'. This host serves the ambient CLI login only.`,
  };
}

/**
 * One row: the harness's provider's ambient login. `selection.kind` is the
 * contract's sole ambient-vs-managed discriminant, so an ambient-only answer
 * is expressible without inventing a subscription.
 */
export const handleAgentListProviderProfiles: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = agentListProviderProfilesRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const providerId = providerIdForHarness(parsed.data.harnessId);
  const limits = await readProviderRateLimits(runtime, providerId, null);
  return {
    ok: true,
    result: {
      providerId,
      profiles: [
        {
          selection: { kind: "ambient" },
          label: PROVIDER_DISPLAY_NAMES[providerId],
          authStatus: ambientAuthStatus(runtime, providerId),
          // The enum is a judgement about headroom, and a reading this host
          // could not take is `unknown` rather than `ok`.
          rateLimitStatus: limits.available === true ? "ok" : "unknown",
          usageUpdatedAt: null,
          // There is one profile, so it is the one last used by definition.
          isEffectiveLastUsed: true,
        },
      ],
    },
  };
};

export const handleAgentGetProviderProfileRateLimits: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed =
    agentGetProviderProfileRateLimitsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const providerId = providerIdForHarness(parsed.data.harnessId);
  if (parsed.data.profileSelection.kind === "profile") {
    return noSuchProfile(providerId, parsed.data.profileSelection.profileId);
  }
  return {
    ok: true,
    result: {
      rateLimits: await readProviderRateLimits(runtime, providerId, null),
      // The read is taken now and cached nowhere, so there is no earlier
      // moment to date it from.
      usageUpdatedAt: null,
    },
  };
};

/** The same read `host.getRateLimitUsage` serves, addressed by profile. */
export const handleProvidersRefreshProfileStatus: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = providersRefreshProfileStatusRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  if (parsed.data.profileId !== AMBIENT) {
    return noSuchProfile(parsed.data.providerId, parsed.data.profileId);
  }
  return {
    ok: true,
    result: {
      providerRateLimits: await readProviderRateLimits(
        runtime,
        parsed.data.providerId,
        null,
      ),
    },
  };
};

/**
 * Disabling the ambient login IS disabling the provider here - there is one
 * login and no second one to fall back to - so this writes the same stored
 * flag `providers.setEnabled` writes, rather than a parallel field nothing
 * else reads.
 */
export const handleProvidersSetProfileEnabled: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = providersSetProfileEnabledRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  if (parsed.data.profileId !== AMBIENT) {
    return noSuchProfile(parsed.data.providerId, parsed.data.profileId);
  }
  const state = await setProviderEnabled(
    runtime.store,
    parsed.data.providerId,
    parsed.data.enabled,
  );
  if (state === null) {
    return { ok: false, code: "RPC_ERROR", message: "Provider catalog miss" };
  }
  return {
    ok: true,
    result: { profileId: AMBIENT, enabled: parsed.data.enabled },
  };
};

/**
 * A reset credit is redeemed against the Codex account through a backend this
 * host does not call, so no outcome in the enum is true of it: `noCredit`
 * would deny credits the user can see on their own account, and `reset` -
 * which the analog answered - claims a limit was cleared and a credit spent.
 */
export const handleProvidersConsumeRateLimitResetCredit: RpcHandler = (
  params,
) => {
  const parsed =
    providersConsumeRateLimitResetCreditRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return {
    ok: false,
    code: "RPC_ERROR",
    message:
      "This host cannot redeem a Codex rate-limit reset credit; redeem it from the Codex CLI or account page.",
  };
};

/**
 * Model providers are the `opencode` settings tab's managed servers, a
 * capability this host does not advertise. `capability_unavailable` is the
 * contract's own word for that; the analog's `{ok: true, providers: []}` said
 * the tab had been read and found empty.
 */
export const handleProvidersListModelProviders: RpcHandler = (params) => {
  const parsed = providersListModelProvidersRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return {
    ok: true,
    result: {
      result: {
        ok: false,
        code: "capability_unavailable",
        detail: "This host manages no model provider servers.",
      },
    },
  };
};

/**
 * Authenticated when the vendor's own credential file is there, configured
 * when its CLI is but the credential is not, and unknown when neither is -
 * the same ladder `providers.list` walks.
 */
function ambientAuthStatus(
  runtime: HostRuntime,
  providerId: ProviderId,
): "authenticated" | "configured" | "unknown" {
  const row = runtime.store
    .snapshot()
    .providers.find((entry) => entry.providerId === providerId);
  const storedApiKey = storedApiKeyFromOverride(row === undefined ? null : row);
  if (credentialPresent(providerId, storedApiKey)) {
    return "authenticated";
  }
  return providerCliIdentity(runtime.store, providerId).path === null
    ? "unknown"
    : "configured";
}

/**
 * The two auth flows, both answered `unsupported`.
 *
 * An MCP server's credential lives in the provider CLI's own config, which
 * this host does not manage - `providers.nativeMutate` already refuses that
 * whole surface with `unsupported_action` - and a model provider's credential
 * is connected through the managed server this host does not run. Both result
 * unions carry an `unsupported` arm with a reason, which is the answer.
 *
 * The analog picked the FIRST arm instead: `{kind: "authorizationUrl",
 * authorizationUrl: "oss"}`. That is not a vague answer, it is an OAuth flow
 * the client would start by opening `oss` in a browser.
 */
function unsupportedAuth(reason: string): {
  readonly ok: true;
  readonly result: {
    readonly result: { readonly kind: "unsupported"; readonly reason: string };
  };
} {
  return { ok: true, result: { result: { kind: "unsupported", reason } } };
}

const MCP_REASON =
  "This host does not manage MCP server credentials; each provider CLI owns its own config.";
const MODEL_PROVIDER_REASON =
  "This host runs no managed model-provider server to connect a credential through.";

export const handleProvidersMcpAuth: RpcHandler = (params) => {
  const parsed = providersMcpAuthRequestSchema.safeParse(params);
  return parsed.success
    ? unsupportedAuth(MCP_REASON)
    : malformed(parsed.error.message);
};

export const handleProvidersAwaitMcpAuth: RpcHandler = (params) => {
  const parsed = providersAwaitMcpAuthRequestSchema.safeParse(params);
  return parsed.success
    ? unsupportedAuth(MCP_REASON)
    : malformed(parsed.error.message);
};

export const handleProvidersCancelMcpAuth: RpcHandler = (params) => {
  const parsed = providersCancelMcpAuthRequestSchema.safeParse(params);
  return parsed.success
    ? unsupportedCancel(MCP_REASON)
    : malformed(parsed.error.message);
};

export const handleProvidersModelProviderAuth: RpcHandler = (params) => {
  const parsed = providersModelProviderAuthRequestSchema.safeParse(params);
  return parsed.success
    ? unsupportedAuth(MODEL_PROVIDER_REASON)
    : malformed(parsed.error.message);
};

export const handleProvidersAwaitModelProviderAuth: RpcHandler = (params) => {
  const parsed = providersAwaitModelProviderAuthRequestSchema.safeParse(params);
  return parsed.success
    ? unsupportedAuth(MODEL_PROVIDER_REASON)
    : malformed(parsed.error.message);
};

export const handleProvidersCancelModelProviderAuth: RpcHandler = (params) => {
  const parsed =
    providersCancelModelProviderAuthRequestSchema.safeParse(params);
  return parsed.success
    ? unsupportedCancel(MODEL_PROVIDER_REASON)
    : malformed(parsed.error.message);
};

/**
 * `cancelled` is whether a pending attempt was found and torn down, which is
 * a different question from the result: none can be pending here, so it is
 * false rather than a courtesy true.
 */
function unsupportedCancel(reason: string): RpcHandlerResult {
  return {
    ok: true,
    result: { cancelled: false, result: { kind: "unsupported", reason } },
  };
}

function malformed(message: string): RpcHandlerResult {
  return { ok: false, code: "RPC_ERROR", message };
}
