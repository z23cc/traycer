import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { TaskRepoIdentifier } from "@traycer/protocol/host/epic/unary-schemas";
import type {
  WorktreeBindingEntry,
  WorktreeEntryScripts,
  WorktreeFolderIntent,
  WorktreePerEntryResult,
  WorkspaceScripts,
} from "@traycer/protocol/host/worktree-schemas";
import { gitRepositoryRoot, readGit, runGitBoolean } from "./git-read";
import {
  parseWorktreeRepoIdentifier,
  readWorktreeScriptsAtRefs,
} from "./worktree-summary";

const GIT_MUTATION_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const RANDOM_BRANCH_ATTEMPTS = 16;
const repositoryMutationTails = new Map<string, Promise<void>>();
const managedGroupMutationTails = new Map<string, Promise<void>>();

export type ManagedWorktreeIntent = Extract<
  WorktreeFolderIntent,
  { readonly kind: "worktree" }
>;

export type WorktreeMaterialization = {
  readonly entry: WorktreeBindingEntry | null;
  readonly result: WorktreePerEntryResult;
};

type RepoIdentifierPolicy =
  | { readonly kind: "derive" }
  | {
      readonly kind: "resolved";
      readonly value: TaskRepoIdentifier | null;
    };

type MaterializationPolicy = {
  readonly setup: "require-empty" | "ignore";
  readonly repoIdentifier: RepoIdentifierPolicy;
};

export async function materializeManagedWorktree(
  intent: ManagedWorktreeIntent,
  worktreeRoot: string,
  now: () => number,
): Promise<WorktreeMaterialization> {
  return materializeManagedWorktreeWithPolicy(intent, worktreeRoot, now, {
    setup: "require-empty",
    repoIdentifier: { kind: "derive" },
  });
}

export async function materializeOwnerlessWorktree(
  intent: ManagedWorktreeIntent,
  worktreeRoot: string,
  now: () => number,
  repoIdentifier: TaskRepoIdentifier | null,
): Promise<WorktreeMaterialization> {
  return materializeManagedWorktreeWithPolicy(intent, worktreeRoot, now, {
    setup: "ignore",
    repoIdentifier: { kind: "resolved", value: repoIdentifier },
  });
}

async function materializeManagedWorktreeWithPolicy(
  intent: ManagedWorktreeIntent,
  worktreeRoot: string,
  now: () => number,
  policy: MaterializationPolicy,
): Promise<WorktreeMaterialization> {
  const branch = intent.branch.name;
  const root = await gitRepositoryRoot(intent.workspacePath);
  if (root === null) {
    return failed(
      intent.workspacePath,
      branch,
      `Workspace is not a git repository: ${intent.workspacePath}`,
    );
  }

  const repositoryKey = await repositoryMutationKey(root);
  return withSerializedRepositoryMutation(repositoryKey, () => {
    const branch = intent.branch;
    if (branch.type === "new" && branch.collision === "random") {
      return materializeRandomManagedWorktreeInRepository(
        { ...intent, branch },
        root,
        worktreeRoot,
        now,
        policy,
      );
    }
    return materializeManagedWorktreeInRepository(
      intent,
      root,
      worktreeRoot,
      now,
      policy,
    );
  });
}

type RandomManagedWorktreeIntent = ManagedWorktreeIntent & {
  readonly branch: Extract<
    ManagedWorktreeIntent["branch"],
    { readonly type: "new"; readonly collision: "random" }
  >;
};

