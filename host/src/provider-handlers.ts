import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import {
  providersAddCustomPathRequestSchema,
  providersAddCustomPathResponseSchema,
  providersDeleteEnvOverrideRequestSchema,
  providersDeleteEnvOverrideResponseSchema,
  providersDetectVersionRequestSchema,
  providersDetectVersionResponseSchema,
  providersListRequestSchema,
  providersListResponseSchema,
  providersRemoveCustomPathRequestSchema,
  providersRemoveCustomPathResponseSchema,
  providersSetEnabledRequestSchemaV21,
  providersSetEnabledResponseSchema,
  providersSetEnvOverrideRequestSchema,
  providersSetEnvOverrideResponseSchema,
  providersSetSelectionRequestSchema,
  providersSetSelectionResponseSchema,
  providersSetTerminalAgentArgsRequestSchema,
  providersSetTerminalAgentArgsResponseSchema,
  type ProviderDisabledBy,
} from "@traycer/protocol/host/provider-schemas";
import type { ZodType } from "zod";
import {
  buildProviderCatalog,
  buildProviderState,
  emptyProviderRuntimeFacts,
  type ProviderRuntimeFactsById,
} from "./provider-catalog";
import {
  ProviderConfigError,
  type ProviderConfigSnapshot,
  type ProviderConfigStore,
} from "./provider-config-store";

export type ProviderHandlerResult =
  | { readonly ok: true; readonly result: unknown }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
    };

export type ProviderMethodHandler = (
  params: unknown,
) => ProviderHandlerResult | Promise<ProviderHandlerResult>;

export type ProviderMethodName =
  | "providers.list"
  | "providers.setSelection"
  | "providers.addCustomPath"
  | "providers.removeCustomPath"
  | "providers.detectVersion"
  | "providers.setEnabled"
  | "providers.setTerminalAgentArgs"
  | "providers.setEnvOverride"
  | "providers.deleteEnvOverride";

export interface ProviderVersionProbeResult {
  readonly executable: boolean;
  readonly version: string | null;
}

export interface ProviderHandlerDependencies {
  readonly config: ProviderConfigStore;
  readonly runtimeFacts?: () => ProviderRuntimeFactsById;
  readonly probeVersion?: (
    candidatePath: string,
  ) => Promise<ProviderVersionProbeResult>;
  readonly now?: () => number;
}

interface ResolvedProviderHandlerDependencies {
  readonly config: ProviderConfigStore;
  readonly runtimeFacts: () => ProviderRuntimeFactsById;
  readonly probeVersion: (
    candidatePath: string,
  ) => Promise<ProviderVersionProbeResult>;
  readonly now: () => number;
}

export const DEFAULT_PROVIDER_VERSION_PROBE_TIMEOUT_MS = 2_000;
const PROVIDER_VERSION_MAX_BUFFER_BYTES = 64 * 1024;

export function createProviderHandlers(
  dependencies: ProviderHandlerDependencies,
): Readonly<Record<ProviderMethodName, ProviderMethodHandler>> {
  const resolved = resolveDependencies(dependencies);
  return {
    "providers.list": (params) => resolveProvidersList(resolved, params),
    "providers.setSelection": (params) =>
      resolveProvidersSetSelection(resolved, params),
    "providers.addCustomPath": (params) =>
      resolveProvidersAddCustomPath(resolved, params),
    "providers.removeCustomPath": (params) =>
      resolveProvidersRemoveCustomPath(resolved, params),
    "providers.detectVersion": (params) =>
      resolveProvidersDetectVersion(resolved, params),
    "providers.setEnabled": (params) =>
      resolveProvidersSetEnabled(resolved, params),
    "providers.setTerminalAgentArgs": (params) =>
      resolveProvidersSetTerminalAgentArgs(resolved, params),
    "providers.setEnvOverride": (params) =>
      resolveProvidersSetEnvOverride(resolved, params),
    "providers.deleteEnvOverride": (params) =>
      resolveProvidersDeleteEnvOverride(resolved, params),
  };
}

