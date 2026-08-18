import { isAbsolute, normalize, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { TextDecoder } from "node:util";
import type {
  GitGetFileDiffRequest,
  GitGetFileDiffResponse,
  GitGetFileDiffsRequest,
  GitGetFileDiffsResponse,
  GitStage,
} from "@traycer/protocol/host/git-schemas";
import {
  canonicalGitRoot,
  gitHeadSha,
  gitIndexOid,
  gitWorktreeOid,
} from "./git-status";

type DiffFileRequest = {
  readonly filePath: string;
  readonly previousPath: string | null;
  readonly stage: GitStage;
};

export function getGitFileDiff(
  request: GitGetFileDiffRequest,
): GitGetFileDiffResponse {
  const runningDir = canonicalGitRoot(request.runningDir);
  return readFileDiff(
    runningDir,
    gitHeadSha(runningDir),
    request,
    request.ignoreWhitespace,
    request.byteBudget,
  );
}

export function getGitFileDiffs(
  request: GitGetFileDiffsRequest,
): GitGetFileDiffsResponse {
  const runningDir = canonicalGitRoot(request.runningDir);
  const headSha = gitHeadSha(runningDir);
  let remainingBytes = request.byteBudget;
  const diffs = request.files.map((file) => {
    const diff = readFileDiff(
      runningDir,
      headSha,
      file,
      request.ignoreWhitespace,
      remainingBytes,
    );
    remainingBytes = Math.max(
      0,
      remainingBytes - Buffer.byteLength(diff.patch),
    );
    return diff;
  });
  return { runningDir, headSha, diffs };
}

function readFileDiff(
  runningDir: string,
  headSha: string,
  file: DiffFileRequest,
  ignoreWhitespace: boolean,
  byteBudget: number | null,
): GitGetFileDiffResponse {
  validateGitPath(file.filePath);
  if (file.previousPath !== null) validateGitPath(file.previousPath);
  const patchBytes = diffBytes(runningDir, file, ignoreWhitespace);
  const truncated = truncateUtf8(patchBytes, byteBudget);
  return {
    filePath: file.filePath,
    headSha,
    stagedOid: gitIndexOid(runningDir, file.filePath),
    worktreeOid: gitWorktreeOid(runningDir, file.filePath),
    patch: truncated.text,
    isTruncated: truncated.isTruncated,
    truncatedAfterBytes: truncated.isTruncated ? truncated.byteLength : null,
    isBinary:
      patchBytes.includes(Buffer.from("Binary files ")) ||
      patchBytes.includes(Buffer.from("GIT binary patch")),
  };
}

function diffBytes(
  runningDir: string,
  file: DiffFileRequest,
  ignoreWhitespace: boolean,
): Buffer {
  const whitespaceArgs = ignoreWhitespace ? ["--ignore-all-space"] : [];
  if (file.stage === "untracked") {
    return runGitDiff(
      runningDir,
      [
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-color",
        ...whitespaceArgs,
        "--",
        "/dev/null",
        file.filePath,
      ],
      [0, 1],
    );
  }
  const paths =
    file.previousPath === null || file.previousPath === file.filePath
      ? [file.filePath]
      : [file.previousPath, file.filePath];
  return runGitDiff(
    runningDir,
    [
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--full-index",
      ...(file.stage === "staged" ? ["--cached"] : []),
      ...whitespaceArgs,
      "--",
      ...paths,
    ],
    [0],
  );
}

function runGitDiff(
  cwd: string,
  args: readonly string[],
  acceptedStatuses: readonly number[],
): Buffer {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "buffer",
    timeout: 15_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!acceptedStatuses.includes(result.status ?? -1)) {
    throw new Error(
      result.stderr.toString("utf8").trim() || `git ${args.join(" ")} failed`,
    );
  }
  return result.stdout;
}

function truncateUtf8(
  bytes: Buffer,
  byteBudget: number | null,
): {
  readonly text: string;
  readonly isTruncated: boolean;
  readonly byteLength: number;
} {
  if (byteBudget === null || bytes.byteLength <= byteBudget) {
    return {
      text: bytes.toString("utf8"),
      isTruncated: false,
      byteLength: bytes.byteLength,
    };
  }
  let length = byteBudget;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (length > 0) {
    try {
      return {
        text: decoder.decode(bytes.subarray(0, length)),
        isTruncated: true,
        byteLength: length,
      };
    } catch {
      length -= 1;
    }
  }
  return { text: "", isTruncated: true, byteLength: 0 };
}

function validateGitPath(path: string): void {
  const normalized = normalize(path);
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    normalized === ".." ||
    normalized.startsWith(`..${sep}`)
  ) {
    throw new Error(`Git file path must be repository-relative: ${path}`);
  }
}
