import { execFile } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const GIT_MUTATION_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

export type WorktreeDeletionErrorCode =
  | "BUSY"
  | "GIT_REMOVE_FAILED"
  | "INVALID_TARGET"
  | "OUTSIDE_MANAGED_ROOT"
  | "REPOSITORY_MISMATCH"
  | "REPOSITORY_ROOT"
  | "TARGET_CHANGED"
  | "UNREGISTERED_WORKTREE";

export class WorktreeDeletionError extends Error {
  readonly code: WorktreeDeletionErrorCode;

  constructor(code: WorktreeDeletionErrorCode, message: string) {
    super(message);
    this.name = "WorktreeDeletionError";
    this.code = code;
  }
}

export type WorktreeDeletionTarget = {
  readonly worktreePath: string;
  readonly repositoryRoot: string;
};

export type WorktreeDeletionRequest = {
  readonly worktreePath: string;
  /**
   * Unary callers can supply the already-resolved main repository root as an
   * extra ownership check. Path-keyed stream callers pass `null` and let Git
   * identify the repository from its common directory.
   */
  readonly expectedRepositoryRoot: string | null;
};

export type WorktreeDeletionEvent =
  | ({ readonly kind: "started" } & WorktreeDeletionTarget)
  | { readonly kind: "phase"; readonly phase: "remove" }
  | { readonly kind: "complete"; readonly deleted: true };

export type WorktreeDeletionCallbacks = {
  readonly isBusy: (
    target: WorktreeDeletionTarget,
  ) => boolean | Promise<boolean>;
  readonly reportEvent: (event: WorktreeDeletionEvent) => void | Promise<void>;
};

export type WorktreeDeletionResult = WorktreeDeletionTarget & {
  readonly deleted: true;
  readonly pruneWarning: string | null;
};

type GitResult =
  | { readonly ok: true; readonly stdout: string; readonly stderr: string }
  | { readonly ok: false; readonly stdout: string; readonly stderr: string };

type DirectoryIdentity = {
  readonly device: number;
  readonly inode: number;
};

type ResolvedWorktreeDeletionTarget = WorktreeDeletionTarget & {
  readonly identity: DirectoryIdentity;
};

/**
 * Removes only Git-registered worktrees whose canonical directory is beneath
 * the configured Traycer-managed root. It deliberately has no filesystem
 * deletion fallback: a path Git does not own is data this service will not
 * remove.
 */
export class WorktreeDeletionService {
  constructor(private readonly managedRoot: string) {}

  async delete(
    request: WorktreeDeletionRequest,
    callbacks: WorktreeDeletionCallbacks,
  ): Promise<WorktreeDeletionResult> {
    const resolvedTarget = await this.resolveTarget(request);
    const target: WorktreeDeletionTarget = {
      worktreePath: resolvedTarget.worktreePath,
      repositoryRoot: resolvedTarget.repositoryRoot,
    };
    if (await callbacks.isBusy(target)) {
      throw new WorktreeDeletionError(
        "BUSY",
        `Worktree is in use and cannot be removed: ${target.worktreePath}`,
      );
    }

    await callbacks.reportEvent({ kind: "started", ...target });
    await callbacks.reportEvent({ kind: "phase", phase: "remove" });
    if (
      !(await directoryStillHasIdentity(
        target.worktreePath,
        resolvedTarget.identity,
      ))
    ) {
      throw new WorktreeDeletionError(
        "TARGET_CHANGED",
        `Worktree target changed after validation; refusing removal: ${target.worktreePath}`,
      );
    }
    const removal = await runGit(target.repositoryRoot, [
      "worktree",
      "remove",
      "--force",
      target.worktreePath,
    ]);
    if (!removal.ok) {
      throw new WorktreeDeletionError(
        "GIT_REMOVE_FAILED",
        gitFailureMessage("git worktree remove failed", target, removal),
      );
    }

    const prune = await runGit(target.repositoryRoot, ["worktree", "prune"]);
    const pruneWarning = prune.ok
      ? null
      : gitFailureMessage("git worktree prune failed", target, prune);
    await callbacks.reportEvent({ kind: "complete", deleted: true });
    return { deleted: true, ...target, pruneWarning };
  }