async function materializeRandomManagedWorktreeInRepository(
  intent: RandomManagedWorktreeIntent,
  root: string,
  worktreeRoot: string,
  now: () => number,
  policy: MaterializationPolicy,
): Promise<WorktreeMaterialization> {
  await runGitBoolean(root, ["worktree", "prune"]);
  const repoIdentifier = await repoIdentifierForMaterialization(
    intent,
    root,
    policy.repoIdentifier,
  );
  const managedGroup = await managedWorktreeGroupPath(
    worktreeRoot,
    root,
    repoIdentifier,
  );
  const pathIdentityHash = retryIdentityHash(
    "path",
    intent.branch.retryIdentity,
    null,
  ).slice(0, 16);

  return withSerializedManagedGroupMutation(managedGroup.lockKey, async () => {
    await ensureManagedWorktreeGroup(managedGroup);

    // A retry identity owns only the deterministic path/branch pair derived
    // from that identity. Replays may adopt that completed checkout, but never
    // a same-named ref or checkout created elsewhere.
    for (let attempt = 0; attempt < RANDOM_BRANCH_ATTEMPTS; attempt += 1) {
      const branch = randomBranchCandidate(
        intent.branch.name,
        intent.branch.retryIdentity,
        attempt,
      );
      const worktreePath = randomManagedWorktreePath(
        managedGroup,
        branch,
        pathIdentityHash,
      );
      const replayCreatedAt = await completedRandomCheckoutCreatedAt(
        root,
        managedGroup,
        branch,
        worktreePath,
      );
      if (replayCreatedAt !== null) {
        return successfulMaterialization(
          intent,
          repoIdentifier,
          worktreePath,
          branch,
          replayCreatedAt,
        );
      }
    }

    const setupCommand =
      policy.setup === "require-empty"
        ? await resolvedSetupCommand(intent, root, intent.branch.source)
        : null;
    if (policy.setup === "require-empty" && setupCommand !== null) {
      return failed(
        intent.workspacePath,
        intent.branch.name,
        "Worktree setup commands are not supported by this local host yet.",
      );
    }
    const sourceCommit = await readGit(root, [
      "rev-parse",
      "--verify",
      `${intent.branch.source}^{commit}`,
    ]);
    if (sourceCommit === null) {
      return failed(
        intent.workspacePath,
        intent.branch.name,
        `Could not resolve source branch ${intent.branch.source}.`,
      );
    }
    const carry = intent.branch.carryUncommittedChanges
      ? await captureCarryState(root, intent.branch.source)
      : null;

    for (let attempt = 0; attempt < RANDOM_BRANCH_ATTEMPTS; attempt += 1) {
      const branch = randomBranchCandidate(
        intent.branch.name,
        intent.branch.retryIdentity,
        attempt,
      );
      const worktreePath = randomManagedWorktreePath(
        managedGroup,
        branch,
        pathIdentityHash,
      );
      const reservation = await reserveManagedWorktreePath(
        managedGroup,
        worktreePath,
      );
      if (reservation === null) {
        continue;
      }
      const added = await executeGit(
        root,
        [
          "worktree",
          "add",
          "-b",
          branch,
          worktreePath,
          "--",
          intent.branch.source,
        ],
        GIT_MUTATION_TIMEOUT_MS,
      );
      if (!added.ok) {
        await removeEmptyReservation(reservation);
        const checkedOutPath = await checkedOutWorktreePath(root, branch);
        if (
          checkedOutPath !== null &&
          (await pathsHaveSameRealLocation(checkedOutPath, worktreePath))
        ) {
          return failed(
            intent.workspacePath,
            branch,
            formatGitFailureForBranch(intent, branch, worktreePath, added),
          );
        }
        if (await localBranchRefConflicts(root, branch)) {
          continue;
        }
        return failed(
          intent.workspacePath,
          branch,
          formatGitFailureForBranch(intent, branch, worktreePath, added),
        );
      }
      try {
        if (carry !== null) {
          await applyCarryState(carry, worktreePath);
        }
        if (intent.scripts !== null) {
          await writeEnvironmentFile(worktreePath, intent.scripts, now());
        }
      } catch (error) {
        await removeCreatedWorktree(root, reservation);
        return failed(
          intent.workspacePath,
          branch,
          error instanceof Error ? error.message : String(error),
        );
      }
      return successfulMaterialization(
        intent,
        repoIdentifier,
        worktreePath,
        branch,
        reservation.createdAt,
      );
    }

    return failed(
      intent.workspacePath,
      intent.branch.name,
      `Could not find an available generated branch after ${RANDOM_BRANCH_ATTEMPTS} attempts.`,
    );
  });
}

function successfulMaterialization(
  intent: ManagedWorktreeIntent,
  repoIdentifier: TaskRepoIdentifier | null,
  worktreePath: string,
  branch: string,
  createdAt: number,
): WorktreeMaterialization {
  return {
    entry: {
      workspacePath: intent.workspacePath,
      mode: "worktree",
      repoIdentifier,
      worktreePath,
      branch,
      isPrimary: intent.isPrimary,
      isImported: false,
      setupState: "not_required",
      setupTerminalSessionId: null,
      setupExitCode: null,
      setupFailedAt: null,
      createdAt,
      ownedSubmodules: [],
    },
    result: {
      workspacePath: intent.workspacePath,
      ok: true,
      worktreePath,
      branch,
      errorMessage: null,
    },
  };
}

