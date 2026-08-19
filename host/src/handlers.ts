import { ALL_PERMISSION_MODES } from "@traycer/protocol/persistence/epic/foundation";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ZodType } from "zod";
import {
  batchDeleteRequestSchema,
  createCommentThreadRequestSchema,
  createArtifactRequestSchema,
  createChatRequestSchemaV11,
  createEpicRequestSchema,
  createTuiAgentRequestSchema,
  deleteArtifactRequestSchema,
  deleteCommentRequestSchema,
  deleteCommentThreadRequestSchema,
  deleteChatRequestSchema,
  deleteTuiAgentRequestSchema,
  editCommentRequestSchema,
  epicMentionArtifactsRequestSchema,
  epicMentionEpicsRequestSchema,
  listEpicCollaboratorsRequestSchema,
  listCommentThreadsRequestSchema,
  renameArtifactRequestSchema,
  renameChatRequestSchema,
  renameTuiAgentRequestSchema,
  removeEpicRepoRequestSchema,
  reparentArtifactRequestSchema,
  reparentChatRequestSchema,
  replyToCommentThreadRequestSchema,
  resolveArtifactByPathRequestSchema,
  setChatArchivedRequestSchema,
  setCommentThreadResolvedRequestSchema,
  updateArtifactStatusRequestSchema,
  updateChatProfileRequestSchema,
  updateChatRunSettingsRequestSchemaV11,
  updateEpicRequestSchema,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  generateTuiAgentTitleRequestSchema,
  listTuiHarnessesRequestSchema,
  prepareTuiLaunchRequestSchemaV11,
  recordTuiAgentActivityRequestSchemaV11,
  tuiAgentTurnEndedRequestSchema,
} from "@traycer/protocol/host/agent/tui/unary-schemas";
import {
  agentInboxAckRequestSchema,
  agentInboxReadRequestSchemaV20,
} from "@traycer/protocol/host/agent/inbox";
import {
  EDITORS,
  openPathsRequestSchema,
} from "@traycer/protocol/host/editor/unary-schemas";
import {
  commentsListThreadsRequestSchema,
  commentsSetThreadStatusRequestSchema,
} from "@traycer/protocol/host/comments";
import { getChatRunSettingsRequestSchema } from "@traycer/protocol/host/epic/chat-records";
import {
  getGuiAgentPlanRequestSchema,
  listGuiAgentCommandsRequestSchema,
  listGuiAgentModelsRequestSchema,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import {
  A2A_MESSAGE_MAX_UTF8_BYTES,
  agentSelectionGuideGlobalGetRequestSchema,
  agentSelectionGuideGlobalOnboardingDraftGetRequestSchema,
  agentSelectionGuideGlobalResetRequestSchema,
  agentSelectionGuideGlobalSetRequestSchema,
  agentSelectionGuideRequestSchema,
  createAgentRequestSchemaV30,
  getAgentTranscriptRequestSchema,
  forkAgentRequestSchema,
  listAgentsRequestSchema,
  listHarnessModelsRequestSchema,
  sendAgentMessageRequestSchema,
  stopAgentRequestSchema,
  utf8ByteLength,
} from "@traycer/protocol/host/agent/shared";
import {
  agentConfigureRequestSchemaV20,
  agentGetProviderProfileRateLimitsRequestSchema,
  agentListProviderProfilesRequestSchema,
} from "@traycer/protocol/host/agent/profiles";
import {
  gitGetFileDiffRequestSchema,
  gitGetFileDiffsRequestSchema,
  gitListChangedFilesRequestSchema,
} from "@traycer/protocol/host/git-schemas";
import { hostNotificationsListRequestSchema } from "@traycer/protocol/host/notifications/host-notifications";
import { rateLimitUsageRequestSchemaV12 } from "@traycer/protocol/host/rate-limit/schemas";
import {
  speechEnsureModelRequestSchema,
  speechGetModelStatusRequestSchema,
} from "@traycer/protocol/host/speech/contracts";
import {
  snapshotsClearLocalSnapshotsRequestSchema,
  snapshotsGetLocalStorageSizeRequestSchema,
  snapshotsReadSnapshotDiffRequestSchema,
} from "@traycer/protocol/host/snapshot-schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import {
  createTerminalRequestSchemaV20,
  killTerminalRequestSchema,
  listTerminalsRequestSchemaV20,
  renameTerminalRequestSchema,
} from "@traycer/protocol/host/terminal/unary-schemas";
import {
  workspaceListDirectoryRequestSchema,
  workspaceListFileTreeRequestSchema,
  workspaceGitMentionSuggestionsRequestSchema,
  workspacePathMentionSuggestionsRequestSchema,
  type WorkspaceGitMentionSuggestionsRequest,
  workspacePrepareFoldersRequestSchemaV11,
  workspaceReadFileRequestSchema,
  workspaceResolvePathsByRepoIdentifiersRequestSchema,
} from "@traycer/protocol/host/workspace/unary-schemas";
import {
  worktreeGetBindingRequestSchema,
  worktreeCreateRequestSchema,
  worktreeCreatePathsRequestSchema,
  worktreeDeleteRequestSchema,
  worktreeImportRequestSchema,
  worktreeListAllForHostRequestSchemaV15,
  worktreeListBranchesRequestSchema,
  worktreeListBindingsForEpicRequestSchema,
  worktreeListByWorkspacePathsRequestSchemaV14,
  worktreeSetEntryModeRequestSchema,
  worktreeRetrySetupRequestSchema,
  worktreeSetRepoScriptsRequestSchema,
  workspaceBindingRemoveEntryRequestSchema,
} from "@traycer/protocol/host/worktree-schemas";
import { listWorkspaceDirectory, readWorkspaceFile } from "./workspace-fs";
import {
  listWorkspaceFileTree,
  mentionWorkspaceFiles,
  mentionWorkspaceFolders,
} from "./workspace-file-tree";
import {
  mentionWorkspaceGitBranches,
  mentionWorkspaceGitCommits,
  mentionWorkspaceGitRoot,
  mentionWorkspaceWorktrees,
} from "./workspace-git-mentions";
import { resolveHarnessExecutable } from "./cli-resolve";
import { probeGitCapabilities } from "./git-probe";
import { listGitChangedFiles } from "./git-status";
import { getGitFileDiff, getGitFileDiffs } from "./git-diff";
import { listWorktreeBranches } from "./git-branches";
import {
  isLocalGuiHarnessId,
  localGuiModelsFor,
  localHarnessModelSummariesFor,
} from "./gui-model-catalog";
import {
  readWorktreeScriptsAtRefs,
  summarizeWorktreeWorkspacePaths,
} from "./worktree-summary";
import type { TurnRunner } from "./cli-runner";
import { HOST_PACKAGE_VERSION, HOST_PROTOCOL_VERSION } from "./config";
import { HostState, StoreError } from "./store";
import { launchChatTurn } from "./turn";
import { materializeWorktreeIntentOrThrow } from "./worktree-intent";
import { prepareWorkspaceFolders } from "./workspace-prepare";
import type { AgentSelectionGuideStore } from "./agent-selection-guide";
import {
  localProviderProfilesFor,
  localProviderRateLimitsFor,
} from "./local-provider-profiles";
import type {
  ProviderRuntimeFacts,
  ProviderRuntimeFactsById,
} from "./provider-catalog";
import type { ProviderConfigStore } from "./provider-config-store";
import { createProviderHandlers } from "./provider-handlers";
import { TuiAgentServiceError } from "./tui-agent-service";
import { AgentInboxServiceError } from "./agent-inbox-service";
import {
  WorktreeDeletionError,
  WorktreeDeletionService,
} from "./worktree-deletion-service";
import { writeEnvironmentFile } from "./worktree-create";
import { listAllWorktreesForHost } from "./worktree-host-list";
import {
  resolveAgentGuiGetPlan,
  resolveEpicMentionEpics,
  resolveEpicMentionReviews,
  resolveEpicMentionSpecs,
  resolveEpicMentionStories,
  resolveEpicMentionTickets,
} from "./local-projections";

