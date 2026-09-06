import { createHash } from "node:crypto";
import type {
  WorktreeBusyHolder,
  WorktreeBusyOwnerRef,
} from "@traycer/protocol/framework/worktree-busy-holders";
import type { HostRuntime } from "../runtime";
import type { StoredBinding } from "../store/host-store";

/**
 * Who is holding a worktree right now.
 *
 * A holder is an OWNER of a binding that names the path, not the path's own
 * disk state: the question the surface asks before a rebind or a delete is
 * "whose work would this disturb", and only the binding table knows that.
 *
 * `activity` separates the two answers a person acts on differently: a chat
 * with a turn in flight, or a terminal agent with a live PTY, is `working` and
 * the action should be refused; an idle owner still holds the worktree, but
 * the surface can offer to take it.
 */
export function holdersForWorktreePath(
  runtime: HostRuntime,
  worktreePath: string,
): readonly WorktreeBusyHolder[] {
  return runtime.store
    .snapshot()
    .bindings.filter((binding) => bindingCovers(binding, worktreePath))
    .map((binding) => holderOf(runtime, binding));
}

/**
 * An owner's holders across every path it binds - deliberately NOT filtered
 * by the request's path. A rebind disclosure has to show the paths this owner
 * is DROPPING as well as the one it is taking, and those are exactly the rows
 * a path filter would remove.
 */
export function holdersForOwner(
  runtime: HostRuntime,
  owner: WorktreeBusyOwnerRef,
): readonly WorktreeBusyHolder[] {
  return runtime.store
    .snapshot()
    .bindings.filter(
      (binding) =>
        binding.epicId === owner.epicId &&
        binding.ownerId === owner.ownerId &&
        binding.ownerKind === owner.ownerKind,
    )
    .map((binding) => holderOf(runtime, binding));
}

/**
 * SHA-256 over the inventory, so a client can echo it back as
 * `expectedHoldersRevision` without a parse round trip. Order-stable: the
 * digest must not change because two holders were enumerated the other way
 * around.
 */
export function holdersRevision(
  holders: readonly WorktreeBusyHolder[],
): string {
  const canonical = holders
    .map((holder) =>
      [
        holder.ownerRef.epicId,
        holder.ownerRef.ownerKind,
        holder.ownerRef.ownerId,
        holder.holdKind,
        holder.activity,
        holder.label,
      ].join(" "),
    )
    .toSorted();
  return createHash("sha256").update(canonical.join("")).digest("hex");
}

function bindingCovers(binding: StoredBinding, worktreePath: string): boolean {
  return binding.binding.entries.some(
    (entry) => entry.worktreePath === worktreePath,
  );
}

function holderOf(
  runtime: HostRuntime,
  binding: StoredBinding,
): WorktreeBusyHolder {
  const state = runtime.store.snapshot();
  const isChat = binding.ownerKind === "chat";
  const label = isChat
    ? (state.chats.find((row) => row.chatId === binding.ownerId)?.title ?? "")
    : (state.tuiAgents.find((row) => row.tuiAgentId === binding.ownerId)
        ?.title ?? "");
  const working = isChat
    ? runtime.guiRuns.printState(binding.ownerId) !== null
    : runtime.terminals.get(binding.ownerId)?.status === "running";
  return {
    ownerRef: {
      epicId: binding.epicId,
      ownerKind: binding.ownerKind,
      ownerId: binding.ownerId,
    },
    holdKind: isChat ? "chat-turn" : "terminal-agent-pty",
    activity: working ? "working" : "idle",
    label: label.length > 0 ? label : binding.ownerId,
    holderId: binding.ownerId,
  };
}
