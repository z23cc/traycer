import type { HostRestartBusyVerdict } from "@traycer/protocol/host/restart/schemas";
import type { HostRuntime } from "../runtime";

export function hostBusyVerdict(runtime: HostRuntime): HostRestartBusyVerdict {
  const workingAgents = runtime.guiRuns.printCount();
  const busyTerminals = runtime.terminals
    .listAll()
    .filter((session) => session.status === "running").length;
  const busySessionCount = workingAgents + busyTerminals;
  return {
    busySessionCount,
    blockers: {
      workingAgents: workingAgents > 0,
      runningTerminals: busyTerminals > 0,
    },
    busyBreakdown: {
      workingAgents,
      activeTerminalAgents: 0,
      busyTerminals,
    },
  };
}
