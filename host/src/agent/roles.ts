import { randomUUID } from "node:crypto";
import {
  projectVisibleRoleClaims,
  roleClaimIdentityKey,
  type RoleClaim,
} from "@traycer/protocol/persistence/epic/role-claims";
import { LOCAL_USER_ID } from "../local-user";
import type { HostRuntime } from "../runtime";
import type { StoredRoleClaim } from "../store/host-store";

/**
 * Role claims are a durable local registry, not a permission system: an agent
 * designates ITSELF, peers read the list to avoid duplicating responsibility,
 * and overlap is reported rather than blocked.
 *
 * Every read goes through the protocol's own projection - account first, then
 * liveness, then a stable order - rather than a filter of this host's own.
 * Claims outlive their agents (a stopped agent keeps its claims, a deleted one
 * cascades nothing), so liveness is resolved on READ and reaping is only ever
 * an optimization.
 */
export function liveAgentIds(
  runtime: HostRuntime,
  epicId: string,
): ReadonlySet<string> {
  const state = runtime.store.snapshot();
  const ids = new Set<string>();
  for (const chat of state.chats) {
    if (chat.epicId === epicId) {
      ids.add(chat.chatId);
    }
  }
  for (const agent of state.agents) {
    if (agent.epicId === epicId) {
      ids.add(agent.id);
    }
  }
  for (const agent of state.tuiAgents) {
    if (agent.epicId === epicId) {
      ids.add(agent.tuiAgentId);
    }
  }
  return ids;
}

export function visibleClaims(
  runtime: HostRuntime,
  epicId: string,
): readonly RoleClaim[] {
  const rows = runtime.store
    .snapshot()
    .roleClaims.filter((claim) => claim.epicId === epicId)
    .map(wireOf);
  return projectVisibleRoleClaims(rows, {
    userId: LOCAL_USER_ID,
    liveAgentIds: liveAgentIds(runtime, epicId),
  });
}

export function wireOf(claim: StoredRoleClaim): RoleClaim {
  return {
    claimId: claim.claimId,
    agentId: claim.agentId,
    userId: claim.userId,
    role: claim.role,
    scope: claim.scope,
    claimedAt: claim.claimedAt,
  };
}

/** The wire shape drops `userId`: every read is already account-filtered. */
export function withoutUser(claim: RoleClaim): {
  readonly claimId: string;
  readonly agentId: string;
  readonly role: string;
  readonly scope: string;
  readonly claimedAt: number;
} {
  return {
    claimId: claim.claimId,
    agentId: claim.agentId,
    role: claim.role,
    scope: claim.scope,
    claimedAt: claim.claimedAt,
  };
}

/**
 * The claim this agent already holds for the same role and scope, if any.
 * Identity is case- and whitespace-insensitive, so `Planner` re-claimed as
 * `planner ` is the SAME claim and comes back untouched - which is what makes
 * a retried claim safe.
 */
export function existingClaim(
  claims: readonly RoleClaim[],
  agentId: string,
  role: string,
  scope: string,
): RoleClaim | null {
  const key = roleClaimIdentityKey({ role, scope });
  return (
    claims.find(
      (claim) =>
        claim.agentId === agentId && roleClaimIdentityKey(claim) === key,
    ) ?? null
  );
}

export function overlappingClaims(
  claims: readonly RoleClaim[],
  agentId: string,
  role: string,
  scope: string,
): readonly RoleClaim[] {
  const key = roleClaimIdentityKey({ role, scope });
  return claims.filter(
    (claim) => claim.agentId !== agentId && roleClaimIdentityKey(claim) === key,
  );
}

export function newClaim(
  epicId: string,
  agentId: string,
  role: string,
  scope: string,
  now: number,
): StoredRoleClaim {
  return {
    claimId: randomUUID(),
    epicId,
    agentId,
    userId: LOCAL_USER_ID,
    role,
    scope,
    claimedAt: now,
  };
}
