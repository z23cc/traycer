import {
  providersAddCustomPathRequestSchema,
  providersClearApiKeyRequestSchema,
  providersDetectVersionRequestSchema,
  providersRemoveCustomPathRequestSchema,
  providersSetApiKeyRequestSchema,
  providersSetEnabledRequestSchemaV21,
  providersSetSelectionRequestSchema,
} from "@traycer/protocol/host/provider-schemas";
import { probeCandidateVersion } from "../../providers/catalog";
import {
  addCustomPath,
  clearProviderApiKey,
  listProviderCliStates,
  removeCustomPath,
  setProviderApiKey,
  setProviderEnabled,
  setProviderSelection,
} from "../../providers/service";
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
