import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import type {
  WorkspaceGitBranchMentionSuggestion,
  WorkspaceGitBranchMentionSuggestionsResponse,
  WorkspaceGitCommitMentionSuggestion,
  WorkspaceGitCommitMentionSuggestionsResponse,
  WorkspaceGitMentionSuggestionsRequest,
  WorkspaceGitRootMentionSuggestion,
  WorkspaceGitRootMentionSuggestionsResponse,
  WorkspacePathMentionSuggestionsRequest,
  WorkspaceWorktreeMentionSuggestion,
  WorkspaceWorktreeMentionSuggestionsResponse,
} from "@traycer/protocol/host/workspace/unary-schemas";
import { gitRepositoryRoot, readGit } from "./git-read";
import { summarizeWorktreeWorkspacePaths } from "./worktree-summary";

export async function mentionWorkspaceWorktrees(
  request: WorkspacePathMentionSuggestionsRequest,
): Promise<WorkspaceWorktreeMentionSuggestionsResponse> {
  const query = normalizedQuery(request.query);
  const entries: WorkspaceWorktreeMentionSuggestion[] = [];
  const seen = new Set<string>();
  for (const requestedRoot of request.roots) {
    const root = await canonicalGitRoot(requestedRoot);
    if (root === null) continue;
    const [summary] = await summarizeWorktreeWorkspacePaths([root], {
      forceRefresh: true,
      environment: "omit",
    });
    if (summary === undefined || !summary.isGitRepo) continue;
    for (const worktree of summary.worktrees) {
      const worktreePath = await canonicalPath(worktree.worktreePath);
      const label =
        worktree.branch ??
        (worktree.head === null
          ? basename(worktreePath)
          : `Detached ${worktree.head.slice(0, 7)}`);
      if (!matchesQuery(`${label} ${worktreePath}`, query)) continue;
      const id = `worktree:${root}:${worktreePath}`;
      if (seen.has(id)) continue;
      seen.add(id);
      entries.push({
        kind: "worktree",
        id,
        label,
        worktreePath,
        workspacePath: root,
        branch: worktree.branch,
        isMain: worktree.isMain,
        description: worktreePath,
      });
    }
  }
  entries.sort(
    (left, right) =>
      Number(left.isMain) - Number(right.isMain) ||
      left.label.localeCompare(right.label) ||
      left.worktreePath.localeCompare(right.worktreePath),
  );
  return { entries: entries.slice(0, request.limit) };
}

export async function mentionWorkspaceGitRoot(
  request: WorkspaceGitMentionSuggestionsRequest,
): Promise<WorkspaceGitRootMentionSuggestionsResponse> {
  const root = await canonicalGitRoot(request.workspacePath);
  if (root === null) return { entries: [] };
  const description = basename(root);
  const query = normalizedQuery(request.query);
  const [status, branch] = await Promise.all([
    readGit(root, ["status", "--porcelain", "-uall"]),
    readGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
  ]);
  const entries: WorkspaceGitRootMentionSuggestion[] = [];
  const uncommittedLabel = "Diff against uncommitted changes";
  if (
    status !== null &&
    matchesQuery(`${uncommittedLabel} ${description}`, query)
  ) {
    entries.push({
      kind: "git",
      id: `git:uncommitted:${root}`,
      label: uncommittedLabel,
      description,
      workspacePath: root,
      gitType: "against_uncommitted_changes",
      branchName: null,
      commitHash: null,
    });
  }
  if (branch !== null && branch !== "HEAD") {
    const entry = branchSuggestion(root, branch);
    if (matchesQuery(`${entry.label} ${branch}`, query)) entries.push(entry);
  }
  return { entries: entries.slice(0, request.limit) };
}

export async function mentionWorkspaceGitBranches(
  request: WorkspaceGitMentionSuggestionsRequest,
): Promise<WorkspaceGitBranchMentionSuggestionsResponse> {
  const root = await canonicalGitRoot(request.workspacePath);
  if (root === null) return { entries: [] };
  const output = await readGit(root, [
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname:short)",
    "refs/heads",
    "refs/remotes",
  ]);
  const query = normalizedQuery(request.query);
  const entries: WorkspaceGitBranchMentionSuggestion[] = [];
  const seen = new Set<string>();
  for (const rawName of outputLines(output)) {
    const name = rawName.endsWith("/HEAD") ? rawName.slice(0, -5) : rawName;
    if (seen.has(name)) continue;
    seen.add(name);
    const entry = branchSuggestion(root, name);
    if (!matchesQuery(`${entry.label} ${name}`, query)) continue;
    entries.push(entry);
    if (entries.length === request.limit) break;
  }
  return { entries };
}

export async function mentionWorkspaceGitCommits(
  request: WorkspaceGitMentionSuggestionsRequest,
): Promise<WorkspaceGitCommitMentionSuggestionsResponse> {
  const root = await canonicalGitRoot(request.workspacePath);
  if (root === null) return { entries: [] };
  const output = await readGit(root, [
    "log",
    "--all",
    "--max-count=500",
    "--date=short",
    "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ad%x1e",
  ]);
  const query = normalizedQuery(request.query);
  const entries: WorkspaceGitCommitMentionSuggestion[] = [];
  for (const record of (output ?? "").split("\x1e")) {
    const [commitHash, shortHash, subject, author, date] = record
      .trim()
      .split("\x1f");
    if (
      commitHash === undefined ||
      shortHash === undefined ||
      subject === undefined ||
      author === undefined ||
      date === undefined
    ) {
      continue;
    }
    const label = `${shortHash} ${subject}`;
    if (!matchesQuery(`${label} ${author}`, query)) continue;
    entries.push({
      kind: "git",
      id: `git:commit:${root}:${commitHash}`,
      label,
      description: `${author} - ${date} - ${basename(root)}`,
      workspacePath: root,
      gitType: "against_commit",
      branchName: null,
      commitHash,
    });
    if (entries.length === request.limit) break;
  }
  return { entries };
}

function branchSuggestion(
  root: string,
  branchName: string,
): WorkspaceGitBranchMentionSuggestion {
  return {
    kind: "git",
    id: `git:branch:${root}:${branchName}`,
    label: `Diff against branch '${branchName}'`,
    description: basename(root),
    workspacePath: root,
    gitType: "against_branch",
    branchName,
    commitHash: null,
  };
}

async function canonicalGitRoot(workspacePath: string): Promise<string | null> {
  const root = await gitRepositoryRoot(workspacePath);
  return root === null ? null : await canonicalPath(root);
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

function normalizedQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

function matchesQuery(value: string, query: string): boolean {
  return query.length === 0 || value.toLocaleLowerCase().includes(query);
}

function outputLines(output: string | null): string[] {
  return output === null
    ? []
    : output
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}
