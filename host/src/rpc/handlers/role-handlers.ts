import {
  claimAgentRoleRequestSchema,
  listAgentRolesRequestSchema,
  relinquishAgentRoleRequestSchema,
  type RoleAwarenessEvent,
} from "@traycer/protocol/host/agent/roles";
import type { RoleClaim } from "@traycer/protocol/persistence/epic/role-claims";
import {
  existingClaim,
  liveAgentIds,
  newClaim,
  overlappingClaims,
  visibleClaims,
  withoutUser,
} from "../../agent/roles";
import type { HostRuntime } from "../../runtime";
import type { RpcHandler } from "./types";

/**
 * Who this host managed to tell, in the contract's own narrow words.
 *
 * A TUI peer has a durable inbox here, so an enqueued notice is `deliveredTo`
 * - the commit point was reached, which is all the word ever promised. A GUI
 * peer is `unreachable` by design: this host does not wake an idle GUI agent
 * to hand it a courtesy notice, and the contract names exactly that case,
 * because reading the registry on its next prompt costs the agent nothing.
 *
 * Awareness NEVER rolls back the registry - a claim is durable responsibility
 * and this is a broadcast to whoever happened to be listening. Only the @1.1
 * shape is built: dispatch projects it down for a @1.0 caller, which folds
 * `deferredToPrompt` into `unreachable`.
 */
function announce(
  runtime: HostRuntime,
  event: RoleAwarenessEvent,
): {
  readonly deliveredTo: string[];
  readonly deferredToPrompt: string[];
  readonly unreachable: string[];
  readonly failed: { readonly agentId: string; readonly reason: string }[];
} {
  const deliveredTo: string[] = [];
  const unreachable: string[] = [];
  const failed: { readonly agentId: string; readonly reason: string }[] = [];
  const monitored = new Set<string>();
  for (const monitor of runtime.inboxMonitors.inEpic(event.epicId)) {
    if (monitor.agentId === event.claim.agentId) {
      continue;
    }
    monitored.add(monitor.agentId);
    if (monitor.announce(event)) {
      deliveredTo.push(monitor.agentId);
      continue;
    }
    // A monitor that negotiated `@1.0` never agreed to receive this frame,
    // and one whose socket has gone is not reachable either.
    unreachable.push(monitor.agentId);
  }
  const state = runtime.store.snapshot();
  for (const agent of [
    ...state.tuiAgents.map((row) => ({
      id: row.tuiAgentId,
      epicId: row.epicId,
    })),
    ...state.chats.map((row) => ({ id: row.chatId, epicId: row.epicId })),
  ]) {
    if (
      agent.epicId === event.epicId &&
      agent.id !== event.claim.agentId &&
      !monitored.has(agent.id)
    ) {
      // Nothing was attempted: awareness is never queued, and waking an idle
      // agent to hand it a courtesy notice costs more than letting it read
      // current roles from its next prompt.
      unreachable.push(agent.id);
    }
  }
  return { deliveredTo, deferredToPrompt: [], unreachable, failed };
}

export const handleAgentRolesClaim: RpcHandler = async (params, runtime) => {
  const parsed = claimAgentRoleRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const request = parsed.data;
  // `claimantAgentId` is an ATTRIBUTION, not a proof: an id naming no agent of
  // this epic is refused rather than minting a claim for a stranger.
  if (!liveAgentIds(runtime, request.epicId).has(request.claimantAgentId)) {
    return {
      ok: false,
      code: "RPC_ERROR",
      message: `agent.roles.claim: '${request.claimantAgentId}' is not an agent of epic '${request.epicId}'.`,
    };
  }
  const before = visibleClaims(runtime, request.epicId);
  const held = existingClaim(
    before,
    request.claimantAgentId,
    request.role,
    request.scope,
  );
  const overlapping = overlappingClaims(
    before,
    request.claimantAgentId,
    request.role,
    request.scope,
  ).map(withoutUser);
  if (held !== null) {
    // A retry, not a duplicate: the existing claim comes back untouched and
    // nothing is announced, because nothing changed.
    return {
      ok: true,
      result: {
        claim: withoutUser(held),
        created: false,
        overlapping,
        awareness: {
          deliveredTo: [],
          deferredToPrompt: [],
          unreachable: [],
          failed: [],
        },
      },
    };
  }
  const minted = newClaim(
    request.epicId,
    request.claimantAgentId,
    request.role,
    request.scope,
    Date.now(),
  );
  await runtime.store.mutate((state) => {
    state.roleClaims.push(minted);
  });
  return {
    ok: true,
    result: {
      claim: withoutUser({ ...minted }),
      created: true,
      overlapping,
      awareness: announce(runtime, {
        kind: "role-claimed",
        epicId: request.epicId,
        claim: withoutUser({ ...minted }),
        at: minted.claimedAt,
      }),
    },
  };
};

export const handleAgentRolesList: RpcHandler = (params, runtime) => {
  const parsed = listAgentRolesRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return {
    ok: true,
    result: {
      claims: visibleClaims(runtime, parsed.data.epicId).map(withoutUser),
    },
  };
};

export const handleAgentRolesRelinquish: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = relinquishAgentRoleRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const request = parsed.data;
  const held: RoleClaim | undefined = visibleClaims(
    runtime,
    request.epicId,
  ).find(
    (claim) =>
      claim.claimId === request.claimId &&
      claim.agentId === request.claimantAgentId,
  );
  // A double relinquish, and a claim belonging to another account, are both
  // "not released" rather than an error - reporting them apart would let a
  // caller probe for claims it may not see.
  if (held === undefined) {
    return {
      ok: true,
      result: {
        released: false,
        awareness: {
          deliveredTo: [],
          deferredToPrompt: [],
          unreachable: [],
          failed: [],
        },
      },
    };
  }
  await runtime.store.mutate((state) => {
    state.roleClaims = state.roleClaims.filter(
      (claim) => claim.claimId !== request.claimId,
    );
  });
  return {
    ok: true,
    result: {
      released: true,
      awareness: announce(runtime, {
        kind: "role-relinquished",
        epicId: request.epicId,
        claim: withoutUser(held),
        at: Date.now(),
      }),
    },
  };
};
