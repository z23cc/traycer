import {
  TRAYCER_SYSTEM_SENDER_AGENT_ID,
  claimAgentRoleRequestSchema,
  listAgentRolesRequestSchema,
  relinquishAgentRoleRequestSchema,
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
  epicId: string,
  claimantAgentId: string,
  notice: string,
): {
  readonly deliveredTo: string[];
  readonly deferredToPrompt: string[];
  readonly unreachable: string[];
  readonly failed: never[];
} {
  const state = runtime.store.snapshot();
  const deliveredTo: string[] = [];
  const unreachable: string[] = [];
  for (const agent of state.tuiAgents) {
    if (agent.epicId !== epicId || agent.tuiAgentId === claimantAgentId) {
      continue;
    }
    runtime.inbox.enqueue({
      epicId,
      toAgentId: agent.tuiAgentId,
      fromAgentId: TRAYCER_SYSTEM_SENDER_AGENT_ID,
      senderTitle: null,
      senderHarnessId: null,
      prompt: notice,
      expectsReply: false,
      responseId: null,
    });
    deliveredTo.push(agent.tuiAgentId);
  }
  for (const chat of state.chats) {
    if (chat.epicId === epicId && chat.chatId !== claimantAgentId) {
      unreachable.push(chat.chatId);
    }
  }
  return { deliveredTo, deferredToPrompt: [], unreachable, failed: [] };
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
      awareness: announce(
        runtime,
        request.epicId,
        request.claimantAgentId,
        `${request.claimantAgentId} claimed the role "${request.role}" for scope "${request.scope}".`,
      ),
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
      awareness: announce(
        runtime,
        request.epicId,
        request.claimantAgentId,
        `${request.claimantAgentId} relinquished the role "${held.role}" for scope "${held.scope}".`,
      ),
    },
  };
};