export function resolveProvidersList(
  dependencies: ResolvedProviderHandlerDependencies,
  params: unknown,
): ProviderHandlerResult {
  const parsed = providersListRequestSchema.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  if (parsed.data.native !== null) {
    return unsupported("providers.list native discovery");
  }
  return success(
    providersListResponseSchema.parse({
      providers: buildProviderCatalog(
        dependencies.config,
        dependencies.runtimeFacts(),
      ),
      native: null,
    }),
  );
}

export async function resolveProvidersSetSelection(
  dependencies: ResolvedProviderHandlerDependencies,
  params: unknown,
): Promise<ProviderHandlerResult> {
  return mutateProvider(
    dependencies,
    providersSetSelectionRequestSchema,
    providersSetSelectionResponseSchema,
    params,
    (request) =>
      dependencies.config.setSelection(request.providerId, request.selection),
  );
}

export async function resolveProvidersAddCustomPath(
  dependencies: ResolvedProviderHandlerDependencies,
  params: unknown,
): Promise<ProviderHandlerResult> {
  return mutateProvider(
    dependencies,
    providersAddCustomPathRequestSchema,
    providersAddCustomPathResponseSchema,
    params,
    (request) =>
      dependencies.config.addCustomPath(request.providerId, request.path),
  );
}

export async function resolveProvidersRemoveCustomPath(
  dependencies: ResolvedProviderHandlerDependencies,
  params: unknown,
): Promise<ProviderHandlerResult> {
  return mutateProvider(
    dependencies,
    providersRemoveCustomPathRequestSchema,
    providersRemoveCustomPathResponseSchema,
    params,
    (request) =>
      dependencies.config.removeCustomPath(request.providerId, request.path),
  );
}

export async function resolveProvidersDetectVersion(
  dependencies: ResolvedProviderHandlerDependencies,
  params: unknown,
): Promise<ProviderHandlerResult> {
  const parsed = providersDetectVersionRequestSchema.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  try {
    const result = await dependencies.probeVersion(parsed.data.candidatePath);
    return success(providersDetectVersionResponseSchema.parse(result));
  } catch (error) {
    return failure(error);
  }
}

export async function resolveProvidersSetEnabled(
  dependencies: ResolvedProviderHandlerDependencies,
  params: unknown,
): Promise<ProviderHandlerResult> {
  const parsed = providersSetEnabledRequestSchemaV21.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  if (parsed.data.profileAction !== null) {
    return unsupported("providers.setEnabled profile management");
  }
  const disabledBy: ProviderDisabledBy | null = parsed.data.enabled
    ? null
    : {
        userId: "local-user",
        handle: null,
        at: dependencies.now(),
      };
  try {
    const snapshot = await dependencies.config.setEnabled(
      parsed.data.providerId,
      parsed.data.enabled,
      disabledBy,
    );
    return mutationSuccess(
      dependencies,
      providersSetEnabledResponseSchema,
      snapshot,
    );
  } catch (error) {
    return failure(error);
  }
}

export async function resolveProvidersSetTerminalAgentArgs(
  dependencies: ResolvedProviderHandlerDependencies,
  params: unknown,
): Promise<ProviderHandlerResult> {
  return mutateProvider(
    dependencies,
    providersSetTerminalAgentArgsRequestSchema,
    providersSetTerminalAgentArgsResponseSchema,
    params,
    (request) =>
      dependencies.config.setTerminalAgentArgs(
        request.providerId,
        request.terminalAgentArgs,
      ),
  );
}

export async function resolveProvidersSetEnvOverride(
  dependencies: ResolvedProviderHandlerDependencies,
  params: unknown,
): Promise<ProviderHandlerResult> {
  return mutateProvider(
    dependencies,
    providersSetEnvOverrideRequestSchema,
    providersSetEnvOverrideResponseSchema,
    params,
    (request) =>
      dependencies.config.setEnvOverride(
        request.providerId,
        request.key,
        request.value,
      ),
  );
}

