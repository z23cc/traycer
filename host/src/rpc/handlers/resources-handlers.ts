import {
  resourcesKillRequestSchema,
  resourcesListLocalServersRequestSchema,
} from "@traycer/protocol/host/resources/subscribe";
import {
  worktreeListHoldersRequestSchema,
  worktreeSetRepoBranchPrefixRequestSchema,
} from "@traycer/protocol/host/worktree-schemas";
import {
  attributedPids,
  killAttributed,
  listeningServers,
} from "../../gui/local-servers";
import {
  holdersForOwner,
  holdersForWorktreePath,
  holdersRevision,
} from "../../worktree/holders";
import { writeRepoBranchPrefix } from "../../worktree/service";
import type { RpcHandler } from "./types";

export const handleResourcesListLocalServers: RpcHandler = (
  params,
  runtime,
) => {
  const parsed = resourcesListLocalServersRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return {
    ok: true,
    result: {
      servers: listeningServers(attributedPids(runtime, parsed.data.epicId)),
    },
  };
};

/**
 * A pid is an address, not a capability, and this request carries bare pids
 * with no epic to scope them. So the kill set is intersected with the
 * processes this host actually started - its own PTYs and their descendants,
 * across every epic - and anything else is silently not killed, which is what
 * the response already models by reporting only what it killed.
 *
 * Without that intersection this method would be a remote `kill(2)` for any
 * pid on the machine, this host's own supervisor included.
 */
export const handleResourcesKill: RpcHandler = (params, runtime) => {
  const parsed = resourcesKillRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const attributed = new Set<number>();
  for (const epic of runtime.store.snapshot().epics) {
    for (const pid of attributedPids(runtime, epic.id)) {
      attributed.add(pid);
    }
  }
  return {
    ok: true,
    result: { killed: killAttributed(parsed.data.pids, attributed) },
  };
};

/**
 * Holders of a worktree, or of one owner. `owner` present switches the
 * question from "who holds this path" to "what does this owner hold", and the
 * path is deliberately not applied as a filter in that mode - a rebind
 * disclosure needs the paths the owner is dropping too.
 *
 * An unknown path or owner is `{ holders: [] }`, never an error.
 */
export const handleWorktreeListHolders: RpcHandler = (params, runtime) => {
  const parsed = worktreeListHoldersRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const holders =
    parsed.data.owner === null
      ? holdersForWorktreePath(runtime, parsed.data.worktreePath)
      : holdersForOwner(runtime, parsed.data.owner);
  return {
    ok: true,
    result: { holders, holdersRevision: holdersRevision(holders) },
  };
};

export const handleWorktreeSetRepoBranchPrefix: RpcHandler = async (params) => {
  const parsed = worktreeSetRepoBranchPrefixRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const updated = await writeRepoBranchPrefix(
    parsed.data.workspacePath,
    parsed.data.branchPrefix,
  );
  return { ok: true, result: { updated } };
};
