import type { TuiActivityOracle } from "./agent/activity";
import type { AgentInbox } from "./agent/inbox";
import type { GuiRunRegistry } from "./gui/deliver";
import type { ChatQueue } from "./gui/queue";
import type { HostStore } from "./store/host-store";
import type { ChatHub } from "./stream/chat-hub";
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
  readonly tuiActivity: TuiActivityOracle;
  readonly guiRuns: GuiRunRegistry;
  readonly queue: ChatQueue;
  readonly chats: ChatHub;
  requestRestart: () => void;
  lastRestartTransitionId: string | null;
};
