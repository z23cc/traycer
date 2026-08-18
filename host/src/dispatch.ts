import {
  AnyRpcContract,
  downgradeResponseAcrossMajors,
  MethodVersionRegistry,
  SchemaVersion,
  upgradeRequestToVersion,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import type { HandlerResult, MethodDispatcher } from "./handlers";

export type DispatchOutcome = {
  readonly schemaVersion: SchemaVersion;
  readonly result: unknown | null;
  readonly error: { readonly code: string; readonly message: string } | null;
};

export function dispatchRequest(args: {
  readonly method: string;
  readonly schemaVersion: SchemaVersion;
  readonly params: unknown;
  readonly handleMethod: MethodDispatcher;
}): DispatchOutcome | Promise<DispatchOutcome> {
  const methodRegistry = methodRegistryFor(args.method);
  if (methodRegistry === null) {
    return {
      schemaVersion: args.schemaVersion,
      result: null,
      error: {
        code: "E_HOST_UNSUPPORTED",
        message: `Unknown method '${args.method}'`,
      },
    };
  }
  const requestedContract = contractForVersion(
    methodRegistry,
    args.schemaVersion,
  );
  if (requestedContract === null) {
    return {
      schemaVersion: args.schemaVersion,
      result: null,
      error: {
        code: "RPC_ERROR",
        message: `No contract installed for method '${args.method}' ${args.schemaVersion.major}.${args.schemaVersion.minor}`,
      },
    };
  }
  const parsed = requestedContract.requestSchema.safeParse(args.params);
  if (!parsed.success) {
    return {
      schemaVersion: args.schemaVersion,
      result: null,
      error: {
        code: "RPC_ERROR",
        message: `Request params failed validation: ${parsed.error.message}`,
      },
    };
  }
  const latest = latestContract(methodRegistry);
  const downgradeError = preflightResponseDowngrade(
    methodRegistry,
    latest.schemaVersion,
    requestedContract.schemaVersion,
  );
  if (downgradeError !== null) {
    return {
      schemaVersion: requestedContract.schemaVersion,
      result: null,
      error: downgradeError,
    };
  }

  let upgradedParams: unknown;
  try {
    upgradedParams = upgradeRequestToVersion(
      methodRegistry,
      requestedContract.schemaVersion,
      latest.schemaVersion,
      parsed.data,
    );
  } catch (error) {
    return rpcFailure(
      requestedContract.schemaVersion,
      `Failed to upgrade request to canonical: ${errorMessage(error)}`,
    );
  }
  const canonicalParams = latest.requestSchema.safeParse(upgradedParams);
  if (!canonicalParams.success) {
    return rpcFailure(
      requestedContract.schemaVersion,
      `Upgraded params failed canonical validation: ${canonicalParams.error.message}`,
    );
  }

  const handled = args.handleMethod(args.method, canonicalParams.data);
  if (handled instanceof Promise) {
    return handled.then(
      (resolved) =>
        encodeHandled({
          methodRegistry,
          requestedContract,
          latestContract: latest,
          handled: resolved,
        }),
      (error: unknown) =>
        rpcFailure(requestedContract.schemaVersion, errorMessage(error)),
    );
  }
  return encodeHandled({
    methodRegistry,
    requestedContract,
    latestContract: latest,
    handled,
  });
}

function encodeHandled(args: {
  readonly methodRegistry: MethodVersionRegistry;
  readonly requestedContract: AnyRpcContract;
  readonly latestContract: AnyRpcContract;
  readonly handled: HandlerResult;
}): DispatchOutcome {
  if (!args.handled.ok) {
    return {
      schemaVersion: args.requestedContract.schemaVersion,
      result: null,
      error: {
        code: args.handled.code,
        message: args.handled.message,
      },
    };
  }

  const parsedLatest = args.latestContract.responseSchema.safeParse(
    args.handled.result,
  );
  if (!parsedLatest.success) {
    return invalidHandlerResponse(
      args.requestedContract.schemaVersion,
      parsedLatest.error.message,
      "Resolver result failed canonical validation",
    );
  }

  let downgraded;
  try {
    downgraded = downgradeResponseAcrossMajors(
      args.methodRegistry,
      args.latestContract.schemaVersion.major,
      args.requestedContract.schemaVersion.major,
      parsedLatest.data,
    );
  } catch (error) {
    return rpcFailure(
      args.requestedContract.schemaVersion,
      `Response downgrade failed: ${errorMessage(error)}`,
    );
  }
  if (!downgraded.ok) {
    return {
      schemaVersion: args.requestedContract.schemaVersion,
      result: null,
      error: downgraded.error,
    };
  }

  const projected = args.requestedContract.responseSchema.safeParse(
    downgraded.value,
  );
  if (!projected.success) {
    return invalidHandlerResponse(
      args.requestedContract.schemaVersion,
      projected.error.message,
      "Downgraded result failed caller validation",
    );
  }

  return {
    schemaVersion: args.requestedContract.schemaVersion,
    result: projected.data,
    error: null,
  };
}

function preflightResponseDowngrade(
  methodRegistry: MethodVersionRegistry,
  canonicalVersion: SchemaVersion,
  requestedVersion: SchemaVersion,
): { readonly code: string; readonly message: string } | null {
  if (canonicalVersion.major === requestedVersion.major) {
    return null;
  }
  const canonicalLine = methodRegistry[canonicalVersion.major];
  if (
    canonicalLine !== undefined &&
    canonicalLine.downgradePathsFromLatest[requestedVersion.major] !== undefined
  ) {
    return null;
  }
  return {
    code: "DOWNGRADE_UNSUPPORTED",
    message: `No direct downgrade path exists from major ${canonicalVersion.major} to major ${requestedVersion.major}`,
  };
}

function invalidHandlerResponse(
  schemaVersion: SchemaVersion,
  details: string,
  prefix: string,
): DispatchOutcome {
  return {
    schemaVersion,
    result: null,
    error: {
      code: "RPC_ERROR",
      message: `${prefix}: ${details}`,
    },
  };
}

function rpcFailure(
  schemaVersion: SchemaVersion,
  message: string,
): DispatchOutcome {
  return {
    schemaVersion,
    result: null,
    error: { code: "RPC_ERROR", message },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function methodRegistryFor(method: string): MethodVersionRegistry | null {
  const entry: unknown = Reflect.get(hostRpcRegistry, method);
  if (!isMethodVersionRegistry(entry)) {
    return null;
  }
  return entry;
}

function isMethodVersionRegistry(
  value: unknown,
): value is MethodVersionRegistry {
  return typeof value === "object" && value !== null;
}

function contractForVersion(
  methodRegistry: MethodVersionRegistry,
  schemaVersion: SchemaVersion,
): AnyRpcContract | null {
  const line = methodRegistry[schemaVersion.major];
  if (line === undefined) {
    return null;
  }
  return line.versions[schemaVersion.minor]?.contract ?? null;
}

function latestContract(methodRegistry: MethodVersionRegistry): AnyRpcContract {
  let latestMajor = Number.NEGATIVE_INFINITY;
  for (const key of Object.keys(methodRegistry)) {
    const major = Number(key);
    if (Number.isInteger(major) && major > latestMajor) {
      latestMajor = major;
    }
  }
  const line = methodRegistry[latestMajor];
  if (line === undefined) {
    throw new Error("Method registry has no installed versions");
  }
  return line.versions[line.latestMinor].contract;
}