async function materializeManagedWorktreeInRepository(
  intent: ManagedWorktreeIntent,
  root: string,
  worktreeRoot: string,
  now: () => number,
  policy: MaterializationPolicy,
): Promise<WorktreeMaterialization> {
  const branch = intent.branch.name;
  await runGitBoolean(root, ["worktree", "prune"]);
  const checkedOutPath = await checkedOutWorktreePath(root, branch);
  if (checkedOutPath !== null) {
    return failed(
      intent.workspacePath,
      branch,
      `${branch} is already checked out in ${checkedOutPath}`,
    );
  }

  const branchExists = await localBranchExists(root, branch);
  let createBranch = false;
  if (intent.branch.type === "existing") {
    if (!branchExists) {
      return failed(
        intent.workspacePath,
        branch,
        `${branch} is not a local branch; create a new branch from it instead of checking it out directly.`,
      );
    }
  } else if (branchExists) {
    const [branchCommit, sourceCommit] = await Promise.all([
      readGit(root, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]),
      readGit(root, [
        "rev-parse",
        "--verify",
        `${intent.branch.source}^{commit}`,
      ]),
    ]);
    if (branchCommit === null || sourceCommit === null) {
      return failed(
        intent.workspacePath,
        branch,
        `${branch} already exists; choose a new branch name or check out the existing branch.`,
      );
    }
    const mayAdopt =
      branchCommit === sourceCommit ||
      (await runGitBoolean(root, [
        "merge-base",
        "--is-ancestor",
        branchCommit,
        sourceCommit,
      ]));
    if (!mayAdopt) {
      return failed(
        intent.workspacePath,
        branch,
        `${branch} already exists and has commits not on ${intent.branch.source}; choose a new branch name or check out the existing branch.`,
      );
    }
  } else {
    createBranch = true;
  }

  const ref =
    intent.branch.type === "existing" || branchExists
      ? branch
      : intent.branch.source;
  const setupCommand =
    policy.setup === "require-empty"
      ? await resolvedSetupCommand(intent, root, ref)
      : null;
  if (policy.setup === "require-empty" && setupCommand !== null) {
    return failed(
      intent.workspacePath,
      branch,
      "Worktree setup commands are not supported by this local host yet.",
    );
  }

  const repoIdentifier = await repoIdentifierForMaterialization(
    intent,
    root,
    policy.repoIdentifier,
  );
  const managedGroup = await managedWorktreeGroupPath(
    worktreeRoot,
    root,
    repoIdentifier,
  );
  return withSerializedManagedGroupMutation(managedGroup.lockKey, async () => {
    await ensureManagedWorktreeGroup(managedGroup);
    const reservation = await allocateManagedWorktreePath(managedGroup, branch);
    const worktreePath = reservation.path;
    const carry =
      intent.branch.type === "new" && intent.branch.carryUncommittedChanges
        ? await captureCarryState(root, intent.branch.source)
        : null;
    const args =
      createBranch && intent.branch.type === "new"
        ? [
            "worktree",
            "add",
            "-b",
            branch,
            worktreePath,
            "--",
            intent.branch.source,
          ]
        : ["worktree", "add", worktreePath, "--", branch];
    const sourceCommit =
      createBranch && intent.branch.type === "new"
        ? await readGit(root, [
            "rev-parse",
            "--verify",
            `${intent.branch.source}^{commit}`,
          ])
        : null;
    const requestedFreshBranch =
      sourceCommit === null
        ? null
        : {
            branch,
            expectedCommit: sourceCommit,
          };
    const added = await addWorktreeWithRetry(
      root,
      args,
      worktreePath,
      requestedFreshBranch,
    );
    if (!added.ok) {
      // A failed add may leave a ref or registered checkout behind, but their
      // ownership is ambiguous once Git reports failure. Release only the
      // exact still-empty directory reservation; never remove Git state here.
      await removeEmptyReservation(reservation);
      if (intent.branch.type === "existing") {
        const racedCheckoutPath = await checkedOutWorktreePath(root, branch);
        if (racedCheckoutPath !== null) {
          return failed(
            intent.workspacePath,
            branch,
            `${branch} is already checked out in ${racedCheckoutPath}`,
          );
        }
      }
      return failed(
        intent.workspacePath,
        branch,
        formatGitFailure(intent, worktreePath, added),
      );
    }

    try {
      if (carry !== null) {
        await applyCarryState(carry, worktreePath);
      }
      if (intent.scripts !== null) {
        await writeEnvironmentFile(worktreePath, intent.scripts, now());
      }
    } catch (error) {
      await removeCreatedWorktree(root, reservation);
      return failed(
        intent.workspacePath,
        branch,
        error instanceof Error ? error.message : String(error),
      );
    }

    const entry: WorktreeBindingEntry = {
      workspacePath: intent.workspacePath,
      mode: "worktree",
      repoIdentifier,
      worktreePath,
      branch,
      isPrimary: intent.isPrimary,
      isImported: false,
      setupState: "not_required",
      setupTerminalSessionId: null,
      setupExitCode: null,
      setupFailedAt: null,
      createdAt: now(),
      ownedSubmodules: [],
    };
    return {
      entry,
      result: {
        workspacePath: intent.workspacePath,
        ok: true,
        worktreePath,
        branch,
        errorMessage: null,
      },
    };
  });
}

