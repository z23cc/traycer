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
import { hostNotificationsSubscribeOpenRequestSchemaV10 } from "@traycer/protocol/host/notifications/host-notifications";
import { authenticateOpenToken } from "../auth";
import { epochRejectionReason, evaluateClientEpoch } from "../epoch-gate";
import {
  clientStreamManifestOverlap,
  hostStreamManifest,
  UNSERVED_STREAM_METHOD_NAMES,
} from "../manifest";
import type { HostRuntime } from "../runtime";
import { filteredSnapshotFrame, snapshotFrame } from "../gui/notifications";
import { listState } from "../rpc/handlers/plain-terminal-handlers";
import { handleChatClientFrame } from "./chat-actions";
import { sendChatSnapshot } from "./chat";
import { attachGitStatusStream } from "./git-status";
import { ArtifactDocLane } from "./artifact-doc";
import { serveAsset } from "./asset";
import { AssetStreamSession } from "../workspace/asset-stream";
import { ResourcesSubscriber, readScope } from "./resources";
import { EpicStateSubscriber } from "./epic-state";
import {
  sendAgentActivitySnapshot,
  sendAnalogStreamSnapshot,
  sendEpicSnapshot,
  sendEpicStatusSnapshot,
  sendNotificationsSnapshot,
} from "./snapshots";
import { attachTerminalStream, type TerminalStreamSession } from "./terminal";
import { workspaceSubscribeFileListOpenRequestSchema } from "@traycer/protocol/host/workspace/subscribe";
import { WorkspaceFileListSession } from "../workspace/file-list-stream";
import { agentInboxSubscribeOpenRequestSchema } from "@traycer/protocol/host/agent/inbox";
import { InboxMonitor } from "./inbox";
import { ChatRecordsSubscriber } from "./chat-records";
import { CommunicationGraphSubscriber } from "./communication-graph";
import { epicCommunicationGraphSubscribeOpenRequestSchema } from "@traycer/protocol/host/epic/communication-graph";

const SUBSCRIBE_TIMEOUT_MS = 30_000;
const POLICY_VIOLATION = 1008;

type StreamState = "pending" | "opened" | "subscribed" | "closed";

type PendingBinary = {
  readonly kind: string;
  readonly epicId: string;
  readonly artifactRoomId: string | null;
  /** Set only for the doc lane, whose write path is guarded by the body's guid. */
  readonly docGuid: string | null;
};

