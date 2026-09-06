import {
  DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  type ProviderNativeErrorResult,
} from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-ids";
import type {
  ProviderCliCandidate,
  ProviderCliState,
  ProviderEnvOverride,
  ProviderSelection,
} from "@traycer/protocol/host/provider-schemas";
import type { HostStore, StoredProviderOverride } from "../store/host-store";
import {
  ALL_PROVIDER_IDS,
  isExecutableFile,
  lookPath,
  pathBinaryName,
} from "./catalog";
import {
  apiKeyStateForProvider,
  credentialPresent,
  storedApiKeyFromOverride,
} from "../gui/provider-rate-limits";
import { PROVIDER_LOGIN_CAPABILITY } from "./login-capability";

export type ProviderListResult = {
  readonly providers: ProviderCliState[];
  readonly native: ProviderNativeErrorResult | null;
};

export type ProviderCliIdentity = {
  readonly enabled: boolean;
  readonly path: string | null;
  readonly terminalAgentArgs: string;
};

/**
 * `native` is `null` for a CLASSIC caller and a typed native error for one
 * that asked. The two are different answers and the difference is the point:
 * `null` means "you did not ask", so returning it to a client that DID ask
 * reads as "asked and got nothing", which is indistinguishable from a
 * provider with no MCP servers configured.
 *
 * This host serves no native provider surface at all - its
 * `nativeCapabilities` advertise no MCP/plugins/skills tabs - so the query is
 * `unsupported_action` rather than an empty list.
 */
export async function listProviderCliStates(
  store: HostStore,
  nativeQueried: boolean,
): Promise<ProviderListResult> {
  const now = Date.now();
  const overrides = store.snapshot().providers;
  const providers: ProviderCliState[] = [];
  for (const providerId of ALL_PROVIDER_IDS) {
    providers.push(
      buildState(providerId, overrideFor(overrides, providerId), now),
    );
  }
  return {
    providers,
    native: nativeQueried ? UNSUPPORTED_NATIVE : null,
  };
}

export const UNSUPPORTED_NATIVE: ProviderNativeErrorResult = {
  ok: false,
  code: "unsupported_action",
  detail: "This host does not manage provider MCP, plugin or skill config.",
};

export function providerCliIdentity(
  store: HostStore,
  providerId: ProviderId,
): ProviderCliIdentity {
  const state = buildState(
    providerId,
    overrideFor(store.snapshot().providers, providerId),
    Date.now(),
  );
  const nextRun = state.nextRunBinary;
  return {
    enabled: state.enabled,
    path: nextRun === null || nextRun === undefined ? null : nextRun.path,
    terminalAgentArgs: state.terminalAgentArgs,
  };
}

export async function setProviderEnabled(
  store: HostStore,
  providerId: ProviderId,
  enabled: boolean,
): Promise<ProviderCliState | null> {
  await upsertOverride(store, providerId, (current) => ({
    ...current,
    enabled,
  }));
  return findProvider(store, providerId);
}

export async function setProviderSelection(
  store: HostStore,
  providerId: ProviderId,
  selection: ProviderSelection,
): Promise<ProviderCliState | null> {
  await upsertOverride(store, providerId, (current) => ({
    ...current,
    selectedKind: selection.kind,
    selectedPath: selection.kind === "custom" ? selection.path : null,
  }));
  return findProvider(store, providerId);
}

export async function addCustomPath(
  store: HostStore,
  providerId: ProviderId,
  path: string,
): Promise<ProviderCliState | null> {
  await upsertOverride(store, providerId, (current) => ({
    ...current,
    customPaths: current.customPaths.includes(path)
      ? current.customPaths
      : [...current.customPaths, path],
    selectedKind: "custom",
    selectedPath: path,
  }));
  return findProvider(store, providerId);
}

export async function setProviderApiKey(
  store: HostStore,
  providerId: ProviderId,
  apiKey: string,
): Promise<ProviderCliState | null> {
  await upsertOverride(store, providerId, (current) => ({
    ...current,
    apiKey,
  }));
  return findProvider(store, providerId);
}

