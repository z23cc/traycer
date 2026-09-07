import { randomUUID } from "node:crypto";
import {
  agentConfigureRequestSchema,
  agentConfigureRequestSchemaV20,
} from "@traycer/protocol/host/agent/profiles";
import { forkAgentRequestSchema } from "@traycer/protocol/host/agent/shared";
import { validateTuiForkProfileRequestSchema } from "@traycer/protocol/host/agent/tui/unary-schemas";
import { latestForkableAssistantMessageId } from "@traycer/protocol/persistence/chat-transcript/fork-boundary";
import { projectTranscriptRows } from "@traycer/protocol/persistence/chat-transcript/row-projection";
import { persistChatRunSettings } from "../../agent/gui-chat";
import { chatWindowedTranscript } from "../../stream/chat";
import type { HostRuntime } from "../../runtime";
import type { StoredChat } from "../../store/host-store";
import type { RpcHandler } from "./types";

type ConfigureRequest = {
  readonly epicId: string;
  readonly agentId: string;
  readonly harnessId: string;
  readonly model: string;
  readonly profileSelection:
    | { readonly kind: "ambient" }
    | { readonly kind: "profile"; readonly profileId: string };
  readonly reasoningEffort: string | null;
  readonly fastMode: boolean;
  /** `null` = preserve the target's current mode - what `@1.0` upgrades to. */
  readonly permissionMode: string | null;
};

/** `@2.0`+ first, then the `@1.0` shape that carries no permission choice. */
function readConfigure(params: unknown): ConfigureRequest | null {
  const v20 = agentConfigureRequestSchemaV20.safeParse(params);
  if (v20.success) {
    return v20.data;
  }
  const v10 = agentConfigureRequestSchema.safeParse(params);
  if (v10.success) {
    return { ...v10.data, permissionMode: null };
  }
  return null;
}

/**
 * The run settings a chat is CURRENTLY persisted with, as far as they can be
 * read back. `runSettings` is stored opaquely (it is whatever the negotiated
 * `epic.updateChatRunSettings` wrote), so each field is recovered defensively
 * and a missing one falls back to the same default a fresh chat runs under.
 */
function currentSettings(chat: StoredChat | undefined): {
  readonly harnessId: string;
  readonly model: string;
  readonly permissionMode: string;
  readonly reasoningEffort: string | null;
  readonly serviceTier: string | null;
  readonly agentMode: string;
  readonly profileId: string | null;
} {
  const raw = chat?.runSettings;
  const record: { readonly [key: string]: unknown } =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as { readonly [key: string]: unknown })
      : {};
  return {
    harnessId: stringOr(record.harnessId, "claude"),
    model: stringOr(record.model, "default"),
    permissionMode: stringOr(record.permissionMode, "supervised"),
    reasoningEffort: nullableString(record.reasoningEffort),
    serviceTier: nullableString(record.serviceTier),
    agentMode: stringOr(record.agentMode, "regular"),
    profileId: nullableString(record.profileId),
  };
}

/**
 * Atomically switches the future-run tuple of one agent.
 *
 * `@1.0` has no `permissionMode`; `@2.0`+ adds it and lets `null` mean
 * "preserve whatever the target is running under", which is exactly what the
 * `@1.0` shape upgrades to. Dispatch hands the handler the CALLER's parse, so
 * both shapes are read here rather than assumed.
 *
 * The response is built in the LATEST shape and left to dispatch to project
 * down - the older majors are frozen harness-id enums whose bridges fail
 * closed, which is the behaviour that keeps an old client from mis-decoding a
 * harness it has never heard of.
 */
export const handleAgentConfigure: RpcHandler = async (params, runtime) => {
  const request = readConfigure(params);
  if (request === null) {
    return {
      ok: false,
      code: "RPC_ERROR",
      message: "invalid agent.configure request",
    };
  }
  const epicId = request.epicId;
  const agentId = request.agentId;
  const chat = runtime.store
    .snapshot()
    .chats.find((row) => row.chatId === agentId && row.epicId === epicId);
  if (chat === undefined) {
    return {
      ok: false,
      code: "RPC_ERROR",
      message: `agent.configure: '${agentId}' is not an agent of epic '${epicId}'.`,
    };
  }
  const before = currentSettings(chat);
  const selection = request.profileSelection;
  const warnings: string[] = [];
  if (selection.kind === "profile") {
    // Stored, not resolved: managed provider profiles are a cloud surface this
    // host does not serve, so the selection is honoured verbatim and the
    // caller is told it was never verified rather than silently dropped.
    warnings.push(
      "This host does not manage provider profiles; the selection was stored but not resolved.",
    );
  }
  const permissionMode =
    request.permissionMode === null
      ? before.permissionMode
      : request.permissionMode;
  const settings = {
    harnessId: request.harnessId,
    model: request.model,
    permissionMode,
    reasoningEffort: request.reasoningEffort,
    serviceTier: before.serviceTier,
    agentMode: before.agentMode,
    profileId: selection.kind === "profile" ? selection.profileId : null,
  };
  await persistChatRunSettings(runtime, {
    epicId,
    chatId: agentId,
    settings,
    harnessId: settings.harnessId,
  });
  await runtime.store.mutate((state) => {
    const row = state.chats.find(
      (candidate) =>
        candidate.chatId === agentId && candidate.epicId === epicId,
    );
    if (row !== undefined) {
      row.fastMode = request.fastMode;
    }
  });
  return {
    ok: true,
    result: {
      settings: {
        harnessId: settings.harnessId,
        model: settings.model,
        profileSelection: selection,
        reasoningEffort: settings.reasoningEffort,
        fastMode: request.fastMode,
        permissionMode: settings.permissionMode,
        agentMode: settings.agentMode,
      },
      warnings,
    },
  };
};

