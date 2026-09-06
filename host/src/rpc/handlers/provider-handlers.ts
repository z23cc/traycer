import {
  providersAddCustomPathRequestSchema,
  providersAwaitLoginRequestSchema,
  providersCancelLoginRequestSchemaV11,
  providersClearApiKeyRequestSchema,
  providersDeleteEnvOverrideRequestSchema,
  providersDetectVersionRequestSchema,
  providersRemoveCustomPathRequestSchema,
  providersSetApiKeyRequestSchema,
  providersSetEnabledRequestSchemaV21,
  providersSetEnvOverrideRequestSchema,
  providersSetSelectionRequestSchema,
  providersSetTerminalAgentArgsRequestSchema,
  providersStartLoginRequestSchemaV11,
  providersStartTerminalLoginRequestSchema,
  providersStartTerminalLoginRequestSchemaV20,
  providersSubmitLoginCodeRequestSchema,
  providersTouchLoginRequestSchema,
  providersNativeMutateRequestSchema,
} from "@traycer/protocol/host/provider-schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-ids";
import type { TerminalScope } from "@traycer/protocol/host/terminal/unary-schemas";
import { probeCandidateVersion } from "../../providers/catalog";
import {
  addCustomPath,
  clearProviderApiKey,
  deleteProviderEnvOverride,
  listProviderCliStates,
  UNSUPPORTED_NATIVE,
  removeCustomPath,
  setProviderApiKey,
  setProviderEnabled,
  setProviderEnvOverride,
  setProviderSelection,
  setProviderTerminalAgentArgs,
} from "../../providers/service";
import {
  awaitProviderLogin,
  cancelProviderLogin,
  startProviderLogin,
  startProviderTerminalLogin,
  submitProviderLoginCode,
  touchProviderLogin,
} from "../../providers/login";
import type { RpcHandler } from "./types";

export const handleProvidersList: RpcHandler = async (params, runtime) => {
  const queried =
    params !== null &&
    typeof params === "object" &&
    !Array.isArray(params) &&
    (params as { readonly native?: unknown }).native !== undefined &&
    (params as { readonly native?: unknown }).native !== null;
  return {
    ok: true,
    result: await listProviderCliStates(runtime.store, queried),
  };
};

/**
 * MCP, plugin and skill config belongs to each provider CLI's own files, and
 * this host manages none of them - it advertises no such tab in
 * `nativeCapabilities`, so the surface is not reachable in the first place.
 * `unsupported_action` says that; the analog's `{ok:true, servers: []}` said
 * the mutation had been applied and the provider had no servers left.
 */
export const handleProvidersNativeMutate: RpcHandler = (params) => {
  const parsed = providersNativeMutateRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return { ok: true, result: { result: UNSUPPORTED_NATIVE } };
};

export const handleProvidersDetectVersion: RpcHandler = async (params) => {
  const parsed = providersDetectVersionRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return {
    ok: true,
    result: await probeCandidateVersion(parsed.data.candidatePath),
  };
};

export const handleProvidersSetEnabled: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = providersSetEnabledRequestSchemaV21.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const state = await setProviderEnabled(
    runtime.store,
    parsed.data.providerId,
    parsed.data.enabled,
  );
  if (state === null) {
    return { ok: false, code: "RPC_ERROR", message: "Provider catalog miss" };
  }
  return { ok: true, result: { state } };
};

export const handleProvidersSetSelection: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = providersSetSelectionRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const state = await setProviderSelection(
    runtime.store,
    parsed.data.providerId,
    parsed.data.selection,
  );
  if (state === null) {
    return { ok: false, code: "RPC_ERROR", message: "Provider catalog miss" };
  }
  return { ok: true, result: { state } };
};

export const handleProvidersAddCustomPath: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = providersAddCustomPathRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const state = await addCustomPath(
    runtime.store,
    parsed.data.providerId,
    parsed.data.path,
  );
  if (state === null) {
    return { ok: false, code: "RPC_ERROR", message: "Provider catalog miss" };
  }
  return { ok: true, result: { state } };
};

export const handleProvidersSetApiKey: RpcHandler = async (params, runtime) => {
  const parsed = providersSetApiKeyRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const state = await setProviderApiKey(
    runtime.store,
    parsed.data.providerId,
    parsed.data.apiKey,
  );
  if (state === null) {
    return { ok: false, code: "RPC_ERROR", message: "Provider catalog miss" };
  }
  return { ok: true, result: { state } };
};

export const handleProvidersClearApiKey: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = providersClearApiKeyRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const state = await clearProviderApiKey(
    runtime.store,
    parsed.data.providerId,
  );
  if (state === null) {
    return { ok: false, code: "RPC_ERROR", message: "Provider catalog miss" };
  }
  return { ok: true, result: { state } };
};

