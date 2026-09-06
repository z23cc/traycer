import type {
  CanonicalTerminalSessionInfoWithLifecycleOwner,
  TerminalScope,
} from "@traycer/protocol/host/terminal/unary-schemas";

export type HostTerminalSession = CanonicalTerminalSessionInfoWithLifecycleOwner;

export class TerminalRegistry {
  private readonly sessions = new Map<string, HostTerminalSession>();

  listAll(): HostTerminalSession[] {
    return [...this.sessions.values()];
  }

  list(scope: TerminalScope): HostTerminalSession[] {
    const all = this.listAll();
    if (scope.kind === "independent") {
      return all.filter((session) => session.scope.kind === "independent");
    }
    return all.filter(
      (session) =>
        session.scope.kind === "epic" && session.scope.epicId === scope.epicId,
    );
  }

  get(sessionId: string): HostTerminalSession | null {
    const found = this.sessions.get(sessionId);
    return found === undefined ? null : found;
  }

  put(session: HostTerminalSession): void {
    this.sessions.set(session.sessionId, session);
  }

  kill(sessionId: string): boolean {
    const existing = this.sessions.get(sessionId);
    if (existing === undefined) {
      return false;
    }
    this.sessions.set(sessionId, {
      ...existing,
      status: "exited",
      exitCode: 0,
      exitReason: "killed",
    });
    return true;
  }
}
