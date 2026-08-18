import { ALL_PERMISSION_MODES } from "@traycer/protocol/persistence/epic/foundation";
import {
  createArtifactRequestSchema,
  createChatRequestSchemaV11,
  createEpicRequestSchema,
  deleteArtifactRequestSchema,
  deleteChatRequestSchema,
  renameArtifactRequestSchema,
  renameChatRequestSchema,
  reparentArtifactRequestSchema,
  reparentChatRequestSchema,
  setChatArchivedRequestSchema,
  updateArtifactStatusRequestSchema,
  updateChatProfileRequestSchema,
  updateChatRunSettingsRequestSchemaV11,
  updateEpicRequestSchema,
} from "@traycer/protocol/host/epic/unary-schemas";
import { getChatRunSettingsRequestSchema } from "@traycer/protocol/host/epic/chat-records";
import {
  listGuiAgentCommandsRequestSchema,
  listGuiAgentModelsRequestSchema,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import {
  A2A_MESSAGE_MAX_UTF8_BYTES,
  createAgentRequestSchemaV30,
  listAgentsRequestSchema,
  sendAgentMessageRequestSchema,
  utf8ByteLength,
} from "@traycer/protocol/host/agent/shared";
import { gitListChangedFilesRequestSchema } from "@traycer/protocol/host/git-schemas";
import { hostNotificationsListRequestSchema } from "@traycer/protocol/host/notifications/host-notifications";
import {
  workspaceListDirectoryRequestSchema,
  workspacePrepareFoldersRequestSchemaV11,
  workspaceReadFileRequestSchema,
  workspaceResolvePathsByRepoIdentifiersRequestSchema,
} from "@traycer/protocol/host/workspace/unary-schemas";
import {
  worktreeGetBindingRequestSchema,
  worktreeCreateRequestSchema,
  worktreeCreatePathsRequestSchema,
  worktreeListBranchesRequestSchema,
  worktreeListBindingsForEpicRequestSchema,
  worktreeListByWorkspacePathsRequestSchemaV14,
  worktreeSetEntryModeRequestSchema,
  workspaceBindingRemoveEntryRequestSchema,
} from "@traycer/protocol/host/worktree-schemas";
import { listWorkspaceDirectory, readWorkspaceFile } from "./workspace-fs";
import { resolveHarnessExecutable } from "./cli-resolve";
import { probeGitCapabilities } from "./git-probe";
import { listWorktreeBranches } from "./git-branches";
import { isLocalGuiHarnessId, localGuiModelsFor } from "./gui-model-catalog";
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

function hostStatus(): HandlerResult {
  return {
    ok: true,
    result: {
      ready: true,
      hostVersion: HOST_PACKAGE_VERSION,
      protocolVersion: HOST_PROTOCOL_VERSION,
      busy: false,
      busySessionCount: 0,
      updateProgress: null,
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

function providersList(): HandlerResult {
  return {
    ok: true,
    result: {
      providers: [],
      native: null,
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
    modes: ["gui"],
    requiresApiKey: false,
    supportedPermissionModes: PERMISSION_MODES,
    availabilityPending: false,
  };
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

export function createHandlers(
  state: HostState,
  runner: TurnRunner,
): {
  readonly handleMethod: MethodDispatcher;
} {
  const handlers: Readonly<Record<string, MethodHandler>> = {
    "host.status": hostStatus,
    "host.getRuntimeCapabilities": runtimeCapabilities,
    "providers.list": providersList,
    "agent.gui.listHarnesses": listGuiHarnesses,
    "agent.gui.listModels": listGuiModels,
    "agent.gui.listCommands": listGuiCommands,
    "agent.create": (params) => createAgent(state, params),
    "agent.list": (params) => listAgents(state, params),
    "agent.sendMessage": (params) => sendAgentMessage(state, runner, params),
    "git.getCapabilities": (params) => gitCapabilities(params),
    "worktree.listAllForHost": () => ({
      ok: true,
      result: { worktrees: [], nextCursor: null },
    }),
    "worktree.getBinding": (params) => getBinding(state, params),
    "worktree.create": (params) => createWorktree(state, params),
    "worktree.createPaths": (params) => createWorktreePaths(state, params),
    "worktree.listBranches": (params) => listBranches(params),
    "worktree.setEntryMode": (params) => setWorktreeEntryMode(state, params),
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
    "workspace.readFile": (params) => readFile(params),
    "epic.create": (params) => createEpic(state, runner, params),
    "epic.createArtifact": (params) => createArtifact(state, params),
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
  if (error instanceof StoreError) {
    return { ok: false, code: error.code, message: error.message };
  }
  return {
    ok: false,
    code: "RPC_ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
}
