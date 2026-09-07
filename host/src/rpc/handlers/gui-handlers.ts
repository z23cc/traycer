import { agentInboxAckRequestSchema } from "@traycer/protocol/host/agent/inbox";
import {
  getGuiAgentPlanRequestSchema,
  listGuiAgentCommandsRequestSchema,
  listGuiAgentModelsRequestSchema,
  listGuiHarnessesRequestSchema,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import {
  agentInboxReadRequestSchema,
  agentInboxReadRequestSchemaV20,
} from "@traycer/protocol/host/agent/inbox";
import { listHarnessModelsRequestSchema } from "@traycer/protocol/host/agent/shared";
import {
  listGuiCommands,
  listGuiHarnesses,
  listGuiModels,
  listHarnessModels,
} from "../../gui/catalog";
import type { RpcHandler } from "./types";
import { planBlockSchema } from "@traycer/protocol/persistence/epic/content-blocks";
import { readBlob, snapshotDir } from "../../snapshots/snapshots";

export const handleGuiListHarnesses: RpcHandler = (params, runtime) => {
  const parsed = listGuiHarnessesRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return { ok: true, result: { harnesses: listGuiHarnesses(runtime) } };
};

export const handleGuiListModels: RpcHandler = async (params, runtime) => {
  const parsed = listGuiAgentModelsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return {
    ok: true,
    result: await listGuiModels(runtime, parsed.data.harnessId),
  };
};

export const handleGuiListCommands: RpcHandler = (params) => {
  const parsed = listGuiAgentCommandsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return { ok: true, result: listGuiCommands(parsed.data.harnessId) };
};

/**
 * A plan's markdown, the way the released host serves it: found by plan id
 * among the chat's plan blocks - the running turn's first, then the
 * persisted ones - and read inline when the block carries it whole, or from
 * the blob store when the block carries a content ref, `blob_missing` when
 * that blob is gone.
 */
export const handleGuiGetPlan: RpcHandler = async (params, runtime) => {
  const parsed = getGuiAgentPlanRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const chat = runtime.store
    .snapshot()
    .chats.find((row) => row.chatId === parsed.data.chatId);
  if (chat === undefined || chat.epicId !== parsed.data.epicId) {
    return {
      ok: false,
      code: "RPC_ERROR",
      message: `agent.gui.getPlan: CHAT_NOT_FOUND - '${parsed.data.chatId}'.`,
    };
  }
  const candidates: unknown[] = [
    ...runtime.guiRuns.blocksOf(parsed.data.chatId),
    ...chat.turns.flatMap((turn) => turn.blocks ?? []),
  ];
  const found = candidates.find(
    (block) =>
      block !== null &&
      typeof block === "object" &&
      Reflect.get(block, "type") === "plan" &&
      Reflect.get(block, "planId") === parsed.data.planId,
  );
  const plan = planBlockSchema.safeParse(found);
  if (!plan.success) {
    return {
      ok: false,
      code: "RPC_ERROR",
      message: `agent.gui.getPlan: PLAN_NOT_FOUND - '${parsed.data.planId}'.`,
    };
  }
  const block = plan.data;
  if (block.fullContentRef === null) {
    return {
      ok: true,
      result: {
        planId: block.planId,
        markdown: block.markdownPreview,
        source: block.source,
        planStatus: block.planStatus,
        contentHash: null,
        unavailableReason: null,
      },
    };
  }
  const markdown = await readBlob(
    snapshotDir(runtime.dataDir),
    block.fullContentRef.hash,
  );
  return {
    ok: true,
    result: {
      planId: block.planId,
      markdown: markdown ?? block.markdownPreview,
      source: block.source,
      planStatus: block.planStatus,
      contentHash: block.fullContentRef.hash,
      unavailableReason: markdown === null ? "blob_missing" : null,
    },
  };
};

export const handleListHarnessModels: RpcHandler = async (params, runtime) => {
  const parsed = listHarnessModelsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return {
    ok: true,
    result: await listHarnessModels(runtime, parsed.data.harnessId),
  };
};

export const handleInboxRead: RpcHandler = (params, runtime) => {
  const latest = agentInboxReadRequestSchemaV20.safeParse(params);
  if (latest.success) {
    return {
      ok: true,
      result: runtime.inbox.read(latest.data.agentId, latest.data.after),
    };
  }
  const legacy = agentInboxReadRequestSchema.safeParse(params);
  if (!legacy.success) {
    return { ok: false, code: "RPC_ERROR", message: latest.error.message };
  }
  return {
    ok: true,
    result: runtime.inbox.read(legacy.data.agentId, null),
  };
};

export const handleInboxAck: RpcHandler = (params, runtime) => {
  const parsed = agentInboxAckRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  runtime.inbox.ack(parsed.data.agentId, parsed.data.eventIds);
  return { ok: true, result: {} };
};