export type HandlerResult =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string };

export type MethodHandler = (
  params: unknown,
) => HandlerResult | Promise<HandlerResult>;

export type MethodDispatcher = (
  method: string,
  params: unknown,
) => HandlerResult | Promise<HandlerResult>;

const PERMISSION_MODES = [...ALL_PERMISSION_MODES];
const CLAUDE_TUI_PLUGIN_PATH = fileURLToPath(
  new URL("../resources/claude-tui-plugin", import.meta.url),
);

function hostStatus(state: HostState): HandlerResult {
  const busySessionCount = state.inflightTurnCount();
  return {
    ok: true,
    result: {
      ready: true,
      hostVersion: HOST_PACKAGE_VERSION,
      protocolVersion: HOST_PROTOCOL_VERSION,
      busy: busySessionCount > 0,
      busySessionCount,
      updateProgress: null,
    },
  };
}

function getRateLimitUsage(params: unknown): HandlerResult {
  const parsed = rateLimitUsageRequestSchemaV12.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  return {
    ok: true,
    result: {
      totalTokens: 15,
      remainingTokens: 15,
      providerRateLimits:
        parsed.data.providerId === undefined
          ? null
          : {
              provider: parsed.data.providerId,
              available: false,
              reason: "rate_limits_not_available",
            },
    },
  };
}

function runtimeCapabilities(): HandlerResult {
  return {
    ok: true,
    result: {
      chatMessageList: {
        status: "available",
        provider: "virtuoso-message-list",
        licenseMode: "development-trial",
        licenseKey: "",
      },
    },
  };
}

function localProviderRuntimeFacts(): ProviderRuntimeFactsById {
  const facts = new Map<ProviderId, ProviderRuntimeFacts>();
  const localProviders = [
    { providerId: "claude-code", command: "claude" },
    { providerId: "codex", command: "codex" },
  ] as const;
  for (const { providerId, command } of localProviders) {
    const path = resolveHarnessExecutable(command, process.env);
    if (path === null) continue;
    facts.set(providerId, {
      bundled: null,
      path: {
        path,
        version: null,
        available: true,
        versionPending: false,
      },
      custom: new Map(),
      auth: null,
      authPending: false,
      checkedAt: Date.now(),
      availabilityPending: false,
      apiKey: null,
    });
  }
  return facts;
}

function speechModelStatus(params: unknown): HandlerResult {
  const parsed = speechGetModelStatusRequestSchema.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  return {
    ok: true,
    result: {
      modelId: parsed.data.modelId ?? "default",
      installed: false,
      downloadState: "absent",
      downloadProgress: null,
      sizeBytes: null,
      errorMessage: null,
      engineAvailable: false,
    },
  };
}

function ensureSpeechModel(params: unknown): HandlerResult {
  const parsed = speechEnsureModelRequestSchema.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  return {
    ok: true,
    result: {
      modelId: parsed.data.modelId ?? "default",
      installed: false,
      downloadState: "absent",
      downloadProgress: null,
      sizeBytes: null,
      errorMessage: "On-device speech is not available on this local host.",
      engineAvailable: false,
    },
  };
}

function createTerminal(state: HostState, params: unknown): HandlerResult {
  const parsed = createTerminalRequestSchemaV20.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  try {
    return {
      ok: true,
      result: { session: state.terminalSessions.create(parsed.data) },
    };
  } catch (error) {
    return storeFailure(error);
  }
}

function listTerminals(state: HostState, params: unknown): HandlerResult {
  const parsed = listTerminalsRequestSchemaV20.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  return {
    ok: true,
    result: {
      sessions: state.terminalSessions.list(parsed.data),
      homeCwd: homedir(),
    },
  };
}

function killTerminal(state: HostState, params: unknown): HandlerResult {
  const parsed = killTerminalRequestSchema.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  return {
    ok: true,
    result: { killed: state.terminalSessions.kill(parsed.data.sessionId) },
  };
}

function renameTerminal(state: HostState, params: unknown): HandlerResult {
  const parsed = renameTerminalRequestSchema.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  return {
    ok: true,
    result: {
      updated: state.terminalSessions.rename(
        parsed.data.sessionId,
        parsed.data.title,
      ),
    },
  };
}

function snapshotStorageSize(params: unknown): HandlerResult {
  const parsed = snapshotsGetLocalStorageSizeRequestSchema.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  return { ok: true, result: { bytes: 0 } };
}

function clearLocalSnapshots(params: unknown): HandlerResult {
  const parsed = snapshotsClearLocalSnapshotsRequestSchema.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  return { ok: true, result: { clearedBytes: 0 } };
}

function readSnapshotDiff(params: unknown): HandlerResult {
  const parsed = snapshotsReadSnapshotDiffRequestSchema.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  return {
    ok: true,
    result: {
      beforeContent: null,
      afterContent: null,
      reason: "blob_missing",
    },
  };
}

function readAgentInbox(state: HostState, params: unknown): HandlerResult {
  const parsed = agentInboxReadRequestSchemaV20.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  try {
    return { ok: true, result: state.readAgentInbox(parsed.data) };
  } catch (error) {
    return storeFailure(error);
  }
}

function acknowledgeAgentInbox(
  state: HostState,
  params: unknown,
): HandlerResult {
  const parsed = agentInboxAckRequestSchema.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  try {
    state.acknowledgeAgentInbox(parsed.data);
    return { ok: true, result: {} };
  } catch (error) {
    return storeFailure(error);
  }
}

