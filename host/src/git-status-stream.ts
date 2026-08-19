import { watch, type FSWatcher } from "node:fs";
import type { SchemaVersion } from "@traycer/protocol/framework";
import type { StreamMethodFrameEnvelope } from "@traycer/protocol/framework/stream-ws-protocol";
import {
  gitSubscribeStatusEventSchema,
  gitSubscribeStatusRequestSchema,
  type GitChangedFileV10,
  type GitListChangedFilesResponse,
  type GitSubscribeStatusEvent,
} from "@traycer/protocol/host/git-schemas";
import { listGitChangedFiles } from "./git-status";

type StreamSend = (data: string | Uint8Array) => void;

export type GitStatusStreamBinding = {
  readonly method: "git.subscribeStatus";
  readonly onFrame: (
    envelope: StreamMethodFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ) => void;
  readonly dispose: () => void;
};

export type GitStatusStreamOptions = {
  readonly pollIntervalMs: number;
  readonly watcherDebounceMs: number;
};

export type OpenGitStatusStreamResult =
  | { readonly accepted: true; readonly binding: GitStatusStreamBinding }
  | {
      readonly accepted: false;
      readonly code: "E_INVALID_ARGUMENT" | "E_HOST_UNSUPPORTED";
      readonly reason: string;
    };

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_WATCHER_DEBOUNCE_MS = 50;

/**
 * Opens the frozen parent-repository `git.subscribeStatus@1.0` stream.
 *
 * Filesystem notifications reduce update latency while the fixed poll is the
 * portable source of truth for platforms or repositories a watcher cannot
 * cover. Neither cadence is client-configurable.
 */
export function openGitStatusStream(
  send: StreamSend,
  schemaVersion: SchemaVersion,
  params: unknown,
  options: GitStatusStreamOptions | undefined,
): OpenGitStatusStreamResult {
  if (schemaVersion.major !== 1 || schemaVersion.minor !== 0) {
    return {
      accepted: false,
      code: "E_HOST_UNSUPPORTED",
      reason: `git.subscribeStatus ${schemaVersion.major}.${schemaVersion.minor} is not implemented`,
    };
  }

  const parsed = gitSubscribeStatusRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      accepted: false,
      code: "E_INVALID_ARGUMENT",
      reason: parsed.error.message,
    };
  }

  const pollStartedAtMs = Date.now();
  let current: GitListChangedFilesResponse;
  try {
    current = listGitChangedFiles(parsed.data);
  } catch (error) {
    return {
      accepted: false,
      code: "E_INVALID_ARGUMENT",
      reason: errorMessage(error),
    };
  }

  let disposed = false;
  let refreshRunning = false;
  let refreshRequested = false;
  let debounceTimer: NodeJS.Timeout | null = null;
  const watchers: FSWatcher[] = [];
  const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const watcherDebounceMs =
    options?.watcherDebounceMs ?? DEFAULT_WATCHER_DEBOUNCE_MS;

  sendEvent(send, snapshotEvent(current, pollStartedAtMs));

  const refresh = (): void => {
    if (disposed) return;
    if (refreshRunning) {
      refreshRequested = true;
      return;
    }
    refreshRunning = true;
    do {
      refreshRequested = false;
      const nextPollStartedAtMs = Date.now();
      try {
        const next = listGitChangedFiles(parsed.data);
        if (next.fingerprint !== current.fingerprint) {
          const changedPaths = changedPathsBetween(current.files, next.files);
          current = next;
          sendEvent(
            send,
            updatedEvent(next, changedPaths, nextPollStartedAtMs),
          );
        }
      } catch (error) {
        sendEvent(send, {
          type: "error",
          message: errorMessage(error),
          isFatal: false,
        });
      }
    } while (refreshRequested && !disposed);
    refreshRunning = false;
  };

  const scheduleWatcherRefresh = (): void => {
    if (disposed || debounceTimer !== null) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      refresh();
    }, watcherDebounceMs);
    debounceTimer.unref();
  };

  const watcher = openWatcher(current.runningDir, scheduleWatcherRefresh);
  if (watcher !== null) watchers.push(watcher);

  const pollTimer = setInterval(refresh, pollIntervalMs);
  pollTimer.unref();

  return {
    accepted: true,
    binding: {
      method: "git.subscribeStatus",
      onFrame: () => {},
      dispose: () => {
        if (disposed) return;
        disposed = true;
        clearInterval(pollTimer);
        if (debounceTimer !== null) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        for (const activeWatcher of watchers) activeWatcher.close();
        watchers.length = 0;
      },
    },
  };
}

function openWatcher(
  runningDir: string,
  onChange: () => void,
): FSWatcher | null {
  try {
    const watcher = watch(
      runningDir,
      { persistent: false, recursive: true },
      onChange,
    );
    watcher.on("error", () => watcher.close());
    return watcher;
  } catch {
    try {
      const watcher = watch(runningDir, { persistent: false }, onChange);
      watcher.on("error", () => watcher.close());
      return watcher;
    } catch {
      return null;
    }
  }
}

function snapshotEvent(
  snapshot: GitListChangedFilesResponse,
  pollStartedAtMs: number,
): GitSubscribeStatusEvent {
  return {
    type: "snapshot",
    ...snapshot,
    pollStartedAtMs,
  };
}

function updatedEvent(
  snapshot: GitListChangedFilesResponse,
  changedPaths: string[],
  pollStartedAtMs: number,
): GitSubscribeStatusEvent {
  return {
    type: "updated",
    ...snapshot,
    changedPaths,
    pollStartedAtMs,
  };
}

function changedPathsBetween(
  previous: readonly GitChangedFileV10[],
  next: readonly GitChangedFileV10[],
): string[] {
  const previousRows = rowsByIdentity(previous);
  const nextRows = rowsByIdentity(next);
  const changedPaths = new Set<string>();
  for (const identity of new Set([
    ...previousRows.keys(),
    ...nextRows.keys(),
  ])) {
    const previousRow = previousRows.get(identity);
    const nextRow = nextRows.get(identity);
    if (JSON.stringify(previousRow) === JSON.stringify(nextRow)) continue;
    if (previousRow !== undefined) changedPaths.add(previousRow.path);
    if (nextRow !== undefined) changedPaths.add(nextRow.path);
  }
  return [...changedPaths].sort((left, right) => left.localeCompare(right));
}

function rowsByIdentity(
  files: readonly GitChangedFileV10[],
): ReadonlyMap<string, GitChangedFileV10> {
  return new Map(files.map((file) => [`${file.path}\0${file.stage}`, file]));
}

function sendEvent(send: StreamSend, event: GitSubscribeStatusEvent): void {
  send(JSON.stringify(gitSubscribeStatusEventSchema.parse(event)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
