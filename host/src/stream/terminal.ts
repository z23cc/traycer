import type { WebSocket } from "ws";
import { terminalSubscribeClientFrameSchema } from "@traycer/protocol/host/terminal/subscribe";
import type { HostRuntime } from "../runtime";

export type TerminalStreamSession = {
  handleFrame: (parsed: unknown) => boolean;
  dispose: () => void;
};

export function attachTerminalStream(
  socket: WebSocket,
  runtime: HostRuntime,
  params: unknown,
): TerminalStreamSession | null {
  const sessionId = readSessionId(params);
  if (sessionId === null) {
    return null;
  }
  const session = runtime.terminals.get(sessionId);
  if (session === null) {
    sendJson(socket, {
      kind: "exit",
      hasBinaryPayload: false,
      sessionId,
      exitCode: 1,
    });
    return null;
  }
  const cols = readPositive(params, "cols");
  const rows = readPositive(params, "rows");
  if (cols !== null && rows !== null) {
    runtime.terminals.put({ ...session, cols, rows });
    runtime.pty.resize(sessionId, cols, rows);
  }
  sendJson(socket, {
    kind: "snapshot",
    hasBinaryPayload: false,
    sessionId,
    session: runtime.terminals.get(sessionId) ?? session,
    scrollback: runtime.pty.scrollback(sessionId),
    ackCreditSupported: true,
  });
  const onData = (id: string, chunk: string): void => {
    if (id === sessionId) {
      sendJson(socket, {
        kind: "data",
        hasBinaryPayload: false,
        sessionId,
        chunk,
      });
    }
  };
  const onExit = (id: string, exitCode: number): void => {
    if (id === sessionId) {
      sendJson(socket, {
        kind: "exit",
        hasBinaryPayload: false,
        sessionId,
        exitCode,
      });
    }
  };
  runtime.pty.on("data", onData);
  runtime.pty.on("exit", onExit);
  return {
    handleFrame: (parsed: unknown): boolean => {
      const frame = terminalSubscribeClientFrameSchema.safeParse(parsed);
      if (!frame.success) {
        return false;
      }
      if (frame.data.kind === "ping") {
        sendJson(socket, { kind: "pong", hasBinaryPayload: false });
        return true;
      }
      if (frame.data.kind === "ack") {
        return true;
      }
      if (frame.data.kind === "write") {
        const accepted = runtime.pty.write(sessionId, frame.data.data);
        sendJson(socket, {
          kind: "actionAck",
          hasBinaryPayload: false,
          sessionId,
          clientActionId: frame.data.clientActionId,
          action: "write",
          status: accepted ? "accepted" : "rejected",
          reason: accepted ? null : "session not running",
          code: accepted ? null : "not_running",
        });
        return true;
      }
      if (frame.data.kind === "resize") {
        const accepted = runtime.pty.resize(
          sessionId,
          frame.data.cols,
          frame.data.rows,
        );
        if (accepted) {
          const current = runtime.terminals.get(sessionId);
          if (current !== null) {
            runtime.terminals.put({
              ...current,
              cols: frame.data.cols,
              rows: frame.data.rows,
            });
          }
          sendJson(socket, {
            kind: "resized",
            hasBinaryPayload: false,
            sessionId,
            cols: frame.data.cols,
            rows: frame.data.rows,
          });
        }
        sendJson(socket, {
          kind: "actionAck",
          hasBinaryPayload: false,
          sessionId,
          clientActionId: frame.data.clientActionId,
          action: "resize",
          status: accepted ? "accepted" : "rejected",
          reason: accepted ? null : "session not running",
          code: accepted ? null : "not_running",
        });
        return true;
      }
      return false;
    },
    dispose: () => {
      runtime.pty.off("data", onData);
      runtime.pty.off("exit", onExit);
    },
  };
}

function readSessionId(params: unknown): string | null {
  if (params === null || typeof params !== "object") {
    return null;
  }
  const sessionId = Reflect.get(params, "sessionId");
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
}

function readPositive(params: unknown, key: string): number | null {
  if (params === null || typeof params !== "object") {
    return null;
  }
  const value = Reflect.get(params, key);
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function sendJson(socket: WebSocket, frame: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(frame));
  }
}
