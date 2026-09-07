import {
  claimShutdownRequestSchema,
  claimShutdownRequestSchemaV11,
  commitShutdownRequestSchema,
  releaseShutdownRequestSchema,
  type ShutdownClaimIntent,
} from "@traycer/protocol/host/lifecycle/schemas";
import { hostBusyVerdict } from "../../gui/busy";
import type { RpcHandler } from "./types";

/**
 * `@1.0` has no `intent`. Dispatch hands a handler whatever the CALLER's
 * contract parsed, so this reads both shapes and upgrades the older one the
 * way the contract's own upgrade path does - to `"shutdown"`, the reading that
 * publishes no restart tombstone.
 */
function readClaim(params: unknown): {
  readonly transitionId: string;
  readonly ttl: number;
  readonly intent: ShutdownClaimIntent;
} | null {
  const v11 = claimShutdownRequestSchemaV11.safeParse(params);
  if (v11.success) {
    return v11.data;
  }
  const v10 = claimShutdownRequestSchema.safeParse(params);
  if (v10.success) {
    return { ...v10.data, intent: "shutdown" };
  }
  return null;
}

export const handleClaimShutdown: RpcHandler = (params, runtime) => {
  const request = readClaim(params);
  if (request === null) {
    return { ok: false, code: "RPC_ERROR", message: "invalid claim request" };
  }
  // A host with work in flight is busy, as released - except to the
  // transition that already holds the claim, whose retried dial only
  // refreshes its lease.
  const now = Date.now();
  const held = runtime.shutdown.current(now);
  if (
    (held === null || held.transitionId !== request.transitionId) &&
    hostBusyVerdict(runtime).busySessionCount > 0
  ) {
    return { ok: true, result: { denied: "busy" } };
  }
  const granted = runtime.shutdown.claimFor(
    request.transitionId,
    request.ttl,
    request.intent,
    now,
  );
  if (granted === null) {
    return { ok: true, result: { denied: "busy" } };
  }
  return { ok: true, result: { granted: { token: granted.token } } };
};

export const handleCommitShutdown: RpcHandler = (params, runtime) => {
  const parsed = commitShutdownRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const claim = runtime.shutdown.take(parsed.data.token, Date.now());
  if (claim === null) {
    return { ok: true, result: { denied: "expired-or-unknown" } };
  }
  // The response has to reach the coordinator before the socket dies with the
  // process, so the exit is scheduled rather than awaited.
  // After the response is on the wire: the intent the claim was taken with
  // decides the exit code, and whether the tombstone goes out first.
  setTimeout(() => {
    runtime.requestShutdown(claim.intent);
  }, 0).unref();
  return { ok: true, result: { committed: true } };
};

export const handleReleaseShutdown: RpcHandler = (params, runtime) => {
  const parsed = releaseShutdownRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const claim = runtime.shutdown.take(parsed.data.token, Date.now());
  if (claim === null) {
    return { ok: true, result: { denied: "expired-or-unknown" } };
  }
  return { ok: true, result: { released: true } };
};
