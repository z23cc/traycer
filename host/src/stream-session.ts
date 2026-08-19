import {
  clientStreamOpenFrameSchema,
  clientStreamSubscribeFrameSchema,
  streamMethodFrameEnvelopeSchema,
  type StreamMethodFrameEnvelope,
} from "@traycer/protocol/framework/stream-ws-protocol";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  chatSubscribeV10,
  chatSubscribeV11,
  chatSubscribeV12,
  chatSubscribeV13,
  chatSubscribeV14,
  chatSubscribeV15,
  chatSubscribeV16,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { isAcceptedBearer } from "./auth";
import { handleChatClientFrame } from "./chat-frames";
import type { TurnRunner } from "./cli-runner";
import { openEpicStream, type EpicStreamBinding } from "./epic-stream";
import {
  openNotificationsStream,
  type NotificationsStreamBinding,
} from "./notifications-stream";
import { HostState } from "./store";
import {
  openGitStatusStream,
  type GitStatusStreamBinding,
} from "./git-status-stream";
import {
  openTerminalStream,
  type TerminalStreamBinding,
} from "./terminal-stream";
import {
  openWorktreeDeleteStream,
  type WorktreeDeleteStreamBinding,
} from "./worktree-delete-stream";
import {
  openAgentInboxStream,
  type AgentInboxStreamBinding,
} from "./agent-inbox-stream";

type StreamSend = (data: string | Uint8Array) => void;
type StreamReject = (code: string, reason: string) => void;

export const STREAM_PING_INTERVAL_MS = 25_000;
export const STREAM_PONG_TIMEOUT_MS = 60_000;

export type StreamSessionOptions = {
  readonly sendTransportPing: () => void;
  readonly close: (code: number, reason: string) => void;
  readonly pingIntervalMs: number;
  readonly pongTimeoutMs: number;
};

type BoundChat = {
  readonly method: "chat.subscribe";
  readonly epicId: string;
  readonly chatId: string;
};

type PendingBinaryFrame = {
  readonly envelope: StreamMethodFrameEnvelope;
};

type MethodStreamBinding =
  | EpicStreamBinding
  | GitStatusStreamBinding
  | NotificationsStreamBinding
  | TerminalStreamBinding
  | AgentInboxStreamBinding
  | WorktreeDeleteStreamBinding;

