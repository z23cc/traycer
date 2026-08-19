import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { z } from "zod";
import {
  providerIdSchema,
  providerSelectionSchema,
  type ProviderDisabledBy,
  type ProviderEnvOverride,
  type ProviderId,
  type ProviderSelection,
} from "@traycer/protocol/host/provider-schemas";

const PROVIDER_CONFIG_VERSION = 1;
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const persistedProviderConfigSchema = z.strictObject({
  selection: providerSelectionSchema,
  enabled: z.boolean(),
  disabledBy: z
    .object({
      userId: z.string(),
      handle: z.string().nullable(),
      at: z.number().int().nonnegative(),
    })
    .nullable(),
  customPaths: z.array(z.string()),
  terminalAgentArgs: z.string(),
  envOverrides: z.record(z.string(), z.string().nullable()),
});

const persistedProviderConfigFileSchema = z.strictObject({
  version: z.literal(PROVIDER_CONFIG_VERSION),
  providers: z.record(z.string(), persistedProviderConfigSchema),
});

type PersistedProviderConfig = z.infer<typeof persistedProviderConfigSchema>;

export type ProviderConfigErrorCode =
  | "CORRUPT_CONFIG"
  | "CUSTOM_PATH_DUPLICATE"
  | "CUSTOM_PATH_NOT_FOUND"
  | "INVALID_ENVIRONMENT_KEY"
  | "INVALID_PROVIDER_ID"
  | "INVALID_PROVIDER_PATH";

export class ProviderConfigError extends Error {
  readonly code: ProviderConfigErrorCode;

  constructor(code: ProviderConfigErrorCode, message: string) {
    super(message);
    this.name = "ProviderConfigError";
    this.code = code;
  }
}

export interface ProviderConfigSnapshot {
  readonly providerId: ProviderId;
  readonly selection: ProviderSelection;
  readonly enabled: boolean;
  readonly disabledBy: ProviderDisabledBy | null;
  readonly customPaths: readonly string[];
  readonly terminalAgentArgs: string;
  readonly envOverrides: readonly ProviderEnvOverride[];
}

/**
 * Device-local, non-secret provider configuration.
 *
 * Raw API keys intentionally have no place in this store. Callers that add a
 * secret backend should keep the bytes behind that boundary and expose only
 * the redacted `ProviderApiKeyState` metadata used by the provider catalog.
 */
export class ProviderConfigStore {
  readonly path: string;
  private readonly persistent: boolean;
  private readonly providers = new Map<ProviderId, PersistedProviderConfig>();
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(hostHome: string, persistent: boolean) {
    this.path = join(hostHome, "config", "provider-overrides.json");
    this.persistent = persistent;
  }

  static async open(hostHome: string): Promise<ProviderConfigStore> {
    if (hostHome.trim().length === 0) {
      throw new ProviderConfigError(
        "CORRUPT_CONFIG",
        "Provider config host home must not be empty.",
      );
    }
    const store = new ProviderConfigStore(hostHome, true);
    await store.load();
    return store;
  }

  static createTransient(): ProviderConfigStore {
    return new ProviderConfigStore("", false);
  }

  list(): ProviderConfigSnapshot[] {
    return providerIdSchema.options.map((providerId) => this.get(providerId));
  }

  get(providerId: ProviderId): ProviderConfigSnapshot {
    ensureProviderId(providerId);
    return toSnapshot(
      providerId,
      this.providers.get(providerId) ?? defaultProviderConfig(),
    );
  }

  async setSelection(
    providerId: ProviderId,
    selection: ProviderSelection,
  ): Promise<ProviderConfigSnapshot> {
    ensureProviderId(providerId);
    const normalizedSelection = normalizeSelection(selection);
    return this.update(providerId, (current) => {
      if (
        normalizedSelection.kind === "custom" &&
        !current.customPaths.includes(normalizedSelection.path)
      ) {
        throw new ProviderConfigError(
          "CUSTOM_PATH_NOT_FOUND",
          `Custom provider path is not registered: ${normalizedSelection.path}`,
        );
      }
      return { ...current, selection: normalizedSelection };
    });
  }

