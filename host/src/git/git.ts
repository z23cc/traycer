import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { TaskRepoIdentifier } from "@traycer/protocol/host/epic/unary-schemas";
import type {
  GitFileStatus,
  GitStage,
  RepoState,
} from "@traycer/protocol/host/git-schemas";

export type GitIdentity = {
  readonly version: string | null;
  readonly available: boolean;
};

export type GitRepoFacts = {
  readonly toplevel: string;
  readonly headSha: string;
  readonly branch: string | null;
  readonly remoteUrl: string | null;
  readonly repoIdentifier: TaskRepoIdentifier | null;
};

export type GitRun = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

export type HostGitChangedFile = {
  readonly path: string;
  readonly previousPath: string | null;
  readonly status: GitFileStatus;
  readonly stage: GitStage;
  readonly isBinary: boolean;
  readonly insertions: number;
  readonly deletions: number;
  readonly sizeBytes: number;
  readonly stagedOid: string | null;
  readonly worktreeOid: string | null;
  readonly gitlink: null;
};

export type GitStatusSnapshot = {
  readonly runningDir: string;
  readonly headSha: string;
  readonly branch: string | null;
  readonly files: readonly HostGitChangedFile[];
  readonly fingerprint: string;
  readonly repoMode: "normal";
  readonly repoState: RepoState;
};

export type DiskWorktree = {
  readonly worktreePath: string;
  readonly branch: string | null;
  readonly sourceBranch: null;
  readonly head: string | null;
  readonly isMain: boolean;
  readonly isLocked: boolean;
};

export type GitBranchRow = {
  readonly name: string;
  readonly isCurrent: boolean;
  readonly isRemoteOnly: boolean;
};

export type FileDiffResult = {
  readonly filePath: string;
  readonly headSha: string;
  readonly stagedOid: string | null;
  readonly worktreeOid: string | null;
  readonly patch: string;
  readonly isTruncated: boolean;
  readonly truncatedAfterBytes: number | null;
  readonly isBinary: boolean;
};

const GIT_READ_TIMEOUT_MS = 8_000;
const GIT_MUTATE_TIMEOUT_MS = 30_000;

export function detectGit(): GitIdentity {
  const result = runGit(["--version"], process.cwd());
  if (result === null) {
    return { version: null, available: false };
  }
  const match = /git version ([^\s]+)/u.exec(result);
  return {
    available: true,
    version: match === null ? result.trim() : match[1],
  };
}

export function inspectRepo(runningDir: string): GitRepoFacts | null {
  if (!isAbsolute(runningDir)) {
    return null;
  }
  const toplevel = runGit(["rev-parse", "--show-toplevel"], runningDir);
  if (toplevel === null) {
    return null;
  }
  const headSha = runGit(["rev-parse", "HEAD"], toplevel);
  if (headSha === null) {
    return null;
  }
  const branch = runGit(["branch", "--show-current"], toplevel);
  const remoteUrl = runGit(["remote", "get-url", "origin"], toplevel);
  return {
    toplevel,
    headSha,
    branch: branch === null || branch.length === 0 ? null : branch,
    remoteUrl,
    repoIdentifier: remoteUrl === null ? null : parseGitRemote(remoteUrl),
  };
}

export function parseGitRemote(url: string): TaskRepoIdentifier | null {
  const trimmed = url.trim().replace(/\.git$/u, "");
  const ssh = /^git@[^:]+:([^/]+)\/([^/]+)$/u.exec(trimmed);
  if (ssh !== null) {
    return { owner: ssh[1], repo: ssh[2] };
  }
  try {
    const parsed = new URL(trimmed);
    const parts = parsed.pathname.replace(/^\/+/u, "").split("/");
    if (parts.length >= 2 && parts[0].length > 0 && parts[1].length > 0) {
      return { owner: parts[0], repo: parts[1] };
    }
  } catch {
    return null;
  }
  return null;
}

export function runGit(args: readonly string[], cwd: string): string | null {
  const result = runGitDetailed(args, cwd, GIT_READ_TIMEOUT_MS);
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim();
}

export function runGitMutating(args: readonly string[], cwd: string): GitRun {
  return runGitDetailed(args, cwd, GIT_MUTATE_TIMEOUT_MS);
}