export function createStreamSession(
  send: StreamSend,
  state: HostState,
  runner: TurnRunner,
  options: StreamSessionOptions | undefined,
): {
  readonly onMessage: (raw: string) => void;
  readonly onBinaryMessage: (payload: Uint8Array) => void;
  readonly onTransportPong: () => void;
  readonly dispose: () => void;
} {
  let phase: "awaiting-open" | "awaiting-subscribe" | "subscribed" =
    "awaiting-open";
  let unsubscribe: (() => void) | null = null;
  let boundChat: BoundChat | null = null;
  let boundMethodStream: MethodStreamBinding | null = null;
  let pendingBinaryFrame: PendingBinaryFrame | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let pongDeadlineTimer: NodeJS.Timeout | null = null;
  let transportPongSinceDeadlineArm = false;
  let disposed = false;
  const advertised = advertisedStreamManifest();
  const heartbeat = options ?? {
    sendTransportPing: () => {},
    close: () => {},
    pingIntervalMs: STREAM_PING_INTERVAL_MS,
    pongTimeoutMs: STREAM_PONG_TIMEOUT_MS,
  };

  function clearHeartbeat(): void {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (pongDeadlineTimer !== null) {
      clearTimeout(pongDeadlineTimer);
      pongDeadlineTimer = null;
    }
  }

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    clearHeartbeat();
    pendingBinaryFrame = null;
    unsubscribe?.();
    unsubscribe = null;
  }

  function emitHeartbeatPing(): void {
    if (disposed || phase !== "subscribed") {
      return;
    }
    sendJson(send, { kind: "ping", hasBinaryPayload: false });
    heartbeat.sendTransportPing();
    if (pongDeadlineTimer !== null) {
      return;
    }
    transportPongSinceDeadlineArm = false;
    pongDeadlineTimer = setTimeout(() => {
      pongDeadlineTimer = null;
      if (disposed) {
        return;
      }
      if (transportPongSinceDeadlineArm) {
        return;
      }
      const reason = `No pong received within ${heartbeat.pongTimeoutMs}ms`;
      sendFatal(send, "STREAM_HEARTBEAT_TIMEOUT", reason);
      heartbeat.close(1008, reason);
      dispose();
    }, heartbeat.pongTimeoutMs);
  }

  function startHeartbeat(): void {
    clearHeartbeat();
    heartbeatTimer = setInterval(emitHeartbeatPing, heartbeat.pingIntervalMs);
  }

  function rejectFatal(code: string, reason: string): void {
    sendFatal(send, code, reason);
    heartbeat.close(1008, reason);
    dispose();
  }

  function rejectProtocol(reason: string): void {
    rejectFatal("STREAM_PROTOCOL_ERROR", reason);
  }

  return {
    onMessage(raw: string): void {
      if (disposed) {
        return;
      }
      if (phase === "awaiting-open") {
        const open = clientStreamOpenFrameSchema.safeParse(parseJson(raw));
        if (!open.success || !isAcceptedBearer(open.data.token)) {
          rejectFatal("UNAUTHORIZED", "Missing bearer token");
          return;
        }
        phase = "awaiting-subscribe";
        sendJson(send, {
          kind: "openAck",
          manifest: advertised,
          capabilities: [],
          hostCredentialState: null,
        });
        return;
      }
      if (phase === "awaiting-subscribe") {
        const subscribe = clientStreamSubscribeFrameSchema.safeParse(
          parseJson(raw),
        );
        if (!subscribe.success) {
          rejectFatal("RPC_ERROR", "Expected subscribe frame");
          return;
        }
        const bound = bindSubscription(
          send,
          state,
          subscribe.data.method,
          subscribe.data.schemaVersion,
          subscribe.data.params,
          rejectFatal,
        );
        if (!bound.accepted) {
          return;
        }
        phase = "subscribed";
        unsubscribe = bound.unsubscribe;
        boundChat = bound.chat;
        boundMethodStream = bound.methodStream;
        startHeartbeat();
        return;
      }
      if (pendingBinaryFrame !== null) {
        rejectProtocol(
          "Unexpected text frame while awaiting paired binary payload",
        );
        return;
      }
      const applicationJson = parseApplicationJson(raw);
      if (!applicationJson.ok) {
        rejectProtocol(`Invalid JSON frame: ${applicationJson.reason}`);
        return;
      }
      const parsed = applicationJson.value;
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        rejectProtocol("Text frame is not a JSON object");
        return;
      }
      if (isPingFrame(parsed)) {
        sendJson(send, { kind: "pong", hasBinaryPayload: false });
        return;
      }
      if (isPongFrame(parsed)) {
        if (pongDeadlineTimer !== null) {
          clearTimeout(pongDeadlineTimer);
          pongDeadlineTimer = null;
        }
        return;
      }
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "kind" in parsed &&
        parsed.kind === "fatalError"
      ) {
        return;
      }
      const envelope = streamMethodFrameEnvelopeSchema.safeParse(parsed);
      if (!envelope.success) {
        rejectProtocol(`Malformed stream envelope: ${envelope.error.message}`);
        return;
      }
      if (envelope.data.hasBinaryPayload) {
        pendingBinaryFrame = { envelope: envelope.data };
        return;
      }
      if (boundMethodStream !== null) {
        boundMethodStream.onFrame(envelope.data, null);
        return;
      }
      if (boundChat !== null) {
        handleChatClientFrame(
          state,
          runner,
          boundChat.epicId,
          boundChat.chatId,
          envelope.data,
        );
      }
    },
    onBinaryMessage(payload: Uint8Array): void {
      if (disposed) {
        return;
      }
      if (phase !== "subscribed") {
        rejectProtocol(`Unexpected binary frame in state '${phase}'`);
        return;
      }
      const pending = pendingBinaryFrame;
      if (pending === null) {
        rejectProtocol(
          "Unexpected binary frame without a paired text envelope",
        );
        return;
      }
      pendingBinaryFrame = null;
      if (boundMethodStream !== null) {
        boundMethodStream.onFrame(pending.envelope, payload);
        return;
      }
      if (boundChat !== null) {
        handleChatClientFrame(
          state,
          runner,
          boundChat.epicId,
          boundChat.chatId,
          pending.envelope,
        );
      }
    },
    onTransportPong(): void {
      if (!disposed) {
        transportPongSinceDeadlineArm = true;
      }
    },
    dispose,
  };
}

