import type { WebSocket, RawData } from "ws";
import type { FatalErrorDetails } from "@traycer/protocol/framework/index";
import { checkStreamCompatibility } from "@traycer/protocol/framework/stream-compat";
import {
  STREAM_CAPABILITY_CREDENTIAL_UPDATE,
  STREAM_CAPABILITY_HOST_CREDENTIAL_PROVISION,
  STREAM_SUBSCRIBE_TIMEOUT_FATAL_CODE,
  clientStreamOpenFrameSchema,
  clientStreamSubscribeFrameSchema,
} from "@traycer/protocol/framework/stream-ws-protocol";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { authenticateOpenToken } from "../auth";
import { epochRejectionReason, evaluateClientEpoch } from "../epoch-gate";
import { clientStreamManifestOverlap, hostStreamManifest } from "../manifest";
import type { HostRuntime } from "../runtime";
import { snapshotFrame } from "../gui/notifications";
import { handleChatClientFrame } from "./chat-actions";
import { sendChatSnapshot } from "./chat";
import { attachGitStatusStream } from "./git-status";
import {
  sendAgentActivitySnapshot,
  sendAnalogStreamSnapshot,
  sendEpicSnapshot,
  sendEpicStatusSnapshot,
  sendNotificationsSnapshot,
} from "./snapshots";
import { attachTerminalStream, type TerminalStreamSession } from "./terminal";

const SUBSCRIBE_TIMEOUT_MS = 30_000;
const POLICY_VIOLATION = 1008;

type StreamState = "pending" | "opened" | "subscribed" | "closed";

type PendingBinary = {
  readonly kind: string;
  readonly epicId: string;
  readonly artifactRoomId: string | null;
};