  async addCustomPath(
    providerId: ProviderId,
    path: string,
  ): Promise<ProviderConfigSnapshot> {
    ensureProviderId(providerId);
    const normalizedPath = normalizeProviderPath(path);
    return this.update(providerId, (current) => {
      if (current.customPaths.includes(normalizedPath)) {
        throw new ProviderConfigError(
          "CUSTOM_PATH_DUPLICATE",
          `Custom provider path is already registered: ${normalizedPath}`,
        );
      }
      return {
        ...current,
        customPaths: [...current.customPaths, normalizedPath].sort(),
      };
    });
  }

  async removeCustomPath(
    providerId: ProviderId,
    path: string,
  ): Promise<ProviderConfigSnapshot> {
    ensureProviderId(providerId);
    const normalizedPath = normalizeProviderPath(path);
    return this.update(providerId, (current) => {
      if (!current.customPaths.includes(normalizedPath)) {
        throw new ProviderConfigError(
          "CUSTOM_PATH_NOT_FOUND",
          `Custom provider path is not registered: ${normalizedPath}`,
        );
      }
      const selection =
        current.selection.kind === "custom" &&
        current.selection.path === normalizedPath
          ? { kind: "path" as const }
          : current.selection;
      return {
        ...current,
        selection,
        customPaths: current.customPaths.filter(
          (candidate) => candidate !== normalizedPath,
        ),
      };
    });
  }

  async setEnabled(
    providerId: ProviderId,
    enabled: boolean,
    disabledBy: ProviderDisabledBy | null,
  ): Promise<ProviderConfigSnapshot> {
    ensureProviderId(providerId);
    if (!enabled && disabledBy === null) {
      throw new ProviderConfigError(
        "CORRUPT_CONFIG",
        "Disabling a provider requires disabled-by metadata.",
      );
    }
    return this.update(providerId, (current) => ({
      ...current,
      enabled,
      disabledBy: enabled ? null : disabledBy,
    }));
  }

  async setTerminalAgentArgs(
    providerId: ProviderId,
    terminalAgentArgs: string,
  ): Promise<ProviderConfigSnapshot> {
    ensureProviderId(providerId);
    return this.update(providerId, (current) => ({
      ...current,
      terminalAgentArgs,
    }));
  }

  async setEnvOverride(
    providerId: ProviderId,
    key: string,
    value: string | null,
  ): Promise<ProviderConfigSnapshot> {
    ensureProviderId(providerId);
    ensureEnvironmentKey(key);
    return this.update(providerId, (current) => ({
      ...current,
      envOverrides: { ...current.envOverrides, [key]: value },
    }));
  }

  async deleteEnvOverride(
    providerId: ProviderId,
    key: string,
  ): Promise<ProviderConfigSnapshot> {
    ensureProviderId(providerId);
    ensureEnvironmentKey(key);
    return this.update(providerId, (current) => {
      const envOverrides = { ...current.envOverrides };
      delete envOverrides[key];
      return { ...current, envOverrides };
    });
  }

  private async load(): Promise<void> {
    if (!this.persistent) {
      return;
    }
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw corruptConfig(
        `Provider config is not valid JSON: ${errorText(error)}`,
      );
    }
    const parsed = persistedProviderConfigFileSchema.safeParse(value);
    if (!parsed.success) {
      throw corruptConfig(
        `Provider config has an invalid shape: ${parsed.error.message}`,
      );
    }

    for (const [rawProviderId, config] of Object.entries(
      parsed.data.providers,
    )) {
      const providerIdResult = providerIdSchema.safeParse(rawProviderId);
      if (!providerIdResult.success) {
        throw corruptConfig(
          `Provider config has unknown provider: ${rawProviderId}`,
        );
      }
      validatePersistedProviderConfig(config);
      this.providers.set(providerIdResult.data, clonePersistedConfig(config));
    }
  }

  private update(
    providerId: ProviderId,
    transform: (current: PersistedProviderConfig) => PersistedProviderConfig,
  ): Promise<ProviderConfigSnapshot> {
    const operation = this.writeQueue.then(async () => {
      const current = clonePersistedConfig(
        this.providers.get(providerId) ?? defaultProviderConfig(),
      );
      const next = transform(current);
      validatePersistedProviderConfig(next);

      const nextProviders = new Map(this.providers);
      nextProviders.set(providerId, clonePersistedConfig(next));
      if (this.persistent) {
        await persistProviderConfigs(this.path, nextProviders);
      }
      this.providers.clear();
      for (const [id, config] of nextProviders) {
        this.providers.set(id, config);
      }
      return toSnapshot(providerId, next);
    });
    this.writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}