export const handleProvidersSetTerminalAgentArgs: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = providersSetTerminalAgentArgsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const state = await setProviderTerminalAgentArgs(
    runtime.store,
    parsed.data.providerId,
    parsed.data.terminalAgentArgs,
  );
  if (state === null) {
    return { ok: false, code: "RPC_ERROR", message: "Provider catalog miss" };
  }
  return { ok: true, result: { state } };
};

export const handleProvidersSetEnvOverride: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = providersSetEnvOverrideRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const state = await setProviderEnvOverride(
    runtime.store,
    parsed.data.providerId,
    parsed.data.key,
    parsed.data.value,
  );
  if (state === null) {
    return { ok: false, code: "RPC_ERROR", message: "Provider catalog miss" };
  }
  return { ok: true, result: { state } };
};

export const handleProvidersDeleteEnvOverride: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = providersDeleteEnvOverrideRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const state = await deleteProviderEnvOverride(
    runtime.store,
    parsed.data.providerId,
    parsed.data.key,
  );
  if (state === null) {
    return { ok: false, code: "RPC_ERROR", message: "Provider catalog miss" };
  }
  return { ok: true, result: { state } };
};

export const handleProvidersStartLogin: RpcHandler = (params, runtime) => {
  const parsed = providersStartLoginRequestSchemaV11.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return {
    ok: true,
    result: startProviderLogin(runtime.store, parsed.data.providerId),
  };
};

export const handleProvidersAwaitLogin: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = providersAwaitLoginRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return {
    ok: true,
    result: await awaitProviderLogin(runtime.store, parsed.data.providerId),
  };
};

export const handleProvidersCancelLogin: RpcHandler = (params) => {
  const parsed = providersCancelLoginRequestSchemaV11.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return {
    ok: true,
    result: { cancelled: cancelProviderLogin(parsed.data.providerId) },
  };
};

export const handleProvidersSubmitLoginCode: RpcHandler = (params) => {
  const parsed = providersSubmitLoginCodeRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return {
    ok: true,
    result: {
      outcome: submitProviderLoginCode(
        parsed.data.providerId,
        parsed.data.code,
      ),
    },
  };
};

export const handleProvidersTouchLogin: RpcHandler = (params) => {
  const parsed = providersTouchLoginRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return {
    ok: true,
    result: { extended: touchProviderLogin(parsed.data.providerId) },
  };
};

export const handleProvidersStartTerminalLogin: RpcHandler = (
  params,
  runtime,
) => {
  // Dispatch binds the requested major's schema and does not upgrade, so
  // this handler accepts both v2.0 (`scope`) and v1.0 (`epicId`).
  const parsed = readStartTerminalLogin(params);
  if (!parsed.ok) {
    return { ok: false, code: "RPC_ERROR", message: parsed.message };
  }
  const started = startProviderTerminalLogin(
    runtime,
    parsed.value.providerId,
    parsed.value.scope,
    parsed.value.cols,
    parsed.value.rows,
  );
  if (!started.ok) {
    return { ok: false, code: "RPC_ERROR", message: started.message };
  }
  return {
    ok: true,
    result: {
      sessionId: started.sessionId,
      replacedSessionId: started.replacedSessionId,
    },
  };
};

function readStartTerminalLogin(params: unknown):
  | {
      readonly ok: true;
      readonly value: {
        readonly providerId: ProviderId;
        readonly scope: TerminalScope;
        readonly cols: number;
        readonly rows: number;
      };
    }
  | { readonly ok: false; readonly message: string } {
  const scoped = providersStartTerminalLoginRequestSchemaV20.safeParse(params);
  if (scoped.success) {
    return {
      ok: true,
      value: {
        providerId: scoped.data.providerId,
        scope: scoped.data.scope,
        cols: scoped.data.cols,
        rows: scoped.data.rows,
      },
    };
  }
  const legacy = providersStartTerminalLoginRequestSchema.safeParse(params);
  if (legacy.success) {
    return {
      ok: true,
      value: {
        providerId: legacy.data.providerId,
        scope: { kind: "epic", epicId: legacy.data.epicId },
        cols: legacy.data.cols,
        rows: legacy.data.rows,
      },
    };
  }
  return { ok: false, message: scoped.error.message };
}

export const handleProvidersRemoveCustomPath: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = providersRemoveCustomPathRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const state = await removeCustomPath(
    runtime.store,
    parsed.data.providerId,
    parsed.data.path,
  );
  if (state === null) {
    return { ok: false, code: "RPC_ERROR", message: "Provider catalog miss" };
  }
  return { ok: true, result: { state } };
};
