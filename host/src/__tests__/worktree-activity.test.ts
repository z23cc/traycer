import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { splitConnectionManifest } from "@traycer/protocol/framework/capability-manifest";
import { hostFrameSchema } from "@traycer/protocol/framework/ws-protocol";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { createEpicRequestSchema } from "@traycer/protocol/host/epic/unary-schemas";
import {
  worktreeGetBindingResponseSchema,
  worktreeListBranchesResponseSchema,
  worktreeListByWorkspacePathsResponseSchemaV13,
  worktreeSetEntryModeResponseSchema,
} from "@traycer/protocol/host/worktree-schemas";
import { scriptedTurnRunner } from "../cli-runner";
import { startHostServer, type HostServer } from "../server";

const HOST_ID = "host-local";

async function openRpc(
  url: string,
): Promise<{ readonly ws: WebSocket; readonly next: () => Promise<string> }> {
  const ws = new WebSocket(url);
  const pending: string[] = [];
  const waiters: Array<(value: string) => void> = [];
  ws.on("message", (data) => {
    const text = data.toString();
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter(text);
      return;
    }
    pending.push(text);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const split = splitConnectionManifest(
    hostRpcRegistry,
    RELEASED_FLOOR_METHOD_NAMES,
  );
  ws.send(
    JSON.stringify({
      kind: "open",
      token: "local",
      manifest: split.manifest,
      optionalManifest: split.optionalManifest,
    }),
  );
  const ack = hostFrameSchema.parse(
    JSON.parse(
      await new Promise<string>((resolve) => {
        const queued = pending.shift();
        if (queued !== undefined) {
          resolve(queued);
          return;
        }
        waiters.push(resolve);
      }),
    ),
  );
  expect(ack.kind).toBe("openAck");
  return {
    ws,
    next: () =>
      new Promise((resolve) => {
        const queued = pending.shift();
        if (queued !== undefined) {
          resolve(queued);
          return;
        }
        waiters.push(resolve);
      }),
  };
}

describe("worktree binding, git, and /activity", () => {
  const servers: HostServer[] = [];
  const tempRoots: string[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      if (server !== undefined) {
        await server.close();
      }
    }
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("answers GET /activity with busy:false when idle", async () => {
    const server = await startHostServer(0, HOST_ID, {
      runner: scriptedTurnRunner(["ok"]),
    });
    servers.push(server);
    const response = await fetch(
      server.websocketUrl
        .replace("ws://", "http://")
        .replace("/rpc", "/activity"),
    );
    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({ busy: false });
  });

  it("binds epic workspaces as local worktrees", async () => {
    const server = await startHostServer(0, HOST_ID, {
      runner: scriptedTurnRunner(["ok"]),
    });
    servers.push(server);
    const { ws, next } = await openRpc(server.websocketUrl);
    const now = Date.now();
    ws.send(
      JSON.stringify({
        kind: "request",
        requestId: "c1",
        method: "epic.create",
        schemaVersion: { major: 1, minor: 0 },
        params: createEpicRequestSchema.parse({
          epic: {
            id: "epic-1",
            title: "Bound",
            initialUserPrompt: "",
            ticketCount: 0,
            specCount: 0,
            storyCount: 0,
            reviewCount: 0,
            status: "active",
            createdAt: now,
            updatedAt: now,
            createdBy: "local-user",
            version: "1.0.0",
          },
          repoIdentifiers: [],
          workspaces: [{ workspacePath: process.cwd() }],
          chat: {
            chatId: "chat-1",
            parentId: null,
            hostId: HOST_ID,
            title: "Chat",
            worktreeIntent: null,
            initialMessage: null,
          },
        }),
      }),
    );
    expect(hostFrameSchema.parse(JSON.parse(await next())).kind).toBe(
      "response",
    );

    ws.send(
      JSON.stringify({
        kind: "request",
        requestId: "b1",
        method: "worktree.getBinding",
        schemaVersion: { major: 1, minor: 0 },
        params: {
          epicId: "epic-1",
          ownerId: "chat-1",
          ownerKind: "chat",
        },
      }),
    );
    const binding = hostFrameSchema.parse(JSON.parse(await next()));
    expect(binding).toMatchObject({
      kind: "response",
      error: null,
      result: {
        binding: {
          entries: [{ workspacePath: process.cwd(), mode: "local" }],
        },
        missingWorktreePaths: [],
      },
    });

    ws.send(
      JSON.stringify({
        kind: "request",
        requestId: "l1",
        method: "worktree.listBindingsForEpic",
        schemaVersion: { major: 1, minor: 2 },
        params: { epicId: "epic-1" },
      }),
    );
    const listed = hostFrameSchema.parse(JSON.parse(await next()));
    expect(listed).toMatchObject({
      kind: "response",
      error: null,
      result: {
        rows: [{ runningDir: process.cwd(), mode: "local" }],
      },
    });
    ws.close();
  });

  it("stores a terminal-agent binding before its owner record exists", async () => {
    const server = await startHostServer(0, HOST_ID, {
      runner: scriptedTurnRunner(["ok"]),
    });
    servers.push(server);
    const first = await openRpc(server.websocketUrl);
    first.ws.send(
      JSON.stringify({
        kind: "request",
        requestId: "terminal-bind",
        method: "worktree.setEntryMode",
        schemaVersion: { major: 1, minor: 0 },
        params: {
          epicId: "epic-before-create",
          ownerId: "terminal-before-create",
          ownerKind: "terminal-agent",
          workspacePath: "/workspace/pre-owner",
          hostId: "old-client-extra",
          mode: "worktree",
        },
      }),
    );
    const setResponse = hostFrameSchema.parse(JSON.parse(await first.next()));
    if (setResponse.kind !== "response") {
      throw new Error("Missing setEntryMode response");
    }
    expect(setResponse.error).toBeNull();
    expect(
      worktreeSetEntryModeResponseSchema.parse(setResponse.result),
    ).toMatchObject({
      binding: {
        entries: [
          {
            workspacePath: "/workspace/pre-owner",
            mode: "local",
            isPrimary: true,
          },
        ],
      },
    });
    first.ws.close();

    const second = await openRpc(server.websocketUrl);
    second.ws.send(
      JSON.stringify({
        kind: "request",
        requestId: "terminal-read",
        method: "worktree.getBinding",
        schemaVersion: { major: 1, minor: 0 },
        params: {
          epicId: "epic-before-create",
          ownerId: "terminal-before-create",
          ownerKind: "terminal-agent",
        },
      }),
    );
    const getResponse = hostFrameSchema.parse(JSON.parse(await second.next()));
    if (getResponse.kind !== "response") {
      throw new Error("Missing getBinding response");
    }
    expect(getResponse.error).toBeNull();
    expect(worktreeGetBindingResponseSchema.parse(getResponse.result)).toEqual({
      binding: worktreeSetEntryModeResponseSchema.parse(setResponse.result)
        .binding,
      missingWorktreePaths: ["/workspace/pre-owner"],
    });
    second.ws.close();
  });

  it("lists local and remote Git branches with the dirty-file count", async () => {
    const root = mkdtempSync(join(tmpdir(), "traycer-host-branches-"));
    tempRoots.push(root);
    execFileSync("git", ["-C", root, "init", "-b", "main"]);
    execFileSync("git", ["-C", root, "config", "user.name", "Traycer Test"]);
    execFileSync("git", [
      "-C",
      root,
      "config",
      "user.email",
      "traycer@example.com",
    ]);
    writeFileSync(join(root, "README.md"), "base\n");
    execFileSync("git", ["-C", root, "add", "README.md"]);
    execFileSync("git", ["-C", root, "commit", "-m", "base"]);
    execFileSync("git", ["-C", root, "branch", "local-old"]);
    execFileSync("git", ["-C", root, "checkout", "-b", "recent"], {
      stdio: "ignore",
    });
    writeFileSync(join(root, "recent.txt"), "recent\n");
    execFileSync("git", ["-C", root, "add", "recent.txt"]);
    execFileSync("git", ["-C", root, "commit", "-m", "recent"], {
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2030-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2030-01-01T00:00:00Z",
      },
    });
    execFileSync("git", ["-C", root, "checkout", "main"], {
      stdio: "ignore",
    });
    execFileSync("git", [
      "-C",
      root,
      "update-ref",
      "refs/remotes/origin/remote-only",
      "refs/heads/recent",
    ]);
    execFileSync("git", [
      "-C",
      root,
      "update-ref",
      "refs/remotes/origin/main",
      "refs/heads/main",
    ]);
    execFileSync("git", [
      "-C",
      root,
      "update-ref",
      "refs/remotes/upstream/remote-only",
      "refs/heads/recent",
    ]);
    execFileSync("git", [
      "-C",
      root,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);
    writeFileSync(join(root, "dirty.txt"), "dirty\n");
    const nested = join(root, "nested");
    mkdirSync(nested);

    const server = await startHostServer(0, HOST_ID, {
      runner: scriptedTurnRunner(["ok"]),
    });
    servers.push(server);
    const { ws, next } = await openRpc(server.websocketUrl);
    ws.send(
      JSON.stringify({
        kind: "request",
        requestId: "branches",
        method: "worktree.listBranches",
        schemaVersion: { major: 1, minor: 0 },
        params: { workspacePath: nested, includeRemote: true },
      }),
    );
    const response = hostFrameSchema.parse(JSON.parse(await next()));
    if (response.kind !== "response") {
      throw new Error("Missing listBranches response");
    }
    expect(response.error).toBeNull();
    const result = worktreeListBranchesResponseSchema.parse(response.result);
    expect(result.uncommittedFileCount).toBe(1);
    expect(result.branches[0]?.name).toBe("recent");
    expect(result.branches).toEqual(
      expect.arrayContaining([
        { name: "main", isCurrent: true, isRemoteOnly: false },
        { name: "local-old", isCurrent: false, isRemoteOnly: false },
        { name: "recent", isCurrent: false, isRemoteOnly: false },
        {
          name: "origin/remote-only",
          isCurrent: false,
          isRemoteOnly: true,
        },
        {
          name: "upstream/remote-only",
          isCurrent: false,
          isRemoteOnly: true,
        },
      ]),
    );
    expect(result.branches.map((branch) => branch.name)).not.toContain(
      "origin/main",
    );
    expect(result.branches.map((branch) => branch.name)).not.toContain(
      "origin/HEAD",
    );

    ws.send(
      JSON.stringify({
        kind: "request",
        requestId: "local-branches",
        method: "worktree.listBranches",
        schemaVersion: { major: 1, minor: 0 },
        params: { workspacePath: nested, includeRemote: false },
      }),
    );
    const localResponse = hostFrameSchema.parse(JSON.parse(await next()));
    if (localResponse.kind !== "response") {
      throw new Error("Missing local listBranches response");
    }
    const localResult = worktreeListBranchesResponseSchema.parse(
      localResponse.result,
    );
    expect(localResult.uncommittedFileCount).toBe(1);
    expect(localResult.branches.every((branch) => !branch.isRemoteOnly)).toBe(
      true,
    );

    const plain = mkdtempSync(join(tmpdir(), "traycer-host-non-git-"));
    tempRoots.push(plain);
    ws.send(
      JSON.stringify({
        kind: "request",
        requestId: "non-git-branches",
        method: "worktree.listBranches",
        schemaVersion: { major: 1, minor: 0 },
        params: { workspacePath: plain, includeRemote: true },
      }),
    );
    const plainResponse = hostFrameSchema.parse(JSON.parse(await next()));
    if (plainResponse.kind !== "response") {
      throw new Error("Missing non-Git listBranches response");
    }
    expect(
      worktreeListBranchesResponseSchema.parse(plainResponse.result),
    ).toEqual({ branches: [], uncommittedFileCount: 0 });
    ws.close();
  });

  it("summarizes the main checkout and linked worktrees from a nested path", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "traycer-host-summary-"));
    tempRoots.push(fixtureRoot);
    const workspace = join(fixtureRoot, "workspace");
    const linkedWorktree = join(fixtureRoot, "feature-worktree");
    mkdirSync(workspace);
    execFileSync("git", ["-C", workspace, "init", "-b", "main"]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.name",
      "Traycer Test",
    ]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.email",
      "traycer@example.com",
    ]);
    execFileSync("git", [
      "-C",
      workspace,
      "remote",
      "add",
      "origin",
      "https://gitlab.example.com/Acme/Workspace.git",
    ]);
    writeFileSync(join(workspace, "README.md"), "base\n");
    execFileSync("git", ["-C", workspace, "add", "README.md"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);
    execFileSync("git", ["-C", workspace, "checkout", "-b", "topic"]);
    execFileSync("git", [
      "-C",
      workspace,
      "worktree",
      "add",
      "-b",
      "feature",
      linkedWorktree,
      "main",
    ]);
    execFileSync("git", ["-C", workspace, "worktree", "lock", linkedWorktree]);
    const nested = join(workspace, "nested");
    const linkedNested = join(linkedWorktree, "nested");
    const plain = join(fixtureRoot, "plain");
    const inconclusive = join(fixtureRoot, "inconclusive");
    const regularFile = join(fixtureRoot, "regular-file");
    const missing = join(fixtureRoot, "missing");
    mkdirSync(nested);
    mkdirSync(linkedNested);
    mkdirSync(plain);
    mkdirSync(inconclusive);
    writeFileSync(join(inconclusive, ".git"), "gitdir: /missing/git-dir\n");
    writeFileSync(regularFile, "not a directory\n");

    const server = await startHostServer(0, HOST_ID, {
      runner: scriptedTurnRunner(["ok"]),
    });
    servers.push(server);
    const { ws, next } = await openRpc(server.websocketUrl);
    ws.send(
      JSON.stringify({
        kind: "request",
        requestId: "workspace-summary",
        method: "worktree.listByWorkspacePaths",
        schemaVersion: { major: 1, minor: 3 },
        params: {
          workspacePaths: [nested, linkedNested, plain],
          scriptRefs: [],
          forceRefresh: true,
        },
      }),
    );
    const response = hostFrameSchema.parse(JSON.parse(await next()));
    if (response.kind !== "response") {
      throw new Error("Missing listByWorkspacePaths response");
    }
    expect(response.error).toBeNull();
    const result = worktreeListByWorkspacePathsResponseSchemaV13.parse(
      response.result,
    );
    expect(result.scriptsAtRefs).toEqual([]);
    expect(result.workspaces).toHaveLength(3);
    const summary = result.workspaces[0];
    expect(summary).toMatchObject({
      workspacePath: nested,
      isGitRepo: true,
      repoIdentifier: { owner: "Acme", repo: "Workspace" },
      mainBranch: "main",
      scripts: null,
    });
    expect(summary?.resolvedAt).toEqual(expect.any(Number));
    expect(summary?.worktrees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          worktreePath: realpathSync(workspace),
          branch: "topic",
          isMain: true,
          isLocked: false,
        }),
        expect.objectContaining({
          worktreePath: realpathSync(linkedWorktree),
          branch: "feature",
          sourceBranch: "main",
          isMain: false,
          isLocked: true,
        }),
      ]),
    );
    expect(result.workspaces[1]).toMatchObject({
      workspacePath: linkedNested,
      isGitRepo: true,
      repoIdentifier: { owner: "Acme", repo: "Workspace" },
      mainBranch: "main",
      worktrees: expect.arrayContaining([
        expect.objectContaining({
          worktreePath: realpathSync(workspace),
          branch: "topic",
          isMain: false,
        }),
        expect.objectContaining({
          worktreePath: realpathSync(linkedWorktree),
          branch: "feature",
          isMain: true,
        }),
      ]),
    });
    expect(result.workspaces[2]).toMatchObject({
      workspacePath: plain,
      isGitRepo: false,
      repoIdentifier: null,
      mainBranch: null,
      worktrees: [],
      scripts: null,
      resolvedAt: expect.any(Number),
    });

    ws.send(
      JSON.stringify({
        kind: "request",
        requestId: "workspace-summary-unresolved",
        method: "worktree.listByWorkspacePaths",
        schemaVersion: { major: 1, minor: 3 },
        params: {
          workspacePaths: [inconclusive, regularFile, missing],
          scriptRefs: [],
          forceRefresh: false,
        },
      }),
    );
    const unresolvedResponse = hostFrameSchema.parse(JSON.parse(await next()));
    if (unresolvedResponse.kind !== "response") {
      throw new Error("Missing unresolved workspace response");
    }
    expect(unresolvedResponse.error).toBeNull();
    const unresolvedResult =
      worktreeListByWorkspacePathsResponseSchemaV13.parse(
        unresolvedResponse.result,
      );
    expect(unresolvedResult.workspaces).toEqual([
      expect.objectContaining({
        workspacePath: inconclusive,
        isGitRepo: false,
        resolvedAt: null,
      }),
      expect.objectContaining({
        workspacePath: regularFile,
        isGitRepo: false,
        resolvedAt: expect.any(Number),
      }),
      expect.objectContaining({
        workspacePath: missing,
        isGitRepo: false,
        resolvedAt: expect.any(Number),
      }),
    ]);
    ws.close();
  });

  it("reads workspace scripts from disk and ref previews from Git", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "traycer-host-scripts-"));
    tempRoots.push(workspace);
    execFileSync("git", ["-C", workspace, "init", "-b", "main"]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.name",
      "Traycer Test",
    ]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.email",
      "traycer@example.com",
    ]);
    const traycerDir = join(workspace, ".traycer");
    const environmentPath = join(traycerDir, "environment.json");
    mkdirSync(traycerDir);
    const scripts = (command: string, updatedAt: number): string =>
      `${JSON.stringify(
        {
          setup: {
            default: command,
            macos: null,
            windows: null,
            linux: null,
          },
          teardown: {
            default: "",
            macos: null,
            windows: null,
            linux: null,
          },
          updatedAt,
        },
        null,
        2,
      )}\n`;
    writeFileSync(environmentPath, scripts("committed setup", 100));
    execFileSync("git", ["-C", workspace, "add", ".traycer/environment.json"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "scripts"]);
    writeFileSync(environmentPath, scripts("working setup", 200));

    const server = await startHostServer(0, HOST_ID, {
      runner: scriptedTurnRunner(["ok"]),
    });
    servers.push(server);
    const { ws, next } = await openRpc(server.websocketUrl);
    ws.send(
      JSON.stringify({
        kind: "request",
        requestId: "workspace-scripts",
        method: "worktree.listByWorkspacePaths",
        schemaVersion: { major: 1, minor: 3 },
        params: {
          workspacePaths: [workspace],
          scriptRefs: [],
          forceRefresh: true,
        },
      }),
    );
    const response = hostFrameSchema.parse(JSON.parse(await next()));
    if (response.kind !== "response") {
      throw new Error("Missing listByWorkspacePaths response");
    }
    expect(response.error).toBeNull();
    const result = worktreeListByWorkspacePathsResponseSchemaV13.parse(
      response.result,
    );
    expect(result.workspaces[0]?.scripts).toMatchObject({
      setup: { default: "working setup" },
      updatedAt: 200,
    });
    expect(result.scriptsAtRefs).toEqual([]);

    ws.send(
      JSON.stringify({
        kind: "request",
        requestId: "workspace-scripts-at-ref",
        method: "worktree.listByWorkspacePaths",
        schemaVersion: { major: 1, minor: 3 },
        params: {
          workspacePaths: [],
          scriptRefs: [{ workspacePath: workspace, ref: "main" }],
          forceRefresh: false,
        },
      }),
    );
    const refResponse = hostFrameSchema.parse(JSON.parse(await next()));
    if (refResponse.kind !== "response") {
      throw new Error("Missing script-ref response");
    }
    expect(refResponse.error).toBeNull();
    const refResult = worktreeListByWorkspacePathsResponseSchemaV13.parse(
      refResponse.result,
    );
    expect(refResult.workspaces).toEqual([]);
    expect(refResult.scriptsAtRefs).toEqual([
      {
        workspacePath: workspace,
        ref: "main",
        scripts: expect.objectContaining({
          setup: expect.objectContaining({ default: "committed setup" }),
          updatedAt: 100,
        }),
      },
    ]);
    ws.close();
  });

  it("lists and reads files under a workspace root", async () => {
    const server = await startHostServer(0, HOST_ID, {
      runner: scriptedTurnRunner(["ok"]),
    });
    servers.push(server);
    const { ws, next } = await openRpc(server.websocketUrl);
    ws.send(
      JSON.stringify({
        kind: "request",
        requestId: "d1",
        method: "workspace.listDirectory",
        schemaVersion: { major: 1, minor: 0 },
        params: {
          workspacePath: process.cwd(),
          directoryPath: process.cwd(),
        },
      }),
    );
    const listed = hostFrameSchema.parse(JSON.parse(await next()));
    expect(listed).toMatchObject({
      kind: "response",
      error: null,
      result: { workspacePath: process.cwd() },
    });

    ws.send(
      JSON.stringify({
        kind: "request",
        requestId: "r1",
        method: "workspace.readFile",
        schemaVersion: { major: 1, minor: 0 },
        params: {
          workspacePath: process.cwd(),
          filePath: `${process.cwd()}/package.json`,
          maxBytes: 200,
        },
      }),
    );
    const read = hostFrameSchema.parse(JSON.parse(await next()));
    expect(read).toMatchObject({
      kind: "response",
      error: null,
      result: { truncated: true, error: null },
    });
    ws.close();
  });

  it("probes git.getCapabilities against a real runningDir", async () => {
    const server = await startHostServer(0, HOST_ID, {
      runner: scriptedTurnRunner(["ok"]),
    });
    servers.push(server);
    const { ws, next } = await openRpc(server.websocketUrl);
    ws.send(
      JSON.stringify({
        kind: "request",
        requestId: "g1",
        method: "git.getCapabilities",
        schemaVersion: { major: 1, minor: 0 },
        params: {
          hostId: HOST_ID,
          runningDir: process.cwd(),
          ignoreWhitespace: false,
        },
      }),
    );
    const response = hostFrameSchema.parse(JSON.parse(await next()));
    expect(response).toMatchObject({
      kind: "response",
      error: null,
      result: { available: true },
    });
    ws.close();
  });
});
