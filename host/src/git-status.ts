import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type {
  GitChangedFileV10,
  GitFileStatus,
  GitListChangedFilesRequest,
  GitListChangedFilesResponse,
  GitStage,
  RepoState,
} from "@traycer/protocol/host/git-schemas";

type StatusEntry = {
  readonly path: string;
  readonly previousPath: string | null;
  readonly status: GitFileStatus;
  readonly stage: GitStage;
};

export function listGitChangedFiles(
  request: GitListChangedFilesRequest,
): GitListChangedFilesResponse {
  const runningDir = canonicalGitRoot(request.runningDir);
  const statusOutput = runGit(runningDir, [
    "status",
    "--porcelain=v2",
    "--branch",
    "-z",
    "--untracked-files=all",
  ]);
  const records = statusOutput.split("\0").filter((record) => record !== "");
  const headSha = branchHeader(records, "# branch.oid ") ?? "";
  const headName = branchHeader(records, "# branch.head ");
  const branch =
    headName === null || headName === "(detached)" ? null : headName;
  const files = parseStatusEntries(records)
    .map((entry) => materializeFile(runningDir, entry))
    .sort(compareChangedFiles);
  const repoState = readRepoState(runningDir, branch);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ runningDir, headSha, branch, files, repoState }))
    .digest("hex");
  return {
    runningDir,
    headSha,
    branch,
    files,
    fingerprint,
    repoMode: "normal",
    repoState,
  };
}

function parseStatusEntries(records: readonly string[]): StatusEntry[] {
  const entries: StatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.startsWith("# ")) continue;
    if (record.startsWith("? ")) {
      entries.push({
        path: record.slice(2),
        previousPath: null,
        status: "untracked",
        stage: "untracked",
      });
      continue;
    }
    if (record.startsWith("u ")) {
      const match = record.match(
        /^u ([^ ]+) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.*)$/u,
      );
      if (match === null)
        throw new Error(`Unsupported Git status row: ${record}`);
      entries.push({
        path: match[2] ?? "",
        previousPath: null,
        status: "conflicted",
        stage: "conflicted",
      });
      continue;
    }
    const ordinary = record.match(
      /^1 ([^ ]+) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.*)$/u,
    );
    if (ordinary !== null) {
      pushOrdinaryEntries(
        entries,
        ordinary[1] ?? "..",
        ordinary[2] ?? "",
        null,
      );
      continue;
    }
    const renamed = record.match(
      /^2 ([^ ]+) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.*)$/u,
    );
    if (renamed !== null) {
      const previousPath = records[index + 1];
      if (previousPath === undefined) {
        throw new Error(`Git rename row has no previous path: ${record}`);
      }
      index += 1;
      pushOrdinaryEntries(
        entries,
        renamed[1] ?? "..",
        renamed[2] ?? "",
        previousPath,
      );
      continue;
    }
    throw new Error(`Unsupported Git status row: ${record}`);
  }
  return entries;
}

function pushOrdinaryEntries(
  entries: StatusEntry[],
  xy: string,
  path: string,
  previousPath: string | null,
): void {
  const indexStatus = xy[0] ?? ".";
  const worktreeStatus = xy[1] ?? ".";
  if (indexStatus !== ".") {
    entries.push({
      path,
      previousPath,
      status: statusFromCode(indexStatus),
      stage: "staged",
    });
  }
  if (worktreeStatus !== ".") {
    entries.push({
      path,
      previousPath,
      status: statusFromCode(worktreeStatus),
      stage: "unstaged",
    });
  }
}

function statusFromCode(code: string): GitFileStatus {
  switch (code) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "U":
      return "conflicted";
    default:
      return "modified";
  }
}

function materializeFile(
  runningDir: string,
  entry: StatusEntry,
): GitChangedFileV10 {
  const absolutePath = join(runningDir, entry.path);
  const content = readableFile(absolutePath);
  const stats =
    entry.stage === "untracked"
      ? untrackedStats(content)
      : diffStats(runningDir, entry.path, entry.stage === "staged");
  return {
    ...entry,
    isBinary: stats.isBinary,
    insertions: stats.insertions,
    deletions: stats.deletions,
    sizeBytes: content?.byteLength ?? 0,
    stagedOid: gitIndexOid(runningDir, entry.path),
    worktreeOid:
      content === null ? null : gitWorktreeOid(runningDir, entry.path),
  };
}

