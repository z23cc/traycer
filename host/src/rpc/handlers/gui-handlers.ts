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

export const handleGuiGetPlan: RpcHandler = (params, runtime) => {
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
  const agent = runtime.store
    .snapshot()
    .agents.find((row) => row.id === parsed.data.chatId);
  const harnessId =
    agent === undefined || agent.harnessId === null ? "claude" : agent.harnessId;
  return {
    ok: true,
    result: {
      planId: parsed.data.planId,
      markdown: "",
      source: {
        harnessId,
        sessionId: null,
        turnId: null,
        kind: "unknown",
      },
      planStatus: "drafting",
      contentHash: null,
      unavailableReason: "blob_missing",
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
