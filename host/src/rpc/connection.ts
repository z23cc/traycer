import type { WebSocket, RawData } from "ws";
import {
  RPC_REQUEST_TIMEOUT_FATAL_CODE,
  checkCompatibility,
  clientFrameSchema,
  type ClientOpenFrame,
  type FatalErrorDetails,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { authenticateOpenToken } from "../auth";
import { epochRejectionReason, evaluateClientEpoch } from "../epoch-gate";
import { hostUnaryManifests } from "../manifest";
import type { HostRuntime } from "../runtime";
import { dispatchHostRpc, type DispatchOutcome } from "./dispatch";

const POST_OPEN_TIMEOUT_MS = 30_000;
const POLICY_VIOLATION = 1008;

type ConnectionState = "pending" | "opened" | "closed";

export function attachRpcConnection(
  socket: WebSocket,
  runtime: HostRuntime,
): void {
  let state: ConnectionState = "pending";
  let postOpenTimer: NodeJS.Timeout | null = null;

  socket.on("message", (data, isBinary) => {
    void onMessage(data, isBinary).catch((error: unknown) => {
      reject(
        {
          code: "INTERNAL_ERROR",
          reason: `Internal error processing message: ${errorMessage(error)}`,
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
        "internal-error",
      );
    });
  });
  socket.on("close", () => {
    state = "closed";
    clearPostOpenTimer();
  });
  socket.on("error", () => {
    state = "closed";
    clearPostOpenTimer();
  });

  function clearPostOpenTimer(): void {
    if (postOpenTimer !== null) {
      clearTimeout(postOpenTimer);
      postOpenTimer = null;
    }
  }

  function reject(details: FatalErrorDetails, reason: string): void {
    if (state === "closed") {
      return;
    }
    state = "closed";
    clearPostOpenTimer();
    sendJson({ kind: "fatalError", details });
    socket.close(POLICY_VIOLATION, reason);
  }

  function sendJson(frame: unknown): void {
    if (socket.readyState !== socket.OPEN) {
      return;
    }
    socket.send(JSON.stringify(frame));
  }

  async function onMessage(data: RawData, isBinary: boolean): Promise<void> {
    if (state === "closed") {
      return;
    }
    if (isBinary) {
      reject(
        unauthorized("Binary WebSocket frames are not supported"),
        "binary",
      );
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawToString(data));
    } catch (error) {
      reject(
        unauthorized(`Invalid JSON frame: ${errorMessage(error)}`),
        "invalid-json",
      );
      return;
    }
    const frame = clientFrameSchema.safeParse(parsed);
    if (!frame.success) {
      reject(
        unauthorized(`Malformed client frame: ${frame.error.message}`),
        "malformed",
      );
      return;
    }
    const payload = frame.data;
    if (payload.kind === "fatalError") {
      state = "closed";
      clearPostOpenTimer();
      socket.close(POLICY_VIOLATION, "client fatal error");
      return;
    }
    if (payload.kind === "open") {
      handleOpen(payload);
      return;
    }
    if (state !== "opened") {
      reject(
        unauthorized(`Unexpected 'request' frame in state '${state}'`),
        "unexpected-request",
      );
      return;
    }
    clearPostOpenTimer();
    const requestId = payload.requestId;
    const method = payload.method;
    let outcome: DispatchOutcome;
    try {
      outcome = await dispatchHostRpc(
        method,
        payload.schemaVersion,
        payload.params,
        runtime,
      );
    } catch (error: unknown) {
      outcome = {
        ok: false,
        code: "RPC_ERROR",
        message: errorMessage(error),
        schemaVersion: payload.schemaVersion,
      };
    }
    if (socket.readyState !== socket.OPEN) {
      return;
    }
    if (outcome.ok) {
      sendJson({
        kind: "response",
        requestId,
        method,
        schemaVersion: outcome.schemaVersion,
        result: outcome.result,
        error: null,
      });
    } else {
      sendJson({
        kind: "response",
        requestId,
        method,
        schemaVersion: outcome.schemaVersion,
        result: null,
        error: { code: outcome.code, message: outcome.message },
      });
    }
    state = "closed";
    socket.close(1000, "rpc complete");
  }

  function handleOpen(open: ClientOpenFrame): void {
    if (state !== "pending") {
      reject(
        unauthorized(`Unexpected 'open' frame in state '${state}'`),
        "unexpected-open",
      );
      return;
    }
    const auth = authenticateOpenToken(open.token);
    if (auth === null) {
      reject(unauthorized("Missing bearer token"), "unauthorized");
      return;
    }
    const epoch = evaluateClientEpoch(open.clientIdentity);
    if (epoch !== null) {
      reject(
        {
          code: "INCOMPATIBLE",
          reason: epochRejectionReason(epoch),
          incompatibleMethods: null,
          upgradeGuidance: {
            clientShouldUpgrade: true,
            hostShouldUpgrade: false,
          },
          retryable: false,
          clientCompatibilityRequirement: epoch,
        },
        "incompatible-epoch",
      );
      return;
    }
    const hostManifests = hostUnaryManifests();
    const compat = checkCompatibility(
      hostRpcRegistry,
      hostManifests.manifest,
      open.manifest,
      "host",
    );
    if (!compat.ok) {
      reject(compat.details, "incompatible");
      return;
    }
    void auth;
    state = "opened";
    sendJson({
      kind: "openAck",
      manifest: hostManifests.manifest,
      optionalManifest: hostManifests.optionalManifest,
    });
    postOpenTimer = setTimeout(() => {
      reject(
        {
          code: RPC_REQUEST_TIMEOUT_FATAL_CODE,
          reason: `Timed out waiting for 'request' frame after openAck (${String(POST_OPEN_TIMEOUT_MS)}ms)`,
          incompatibleMethods: null,
          upgradeGuidance: null,
          retryable: true,
        },
        "rpc-timeout",
      );
    }, POST_OPEN_TIMEOUT_MS);
  }
}

function unauthorized(reason: string): FatalErrorDetails {
  return {
    code: "UNAUTHORIZED",
    reason,
    incompatibleMethods: null,
    upgradeGuidance: null,
  };
}

function rawToString(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
