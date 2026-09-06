import {
  generateTuiAgentTitleRequestSchema,
  listTuiHarnessesRequestSchema,
  prepareTuiLaunchRequestSchemaV11,
  recordTuiAgentActivityRequestSchemaV11,
  tuiAgentPromptSubmittedRequestSchemaV11,
  tuiAgentTurnEndedRequestSchema,
} from "@traycer/protocol/host/agent/tui/unary-schemas";
import {
  createTuiAgentRequestSchema,
  deleteTuiAgentRequestSchema,
  renameTuiAgentRequestSchema,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  listTuiAgentsRequestSchema,
  listTuiAgentsRequestV11Schema,
} from "@traycer/protocol/host/epic/tui-agent-records";
import {
  createTuiAgent,
  deleteTuiAgent,
  generateTuiTitle,
  listTuiHarnesses,
  prepareTuiLaunch,
  recordTuiActivity,
  recordTuiPromptSubmitted,
  recordTuiTurnEnded,
  renameTuiAgent,
} from "../../tui/service";
import type { RpcHandler } from "./types";

export const handleTuiListHarnesses: RpcHandler = (params, runtime) => {
  const parsed = listTuiHarnessesRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return { ok: true, result: { harnesses: listTuiHarnesses(runtime) } };
};

export const handleTuiPrepareLaunch: RpcHandler = async (params, runtime) => {
  const parsed = prepareTuiLaunchRequestSchemaV11.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  try {
    const prepared = await prepareTuiLaunch(runtime, parsed.data);
    return { ok: true, result: prepared };
  } catch (error) {
    return {
      ok: false,
      code: "RPC_ERROR",
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

export const handleEpicCreateTuiAgent: RpcHandler = async (params, runtime) => {
  const parsed = createTuiAgentRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  try {
    const created = await createTuiAgent(runtime, parsed.data);
    return { ok: true, result: created };
  } catch (error) {
    return {
      ok: false,
      code: "RPC_ERROR",
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

export const handleEpicDeleteTuiAgent: RpcHandler = async (params, runtime) => {
  const parsed = deleteTuiAgentRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const deleted = await deleteTuiAgent(
    runtime,
    parsed.data.epicId,
    parsed.data.tuiAgentId,
  );
  return { ok: true, result: { deleted } };
};

export const handleTuiGenerateTitle: RpcHandler = async (params, runtime) => {
  const parsed = generateTuiAgentTitleRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  try {
    return { ok: true, result: await generateTuiTitle(runtime, parsed.data) };
  } catch (error) {
    return {
      ok: false,
      code: "RPC_ERROR",
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

export const handleTuiRecordActivity: RpcHandler = async (params, runtime) => {
  const parsed = recordTuiAgentActivityRequestSchemaV11.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return { ok: true, result: await recordTuiActivity(runtime, parsed.data) };
};

export const handleTuiTurnEnded: RpcHandler = (params, runtime) => {
  const parsed = tuiAgentTurnEndedRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return { ok: true, result: recordTuiTurnEnded(runtime, parsed.data) };
};

export const handleTuiPromptSubmitted: RpcHandler = async (params, runtime) => {
  const parsed = tuiAgentPromptSubmittedRequestSchemaV11.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return {
    ok: true,
    result: await recordTuiPromptSubmitted(runtime, parsed.data),
  };
};

export const handleEpicRenameTuiAgent: RpcHandler = async (params, runtime) => {
  const parsed = renameTuiAgentRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const updated = await renameTuiAgent(
    runtime,
    parsed.data.epicId,
    parsed.data.tuiAgentId,
    parsed.data.title,
  );
  return { ok: true, result: { updated } };
};

export const handleEpicListTuiAgents: RpcHandler = (params) => {
  const parsedV11 = listTuiAgentsRequestV11Schema.safeParse(params);
  const parsedV10 = listTuiAgentsRequestSchema.safeParse(params);
  if (!parsedV11.success && !parsedV10.success) {
    return { ok: false, code: "RPC_ERROR", message: parsedV10.error.message };
  }
  return { ok: true, result: { tuiAgents: [] } };
};
