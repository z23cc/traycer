import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  OsScript,
  WorktreeBinding,
  WorktreeBindingEntry,
  WorktreeBindingOwnerKind,
  WorktreeBranchSelection,
  WorktreeFolderIntent,
  WorktreeHostEntryOwner,
  WorktreeHostEntryV16,
  WorktreeImportEntry,
  WorktreePerEntryResult,
  WorkspaceScripts,
} from "@traycer/protocol/host/worktree-schemas";
import {
  branchStatus,
  inspectRepo,
  listDiskWorktrees,
  listManagedWorktreeDirs,
  runGit,
  runGitMutating,
  type GitRepoFacts,
  uncommittedCount,
} from "../git/git";
import type { HostRuntime } from "../runtime";
import type { StoredBinding } from "../store/host-store";
import { validateWorkspacePath } from "../workspace/workspace";

export type ListAllRequest = {
  readonly includeActivity: boolean;
  readonly activityPaths: readonly string[] | null;
  readonly cursor: string | null;
  readonly limit: number | null;
  readonly forceRefresh: boolean;
};

export type CreateWorktreeRequest = {
  readonly epicId: string;
  readonly ownerId: string;
  readonly ownerKind: WorktreeBindingOwnerKind;
  readonly entries: readonly WorktreeFolderIntent[];
};

export async function listAllWorktrees(
  runtime: HostRuntime,
  request: ListAllRequest,
): Promise<{
  readonly worktrees: WorktreeHostEntryV16[];
  readonly nextCursor: string | null;
}> {
  void request.forceRefresh;
  const paths = await collectWorktreePaths(runtime);
  const selected =
    request.activityPaths === null
      ? paths
      : paths.filter((path) => request.activityPaths?.includes(path) === true);
  selected.sort((left, right) => left.localeCompare(right));
  const cursor = request.cursor;
  const afterCursor =
    cursor === null
      ? selected
      : selected.filter((path) => path > cursor);
  const page =
    request.limit === null ? afterCursor : afterCursor.slice(0, request.limit);
  const probe =
    request.includeActivity || request.activityPaths !== null;
  const worktrees = [];
  for (const path of page) {
    worktrees.push(await describeWorktree(runtime, path, probe));
  }
  const nextCursor =
    request.activityPaths !== null ||
    request.limit === null ||
    afterCursor.length <= page.length
      ? null
      : page[page.length - 1];
  return { worktrees, nextCursor };
}

export async function createWorktreeBinding(
  runtime: HostRuntime,
  request: CreateWorktreeRequest,
): Promise<{
  readonly binding: WorktreeBinding;
  readonly perEntry: WorktreePerEntryResult[];
}> {
  const now = Date.now();
  const entries: WorktreeBindingEntry[] = [];
  const perEntry: WorktreePerEntryResult[] = [];
  for (const intent of request.entries) {
    const built = await materializeIntent(runtime, intent, now);
    if (built.entry !== null) {
      entries.push(built.entry);
    }
    perEntry.push(built.result);
  }
  const binding: WorktreeBinding = { entries };
  await persistBinding(runtime, {
    epicId: request.epicId,
    ownerId: request.ownerId,
    ownerKind: request.ownerKind,
    binding,
  });
  return { binding, perEntry };
}

export async function importWorktreeBinding(
  runtime: HostRuntime,
  request: {
    readonly epicId: string;
    readonly ownerId: string;
    readonly ownerKind: WorktreeBindingOwnerKind;
    readonly entries: readonly WorktreeImportEntry[];
  },
): Promise<WorktreeBinding> {
  const now = Date.now();
  const entries: WorktreeBindingEntry[] = [];
  for (const row of request.entries) {
    const intent: WorktreeFolderIntent =
      row.worktreePath === null
        ? {
            kind: "local",
            workspacePath: row.workspacePath,
            repoIdentifier: row.repoIdentifier,
            isPrimary: row.isPrimary,
          }
        : {
            kind: "import",
            workspacePath: row.workspacePath,
            repoIdentifier: row.repoIdentifier,
            isPrimary: row.isPrimary,
            worktreePath: row.worktreePath,
          };
    const built = await materializeIntent(runtime, intent, now);
    if (built.entry !== null) {
      entries.push(built.entry);
    }
  }
  const binding: WorktreeBinding = { entries };
  await persistBinding(runtime, {
    epicId: request.epicId,
    ownerId: request.ownerId,
    ownerKind: request.ownerKind,
    binding,
  });
  return binding;
}

