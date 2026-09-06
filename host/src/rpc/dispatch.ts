import {
  getLatestContract,
  type AnyRpcContract,
  type MethodVersionRegistry,
  type SchemaVersion,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { handlerFor, type RpcHandlerResult } from "./handlers";
import type { HostRuntime } from "../runtime";

export type DispatchOutcome =
  | {
      readonly ok: true;
      readonly result: unknown;
      readonly schemaVersion: SchemaVersion;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly schemaVersion: SchemaVersion;
    };

export async function dispatchHostRpc(
  method: string,
  schemaVersion: SchemaVersion,
  params: unknown,
  runtime: HostRuntime,
): Promise<DispatchOutcome> {
  const methodRegistry = methodRegistryOf(method);
  if (methodRegistry === null) {
    return {
      ok: false,
      code: "RPC_ERROR",
      message: `Unknown method ${method}`,
      schemaVersion,
    };
  }
  const requested = contractAt(methodRegistry, schemaVersion);
  if (requested === null) {
    return {
      ok: false,
      code: "INCOMPATIBLE",
      message: `Method ${method} does not install ${String(schemaVersion.major)}.${String(schemaVersion.minor)}`,
      schemaVersion,
    };
  }
  const parsedRequest = requested.requestSchema.safeParse(params);
  if (!parsedRequest.success) {
    return {
      ok: false,
      code: "RPC_ERROR",
      message: parsedRequest.error.message,
      schemaVersion,
    };
  }
  const handled = await Promise.resolve(
    handlerFor(method)(parsedRequest.data, runtime),
  );
  if (!handled.ok) {
    return {
      ok: false,
      code: handled.code,
      message: handled.message,
      schemaVersion,
    };
  }
  const projected = projectResponse(methodRegistry, requested, handled);
  if (!projected.ok) {
    return {
      ok: false,
      code: projected.code,
      message: projected.message,
      schemaVersion,
    };
  }
  return {
    ok: true,
    result: projected.result,
    schemaVersion,
  };
}

function projectResponse(
  methodRegistry: MethodVersionRegistry,
  requested: AnyRpcContract,
  handled: Extract<RpcHandlerResult, { ok: true }>,
): RpcHandlerResult {
  const latest = getLatestContract(methodRegistry, undefined);
  if (!isRpcContract(latest)) {
    return {
      ok: false,
      code: "RPC_ERROR",
      message: `Latest contract for ${requested.method} is not an RPC contract`,
    };
  }
  const latestParsed = latest.responseSchema.safeParse(handled.result);
  const candidate = latestParsed.success ? latestParsed.data : handled.result;
  const projected = requested.responseSchema.safeParse(candidate);
  if (projected.success) {
    return { ok: true, result: projected.data };
  }
  return {
    ok: false,
    code: "RPC_ERROR",
    message: `Failed to project ${requested.method} response onto ${String(requested.schemaVersion.major)}.${String(requested.schemaVersion.minor)}: ${projected.error.message}`,
  };
}

function methodRegistryOf(method: string): MethodVersionRegistry | null {
  const bag: { readonly [name: string]: MethodVersionRegistry } =
    hostRpcRegistry;
  const found = bag[method];
  return found === undefined ? null : found;
}

function contractAt(
  methodRegistry: MethodVersionRegistry,
  version: SchemaVersion,
): AnyRpcContract | null {
  const line = Reflect.get(methodRegistry, version.major);
  if (line === undefined || line === null || typeof line !== "object") {
    return null;
  }
  const versions = Reflect.get(line, "versions");
  if (
    versions === undefined ||
    versions === null ||
    typeof versions !== "object"
  ) {
    return null;
  }
  const entry = Reflect.get(versions, version.minor);
  if (entry === undefined || entry === null || typeof entry !== "object") {
    return null;
  }
  const contract = Reflect.get(entry, "contract");
  return isRpcContract(contract) ? contract : null;
}

function isRpcContract(value: unknown): value is AnyRpcContract {
  if (value === null || typeof value !== "object") {
    return false;
  }
  return (
    "method" in value &&
    "schemaVersion" in value &&
    "requestSchema" in value &&
    "responseSchema" in value
  );
}