export function runGitDetailed(
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): GitRun {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

export function statusSnapshot(runningDir: string): GitStatusSnapshot | null {
  const facts = inspectRepo(runningDir);
  if (facts === null) {
    return null;
  }
  const porcelain = runGit(["status", "--porcelain=v1", "-uall"], facts.toplevel);
  const files = parsePorcelain(porcelain ?? "");
  const fingerprint = `${facts.headSha}\n${porcelain ?? ""}`;
  return {
    runningDir: facts.toplevel,
    headSha: facts.headSha,
    branch: facts.branch,
    files,
    fingerprint: hashFingerprint(fingerprint),
    repoMode: "normal",
    repoState: detectRepoState(facts.toplevel),
  };
}

export function uncommittedCount(runningDir: string): number {
  const porcelain = runGit(["status", "--porcelain=v1", "-uall"], runningDir);
  if (porcelain === null || porcelain.length === 0) {
    return 0;
  }
  return porcelain.split("\n").filter((line) => line.trim().length > 0).length;
}

export function listBranches(
  workspacePath: string,
  includeRemote: boolean,
): { readonly branches: readonly GitBranchRow[]; readonly uncommittedFileCount: number } {
  const facts = inspectRepo(workspacePath);
  if (facts === null) {
    return { branches: [], uncommittedFileCount: 0 };
  }
  const args = includeRemote
    ? ["branch", "-a", "--format=%(refname:short)\t%(HEAD)"]
    : ["branch", "--format=%(refname:short)\t%(HEAD)"];
  const raw = runGit(args, facts.toplevel) ?? "";
  const branches: GitBranchRow[] = [];
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    const [name, head] = line.split("\t");
    if (name === undefined || name.length === 0) {
      continue;
    }
    const normalized = name.replace(/^remotes\//u, "");
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    branches.push({
      name: normalized,
      isCurrent: head === "*",
      isRemoteOnly: name.startsWith("remotes/") || name.startsWith("origin/"),
    });
  }
  return {
    branches,
    uncommittedFileCount: uncommittedCount(facts.toplevel),
  };
}

export function listDiskWorktrees(workspacePath: string): DiskWorktree[] {
  const facts = inspectRepo(workspacePath);
  if (facts === null) {
    return [];
  }
  const raw = runGit(["worktree", "list", "--porcelain"], facts.toplevel);
  if (raw === null || raw.length === 0) {
    return [];
  }
  const entries: DiskWorktree[] = [];
  let current: {
    worktreePath: string | null;
    branch: string | null;
    head: string | null;
    isLocked: boolean;
  } = {
    worktreePath: null,
    branch: null,
    head: null,
    isLocked: false,
  };
  const flush = (): void => {
    if (current.worktreePath === null) {
      return;
    }
    entries.push({
      worktreePath: current.worktreePath,
      branch: current.branch,
      sourceBranch: null,
      head: current.head,
      isMain: entries.length === 0,
      isLocked: current.isLocked,
    });
    current = {
      worktreePath: null,
      branch: null,
      head: null,
      isLocked: false,
    };
  };
  for (const line of raw.split("\n")) {
    if (line.length === 0) {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      current.worktreePath = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//u, "");
    } else if (line === "detached") {
      current.branch = null;
    } else if (line.startsWith("locked")) {
      current.isLocked = true;
    }
  }
  flush();
  return entries;
}

export function resolveDefaultBranch(toplevel: string): string | null {
  const originHead = runGit(
    ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    toplevel,
  );
  if (originHead !== null && originHead.length > 0) {
    return originHead.replace(/^refs\/remotes\/origin\//u, "");
  }
  if (runGit(["rev-parse", "--verify", "refs/heads/main"], toplevel) !== null) {
    return "main";
  }
  if (runGit(["rev-parse", "--verify", "refs/heads/master"], toplevel) !== null) {
    return "master";
  }
  return runGit(["branch", "--show-current"], toplevel);
}

export function branchStatus(
  toplevel: string,
  branch: string | null,
): {
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly mergedIntoDefault: boolean;
} | null {
  if (branch === null) {
    return null;
  }
  const defaultBranch = resolveDefaultBranch(toplevel);
  if (defaultBranch === null) {
    return null;
  }
  const ancestor = runGitDetailed(
    ["merge-base", "--is-ancestor", "HEAD", defaultBranch],
    toplevel,
    GIT_READ_TIMEOUT_MS,
  );
  const aheadRaw = runGit(["rev-list", "--count", "@{upstream}..HEAD"], toplevel);
  const behindRaw = runGit(["rev-list", "--count", "HEAD..@{upstream}"], toplevel);
  return {
    ahead: aheadRaw === null ? null : Number.parseInt(aheadRaw, 10),
    behind: behindRaw === null ? null : Number.parseInt(behindRaw, 10),
    mergedIntoDefault: ancestor.status === 0,
  };
}

export function getFileDiff(input: {
  readonly runningDir: string;
  readonly filePath: string;
  readonly previousPath: string | null;
  readonly stage: GitStage;
  readonly ignoreWhitespace: boolean;
  readonly byteBudget: number | null;
}): FileDiffResult | null {
  const facts = inspectRepo(input.runningDir);
  if (facts === null) {
    return null;
  }
  const args = ["diff", "--no-color", "--patch"];
  if (input.ignoreWhitespace) {
    args.push("-w");
  }
  if (input.stage === "staged") {
    args.push("--cached");
  }
  if (input.stage === "untracked") {
    args.push("--no-index", "--", "/dev/null", input.filePath);
  } else if (input.previousPath !== null) {
    args.push("--", input.previousPath, input.filePath);
  } else {
    args.push("--", input.filePath);
  }
  const result = runGitDetailed(args, facts.toplevel, GIT_READ_TIMEOUT_MS);
  const patch = result.stdout;
  const isBinary = /Binary files |GIT binary patch/u.test(patch);
  const budget = input.byteBudget;
  if (budget !== null && Buffer.byteLength(patch, "utf8") > budget) {
    const truncated = Buffer.from(patch, "utf8").subarray(0, budget).toString("utf8");
    return {
      filePath: input.filePath,
      headSha: facts.headSha,
      stagedOid: null,
      worktreeOid: null,
      patch: truncated,
      isTruncated: true,
      truncatedAfterBytes: budget,
      isBinary,
    };
  }
  return {
    filePath: input.filePath,
    headSha: facts.headSha,
    stagedOid: null,
    worktreeOid: null,
    patch,
    isTruncated: false,
    truncatedAfterBytes: null,
    isBinary,
  };
}

export function listManagedWorktreeDirs(dataDir: string): string[] {
  const root = join(dataDir, "worktrees");
  if (!existsSync(root)) {
    return [];
  }
  const found: string[] = [];
  walkManaged(root, 0, found);
  return found;
}

export function listRecentCommits(
  workspacePath: string,
  query: string,
  limit: number,
): readonly { readonly hash: string; readonly subject: string }[] {
  const facts = inspectRepo(workspacePath);
  if (facts === null) {
    return [];
  }
  const raw = runGit(["log", "-n", "50", "--format=%H\t%s"], facts.toplevel);
  if (raw === null || raw.length === 0) {
    return [];
  }
  const needle = query.toLowerCase();
  const rows = [];
  for (const line of raw.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) {
      continue;
    }
    const hash = line.slice(0, tab);
    const subject = line.slice(tab + 1);
    if (
      needle.length > 0 &&
      !hash.toLowerCase().includes(needle) &&
      !subject.toLowerCase().includes(needle)
    ) {
      continue;
    }
    rows.push({ hash, subject });
    if (rows.length >= limit) {
      break;
    }
  }
  return rows;
}

function walkManaged(dir: string, depth: number, found: string[]): void {
  if (depth > 4) {
    return;
  }
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === ".git") {
      continue;
    }
    const absolute = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(absolute).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) {
      continue;
    }
    if (existsSync(join(absolute, ".git"))) {
      found.push(absolute);
      continue;
    }
    walkManaged(absolute, depth + 1, found);
  }
}