export async function createWorktreePaths(
  runtime: HostRuntime,
  entries: readonly WorktreeFolderIntent[],
): Promise<{
  readonly entries: readonly {
    readonly workspacePath: string;
    readonly path: string;
    readonly mode: "local" | "worktree";
    readonly repoIdentifier: WorktreeBindingEntry["repoIdentifier"];
    readonly branch: string | null;
  }[];
  readonly perEntry: WorktreePerEntryResult[];
}> {
  const now = Date.now();
  const created = [];
  const perEntry: WorktreePerEntryResult[] = [];
  for (const intent of entries) {
    const built = await materializeIntent(runtime, intent, now);
    perEntry.push(built.result);
    if (built.entry === null || built.result.worktreePath === null) {
      continue;
    }
    created.push({
      workspacePath: built.entry.workspacePath,
      path: built.result.worktreePath,
      mode: built.entry.mode,
      repoIdentifier: built.entry.repoIdentifier,
      branch: built.entry.branch,
    });
  }
  return { entries: created, perEntry };
}

export async function setEntryModeLocal(
  runtime: HostRuntime,
  epicId: string,
  ownerId: string,
  ownerKind: WorktreeBindingOwnerKind,
  workspacePath: string,
): Promise<WorktreeBinding | null> {
  const found = findBinding(runtime, epicId, ownerId, ownerKind);
  if (found === undefined) {
    return null;
  }
  const entries = found.binding.entries.map((entry) => {
    if (entry.workspacePath !== workspacePath) {
      return entry;
    }
    return {
      ...entry,
      mode: "local" as const,
      worktreePath: null,
      setupState: "not_required" as const,
      setupTerminalSessionId: null,
      setupExitCode: null,
      setupFailedAt: null,
    };
  });
  const binding: WorktreeBinding = { ...found.binding, entries };
  await persistBinding(runtime, { ...found, binding });
  return binding;
}

export async function removeBindingEntry(
  runtime: HostRuntime,
  epicId: string,
  ownerId: string,
  ownerKind: WorktreeBindingOwnerKind,
  workspacePath: string,
): Promise<WorktreeBinding | null> {
  const found = findBinding(runtime, epicId, ownerId, ownerKind);
  if (found === undefined) {
    return null;
  }
  const binding: WorktreeBinding = {
    ...found.binding,
    entries: found.binding.entries.filter(
      (entry) => entry.workspacePath !== workspacePath,
    ),
  };
  await persistBinding(runtime, { ...found, binding });
  return binding;
}

export async function deleteWorktree(
  runtime: HostRuntime,
  workspacePath: string,
  worktreePath: string,
): Promise<boolean> {
  const facts = inspectRepo(workspacePath);
  let deleted = false;
  if (facts !== null) {
    const removed = runGitMutating(
      ["worktree", "remove", "--force", worktreePath],
      facts.toplevel,
    );
    deleted = removed.status === 0;
  }
  if (!deleted && existsSync(worktreePath)) {
    await rm(worktreePath, { recursive: true, force: true });
    deleted = true;
  }
  await runtime.store.mutate((state) => {
    state.bindings = state.bindings.map((binding) => ({
      ...binding,
      binding: {
        ...binding.binding,
        entries: binding.binding.entries.filter(
          (entry) => entry.worktreePath !== worktreePath,
        ),
      },
    }));
  });
  return deleted;
}

export async function summarizeWorkspaces(
  workspacePaths: readonly string[],
): Promise<
  readonly {
    readonly workspacePath: string;
    readonly isGitRepo: boolean;
    readonly repoIdentifier: WorktreeBindingEntry["repoIdentifier"];
    readonly mainBranch: string | null;
    readonly worktrees: readonly {
      readonly worktreePath: string;
      readonly branch: string | null;
      readonly sourceBranch: null;
      readonly head: string | null;
      readonly isMain: boolean;
      readonly isLocked: boolean;
    }[];
    readonly scripts: WorkspaceScripts | null;
    readonly resolvedAt: number;
    readonly repoBranchPrefix: { readonly status: "absent" };
    readonly presence: "present" | "absent";
  }[]