export async function localOrImportedEntry(
  intent: Exclude<WorktreeFolderIntent, ManagedWorktreeIntent>,
  worktreeRoot: string,
  now: () => number,
): Promise<{
  readonly entry: WorktreeBindingEntry;
  readonly result: WorktreePerEntryResult;
  readonly touchedWorkspacePaths: readonly string[];
}> {
  const managedImport =
    intent.kind === "local"
      ? await resolveManagedLocalIntent(intent.workspacePath, worktreeRoot)
      : null;
  const workspacePath = managedImport?.workspacePath ?? intent.workspacePath;
  const importedWorktreePath =
    managedImport?.worktreePath ??
    (intent.kind === "import" ? intent.worktreePath : null);
  const repoIdentifier =
    intent.repoIdentifier ??
    parseWorktreeRepoIdentifier(
      await readGit(workspacePath, ["remote", "get-url", "origin"]),
    );
  const imported = intent.kind === "import" || managedImport !== null;
  const branch = imported ? await importedBranch(importedWorktreePath) : null;
  const worktreePath = imported ? importedWorktreePath : null;
  const entry: WorktreeBindingEntry = {
    workspacePath,
    mode: imported ? "worktree" : "local",
    repoIdentifier,
    worktreePath,
    branch,
    isPrimary: intent.isPrimary,
    isImported: imported,
    setupState: "not_required",
    setupTerminalSessionId: null,
    setupExitCode: null,
    setupFailedAt: null,
    createdAt: now(),
    ownedSubmodules: [],
  };
  return {
    entry,
    result: {
      workspacePath,
      ok: true,
      worktreePath,
      branch,
      errorMessage: null,
    },
    touchedWorkspacePaths:
      managedImport === null
        ? [workspacePath]
        : [intent.workspacePath, workspacePath],
  };
}

type GitExecution = {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly errorMessage: string | null;
  readonly timedOut: boolean;
};

type FreshBranchRequest = {
  readonly branch: string;
  readonly expectedCommit: string;
};

type CarryState = {
  readonly sourcePath: string;
  readonly stashCommit: string | null;
  readonly untrackedPaths: readonly string[];
};

async function repoIdentifierForMaterialization(
  intent: ManagedWorktreeIntent,
  root: string,
  policy: RepoIdentifierPolicy,
): Promise<TaskRepoIdentifier | null> {
  if (policy.kind === "resolved") {
    return policy.value;
  }
  if (intent.repoIdentifier !== null) {
    return intent.repoIdentifier;
  }
  const remoteUrl = await readGit(root, ["remote", "get-url", "origin"]);
  return parseWorktreeRepoIdentifier(remoteUrl);
}

async function resolvedSetupCommand(
  intent: ManagedWorktreeIntent,
  root: string,
  ref: string,
): Promise<string | null> {
  let scripts: WorktreeEntryScripts | WorkspaceScripts | null = intent.scripts;
  if (scripts === null) {
    const read = await readWorktreeScriptsAtRefs([
      { workspacePath: root, ref },
    ]);
    scripts = read[0]?.scripts ?? null;
  }
  if (scripts === null) {
    return null;
  }
  const platform = platformSetup(scripts.setup);
  const command = platform.trim().length > 0 ? platform : scripts.setup.default;
  return command.trim().length > 0 ? command.trim() : null;
}

function platformSetup(setup: WorktreeEntryScripts["setup"]): string {
  if (process.platform === "darwin") {
    return setup.macos ?? "";
  }
  if (process.platform === "win32") {
    return setup.windows ?? "";
  }
  if (process.platform === "linux") {
    return setup.linux ?? "";
  }
  return "";
}