function defaultProviderConfig(): PersistedProviderConfig {
  return {
    selection: { kind: "path" },
    enabled: true,
    disabledBy: null,
    customPaths: [],
    terminalAgentArgs: "",
    envOverrides: {},
  };
}

function clonePersistedConfig(
  config: PersistedProviderConfig,
): PersistedProviderConfig {
  return {
    selection:
      config.selection.kind === "custom"
        ? { kind: "custom", path: config.selection.path }
        : { kind: config.selection.kind },
    enabled: config.enabled,
    disabledBy: config.disabledBy === null ? null : { ...config.disabledBy },
    customPaths: [...config.customPaths],
    terminalAgentArgs: config.terminalAgentArgs,
    envOverrides: { ...config.envOverrides },
  };
}

function toSnapshot(
  providerId: ProviderId,
  config: PersistedProviderConfig,
): ProviderConfigSnapshot {
  return {
    providerId,
    selection:
      config.selection.kind === "custom"
        ? { kind: "custom", path: config.selection.path }
        : { kind: config.selection.kind },
    enabled: config.enabled,
    disabledBy: config.disabledBy === null ? null : { ...config.disabledBy },
    customPaths: [...config.customPaths],
    terminalAgentArgs: config.terminalAgentArgs,
    envOverrides: Object.entries(config.envOverrides)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({ key, value })),
  };
}

function validatePersistedProviderConfig(
  config: PersistedProviderConfig,
): void {
  const normalizedPaths = config.customPaths.map(normalizeProviderPath);
  if (
    config.customPaths.some((path, index) => path !== normalizedPaths[index])
  ) {
    throw corruptConfig(
      "Provider config contains a non-canonical custom path.",
    );
  }
  if (new Set(normalizedPaths).size !== normalizedPaths.length) {
    throw corruptConfig("Provider config contains duplicate custom paths.");
  }
  if (
    config.selection.kind === "custom" &&
    (config.selection.path !== normalizeProviderPath(config.selection.path) ||
      !normalizedPaths.includes(config.selection.path))
  ) {
    throw corruptConfig("Provider config selects an unregistered custom path.");
  }
  if (config.enabled && config.disabledBy !== null) {
    throw corruptConfig(
      "Enabled provider config contains disabled-by metadata.",
    );
  }
  if (!config.enabled && config.disabledBy === null) {
    throw corruptConfig("Disabled provider config lacks disabled-by metadata.");
  }
  for (const key of Object.keys(config.envOverrides)) {
    ensureEnvironmentKey(key);
  }
}

function normalizeSelection(selection: ProviderSelection): ProviderSelection {
  if (selection.kind !== "custom") {
    return { kind: selection.kind };
  }
  return { kind: "custom", path: normalizeProviderPath(selection.path) };
}

function normalizeProviderPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length === 0 || !isAbsolute(trimmed)) {
    throw new ProviderConfigError(
      "INVALID_PROVIDER_PATH",
      `Provider path must be absolute: ${path}`,
    );
  }
  return normalize(trimmed);
}

function ensureEnvironmentKey(key: string): void {
  if (!ENVIRONMENT_KEY_PATTERN.test(key)) {
    throw new ProviderConfigError(
      "INVALID_ENVIRONMENT_KEY",
      `Invalid environment variable name: ${key}`,
    );
  }
}

function ensureProviderId(
  providerId: string,
): asserts providerId is ProviderId {
  if (!providerIdSchema.safeParse(providerId).success) {
    throw new ProviderConfigError(
      "INVALID_PROVIDER_ID",
      `Unknown provider: ${providerId}`,
    );
  }
}

async function persistProviderConfigs(
  path: string,
  providers: ReadonlyMap<ProviderId, PersistedProviderConfig>,
): Promise<void> {
  const serializedProviders: Record<string, PersistedProviderConfig> = {};
  for (const providerId of providerIdSchema.options) {
    const config = providers.get(providerId);
    if (config !== undefined) {
      serializedProviders[providerId] = clonePersistedConfig(config);
    }
  }
  const contents = `${JSON.stringify(
    { version: PROVIDER_CONFIG_VERSION, providers: serializedProviders },
    null,
    2,
  )}\n`;
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function corruptConfig(message: string): ProviderConfigError {
  return new ProviderConfigError("CORRUPT_CONFIG", message);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