function bindSubscription(
  send: StreamSend,
  state: HostState,
  method: string,
  schemaVersion: { readonly major: number; readonly minor: number },
  params: unknown,
  reject: StreamReject,
): {
  readonly accepted: boolean;
  readonly unsubscribe: (() => void) | null;
  readonly chat: BoundChat | null;
  readonly methodStream: MethodStreamBinding | null;
} {
  if (method === "epic.subscribe") {
    return bindEpicSubscribe(send, state, schemaVersion, params, reject);
  }
  if (method === "chat.subscribe") {
    return bindChatSubscribe(send, state, schemaVersion, params, reject);
  }
  if (method === "git.subscribeStatus") {
    return bindGitStatusSubscribe(send, schemaVersion, params, reject);
  }
  if (method === "notifications.subscribe") {
    return bindNotificationsSubscribe(send, state, params, reject);
  }
  if (method === "terminal.subscribe") {
    return bindTerminalSubscribe(send, state, schemaVersion, params, reject);
  }
  if (method === "agent.inbox.subscribe") {
    return bindAgentInboxSubscribe(send, state, schemaVersion, params, reject);
  }
  if (method === "worktree.deleteByPath") {
    return bindWorktreeDeleteSubscribe(
      send,
      state,
      schemaVersion,
      params,
      reject,
    );
  }
  reject("E_HOST_UNSUPPORTED", `${method} is not implemented`);
  return {
    accepted: false,
    unsubscribe: null,
    chat: null,
    methodStream: null,
  };
}

function bindAgentInboxSubscribe(
  send: StreamSend,
  state: HostState,
  schemaVersion: { readonly major: number; readonly minor: number },
  params: unknown,
  reject: StreamReject,
): {
  readonly accepted: boolean;
  readonly unsubscribe: (() => void) | null;
  readonly chat: BoundChat | null;
  readonly methodStream: MethodStreamBinding | null;
} {
  const opened = openAgentInboxStream(send, state, schemaVersion, params);
  if (!opened.accepted) {
    reject(opened.code, opened.reason);
    return {
      accepted: false,
      unsubscribe: null,
      chat: null,
      methodStream: null,
    };
  }
  return {
    accepted: true,
    unsubscribe: opened.binding.dispose,
    chat: null,
    methodStream: opened.binding,
  };
}

function bindWorktreeDeleteSubscribe(
  send: StreamSend,
  state: HostState,
  schemaVersion: { readonly major: number; readonly minor: number },
  params: unknown,
  reject: StreamReject,
): {
  readonly accepted: boolean;
  readonly unsubscribe: (() => void) | null;
  readonly chat: BoundChat | null;
  readonly methodStream: MethodStreamBinding | null;
} {
  const opened = openWorktreeDeleteStream(send, state, schemaVersion, params);
  if (!opened.accepted) {
    reject(opened.code, opened.reason);
    return {
      accepted: false,
      unsubscribe: null,
      chat: null,
      methodStream: null,
    };
  }
  return {
    accepted: true,
    unsubscribe: opened.binding.dispose,
    chat: null,
    methodStream: opened.binding,
  };
}

