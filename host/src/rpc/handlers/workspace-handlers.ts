import { basename, join } from "node:path";
import {
  workspaceGitMentionSuggestionsRequestSchema,
  workspaceListDirectoryRequestSchema,
  workspaceListFileTreeRequestSchema,
  workspacePathMentionSuggestionsRequestSchema,
  workspacePrepareFoldersRequestSchemaV14,
  workspaceReadFileRequestSchema,
  workspaceResolvePathsByRepoIdentifiersRequestSchema,
} from "@traycer/protocol/host/workspace/unary-schemas";
import type { RpcHandler } from "./types";
import {
  inspectRepo,
  listBranches,
  listDiskWorktrees,
  listRecentCommits,
  statusSnapshot,
} from "../../git/git";
import {
  createAndPrepare,
  forgetRecent,
  homeDir,
  listDirectory,
  listFileTree,
  prepareFolders,
  readWorkspaceFile,
  recordRecent,
  validateWorkspacePath,
} from "../../workspace/workspace";

export const handleWorkspacePrepareFolders: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = workspacePrepareFoldersRequestSchemaV14.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const request = parsed.data;
  const recents = runtime.store.snapshot().recents;
  if (request.operation === "getHomeDir") {
    return emptyPrepare(request.operation, homeDir(), recents);
  }
  if (request.operation === "listRecentWorkspaces") {
    return emptyPrepare(request.operation, null, recents);
  }
  if (request.operation === "validatePath") {
    if (request.path === null) {
      return {
        ok: false,
        code: "RPC_ERROR",
        message: "validatePath requires path",
      };
    }
    const validation = await validateWorkspacePath(request.path);
    return {
      ok: true,
      result: {
        operation: request.operation,
        folders: [],
        repoIdentifiers: [],
        homeDir: null,
        validation,
        recentWorkspaces: recents,
      },
    };
  }
  if (request.operation === "recordRecentWorkspace") {
    if (request.path === null) {
      return {
        ok: false,
        code: "RPC_ERROR",
        message: "recordRecentWorkspace requires path",
      };
    }
    const bump = request.bumpRecency !== false;
    const next = await recordRecent(runtime.store, request.path, bump);
    const validation = bump ? await validateWorkspacePath(request.path) : null;
    return {
      ok: true,
      result: {
        operation: request.operation,
        folders: [],
        repoIdentifiers: [],
        homeDir: null,
        validation,
        recentWorkspaces: next,
      },
    };
  }
  if (request.operation === "forgetRecentWorkspace") {
    if (request.path === null) {
      return {
        ok: false,
        code: "RPC_ERROR",
        message: "forgetRecentWorkspace requires path",
      };
    }
    const next = await forgetRecent(runtime.store, request.path);
    return emptyPrepare(request.operation, null, next);
  }
  if (request.operation === "createAndPrepare") {
    if (request.path === null) {
      return {
        ok: false,
        code: "RPC_ERROR",
        message: "createAndPrepare requires path",
      };
    }
    const created = await createAndPrepare(request.path);
    if (!created.ok) {
      return {
        ok: true,
        result: {
          operation: request.operation,
          folders: [],
          repoIdentifiers: [],
          homeDir: null,
          validation: created,
          recentWorkspaces: recents,
        },
      };
    }
    const prepared = await prepareFolders([created.resolvedPath]);
    if (request.bumpRecency === true) {
      await recordRecent(runtime.store, created.resolvedPath, true);
    }
    return {
      ok: true,
      result: {
        operation: request.operation,
        folders: prepared.folders,
        repoIdentifiers: prepared.repoIdentifiers,
        homeDir: null,
        validation: created,
        recentWorkspaces: runtime.store.snapshot().recents,
      },
    };
  }
  const folderPaths = request.folderPaths ?? [];
  const prepared = await prepareFolders(folderPaths);
  if (request.bumpRecency === true) {
    for (const folder of prepared.folders) {
      await recordRecent(runtime.store, folder.workspacePath, true);
    }
  }
  return {
    ok: true,
    result: {
      operation: request.operation,
      folders: prepared.folders,
      repoIdentifiers: prepared.repoIdentifiers,
      homeDir: null,
      validation: null,
      recentWorkspaces: runtime.store.snapshot().recents,
    },
  };
};