  private async resolveTarget(
    request: WorktreeDeletionRequest,
  ): Promise<ResolvedWorktreeDeletionTarget> {
    if (!isAbsolute(request.worktreePath)) {
      throw new WorktreeDeletionError(
        "INVALID_TARGET",
        `Worktree path must be absolute: ${request.worktreePath}`,
      );
    }
    const [managedRoot, worktreePath] = await Promise.all([
      canonicalDirectory(this.managedRoot, "managed worktree root", true),
      canonicalDirectory(request.worktreePath, "worktree target", false),
    ]);
    const managedRelativePath = relative(managedRoot, worktreePath);
    if (!isStrictDescendant(managedRelativePath)) {
      throw new WorktreeDeletionError(
        "OUTSIDE_MANAGED_ROOT",
        `Refusing to remove a path outside the managed worktree root: ${worktreePath}`,
      );
    }

    const rootResult = await runGit(worktreePath, [
      "rev-parse",
      "--show-toplevel",
    ]);
    if (!rootResult.ok || rootResult.stdout.trim().length === 0) {
      throw new WorktreeDeletionError(
        "UNREGISTERED_WORKTREE",
        `Path is not a registered Git worktree: ${worktreePath}`,
      );
    }
    const checkoutRoot = await realpath(resolve(rootResult.stdout.trim()));
    if (checkoutRoot !== worktreePath) {
      throw new WorktreeDeletionError(
        "UNREGISTERED_WORKTREE",
        `Path is not the root of a registered Git worktree: ${worktreePath}`,
      );
    }

    const commonDirectoryResult = await runGit(worktreePath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    if (
      !commonDirectoryResult.ok ||
      commonDirectoryResult.stdout.trim().length === 0
    ) {
      throw new WorktreeDeletionError(
        "UNREGISTERED_WORKTREE",
        `Cannot resolve the repository for worktree: ${worktreePath}`,
      );
    }
    const commonDirectory = await realpath(
      resolve(worktreePath, commonDirectoryResult.stdout.trim()),
    );
    const repositoryRoot = await realpath(dirname(commonDirectory));
    if (repositoryRoot === worktreePath) {
      throw new WorktreeDeletionError(
        "REPOSITORY_ROOT",
        `Refusing to remove the repository root as a worktree: ${worktreePath}`,
      );
    }
    if (request.expectedRepositoryRoot !== null) {
      const expectedRepositoryRoot = await canonicalDirectory(
        request.expectedRepositoryRoot,
        "expected repository root",
        true,
      );
      if (expectedRepositoryRoot !== repositoryRoot) {
        throw new WorktreeDeletionError(
          "REPOSITORY_MISMATCH",
          `Worktree belongs to ${repositoryRoot}, not ${expectedRepositoryRoot}: ${worktreePath}`,
        );
      }
    }

    const listResult = await runGit(repositoryRoot, [
      "worktree",
      "list",
      "--porcelain",
    ]);
    if (!listResult.ok) {
      throw new WorktreeDeletionError(
        "UNREGISTERED_WORKTREE",
        gitFailureMessage(
          "Cannot read the repository worktree registry",
          { worktreePath, repositoryRoot },
          listResult,
        ),
      );
    }
    const registered = await hasRegisteredPath(listResult.stdout, worktreePath);
    if (!registered) {
      throw new WorktreeDeletionError(
        "UNREGISTERED_WORKTREE",
        `Path is not registered by its Git repository: ${worktreePath}`,
      );
    }
    return {
      worktreePath,
      repositoryRoot,
      identity: await directoryIdentity(worktreePath),
    };
  }
}

async function canonicalDirectory(
  path: string,
  label: string,
  allowSymbolicLink: boolean,
): Promise<string> {
  try {
    const [linkMetadata, targetMetadata, canonicalPath] = await Promise.all([
      lstat(path),
      stat(path),
      realpath(path),
    ]);
    if (
      !targetMetadata.isDirectory() ||
      (!allowSymbolicLink && linkMetadata.isSymbolicLink())
    ) {
      throw new Error(`${label} is not a real directory`);
    }
    return canonicalPath;
  } catch (error) {
    if (error instanceof WorktreeDeletionError) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new WorktreeDeletionError(
      "INVALID_TARGET",
      `Cannot resolve ${label} ${path}: ${detail}`,
    );
  }
}

function isStrictDescendant(relativePath: string): boolean {
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

async function directoryIdentity(path: string): Promise<DirectoryIdentity> {
  const metadata = await lstat(path);
  return { device: metadata.dev, inode: metadata.ino };
}

async function directoryStillHasIdentity(
  path: string,
  identity: DirectoryIdentity,
): Promise<boolean> {
  try {
    const current = await directoryIdentity(path);
    return (
      current.device === identity.device && current.inode === identity.inode
    );
  } catch {
    return false;
  }
}

async function hasRegisteredPath(
  porcelain: string,
  expectedPath: string,
): Promise<boolean> {
  for (const line of porcelain.split(/\r?\n/u)) {
    if (!line.startsWith("worktree ")) {
      continue;
    }
    const listedPath = line.slice("worktree ".length);
    try {
      if ((await realpath(listedPath)) === expectedPath) {
        return true;
      }
    } catch {
      // Stale worktree registrations are not ownership of the requested path.
    }
  }
  return false;
}

function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolveResult) => {
    try {
      execFile(
        "git",
        ["-C", cwd, ...args],
        {
          cwd,
          encoding: "utf8",
          timeout: GIT_MUTATION_TIMEOUT_MS,
          maxBuffer: GIT_MAX_BUFFER_BYTES,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          resolveResult({
            ok: error === null,
            stdout,
            stderr,
          });
        },
      );
    } catch (error) {
      resolveResult({
        ok: false,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function gitFailureMessage(
  prefix: string,
  target: WorktreeDeletionTarget,
  result: GitResult,
): string {
  const detail =
    result.stderr.trim() || result.stdout.trim() || "unknown error";
  return `${prefix} for ${target.worktreePath} in ${target.repositoryRoot}: ${detail}`;
}