export async function setProviderTerminalAgentArgs(
  store: HostStore,
  providerId: ProviderId,
  terminalAgentArgs: string,
): Promise<ProviderCliState | null> {
  await upsertOverride(store, providerId, (current) => ({
    ...current,
    terminalAgentArgs,
  }));
  return findProvider(store, providerId);
}

export async function setProviderEnvOverride(
  store: HostStore,
  providerId: ProviderId,
  key: string,
  value: string | null,
): Promise<ProviderCliState | null> {
  await upsertOverride(store, providerId, (current) => ({
    ...current,
    envOverrides: upsertEnvOverride(current.envOverrides, key, value),
  }));
  return findProvider(store, providerId);
}

export async function deleteProviderEnvOverride(
  store: HostStore,
  providerId: ProviderId,
  key: string,
): Promise<ProviderCliState | null> {
  await upsertOverride(store, providerId, (current) => ({
    ...current,
    envOverrides: current.envOverrides.filter((row) => row.key !== key),
  }));
  return findProvider(store, providerId);
}

export function spawnEnvForProvider(
  store: HostStore,
  providerId: ProviderId,
): NodeJS.ProcessEnv {
  const override = overrideFor(store.snapshot().providers, providerId);
  const env: NodeJS.ProcessEnv = { ...process.env };
  const rows = override === null ? [] : override.envOverrides;
  const win32 = process.platform === "win32";
  for (const row of rows) {
    const existing = win32
      ? Object.keys(env).find(
          (name) => name.toLowerCase() === row.key.toLowerCase(),
        )
      : row.key;
    const target = existing === undefined ? row.key : existing;
    if (row.value === null) {
      delete env[target];
    } else {
      env[target] = row.value;
    }
  }
  return env;
}

function upsertEnvOverride(
  current: readonly ProviderEnvOverride[],
  key: string,
  value: string | null,
): ProviderEnvOverride[] {
  const without = current.filter((row) => row.key !== key);
  return [...without, { key, value }].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
}

export async function clearProviderApiKey(
  store: HostStore,
  providerId: ProviderId,
): Promise<ProviderCliState | null> {
  await upsertOverride(store, providerId, (current) => ({
    ...current,
    apiKey: null,
  }));
  return findProvider(store, providerId);
}

export async function removeCustomPath(
  store: HostStore,
  providerId: ProviderId,
  path: string,
): Promise<ProviderCliState | null> {
  await upsertOverride(store, providerId, (current) => {
    const customPaths = current.customPaths.filter((entry) => entry !== path);
    const dropSelection =
      current.selectedKind === "custom" && current.selectedPath === path;
    return {
      ...current,
      customPaths,
      selectedKind: dropSelection ? "path" : current.selectedKind,
      selectedPath: dropSelection ? null : current.selectedPath,
    };
  });
  return findProvider(store, providerId);
}

async function findProvider(
  store: HostStore,
  providerId: ProviderId,
): Promise<ProviderCliState | null> {
  const listed = await listProviderCliStates(store, false);
  const found = listed.providers.find((row) => row.providerId === providerId);
  return found === undefined ? null : found;
}