/**
 * A fork is a NEW agent seeded with the source's transcript up to its latest
 * forkable assistant row - never the live turn, which is a row the user is
 * still watching.
 *
 * The boundary comes from the shared projection rather than a scan of this
 * host's own, so the message this cuts at is the one the client's own
 * `latestForkableAssistantMessageId` named on the snapshot it forked from.
 */
export const handleAgentFork: RpcHandler = async (params, runtime) => {
  const parsed = forkAgentRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const request = parsed.data;
  const source = runtime.store
    .snapshot()
    .chats.find(
      (row) => row.chatId === request.agentId && row.epicId === request.epicId,
    );
  if (source === undefined) {
    return {
      ok: false,
      code: "RPC_ERROR",
      message: `agent.fork: '${request.agentId}' is not an agent of epic '${request.epicId}'.`,
    };
  }
  const transcript = chatWindowedTranscript(
    runtime,
    request.epicId,
    request.agentId,
  );
  const activeTurnId = runtime.guiRuns.printState(request.agentId)?.turnId;
  let boundary: string | null = null;
  try {
    boundary = latestForkableAssistantMessageId(
      projectTranscriptRows({
        messages: transcript.messages,
        events: [],
        activeTurnId: activeTurnId ?? null,
        chatId: request.agentId,
      }),
      activeTurnId ?? null,
    );
  } catch {
    boundary = null;
  }
  const warnings: string[] = [];
  if (request.workspace !== null && request.workspace.entries.length > 0) {
    warnings.push(
      "This host forks into the source agent's workspace; the requested entries were ignored.",
    );
  }
  const before = currentSettings(source);
  const override = request.profileSelection;
  const effectiveProfileId =
    override.kind === "inherit"
      ? before.profileId
      : override.kind === "ambient"
        ? null
        : override.profileId;
  if (override.kind === "profile") {
    warnings.push(
      "This host does not manage provider profiles; the selection was stored but not resolved.",
    );
  }
  const forkedTurns = turnsThrough(source, boundary);
  const agentId = randomUUID();
  const now = Date.now();
  await runtime.store.mutate((state) => {
    state.agents.push({
      id: agentId,
      epicId: request.epicId,
      parentId: request.agentId,
      hostId: runtime.hostId,
      surface: "gui",
      harnessId: before.harnessId,
      title: request.name,
      createdAt: now,
      stopped: false,
    });
    state.chats.push({
      ...source,
      chatId: agentId,
      parentId: request.agentId,
      title: request.name ?? source.title,
      createdAt: now,
      turns: forkedTurns.map((turn) => ({ ...turn })),
      events: [],
      // A fork starts its own coordinate space and its own counters: the
      // source's epoch numbers rows this copy no longer has.
      transcriptEpoch: 0,
      indexRevision: 0,
      accumulatedChanges: [],
      runSettings: {
        ...before,
        permissionMode: request.permissionMode,
        profileId: effectiveProfileId,
      },
    });
  });
  return {
    ok: true,
    result: {
      agentId,
      sourceAgentId: request.agentId,
      forkedFromMessageId: boundary,
      warnings,
      effectiveProfileId,
      profileOverrideApplied: override.kind !== "inherit",
    },
  };
};

/**
 * One verdict per requested profile, in request order - the picker indexes
 * this array against its own rows, so a short answer is worse than a refusal.
 *
 * This host manages no provider profiles, so every named target is
 * `TARGET_PROFILE_UNAVAILABLE` and only the ambient login (`null`) can be
 * admitted. A source with no harness session has written no transcript to
 * resume from, which is `SOURCE_NOT_READY` and is asserted ahead of anything
 * profile-shaped.
 */
export const handleValidateTuiForkProfile: RpcHandler = (params, runtime) => {
  const parsed = validateTuiForkProfileRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const request = parsed.data;
  const source = runtime.store
    .snapshot()
    .tuiAgents.find(
      (row) =>
        row.tuiAgentId === request.sourceTuiAgentId &&
        row.epicId === request.epicId,
    );
  const refusal =
    source === undefined
      ? {
          subcode: "FORK_SOURCE_NOT_FOUND" as const,
          message: "No terminal agent with that id in this epic.",
        }
      : source.harnessSessionId === null
        ? {
            subcode: "SOURCE_NOT_READY" as const,
            message: "This agent has no harness session to fork from yet.",
          }
        : null;
  return {
    ok: true,
    result: {
      verdicts: request.targetProfileIds.map((targetProfileId) => {
        if (refusal !== null) {
          return { targetProfileId, admitted: false, ...refusal };
        }
        if (targetProfileId === null) {
          return {
            targetProfileId,
            admitted: true,
            subcode: null,
            message: null,
          };
        }
        return {
          targetProfileId,
          admitted: false,
          subcode: "TARGET_PROFILE_UNAVAILABLE" as const,
          message: "This host does not manage provider profiles.",
        };
      }),
    },
  };
};

/** The source's turns up to and including the fork boundary. */
function turnsThrough(
  source: StoredChat,
  boundary: string | null,
): readonly StoredChat["turns"][number][] {
  if (boundary === null) {
    return [];
  }
  const index = source.turns.findIndex((turn) => turn.messageId === boundary);
  return index < 0 ? [...source.turns] : source.turns.slice(0, index + 1);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
