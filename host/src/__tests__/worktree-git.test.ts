import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  CURRENT_CLIENT_COMPATIBILITY_EPOCH,
  SERVES_EVERY_INSTALLED_MAJOR,
  splitConnectionManifest,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { startHost, type StartedHost } from "../start-host";

describe("worktree and git RPCs", () => {
  let started: StartedHost | null = null;
  let tempDir: string | null = null;

  afterEach(async () => {
    if (started !== null) {
      await started.close();
      started = null;
    }
    if (tempDir !== null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("creates a local binding, a git worktree, and answers git status", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    const workspace = join(tempDir, "repo");
    await mkdir(workspace);
    await writeFile(join(workspace, "README.md"), "hello\n");
    git(workspace, ["init"]);
    git(workspace, ["config", "user.email", "test@traycer.dev"]);
    git(workspace, ["config", "user.name", "Traycer Test"]);
    git(workspace, ["add", "."]);
    git(workspace, ["-c", "commit.gpgsign=false", "commit", "-m", "init"]);
    const canonical = await realpath(workspace);

    await call(started.rpcUrl, "epic.create", { major: 1, minor: 0 }, {
      epic: {
        id: "epic-1",
        title: "Git task",
        initialUserPrompt: "work",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: "local",
        version: "2.0.0",
      },
      repoIdentifiers: [],
      workspaces: [{ workspacePath: canonical }],
      chat: {
        chatId: "chat-1",
        parentId: null,
        hostId: started.runtime.hostId,
        title: "Chat",
        worktreeIntent: null,
        initialMessage: null,
      },
    });

    const local = await call(started.rpcUrl, "worktree.create", {
      major: 1,
      minor: 1,
    }, {
      epicId: "epic-1",
      ownerId: "chat-1",
      ownerKind: "chat",
      entries: [
        {
          kind: "local",
          workspacePath: canonical,
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    });
    expect(local).toMatchObject({
      binding: { entries: [{ mode: "local", workspacePath: canonical }] },
      perEntry: [{ ok: true, worktreePath: null }],
    });

    const created = await call(started.rpcUrl, "worktree.create", {
      major: 1,
      minor: 1,
    }, {
      epicId: "epic-1",
      ownerId: "chat-1",
      ownerKind: "chat",
      entries: [
        {
          kind: "worktree",
          workspacePath: canonical,
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "traycer/test",
            source: "HEAD",
            carryUncommittedChanges: false,
            collision: "fail",
          },
          scripts: null,
        },
      ],
    });
    const createdRecord = created as {
      perEntry: readonly { ok: boolean; worktreePath: string | null }[];
    };
    expect(createdRecord.perEntry[0]?.ok).toBe(true);
    expect(createdRecord.perEntry[0]?.worktreePath).toEqual(
      expect.stringContaining(`${join("worktrees", "local")}`),
    );

    const listed = await call(started.rpcUrl, "worktree.listAllForHost", {
      major: 1,
      minor: 6,
    }, {
      includeActivity: false,
      activityPaths: null,
      cursor: null,
      limit: null,
      forceRefresh: false,
    });
    expect(listed).toMatchObject({
      nextCursor: null,
      worktrees: [
        expect.objectContaining({
          branch: "traycer/test",
          presence: "present",
          gitUnreadable: false,
          owners: [expect.objectContaining({ epicId: "epic-1", ownerId: "chat-1" })],
        }),
      ],
    });

    const branches = await call(started.rpcUrl, "worktree.listBranches", {
      major: 1,
      minor: 0,
    }, {
      workspacePath: canonical,
      includeRemote: false,
    });
    expect(branches).toMatchObject({
      uncommittedFileCount: 0,
      branches: expect.arrayContaining([
        expect.objectContaining({ name: "traycer/test" }),
      ]),
    });

    await writeFile(join(workspace, "README.md"), "hello world\n");
    const changed = await call(started.rpcUrl, "git.listChangedFiles", {
      major: 1,
      minor: 1,
    }, {
      hostId: started.runtime.hostId,
      runningDir: canonical,
      ignoreWhitespace: false,
      includeSubmodules: false,
    });
    expect(changed).toMatchObject({
      files: [expect.objectContaining({ path: "README.md", status: "modified" })],
      submodules: [],
    });

    const diff = await call(started.rpcUrl, "git.getFileDiff", {
      major: 1,
      minor: 0,
    }, {
      hostId: started.runtime.hostId,
      runningDir: canonical,
      filePath: "README.md",
      previousPath: null,
      stage: "unstaged",
      ignoreWhitespace: false,
      byteBudget: 65536,
    });
    expect(diff).toMatchObject({
      filePath: "README.md",
      isTruncated: false,
    });
    expect(String((diff as { patch: string }).patch)).toContain("hello world");

    const mentions = await call(started.rpcUrl, "workspace.mentionFiles", {
      major: 1,
      minor: 0,
    }, {
      roots: [canonical],
      query: "readme",
      limit: 10,
    });
    expect(mentions).toMatchObject({
      entries: [expect.objectContaining({ kind: "file", label: "README.md" })],
    });
  });

  it("pushes a git.subscribeStatus snapshot on /stream", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    const workspace = join(tempDir, "repo");
    await mkdir(workspace);
    await writeFile(join(workspace, "README.md"), "hello\n");
    git(workspace, ["init"]);
    git(workspace, ["config", "user.email", "test@traycer.dev"]);
    git(workspace, ["config", "user.name", "Traycer Test"]);
    git(workspace, ["add", "."]);
    git(workspace, ["-c", "commit.gpgsign=false", "commit", "-m", "init"]);
    const canonical = await realpath(workspace);
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    const snapshot = await subscribeGitStatus(
      streamUrl,
      started.runtime.hostId,
      canonical,
    );
    expect(snapshot).toMatchObject({
      type: "snapshot",
      runningDir: canonical,
      files: [],
      submodules: [],
      watcher: { state: "starting" },
    });
  });
});

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "git failed");
  }
}