function bindGitStatusSubscribe(
  send: StreamSend,
  schemaVersion: { readonly major: number; readonly minor: number },
  params: unknown,
  reject: StreamReject,
): {
  readonly accepted: boolean;
  readonly unsubscribe: (() => void) | null;
  readonly chat: BoundChat | null;
  readonly methodStream: MethodStreamBinding | null;
} {
  const opened = openGitStatusStream(send, schemaVersion, params, undefined);
  if (!opened.accepted) {
    reject(opened.code, opened.reason);
    return {
      accepted: false,
      unsubscribe: null,
      chat: null,
      methodStream: null,
    };
  }
  return {
    accepted: true,
    unsubscribe: opened.binding.dispose,
    chat: null,
    methodStream: opened.binding,
  };
}

function bindTerminalSubscribe(
  send: StreamSend,
  state: HostState,
  schemaVersion: { readonly major: number; readonly minor: number },
  params: unknown,
  reject: StreamReject,
): {
  readonly accepted: boolean;
  readonly unsubscribe: (() => void) | null;
  readonly chat: BoundChat | null;
  readonly methodStream: MethodStreamBinding | null;
} {
  const opened = openTerminalStream(send, state, schemaVersion, params);
  if (!opened.accepted) {
    reject(opened.code, opened.reason);
    return {
      accepted: false,
      unsubscribe: null,
      chat: null,
      methodStream: null,
    };
  }
  return {
    accepted: true,
    unsubscribe: opened.binding.dispose,
    chat: null,
    methodStream: opened.binding,
  };
}

function bindEpicSubscribe(
  send: StreamSend,
  state: HostState,
  schemaVersion: { readonly major: number; readonly minor: number },
  params: unknown,
  reject: StreamReject,
): {
  readonly accepted: boolean;
  readonly unsubscribe: (() => void) | null;
  readonly chat: BoundChat | null;
  readonly methodStream: MethodStreamBinding | null;
} {
  const opened = openEpicStream(send, state, schemaVersion, params);
  if (!opened.accepted) {
    reject(opened.code, opened.reason);
    return {
      accepted: false,
      unsubscribe: null,
      chat: null,
      methodStream: null,
    };
  }
  return {
    accepted: true,
    unsubscribe: opened.binding.dispose,
    chat: null,
    methodStream: opened.binding,
  };
}

function bindChatSubscribe(
  send: StreamSend,
  state: HostState,
  schemaVersion: { readonly major: number; readonly minor: number },
  params: unknown,
  reject: StreamReject,
): {
  readonly accepted: boolean;
  readonly unsubscribe: (() => void) | null;
  readonly chat: BoundChat | null;
  readonly methodStream: MethodStreamBinding | null;
} {
  const contract = chatSubscribeContract(schemaVersion);
  if (contract === null) {
    reject(
      "E_HOST_UNSUPPORTED",
      `chat.subscribe ${schemaVersion.major}.${schemaVersion.minor} is not implemented`,
    );
    return {
      accepted: false,
      unsubscribe: null,
      chat: null,
      methodStream: null,
    };
  }
  const parsed = contract.openRequestSchema.safeParse(params);
  if (!parsed.success) {
    reject("E_INVALID_ARGUMENT", parsed.error.message);
    return {
      accepted: false,
      unsubscribe: null,
      chat: null,
      methodStream: null,
    };
  }
  const chat = state.getChat(parsed.data.epicId, parsed.data.chatId);
  if (chat === null) {
    reject("E_INVALID_ARGUMENT", `Unknown chat ${parsed.data.chatId}`);
    return {
      accepted: false,
      unsubscribe: null,
      chat: null,
      methodStream: null,
    };
  }
  const sendFrame = (frame: unknown): boolean => {
    const projected = contract.serverFrameSchema.safeParse(frame);
    if (!projected.success) {
      reject(
        "STREAM_PROTOCOL_ERROR",
        `chat.subscribe ${schemaVersion.major}.${schemaVersion.minor} frame projection failed: ${projected.error.message}`,
      );
      return false;
    }
    sendJson(send, projected.data);
    return true;
  };
  if (!sendFrame(state.snapshotFrame(parsed.data.epicId, chat))) {
    return {
      accepted: false,
      unsubscribe: null,
      chat: null,
      methodStream: null,
    };
  }
  return {
    accepted: true,
    unsubscribe: state.subscribeChat(
      parsed.data.epicId,
      parsed.data.chatId,
      (frame) => {
        sendFrame(frame);
      },
    ),
    chat: {
      method: "chat.subscribe",
      epicId: parsed.data.epicId,
      chatId: parsed.data.chatId,
    },
    methodStream: null,
  };
}

