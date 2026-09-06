import {
  createAgentRequestSchemaV30,
  getAgentTranscriptRequestSchema,
  listAgentsRequestSchema,
  sendAgentMessageRequestSchema,
  stopAgentRequestSchema,
} from "@traycer/protocol/host/agent/shared";
import {
  agentTranscript,
  createLocalAgent,
  listLocalAgents,
  sendLocalAgentMessage,
  stopLocalAgent,
} from "../../agent/service";
import type { RpcHandler } from "./types";

export const handleAgentCreate: RpcHandler = async (params, runtime) => {
  const parsed = createAgentRequestSchemaV30.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const created = await createLocalAgent(runtime, {
    senderAgentId: parsed.data.senderAgentId,
    epicId: parsed.data.epicId,
    name: parsed.data.name,
    surface: parsed.data.surface,
    harnessId: parsed.data.harnessId,
  });
  return { ok: true, result: created };
};

export const handleAgentSendMessage: RpcHandler = async (params, runtime) => {
  const parsed = sendAgentMessageRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  try {
    const sent = await sendLocalAgentMessage(runtime, parsed.data);
    return { ok: true, result: sent };
  } catch (error) {
    return {
      ok: false,
      code: "RPC_ERROR",
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

export const handleAgentList: RpcHandler = (params, runtime) => {
  const parsed = listAgentsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return {
    ok: true,
    result: listLocalAgents(
      runtime,
      parsed.data.epicId,
      parsed.data.senderAgentId,
      parsed.data.scope,
    ),
  };
};

export const handleAgentGetTranscript: RpcHandler = (params, runtime) => {
  const parsed = getAgentTranscriptRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return {
    ok: true,
    result: { transcript: agentTranscript(runtime, parsed.data.agentId) },
  };
};

export const handleAgentStop: RpcHandler = async (params, runtime) => {
  const parsed = stopAgentRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const stoppedAgentIds = await stopLocalAgent(
    runtime,
    parsed.data.agentId,
    parsed.data.cascade,
  );
  return { ok: true, result: { stoppedAgentIds } };
};