> {
  const now = Date.now();
  const rows = [];
  for (const workspacePath of workspacePaths) {
    const validation = await validateWorkspacePath(workspacePath);
    if (!validation.ok) {
      rows.push({
        workspacePath,
        isGitRepo: false,
        repoIdentifier: null,
        mainBranch: null,
        worktrees: [],
        scripts: null,
        resolvedAt: now,
        repoBranchPrefix: { status: "absent" as const },
        presence: "absent" as const,
      });
      continue;
    }
    const facts = inspectRepo(validation.resolvedPath);
    rows.push({
      workspacePath: validation.resolvedPath,
      isGitRepo: facts !== null,
      repoIdentifier: facts === null ? null : facts.repoIdentifier,
      mainBranch: facts === null ? null : facts.branch,
      worktrees: listDiskWorktrees(validation.resolvedPath),
      scripts: await readWorkspaceScripts(validation.resolvedPath),
      resolvedAt: now,
      repoBranchPrefix: { status: "absent" as const },
      presence: "present" as const,
    });
  }
  return rows;
}

export async function scriptsAtRef(
  workspacePath: string,
  ref: string,
): Promise<WorkspaceScripts | null> {
  const facts = inspectRepo(workspacePath);
  if (facts === null) {
    return null;
  }
  const raw = runGit(["show", `${ref}:.traycer/environment.json`], facts.toplevel);
  if (raw === null) {
    return null;
  }
  return parseWorkspaceScripts(raw);
}