function chatSubscribeContract(schemaVersion: {
  readonly major: number;
  readonly minor: number;
}) {
  if (schemaVersion.major !== 1) {
    return null;
  }
  switch (schemaVersion.minor) {
    case 0:
      return chatSubscribeV10;
    case 1:
      return chatSubscribeV11;
    case 2:
      return chatSubscribeV12;
    case 3:
      return chatSubscribeV13;
    case 4:
      return chatSubscribeV14;
    case 5:
      return chatSubscribeV15;
    case 6:
      return chatSubscribeV16;
    default:
      return null;
  }
}

function bindNotificationsSubscribe(
  send: StreamSend,
  state: HostState,
  params: unknown,
  reject: StreamReject,
): {
  readonly accepted: boolean;
  readonly unsubscribe: (() => void) | null;
  readonly chat: BoundChat | null;
  readonly methodStream: MethodStreamBinding | null;
} {
  const opened = openNotificationsStream(send, state, params);
  if (!opened.accepted) {
    reject(opened.code, opened.reason);
    return {
      accepted: false,
      unsubscribe: null,
      chat: null,
      methodStream: null,
    };
  }
  return {
    accepted: true,
    unsubscribe: opened.binding.dispose,
    chat: null,
    methodStream: opened.binding,
  };
}

function advertisedStreamManifest(): Record<
  string,
  { major: number; minor: number }
> {
  const full = buildStreamManifest(hostStreamRpcRegistry);
  const epic = full["epic.subscribe"];
  const chat = full["chat.subscribe"];
  const git = full["git.subscribeStatus"];
  const terminal = full["terminal.subscribe"];
  const agentInbox = full["agent.inbox.subscribe"];
  const worktreeDelete = full["worktree.deleteByPath"];
  const manifest: Record<string, { major: number; minor: number }> = {};
  if (epic !== undefined) {
    manifest["epic.subscribe"] = epic;
  }
  if (chat !== undefined) {
    manifest["chat.subscribe"] = chat;
  }
  if (git !== undefined) {
    manifest["git.subscribeStatus"] = { major: 1, minor: 0 };
  }
  if (terminal !== undefined) {
    manifest["terminal.subscribe"] = terminal;
  }
  if (agentInbox !== undefined) {
    manifest["agent.inbox.subscribe"] = agentInbox;
  }
  if (worktreeDelete !== undefined) {
    manifest["worktree.deleteByPath"] = { major: 1, minor: 0 };
  }
  manifest["notifications.subscribe"] = { major: 1, minor: 0 };
  return manifest;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseApplicationJson(
  raw: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function isPingFrame(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    Reflect.get(value, "kind") === "ping" &&
    Reflect.get(value, "hasBinaryPayload") === false
  );
}

function isPongFrame(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    Reflect.get(value, "kind") === "pong" &&
    Reflect.get(value, "hasBinaryPayload") === false
  );
}

function sendJson(send: StreamSend, frame: unknown): void {
  send(JSON.stringify(frame));
}

function sendFatal(send: StreamSend, code: string, reason: string): void {
  sendJson(send, {
    kind: "fatalError",
    details: {
      code,
      reason,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  });
}
