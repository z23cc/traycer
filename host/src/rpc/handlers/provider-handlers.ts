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
} from "@traycer/protocol/host/provider-schemas";
import { probeCandidateVersion } from "../../providers/catalog";
import {
  addCustomPath,
  clearProviderApiKey,
  deleteProviderEnvOverride,
  listProviderCliStates,
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
} from "../../providers/login";
import type { RpcHandler } from "./types";

export const handleProvidersList: RpcHandler = async (_params, runtime) => {
  const listed = await listProviderCliStates(runtime.store);
  return { ok: true, result: listed };
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