function diffStats(
  runningDir: string,
  path: string,
  staged: boolean,
): {
  readonly isBinary: boolean;
  readonly insertions: number;
  readonly deletions: number;
} {
  const output = runGit(runningDir, [
    "diff",
    ...(staged ? ["--cached"] : []),
    "--numstat",
    "--",
    path,
  ]).trim();
  if (output.length === 0) {
    return { isBinary: false, insertions: 0, deletions: 0 };
  }
  const [insertions = "0", deletions = "0"] = output.split("\t");
  const isBinary = insertions === "-" || deletions === "-";
  return {
    isBinary,
    insertions: isBinary ? 0 : Number.parseInt(insertions, 10),
    deletions: isBinary ? 0 : Number.parseInt(deletions, 10),
  };
}

function untrackedStats(content: Buffer | null): {
  readonly isBinary: boolean;
  readonly insertions: number;
  readonly deletions: number;
} {
  if (content === null) return { isBinary: false, insertions: 0, deletions: 0 };
  const isBinary = content.includes(0);
  if (isBinary) return { isBinary: true, insertions: 0, deletions: 0 };
  let insertions = 0;
  for (const byte of content) if (byte === 10) insertions += 1;
  if (content.length > 0 && content[content.length - 1] !== 10) insertions += 1;
  return { isBinary: false, insertions, deletions: 0 };
}

export function canonicalGitRoot(runningDir: string): string {
  return realpathSync(
    runGit(runningDir, ["rev-parse", "--show-toplevel"]).trim(),
  );
}

export function gitHeadSha(runningDir: string): string {
  return optionalGit(runningDir, ["rev-parse", "--verify", "HEAD"]) ?? "";
}

export function gitIndexOid(runningDir: string, path: string): string | null {
  return optionalGit(runningDir, ["rev-parse", "--verify", `:${path}`]);
}

export function gitWorktreeOid(
  runningDir: string,
  path: string,
): string | null {
  return optionalGit(runningDir, ["hash-object", "--", path]);
}

function readableFile(path: string): Buffer | null {
  try {
    return lstatSync(path).isFile() ? readFileSync(path) : null;
  } catch {
    return null;
  }
}

function readRepoState(runningDir: string, branch: string | null): RepoState {
  const gitDir = runGit(runningDir, ["rev-parse", "--absolute-git-dir"]).trim();
  const mergeHead = join(gitDir, "MERGE_HEAD");
  if (existsSync(mergeHead)) {
    return {
      kind: "merge",
      headRef: branch ?? "HEAD",
      mergeHeads: readFileSync(mergeHead, "utf8")
        .split(/\r?\n/u)
        .filter((sha) => sha.length > 0),
    };
  }
  const cherryPickHead = readStateSha(gitDir, "CHERRY_PICK_HEAD");
  if (cherryPickHead !== null) {
    return { kind: "cherry-pick", pickingSha: cherryPickHead };
  }
  const revertHead = readStateSha(gitDir, "REVERT_HEAD");
  if (revertHead !== null) return { kind: "revert", revertingSha: revertHead };
  if (existsSync(join(gitDir, "BISECT_LOG"))) {
    return { kind: "bisect", goodSha: null, badSha: null };
  }
  return { kind: "clean" };
}

function readStateSha(gitDir: string, name: string): string | null {
  const path = join(gitDir, name);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : null;
}

function branchHeader(
  records: readonly string[],
  prefix: string,
): string | null {
  const record = records.find((candidate) => candidate.startsWith(prefix));
  return record === undefined ? null : record.slice(prefix.length);
}

function optionalGit(cwd: string, args: readonly string[]): string | null {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function runGit(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function compareChangedFiles(
  left: GitChangedFileV10,
  right: GitChangedFileV10,
): number {
  const pathOrder = left.path.localeCompare(right.path);
  if (pathOrder !== 0) return pathOrder;
  const stages: readonly GitStage[] = [
    "staged",
    "unstaged",
    "untracked",
    "conflicted",
  ];
  return stages.indexOf(left.stage) - stages.indexOf(right.stage);
}
