import type {
  WorktreeBinding,
  WorktreeBindingOwnerKind,
  WorktreeBindingWorkspaceMode,
  WorktreeCreateRequest,
  WorktreeCreateResponse,
  WorktreeFolderIntent,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import { HostState, StoreError } from "./store";

export type WorktreeIntentResolution = {
  readonly epicId: string;
  readonly ownerId: string;
  readonly ownerKind: WorktreeBindingOwnerKind;
  readonly workspaceMode: WorktreeBindingWorkspaceMode | undefined;
  readonly intent: WorktreeIntent | null | undefined;
  readonly wrapThrownErrors: boolean;
};

export async function materializeWorktreeIntentOrThrow(
  state: HostState,
  request: WorktreeIntentResolution,
): Promise<WorktreeBinding | null> {
  const entries = entriesForResolution(request.workspaceMode, request.intent);
  if (entries === null) {
    return null;
  }

  let response: WorktreeCreateResponse;
  try {
    response = await state.createWorktree({
      epicId: request.epicId,
      ownerId: request.ownerId,
      ownerKind: request.ownerKind,
      entries,
    });
  } catch (error) {
    if (!request.wrapThrownErrors) {
      throw error;
    }
    throw new StoreError(
      "WORKTREE_CREATE_FAILED",
      error instanceof Error ? error.message : String(error),
    );
  }

  const failures = response.perEntry.filter((result) => !result.ok);
  const missing = entries.filter(
    (entry) =>
      !response.binding.entries.some(
        (bindingEntry) =>
          bindingEntry.workspacePath === entry.workspacePath,
      ),
  );
  if (failures.length === 0 && missing.length === 0) {
    return response.binding;
  }

  const reasons = failures.map((failure) => {
    if (failure.errorMessage !== null) {
      return failure.errorMessage;
    }
    const source = entries.find(
      (entry) => entry.workspacePath === failure.workspacePath,
    );
    return source?.kind === "worktree"
      ? `Couldn't create worktree for ${failure.workspacePath}`
      : `Couldn't prepare workspace ${failure.workspacePath}`;
  });
  for (const entry of missing) {
    if (
      failures.some(
        (failure) => failure.workspacePath === entry.workspacePath,
      )
    ) {
      continue;
    }
    reasons.push(
      entry.kind === "worktree"
        ? `Couldn't create worktree for ${entry.workspacePath}`
        : `Couldn't prepare workspace ${entry.workspacePath}`,
    );
  }
  throw new StoreError("WORKTREE_CREATE_FAILED", reasons.join("\n"));
}

function entriesForResolution(
  workspaceMode: WorktreeBindingWorkspaceMode | undefined,
  intent: WorktreeIntent | null | undefined,
): WorktreeCreateRequest["entries"] | null {
  if (workspaceMode === "folderless") {
    return [];
  }
  if (intent === null || intent === undefined) {
    return null;
  }
  return intent.entries.map(canonicalCreateEntry);
}

function canonicalCreateEntry(
  entry: WorktreeFolderIntent,
): WorktreeCreateRequest["entries"][number] {
  if (entry.kind !== "worktree") {
    return entry;
  }
  if (entry.branch.type === "existing") {
    return { ...entry, branch: { ...entry.branch } };
  }
  const branch = entry.branch;
  if (branch.collision === "random") {
    return { ...entry, branch };
  }
  return {
    ...entry,
    branch: {
      type: "new",
      name: branch.name,
      source: branch.source,
      carryUncommittedChanges: branch.carryUncommittedChanges,
      collision: "fail",
    },
  };
}
