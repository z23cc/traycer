import { existsSync } from "node:fs";
import {
  workspaceBindingRemoveEntryRequestSchema,
  worktreeCreatePathsRequestSchema,
  worktreeCreatePathsRequestSchemaV10,
  worktreeCreateRequestSchema,
  worktreeCreateRequestSchemaV10,
  worktreeDeleteRequestSchemaV12,
  worktreeGetBindingRequestSchema,
  worktreeImportRequestSchema,
  worktreeListBindingsForEpicRequestSchema,
  worktreeListBranchesRequestSchema,
  worktreeListByWorkspacePathsRequestSchemaV14,
  worktreeRetrySetupRequestSchema,
  worktreeSetEntryModeRequestSchema,
  worktreeSetRepoScriptsRequestSchema,
  type WorktreeFolderIntent,
} from "@traycer/protocol/host/worktree-schemas";
import { inspectRepo, listBranches } from "../../git/git";
import {
  createWorktreeBinding,
  createWorktreePaths,
  deleteWorktree,
  findBinding,
  importWorktreeBinding,
  listAllWorktrees,
  removeBindingEntry,
  scriptsAtRef,
  setEntryModeLocal,
  summarizeWorkspaces,
  writeRepoScripts,
  type ListAllRequest,
} from "../../worktree/service";
import type { RpcHandler } from "./types";

export const handleWorktreeListAll: RpcHandler = async (params, runtime) => {
  const listed = await listAllWorktrees(runtime, readListAllRequest(params));
  return { ok: true, result: listed };
};

export const handleWorktreeGetBinding: RpcHandler = (params, runtime) => {
  const parsed = worktreeGetBindingRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const found = findBinding(
    runtime,
    parsed.data.epicId,
    parsed.data.ownerId,
    parsed.data.ownerKind,
  );
  if (found === undefined) {
    return { ok: true, result: { binding: null, missingWorktreePaths: [] } };
  }
  const missing = found.binding.entries
    .map((entry) => entry.worktreePath ?? entry.workspacePath)
    .filter((path) => !existsSync(path));
  return {
    ok: true,
    result: { binding: found.binding, missingWorktreePaths: missing },
  };
};

export const handleWorktreeListBindingsForEpic: RpcHandler = (
  params,
  runtime,
) => {
  const parsed = worktreeListBindingsForEpicRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const snapshot = runtime.store.snapshot();
  const bindings = snapshot.bindings.filter(
    (binding) => binding.epicId === parsed.data.epicId,
  );
  const rows = [];
  const seen = new Set<string>();
  for (const binding of bindings) {
    for (const entry of binding.binding.entries) {
      const runningDir = entry.worktreePath ?? entry.workspacePath;
      if (seen.has(runningDir)) {
        continue;
      }
      seen.add(runningDir);
      const facts = inspectRepo(runningDir);
      rows.push({
        hostId: runtime.hostId,
        runningDir,
        workspacePath: entry.workspacePath,
        worktreePath: entry.worktreePath,
        mode: entry.mode,
        isGitRepo: facts !== null,
        repoIdentifier:
          entry.repoIdentifier ?? (facts === null ? null : facts.repoIdentifier),
        branch: entry.branch ?? (facts === null ? null : facts.branch),
        isPrimary: entry.isPrimary,
        isImported: entry.isImported,
        setupState: entry.setupState,
        disabledReason: existsSync(runningDir) ? null : "missing_worktree_path",
        sources: [
          {
            ownerKind: binding.ownerKind,
            ownerId: binding.ownerId,
            workspacePath: entry.workspacePath,
            isPrimary: entry.isPrimary,
            mode: entry.mode,
          },
        ],
        isGitResolvePending: false,
      });
    }
  }
  const epic = snapshot.epics.find((row) => row.id === parsed.data.epicId);
  const ownerChat =
    snapshot.chats.find((chat) => chat.epicId === parsed.data.epicId) ?? null;
  if (epic !== undefined) {
    for (const workspacePath of epic.workspaces) {
      if (seen.has(workspacePath)) {
        continue;
      }
      seen.add(workspacePath);
      const facts = inspectRepo(workspacePath);
      rows.push({
        hostId: runtime.hostId,
        runningDir: workspacePath,
        workspacePath,
        worktreePath: null,
        mode: "local" as const,
        isGitRepo: facts !== null,
        repoIdentifier: facts === null ? null : facts.repoIdentifier,
        branch: facts === null ? null : facts.branch,
        isPrimary: true,
        isImported: false,
        setupState: "not_required" as const,
        disabledReason: existsSync(workspacePath)
          ? null
          : "missing_worktree_path",
        sources: [
          {
            ownerKind: "chat" as const,
            ownerId: ownerChat === null ? epic.id : ownerChat.chatId,
            workspacePath,
            isPrimary: true,
            mode: "local" as const,
          },
        ],
        isGitResolvePending: false,
      });
    }
  }
  return {
    ok: true,
    result: {
      rows,
      folderlessCwd: runtime.dataDir,
    },
  };
};

export const handleWorktreeCreate: RpcHandler = async (params, runtime) => {
  const latest = worktreeCreateRequestSchema.safeParse(params);
  const parsed = latest.success
    ? latest
    : worktreeCreateRequestSchemaV10.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const created = await createWorktreeBinding(runtime, {
    epicId: parsed.data.epicId,
    ownerId: parsed.data.ownerId,
    ownerKind: parsed.data.ownerKind,
    entries: parsed.data.entries,
  });
  return { ok: true, result: created };
};