async function importedBranch(
  worktreePath: string | null,
): Promise<string | null> {
  if (worktreePath === null) {
    return null;
  }
  const branch = await readGit(worktreePath, [
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  return branch === "HEAD" ? null : branch;
}

async function resolveManagedLocalIntent(
  workspacePath: string,
  worktreeRoot: string,
): Promise<{
  readonly workspacePath: string;
  readonly worktreePath: string;
} | null> {
  const managedPath = await managedWorktreeCandidate(
    workspacePath,
    worktreeRoot,
  );
  if (managedPath === null) {
    return null;
  }
  const expectedRegisteredPath = await canonicalManagedRegisteredPath(
    managedPath,
    worktreeRoot,
  );
  return withSerializedManagedGroupMutation(
    dirname(expectedRegisteredPath),
    async () => {
      const worktreeList = await readGit(managedPath, [
        "worktree",
        "list",
        "--porcelain",
      ]);
      if (worktreeList === null) {
        throw new Error(managedWorktreeOrphanMessage(managedPath));
      }
      const worktreePaths = worktreeList
        .split(/\r?\n/u)
        .flatMap((line) =>
          line.startsWith("worktree ") ? [line.slice(9)] : [],
        );
      const mainRoot = worktreePaths[0];
      const linked = worktreePaths
        .slice(1)
        .some((path) => resolve(path) === expectedRegisteredPath);
      if (mainRoot === undefined || !linked) {
        return null;
      }
      return {
        workspacePath: resolve(mainRoot),
        worktreePath: managedPath,
      };
    },
  );
}

async function canonicalManagedRegisteredPath(
  managedPath: string,
  worktreeRoot: string,
): Promise<string> {
  const lexicalRoot = resolve(worktreeRoot);
  const parts = descendantParts(lexicalRoot, resolve(managedPath));
  const canonicalRoot = await realPathOrNull(lexicalRoot);
  if (parts?.length !== 2 || canonicalRoot === null) {
    return resolve(managedPath);
  }
  // Canonicalize only the configured root. Following a leaf symlink would
  // make an alias to another checkout look like a registered managed path.
  return join(canonicalRoot, ...parts);
}

async function managedWorktreeCandidate(
  workspacePath: string,
  worktreeRoot: string,
): Promise<string | null> {
  const absoluteManagedRoot = resolve(worktreeRoot);
  const absoluteWorkspacePath = resolve(workspacePath);
  const lexicalParts = descendantParts(
    absoluteManagedRoot,
    absoluteWorkspacePath,
  );
  if (lexicalParts?.length !== 2) {
    return null;
  }
  const candidate = join(absoluteManagedRoot, ...lexicalParts);
  const [realManagedRoot, realWorkspacePath] = await Promise.all([
    realPathOrNull(absoluteManagedRoot),
    realPathOrNull(absoluteWorkspacePath),
  ]);
  if (realWorkspacePath === null) {
    return candidate;
  }
  if (realManagedRoot === null) {
    return null;
  }
  const realParts = descendantParts(realManagedRoot, realWorkspacePath);
  return realParts?.length === 2 ? candidate : null;
}

function descendantParts(root: string, path: string): string[] | null {
  const child = relative(root, path);
  if (child.length === 0 || child.startsWith("..") || isAbsolute(child)) {
    return null;
  }
  return child.split(sep).filter((part) => part.length > 0);
}

async function realPathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

function managedWorktreeOrphanMessage(worktreePath: string): string {
  return (
    `worktree.import: managed worktree ${worktreePath} has no resolvable source workspace ` +
    "(its source repository may have moved or been deleted). Recreate the worktree " +
    "(e.g. traycer_create_worktree), or bind an explicit source via the CLI's " +
    "--workspace-entry <source>=<run>."
  );
}

async function localBranchExists(
  root: string,
  branch: string,
): Promise<boolean> {
  return runGitBoolean(root, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
}

async function localBranchRefConflicts(
  root: string,
  branch: string,
): Promise<boolean> {
  const refs = await readGit(root, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/heads",
  ]);
  if (refs === null) {
    return false;
  }
  const candidate = `refs/heads/${branch}`;
  return refs.split(/\r?\n/u).some((ref) => {
    const normalized = ref.trim();
    return (
      normalized === candidate ||
      normalized.startsWith(`${candidate}/`) ||
      candidate.startsWith(`${normalized}/`)
    );
  });
}

async function checkedOutWorktreePath(
  root: string,
  branch: string,
): Promise<string | null> {
  const output = await readGit(root, ["worktree", "list", "--porcelain"]);
  if (output === null) {
    return null;
  }
  let path: string | null = null;
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith("worktree ")) {
      path = line.slice(9);
      continue;
    }
    if (line === `branch refs/heads/${branch}`) {
      return path;
    }
    if (line.length === 0) {
      path = null;
    }
  }
  return null;
}