function buildState(
  providerId: ProviderId,
  override: StoredProviderOverride | null,
  now: number,
): ProviderCliState {
  const candidates: ProviderCliCandidate[] = [];
  const pathBinary = lookPath(pathBinaryName(providerId));
  candidates.push(
    pathBinary === null
      ? {
          kind: "path",
          path: "",
          version: null,
          available: false,
          versionPending: false,
        }
      : {
          kind: "path",
          path: pathBinary,
          version: null,
          available: true,
          versionPending: false,
        },
  );
  candidates.push({
    kind: "bundled",
    path: "",
    version: null,
    available: false,
    versionPending: false,
  });
  const customPaths = override === null ? [] : override.customPaths;
  for (const custom of customPaths) {
    candidates.push({
      kind: "custom",
      path: custom,
      version: null,
      available: isExecutableFile(custom),
      versionPending: false,
    });
  }
  const selected = readSelection(override);
  const resolved = resolveEffectiveCliIdentity(selected, candidates);
  const available = resolved.path !== null;
  const storedApiKey = storedApiKeyFromOverride(override);
  const enabled =
    override !== null && override.enabled !== null
      ? override.enabled
      : available;
  return {
    providerId,
    enabled,
    disabledBy: null,
    selected,
    candidates,
    authPending: false,
    checkedAt: now,
    apiKey: apiKeyStateForProvider(providerId, storedApiKey),
    terminalAgentArgs: override === null ? "" : override.terminalAgentArgs,
    envOverrides: override === null ? [] : [...override.envOverrides],
    loginCapability: PROVIDER_LOGIN_CAPABILITY[providerId],
    availabilityPending: false,
    profiles: [],
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    cliBinaryResolved: available,
    packId: null,
    managedVersions: null,
    managedVersionsUnavailable: null,
    nextRunBinary:
      resolved.path === null || resolved.kind === null
        ? null
        : {
            kind: resolved.kind,
            path: resolved.path,
            version: resolved.version,
          },
    auth: {
      status: ambientAuthStatus(providerId, available, storedApiKey),
      badgeText: null,
      label: null,
      detail: null,
    },
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  };
}

function resolveEffectiveCliIdentity(
  selected: ProviderSelection,
  candidates: readonly ProviderCliCandidate[],
): {
  readonly kind: "bundled" | "path" | "custom" | null;
  readonly path: string | null;
  readonly version: string | null;
} {
  const bundled = candidates.find((row) => row.kind === "bundled");
  const pathCandidate = candidates.find((row) => row.kind === "path");
  if (selected.kind === "custom") {
    const custom = candidates.find(
      (row) => row.kind === "custom" && row.path === selected.path,
    );
    if (custom !== undefined && custom.available) {
      return { kind: "custom", path: custom.path, version: custom.version };
    }
  } else if (
    selected.kind === "path" &&
    pathCandidate !== undefined &&
    pathCandidate.available
  ) {
    return {
      kind: "path",
      path: pathCandidate.path,
      version: pathCandidate.version,
    };
  }
  if (bundled !== undefined && bundled.available) {
    return { kind: "bundled", path: bundled.path, version: bundled.version };
  }
  if (pathCandidate !== undefined && pathCandidate.available) {
    return {
      kind: "path",
      path: pathCandidate.path,
      version: pathCandidate.version,
    };
  }
  return { kind: null, path: null, version: null };
}

function readSelection(
  override: StoredProviderOverride | null,
): ProviderSelection {
  if (override === null) {
    return { kind: "path" };
  }
  if (override.selectedKind === "custom" && override.selectedPath !== null) {
    return { kind: "custom", path: override.selectedPath };
  }
  if (override.selectedKind === "bundled") {
    return { kind: "bundled" };
  }
  return { kind: "path" };
}

function ambientAuthStatus(
  providerId: ProviderId,
  available: boolean,
  storedApiKey: string | null,
): "authenticated" | "configured" | "unknown" {
  if (credentialPresent(providerId, storedApiKey)) {
    return "authenticated";
  }
  if (!available) {
    return "unknown";
  }
  return "configured";
}

function overrideFor(
  rows: readonly StoredProviderOverride[],
  providerId: ProviderId,
): StoredProviderOverride | null {
  return rows.find((row) => row.providerId === providerId) ?? null;
}

async function upsertOverride(
  store: HostStore,
  providerId: ProviderId,
  update: (current: StoredProviderOverride) => StoredProviderOverride,
): Promise<void> {
  await store.mutate((state) => {
    const current = state.providers.find(
      (row) => row.providerId === providerId,
    );
    const base: StoredProviderOverride =
      current === undefined
        ? {
            providerId,
            enabled: null,
            selectedKind: "path",
            selectedPath: null,
            customPaths: [],
            apiKey: null,
            terminalAgentArgs: "",
            envOverrides: [],
          }
        : current;
    const next = update(base);
    state.providers = [
      ...state.providers.filter((row) => row.providerId !== providerId),
      next,
    ];
  });
}
