import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  workspaceScriptsSchema,
  type DiskWorktreeEntry,
  type RepoBranchPrefixState,
  type WorktreeScriptRef,
  type WorktreeScriptsAtRef,
  type WorktreeWorkspaceSummaryV15,
  type WorkspaceScripts,
} from "@traycer/protocol/host/worktree-schemas";
import { gitRepositoryRoot, readGit, runGitBoolean } from "./git-read";

const ENVIRONMENT_PATH_SEGMENTS = [".traycer", "environment.json"] as const;
const ENVIRONMENT_GIT_PATH = ".traycer/environment.json";

type MutableWorktreeEntry = {
  worktreePath: string | null;
  branch: string | null;
  head: string | null;
  isLocked: boolean;
  isPrunable: boolean;
};

type EnvironmentRead = {
  readonly scripts: WorkspaceScripts | null;
  readonly repoBranchPrefix: RepoBranchPrefixState;
};

export type WorktreeWorkspaceSummaryOptions = {
  readonly forceRefresh: boolean;
  readonly environment: "include" | "omit";
};

export async function summarizeWorktreeWorkspacePaths(
  workspacePaths: readonly string[],
  options: WorktreeWorkspaceSummaryOptions,
): Promise<WorktreeWorkspaceSummaryV15[]> {
  return Promise.all(
    workspacePaths.map(async (workspacePath) => {
      try {
        return await summarizeWorktreeWorkspacePath(
          workspacePath,
          options.environment,
        );
      } catch (error) {
        if (options.forceRefresh) {
          throw error;
        }
        return unresolvedWorkspaceSummary(workspacePath);
      }
    }),
  );
}

export async function readWorktreeScriptsAtRefs(
  scriptRefs: readonly WorktreeScriptRef[],
): Promise<WorktreeScriptsAtRef[]> {
  return Promise.all(
    scriptRefs.map(async ({ workspacePath, ref }) => {
      const root = await gitRepositoryRoot(workspacePath);
      const output =
        root === null
          ? null
          : await readGit(root, ["show", `${ref}:${ENVIRONMENT_GIT_PATH}`]);
      return {
        workspacePath,
        ref,
        scripts: parseWorkspaceScripts(output),
      };
    }),
  );
}

async function summarizeWorktreeWorkspacePath(
  workspacePath: string,
  environmentMode: WorktreeWorkspaceSummaryOptions["environment"],
): Promise<WorktreeWorkspaceSummaryV15> {
  const present = await directoryIsPresent(workspacePath);
  const root = await gitRepositoryRoot(workspacePath);
  if (root === null) {
    const resolved =
      present === "present"
        ? await isConclusiveNonGitDirectory(workspacePath)
        : present === "absent";
    return {
      workspacePath,
      isGitRepo: false,
      repoIdentifier: null,
      mainBranch: null,
      worktrees: [],
      scripts: null,
      resolvedAt: resolved ? Date.now() : null,
      repoBranchPrefix: { status: "absent" },
      presence: present === "absent" ? "absent" : "present",
    };
  }

  await runGitBoolean(root, ["worktree", "prune"]);
  const [worktreeOutput, mainBranch, remoteUrl, environment] =
    await Promise.all([
      readGit(root, ["worktree", "list", "--porcelain"]),
      resolveMainBranch(root),
      readGit(root, ["remote", "get-url", "origin"]),
      readEnvironmentForSummary(root, environmentMode),
    ]);
  if (worktreeOutput === null) {
    const succeeded = await runGitBoolean(root, [
      "worktree",
      "list",
      "--porcelain",
    ]);
    if (!succeeded) {
      throw new Error(`git worktree list failed for ${root}`);
    }
  }
  const worktrees = await withSourceBranches(
    root,
    parseWorktreePorcelain(worktreeOutput ?? "", root),
    mainBranch,
  );
  return {
    workspacePath,
    isGitRepo: true,
    repoIdentifier: parseWorktreeRepoIdentifier(remoteUrl),
    mainBranch,
    worktrees,
    scripts: environment.scripts,
    resolvedAt: Date.now(),
    repoBranchPrefix: environment.repoBranchPrefix,
    presence: "present",
  };
}