async function pathsHaveSameRealLocation(
  left: string,
  right: string,
): Promise<boolean> {
  const [leftRealPath, rightRealPath] = await Promise.all([
    realPathOrNull(left),
    realPathOrNull(right),
  ]);
  return (
    leftRealPath !== null &&
    rightRealPath !== null &&
    leftRealPath === rightRealPath
  );
}

type ManagedWorktreeGroup = {
  readonly path: string;
  readonly lockKey: string;
};

async function managedWorktreeGroupPath(
  worktreeRoot: string,
  repositoryRoot: string,
  repoIdentifier: TaskRepoIdentifier | null,
): Promise<ManagedWorktreeGroup> {
  const group =
    repoIdentifier === null
      ? `local__${pathSegment(basename(repositoryRoot))}__${createHash("sha256")
          .update(repositoryRoot)
          .digest("hex")
          .slice(0, 10)}`
      : `${pathSegment(repoIdentifier.owner)}__${pathSegment(repoIdentifier.repo)}`;
  const configuredRoot = resolve(worktreeRoot);
  await mkdir(configuredRoot, { recursive: true });
  const canonicalRoot = await realpath(configuredRoot);
  const groupPath = join(configuredRoot, group);
  return { path: groupPath, lockKey: join(canonicalRoot, group) };
}

async function ensureManagedWorktreeGroup(
  group: ManagedWorktreeGroup,
): Promise<void> {
  try {
    await mkdir(group.path);
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
  }
  const [groupStat, canonicalGroup] = await Promise.all([
    lstat(group.path),
    realpath(group.path),
  ]);
  if (
    !groupStat.isDirectory() ||
    groupStat.isSymbolicLink() ||
    canonicalGroup !== group.lockKey
  ) {
    throw new Error(`unsafe managed worktree group: ${group.path}`);
  }
}

type ManagedPathReservation = {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
  readonly createdAt: number;
};

function randomBranchCandidate(
  requestedName: string,
  retryIdentity: string,
  attempt: number,
): string {
  if (attempt === 0) {
    return requestedName;
  }
  const suffix = retryIdentityHash("branch", retryIdentity, attempt).slice(
    0,
    10,
  );
  return `${requestedName}-${suffix}`;
}

function retryIdentityHash(
  domain: "branch" | "path",
  retryIdentity: string,
  attempt: number | null,
): string {
  return createHash("sha256")
    .update(domain)
    .update("\0")
    .update(retryIdentity)
    .update("\0")
    .update(attempt === null ? "" : String(attempt))
    .digest("hex");
}

function randomManagedWorktreePath(
  managedGroup: ManagedWorktreeGroup,
  branch: string,
  identityHash: string,
): string {
  const suffix = `-${identityHash}`;
  const branchLeaf = branchSegment(branch).slice(0, 255 - suffix.length);
  return join(managedGroup.path, `${branchLeaf}${suffix}`);
}

async function completedRandomCheckoutCreatedAt(
  root: string,
  managedGroup: ManagedWorktreeGroup,
  branch: string,
  worktreePath: string,
): Promise<number | null> {
  const checkedOutPath = await checkedOutWorktreePath(root, branch);
  if (checkedOutPath === null) {
    return null;
  }
  const [checkedOutRealPath, requestedRealPath] = await Promise.all([
    realPathOrNull(checkedOutPath),
    realPathOrNull(worktreePath),
  ]);
  if (
    checkedOutRealPath === null ||
    requestedRealPath === null ||
    checkedOutRealPath !== requestedRealPath
  ) {
    return null;
  }
  try {
    const checkoutStat = await lstat(worktreePath);
    if (
      !checkoutStat.isDirectory() ||
      checkoutStat.isSymbolicLink() ||
      dirname(requestedRealPath) !== managedGroup.lockKey
    ) {
      return null;
    }
    return checkoutStat.birthtimeMs;
  } catch {
    return null;
  }
}

async function reserveManagedWorktreePath(
  managedGroup: ManagedWorktreeGroup,
  candidate: string,
): Promise<ManagedPathReservation | null> {
  if ((await realpath(managedGroup.path)) !== managedGroup.lockKey) {
    throw new Error(`unsafe managed worktree group: ${managedGroup.path}`);
  }
  try {
    await mkdir(candidate);
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      return null;
    }
    throw error;
  }
  const candidateStat = await lstat(candidate);
  const reservation: ManagedPathReservation = {
    path: candidate,
    device: candidateStat.dev,
    inode: candidateStat.ino,
    createdAt: candidateStat.birthtimeMs,
  };
  const canonicalCandidate = await realpath(candidate);
  if (
    !candidateStat.isDirectory() ||
    candidateStat.isSymbolicLink() ||
    dirname(canonicalCandidate) !== managedGroup.lockKey
  ) {
    await removeEmptyReservation(reservation);
    throw new Error(`unsafe managed worktree path: ${candidate}`);
  }
  return reservation;
}

