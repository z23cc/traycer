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
import {
  clearBlobs,
  readBlob,
  snapshotDir,
  storageBytes,
} from "../../snapshots/snapshots";
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

export const handleSnapshotSize: RpcHandler = async (_params, runtime) => ({
  ok: true,
  result: { bytes: await storageBytes(snapshotDir(runtime.dataDir)) },
});

export const handleSnapshotClear: RpcHandler = async (params, runtime) => {
  const parsed = snapshotsClearLocalSnapshotsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return {
    ok: true,
    result: { clearedBytes: await clearBlobs(snapshotDir(runtime.dataDir)) },
  };
};

/**
 * The bodies behind a `file_change` card's hashes. A hash the store no
 * longer holds - cleared, or never written - is `blob_missing` for the whole
 * answer: half a diff is not a diff.
 */
export const handleSnapshotReadDiff: RpcHandler = async (params, runtime) => {
  const parsed = snapshotsReadSnapshotDiffRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const dir = snapshotDir(runtime.dataDir);
  const { beforeHash, afterHash } = parsed.data;
  const beforeContent =
    beforeHash === null ? null : await readBlob(dir, beforeHash);
  const afterContent =
    afterHash === null ? null : await readBlob(dir, afterHash);
  const missing =
    (beforeHash !== null && beforeContent === null) ||
    (afterHash !== null && afterContent === null);
  return {
    ok: true,
    result: missing
      ? { beforeContent: null, afterContent: null, reason: "blob_missing" }
      : { beforeContent, afterContent, reason: "snapshot" },
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

/**
 * The updater, the service registration, and its removal all shell out to the
 * `traycer` CLI so it can bootout/bootstrap the launchd job that supervises
 * this process. An OSS host does not own that job - it is started by whatever
 * supervisor launched it, and its bits come from a checkout rather than a
 * signed release - so there is no CLI run here that could honestly succeed.
 *
 * `externally-managed` is the contract's own word for exactly that: an
 * external supervisor owns this host's service lifecycle. Answering
 * `accepted`/`ok` instead would tell the GUI an update or a registration is
 * under way when nothing is happening, and on this machine it would also
 * invite a second supervisor over a host home that already has one.
 */
const EXTERNALLY_MANAGED: RpcHandler = () => ({
  ok: true,
  result: { outcome: "externally-managed" },
});

export const handleHostUpdateInstall = EXTERNALLY_MANAGED;
export const handleHostServiceRegister = EXTERNALLY_MANAGED;
export const handleHostServiceDeregister = EXTERNALLY_MANAGED;