export const handleWorkspaceListDirectory: RpcHandler = async (params) => {
  const parsed = workspaceListDirectoryRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const listed = await listDirectory(
    parsed.data.workspacePath,
    parsed.data.directoryPath,
  );
  if (!listed.ok) {
    return { ok: false, code: "RPC_ERROR", message: listed.message };
  }
  return {
    ok: true,
    result: {
      workspacePath: parsed.data.workspacePath,
      directoryPath: parsed.data.directoryPath,
      entries: listed.entries,
    },
  };
};

export const handleWorkspaceReadFile: RpcHandler = async (params) => {
  const parsed = workspaceReadFileRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const read = await readWorkspaceFile(
    parsed.data.workspacePath,
    parsed.data.filePath,
    parsed.data.maxBytes,
  );
  return {
    ok: true,
    result: {
      workspacePath: parsed.data.workspacePath,
      filePath: parsed.data.filePath,
      content: read.content,
      truncated: read.truncated,
      error: read.error,
    },
  };
};

export const handleWorkspaceListFileTree: RpcHandler = async (params) => {
  const parsed = workspaceListFileTreeRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const tree = await listFileTree(
    parsed.data.workspacePath,
    parsed.data.maxFiles,
  );
  const snapshot = statusSnapshot(parsed.data.workspacePath);
  const gitStatus =
    snapshot === null
      ? []
      : snapshot.files.map((file) => ({
          path: file.path,
          status:
            file.status === "conflicted" ||
            file.status === "copied" ||
            file.status === "modified"
              ? ("modified" as const)
              : file.status === "added"
                ? ("added" as const)
                : file.status === "deleted"
                  ? ("deleted" as const)
                  : file.status === "renamed"
                    ? ("renamed" as const)
                    : ("untracked" as const),
        }));
  return {
    ok: true,
    result: {
      workspacePath: parsed.data.workspacePath,
      files: tree.files,
      gitStatus,
      truncated: tree.truncated,
    },
  };
};

export const handleWorkspaceMentionFolders: RpcHandler = async (params) => {
  const parsed = workspacePathMentionSuggestionsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const query = parsed.data.query.toLowerCase();
  const entries = [];
  for (const root of parsed.data.roots) {
    const listed = await listDirectory(root, ".");
    if (!listed.ok) {
      continue;
    }
    for (const entry of listed.entries) {
      if (entry.kind !== "directory") {
        continue;
      }
      if (query.length > 0 && !entry.name.toLowerCase().includes(query)) {
        continue;
      }
      entries.push({
        kind: "folder" as const,
        id: `${root}:${entry.path}`,
        label: entry.name,
        relPath: entry.path,
        absolutePath: join(root, entry.path),
        workspacePath: root,
        description: basename(root),
      });
      if (entries.length >= parsed.data.limit) {
        break;
      }
    }
    if (entries.length >= parsed.data.limit) {
      break;
    }
  }
  return { ok: true, result: { entries } };
};

export const handleWorkspaceMentionFiles: RpcHandler = async (params) => {
  const parsed = workspacePathMentionSuggestionsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const query = parsed.data.query.toLowerCase();
  const entries = [];
  for (const root of parsed.data.roots) {
    const tree = await listFileTree(root, 500);
    for (const file of tree.files) {
      if (query.length > 0 && !file.path.toLowerCase().includes(query)) {
        continue;
      }
      entries.push({
        kind: "file" as const,
        id: `${root}:${file.path}`,
        label: file.name,
        relPath: file.path,
        absolutePath: join(root, file.path),
        workspacePath: root,
        description: file.path,
      });
      if (entries.length >= parsed.data.limit) {
        break;
      }
    }
    if (entries.length >= parsed.data.limit) {
      break;
    }
  }
  return { ok: true, result: { entries } };
};

export const handleWorkspaceMentionWorktrees: RpcHandler = (params) => {
  const parsed = workspacePathMentionSuggestionsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const query = parsed.data.query.toLowerCase();
  const entries = [];
  for (const root of parsed.data.roots) {
    for (const worktree of listDiskWorktrees(root)) {
      const label = worktree.branch ?? basename(worktree.worktreePath);
      if (query.length > 0 && !label.toLowerCase().includes(query)) {
        continue;
      }
      entries.push({
        kind: "worktree" as const,
        id: worktree.worktreePath,
        label,
        worktreePath: worktree.worktreePath,
        workspacePath: root,
        branch: worktree.branch,
        isMain: worktree.isMain,
        description: worktree.worktreePath,
      });
      if (entries.length >= parsed.data.limit) {
        break;
      }
    }
  }
  return { ok: true, result: { entries } };
};