async function allocateManagedWorktreePath(
  managedGroup: ManagedWorktreeGroup,
  branch: string,
): Promise<ManagedPathReservation> {
  if ((await realpath(managedGroup.path)) !== managedGroup.lockKey) {
    throw new Error(`unsafe managed worktree group: ${managedGroup.path}`);
  }
  const leaf = branchSegment(branch);
  let suffix = 1;
  for (;;) {
    const candidate = join(
      managedGroup.path,
      suffix === 1 ? leaf : `${leaf}-${suffix}`,
    );
    const reservation = await reserveManagedWorktreePath(
      managedGroup,
      candidate,
    );
    if (reservation !== null) {
      return reservation;
    }
    {
      suffix += 1;
    }
  }
}

function pathSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "unnamed"
  );
}

function branchSegment(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "branch"
  );
}

async function addWorktreeWithRetry(
  root: string,
  args: readonly string[],
  worktreePath: string,
  requestedFreshBranch: FreshBranchRequest | null,
): Promise<GitExecution> {
  const first = await executeGit(root, args, GIT_MUTATION_TIMEOUT_MS);
  if (first.ok) {
    return first;
  }
  await runGitBoolean(root, ["worktree", "prune"]);
  const canAdoptFreshBranch =
    requestedFreshBranch !== null &&
    (await branchPointsAtCommit(
      root,
      requestedFreshBranch.branch,
      requestedFreshBranch.expectedCommit,
    )) &&
    (await checkedOutWorktreePath(root, requestedFreshBranch.branch)) === null;
  const retryArgs = canAdoptFreshBranch
    ? ["worktree", "add", worktreePath, "--", requestedFreshBranch.branch]
    : args;
  const second = await executeGit(root, retryArgs, GIT_MUTATION_TIMEOUT_MS);
  return second.ok ? second : first;
}

async function removeCreatedWorktree(
  root: string,
  reservation: ManagedPathReservation,
): Promise<void> {
  await executeGit(
    root,
    ["worktree", "remove", "--force", reservation.path],
    GIT_MUTATION_TIMEOUT_MS,
  );
  await runGitBoolean(root, ["worktree", "prune"]);
  await removeEmptyReservation(reservation);
  // Never recursively remove a path or delete its branch ref during failure
  // cleanup. Another process may have claimed either after Git released them.
  // A later request can safely adopt a same-tip leftover branch.
}

async function removeEmptyReservation(
  reservation: ManagedPathReservation,
): Promise<void> {
  try {
    const current = await lstat(reservation.path);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== reservation.device ||
      current.ino !== reservation.inode
    ) {
      return;
    }
    await rmdir(reservation.path);
  } catch {
    // Only the exact, still-empty directory reserved by this operation may be
    // removed. Missing, populated, replaced, and unreadable paths stay put.
  }
}

async function branchPointsAtCommit(
  root: string,
  branch: string,
  expectedCommit: string,
): Promise<boolean> {
  const commit = await readGit(root, [
    "rev-parse",
    "--verify",
    `refs/heads/${branch}^{commit}`,
  ]);
  return commit === expectedCommit;
}

function executeGit(
  cwd: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<GitExecution> {
  return new Promise((resolveResult) => {
    try {
      execFile(
        "git",
        ["-C", cwd, ...args],
        {
          cwd,
          encoding: "utf8",
          timeout: timeoutMs,
          maxBuffer: GIT_MAX_BUFFER_BYTES,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          resolveResult({
            ok: error === null,
            stdout,
            stderr,
            errorMessage: error === null ? null : error.message,
            timedOut:
              error !== null && "killed" in error && error.killed === true,
          });
        },
      );
    } catch (error) {
      resolveResult({
        ok: false,
        stdout: "",
        stderr: "",
        errorMessage: error instanceof Error ? error.message : String(error),
        timedOut: false,
      });
    }
  });
}

function formatGitFailure(
  intent: ManagedWorktreeIntent,
  worktreePath: string,
  result: GitExecution,
): string {
  return formatGitFailureForBranch(
    intent,
    intent.branch.name,
    worktreePath,
    result,
  );
}

function formatGitFailureForBranch(
  intent: ManagedWorktreeIntent,
  branch: string,
  worktreePath: string,
  result: GitExecution,
): string {
  const prefix =
    intent.branch.type === "new"
      ? `git worktree add failed for ${branch} at ${worktreePath}`
      : `Could not check out ${branch} into a new worktree at ${worktreePath}.`;
  if (result.timedOut) {
    return `${prefix} (timed out after ${GIT_MUTATION_TIMEOUT_MS / 1_000}s)`;
  }
  const detail = result.stderr
    .split(/\r\n|\n|\r/u)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !/^(Preparing worktree|Updating files|HEAD is now at)/u.test(line),
    )
    .slice(-3)
    .join(" ")
    .slice(0, 400);
  return detail.length === 0 ? prefix : `${prefix}: ${detail}`;
}

