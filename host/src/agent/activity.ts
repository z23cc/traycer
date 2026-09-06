export class TuiActivityOracle {
  private readonly working = new Set<string>();

  start(tuiAgentId: string): void {
    this.working.add(tuiAgentId);
  }

  stop(tuiAgentId: string): void {
    this.working.delete(tuiAgentId);
  }

  isWorking(tuiAgentId: string): boolean {
    return this.working.has(tuiAgentId);
  }
}