export const handleWorkspaceMentionGitRoot: RpcHandler = (params) => {
  const parsed = workspaceGitMentionSuggestionsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const facts = inspectRepo(parsed.data.workspacePath);
  if (facts === null) {
    return { ok: true, result: { entries: [] } };
  }
  const entries: {
    readonly kind: "git";
    readonly id: string;
    readonly label: string;
    readonly description: string;
    readonly workspacePath: string;
    readonly gitType: "against_uncommitted_changes" | "against_branch";
    readonly branchName: string | null;
    readonly commitHash: null;
  }[] = [
    {
      kind: "git",
      id: `${facts.toplevel}:uncommitted`,
      label: "Uncommitted changes",
      description: "Working tree",
      workspacePath: parsed.data.workspacePath,
      gitType: "against_uncommitted_changes",
      branchName: null,
      commitHash: null,
    },
  ];
  if (facts.branch !== null) {
    entries.push({
      kind: "git",
      id: `${facts.toplevel}:branch:${facts.branch}`,
      label: facts.branch,
      description: "Current branch",
      workspacePath: parsed.data.workspacePath,
      gitType: "against_branch",
      branchName: facts.branch,
      commitHash: null,
    });
  }
  return { ok: true, result: { entries: entries.slice(0, parsed.data.limit) } };
};

export const handleWorkspaceMentionGitBranches: RpcHandler = (params) => {
  const parsed = workspaceGitMentionSuggestionsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const query = parsed.data.query.toLowerCase();
  const listed = listBranches(parsed.data.workspacePath, true);
  const entries = listed.branches
    .filter(
      (branch) =>
        query.length === 0 || branch.name.toLowerCase().includes(query),
    )
    .slice(0, parsed.data.limit)
    .map((branch) => ({
      kind: "git" as const,
      id: `${parsed.data.workspacePath}:branch:${branch.name}`,
      label: branch.name,
      description: branch.isCurrent ? "Current branch" : "Branch",
      workspacePath: parsed.data.workspacePath,
      gitType: "against_branch" as const,
      branchName: branch.name,
      commitHash: null,
    }));
  return { ok: true, result: { entries } };
};

export const handleWorkspaceMentionGitCommits: RpcHandler = (params) => {
  const parsed = workspaceGitMentionSuggestionsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const commits = listRecentCommits(
    parsed.data.workspacePath,
    parsed.data.query,
    parsed.data.limit,
  );
  const entries = commits.map((commit) => ({
    kind: "git" as const,
    id: `${parsed.data.workspacePath}:commit:${commit.hash}`,
    label: commit.hash.slice(0, 8),
    description: commit.subject,
    workspacePath: parsed.data.workspacePath,
    gitType: "against_commit" as const,
    branchName: null,
    commitHash: commit.hash,
  }));
  return { ok: true, result: { entries } };
};

export const handleWorkspaceResolvePaths: RpcHandler = (params, runtime) => {
  const parsed =
    workspaceResolvePathsByRepoIdentifiersRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const wanted = new Set(
    parsed.data.repoIdentifiers.map((repo) => `${repo.owner}/${repo.repo}`),
  );
  const mappings = [];
  const seen = new Set<string>();
  const candidates = [
    ...runtime.store.snapshot().recents.map((recent) => recent.path),
    ...runtime.store.snapshot().epics.flatMap((epic) => [...epic.workspaces]),
  ];
  for (const path of candidates) {
    const facts = inspectRepo(path);
    if (facts === null || facts.repoIdentifier === null) {
      continue;
    }
    const key = `${facts.repoIdentifier.owner}/${facts.repoIdentifier.repo}`;
    if (!wanted.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    mappings.push({
      repoIdentifier: facts.repoIdentifier,
      workspacePath: facts.toplevel,
    });
  }
  return { ok: true, result: { mappings } };
};

function emptyPrepare(
  operation: string,
  home: string | null,
  recents: readonly { path: string; lastOpenedAt: string }[],
) {
  return {
    ok: true as const,
    result: {
      operation,
      folders: [],
      repoIdentifiers: [],
      homeDir: home,
      validation: null,
      recentWorkspaces: recents,
    },
  };
}
