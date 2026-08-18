import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { splitConnectionManifest } from "@traycer/protocol/framework/capability-manifest";
import {
  hostFrameSchema,
  type HostFrame,
} from "@traycer/protocol/framework/ws-protocol";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { workspaceListFileTreeResponseSchema } from "@traycer/protocol/host/workspace/unary-schemas";
import {
  workspaceFileMentionSuggestionsResponseSchema,
  workspaceFolderMentionSuggestionsResponseSchema,
  workspaceGitBranchMentionSuggestionsResponseSchema,
  workspaceGitCommitMentionSuggestionsResponseSchema,
  workspaceGitRootMentionSuggestionsResponseSchema,
  workspaceWorktreeMentionSuggestionsResponseSchema,
} from "@traycer/protocol/host/workspace/unary-schemas";
import { startHostServer, type HostServer } from "../server";

describe("workspace.listFileTree", () => {
  const servers: HostServer[] = [];
  const sockets: WebSocket[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    while (servers.length > 0) await servers.pop()?.close();
    while (roots.length > 0) {
      const root = roots.pop();
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    }
  });

  it("lists canonical workspace files with Git badges, ignore control, and truncation", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-file-tree-"));
    roots.push(root);
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Traycer Test");
    git(root, "config", "user.email", "traycer@example.com");
    await mkdir(join(root, "src"));
    await writeFile(join(root, ".gitignore"), "*.log\n");
    await writeFile(join(root, "src", "tracked.ts"), "export const n = 1;\n");
    git(root, "add", ".gitignore", "src/tracked.ts");
    git(root, "commit", "-m", "initial");
    await writeFile(join(root, "src", "tracked.ts"), "export const n = 2;\n");
    await writeFile(join(root, "src", "untracked.ts"), "export {};\n");
    await writeFile(join(root, "ignored.log"), "ignored\n");

    const server = await startHostServer(0, "host-file-tree", undefined);
    servers.push(server);
    const connection = await openRpc(server.websocketUrl, sockets);

    const ordinary = workspaceListFileTreeResponseSchema.parse(
      responseResult(
        await rpc(connection, {
          workspacePath: root,
          maxFiles: 100,
          includeIgnored: false,
        }),
      ),
    );
    expect(ordinary).toEqual({
      workspacePath: await realpath(root),
      files: [
        { path: ".gitignore", name: ".gitignore" },
        { path: "src/tracked.ts", name: "tracked.ts" },
        { path: "src/untracked.ts", name: "untracked.ts" },
      ],
      gitStatus: [
        { path: "src/tracked.ts", status: "modified" },
        { path: "src/untracked.ts", status: "untracked" },
      ],
      truncated: false,
    });

    const withIgnored = workspaceListFileTreeResponseSchema.parse(
      responseResult(
        await rpc(connection, {
          workspacePath: root,
          maxFiles: 100,
          includeIgnored: true,
        }),
      ),
    );
    expect(withIgnored.files).toContainEqual({
      path: "ignored.log",
      name: "ignored.log",
    });
    expect(withIgnored.gitStatus).toContainEqual({
      path: "ignored.log",
      status: "ignored",
    });

    const truncated = workspaceListFileTreeResponseSchema.parse(
      responseResult(
        await rpc(connection, {
          workspacePath: root,
          maxFiles: 2,
          includeIgnored: true,
        }),
      ),
    );
    expect(truncated.files).toHaveLength(2);
    expect(truncated.truncated).toBe(true);
  });

  it("returns deterministic file and folder mention suggestions across roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-mentions-"));
    roots.push(root);
    await mkdir(join(root, "docs"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "docs", "guide.md"), "guide\n");
    await writeFile(join(root, "src", "guide.ts"), "guide\n");
    await writeFile(join(root, "README.md"), "readme\n");
    const canonicalRoot = await realpath(root);

    const server = await startHostServer(0, "host-mentions", undefined);
    servers.push(server);
    const connection = await openRpc(server.websocketUrl, sockets);
    const files = workspaceFileMentionSuggestionsResponseSchema.parse(
      responseResult(
        await rpcMethod(connection, "workspace.mentionFiles", {
          roots: [root],
          query: "guide",
          limit: 1,
        }),
      ),
    );
    expect(files).toEqual({
      entries: [
        {
          kind: "file",
          id: `file:${canonicalRoot}:docs/guide.md`,
          label: "guide.md",
          relPath: "docs/guide.md",
          absolutePath: join(canonicalRoot, "docs", "guide.md"),
          workspacePath: canonicalRoot,
          description: "docs",
        },
      ],
    });

    const folders = workspaceFolderMentionSuggestionsResponseSchema.parse(
      responseResult(
        await rpcMethod(connection, "workspace.mentionFolders", {
          roots: [root],
          query: "",
          limit: 2,
        }),
      ),
    );
    expect(folders).toEqual({
      entries: [
        {
          kind: "folder",
          id: `folder:${canonicalRoot}:docs/`,
          label: "docs",
          relPath: "docs/",
          absolutePath: join(canonicalRoot, "docs"),
          workspacePath: canonicalRoot,
          description: "",
        },
        {
          kind: "folder",
          id: `folder:${canonicalRoot}:src/`,
          label: "src",
          relPath: "src/",
          absolutePath: join(canonicalRoot, "src"),
          workspacePath: canonicalRoot,
          description: "",
        },
      ],
    });
  });

  it("returns worktree, Git root, branch, and commit mention suggestions", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-git-mentions-"));
    const linked = await mkdtemp(join(tmpdir(), "traycer-linked-worktree-"));
    roots.push(root, linked);
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Traycer Test");
    git(root, "config", "user.email", "traycer@example.com");
    await writeFile(join(root, "README.md"), "first\n");
    git(root, "add", "README.md");
    git(root, "commit", "-m", "first mention commit");
    const commitHash = git(root, "rev-parse", "HEAD").trim();
    git(root, "branch", "feature/mention");
    await rm(linked, { recursive: true, force: true });
    git(root, "worktree", "add", linked, "feature/mention");
    await writeFile(join(root, "uncommitted.txt"), "pending\n");
    const canonicalRoot = await realpath(root);
    const canonicalLinked = await realpath(linked);

    const server = await startHostServer(0, "host-git-mentions", undefined);
    servers.push(server);
    const connection = await openRpc(server.websocketUrl, sockets);

    const worktrees = workspaceWorktreeMentionSuggestionsResponseSchema.parse(
      responseResult(
        await rpcMethod(connection, "workspace.mentionWorktrees", {
          roots: [root],
          query: "feature/",
          limit: 10,
        }),
      ),
    );
    expect(worktrees.entries).toEqual([
      {
        kind: "worktree",
        id: `worktree:${canonicalRoot}:${canonicalLinked}`,
        label: "feature/mention",
        worktreePath: canonicalLinked,
        workspacePath: canonicalRoot,
        branch: "feature/mention",
        isMain: false,
        description: canonicalLinked,
      },
    ]);

    const gitRoot = workspaceGitRootMentionSuggestionsResponseSchema.parse(
      responseResult(
        await rpcMethod(connection, "workspace.mentionGitRoot", {
          workspacePath: root,
          query: "",
          limit: 10,
        }),
      ),
    );
    expect(gitRoot.entries).toContainEqual({
      kind: "git",
      id: `git:branch:${canonicalRoot}:main`,
      label: "Diff against branch 'main'",
      description: basename(canonicalRoot),
      workspacePath: canonicalRoot,
      gitType: "against_branch",
      branchName: "main",
      commitHash: null,
    });
    expect(gitRoot.entries).toContainEqual({
      kind: "git",
      id: `git:uncommitted:${canonicalRoot}`,
      label: "Diff against uncommitted changes",
      description: basename(canonicalRoot),
      workspacePath: canonicalRoot,
      gitType: "against_uncommitted_changes",
      branchName: null,
      commitHash: null,
    });

    const branches = workspaceGitBranchMentionSuggestionsResponseSchema.parse(
      responseResult(
        await rpcMethod(connection, "workspace.mentionGitBranches", {
          workspacePath: root,
          query: "feature",
          limit: 10,
        }),
      ),
    );
    expect(branches.entries).toEqual([
      {
        kind: "git",
        id: `git:branch:${canonicalRoot}:feature/mention`,
        label: "Diff against branch 'feature/mention'",
        description: basename(canonicalRoot),
        workspacePath: canonicalRoot,
        gitType: "against_branch",
        branchName: "feature/mention",
        commitHash: null,
      },
    ]);

    const commits = workspaceGitCommitMentionSuggestionsResponseSchema.parse(
      responseResult(
        await rpcMethod(connection, "workspace.mentionGitCommits", {
          workspacePath: root,
          query: "mention",
          limit: 10,
        }),
      ),
    );
    expect(commits.entries).toHaveLength(1);
    expect(commits.entries[0]).toMatchObject({
      kind: "git",
      id: `git:commit:${canonicalRoot}:${commitHash}`,
      label: `${commitHash.slice(0, 7)} first mention commit`,
      workspacePath: canonicalRoot,
      gitType: "against_commit",
      branchName: null,
      commitHash,
    });
    expect(commits.entries[0]?.description).toMatch(
      new RegExp(
        `^Traycer Test - \\d{4}-\\d{2}-\\d{2} - ${basename(canonicalRoot)}$`,
      ),
    );
  });
});

