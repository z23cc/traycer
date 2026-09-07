import type { WebSocket } from "ws";
import type { GuiHarnessId } from "@traycer/protocol/host/agent/shared";
import type { SessionImportGroup } from "@traycer/protocol/host/session-import/candidate";
import {
  sessionImportScanOpenRequestSchema,
  type SessionImportScanTotals,
} from "@traycer/protocol/host/session-import/scan";
import {
  groupSessions,
  readableProviders,
  readProvider,
  type DiscoveredSession,
  type ProviderRoots,
} from "../session-import/discover";

/**
 * `sessionImport.scan` - the one moment this host reads the vendors' session
 * directories.
 *
 * Frame order follows the contract exactly: `started` before a directory is
 * opened, `providerFailed` the moment a provider gives up, then every `group`,
 * then `complete`. Groups cannot stream during the walk because a folder's
 * membership spans providers - a Claude session and a Codex session run in the
 * same checkout belong to one group - so grouping waits for the last walk.
 *
 * A provider this host has no reader for is reported as FAILED rather than
 * silently contributing nothing: "we cannot look" and "you have never used it"
 * are different answers, and only the first should grey the section out.
 */
export function serveSessionImportScan(
  socket: WebSocket,
  params: unknown,
  roots: ProviderRoots,
): boolean {
  const open = sessionImportScanOpenRequestSchema.safeParse(params);
  if (!open.success) {
    return false;
  }
  const providers = open.data.providers ?? readableProviders(roots);
  send(socket, { kind: "started", hasBinaryPayload: false, providers });
  const found: DiscoveredSession[] = [];
  for (const harness of providers) {
    const root = roots.get(harness);
    if (root === undefined) {
      fail(
        socket,
        harness,
        "source_unreadable",
        `This host has no reader for ${harness} sessions.`,
      );
      continue;
    }
    try {
      found.push(...readProvider(harness, root, open.data.updatedAfter));
    } catch (error) {
      fail(socket, harness, "source_unreadable", String(error));
    }
  }
  const groups = groupSessions(found);
  for (const group of groups) {
    send(socket, { kind: "group", hasBinaryPayload: false, group });
  }
  send(socket, {
    kind: "complete",
    hasBinaryPayload: false,
    totals: totalsOf(groups),
  });
  return true;
}

function totalsOf(
  groups: readonly SessionImportGroup[],
): SessionImportScanTotals {
  const totals = {
    groups: groups.length,
    sessions: 0,
    importable: 0,
    alreadyInTraycer: 0,
    unreadable: 0,
  };
  for (const group of groups) {
    for (const session of group.sessions) {
      totals.sessions += 1;
      if (session.state.kind === "importable") {
        totals.importable += 1;
      } else if (session.state.kind === "already_in_traycer") {
        totals.alreadyInTraycer += 1;
      } else {
        totals.unreadable += 1;
      }
    }
  }
  return totals;
}

function fail(
  socket: WebSocket,
  harness: GuiHarnessId,
  reason: "source_unreadable",
  detail: string,
): void {
  send(socket, {
    kind: "providerFailed",
    hasBinaryPayload: false,
    harness,
    reason,
    detail,
  });
}

function send(socket: WebSocket, frame: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(frame));
  }
}
