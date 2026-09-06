import {
  managedCommandConfigureRequestSchema,
  managedCommandControlRequestSchema,
  managedCommandDeleteRequestSchema,
  managedCommandDeliverHeldRequestSchema,
} from "@traycer/protocol/host/managed-command/unary-schemas";
import type { HostRuntime } from "../../runtime";
import type { RpcHandler } from "./types";

/**
 * Managed commands are supervised shells the AGENT authors, through the
 * `traycer_*_shell` tool set. This host serves no such tool, so nothing here
 * can create one and the set is empty by construction - which is exactly what
 * `chat.subscribe` has always published (`managedCommands: []`).
 *
 * The id-addressed controls therefore refuse. That refusal is the alignment:
 * the analog answered `start` with a fabricated `{id:"oss", state:"running"}`,
 * so a viewer saw a shell that does not exist, with a pid, and a Stop button
 * that would report success forever. The response schemas have no "not found"
 * arm - a command is either returned or the call fails - so an unknown id is
 * an error, and an id from another epic is answered identically, which is what
 * keeps the surface from being used to probe for commands.
 *
 * No registry is persisted for the same reason: a store field nothing writes
 * is scaffolding. The day a creation surface lands, it lands with one.
 */
function noSuchCommand(
  commandId: string,
  epicId: string,
): {
  readonly ok: false;
  readonly code: "RPC_ERROR";
  readonly message: string;
} {
  return {
    ok: false,
    code: "RPC_ERROR",
    message: `No managed command '${commandId}' in epic '${epicId}'.`,
  };
}

export const handleManagedCommandStart: RpcHandler = (params) => {
  const parsed = managedCommandControlRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return noSuchCommand(parsed.data.commandId, parsed.data.epicId);
};

export const handleManagedCommandStop: RpcHandler = (params) => {
  const parsed = managedCommandControlRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return noSuchCommand(parsed.data.commandId, parsed.data.epicId);
};

export const handleManagedCommandConfigure: RpcHandler = (params) => {
  const parsed = managedCommandConfigureRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return noSuchCommand(parsed.data.commandId, parsed.data.epicId);
};

/**
 * Delete is the one control with no post-state to report, so an id that never
 * existed and an id that just stopped existing are indistinguishable by
 * design - the echo is what lets a caller tear down its window either way.
 */
export const handleManagedCommandDelete: RpcHandler = (params) => {
  const parsed = managedCommandDeleteRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return { ok: true, result: { commandId: parsed.data.commandId } };
};

/**
 * `epicId` is load-bearing for AUTHORIZATION here, not decoration: the durable
 * hold rows carry a chat and no epic, so a scan keyed on the chat alone would
 * answer for a chat the caller named but has no rights to. The chat is proved
 * to belong to the epic first; then, with no managed commands on this host,
 * there is genuinely nothing held.
 */
export const handleManagedCommandDeliverHeld: RpcHandler = (
  params,
  runtime: HostRuntime,
) => {
  const parsed = managedCommandDeliverHeldRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const chat = runtime.store
    .snapshot()
    .chats.find(
      (row) =>
        row.chatId === parsed.data.chatId && row.epicId === parsed.data.epicId,
    );
  if (chat === undefined) {
    return {
      ok: false,
      code: "RPC_ERROR",
      message: `No chat '${parsed.data.chatId}' in epic '${parsed.data.epicId}'.`,
    };
  }
  return {
    ok: true,
    result: { released: [], unresolved: [], unattributed: [], held: [] },
  };
};