async function resolveMainBranch(root: string): Promise<string | null> {
  const remoteHead = await readGit(root, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (remoteHead !== null) {
    return remoteHead.replace(/^origin\//u, "");
  }
  const conventional = await readGit(root, [
    "branch",
    "--list",
    "main",
    "master",
    "--format=%(refname:short)",
  ]);
  if (conventional !== null) {
    const names = outputLines(conventional);
    if (names.includes("main")) {
      return "main";
    }
    if (names.includes("master")) {
      return "master";
    }
  }
  const head = await readGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return head === null || head === "HEAD" ? null : head;
}

function parseWorktreePorcelain(
  output: string,
  root: string,
): DiskWorktreeEntry[] {
  if (output.trim().length === 0) {
    return [];
  }
  const worktrees: DiskWorktreeEntry[] = [];
  let current: MutableWorktreeEntry | null = null;
  const flush = (): void => {
    if (
      current === null ||
      current.worktreePath === null ||
      current.isPrunable
    ) {
      current = null;
      return;
    }
    worktrees.push({
      worktreePath: current.worktreePath,
      branch: current.branch,
      head: current.head,
      isMain: resolve(current.worktreePath) === resolve(root),
      isLocked: current.isLocked,
    });
    current = null;
  };
  for (const line of output.split(/\r?\n/u)) {
    const value = line.trimEnd();
    if (value.length === 0) {
      flush();
      continue;
    }
    if (value.startsWith("worktree ")) {
      flush();
      current = {
        worktreePath: value.slice(9).trim(),
        branch: null,
        head: null,
        isLocked: false,
        isPrunable: false,
      };
      continue;
    }
    if (current === null) {
      continue;
    }
    if (value.startsWith("HEAD ")) {
      current.head = value.slice(5).trim();
    } else if (value.startsWith("branch ")) {
      current.branch = value
        .slice(7)
        .trim()
        .replace(/^refs\/heads\//u, "");
    } else if (value === "detached") {
      current.branch = null;
    } else if (value === "locked" || value.startsWith("locked ")) {
      current.isLocked = true;
    } else if (value === "prunable" || value.startsWith("prunable ")) {
      current.isPrunable = true;
    }
  }
  flush();
  return worktrees;
}

async function withSourceBranches(
  root: string,
  worktrees: readonly DiskWorktreeEntry[],
  mainBranch: string | null,
): Promise<DiskWorktreeEntry[]> {
  return Promise.all(
    worktrees.map(async (worktree) => ({
      ...worktree,
      sourceBranch: worktree.isMain
        ? null
        : await detectWorktreeSourceBranch(root, worktree, mainBranch),
    })),
  );
}

async function detectWorktreeSourceBranch(
  root: string,
  worktree: DiskWorktreeEntry,
  mainBranch: string | null,
): Promise<string | null> {
  const branchReflog =
    worktree.branch === null
      ? null
      : await readGit(root, [
          "reflog",
          "show",
          "--format=%gs",
          "--max-count=16",
          `refs/heads/${worktree.branch}`,
        ]);
  const branchSource = sourceBranchFromReflog(branchReflog);
  if (branchSource !== null) {
    return branchSource;
  }
  const headReflog = await readGit(worktree.worktreePath, [
    "reflog",
    "show",
    "--format=%gs",
    "--max-count=16",
    "HEAD",
  ]);
  return sourceBranchFromReflog(headReflog) ?? mainBranch;
}

function sourceBranchFromReflog(output: string | null): string | null {
  if (output === null) {
    return null;
  }
  for (const line of output.split(/\r?\n/u)) {
    const value = line.trim();
    const created = value.match(/^branch: Created from (?<source>.+)$/u);
    const checkout = value.match(
      /^checkout: moving from (?<source>\S+) to \S+$/u,
    );
    const source = created?.groups?.source ?? checkout?.groups?.source ?? null;
    const normalized = normalizeSourceBranch(source);
    if (normalized !== null) {
      return normalized;
    }
  }
  return null;
}

function normalizeSourceBranch(source: string | null): string | null {
  const value = source?.trim() ?? "";
  if (
    value.length === 0 ||
    value === "HEAD" ||
    /^[0-9a-f]{7,40}$/iu.test(value)
  ) {
    return null;
  }
  return value.replace(/^refs\/heads\//u, "").replace(/^refs\/remotes\//u, "");
}

export function parseWorktreeRepoIdentifier(
  remoteUrl: string | null,
): { readonly owner: string; readonly repo: string } | null {
  if (remoteUrl === null || remoteUrl.length === 0) {
    return null;
  }
  const scpPath = remoteUrl.match(/^[^@\s]+@[^:]+:(?<path>.+)$/u)?.groups?.path;
  let path = scpPath ?? null;
  if (path === null) {
    try {
      path = new URL(remoteUrl).pathname;
    } catch {
      return null;
    }
  }
  const segments = path
    .replace(/\.git$/u, "")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const repo = segments.at(-1);
  const owner = segments.at(-2);
  return owner === undefined || repo === undefined ? null : { owner, repo };
}

async function readEnvironment(root: string): Promise<EnvironmentRead> {
  let content: string;
  try {
    content = await readFile(join(root, ...ENVIRONMENT_PATH_SEGMENTS), "utf8");
  } catch (error) {
    return {
      scripts: null,
      repoBranchPrefix: {
        status: isMissingPathError(error) ? "absent" : "malformed",
      },
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return { scripts: null, repoBranchPrefix: { status: "malformed" } };
  }
  const scripts = workspaceScriptsSchema.safeParse(value);
  return {
    scripts: scripts.success ? scripts.data : null,
    repoBranchPrefix: repoBranchPrefixFromJson(value),
  };
}

function readEnvironmentForSummary(
  root: string,
  environment: WorktreeWorkspaceSummaryOptions["environment"],
): Promise<EnvironmentRead> {
  if (environment === "omit") {
    return Promise.resolve({
      scripts: null,
      repoBranchPrefix: { status: "absent" },
    });
  }
  return readEnvironment(root);
}

function parseWorkspaceScripts(
  content: string | null,
): WorkspaceScripts | null {
  if (content === null) {
    return null;
  }
  try {
    const parsed = workspaceScriptsSchema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function repoBranchPrefixFromJson(value: unknown): RepoBranchPrefixState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { status: "malformed" };
  }
  if (!("branchPrefix" in value)) {
    return { status: "absent" };
  }
  const branchPrefix = value.branchPrefix;
  return typeof branchPrefix === "string"
    ? { status: "present", value: branchPrefix }
    : { status: "malformed" };
}

function unresolvedWorkspaceSummary(
  workspacePath: string,
): WorktreeWorkspaceSummaryV15 {
  return {
    workspacePath,
    isGitRepo: false,
    repoIdentifier: null,
    mainBranch: null,
    worktrees: [],
    scripts: null,
    resolvedAt: null,
    repoBranchPrefix: { status: "absent" },
    presence: "present",
  };
}

async function directoryIsPresent(
  path: string,
): Promise<"present" | "absent" | "unknown"> {
  try {
    return (await stat(path)).isDirectory() ? "present" : "absent";
  } catch (error) {
    if (isMissingPathError(error)) {
      return "absent";
    }
    return "unknown";
  }
}

async function isConclusiveNonGitDirectory(path: string): Promise<boolean> {
  let cursor: string;
  try {
    cursor = await realpath(path);
  } catch {
    return false;
  }
  while (true) {
    try {
      await stat(join(cursor, ".git"));
      return false;
    } catch {
      // The signed host treats an unreadable marker like a missing marker and
      // keeps walking toward the filesystem root.
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      return true;
    }
    cursor = parent;
  }
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

function outputLines(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