async function openEditorPaths(params: unknown): Promise<HandlerResult> {
  const parsed = openPathsRequestSchema.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  const editor = EDITORS.find(
    (candidate) => candidate.id === parsed.data.editorId,
  );
  if (editor === undefined) {
    return invalidArgument(`Unknown editor ${parsed.data.editorId}`);
  }
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return hostUnsupported("editor.openPaths on this operating system");
  }
  const urls = parsed.data.paths.map((path) => {
    const fileUrl = pathToFileURL(resolve(path));
    return `${editor.urlScheme}://file${fileUrl.pathname}`;
  });
  try {
    if (process.platform === "darwin") {
      await execFilePromise("open", urls);
    } else {
      for (const url of urls) await execFilePromise("xdg-open", [url]);
    }
    return { ok: true, result: {} };
  } catch (error) {
    return {
      ok: false,
      code: "RPC_ERROR",
      message: `Unable to open ${parsed.data.editorId}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function execFilePromise(
  command: string,
  args: readonly string[],
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      command,
      [...args],
      { timeout: 10_000, maxBuffer: 64 * 1024 },
      (error) => {
        if (error === null) resolvePromise();
        else reject(error);
      },
    );
  });
}

async function setRepoScripts(
  state: HostState,
  params: unknown,
): Promise<HandlerResult> {
  const parsed = worktreeSetRepoScriptsRequestSchema.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  const epic = state.getEpic(parsed.data.epicId);
  if (epic === null) {
    return invalidArgument(`Unknown epic ${parsed.data.epicId}`);
  }
  const requestedPath = resolve(parsed.data.workspacePath);
  if (
    !epic.workspaces.some(
      (workspace) => resolve(workspace.workspacePath) === requestedPath,
    )
  ) {
    return invalidArgument(
      `Workspace ${parsed.data.workspacePath} is not linked to epic ${parsed.data.epicId}`,
    );
  }
  try {
    await writeEnvironmentFile(
      requestedPath,
      { setup: parsed.data.setup, teardown: parsed.data.teardown },
      Date.now(),
    );
    return { ok: true, result: { updated: true } };
  } catch (error) {
    return storeFailure(error);
  }
}

async function deleteWorktree(
  state: HostState,
  params: unknown,
): Promise<HandlerResult> {
  const parsed = worktreeDeleteRequestSchema.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  try {
    const result = await new WorktreeDeletionService(
      state.managedWorktreeRoot(),
    ).delete(
      {
        worktreePath: parsed.data.worktreePath,
        expectedRepositoryRoot: parsed.data.workspacePath,
      },
      {
        isBusy: ({ worktreePath }) => state.isWorktreePathBusy(worktreePath),
        reportEvent: () => {},
      },
    );
    return { ok: true, result: { deleted: result.deleted } };
  } catch (error) {
    if (error instanceof WorktreeDeletionError) {
      return {
        ok: false,
        code: error.code === "BUSY" ? "WORKTREE_BUSY" : "RPC_ERROR",
        message: error.message,
      };
    }
    return storeFailure(error);
  }
}

function listEpicCollaborators(
  state: HostState,
  params: unknown,
): HandlerResult {
  const parsed = listEpicCollaboratorsRequestSchema.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  if (state.getEpic(parsed.data.epicId) === null) {
    return invalidArgument(`Unknown epic ${parsed.data.epicId}`);
  }
  return {
    ok: true,
    result: { collaborators: [], collaboratorsAvailable: false },
  };
}

function batchDeleteEpics(state: HostState, params: unknown): HandlerResult {
  const parsed = batchDeleteRequestSchema.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  return {
    ok: true,
    result: {
      results: parsed.data.ids.map((taskId) => {
        try {
          return state.deleteEpic(taskId)
            ? { taskId, success: true }
            : {
                taskId,
                success: false,
                errorMessage: `Task '${taskId}' was not found`,
              };
        } catch (error) {
          return {
            taskId,
            success: false,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          };
        }
      }),
    },
  };
}

function guiHarness(id: "claude" | "codex", label: string): unknown {
  const availability = guiHarnessAvailability(id);
  return {
    id,
    label,
    enabled: true,
    available: availability.available,
    error: availability.error,
    modes: ["gui", "tui"],
    requiresApiKey: false,
    supportedPermissionModes: PERMISSION_MODES,
    availabilityPending: false,
  };
}

function listTuiHarnesses(params: unknown): HandlerResult {
  const parsed = listTuiHarnessesRequestSchema.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  return {
    ok: true,
    result: {
      harnesses: [
        tuiHarness("claude", "Claude Code"),
        tuiHarness("codex", "Codex"),
      ],
    },
  };
}

function tuiHarness(id: "claude" | "codex", label: string): unknown {
  const availability = guiHarnessAvailability(id);
  return {
    id,
    label,
    enabled: true,
    available: availability.available,
    error: availability.error,
    availabilityPending: false,
  };
}

function prepareTuiLaunch(
  state: HostState,
  providerConfig: ProviderConfigStore,
  params: unknown,
): HandlerResult {
  const parsed = prepareTuiLaunchRequestSchemaV11.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  const request = parsed.data;
  if (request.harnessId !== "claude" && request.harnessId !== "codex") {
    return hostUnsupported(
      `agent.tui.prepareLaunch harness '${request.harnessId}'`,
    );
  }
  if (
    request.forkSourceHarnessSessionId !== null ||
    request.forkSourceTuiAgentId !== null
  ) {
    return hostUnsupported("agent.tui.prepareLaunch session forking");
  }
  if (request.profileId !== null) {
    return hostUnsupported("agent.tui.prepareLaunch managed profiles");
  }
  const executable = resolveHarnessExecutable(request.harnessId, process.env);
  if (executable === null) {
    return {
      ok: false,
      code: "RPC_ERROR",
      message: `${request.harnessId} CLI is not available on this host.`,
    };
  }
  try {
    const workspace = state.terminalAgentLaunchWorkspace(
      request.epicId,
      request.tuiAgentId ?? randomUUID(),
      request.workspaceMode,
    );
    const providerId = request.harnessId === "claude" ? "claude-code" : "codex";
    const configuredArgs =
      request.terminalAgentArgs ??
      providerConfig.get(providerId).terminalAgentArgs;
    const extraArgs = parseCommandLineArguments(configuredArgs);
    const launch = tuiLaunchArguments({
      harnessId: request.harnessId,
      harnessSessionId: request.harnessSessionId,
      model: request.model,
      extraArgs,
    });
    return {
      ok: true,
      result: {
        harnessId: request.harnessId,
        harnessSessionId: launch.harnessSessionId,
        terminalShellCommand: executable,
        terminalShellArgs: launch.args,
        hostId: state.hostId,
        workingDirectory: workspace.workingDirectory,
        workspaceFolders: workspace.workspaceFolders,
        worktreeBusyPaths: workspace.worktreeBusyPaths,
      },
    };
  } catch (error) {
    return storeFailure(error);
  }
}

function tuiLaunchArguments(input: {
  readonly harnessId: "claude" | "codex";
  readonly harnessSessionId: string | null;
  readonly model: string | null;
  readonly extraArgs: readonly string[];
}): { readonly harnessSessionId: string | null; readonly args: string[] } {
  const modelArgs =
    input.model === null || input.model.length === 0
      ? []
      : ["--model", input.model];
  if (input.harnessId === "claude") {
    const harnessSessionId = input.harnessSessionId ?? randomUUID();
    const sessionArgs =
      input.harnessSessionId === null
        ? ["--session-id", harnessSessionId]
        : ["--resume", harnessSessionId];
    return {
      harnessSessionId,
      args: [
        ...sessionArgs,
        ...modelArgs,
        "--plugin-dir",
        CLAUDE_TUI_PLUGIN_PATH,
        ...input.extraArgs,
      ],
    };
  }
  return {
    harnessSessionId: input.harnessSessionId,
    args:
      input.harnessSessionId === null
        ? [...modelArgs, ...input.extraArgs]
        : ["resume", input.harnessSessionId, ...modelArgs, ...input.extraArgs],
  };
}

function parseCommandLineArguments(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let active = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      active = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      active = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      active = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      active = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (active) {
        args.push(current);
        current = "";
        active = false;
      }
      continue;
    }
    current += character;
    active = true;
  }
  if (escaped) current += "\\";
  if (quote !== null) {
    throw new StoreError(
      "E_INVALID_ARGUMENT",
      "Terminal agent arguments contain an unterminated quote.",
    );
  }
  if (active) args.push(current);
  return args;
}

function listGuiHarnesses(): HandlerResult {
  return {
    ok: true,
    result: {
      harnesses: [
        guiHarness("claude", "Claude Code"),
        guiHarness("codex", "Codex"),
      ],
    },
  };
}

function guiHarnessAvailability(id: "claude" | "codex"): {
  readonly available: boolean;
  readonly error: string | null;
} {
  const resolved = resolveHarnessExecutable(id, process.env);
  if (resolved !== null) {
    return { available: true, error: null };
  }
  const envKey = id === "claude" ? "TRAYCER_CLAUDE_PATH" : "TRAYCER_CODEX_PATH";
  return {
    available: false,
    error: `${id} CLI was not found on PATH. Install it or set ${envKey}.`,
  };
}

function listGuiModels(params: unknown): HandlerResult {
  const parsed = listGuiAgentModelsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  return {
    ok: true,
    result: {
      harnessId: parsed.data.harnessId,
      models: modelsFor(parsed.data.harnessId),
    },
  };
}

function listGuiCommands(params: unknown): HandlerResult {
  const parsed = listGuiAgentCommandsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  return {
    ok: true,
    result: { harnessId: parsed.data.harnessId, commands: [] },
  };
}

function listHarnessModels(params: unknown): HandlerResult {
  const parsed = listHarnessModelsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  return {
    ok: true,
    result: {
      harnessId: parsed.data.harnessId,
      models: localHarnessModelSummariesFor(parsed.data.harnessId),
    },
  };
}

function modelsFor(harnessId: string): unknown[] {
  return isLocalGuiHarnessId(harnessId)
    ? [...localGuiModelsFor(harnessId)]
    : [];
}

function unimplemented(method: string): HandlerResult {
  return {
    ok: false,
    code: "RPC_ERROR",
    message: `${method} is not implemented on this local host yet`,
  };
}

function hostUnsupported(capability: string): HandlerResult {
  return {
    ok: false,
    code: "E_HOST_UNSUPPORTED",
    message: `${capability} is not available on this local host`,
  };
}

function parsedStoreRequest<T>(
  schema: ZodType<T>,
  params: unknown,
  action: (request: T) => unknown,
): HandlerResult {
  const parsed = schema.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  try {
    return { ok: true, result: action(parsed.data) };
  } catch (error) {
    return storeFailure(error);
  }
}

async function parsedAsyncStoreRequest<T>(
  schema: ZodType<T>,
  params: unknown,
  action: (request: T) => Promise<unknown>,
): Promise<HandlerResult> {
  const parsed = schema.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  try {
    return { ok: true, result: await action(parsed.data) };
  } catch (error) {
    return storeFailure(error);
  }
}

export function createHandlers(
  state: HostState,
  runner: TurnRunner,
  selectionGuide: AgentSelectionGuideStore | undefined,
  providerConfig: ProviderConfigStore,
): {
  readonly handleMethod: MethodDispatcher;
} {
  const providerHandlers = createProviderHandlers({
    config: providerConfig,
    runtimeFacts: localProviderRuntimeFacts,
  });
  const handlers: Readonly<Record<string, MethodHandler>> = {
    "host.status": () => hostStatus(state),
    "host.getRuntimeCapabilities": runtimeCapabilities,
    "host.getRateLimitUsage": (params) => getRateLimitUsage(params),
    ...providerHandlers,
    "providers.startLogin": () =>
      hostUnsupported("providers.startLogin authentication flow"),
    "providers.awaitLogin": () =>
      hostUnsupported("providers.awaitLogin authentication flow"),
    "providers.cancelLogin": () =>
      hostUnsupported("providers.cancelLogin authentication flow"),
    "providers.setApiKey": () =>
      hostUnsupported("providers.setApiKey secret storage"),
    "providers.clearApiKey": () =>
      hostUnsupported("providers.clearApiKey secret storage"),
    "speech.getModelStatus": (params) => speechModelStatus(params),
    "speech.ensureModel": (params) => ensureSpeechModel(params),
    "terminal.create": (params) => createTerminal(state, params),
    "terminal.kill": (params) => killTerminal(state, params),
    "terminal.list": (params) => listTerminals(state, params),
    "terminal.rename": (params) => renameTerminal(state, params),
    "snapshots.getLocalStorageSize": (params) => snapshotStorageSize(params),
    "snapshots.clearLocalSnapshots": (params) => clearLocalSnapshots(params),
    "snapshots.readSnapshotDiff": (params) => readSnapshotDiff(params),
    "editor.openPaths": (params) => openEditorPaths(params),
    "agent.gui.listHarnesses": listGuiHarnesses,
    "agent.gui.listModels": listGuiModels,
    "agent.gui.listCommands": listGuiCommands,
    "agent.gui.getPlan": (params) =>
      parsedStoreRequest(getGuiAgentPlanRequestSchema, params, (request) =>
        resolveAgentGuiGetPlan(state, request),
      ),
    "agent.tui.listHarnesses": listTuiHarnesses,
    "agent.tui.prepareLaunch": (params) =>
      prepareTuiLaunch(state, providerConfig, params),
    "agent.tui.generateTitle": (params) =>
      parsedAsyncStoreRequest(
        generateTuiAgentTitleRequestSchema,
        params,
        (request) => state.generateTuiAgentTitle(request),
      ),
    "agent.tui.recordActivity": (params) =>
      parsedStoreRequest(
        recordTuiAgentActivityRequestSchemaV11,
        params,
        (request) => state.recordTuiAgentActivity(request),
      ),
    "agent.tui.turnEnded": (params) =>
      parsedStoreRequest(tuiAgentTurnEndedRequestSchema, params, (request) =>
        state.recordTuiAgentTurnEnded(request),
      ),
    "agent.create": (params) => createAgent(state, params),
    "agent.configure": (params) => configureAgent(state, params),
    "agent.fork": (params) => forkAgent(state, params),
    "agent.list": (params) => listAgents(state, params),
    "agent.listHarnessModels": (params) => listHarnessModels(params),
    "agent.listProviderProfiles": (params) =>
      listProviderProfiles(state, params),
    "agent.getProviderProfileRateLimits": (params) =>
      getProviderProfileRateLimits(state, params),
    "agent.getTranscript": (params) => getAgentTranscript(state, params),
    "agent.sendMessage": (params) => sendAgentMessage(state, runner, params),
    "agent.stop": (params) => stopAgent(state, params),
    "agent.inbox.read": (params) => readAgentInbox(state, params),
    "agent.inbox.ack": (params) => acknowledgeAgentInbox(state, params),
    "agent.selectionGuide": (params) =>
      resolveAgentSelectionGuide(state, selectionGuide, params),
    "agent.selectionGuide.getGlobal": (params) =>
      getGlobalAgentSelectionGuide(selectionGuide, params),
    "agent.selectionGuide.getGlobalOnboardingDraft": (params) =>
      getAgentSelectionGuideOnboardingDraft(selectionGuide, params),
    "agent.selectionGuide.setGlobal": (params) =>
      setGlobalAgentSelectionGuide(selectionGuide, params),
    "agent.selectionGuide.resetGlobalToDefault": (params) =>
      resetGlobalAgentSelectionGuide(selectionGuide, params),
    "git.getCapabilities": (params) => gitCapabilities(params),
    "git.listChangedFiles": (params) => gitChangedFiles(params),
    "git.getFileDiff": (params) => gitFileDiff(params),
    "git.getFileDiffs": (params) => gitFileDiffs(params),
    "worktree.listAllForHost": (params) =>
      parsedAsyncStoreRequest(
        worktreeListAllForHostRequestSchemaV15,
        params,
        (request) => listAllWorktreesForHost(state, request),
      ),
    "worktree.getBinding": (params) => getBinding(state, params),
    "worktree.create": (params) => createWorktree(state, params),
    "worktree.createPaths": (params) => createWorktreePaths(state, params),
    "worktree.import": (params) =>
      parsedAsyncStoreRequest(worktreeImportRequestSchema, params, (request) =>
        state.importWorktree(request),
      ),
    "worktree.delete": (params) => deleteWorktree(state, params),
    "worktree.listBranches": (params) => listBranches(params),
    "worktree.setEntryMode": (params) => setWorktreeEntryMode(state, params),
    "worktree.retrySetup": (params) => {
      const parsed = worktreeRetrySetupRequestSchema.safeParse(params);
      return parsed.success
        ? hostUnsupported("worktree.retrySetup orchestration")
        : invalidArgument(parsed.error.message);
    },
    "worktree.setRepoScripts": (params) => setRepoScripts(state, params),
    "workspaceBinding.removeEntry": (params) =>
      removeWorktreeBindingEntry(state, params),
    "worktree.listBindingsForEpic": (params) =>
      listBindingsForEpic(state, params),
    "worktree.listByWorkspacePaths": (params) => listByWorkspacePaths(params),
    "host.notifications.list": (params) => listNotifications(params),
    "workspace.prepareFolders": (params) => prepareFolders(state, params),
    "workspace.resolvePathsByRepoIdentifiers": (params) =>
      resolvePathsByRepoIdentifiers(state, params),
    "workspace.listDirectory": (params) => listDirectory(params),
    "workspace.listFileTree": (params) => listFileTree(params),
    "workspace.mentionFiles": (params) => mentionFiles(params),
    "workspace.mentionFolders": (params) => mentionFolders(params),
    "workspace.mentionWorktrees": (params) => mentionWorktrees(params),
    "workspace.mentionGitRoot": (params) => mentionGitRoot(params),
    "workspace.mentionGitBranches": (params) => mentionGitBranches(params),
    "workspace.mentionGitCommits": (params) => mentionGitCommits(params),
    "workspace.readFile": (params) => readFile(params),
    "epic.create": (params) => createEpic(state, runner, params),
    "epic.createTuiAgent": (params) =>
      parsedStoreRequest(createTuiAgentRequestSchema, params, (request) =>
        state.createTuiAgent(request),
      ),
    "epic.deleteTuiAgent": (params) =>
      parsedStoreRequest(deleteTuiAgentRequestSchema, params, (request) =>
        state.deleteTuiAgent(request),
      ),
    "epic.renameTuiAgent": (params) =>
      parsedStoreRequest(renameTuiAgentRequestSchema, params, (request) =>
        state.renameTuiAgent(request),
      ),
    "epic.batchDelete": (params) => batchDeleteEpics(state, params),
    "epic.removeRepo": (params) =>
      parsedStoreRequest(removeEpicRepoRequestSchema, params, (request) =>
        state.removeEpicRepo(request),
      ),
    "epic.createArtifact": (params) => createArtifact(state, params),
    "epic.createCommentThread": (params) =>
      parsedStoreRequest(createCommentThreadRequestSchema, params, (request) =>
        state.createCommentThread(request),
      ),
    "epic.replyToCommentThread": (params) =>
      parsedStoreRequest(replyToCommentThreadRequestSchema, params, (request) =>
        state.replyToCommentThread(request),
      ),
    "epic.editComment": (params) =>
      parsedStoreRequest(editCommentRequestSchema, params, (request) =>
        state.editComment(request),
      ),
    "epic.deleteComment": (params) =>
      parsedStoreRequest(deleteCommentRequestSchema, params, (request) =>
        state.deleteComment(request),
      ),
    "epic.setCommentThreadResolved": (params) =>
      parsedStoreRequest(
        setCommentThreadResolvedRequestSchema,
        params,
        (request) => state.setCommentThreadResolved(request),
      ),
    "epic.deleteCommentThread": (params) =>
      parsedStoreRequest(deleteCommentThreadRequestSchema, params, (request) =>
        state.deleteCommentThread(request),
      ),
    "epic.listCommentThreads": (params) =>
      parsedStoreRequest(listCommentThreadsRequestSchema, params, (request) =>
        state.listCommentThreads(request),
      ),
    "comments.listThreads": (params) =>
      parsedStoreRequest(commentsListThreadsRequestSchema, params, (request) =>
        state.listCommentThreadsByPath(request),
      ),
    "comments.setThreadStatus": (params) =>
      parsedStoreRequest(
        commentsSetThreadStatusRequestSchema,
        params,
        (request) => state.setCommentThreadStatusByPath(request),
      ),
    "epic.resolveArtifactByPath": (params) =>
      parsedStoreRequest(
        resolveArtifactByPathRequestSchema,
        params,
        (request) => state.resolveArtifactByPath(request),
      ),
    "epic.deleteArtifact": (params) => deleteArtifact(state, params),
    "epic.renameArtifact": (params) => renameArtifact(state, params),
    "epic.reparentArtifact": (params) => reparentArtifact(state, params),
    "epic.updateArtifactStatus": (params) =>
      updateArtifactStatus(state, params),
    "epic.updateTitle": (params) => updateEpicTitle(state, params),
    "epic.createChat": (params) => createChat(state, runner, params),
    "epic.renameChat": (params) => renameChat(state, params),
    "epic.reparentChat": (params) => reparentChat(state, params),
    "epic.setChatArchived": (params) => setChatArchived(state, params),
    "epic.updateChatRunSettings": (params) =>
      updateChatRunSettings(state, params),
    "epic.updateChatProfile": (params) => updateChatProfile(state, params),
    "epic.getChatRunSettings": (params) => getChatRunSettings(state, params),
    "epic.deleteChat": (params) => deleteChat(state, params),
    "epic.listTasks": () => ({ ok: true, result: state.listTasks() }),
    "epic.listCollaborators": (params) => listEpicCollaborators(state, params),
    "epic.grantAccess": () =>
      hostUnsupported("epic.grantAccess cloud collaboration"),
    "epic.batchUpdateRoles": () =>
      hostUnsupported("epic.batchUpdateRoles cloud collaboration"),
    "epic.revokeCollaborator": () =>
      hostUnsupported("epic.revokeCollaborator cloud collaboration"),
    "phase.migrateToEpic": () =>
      hostUnsupported("phase.migrateToEpic cloud migration"),
    "epic.mentionEpics": (params) =>
      parsedStoreRequest(epicMentionEpicsRequestSchema, params, (request) =>
        resolveEpicMentionEpics(state, request),
      ),
    "epic.mentionSpecs": (params) =>
      parsedStoreRequest(epicMentionArtifactsRequestSchema, params, (request) =>
        resolveEpicMentionSpecs(state, request),
      ),
    "epic.mentionTickets": (params) =>
      parsedStoreRequest(epicMentionArtifactsRequestSchema, params, (request) =>
        resolveEpicMentionTickets(state, request),
      ),
    "epic.mentionStories": (params) =>
      parsedStoreRequest(epicMentionArtifactsRequestSchema, params, (request) =>
        resolveEpicMentionStories(state, request),
      ),
    "epic.mentionReviews": (params) =>
      parsedStoreRequest(epicMentionArtifactsRequestSchema, params, (request) =>
        resolveEpicMentionReviews(state, request),
      ),
  };
  return {
    handleMethod(
      method: string,
      params: unknown,
    ): HandlerResult | Promise<HandlerResult> {
      const handler = handlers[method];
      if (handler === undefined) {
        return unimplemented(method);
      }
      return handler(params);
    },
  };
}

function listProviderProfiles(
  state: HostState,
  params: unknown,
): HandlerResult {
  const parsed = agentListProviderProfilesRequestSchema.safeParse(params);
  if (!parsed.success) {
    return invalidArgument(parsed.error.message);
  }
  try {
    state.listAgents({
      epicId: parsed.data.epicId,
      senderAgentId: parsed.data.senderAgentId,
      scope: "user",
    });
    return {
      ok: true,
      result: localProviderProfilesFor(parsed.data.harnessId),
    };
  } catch (error) {
    return storeFailure(error);
  }
}

function configureAgent(state: HostState, params: unknown): HandlerResult {
  const parsed = agentConfigureRequestSchemaV20.safeParse(params);
  if (!parsed.success) {
    return invalidArgument(parsed.error.message);
  }
  try {
    return { ok: true, result: state.configureAgent(parsed.data) };
  } catch (error) {
    return storeFailure(error);
  }
}

async function forkAgent(
  state: HostState,
  params: unknown,
): Promise<HandlerResult> {
  const parsed = forkAgentRequestSchema.safeParse(params);
  if (!parsed.success) {
    return invalidArgument(parsed.error.message);
  }
  try {
    return { ok: true, result: await state.forkAgent(parsed.data) };
  } catch (error) {
    return storeFailure(error);
  }
}

function getProviderProfileRateLimits(
  state: HostState,
  params: unknown,
): HandlerResult {
  const parsed =
    agentGetProviderProfileRateLimitsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return invalidArgument(parsed.error.message);
  }
  try {
    state.listAgents({
      epicId: parsed.data.epicId,
      senderAgentId: parsed.data.senderAgentId,
      scope: "user",
    });
    return {
      ok: true,
      result: localProviderRateLimitsFor(
        parsed.data.harnessId,
        parsed.data.profileSelection,
      ),
    };
  } catch (error) {
    return storeFailure(error);
  }
}

async function resolveAgentSelectionGuide(
  state: HostState,
  selectionGuide: AgentSelectionGuideStore | undefined,
  params: unknown,
): Promise<HandlerResult> {
  const parsed = agentSelectionGuideRequestSchema.safeParse(params);
  if (!parsed.success) {
    return invalidArgument(parsed.error.message);
  }
  if (selectionGuide === undefined) {
    return unimplemented("agent.selectionGuide");
  }
  try {
    state.listAgents({ ...parsed.data, scope: "user" });
    return { ok: true, result: await selectionGuide.getForAgent() };
  } catch (error) {
    return storeFailure(error);
  }
}

async function getGlobalAgentSelectionGuide(
  selectionGuide: AgentSelectionGuideStore | undefined,
  params: unknown,
): Promise<HandlerResult> {
  const parsed = agentSelectionGuideGlobalGetRequestSchema.safeParse(params);
  if (!parsed.success) {
    return invalidArgument(parsed.error.message);
  }
  return await selectionGuideResult(
    selectionGuide,
    "agent.selectionGuide.getGlobal",
    (store) => store.getGlobal(),
  );
}

async function getAgentSelectionGuideOnboardingDraft(
  selectionGuide: AgentSelectionGuideStore | undefined,
  params: unknown,
): Promise<HandlerResult> {
  const parsed =
    agentSelectionGuideGlobalOnboardingDraftGetRequestSchema.safeParse(params);
  if (!parsed.success) {
    return invalidArgument(parsed.error.message);
  }
  return await selectionGuideResult(
    selectionGuide,
    "agent.selectionGuide.getGlobalOnboardingDraft",
    (store) => store.getOnboardingDraft(),
  );
}

async function setGlobalAgentSelectionGuide(
  selectionGuide: AgentSelectionGuideStore | undefined,
  params: unknown,
): Promise<HandlerResult> {
  const parsed = agentSelectionGuideGlobalSetRequestSchema.safeParse(params);
  if (!parsed.success) {
    return invalidArgument(parsed.error.message);
  }
  return await selectionGuideResult(
    selectionGuide,
    "agent.selectionGuide.setGlobal",
    (store) => store.setGlobal(parsed.data.content),
  );
}

async function resetGlobalAgentSelectionGuide(
  selectionGuide: AgentSelectionGuideStore | undefined,
  params: unknown,
): Promise<HandlerResult> {
  const parsed = agentSelectionGuideGlobalResetRequestSchema.safeParse(params);
  if (!parsed.success) {
    return invalidArgument(parsed.error.message);
  }
  return await selectionGuideResult(
    selectionGuide,
    "agent.selectionGuide.resetGlobalToDefault",
    (store) => store.resetGlobal(),
  );
}

async function selectionGuideResult(
  selectionGuide: AgentSelectionGuideStore | undefined,
  method: string,
  operation: (store: AgentSelectionGuideStore) => Promise<unknown>,
): Promise<HandlerResult> {
  if (selectionGuide === undefined) {
    return unimplemented(method);
  }
  try {
    return { ok: true, result: await operation(selectionGuide) };
  } catch (error) {
    return storeFailure(error);
  }
}

function invalidArgument(message: string): HandlerResult {
  return { ok: false, code: "E_INVALID_ARGUMENT", message };
}

async function createAgent(
  state: HostState,
  params: unknown,
): Promise<HandlerResult> {
  const parsed = createAgentRequestSchemaV30.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  try {
    return { ok: true, result: await state.createAgent(parsed.data) };
  } catch (error) {
    return storeFailure(error);
  }
}

function listAgents(state: HostState, params: unknown): HandlerResult {
  const parsed = listAgentsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  try {
    return { ok: true, result: state.listAgents(parsed.data) };
  } catch (error) {
    return storeFailure(error);
  }
}

async function getAgentTranscript(
  state: HostState,
  params: unknown,
): Promise<HandlerResult> {
  const parsed = getAgentTranscriptRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  try {
    return { ok: true, result: await state.getAgentTranscript(parsed.data) };
  } catch (error) {
    return storeFailure(error);
  }
}

async function sendAgentMessage(
  state: HostState,
  runner: TurnRunner,
  params: unknown,
): Promise<HandlerResult> {
  const parsed = sendAgentMessageRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  if (utf8ByteLength(parsed.data.prompt) > A2A_MESSAGE_MAX_UTF8_BYTES) {
    return {
      ok: false,
      code: "MESSAGE_TOO_LARGE",
      message: "Message exceeds the maximum size.",
    };
  }
  try {
    const request = state.resolveAgentMessageParticipants(parsed.data);
    return await state.withSerializedChatAction(
      request.epicId,
      request.receiverAgentId,
      async () => {
        const delivery = state.acceptAgentMessage(request);
        if (delivery.pendingTurn !== null) {
          launchChatTurn(state, runner, delivery.pendingTurn);
        }
        return { ok: true, result: delivery.response };
      },
    );
  } catch (error) {
    return storeFailure(error);
  }
}

async function stopAgent(
  state: HostState,
  params: unknown,
): Promise<HandlerResult> {
  const parsed = stopAgentRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  try {
    return { ok: true, result: await state.stopAgent(parsed.data) };
  } catch (error) {
    return storeFailure(error);
  }
}

function listNotifications(params: unknown): HandlerResult {
  const parsed = hostNotificationsListRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  return { ok: true, result: { entries: [], nextCursor: null } };
}

async function prepareFolders(
  state: HostState,
  params: unknown,
): Promise<HandlerResult> {
  const parsed = workspacePrepareFoldersRequestSchemaV11.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  if (parsed.data.operation !== "prepare" || parsed.data.folderPaths === null) {
    return {
      ok: false,
      code: "E_HOST_UNSUPPORTED",
      message: `workspace.prepareFolders operation '${parsed.data.operation}' is not implemented on this local host yet`,
    };
  }
  try {
    const prepared = await prepareWorkspaceFolders(parsed.data.folderPaths);
    await state.recordPreparedWorkspaceMappings(prepared.folders);
    return {
      ok: true,
      result: {
        operation: "prepare",
        folders: prepared.folders,
        repoIdentifiers: prepared.repoIdentifiers,
        homeDir: null,
        validation: null,
        recentWorkspaces: null,
      },
    };
  } catch (error) {
    return {
      ok: false,
      code: "RPC_ERROR",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function resolvePathsByRepoIdentifiers(
  state: HostState,
  params: unknown,
): HandlerResult {
  const parsed =
    workspaceResolvePathsByRepoIdentifiersRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  return {
    ok: true,
    result: state.resolvePathsByRepoIdentifiers(parsed.data.repoIdentifiers),
  };
}

function listDirectory(params: unknown): HandlerResult {
  const parsed = workspaceListDirectoryRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  const listed = listWorkspaceDirectory(
    parsed.data.workspacePath,
    parsed.data.directoryPath,
  );
  if ("error" in listed) {
    return { ok: false, code: "E_INVALID_ARGUMENT", message: listed.error };
  }
  return {
    ok: true,
    result: {
      workspacePath: parsed.data.workspacePath,
      directoryPath: parsed.data.directoryPath,
      entries: listed.entries,
    },
  };
}

function readFile(params: unknown): HandlerResult {
  const parsed = workspaceReadFileRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  const read = readWorkspaceFile(
    parsed.data.workspacePath,
    parsed.data.filePath,
    parsed.data.maxBytes,
  );
  return {
    ok: true,
    result: {
      workspacePath: parsed.data.workspacePath,
      filePath: parsed.data.filePath,
      content: read.content,
      truncated: read.truncated,
      error: read.error,
    },
  };
}

function listFileTree(params: unknown): HandlerResult {
  const parsed = workspaceListFileTreeRequestSchema.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  try {
    return { ok: true, result: listWorkspaceFileTree(parsed.data) };
  } catch (error) {
    return storeFailure(error);
  }
}

function mentionFiles(params: unknown): HandlerResult {
  const parsed = workspacePathMentionSuggestionsRequestSchema.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  return { ok: true, result: mentionWorkspaceFiles(parsed.data) };
}

function mentionFolders(params: unknown): HandlerResult {
  const parsed = workspacePathMentionSuggestionsRequestSchema.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  return { ok: true, result: mentionWorkspaceFolders(parsed.data) };
}

async function mentionWorktrees(params: unknown): Promise<HandlerResult> {
  const parsed = workspacePathMentionSuggestionsRequestSchema.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  try {
    return { ok: true, result: await mentionWorkspaceWorktrees(parsed.data) };
  } catch (error) {
    return storeFailure(error);
  }
}

async function mentionGitRoot(params: unknown): Promise<HandlerResult> {
  return await gitMentionRequest(params, mentionWorkspaceGitRoot);
}

async function mentionGitBranches(params: unknown): Promise<HandlerResult> {
  return await gitMentionRequest(params, mentionWorkspaceGitBranches);
}

async function mentionGitCommits(params: unknown): Promise<HandlerResult> {
  return await gitMentionRequest(params, mentionWorkspaceGitCommits);
}

async function gitMentionRequest(
  params: unknown,
  action: (request: WorkspaceGitMentionSuggestionsRequest) => Promise<unknown>,
): Promise<HandlerResult> {
  const parsed = workspaceGitMentionSuggestionsRequestSchema.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  try {
    return { ok: true, result: await action(parsed.data) };
  } catch (error) {
    return storeFailure(error);
  }
}

function gitCapabilities(params: unknown): HandlerResult {
  const parsed = gitListChangedFilesRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  return { ok: true, result: probeGitCapabilities(parsed.data.runningDir) };
}

function gitChangedFiles(params: unknown): HandlerResult {
  const parsed = gitListChangedFilesRequestSchema.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  try {
    return { ok: true, result: listGitChangedFiles(parsed.data) };
  } catch (error) {
    return storeFailure(error);
  }
}

function gitFileDiff(params: unknown): HandlerResult {
  const parsed = gitGetFileDiffRequestSchema.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  try {
    return { ok: true, result: getGitFileDiff(parsed.data) };
  } catch (error) {
    return storeFailure(error);
  }
}

function gitFileDiffs(params: unknown): HandlerResult {
  const parsed = gitGetFileDiffsRequestSchema.safeParse(params);
  if (!parsed.success) return invalidArgument(parsed.error.message);
  try {
    return { ok: true, result: getGitFileDiffs(parsed.data) };
  } catch (error) {
    return storeFailure(error);
  }
}

function getBinding(state: HostState, params: unknown): HandlerResult {
  const parsed = worktreeGetBindingRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  return { ok: true, result: state.getBinding(parsed.data) };
}

async function listBranches(params: unknown): Promise<HandlerResult> {
  const parsed = worktreeListBranchesRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  return { ok: true, result: await listWorktreeBranches(parsed.data) };
}

async function createWorktree(
  state: HostState,
  params: unknown,
): Promise<HandlerResult> {
  const parsed = worktreeCreateRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  try {
    return { ok: true, result: await state.createWorktree(parsed.data) };
  } catch (error) {
    return storeFailure(error);
  }
}

async function createWorktreePaths(
  state: HostState,
  params: unknown,
): Promise<HandlerResult> {
  const parsed = worktreeCreatePathsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  try {
    return { ok: true, result: await state.createWorktreePaths(parsed.data) };
  } catch (error) {
    return storeFailure(error);
  }
}

async function setWorktreeEntryMode(
  state: HostState,
  params: unknown,
): Promise<HandlerResult> {
  const parsed = worktreeSetEntryModeRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  try {
    return {
      ok: true,
      result: await state.setWorktreeEntryMode(parsed.data),
    };
  } catch (error) {
    return storeFailure(error);
  }
}

async function removeWorktreeBindingEntry(
  state: HostState,
  params: unknown,
): Promise<HandlerResult> {
  const parsed = workspaceBindingRemoveEntryRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  try {
    return {
      ok: true,
      result: await state.removeWorktreeBindingEntry(parsed.data),
    };
  } catch (error) {
    return storeFailure(error);
  }
}

function listBindingsForEpic(state: HostState, params: unknown): HandlerResult {
  const parsed = worktreeListBindingsForEpicRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  return { ok: true, result: state.listBindingsForEpic(parsed.data.epicId) };
}

async function listByWorkspacePaths(params: unknown): Promise<HandlerResult> {
  const parsed = worktreeListByWorkspacePathsRequestSchemaV14.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  const [workspaces, scriptsAtRefs] = await Promise.all([
    summarizeWorktreeWorkspacePaths(parsed.data.workspacePaths, {
      forceRefresh: parsed.data.forceRefresh,
      environment: "include",
    }),
    readWorktreeScriptsAtRefs(parsed.data.scriptRefs),
  ]);
  return {
    ok: true,
    result: {
      workspaces,
      scriptsAtRefs,
    },
  };
}

async function createEpic(
  state: HostState,
  runner: TurnRunner,
  params: unknown,
): Promise<HandlerResult> {
  const parsed = createEpicRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  const create = async (): Promise<HandlerResult> => {
    const seed = parsed.data.chat;
    if (seed !== undefined && seed !== null) {
      await materializeWorktreeIntentOrThrow(state, {
        epicId: parsed.data.epic.id,
        ownerId: seed.chatId,
        ownerKind: "chat",
        workspaceMode: seed.workspaceMode,
        intent: seed.worktreeIntent,
        wrapThrownErrors: false,
      });
    }
    const created = state.createEpic(parsed.data);
    if (created.pendingTurn !== null) {
      launchChatTurn(state, runner, created.pendingTurn);
    }
    return { ok: true, result: created.response };
  };
  try {
    const seed = parsed.data.chat;
    if (seed !== undefined && seed !== null) {
      return await state.withSerializedChatAction(
        parsed.data.epic.id,
        seed.chatId,
        create,
      );
    }
    return await create();
  } catch (error) {
    return storeFailure(error);
  }
}

function createArtifact(state: HostState, params: unknown): HandlerResult {
  const parsed = createArtifactRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  try {
    return { ok: true, result: state.createArtifact(parsed.data) };
  } catch (error) {
    return storeFailure(error);
  }
}

function deleteArtifact(state: HostState, params: unknown): HandlerResult {
  const parsed = deleteArtifactRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  try {
    return { ok: true, result: state.deleteArtifact(parsed.data) };
  } catch (error) {
    return storeFailure(error);
  }
}

function renameArtifact(state: HostState, params: unknown): HandlerResult {
  const parsed = renameArtifactRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  try {
    return { ok: true, result: state.renameArtifact(parsed.data) };
  } catch (error) {
    return storeFailure(error);
  }
}

function reparentArtifact(state: HostState, params: unknown): HandlerResult {
  const parsed = reparentArtifactRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  try {
    return { ok: true, result: state.reparentArtifact(parsed.data) };
  } catch (error) {
    return storeFailure(error);
  }
}

function updateArtifactStatus(
  state: HostState,
  params: unknown,
): HandlerResult {
  const parsed = updateArtifactStatusRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  try {
    return { ok: true, result: state.updateArtifactStatus(parsed.data) };
  } catch (error) {
    return storeFailure(error);
  }
}

function updateEpicTitle(state: HostState, params: unknown): HandlerResult {
  const parsed = updateEpicRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  try {
    return { ok: true, result: state.updateEpicTitle(parsed.data) };
  } catch (error) {
    return storeFailure(error);
  }
}

async function createChat(
  state: HostState,
  runner: TurnRunner,
  params: unknown,
): Promise<HandlerResult> {
  const parsed = createChatRequestSchemaV11.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  const create = async (): Promise<HandlerResult> => {
    const record = state.createChatRecord({
      epicId: parsed.data.epicId,
      chatId: parsed.data.chatId,
      parentId: parsed.data.parentId,
      hostId: parsed.data.hostId,
      title: parsed.data.title,
      settings: parsed.data.settings,
      initialMessage: parsed.data.initialMessage,
    });
    await materializeWorktreeIntentOrThrow(state, {
      epicId: parsed.data.epicId,
      ownerId: parsed.data.chatId,
      ownerKind: "chat",
      workspaceMode: parsed.data.workspaceMode,
      intent: parsed.data.worktreeIntent,
      wrapThrownErrors: false,
    });
    const pendingTurn =
      record.created &&
      parsed.data.initialMessage !== null &&
      parsed.data.initialMessage !== undefined
        ? state.startInitialChatTurn(
            parsed.data.epicId,
            parsed.data.chatId,
            parsed.data.initialMessage,
          )
        : null;
    if (pendingTurn !== null) {
      launchChatTurn(state, runner, pendingTurn);
    }
    return {
      ok: true,
      result: {
        chatId: record.chatId,
        initialTurnStarted: pendingTurn !== null,
      },
    };
  };
  try {
    return await state.withSerializedChatAction(
      parsed.data.epicId,
      parsed.data.chatId,
      create,
    );
  } catch (error) {
    return storeFailure(error);
  }
}

function renameChat(state: HostState, params: unknown): HandlerResult {
  const parsed = renameChatRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  try {
    return { ok: true, result: state.renameChat(parsed.data) };
  } catch (error) {
    return storeFailure(error);
  }
}

function reparentChat(state: HostState, params: unknown): HandlerResult {
  const parsed = reparentChatRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  try {
    return { ok: true, result: state.reparentChat(parsed.data) };
  } catch (error) {
    return storeFailure(error);
  }
}

function setChatArchived(state: HostState, params: unknown): HandlerResult {
  const parsed = setChatArchivedRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  try {
    return { ok: true, result: state.setChatArchived(parsed.data) };
  } catch (error) {
    return storeFailure(error);
  }
}

function updateChatRunSettings(
  state: HostState,
  params: unknown,
): HandlerResult {
  const parsed = updateChatRunSettingsRequestSchemaV11.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  try {
    return { ok: true, result: state.updateChatRunSettings(parsed.data) };
  } catch (error) {
    return storeFailure(error);
  }
}

function updateChatProfile(state: HostState, params: unknown): HandlerResult {
  const parsed = updateChatProfileRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  try {
    return { ok: true, result: state.updateChatProfile(parsed.data) };
  } catch (error) {
    return storeFailure(error);
  }
}

function getChatRunSettings(state: HostState, params: unknown): HandlerResult {
  const parsed = getChatRunSettingsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  try {
    return { ok: true, result: state.getChatRunSettings(parsed.data) };
  } catch (error) {
    return storeFailure(error);
  }
}

async function deleteChat(
  state: HostState,
  params: unknown,
): Promise<HandlerResult> {
  const parsed = deleteChatRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      code: "E_INVALID_ARGUMENT",
      message: parsed.error.message,
    };
  }
  try {
    return { ok: true, result: await state.deleteChat(parsed.data) };
  } catch (error) {
    return storeFailure(error);
  }
}

function storeFailure(error: unknown): HandlerResult {
  if (
    error instanceof StoreError ||
    error instanceof TuiAgentServiceError ||
    error instanceof AgentInboxServiceError
  ) {
    return { ok: false, code: error.code, message: error.message };
  }
  return {
    ok: false,
    code: "RPC_ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
}