async function call(
  url: string,
  method: string,
  schemaVersion: { major: number; minor: number },
  params: unknown,
): Promise<unknown> {
  const clientManifests = splitConnectionManifest(
    hostRpcRegistry,
    RELEASED_FLOOR_METHOD_NAMES,
    SERVES_EVERY_INSTALLED_MAJOR,
  );
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const frames: unknown[] = [];
  const done = new Promise<void>((resolve, reject) => {
    socket.on("message", (data) => {
      frames.push(JSON.parse(String(data)));
      if (frames.length === 1) {
        socket.send(
          JSON.stringify({
            kind: "request",
            requestId: "1",
            method,
            schemaVersion,
            params,
          }),
        );
      }
    });
    socket.once("close", () => resolve());
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      kind: "open",
      token: "test-token",
      manifest: clientManifests.manifest,
      optionalManifest: clientManifests.optionalManifest,
      clientIdentity: {
        kind: "cli",
        compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
        appVersion: "0.1.0",
      },
    }),
  );
  await done;
  const response = frames[1];
  if (
    response === null ||
    typeof response !== "object" ||
    !("kind" in response) ||
    response.kind !== "response"
  ) {
    throw new Error(`expected response, got ${JSON.stringify(response)}`);
  }
  const record = response as Record<string, unknown>;
  if (record.error !== null) {
    throw new Error(`RPC error: ${JSON.stringify(record.error)}`);
  }
  return record.result;
}

async function subscribeGitStatus(
  url: string,
  hostId: string,
  runningDir: string,
): Promise<unknown> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const frames: unknown[] = [];
  const done = new Promise<void>((resolve, reject) => {
    socket.on("message", (data) => {
      const parsed: unknown = JSON.parse(String(data));
      frames.push(parsed);
      if (frames.length === 1) {
        socket.send(
          JSON.stringify({
            kind: "subscribe",
            method: "git.subscribeStatus",
            schemaVersion: { major: 1, minor: 3 },
            params: {
              hostId,
              runningDir,
              ignoreWhitespace: false,
              freshNonce: null,
            },
          }),
        );
        return;
      }
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "type" in parsed &&
        parsed.type === "snapshot"
      ) {
        socket.close();
      }
    });
    socket.once("close", () => resolve());
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      kind: "open",
      token: "test-token",
      manifest: {},
      clientIdentity: {
        kind: "cli",
        compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
        appVersion: "0.1.0",
      },
    }),
  );
  await done;
  const snapshot = frames.find(
    (frame) =>
      frame !== null &&
      typeof frame === "object" &&
      "type" in frame &&
      frame.type === "snapshot",
  );
  if (snapshot === undefined) {
    throw new Error(`expected snapshot, got ${JSON.stringify(frames)}`);
  }
  return snapshot;
}
