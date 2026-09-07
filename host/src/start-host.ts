import { mkdir } from "node:fs/promises";
import { TuiActivityOracle } from "./agent/activity";
import { AgentInbox } from "./agent/inbox";
import { InboxMonitorRegistry } from "./stream/inbox";
import { resolveHostDataDir } from "./data-dir";
import { GuiRunRegistry } from "./gui/deliver";
import { NotificationHub } from "./gui/notifications";
import { ChatQueue } from "./gui/queue";
import { loadOrCreateHostIdentity } from "./identity";
import { listenHostHttp, type HostHttpServer } from "./http-server";
import { publishedRuntimeVersion } from "./install-record";
import { buildPidMetadata, writePidMetadata } from "./pid-metadata";
import type { HostRuntime } from "./runtime";
import { HostStore } from "./store/host-store";
import { PlainTerminalHub } from "./terminal/plain";
import { ChatHub } from "./stream/chat-hub";
import { ChatRecordsHub } from "./stream/chat-records";
import { CommunicationGraphHub } from "./stream/communication-graph";
import { ArtifactDocHub } from "./stream/artifact-doc";
import { defaultProviderRoots } from "./session-import/discover";
import { SessionImportRuns } from "./stream/session-import-run";
import { WorktreeDeleteCommands } from "./stream/worktree-delete";
import { EpicStateHub } from "./stream/epic-state";
import { ShutdownCoordinator } from "./lifecycle/shutdown";
import { EpicHub } from "./stream/epic-hub";
import { PtyManager } from "./terminal/pty";
import { TerminalRegistry } from "./terminal/sessions";
import { HOST_VERSION } from "./version";

export type StartedHost = {
  readonly runtime: HostRuntime;
  readonly rpcUrl: string;
  readonly port: number;
  close: () => Promise<void>;
};

export type StartHostOptions = {
  readonly argv: readonly string[];
  readonly listenHost: string;
  readonly listenPort: number;
};

export async function startHost(
  options: StartHostOptions,
): Promise<StartedHost> {
  const dataDir = resolveHostDataDir(options.argv);
  await mkdir(dataDir, { recursive: true });
  const identity = await loadOrCreateHostIdentity(dataDir);
  const store = await HostStore.open(dataDir);
  const terminals = new TerminalRegistry();
  const pty = new PtyManager();
  pty.on("exit", (sessionId: string, exitCode: number) => {
    const existing = terminals.get(sessionId);
    if (existing === null || existing.status === "exited") {
      return;
    }
    terminals.put({
      ...existing,
      status: "exited",
      exitCode,
      exitReason: "process-exit",
    });
  });
  const runtime: HostRuntime = {
    hostId: identity.hostId,
    hostVersion: HOST_VERSION,
    dataDir,
    store,
    terminals,
    pty,
    inbox: new AgentInbox(),
    inboxMonitors: new InboxMonitorRegistry(),
    tuiActivity: new TuiActivityOracle(),
    guiRuns: new GuiRunRegistry(),
    queue: new ChatQueue(),
    chats: new ChatHub(),
    chatRecords: new ChatRecordsHub(),
    graphs: new CommunicationGraphHub(),
    epicState: new EpicStateHub(),
    artifactDocs: new ArtifactDocHub(),
    worktreeDeletes: new WorktreeDeleteCommands(),
    sessionImports: new SessionImportRuns(defaultProviderRoots()),
    authorityEpoch: `oss:${identity.hostId}:${String(Date.now())}`,
    notifications: new NotificationHub(),
    plainTerminals: new PlainTerminalHub(),
    epics: new EpicHub(),
    shutdown: new ShutdownCoordinator(),
    requestRestart: () => undefined,
    lastRestartTransitionId: null,
  };
  // Every store write reaches the records lane through this one hook; the
  // subscribers themselves decide whether their epic's rows actually moved.
  store.onCommit(() => {
    runtime.epicState.publish();
  });
  const http: HostHttpServer = await listenHostHttp({
    host: options.listenHost,
    port: options.listenPort,
    runtime,
  });
  const metadata = buildPidMetadata({
    hostId: runtime.hostId,
    version: await publishedRuntimeVersion(dataDir),
    websocketUrl: http.rpcUrl,
  });
  await writePidMetadata(dataDir, metadata);
  console.error(
    `[host] RPC listening ws=${http.rpcUrl} hostId=${runtime.hostId}`,
  );
  const close = async (): Promise<void> => {
    await runtime.guiRuns.disposeAll();
    pty.disposeAll();
    await store.close();
    await http.close();
  };
  runtime.requestRestart = () => {
    void close().finally(() => {
      if (typeof process.env.VITEST === "string") {
        return;
      }
      process.exit(0);
    });
  };
  return {
    runtime,
    rpcUrl: http.rpcUrl,
    port: http.port,
    close,
  };
}