export async function writeRepoScripts(
  workspacePath: string,
  setup: OsScript,
  teardown: OsScript,
): Promise<boolean> {
  const validation = await validateWorkspacePath(workspacePath);
  if (!validation.ok) {
    return false;
  }
  const dir = join(validation.resolvedPath, ".traycer");
  await mkdir(dir, { recursive: true });
  const payload: WorkspaceScripts = {
    setup,
    teardown,
    updatedAt: Date.now(),
  };
  await writeFile(
    join(dir, "environment.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
  return true;
}

export function findBinding(
  runtime: HostRuntime,
  epicId: string,
  ownerId: string,
  ownerKind: WorktreeBindingOwnerKind,
): StoredBinding | undefined {
  return runtime.store
    .snapshot()
    .bindings.find(
      (binding) =>
        binding.epicId === epicId &&
        binding.ownerId === ownerId &&
        binding.ownerKind === ownerKind,
    );
}

export function resolveChatWorktreeBinding(
  runtime: HostRuntime,
  epicId: string,
  chatId: string,
): WorktreeBinding | null {
  const stored = findBinding(runtime, epicId, chatId, "chat");
  if (stored !== undefined && stored.binding.entries.length > 0) {
    return stored.binding;
  }
  const epic = runtime.store.snapshot().epics.find((row) => row.id === epicId);
  if (epic === undefined || epic.workspaces.length === 0) {
    return null;
  }
  const now = Date.now();
  return {
    entries: epic.workspaces.map((workspacePath, index) => {
      const facts = inspectRepo(workspacePath);
      return localEntry(
        workspacePath,
        facts === null ? null : facts.repoIdentifier,
        index === 0,
        now,
        facts,
      );
    }),
  };
}

async function collectWorktreePaths(runtime: HostRuntime): Promise<string[]> {
  const paths = new Set<string>(listManagedWorktreeDirs(runtime.dataDir));
  for (const binding of runtime.store.snapshot().bindings) {
    for (const entry of binding.binding.entries) {
      if (entry.mode === "worktree" && entry.worktreePath !== null) {
        paths.add(entry.worktreePath);
      }
    }
  }
  const existing = [];
  for (const path of paths) {
    if (existsSync(path)) {
      existing.push(path);
    }
  }
  return existing;
}

async function describeWorktree(
  runtime: HostRuntime,
  worktreePath: string,
  includeActivity: boolean,
): Promise<WorktreeHostEntryV16> {
  const facts = inspectRepo(worktreePath);
  const gitDirExists = existsSync(join(worktreePath, ".git"));
  const gitUnreadable = gitDirExists && facts === null;
  const owners = ownersFor(runtime, worktreePath);
  const inUse =
    owners.length > 0 ||
    runtime.terminals
      .listAll()
      .some(
        (session) =>
          session.cwd === worktreePath || session.currentCwd === worktreePath,
      );
  let createdAt: number | null = null;
  try {
    const stats = await lstat(worktreePath);
    createdAt = stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs;
  } catch {
    createdAt = null;
  }
  const status = includeActivity ? branchStatus(worktreePath, facts?.branch ?? null) : null;
  const dirty = facts === null ? 0 : uncommittedCount(facts.toplevel);
  const repoIdentifier = facts === null ? null : facts.repoIdentifier;
  return {
    worktreePath,
    repoLabel:
      repoIdentifier === null
        ? basename(worktreePath)
        : `${repoIdentifier.owner}/${repoIdentifier.repo}`,
    repoIdentifier,
    branch: facts === null ? null : facts.branch,
    inUse,
    uncommittedCount: dirty,
    gitRemovable: facts !== null,
    scripts: await readWorkspaceScripts(worktreePath),
    lastActivityAt: includeActivity ? Date.now() : null,
    owners,
    branchStatus: includeActivity ? status : null,
    createdAt,
    prState: includeActivity ? "none" : null,
    prNumber: null,
    prUrl: null,
    mergedHeadShaMatches: false,
    submodules: [],
    atBaseCommit:
      includeActivity && dirty === 0 && status !== null && status.mergedIntoDefault,
    resolvedAt: Date.now(),
    presence: "present",
    gitUnreadable,
  };
}

function ownersFor(
  runtime: HostRuntime,
  worktreePath: string,
): WorktreeHostEntryOwner[] {
  const owners: WorktreeHostEntryOwner[] = [];
  for (const binding of runtime.store.snapshot().bindings) {
    for (const entry of binding.binding.entries) {
      if (entry.worktreePath === worktreePath) {
        owners.push({
          epicId: binding.epicId,
          ownerKind: binding.ownerKind,
          ownerId: binding.ownerId,
          updatedAt: entry.createdAt,
        });
      }
    }
  }
  return owners;
}

async function materializeIntent(
  runtime: HostRuntime,
  intent: WorktreeFolderIntent,
  now: number,
): Promise<{
  readonly entry: WorktreeBindingEntry | null;
  readonly result: WorktreePerEntryResult;
}> {
  const validation = await validateWorkspacePath(intent.workspacePath);
  if (!validation.ok) {
    return {
      entry: null,
      result: {
        workspacePath: intent.workspacePath,
        ok: false,
        worktreePath: null,
        branch: null,
        errorMessage: validation.reason,
      },
    };
  }
  const facts = inspectRepo(validation.resolvedPath);
  const repoIdentifier =
    intent.repoIdentifier ?? (facts === null ? null : facts.repoIdentifier);
  if (intent.kind === "local") {
    const entry = localEntry(
      validation.resolvedPath,
      repoIdentifier,
      intent.isPrimary,
      now,
      facts,
    );
    return {
      entry,
      result: {
        workspacePath: validation.resolvedPath,
        ok: true,
        worktreePath: null,
        branch: entry.branch,
        errorMessage: null,
      },
    };
  }
  if (intent.kind === "import") {
    const imported = await validateWorkspacePath(intent.worktreePath);
    if (!imported.ok) {
      return {
        entry: null,
        result: {
          workspacePath: intent.workspacePath,
          ok: false,
          worktreePath: intent.worktreePath,
          branch: null,
          errorMessage: imported.reason,
        },
      };
    }
    const importedFacts = inspectRepo(imported.resolvedPath);
    const entry: WorktreeBindingEntry = {
      workspacePath: validation.resolvedPath,
      mode: "worktree",
      repoIdentifier,
      worktreePath: imported.resolvedPath,
      branch: importedFacts === null ? null : importedFacts.branch,
      isPrimary: intent.isPrimary,
      isImported: true,
      setupState: "succeeded",
      setupTerminalSessionId: null,
      setupExitCode: 0,
      setupFailedAt: null,
      createdAt: now,
      ownedSubmodules: [],
    };
    return {
      entry,
      result: {
        workspacePath: validation.resolvedPath,
        ok: true,
        worktreePath: imported.resolvedPath,
        branch: entry.branch,
        errorMessage: null,
      },
    };
  }
  const created = await addGitWorktree(
    runtime.dataDir,
    validation.resolvedPath,
    intent.branch,
    facts,
  );
  if (!created.ok) {
    return {
      entry: null,
      result: {
        workspacePath: validation.resolvedPath,
        ok: false,
        worktreePath: null,
        branch: intent.branch.name,
        errorMessage: created.error,
      },
    };
  }
  if (intent.scripts !== null) {
    await writeRepoScripts(created.path, intent.scripts.setup, intent.scripts.teardown);
  }
  const entry: WorktreeBindingEntry = {
    workspacePath: validation.resolvedPath,
    mode: "worktree",
    repoIdentifier,
    worktreePath: created.path,
    branch: intent.branch.name,
    isPrimary: intent.isPrimary,
    isImported: false,
    setupState: "succeeded",
    setupTerminalSessionId: null,
    setupExitCode: 0,
    setupFailedAt: null,
    createdAt: now,
    ownedSubmodules: [],
  };
  return {
    entry,
    result: {
      workspacePath: validation.resolvedPath,
      ok: true,
      worktreePath: created.path,
      branch: intent.branch.name,
      errorMessage: null,
    },
  };
}

async function addGitWorktree(
  dataDir: string,
  workspacePath: string,
  branch: WorktreeBranchSelection,
  facts: GitRepoFacts | null,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (facts === null) {
    return { ok: false, error: "Not a git repository" };
  }
  const owner = facts.repoIdentifier?.owner ?? "local";
  const repo = facts.repoIdentifier?.repo ?? basenameSafe(workspacePath);
  const dest = join(dataDir, "worktrees", owner, repo, slug(branch.name));
  await mkdir(dirname(dest), { recursive: true });
  if (existsSync(dest)) {
    return { ok: true, path: dest };
  }
  const args =
    branch.type === "existing"
      ? ["worktree", "add", dest, branch.name]
      : ["worktree", "add", "-b", branch.name, dest, branch.source];
  if (branch.type === "new" && branch.carryUncommittedChanges) {
    runGitMutating(
      ["stash", "push", "--include-untracked", "-m", "traycer-worktree-carry"],
      workspacePath,
    );
  }
  const added = runGitMutating(args, workspacePath);
  if (added.status !== 0 && !existsSync(dest)) {
    return {
      ok: false,
      error: added.stderr.trim().length > 0 ? added.stderr.trim() : "git worktree add failed",
    };
  }
  if (branch.type === "new" && branch.carryUncommittedChanges) {
    runGitMutating(["stash", "pop"], dest);
  }
  return { ok: true, path: dest };
}

function localEntry(
  workspacePath: string,
  repoIdentifier: WorktreeBindingEntry["repoIdentifier"],
  isPrimary: boolean,
  createdAt: number,
  facts: GitRepoFacts | null,
): WorktreeBindingEntry {
  return {
    workspacePath,
    mode: "local",
    repoIdentifier,
    worktreePath: null,
    branch: facts === null ? null : facts.branch,
    isPrimary,
    isImported: false,
    setupState: "not_required",
    setupTerminalSessionId: null,
    setupExitCode: null,
    setupFailedAt: null,
    createdAt,
    ownedSubmodules: [],
  };
}

async function persistBinding(
  runtime: HostRuntime,
  stored: StoredBinding,
): Promise<void> {
  await runtime.store.mutate((state) => {
    state.bindings = state.bindings.filter(
      (row) =>
        !(
          row.epicId === stored.epicId &&
          row.ownerId === stored.ownerId &&
          row.ownerKind === stored.ownerKind
        ),
    );
    state.bindings.push(stored);
  });
}

async function readWorkspaceScripts(
  root: string,
): Promise<WorkspaceScripts | null> {
  try {
    const raw = await readFile(join(root, ".traycer", "environment.json"), "utf8");
    return parseWorkspaceScripts(raw);
  } catch {
    return null;
  }
}

function parseWorkspaceScripts(raw: string): WorkspaceScripts | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (
    !isOsScript(record.setup) ||
    !isOsScript(record.teardown) ||
    typeof record.updatedAt !== "number"
  ) {
    return null;
  }
  return {
    setup: record.setup,
    teardown: record.teardown,
    updatedAt: record.updatedAt,
  };
}

function isOsScript(value: unknown): value is OsScript {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.default === "string" &&
    (record.macos === null || typeof record.macos === "string") &&
    (record.windows === null || typeof record.windows === "string") &&
    (record.linux === null || typeof record.linux === "string")
  );
}

function basenameSafe(path: string): string {
  const last = basename(path);
  return last.length === 0 ? "workspace" : last;
}

function slug(branch: string): string {
  return branch.replaceAll("/", "--");
}