function detectRepoState(toplevel: string): RepoState {
  const gitDir = runGit(["rev-parse", "--git-dir"], toplevel) ?? join(toplevel, ".git");
  const dir = isAbsolute(gitDir) ? gitDir : join(toplevel, gitDir);
  if (existsSync(join(dir, "MERGE_HEAD"))) {
    return { kind: "merge", headRef: "HEAD", mergeHeads: [] };
  }
  if (existsSync(join(dir, "rebase-merge")) || existsSync(join(dir, "rebase-apply"))) {
    return {
      kind: "rebase",
      ontoSha: "",
      originalBranch: null,
      step: null,
      totalSteps: null,
    };
  }
  if (existsSync(join(dir, "CHERRY_PICK_HEAD"))) {
    return { kind: "cherry-pick", pickingSha: "" };
  }
  if (existsSync(join(dir, "REVERT_HEAD"))) {
    return { kind: "revert", revertingSha: "" };
  }
  if (existsSync(join(dir, "BISECT_LOG"))) {
    return { kind: "bisect", goodSha: null, badSha: null };
  }
  return { kind: "clean" };
}

function parsePorcelain(output: string): readonly HostGitChangedFile[] {
  if (output.length === 0) {
    return [];
  }
  const files: HostGitChangedFile[] = [];
  for (const line of output.split("\n")) {
    if (line.length < 3) {
      continue;
    }
    const code = line.slice(0, 2);
    const rest = line.slice(2).replace(/^ /u, "");
    if (rest.length === 0) {
      continue;
    }
    const renamed = rest.includes(" -> ");
    const path = unquoteGitPath(
      renamed ? rest.slice(rest.lastIndexOf(" -> ") + 4) : rest,
    );
    const previousPath = renamed
      ? unquoteGitPath(rest.slice(0, rest.lastIndexOf(" -> ")))
      : null;
    files.push({
      path,
      previousPath,
      status: statusFromCode(code),
      stage: stageFromCode(code),
      isBinary: false,
      insertions: 0,
      deletions: 0,
      sizeBytes: 0,
      stagedOid: null,
      worktreeOid: null,
      gitlink: null,
    });
  }
  return files;
}

function unquoteGitPath(path: string): string {
  if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
    return path.slice(1, -1);
  }
  return path;
}

function statusFromCode(code: string): GitFileStatus {
  if (code === "??") {
    return "untracked";
  }
  if (code.includes("U") || code === "AA" || code === "DD") {
    return "conflicted";
  }
  if (code.includes("R")) {
    return "renamed";
  }
  if (code.includes("C")) {
    return "copied";
  }
  if (code.includes("A")) {
    return "added";
  }
  if (code.includes("D")) {
    return "deleted";
  }
  return "modified";
}

function stageFromCode(code: string): GitStage {
  if (code === "??") {
    return "untracked";
  }
  if (code.includes("U") || code === "AA" || code === "DD") {
    return "conflicted";
  }
  if (code[0] !== " " && code[0] !== "?") {
    return "staged";
  }
  return "unstaged";
}

function hashFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
