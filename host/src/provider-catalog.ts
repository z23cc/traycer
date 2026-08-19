import { accessSync, constants } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import {
  DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  providerIdSchema,
  type ProviderApiKeyState,
  type ProviderAuth,
  type ProviderCliCandidate,
  type ProviderCliState,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import {
  ProviderConfigStore,
  type ProviderConfigSnapshot,
} from "./provider-config-store";

export const LOCAL_PROVIDER_IDS: readonly ProviderId[] =
  providerIdSchema.options;

export interface ProviderBinaryFacts {
  /** Resolved absolute binary path. */
  readonly path: string;
  readonly version: string | null;
  readonly available: boolean;
  readonly versionPending: boolean;
}

/**
 * Runtime-only probe results. None of these fields are persisted by the
 * provider config store. API-key state is deliberately metadata-only; this
 * boundary cannot accept or return raw secret contents.
 */
export interface ProviderRuntimeFacts {
  readonly bundled: ProviderBinaryFacts | null;
  readonly path: ProviderBinaryFacts | null;
  readonly custom: ReadonlyMap<string, ProviderBinaryFacts>;
  readonly auth: ProviderAuth | null;
  readonly authPending: boolean;
  readonly checkedAt: number | null;
  readonly availabilityPending: boolean;
  readonly apiKey: ProviderApiKeyState | null;
}

export type ProviderRuntimeFactsById = ReadonlyMap<
  ProviderId,
  ProviderRuntimeFacts
>;

export function emptyProviderRuntimeFacts(): ProviderRuntimeFactsById {
  return new Map();
}

/** Builds the complete released provider catalog in protocol order. */
export function buildProviderCatalog(
  store: ProviderConfigStore,
  runtimeFacts: ProviderRuntimeFactsById,
): ProviderCliState[] {
  return LOCAL_PROVIDER_IDS.map((providerId) =>
    buildProviderState(store.get(providerId), runtimeFacts.get(providerId)),
  );
}

/** Builds one state echo for provider mutation responses. */
export function buildProviderState(
  config: ProviderConfigSnapshot,
  runtimeFacts: ProviderRuntimeFacts | undefined,
): ProviderCliState {
  const pending = runtimeFacts?.availabilityPending ?? false;
  const bundled = candidate("bundled", runtimeFacts?.bundled ?? null, pending);
  const pathCandidate = candidate("path", runtimeFacts?.path ?? null, pending);
  const customCandidates = config.customPaths.map((path) =>
    customCandidate(path, runtimeFacts?.custom.get(path), pending),
  );
  const candidates = [bundled, pathCandidate, ...customCandidates];
  const cliBinaryResolved = resolvesBinary(config, candidates);
  const apiKey = runtimeFacts?.apiKey ?? defaultApiKeyState();

  return {
    providerId: config.providerId,
    enabled: config.enabled,
    disabledBy: config.disabledBy,
    selected: config.selection,
    candidates,
    authPending: runtimeFacts?.authPending ?? false,
    checkedAt: runtimeFacts?.checkedAt ?? null,
    apiKey,
    terminalAgentArgs: config.terminalAgentArgs,
    envOverrides: [...config.envOverrides],
    loginCapability: null,
    availabilityPending: pending,
    profiles: [],
    auth:
      runtimeFacts?.auth ??
      defaultAuth(cliBinaryResolved, config.enabled, pending),
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    cliBinaryResolved,
    packId: null,
    managedVersions: null,
    managedVersionsUnavailable: null,
    nextRunBinary: null,
  };
}

function candidate(
  kind: "bundled" | "path",
  facts: ProviderBinaryFacts | null,
  availabilityPending: boolean,
): ProviderCliCandidate {
  if (facts === null) {
    return {
      kind,
      path: "",
      version: null,
      available: false,
      versionPending: availabilityPending,
    };
  }
  return {
    kind,
    path: facts.path,
    version: facts.version,
    available: !availabilityPending && facts.available,
    versionPending: availabilityPending || facts.versionPending,
  };
}

function customCandidate(
  configuredPath: string,
  facts: ProviderBinaryFacts | undefined,
  availabilityPending: boolean,
): ProviderCliCandidate {
  const normalizedPath = normalize(configuredPath);
  if (facts !== undefined) {
    return {
      kind: "custom",
      path: normalizedPath,
      version: facts.version,
      available: !availabilityPending && facts.available,
      versionPending: availabilityPending || facts.versionPending,
    };
  }
  return {
    kind: "custom",
    path: normalizedPath,
    version: null,
    available: !availabilityPending && isExecutable(normalizedPath),
    versionPending: availabilityPending,
  };
}

function resolvesBinary(
  config: ProviderConfigSnapshot,
  candidates: readonly ProviderCliCandidate[],
): boolean {
  const selected = candidates.find((candidate) => {
    if (candidate.kind !== config.selection.kind) {
      return false;
    }
    return (
      candidate.kind !== "custom" ||
      (config.selection.kind === "custom" &&
        candidate.path === config.selection.path)
    );
  });
  if (selected?.available === true) {
    return true;
  }
  return candidates.some(
    (candidate) => candidate.kind !== "custom" && candidate.available,
  );
}

function defaultApiKeyState(): ProviderApiKeyState {
  return {
    supported: false,
    configured: false,
    source: null,
  };
}

function defaultAuth(
  cliBinaryResolved: boolean,
  enabled: boolean,
  availabilityPending: boolean,
): ProviderAuth {
  if (!enabled) {
    return {
      status: "unavailable",
      badgeText: "Disabled",
      label: null,
      detail: "This provider is disabled on this host.",
    };
  }
  if (availabilityPending) {
    return {
      status: "unknown",
      badgeText: null,
      label: null,
      detail: "Provider availability is still being checked.",
    };
  }
  if (!cliBinaryResolved) {
    return {
      status: "unavailable",
      badgeText: "Unavailable",
      label: null,
      detail: "No runnable CLI binary was found on this host.",
    };
  }
  return {
    status: "unknown",
    badgeText: null,
    label: null,
    detail: null,
  };
}

function isExecutable(path: string): boolean {
  if (!isAbsolute(path)) {
    return false;
  }
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
