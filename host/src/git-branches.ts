import type {
  WorktreeBranch,
  WorktreeListBranchesRequest,
  WorktreeListBranchesResponse,
} from "@traycer/protocol/host/worktree-schemas";
import { gitRepositoryRoot, readGit } from "./git-read";

export async function listWorktreeBranches(
  request: WorktreeListBranchesRequest,
): Promise<WorktreeListBranchesResponse> {
  const root = await gitRepositoryRoot(request.workspacePath);
  if (root === null) {
    return { branches: [], uncommittedFileCount: 0 };
  }
  const [branches, uncommittedFileCount] = await Promise.all([
    readBranches(root, request.includeRemote),
    countUncommittedFiles(root),
  ]);
  return { branches, uncommittedFileCount };
}

async function readBranches(
  root: string,
  includeRemote: boolean,
): Promise<WorktreeBranch[]> {
  const [head, localOutput, remoteOutput] = await Promise.all([
    readGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    readGit(root, [
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname:short)",
      "refs/heads",
    ]),
    includeRemote
      ? readGit(root, [
          "for-each-ref",
          "--sort=-committerdate",
          "--format=%(refname:short)",
          "refs/remotes",
        ])
      : Promise.resolve(null),
  ]);
  const localNames = outputLines(localOutput);
  const localNameSet = new Set(localNames);
  const current = head === "HEAD" ? null : head;
  const seen = new Set<string>();
  const branches: WorktreeBranch[] = [];
  for (const name of localNames) {
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    branches.push({
      name,
      isCurrent: current !== null && current === name,
      isRemoteOnly: false,
    });
  }
  for (const fullRef of outputLines(remoteOutput)) {
    if (fullRef === "HEAD" || fullRef.endsWith("/HEAD")) {
      continue;
    }
    const shortName = remoteShortName(fullRef);
    if (
      shortName === null ||
      localNameSet.has(shortName) ||
      seen.has(fullRef)
    ) {
      continue;
    }
    seen.add(fullRef);
    branches.push({ name: fullRef, isCurrent: false, isRemoteOnly: true });
  }
  return branches;
}

async function countUncommittedFiles(root: string): Promise<number> {
  const output = await readGit(root, ["status", "--porcelain", "-uall"]);
  return output === null
    ? 0
    : output.split("\n").filter((line) => line.length > 0).length;
}

function outputLines(output: string | null): string[] {
  return output === null
    ? []
    : output
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

function remoteShortName(fullRef: string): string | null {
  const separator = fullRef.indexOf("/");
  return separator === -1 ? null : fullRef.slice(separator + 1);
}
