import type { WebSocket } from "ws";
import { gitSubscribeStatusRequestSchemaV12 } from "@traycer/protocol/host/git-schemas";
import { statusSnapshot } from "../git/git";

const POLL_MS = 2_000;

export function attachGitStatusStream(
  socket: WebSocket,
  params: unknown,
): void {
  const parsed = gitSubscribeStatusRequestSchemaV12.safeParse(params);
  const runningDir =
    parsed.success
      ? parsed.data.runningDir
      : readRunningDir(params);
  const freshNonce = parsed.success ? parsed.data.freshNonce : null;
  if (runningDir === null) {
    sendJson(socket, {
      type: "error",
      message: "git.subscribeStatus requires runningDir",
      isFatal: true,
    });
    return;
  }
  let lastFingerprint = "";
  const emit = (kind: "snapshot" | "updated"): boolean => {
    const snapshot = statusSnapshot(runningDir);
    if (snapshot === null) {
      sendJson(socket, {
        type: "error",
        message: "Not a git repository",
        isFatal: true,
      });
      return false;
    }
    const changedPaths =
      kind === "updated"
        ? snapshot.files.map((file) => file.path)
        : [];
    sendJson(socket, {
      type: kind,
      runningDir: snapshot.runningDir,
      headSha: snapshot.headSha,
      branch: snapshot.branch,
      files: snapshot.files,
      fingerprint: snapshot.fingerprint,
      nestedFingerprint: snapshot.fingerprint,
      repoMode: snapshot.repoMode,
      repoState: snapshot.repoState,
      submodules: [],
      pollStartedAtMs: Date.now(),
      freshNonce,
      watcher: {
        state: "starting",
        detail: null,
      },
      ...(kind === "updated" ? { changedPaths } : {}),
    });
    lastFingerprint = snapshot.fingerprint;
    return true;
  };
  if (!emit("snapshot")) {
    return;
  }
  const timer: NodeJS.Timeout = setInterval(() => {
    if (socket.readyState !== socket.OPEN) {
      clearInterval(timer);
      return;
    }
    const snapshot = statusSnapshot(runningDir);
    if (snapshot === null) {
      return;
    }
    if (snapshot.fingerprint !== lastFingerprint) {
      emit("updated");
    }
  }, POLL_MS);
  socket.once("close", () => {
    clearInterval(timer);
  });
}

function readRunningDir(params: unknown): string | null {
  if (params === null || typeof params !== "object") {
    return null;
  }
  const runningDir = Reflect.get(params, "runningDir");
  return typeof runningDir === "string" && runningDir.length > 0
    ? runningDir
    : null;
}

function sendJson(socket: WebSocket, frame: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(frame));
  }
}
