import type { TuiActivityOracle } from "./agent/activity";
import type { AgentInbox } from "./agent/inbox";
import type { InboxMonitorRegistry } from "./stream/inbox";
import type { GuiRunRegistry } from "./gui/deliver";
import type { NotificationHub } from "./gui/notifications";
import type { ChatQueue } from "./gui/queue";
import type { HostStore } from "./store/host-store";
import type { ChatHub } from "./stream/chat-hub";
import type { ChatRecordsHub } from "./stream/chat-records";
import type { CommunicationGraphHub } from "./stream/communication-graph";
import type { ShutdownClaimIntent } from "@traycer/protocol/host/lifecycle/schemas";
import type { ShutdownCoordinator } from "./lifecycle/shutdown";
import type { EpicHub } from "./stream/epic-hub";
import type { PlainTerminalHub } from "./terminal/plain";
import type { ArtifactDocHub } from "./stream/artifact-doc";
import type { SessionImportRuns } from "./stream/session-import-run";
import type { WorktreeDeleteCommands } from "./stream/worktree-delete";
import type { EpicStateHub } from "./stream/epic-state";
import type { PtyManager } from "./terminal/pty";
import type { TerminalRegistry } from "./terminal/sessions";

export type HostRuntime = {
  readonly hostId: string;
  readonly hostVersion: string;
  readonly dataDir: string;
  readonly store: HostStore;
  readonly terminals: TerminalRegistry;
  readonly pty: PtyManager;
  readonly inbox: AgentInbox;
  readonly inboxMonitors: InboxMonitorRegistry;
  readonly tuiActivity: TuiActivityOracle;
  readonly guiRuns: GuiRunRegistry;
  readonly queue: ChatQueue;
  readonly chats: ChatHub;
  readonly chatRecords: ChatRecordsHub;
  readonly graphs: CommunicationGraphHub;
  readonly epicState: EpicStateHub;
  readonly artifactDocs: ArtifactDocHub;
  readonly worktreeDeletes: WorktreeDeleteCommands;
  /**
   * Import runs, held here rather than on a connection because the contract
   * says a run outlives the socket that started it.
   */
  readonly sessionImports: SessionImportRuns;
  /**
   * This process's replica identity, stamped on every records-lane frame. It
   * carries the start time because the lane's positions are in-memory: a
   * restart resets them, and a client resuming under an unchanged epoch could
   * not tell the reset from real history.
   */
  readonly authorityEpoch: string;
  readonly notifications: NotificationHub;
  readonly plainTerminals: PlainTerminalHub;
  readonly epics: EpicHub;
  readonly shutdown: ShutdownCoordinator;
  /**
   * Take the host down, for a restart (exit 87, tombstone announced) or for
   * good (exit 0). Once: a second request while the first tears down is
   * ignored.
   */
  requestShutdown: (intent: ShutdownClaimIntent) => void;
  lastRestartTransitionId: string | null;
};