export async function resolveProvidersDeleteEnvOverride(
  dependencies: ResolvedProviderHandlerDependencies,
  params: unknown,
): Promise<ProviderHandlerResult> {
  return mutateProvider(
    dependencies,
    providersDeleteEnvOverrideRequestSchema,
    providersDeleteEnvOverrideResponseSchema,
    params,
    (request) =>
      dependencies.config.deleteEnvOverride(request.providerId, request.key),
  );
}

/**
 * Probes only the exact candidate path supplied by the caller. The child is
 * bounded by both a deadline and an output cap so a broken CLI cannot wedge
 * the host or grow its memory without limit.
 */
export async function probeProviderVersion(
  candidatePath: string,
  timeoutMs: number | undefined,
): Promise<ProviderVersionProbeResult> {
  try {
    await access(candidatePath, constants.X_OK);
  } catch {
    return { executable: false, version: null };
  }

  return new Promise((resolve) => {
    execFile(
      candidatePath,
      ["--version"],
      {
        encoding: "utf8",
        killSignal: "SIGKILL",
        maxBuffer: PROVIDER_VERSION_MAX_BUFFER_BYTES,
        timeout: timeoutMs ?? DEFAULT_PROVIDER_VERSION_PROBE_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          resolve({
            executable: !isMissingOrInaccessible(error),
            version: null,
          });
          return;
        }
        resolve({
          executable: true,
          version: firstNonEmptyLine(stdout) ?? firstNonEmptyLine(stderr),
        });
      },
    );
  });
}

function resolveDependencies(
  dependencies: ProviderHandlerDependencies,
): ResolvedProviderHandlerDependencies {
  return {
    config: dependencies.config,
    runtimeFacts:
      dependencies.runtimeFacts ?? (() => emptyProviderRuntimeFacts()),
    probeVersion:
      dependencies.probeVersion ??
      ((path) => probeProviderVersion(path, undefined)),
    now: dependencies.now ?? Date.now,
  };
}

async function mutateProvider<Request>(
  dependencies: ResolvedProviderHandlerDependencies,
  requestSchema: ZodType<Request>,
  responseSchema: ZodType<unknown>,
  params: unknown,
  mutation: (request: Request) => Promise<ProviderConfigSnapshot>,
): Promise<ProviderHandlerResult> {
  const parsed = requestSchema.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  try {
    const snapshot = await mutation(parsed.data);
    return mutationSuccess(dependencies, responseSchema, snapshot);
  } catch (error) {
    return failure(error);
  }
}

function mutationSuccess(
  dependencies: ResolvedProviderHandlerDependencies,
  responseSchema: ZodType<unknown>,
  snapshot: ProviderConfigSnapshot,
): ProviderHandlerResult {
  const runtimeFacts = dependencies.runtimeFacts().get(snapshot.providerId);
  return success(
    responseSchema.parse({
      state: buildProviderState(snapshot, runtimeFacts),
    }),
  );
}

function firstNonEmptyLine(output: string): string | null {
  return (
    output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? null
  );
}

function isMissingOrInaccessible(error: Error): boolean {
  const code = "code" in error ? error.code : undefined;
  return code === "ENOENT" || code === "EACCES";
}

function success(result: unknown): ProviderHandlerResult {
  return { ok: true, result };
}

function invalidArgument(message: string): ProviderHandlerResult {
  return { ok: false, code: "E_INVALID_ARGUMENT", message };
}

function unsupported(capability: string): ProviderHandlerResult {
  return {
    ok: false,
    code: "E_HOST_UNSUPPORTED",
    message: `${capability} is not available on this local host`,
  };
}

function failure(error: unknown): ProviderHandlerResult {
  if (error instanceof ProviderConfigError) {
    return invalidArgument(error.message);
  }
  return {
    ok: false,
    code: "RPC_ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
}