type RpcConnection = { readonly ws: WebSocket; nextRequestId: number };

async function openRpc(
  websocketUrl: string,
  sockets: WebSocket[],
): Promise<RpcConnection> {
  const ws = new WebSocket(websocketUrl);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
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
  hostFrameSchema.parse(JSON.parse(await nextMessage(ws)));
  return { ws, nextRequestId: 1 };
}

async function rpc(
  connection: RpcConnection,
  params: unknown,
): Promise<HostFrame> {
  return await rpcMethod(connection, "workspace.listFileTree", params);
}

async function rpcMethod(
  connection: RpcConnection,
  method: string,
  params: unknown,
): Promise<HostFrame> {
  const requestId = `file-tree-${String(connection.nextRequestId++)}`;
  connection.ws.send(
    JSON.stringify({
      kind: "request",
      requestId,
      method,
      schemaVersion: { major: 1, minor: 0 },
      params,
    }),
  );
  return hostFrameSchema.parse(JSON.parse(await nextMessage(connection.ws)));
}

function responseResult(frame: HostFrame): unknown {
  if (frame.kind !== "response" || frame.error !== null) {
    throw new Error(
      frame.kind === "response"
        ? `${frame.error?.code}: ${frame.error?.message}`
        : "Expected response frame",
    );
  }
  return frame.result;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData): void => {
      ws.off("error", onError);
      resolve(data.toString());
    };
    const onError = (error: Error): void => {
      ws.off("message", onMessage);
      reject(error);
    };
    ws.once("message", onMessage);
    ws.once("error", onError);
  });
}