export const handleWorktreeCreatePaths: RpcHandler = async (params, runtime) => {
  const latest = worktreeCreatePathsRequestSchema.safeParse(params);
  const parsed = latest.success
    ? latest
    : worktreeCreatePathsRequestSchemaV10.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const intents: WorktreeFolderIntent[] = parsed.data.entries.map((entry) => ({
    kind: "worktree",
    workspacePath: entry.workspacePath,
    repoIdentifier: null,
    isPrimary: false,
    branch: entry.branch,
    scripts: null,
  }));
  const created = await createWorktreePaths(runtime, intents);
  return { ok: true, result: created };
};

export const handleWorktreeImport: RpcHandler = async (params, runtime) => {
  const parsed = worktreeImportRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const binding = await importWorktreeBinding(runtime, parsed.data);
  return { ok: true, result: { binding } };
};

export const handleWorktreeSetEntryMode: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = worktreeSetEntryModeRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const binding = await setEntryModeLocal(
    runtime,
    parsed.data.epicId,
    parsed.data.ownerId,
    parsed.data.ownerKind,
    parsed.data.workspacePath,
  );
  if (binding === null) {
    return { ok: false, code: "RPC_ERROR", message: "Binding not found" };
  }
  return { ok: true, result: { binding } };
};

export const handleWorkspaceBindingRemoveEntry: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = workspaceBindingRemoveEntryRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const binding = await removeBindingEntry(
    runtime,
    parsed.data.epicId,
    parsed.data.ownerId,
    parsed.data.ownerKind,
    parsed.data.workspacePath,
  );
  if (binding === null) {
    return { ok: false, code: "RPC_ERROR", message: "Binding not found" };
  }
  return { ok: true, result: { binding } };
};

export const handleWorktreeDelete: RpcHandler = async (params, runtime) => {
  const parsed = worktreeDeleteRequestSchemaV12.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const deleted = await deleteWorktree(
    runtime,
    parsed.data.workspacePath,
    parsed.data.worktreePath,
  );
  return { ok: true, result: { deleted } };
};

export const handleWorktreeListBranches: RpcHandler = (params) => {
  const parsed = worktreeListBranchesRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return {
    ok: true,
    result: listBranches(parsed.data.workspacePath, parsed.data.includeRemote),
  };
};

export const handleWorktreeListByWorkspacePaths: RpcHandler = async (
  params,
) => {
  const workspacePaths = readWorkspacePaths(params);
  const scriptRefs = readScriptRefs(params);
  const workspaces = await summarizeWorkspaces(workspacePaths);
  const scriptsAtRefs = [];
  for (const ref of scriptRefs) {
    scriptsAtRefs.push({
      workspacePath: ref.workspacePath,
      ref: ref.ref,
      scripts: await scriptsAtRef(ref.workspacePath, ref.ref),
    });
  }
  return { ok: true, result: { workspaces, scriptsAtRefs } };
};

export const handleWorktreeRetrySetup: RpcHandler = (params, runtime) => {
  const parsed = worktreeRetrySetupRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const found = findBinding(
    runtime,
    parsed.data.epicId,
    parsed.data.ownerId,
    parsed.data.ownerKind,
  );
  if (found === undefined) {
    return { ok: false, code: "RPC_ERROR", message: "Binding not found" };
  }
  return {
    ok: true,
    result: { binding: found.binding, terminalSessionId: null },
  };
};

export const handleWorktreeSetRepoScripts: RpcHandler = async (params) => {
  const parsed = worktreeSetRepoScriptsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const updated = await writeRepoScripts(
    parsed.data.workspacePath,
    parsed.data.setup,
    parsed.data.teardown,
  );
  return { ok: true, result: { updated } };
};

function readListAllRequest(params: unknown): ListAllRequest {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return {
      includeActivity: false,
      activityPaths: null,
      cursor: null,
      limit: null,
      forceRefresh: false,
    };
  }
  const record = params as Record<string, unknown>;
  return {
    includeActivity: record.includeActivity === true,
    activityPaths: readStringArrayOrNull(record.activityPaths),
    cursor: typeof record.cursor === "string" ? record.cursor : null,
    limit:
      typeof record.limit === "number" &&
      Number.isInteger(record.limit) &&
      record.limit > 0
        ? record.limit
        : null,
    forceRefresh: record.forceRefresh === true,
  };
}

function readWorkspacePaths(params: unknown): readonly string[] {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return [];
  }
  const parsed = worktreeListByWorkspacePathsRequestSchemaV14.safeParse(params);
  if (parsed.success) {
    return parsed.data.workspacePaths;
  }
  const record = params as Record<string, unknown>;
  return readStringArrayOrNull(record.workspacePaths) ?? [];
}

function readScriptRefs(
  params: unknown,
): readonly { readonly workspacePath: string; readonly ref: string }[] {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return [];
  }
  const record = params as Record<string, unknown>;
  if (!Array.isArray(record.scriptRefs)) {
    return [];
  }
  const refs: { workspacePath: string; ref: string }[] = [];
  for (const entry of record.scriptRefs) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.workspacePath === "string" && typeof row.ref === "string") {
      refs.push({ workspacePath: row.workspacePath, ref: row.ref });
    }
  }
  return refs;
}

function readStringArrayOrNull(value: unknown): readonly string[] | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}