export function attachStreamConnection(
  socket: WebSocket,
  runtime: HostRuntime,
): void {
  let state: StreamState = "pending";
  let subscribeTimer: NodeJS.Timeout | null = null;
  let terminalStream: TerminalStreamSession | null = null;
  let pendingBinary: PendingBinary | null = null;
  const hostManifest = hostStreamManifest();

  socket.on("message", (data, isBinary) => {
    onMessage(data, isBinary);
  });
  socket.on("close", () => {
    state = "closed";
    clearSubscribeTimer();
    runtime.chats.remove(socket);
    runtime.notifications.remove(socket);
    runtime.epics.remove(socket);
    terminalStream?.dispose();
    terminalStream = null;
  });
  socket.on("error", () => {
    state = "closed";
    clearSubscribeTimer();
    runtime.chats.remove(socket);
    runtime.notifications.remove(socket);
    runtime.epics.remove(socket);
    terminalStream?.dispose();
    terminalStream = null;
  });

  function clearSubscribeTimer(): void {
    if (subscribeTimer !== null) {
      clearTimeout(subscribeTimer);
      subscribeTimer = null;
    }
  }

  function reject(details: FatalErrorDetails, reason: string): void {
    if (state === "closed") {
      return;
    }
    state = "closed";
    clearSubscribeTimer();
    sendJson({ kind: "fatalError", details });
    socket.close(POLICY_VIOLATION, reason);
  }

  function sendJson(frame: unknown): void {
    if (socket.readyState !== socket.OPEN) {
      return;
    }
    socket.send(JSON.stringify(frame));
  }

  function onMessage(data: RawData, isBinary: boolean): void {
    if (state === "closed") {
      return;
    }
    if (isBinary) {
      if (state === "subscribed" && pendingBinary !== null) {
        applyPendingBinary(rawToBuffer(data));
        pendingBinary = null;
      }
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
    if (state === "pending") {
      handleOpen(parsed);
      return;
    }
    if (state === "opened") {
      handleSubscribe(parsed);
      return;
    }
    handleApplication(parsed);
  }

  function handleOpen(parsed: unknown): void {
    const open = clientStreamOpenFrameSchema.safeParse(parsed);
    if (!open.success) {
      reject(
        unauthorized(`Malformed client frame: ${open.error.message}`),
        "malformed",
      );
      return;
    }
    const auth = authenticateOpenToken(open.data.token);
    if (auth === null) {
      reject(unauthorized("Missing bearer token"), "unauthorized");
      return;
    }
    const epoch = evaluateClientEpoch(open.data.clientIdentity);
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
    const clientManifest = open.data.manifest;
    const advertised =
      Object.keys(clientManifest).length === 0 ? {} : hostManifest;
    if (Object.keys(clientManifest).length > 0) {
      const compat = checkStreamCompatibility(
        hostStreamRpcRegistry,
        advertised,
        clientStreamManifestOverlap(advertised, clientManifest),
        "host",
      );
      if (!compat.ok) {
        reject(compat.details, "incompatible");
        return;
      }
    }
    void auth;
    state = "opened";
    sendJson({
      kind: "openAck",
      manifest: advertised,
      capabilities: [
        STREAM_CAPABILITY_CREDENTIAL_UPDATE,
        STREAM_CAPABILITY_HOST_CREDENTIAL_PROVISION,
      ],
      hostCredentialState: null,
    });
    subscribeTimer = setTimeout(() => {
      reject(
        {
          code: STREAM_SUBSCRIBE_TIMEOUT_FATAL_CODE,
          reason: `Timed out waiting for 'subscribe' frame after openAck (${String(SUBSCRIBE_TIMEOUT_MS)}ms)`,
          incompatibleMethods: null,
          upgradeGuidance: null,
          retryable: true,
        },
        "subscribe-timeout",
      );
    }, SUBSCRIBE_TIMEOUT_MS);
  }

  function handleSubscribe(parsed: unknown): void {
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "kind" in parsed &&
      parsed.kind === "fatalError"
    ) {
      state = "closed";
      clearSubscribeTimer();
      socket.close(POLICY_VIOLATION, "client fatal error");
      return;
    }
    const subscribe = clientStreamSubscribeFrameSchema.safeParse(parsed);
    if (!subscribe.success) {
      reject(
        unauthorized(`Malformed subscribe frame: ${subscribe.error.message}`),
        "malformed-subscribe",
      );
      return;
    }
    clearSubscribeTimer();
    state = "subscribed";
    if (subscribe.data.method === "notifications.subscribe") {
      sendNotificationsSnapshot(socket);
      return;
    }
    if (subscribe.data.method === "agent.activity.subscribe") {
      sendAgentActivitySnapshot(socket);
      return;
    }
    if (subscribe.data.method === "epic.subscribe") {
      const epicId = readEpicId(subscribe.data.params);
      if (epicId === null) {
        reject(unauthorized("epic.subscribe requires epicId"), "missing-epic");
        return;
      }
      sendEpicSnapshot(socket, runtime, epicId);
      return;
    }
    if (subscribe.data.method === "epic.status.subscribe") {
      const epicId = readEpicId(subscribe.data.params);
      if (epicId === null) {
        reject(
          unauthorized("epic.status.subscribe requires epicId"),
          "missing-epic",
        );
        return;
      }
      sendEpicStatusSnapshot(socket, runtime, epicId);
      return;
    }
    if (subscribe.data.method === "chat.subscribe") {
      const chatId = readChatId(subscribe.data.params);
      const epicId = readEpicId(subscribe.data.params);
      if (chatId === null || epicId === null) {
        reject(
          unauthorized("chat.subscribe requires epicId and chatId"),
          "missing-chat",
        );
        return;
      }
      runtime.chats.add(epicId, chatId, socket);
      sendChatSnapshot(socket, runtime, epicId, chatId);
      return;
    }
    if (subscribe.data.method === "git.subscribeStatus") {
      attachGitStatusStream(socket, subscribe.data.params);
      return;
    }
    if (subscribe.data.method === "terminal.subscribe") {
      terminalStream = attachTerminalStream(
        socket,
        runtime,
        subscribe.data.params,
      );
      if (terminalStream === null) {
        reject(
          unauthorized("terminal.subscribe requires a live sessionId"),
          "missing-terminal",
        );
      }
      return;
    }
    if (subscribe.data.method === "host.notifications.feed.subscribe") {
      runtime.notifications.add(socket);
      sendJson(snapshotFrame(runtime));
      return;
    }
    sendAnalogStreamSnapshot(socket, subscribe.data.method);
  }

  function handleApplication(parsed: unknown): void {
    if (terminalStream !== null && terminalStream.handleFrame(parsed)) {
      return;
    }
    if (parsed === null || typeof parsed !== "object" || !("kind" in parsed)) {
      return;
    }
    if (parsed.kind === "ping") {
      sendJson({ kind: "pong", hasBinaryPayload: false });
      return;
    }
    if (parsed.kind === "applyUpdate" || parsed.kind === "awareness") {
      const epicId = readEpicId(parsed);
      if (epicId !== null && Reflect.get(parsed, "hasBinaryPayload") === true) {
        pendingBinary = { kind: parsed.kind, epicId, artifactRoomId: null };
      }
      return;
    }
    if (
      parsed.kind === "artifactRoomApplyUpdate" ||
      parsed.kind === "artifactRoomAwareness"
    ) {
      const epicId = readEpicId(parsed);
      const artifactRoomId = Reflect.get(parsed, "artifactRoomId");
      if (
        epicId !== null &&
        typeof artifactRoomId === "string" &&
        Reflect.get(parsed, "hasBinaryPayload") === true
      ) {
        pendingBinary = {
          kind: parsed.kind,
          epicId,
          artifactRoomId,
        };
      }
      return;
    }
    handleChatClientFrame(parsed, socket, runtime);
  }

  function applyPendingBinary(bytes: Buffer): void {
    if (pendingBinary === null) {
      return;
    }
    if (pendingBinary.kind === "applyUpdate") {
      runtime.epics.applyRootUpdate(pendingBinary.epicId, bytes);
      return;
    }
    if (
      pendingBinary.kind === "artifactRoomApplyUpdate" &&
      pendingBinary.artifactRoomId !== null
    ) {
      runtime.epics.applyRoomUpdate(
        runtime,
        pendingBinary.epicId,
        pendingBinary.artifactRoomId,
        bytes,
      );
    }
  }
}

function readEpicId(params: unknown): string | null {
  if (params === null || typeof params !== "object") {
    return null;
  }
  const epicId = Reflect.get(params, "epicId");
  return typeof epicId === "string" && epicId.length > 0 ? epicId : null;
}

function readChatId(params: unknown): string | null {
  if (params === null || typeof params !== "object") {
    return null;
  }
  const chatId = Reflect.get(params, "chatId");
  return typeof chatId === "string" && chatId.length > 0 ? chatId : null;
}

function unauthorized(reason: string): FatalErrorDetails {
  return {
    code: "UNAUTHORIZED",
    reason,
    incompatibleMethods: null,
    upgradeGuidance: null,
  };
}

function rawToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (typeof data === "string") {
    return Buffer.from(data);
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
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