async function captureCarryState(
  root: string,
  sourceBranch: string,
): Promise<CarryState | null> {
  const sourcePath = await checkoutPathForBranch(root, sourceBranch);
  if (sourcePath === null) {
    return null;
  }
  const [stash, untracked] = await Promise.all([
    executeGit(sourcePath, ["stash", "create"], GIT_MUTATION_TIMEOUT_MS),
    executeGit(
      sourcePath,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      GIT_MUTATION_TIMEOUT_MS,
    ),
  ]);
  return {
    sourcePath,
    stashCommit:
      stash.ok && stash.stdout.trim().length > 0 ? stash.stdout.trim() : null,
    untrackedPaths: untracked.ok
      ? untracked.stdout.split("\0").filter((path) => path.length > 0)
      : [],
  };
}

async function checkoutPathForBranch(
  root: string,
  branch: string,
): Promise<string | null> {
  const current = await readGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current === branch) {
    return root;
  }
  return checkedOutWorktreePath(root, branch);
}

async function applyCarryState(
  carry: CarryState,
  worktreePath: string,
): Promise<void> {
  if (carry.stashCommit !== null) {
    await executeGit(
      worktreePath,
      ["stash", "apply", carry.stashCommit],
      GIT_MUTATION_TIMEOUT_MS,
    );
  }
  await Promise.all(
    carry.untrackedPaths.map(async (path) => {
      const source = resolve(carry.sourcePath, path);
      const target = resolve(worktreePath, path);
      if (
        !isWithin(carry.sourcePath, source) ||
        !isWithin(worktreePath, target)
      ) {
        return;
      }
      try {
        await mkdir(dirname(target), { recursive: true });
        await copyFile(source, target);
      } catch {
        // Carry is best effort in the signed host; provisioning stays successful.
      }
    }),
  );
}

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child.length === 0 ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

export async function writeEnvironmentFile(
  worktreePath: string,
  scripts: WorktreeEntryScripts,
  updatedAt: number,
): Promise<void> {
  const directory = join(worktreePath, ".traycer");
  try {
    const current = await lstat(directory);
    if (!current.isDirectory() || current.isSymbolicLink()) {
      throw new Error(
        `Refusing to write scripts through unsafe path ${directory}`,
      );
    }
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
    await mkdir(directory, { recursive: true });
  }
  const target = join(directory, "environment.json");
  const temporary = join(directory, `.environment.${randomUUID()}.tmp`);
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ ...scripts, updatedAt }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

function failed(
  workspacePath: string,
  branch: string,
  errorMessage: string,
): WorktreeMaterialization {
  return {
    entry: null,
    result: {
      workspacePath,
      ok: false,
      worktreePath: null,
      branch,
      errorMessage,
    },
  };
}

async function withSerializedRepositoryMutation<T>(
  repositoryRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous =
    repositoryMutationTails.get(repositoryRoot) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  repositoryMutationTails.set(repositoryRoot, tail);
  try {
    return await result;
  } finally {
    if (repositoryMutationTails.get(repositoryRoot) === tail) {
      repositoryMutationTails.delete(repositoryRoot);
    }
  }
}

async function withSerializedManagedGroupMutation<T>(
  managedGroup: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous =
    managedGroupMutationTails.get(managedGroup) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  managedGroupMutationTails.set(managedGroup, tail);
  try {
    return await result;
  } finally {
    if (managedGroupMutationTails.get(managedGroup) === tail) {
      managedGroupMutationTails.delete(managedGroup);
    }
  }
}

async function repositoryMutationKey(repositoryRoot: string): Promise<string> {
  const commonDirectory = await readGit(repositoryRoot, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const candidate =
    commonDirectory === null
      ? repositoryRoot
      : isAbsolute(commonDirectory)
        ? commonDirectory
        : resolve(repositoryRoot, commonDirectory);
  return (await realPathOrNull(candidate)) ?? resolve(candidate);
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
