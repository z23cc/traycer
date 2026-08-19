import type { SchemaVersion } from "@traycer/protocol/framework";
import type { StreamMethodFrameEnvelope } from "@traycer/protocol/framework/stream-ws-protocol";
import {
  terminalSubscribeClientFrameSchema,
  terminalSubscribeOpenRequestSchema,
  terminalSubscribeServerFrameSchema,
  terminalSubscribeServerFrameSchemaV14,
  terminalSubscribeServerFrameSchemaV15,
  terminalSubscribeV10,
  terminalSubscribeV11,
  terminalSubscribeV12,
  terminalSubscribeV15,
} from "@traycer/protocol/host/terminal/subscribe";
import type {
  CanonicalTerminalSessionInfoWithCurrentCwd,
  TerminalSessionInfo,
} from "@traycer/protocol/host/terminal/unary-schemas";
import type { HostState } from "./store";
import type { TerminalSessionEvent } from "./terminal-session-manager";

type StreamSend = (data: string | Uint8Array) => void;

export type TerminalStreamBinding = {
  readonly method: "terminal.subscribe";
  readonly onFrame: (
    envelope: StreamMethodFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ) => void;
  readonly dispose: () => void;
};

export type OpenTerminalStreamResult =
  | { readonly accepted: true; readonly binding: TerminalStreamBinding }
  | {
      readonly accepted: false;
      readonly code: "E_INVALID_ARGUMENT" | "E_HOST_UNSUPPORTED";
      readonly reason: string;
    };

export function openTerminalStream(
  send: StreamSend,
  state: HostState,
  schemaVersion: SchemaVersion,
  params: unknown,
): OpenTerminalStreamResult {
  if (!supportsTerminalVersion(schemaVersion)) {
    return {
      accepted: false,
      code: "E_HOST_UNSUPPORTED",
      reason: `terminal.subscribe ${schemaVersion.major}.${schemaVersion.minor} is not implemented`,
    };
  }
  const parsed = terminalSubscribeOpenRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      accepted: false,
      code: "E_INVALID_ARGUMENT",
      reason: parsed.error.message,
    };
  }
  const { sessionId, cols, rows } = parsed.data;

  const sendProjected = (frame: unknown): void => {
    const projected = projectServerFrame(schemaVersion, frame);
    if (projected.success) {
      send(JSON.stringify(projected.data));
    }
  };
  const subscription = state.terminalSessions.subscribe(
    sessionId,
    cols,
    rows,
    (event) =>
      sendTerminalEvent(sendProjected, schemaVersion, sessionId, event),
  );
  if (subscription === null) {
    return {
      accepted: false,
      code: "E_INVALID_ARGUMENT",
      reason: `Unknown terminal ${sessionId}`,
    };
  }
  if (schemaVersion.minor <= 3 && subscription.session.scope.kind !== "epic") {
    subscription.dispose();
    return {
      accepted: false,
      code: "E_HOST_UNSUPPORTED",
      reason:
        "Independent terminal sessions require terminal.subscribe@1.4 or newer",
    };
  }
  sendProjected({
    kind: "snapshot",
    hasBinaryPayload: false,
    sessionId,
    session: projectSession(schemaVersion, subscription.session),
    scrollback: subscription.scrollback,
    ...(schemaVersion.minor >= 1 ? { ackCreditSupported: true } : {}),
  });

  return {
    accepted: true,
    binding: {
      method: "terminal.subscribe",
      onFrame: (envelope) => {
        const frame = terminalSubscribeClientFrameSchema.safeParse(envelope);
        if (!frame.success) {
          return;
        }
        const value = frame.data;
        if (value.kind === "ack" || value.kind === "ping") {
          return;
        }
        if (value.kind === "write") {
          const accepted =
            value.sessionId === sessionId && subscription.write(value.data);
          sendActionAck(
            sendProjected,
            sessionId,
            value.clientActionId,
            "write",
            accepted,
          );
          return;
        }
        if (value.kind === "resize") {
          const accepted =
            value.sessionId === sessionId &&
            subscription.resize(value.cols, value.rows);
          sendActionAck(
            sendProjected,
            sessionId,
            value.clientActionId,
            "resize",
            accepted,
          );
        }
      },
      dispose: subscription.dispose,
    },
  };
}

function sendTerminalEvent(
  send: (frame: unknown) => void,
  schemaVersion: SchemaVersion,
  sessionId: string,
  event: TerminalSessionEvent,
): void {
  if (event.kind === "data") {
    send({
      kind: "data",
      hasBinaryPayload: false,
      sessionId,
      chunk: event.chunk,
    });
    return;
  }
  if (event.kind === "resized") {
    send({
      kind: "resized",
      hasBinaryPayload: false,
      sessionId,
      cols: event.cols,
      rows: event.rows,
    });
    return;
  }
  if (event.kind === "exit") {
    send({
      kind: "exit",
      hasBinaryPayload: false,
      sessionId,
      exitCode: event.exitCode,
    });
    return;
  }
  if (schemaVersion.minor >= 3) {
    send({
      kind: "sessionUpdated",
      hasBinaryPayload: false,
      sessionId,
      session: projectSession(schemaVersion, event.session),
    });
  }
}

function sendActionAck(
  send: (frame: unknown) => void,
  sessionId: string,
  clientActionId: string,
  action: "write" | "resize",
  accepted: boolean,
): void {
  send({
    kind: "actionAck",
    hasBinaryPayload: false,
    sessionId,
    clientActionId,
    action,
    status: accepted ? "accepted" : "rejected",
    reason: accepted ? null : "Terminal session is not running",
    code: accepted ? null : "TERMINAL_NOT_RUNNING",
  });
}

function projectSession(
  schemaVersion: SchemaVersion,
  session: CanonicalTerminalSessionInfoWithCurrentCwd,
): CanonicalTerminalSessionInfoWithCurrentCwd | TerminalSessionInfo | object {
  if (schemaVersion.minor >= 5) {
    return session;
  }
  const { currentCwd: _currentCwd, ...withoutCurrentCwd } = session;
  if (schemaVersion.minor >= 4) {
    return withoutCurrentCwd;
  }
  if (session.scope.kind !== "epic") {
    return withoutCurrentCwd;
  }
  const { scope: _scope, ...legacy } = withoutCurrentCwd;
  return { ...legacy, epicId: session.scope.epicId };
}

function supportsTerminalVersion(schemaVersion: SchemaVersion): boolean {
  if (schemaVersion.major !== 1) {
    return false;
  }
  switch (schemaVersion.minor) {
    case 0:
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
      return true;
    default:
      return false;
  }
}

function projectServerFrame(schemaVersion: SchemaVersion, frame: unknown) {
  switch (schemaVersion.minor) {
    case 0:
      return terminalSubscribeV10.serverFrameSchema.safeParse(frame);
    case 1:
      return terminalSubscribeV11.serverFrameSchema.safeParse(frame);
    case 2:
      return terminalSubscribeV12.serverFrameSchema.safeParse(frame);
    case 3:
      return terminalSubscribeServerFrameSchema.safeParse(frame);
    case 4:
      return terminalSubscribeServerFrameSchemaV14.safeParse(frame);
    case 5:
      return terminalSubscribeServerFrameSchemaV15.safeParse(frame);
    default:
      return terminalSubscribeV15.serverFrameSchema.safeParse(frame);
  }
}