export function attachStreamConnection(
  socket: WebSocket,
  runtime: HostRuntime,
): void {
  let state: StreamState = "pending";
  let subscribeTimer: NodeJS.Timeout | null = null;
  let terminalStream: TerminalStreamSession | null = null;
  let fileListStream: WorkspaceFileListSession | null = null;
  let epicState: EpicStateSubscriber | null = null;
  let artifactDoc: ArtifactDocLane | null = null;
  let assetStream: AssetStreamSession | null = null;
  let resources: ResourcesSubscriber | null = null;
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
    runtime.plainTerminals.remove(socket);
    runtime.inboxMonitors.remove(socket);
    runtime.chatRecords.remove(socket);
    runtime.graphs.remove(socket);
    runtime.epicState.remove(socket);
    runtime.artifactDocs.remove(socket);
    resources?.stop();
    runtime.epics.remove(socket);
    terminalStream?.dispose();
    terminalStream = null;
    fileListStream?.close();
    fileListStream = null;
  });
  socket.on("error", () => {
    state = "closed";
    clearSubscribeTimer();
    runtime.chats.remove(socket);
    runtime.notifications.remove(socket);
    runtime.plainTerminals.remove(socket);
    runtime.inboxMonitors.remove(socket);
    runtime.chatRecords.remove(socket);
    runtime.graphs.remove(socket);
    runtime.epicState.remove(socket);
    runtime.artifactDocs.remove(socket);
    resources?.stop();
    runtime.epics.remove(socket);
    terminalStream?.dispose();
    terminalStream = null;
    fileListStream?.close();
    fileListStream = null;
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
    if (subscribe.data.method === "terminal.plain.subscribeList") {
      const scope = readPlainScope(subscribe.data.params);
      runtime.plainTerminals.add(socket, scope);
      sendJson({
        kind: "state",
        hasBinaryPayload: false,
        state: listState(runtime, scope),
      });
      return;
    }
    if (subscribe.data.method === "host.notifications.subscribe") {
      const opened = hostNotificationsSubscribeOpenRequestSchemaV10.safeParse(
        subscribe.data.params,
      );
      if (!opened.success) {
        reject(
          unauthorized(`host.notifications.subscribe: ${opened.error.message}`),
          "malformed-notifications-open",
        );
        return;
      }
      runtime.notifications.add(socket);
      sendJson(
        filteredSnapshotFrame(
          runtime,
          opened.data.filter,
          opened.data.initialLimit,
        ),
      );
      return;
    }
    if (subscribe.data.method === "host.notifications.feed.subscribe") {
      runtime.notifications.add(socket);
      sendJson(snapshotFrame(runtime));
      return;
    }
    if (subscribe.data.method === "epic.communicationGraph.subscribe") {
      const opened = epicCommunicationGraphSubscribeOpenRequestSchema.safeParse(
        subscribe.data.params,
      );
      if (!opened.success) {
        reject(
          unauthorized("epic.communicationGraph.subscribe requires an epicId"),
          "missing-epic",
        );
        return;
      }
      const subscriber = new CommunicationGraphSubscriber(
        socket,
        runtime,
        opened.data.epicId,
        opened.data.sinceCursor ?? 0,
      );
      runtime.graphs.add(socket, subscriber);
      subscriber.seed();
      return;
    }
    if (subscribe.data.method === "pr.subscribeListForEpic") {
      // No `gh` sweep runs here, so the list is empty because nothing was
      // fetched - `gh-unavailable`, not the `ok` that claims a sweep found
      // this epic has no pull requests.
      sendJson({
        kind: "snapshot",
        hasBinaryPayload: false,
        sourceStatus: "gh-unavailable",
        notice: null,
        items: [],
      });
      return;
    }
    if (
      subscribe.data.method === "worktree.changed" ||
      subscribe.data.method === "providers.changed"
    ) {
      // Change PINGS, not snapshots: nothing is waiting on a first frame, and
      // the analog's fabricated one made every subscriber refetch immediately
      // for a change that never happened. The socket is simply held open.
      return;
    }
    if (subscribe.data.method === "host.chatRecords.subscribe") {
      const subscriber = new ChatRecordsSubscriber(socket, runtime);
      runtime.chatRecords.add(socket, subscriber);
      subscriber.seed();
      return;
    }
    if (subscribe.data.method === "agent.inbox.subscribe") {
      const opened = agentInboxSubscribeOpenRequestSchema.safeParse(
        subscribe.data.params,
      );
      if (!opened.success) {
        reject(
          unauthorized("agent.inbox.subscribe requires an agentId and epicId"),
          "missing-agent",
        );
        return;
      }
      const monitor = new InboxMonitor(
        socket,
        runtime,
        opened.data.agentId,
        opened.data.epicId,
        subscribe.data.schemaVersion.minor,
      );
      runtime.inboxMonitors.add(socket, monitor);
      monitor.drain();
      return;
    }
    if (subscribe.data.method === "workspace.subscribeFileList") {
      const opened = workspaceSubscribeFileListOpenRequestSchema.safeParse(
        subscribe.data.params,
      );
      if (!opened.success) {
        reject(
          unauthorized("workspace.subscribeFileList requires a workspacePath"),
          "missing-workspace",
        );
        return;
      }
      fileListStream = new WorkspaceFileListSession(socket);
      void fileListStream.open(opened.data.workspacePath);
      return;
    }
    if (subscribe.data.method === "epic.state.subscribe") {
      const epicId = readEpicId(subscribe.data.params);
      if (epicId === null) {
        reject(
          unauthorized("epic.state.subscribe requires epicId"),
          "missing-epic",
        );
        return;
      }
      epicState = new EpicStateSubscriber(socket, runtime, epicId);
      runtime.epicState.add(socket, epicState);
      return;
    }
    if (subscribe.data.method === "artifact.subscribe") {
      const epicId = readEpicId(subscribe.data.params);
      const artifactId = Reflect.get(
        subscribe.data.params === null ||
          typeof subscribe.data.params !== "object"
          ? {}
          : subscribe.data.params,
        "artifactId",
      );
      if (epicId === null || typeof artifactId !== "string") {
        reject(
          unauthorized("artifact.subscribe requires epicId and artifactId"),
          "missing-artifact",
        );
        return;
      }
      artifactDoc = new ArtifactDocLane(socket, runtime, epicId, artifactId);
      runtime.artifactDocs.add(socket, artifactDoc);
      void artifactDoc.open(subscribe.data.params).then((ok) => {
        if (!ok) {
          reject(
            unauthorized("artifact.subscribe: malformed open request"),
            "malformed-artifact-open",
          );
        }
      });
      return;
    }
    if (
      subscribe.data.method === "workspace.streamAsset" ||
      subscribe.data.method === "git.streamFileAsset"
    ) {
      // The negotiated minor decides whether PDF is a type this peer can
      // parse, so it travels with the session rather than being re-derived.
      assetStream = new AssetStreamSession(
        socket,
        subscribe.data.schemaVersion.minor,
      );
      void serveAsset(
        assetStream,
        subscribe.data.method,
        subscribe.data.params,
      );
      return;
    }
    if (subscribe.data.method === "resources.subscribe") {
      const scope = readScope(
        subscribe.data.params,
        subscribe.data.schemaVersion.minor,
      );
      if (scope === null) {
        reject(
          unauthorized("resources.subscribe requires an epicId or a scope"),
          "missing-scope",
        );
        return;
      }
      resources = new ResourcesSubscriber(
        socket,
        runtime,
        scope,
        subscribe.data.schemaVersion.minor,
      );
      resources.start();
      return;
    }
    if (UNSERVED_STREAM_METHOD_NAMES.includes(subscribe.data.method)) {
      reject(
        {
          code: "INCOMPATIBLE",
          reason: `This host does not serve ${subscribe.data.method}.`,
          incompatibleMethods: [
            {
              method: subscribe.data.method,
              clientCanonical: subscribe.data.schemaVersion,
              hostCanonical: null,
              blocking: "host-missing-method",
            },
          ],
          upgradeGuidance: {
            clientShouldUpgrade: false,
            hostShouldUpgrade: true,
          },
          retryable: false,
        },
        "unserved-method",
      );
      return;
    }
    sendAnalogStreamSnapshot(socket, subscribe.data.method);
  }

  function handleApplication(parsed: unknown): void {
    if (terminalStream !== null && terminalStream.handleFrame(parsed)) {
      return;
    }
    if (fileListStream !== null) {
      void fileListStream.handleFrame(parsed);
      return;
    }
    if (runtime.inboxMonitors.handleFrame(socket, parsed)) {
      return;
    }
    if (runtime.chatRecords.handleFrame(socket, parsed)) {
      return;
    }
    if (runtime.graphs.handleFrame(socket, parsed)) {
      return;
    }
    if (runtime.epicState.handleFrame(socket, parsed)) {
      return;
    }
    if (parsed === null || typeof parsed !== "object" || !("kind" in parsed)) {
      return;
    }
    if (resources !== null && resources.handleFrame(parsed)) {
      return;
    }
    if (parsed.kind === "ping") {
      if (assetStream !== null) {
        assetStream.pong();
        return;
      }
      if (artifactDoc !== null) {
        artifactDoc.pong();
        return;
      }
      sendJson({ kind: "pong", hasBinaryPayload: false });
      return;
    }
    if (
      artifactDoc !== null &&
      (parsed.kind === "applyUpdate" || parsed.kind === "awareness")
    ) {
      // The doc lane owns the socket outright, so its `applyUpdate` /
      // `awareness` are never the epic monolith's frames of the same name.
      const docGuid = Reflect.get(parsed, "docGuid");
      pendingBinary = {
        kind: `doc:${parsed.kind}`,
        epicId: artifactDoc.epicId,
        artifactRoomId: null,
        docGuid: typeof docGuid === "string" ? docGuid : null,
      };
      return;
    }
    if (parsed.kind === "applyUpdate" || parsed.kind === "awareness") {
      const epicId = readEpicId(parsed);
      if (epicId !== null && Reflect.get(parsed, "hasBinaryPayload") === true) {
        pendingBinary = {
          kind: parsed.kind,
          epicId,
          artifactRoomId: null,
          docGuid: null,
        };
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
          docGuid: null,
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
    if (artifactDoc !== null && pendingBinary.kind.startsWith("doc:")) {
      if (pendingBinary.kind === "doc:awareness") {
        artifactDoc.awareness(bytes);
        return;
      }
      if (pendingBinary.docGuid !== null) {
        artifactDoc.applyUpdate(pendingBinary.docGuid, bytes);
      }
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

function readPlainScope(
  params: unknown,
): { kind: "epic"; epicId: string } | { kind: "independent" } {
  const epicId = readEpicId(readScopeObject(params));
  return epicId === null ? { kind: "independent" } : { kind: "epic", epicId };
}

function readScopeObject(params: unknown): unknown {
  if (params === null || typeof params !== "object") {
    return null;
  }
  return Reflect.get(params, "scope");
}
