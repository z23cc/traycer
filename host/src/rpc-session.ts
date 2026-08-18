import { check } from "@traycer/protocol/framework/compatibility-checker";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import {
  clientFrameSchema,
  type ClientRequestFrame,
  type FatalErrorDetails,
  type HostFrame,
} from "@traycer/protocol/framework/ws-protocol";
import { isAcceptedBearer } from "./auth";
import { dispatchRequest, type DispatchOutcome } from "./dispatch";
import type { MethodDispatcher } from "./handlers";
import { hostConnectionManifest } from "./manifest";

type SessionPhase = "awaiting-open" | "ready";

export type RpcSession = {
  readonly onMessage: (raw: string) => void;
};

export function createRpcSession(
  send: (frame: HostFrame) => void,
  handleMethod: MethodDispatcher,
): RpcSession {
  let phase: SessionPhase = "awaiting-open";
  const hostManifest = hostConnectionManifest();

  return {
    onMessage(raw: string): void {
      const parsed = clientFrameSchema.safeParse(parseJson(raw));
      if (!parsed.success) {
        sendFatal(send, {
          code: "RPC_ERROR",
          reason: "Malformed client frame",
          incompatibleMethods: null,
          upgradeGuidance: null,
        });
        return;
      }
      const frame = parsed.data;
      if (frame.kind === "fatalError") {
        return;
      }
      if (phase === "awaiting-open") {
        if (frame.kind !== "open") {
          sendFatal(send, {
            code: "RPC_ERROR",
            reason: "First frame must be open",
            incompatibleMethods: null,
            upgradeGuidance: null,
          });
          return;
        }
        if (!isAcceptedBearer(frame.token)) {
          sendFatal(send, {
            code: "UNAUTHORIZED",
            reason: "Missing bearer token",
            incompatibleMethods: null,
            upgradeGuidance: null,
          });
          return;
        }
        const compat = check(
          hostRpcRegistry,
          hostManifest.manifest,
          frame.manifest,
          "host",
        );
        if (!compat.ok) {
          send({ kind: "fatalError", details: compat.details });
          return;
        }
        phase = "ready";
        send({
          kind: "openAck",
          manifest: hostManifest.manifest,
          optionalManifest: hostManifest.optionalManifest,
        });
        return;
      }
      if (frame.kind !== "request") {
        sendFatal(send, {
          code: "RPC_ERROR",
          reason: "Expected a request frame",
          incompatibleMethods: null,
          upgradeGuidance: null,
        });
        return;
      }
      const outcome = dispatchRequest({
        method: frame.method,
        schemaVersion: frame.schemaVersion,
        params: frame.params,
        handleMethod,
      });
      if (outcome instanceof Promise) {
        void outcome.then((resolved) => {
          sendResponse(send, frame, resolved);
        });
        return;
      }
      sendResponse(send, frame, outcome);
    },
  };
}

function sendResponse(
  send: (frame: HostFrame) => void,
  request: ClientRequestFrame,
  outcome: DispatchOutcome,
): void {
  send({
    kind: "response",
    requestId: request.requestId,
    method: request.method,
    schemaVersion: outcome.schemaVersion,
    result: outcome.result,
    error: outcome.error,
  });
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sendFatal(
  send: (frame: HostFrame) => void,
  details: FatalErrorDetails,
): void {
  send({ kind: "fatalError", details });
}
