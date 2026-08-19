import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  worktreeListAllForHostRequestSchemaV15,
  type WorktreeHostEntryOwner,
  type WorktreeHostEntryV15,
  type WorktreeListAllForHostResponseV15,
} from "@traycer/protocol/host/worktree-schemas";
import { readGit, runGitBoolean } from "./git-read";
import type { HostState } from "./store";
import { summarizeWorktreeWorkspacePaths } from "./worktree-summary";

export async function listAllWorktreesForHost(
  state: HostState,
  params: unknown,
): Promise<WorktreeListAllForHostResponseV15> {
  const request = worktreeListAllForHostRequestSchemaV15.parse(params);
  const paths = await managedWorktreePaths(state.managedWorktreeRoot());
  const activityPaths = request.activityPaths;
  const selected =
    activityPaths === null
      ? paths.filter(
          (path) => request.cursor === null || path > resolve(request.cursor),
        )
      : paths.filter((path) =>
          activityPaths.some((selectedPath) =>
            sameResolvedPath(path, selectedPath),
          ),
        );
  const limit = activityPaths === null ? request.limit : null;
  const page = limit === null ? selected : selected.slice(0, limit);
  const includeActivity = request.includeActivity || activityPaths !== null;
  const worktrees = await Promise.all(
    page.map((path) => worktreeEntry(state, path, includeActivity)),
  );
  return {
    worktrees,
    nextCursor:
      limit !== null && selected.length > page.length
        ? (page.at(-1) ?? null)
        : null,
  };
}

async function managedWorktreePaths(root: string): Promise<string[]> {
  let groups;
  try {
    groups = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) return [];
    throw error;
  }
  const paths: string[] = [];
  for (const group of groups) {
    if (!group.isDirectory() || group.isSymbolicLink()) continue;
    const groupPath = join(root, group.name);
    const leaves = await readdir(groupPath, { withFileTypes: true });
    for (const leaf of leaves) {
      if (!leaf.isDirectory() || leaf.isSymbolicLink()) continue;
      paths.push(resolve(groupPath, leaf.name));
    }
  }
  return paths.sort((left, right) => left.localeCompare(right));
}

async function worktreeEntry(
  state: HostState,
  worktreePath: string,
  includeActivity: boolean,
): Promise<WorktreeHostEntryV15> {
  const [summary] = await summarizeWorktreeWorkspacePaths([worktreePath], {
    forceRefresh: false,
    environment: "include",
  });
  const owners = state.worktreeOwnersForPath(worktreePath);
  const [branch, statusOutput, pathStat] = await Promise.all([
    readGit(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]),
    readGit(worktreePath, ["status", "--porcelain", "-uall"]),
    lstat(worktreePath),
  ]);
  const normalizedBranch = branch === null || branch === "HEAD" ? null : branch;
  const registered =
    summary?.isGitRepo === true &&
    (
      await Promise.all(
        summary.worktrees.map(
          async (entry) =>
            entry.worktreePath !== null &&
            (await sameCanonicalPath(entry.worktreePath, worktreePath)),
        ),
      )
    ).some(Boolean);
  const activity = includeActivity
    ? await worktreeActivity(
        worktreePath,
        normalizedBranch,
        summary?.mainBranch ?? null,
        owners,
        pathStat.mtimeMs,
      )
    : null;
  return {
    worktreePath,
    repoLabel:
      summary?.repoIdentifier === null || summary?.repoIdentifier === undefined
        ? localRepoLabel(worktreePath)
        : `${summary.repoIdentifier.owner}/${summary.repoIdentifier.repo}`,
    repoIdentifier: summary?.repoIdentifier ?? null,
    branch: normalizedBranch,
    inUse: owners.length > 0 || state.isWorktreePathBusy(worktreePath),
    uncommittedCount: outputLines(statusOutput).length,
    gitRemovable: registered,
    scripts: summary?.scripts ?? null,
    lastActivityAt: activity?.lastActivityAt ?? null,
    owners,
    branchStatus: activity?.branchStatus ?? null,
    createdAt: Number.isFinite(pathStat.birthtimeMs)
      ? pathStat.birthtimeMs
      : null,
    prState: null,
    prNumber: null,
    prUrl: null,
    mergedHeadShaMatches: false,
    submodules: [],
    atBaseCommit: false,
    resolvedAt: summary?.resolvedAt ?? null,
    presence: "present",
  };
}

async function worktreeActivity(
  worktreePath: string,
  branch: string | null,
  mainBranch: string | null,
  owners: readonly WorktreeHostEntryOwner[],
  modifiedAt: number,
): Promise<{
  readonly lastActivityAt: number;
  readonly branchStatus: {
    readonly ahead: number | null;
    readonly behind: number | null;
    readonly mergedIntoDefault: boolean;
  } | null;
}> {
  const lastActivityAt = Math.max(
    modifiedAt,
    ...owners.map((owner) => owner.updatedAt),
  );
  if (branch === null || mainBranch === null) {
    return { lastActivityAt, branchStatus: null };
  }
  const [mergedIntoDefault, upstream] = await Promise.all([
    runGitBoolean(worktreePath, [
      "merge-base",
      "--is-ancestor",
      "HEAD",
      mainBranch,
    ]),
    readGit(worktreePath, [
      "rev-list",
      "--left-right",
      "--count",
      "@{upstream}...HEAD",
    ]),
  ]);
  const counts = upstream?.trim().split(/\s+/u).map(Number) ?? [];
  return {
    lastActivityAt,
    branchStatus: {
      behind:
        counts.length === 2 && Number.isFinite(counts[0]) ? counts[0] : null,
      ahead:
        counts.length === 2 && Number.isFinite(counts[1]) ? counts[1] : null,
      mergedIntoDefault,
    },
  };
}

function outputLines(output: string | null): string[] {
  return output === null || output.length === 0
    ? []
    : output.split(/\r?\n/u).filter((line) => line.length > 0);
}

function localRepoLabel(worktreePath: string): string {
  const group = basename(resolve(worktreePath, ".."));
  const match = /^local__(.+)__[a-f0-9]{10}$/u.exec(group);
  return match?.[1] ?? group;
}

function sameResolvedPath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

async function sameCanonicalPath(
  left: string,
  right: string,
): Promise<boolean> {
  try {
    return (await realpath(left)) === (await realpath(right));
  } catch {
    return sameResolvedPath(left, right);
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
