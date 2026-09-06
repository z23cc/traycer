import {
  agentSelectionGuideGlobalGetRequestSchema,
  agentSelectionGuideGlobalOnboardingDraftGetRequestSchema,
  agentSelectionGuideGlobalResetRequestSchema,
  agentSelectionGuideGlobalSetRequestSchema,
  agentSelectionGuideRequestSchema,
} from "@traycer/protocol/host/agent/shared";
import { speechGetModelStatusRequestSchema } from "@traycer/protocol/host/speech/contracts";
import {
  snapshotsClearLocalSnapshotsRequestSchema,
  snapshotsReadSnapshotDiffRequestSchema,
} from "@traycer/protocol/host/snapshot-schemas";
import { hostRestartRequestSchema } from "@traycer/protocol/host/restart/schemas";
import { rateLimitUsageRequestSchemaV40 } from "@traycer/protocol/host/rate-limit/schemas";
import type { RpcHandler } from "./types";
import { HOST_PROTOCOL_VERSION } from "../../version";
import { hostBusyVerdict } from "../../gui/busy";
import { readProviderRateLimits } from "../../gui/provider-rate-limits";

const SPEECH_STATUS = {
  modelId: "default",
  installed: false,
  downloadState: "absent" as const,
  downloadProgress: null,
  sizeBytes: null,
  errorMessage: null,
  engineAvailable: false,
};

const GENERATED_GUIDE = `# Agent selection

Prefer the coding agent the user already has installed.
`;

export const handleHostStatus: RpcHandler = (_params, runtime) => {
  const verdict = hostBusyVerdict(runtime);
  return {
    ok: true,
    result: {
      ready: true,
      hostVersion: runtime.hostVersion,
      protocolVersion: HOST_PROTOCOL_VERSION,
      busy: verdict.busySessionCount > 0,
      busySessionCount: verdict.busySessionCount,
      updateProgress: null,
      busyBreakdown: verdict.busyBreakdown,
      updateOperation: { kind: "none" },
      updateTransaction: {
        recordSchemaVersion: 2,
        authority: "legacy",
      },
    },
  };
};

export const handleHostRestart: RpcHandler = (params, runtime) => {
  const parsed = hostRestartRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  if (runtime.lastRestartTransitionId === parsed.data.transitionId) {
    return { ok: true, result: { outcome: "accepted" } };
  }
  const verdict = hostBusyVerdict(runtime);
  if (verdict.busySessionCount > 0) {
    return {
      ok: true,
      result: { outcome: "busy", verdict },
    };
  }
  runtime.lastRestartTransitionId = parsed.data.transitionId;
  runtime.requestRestart();
  return { ok: true, result: { outcome: "accepted" } };
};

export const handleRuntimeCapabilities: RpcHandler = () => ({
  ok: true,
  result: {
    chatMessageList: {
      status: "available",
      provider: "virtuoso-message-list",
      licenseMode: "development-trial",
      licenseKey: "",
    },
  },
});

const APERTURE_TOKEN_BUDGET = 15;

export const handleRateLimitUsage: RpcHandler = async (params, runtime) => {
  const parsed = rateLimitUsageRequestSchemaV40.safeParse(
    params === undefined || params === null ? {} : params,
  );
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const providerId = parsed.data.providerId;
  if (providerId === undefined) {
    return {
      ok: true,
      result: {
        totalTokens: APERTURE_TOKEN_BUDGET,
        remainingTokens: APERTURE_TOKEN_BUDGET,
        providerRateLimits: null,
      },
    };
  }
  const providerRateLimits = await readProviderRateLimits(
    runtime,
    providerId,
    parsed.data.profileId,
  );
  return {
    ok: true,
    result: {
      totalTokens: 0,
      remainingTokens: 0,
      providerRateLimits,
    },
  };
};

export const handleSnapshotSize: RpcHandler = () => ({
  ok: true,
  result: { bytes: 0 },
});

export const handleSnapshotClear: RpcHandler = (params) => {
  const parsed = snapshotsClearLocalSnapshotsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return { ok: true, result: { clearedBytes: 0 } };
};

export const handleSnapshotReadDiff: RpcHandler = (params) => {
  const parsed = snapshotsReadSnapshotDiffRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return {
    ok: true,
    result: {
      beforeContent: null,
      afterContent: null,
      reason: "blob_missing",
    },
  };
};

export const handleEditorOpenPaths: RpcHandler = () => ({
  ok: true,
  result: {},
});

export const handleSelectionGuide: RpcHandler = (params, runtime) => {
  const parsed = agentSelectionGuideRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const content = runtime.store.snapshot().selectionGuide ?? GENERATED_GUIDE;
  return {
    ok: true,
    result: {
      status: "found",
      sources: [
        {
          kind: "global",
          path: "~/.traycer/agent-selection-guide.md",
          priority: 0,
          content,
        },
      ],
    },
  };
};

export const handleSelectionGuideGlobalGet: RpcHandler = (params, runtime) => {
  const parsed = agentSelectionGuideGlobalGetRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return {
    ok: true,
    result: {
      content: runtime.store.snapshot().selectionGuide ?? GENERATED_GUIDE,
      generatedDefaultContent: GENERATED_GUIDE,
    },
  };
};

export const handleSelectionGuideGlobalSet: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = agentSelectionGuideGlobalSetRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  await runtime.store.mutate((state) => {
    state.selectionGuide = parsed.data.content;
  });
  return {
    ok: true,
    result: {
      content: parsed.data.content,
      generatedDefaultContent: GENERATED_GUIDE,
    },
  };
};

export const handleSelectionGuideGlobalReset: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = agentSelectionGuideGlobalResetRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  await runtime.store.mutate((state) => {
    state.selectionGuide = null;
  });
  return {
    ok: true,
    result: {
      content: GENERATED_GUIDE,
      generatedDefaultContent: GENERATED_GUIDE,
    },
  };
};

export const handleSelectionGuideOnboardingDraft: RpcHandler = (
  params,
  runtime,
) => {
  const parsed =
    agentSelectionGuideGlobalOnboardingDraftGetRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return {
    ok: true,
    result: {
      content: runtime.store.snapshot().selectionGuide,
      generatedDefaultContent: GENERATED_GUIDE,
      providersSettled: true,
    },
  };
};

export const handleSpeechModelStatus: RpcHandler = (params) => {
  const parsed = speechGetModelStatusRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return {
    ok: true,
    result: {
      ...SPEECH_STATUS,
      modelId: parsed.data.modelId ?? SPEECH_STATUS.modelId,
    },
  };
};
