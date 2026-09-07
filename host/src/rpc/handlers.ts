import type { RpcHandler } from "./handlers/types";
export type { RpcHandler, RpcHandlerResult } from "./handlers/types";
import { analogResultForMethod } from "./analog-value";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { epicGetWorkspaceContextV10 } from "@traycer/protocol/host/epic/lane-unaries";
import { browserSavedLoginSitesV10 } from "@traycer/protocol/host/browser/contracts";
import {
  configLogLevelsGetV10,
  configLogLevelsSetV10,
} from "@traycer/protocol/host/config/contracts";
import {
  hostIdentityGetV10,
  hostIdentitySetV10,
} from "@traycer/protocol/host/identity/contracts";
import {
  hostGetInstallationInfoV11,
  hostServiceStatusV10,
  hostUpdateCheckV11,
} from "@traycer/protocol/host/maintenance/contracts";
import {
  handleResourcesKill,
  handleResourcesListLocalServers,
  handleWorktreeListHolders,
  handleWorktreeSetRepoBranchPrefix,
} from "./handlers/resources-handlers";
import {
  handleManagedCommandConfigure,
  handleManagedCommandDelete,
  handleManagedCommandDeliverHeld,
  handleManagedCommandStart,
  handleManagedCommandStop,
} from "./handlers/managed-command-handlers";
import {
  handleAgentGetProviderProfileRateLimits,
  handleAgentListProviderProfiles,
  handleProvidersAwaitMcpAuth,
  handleProvidersAwaitModelProviderAuth,
  handleProvidersCancelMcpAuth,
  handleProvidersCancelModelProviderAuth,
  handleProvidersConsumeRateLimitResetCredit,
  handleProvidersListModelProviders,
  handleProvidersMcpAuth,
  handleProvidersModelProviderAuth,
  handleProvidersRefreshProfileStatus,
  handleProvidersSetProfileEnabled,
} from "./handlers/provider-profile-handlers";
import {
  handleAgentConfigure,
  handleAgentFork,
  handleValidateTuiForkProfile,
} from "./handlers/agent-config-handlers";
import {
  handleNotificationHooksSave,
  handleNotificationHooksStatus,
  handleNotificationHooksTest,
} from "./handlers/notification-handlers";
import {
  handleAgentRolesClaim,
  handleAgentRolesList,
  handleAgentRolesRelinquish,
} from "./handlers/role-handlers";
import {
  handleChatLocateRow,
  handleChatReadAccumulatedFileChange,
  handleReadChatAttachment,
} from "./handlers/chat-read-handlers";
import {
  handleDiagnosticsLogsList,
  handleDiagnosticsLogsTail,
  handleHostDoctor,
} from "./handlers/diagnostics-handlers";
import {
  handleClaimShutdown,
  handleCommitShutdown,
  handleReleaseShutdown,
} from "./handlers/lifecycle-handlers";
import {
  handleEditorOpenPaths,
  handleHostRestart,
  handleHostServiceDeregister,
  handleHostServiceRegister,
  handleHostUpdateInstall,
  handleHostStatus,
  handleRateLimitUsage,
  handleRuntimeCapabilities,
  handleSelectionGuide,
  handleSelectionGuideGlobalGet,
  handleSelectionGuideGlobalReset,
  handleSelectionGuideGlobalSet,
  handleSelectionGuideOnboardingDraft,
  handleSnapshotClear,
  handleSnapshotReadDiff,
  handleSnapshotSize,
  handleSpeechModelStatus,
} from "./handlers/misc-handlers";
import {
  handleFetchArtifactAttachment,
  handleFinishArtifactImage,
  handlePrepareArtifactImage,
} from "./handlers/attachment-handlers";
import {
  handlePlainTerminalClose,
  handlePlainTerminalCreate,
  handlePlainTerminalEnsureRunning,
  handlePlainTerminalImportLegacy,
  handlePlainTerminalList,
  handlePlainTerminalRename,
} from "./handlers/plain-terminal-handlers";
import {
  handleNotificationsClearAll,
  handleNotificationsGetConfig,
  handleNotificationsIndicatorState,
  handleNotificationsList,
  handleNotificationsMarkAllRead,
  handleNotificationsMarkRead,
  handleNotificationsResolve,
  handleNotificationsSetConfig,
} from "./handlers/notification-handlers";
import {
  handleEpicBatchDelete,
  handleEpicBatchUpdateRoles,
  handleEpicCreate,
  handleEpicCreateChat,
  handleEpicDeleteChat,
  handleEpicGetChatRunSettings,
  handleEpicGetTaskContexts,
  handleEpicGrantAccess,
  handleEpicListChatRecords,
  handleEpicListCollaborators,
  handleEpicListTasks,
  handleEpicMentionEpics,
  handleEpicRecordViewed,
  handleEpicRemoveRepo,
  handleEpicRenameChat,
  handleEpicReparentChat,
  handleEpicRetryMigration,
  handleEpicRevokeCollaborator,
  handleEpicSetChatArchived,
  handleEpicUpdateChatProfile,
  handleEpicUpdateChatRunSettings,
  handleEpicUpdateTitle,
} from "./handlers/epic-handlers";
import {
  handleCommentsListThreads,
  handleCommentsSetThreadStatus,
  handleEpicCreateArtifact,
  handleEpicCreateCommentThread,
  handleEpicDeleteArtifact,
  handleEpicDeleteComment,
  handleEpicDeleteCommentThread,
  handleEpicEditComment,
  handleEpicListCommentThreads,
  handleEpicMentionReviews,
  handleEpicMentionSpecs,
  handleEpicMentionStories,
  handleEpicMentionTickets,
  handleEpicRenameArtifact,
  handleEpicReparentArtifact,
  handleEpicResolveArtifactByPath,
  handleEpicReplyToCommentThread,
  handleEpicSetCommentThreadResolved,
  handleEpicUpdateArtifactStatus,
} from "./handlers/artifact-handlers";
import {
  handleAgentCreate,
  handleAgentGetTranscript,
  handleAgentList,
  handleAgentSendMessage,
  handleAgentStop,
} from "./handlers/agent-handlers";
import {
  handleGuiGetPlan,
  handleGuiListCommands,
  handleGuiListHarnesses,
  handleGuiListModels,
  handleInboxAck,
  handleInboxRead,
  handleListHarnessModels,
} from "./handlers/gui-handlers";
import {
  handleEpicCreateTuiAgent,
  handleEpicDeleteTuiAgent,
  handleEpicListTuiAgents,
  handleEpicRenameTuiAgent,
  handleTuiGenerateTitle,
  handleTuiListHarnesses,
  handleTuiPrepareLaunch,
  handleTuiPromptSubmitted,
  handleTuiRecordActivity,
  handleTuiTurnEnded,
} from "./handlers/tui-handlers";
import { floorUnavailable } from "./handlers/floor-handlers";
import {
  handleBrowserSavedLoginSites,
  handleConfigLogLevelsGet,
  handleConfigLogLevelsSet,
  handleEpicChatBackupStatus,
  handleEpicGetWorkspaceContext,
  handleEpicListChatPublicationTargets,
  handleEpicListCloudChats,
  handleHostChatForkGet,
  handleHostGetInstallationInfo,
  handleHostIdentityGet,
  handleHostIdentitySet,
  handleHostServiceStatus,
  handleHostUpdateCheck,
  handleHostUsageSummary,
  handlePhaseMigrateToEpic,
} from "./handlers/analog-handlers";
import {
  handleConfigEnvDelete,
  handleConfigEnvList,
  handleConfigEnvSet,
  handleConfigShellAdd,
  handleConfigShellGet,
  handleConfigShellListDetected,
  handleConfigShellProbe,
  handleConfigShellRemove,
  handleConfigShellReset,
  handleConfigShellRevertArgs,
  handleConfigShellSet,
  handleEpicSearchArtifacts,
  handleEpicSetPinned,
  handleGitGetFileContents,
  handleTerminalReadOutput,
  handleWorkspaceBrowseFolders,
  handleWorkspaceSearchPaths,
  handleWorkspaceSearchText,
  handleWorkspaceWriteFile,
} from "./handlers/optional-local-handlers";
import {
  handleGitCapabilities,
  handleGitGetFileDiff,
  handleGitGetFileDiffs,
  handleGitListChangedFiles,
} from "./handlers/git-handlers";
import {
  handleProvidersAddCustomPath,
  handleProvidersAwaitLogin,
  handleProvidersCancelLogin,
  handleProvidersClearApiKey,
  handleProvidersDeleteEnvOverride,
  handleProvidersDetectVersion,
  handleProvidersList,
  handleProvidersNativeMutate,
  handleProvidersRemoveCustomPath,
  handleProvidersSetApiKey,
  handleProvidersSetEnabled,
  handleProvidersSetEnvOverride,
  handleProvidersSetSelection,
  handleProvidersSetTerminalAgentArgs,
  handleProvidersStartLogin,
  handleProvidersStartTerminalLogin,
  handleProvidersSubmitLoginCode,
  handleProvidersTouchLogin,
} from "./handlers/provider-handlers";
import {
  handleTerminalCreate,
  handleTerminalKill,
  handleTerminalList,
  handleTerminalRename,
} from "./handlers/terminal-handlers";
import {
  handleWorkspaceListDirectory,
  handleWorkspaceListFileTree,
  handleWorkspaceMentionFiles,
  handleWorkspaceMentionFolders,
  handleWorkspaceMentionGitBranches,
  handleWorkspaceMentionGitCommits,
  handleWorkspaceMentionGitRoot,
  handleWorkspaceMentionWorktrees,
  handleWorkspacePrepareFolders,
  handleWorkspaceReadFile,
  handleWorkspaceResolvePaths,
} from "./handlers/workspace-handlers";
import {
  handleWorkspaceBindingRemoveEntry,
  handleWorktreeCreate,
  handleWorktreeCreatePaths,
  handleWorktreeDelete,
  handleWorktreeGetBinding,
  handleWorktreeImport,
  handleWorktreeListAll,
  handleWorktreeListBindingsForEpic,
  handleWorktreeListBranches,
  handleWorktreeListByWorkspacePaths,
  handleWorktreeRetrySetup,
  handleWorktreeSetEntryMode,
  handleWorktreeSetRepoScripts,
} from "./handlers/worktree-handlers";

export function handlerFor(method: string): RpcHandler {
  const found = HANDLERS[method];
  if (found !== undefined) {
    return found;
  }
  return analogFallback(method);
}

/**
 * The only safe "is anything happening" question: the run outlives its socket,
 * so a Settings pane that opens after the wizard was closed asks HERE rather
 * than subscribing and thereby attaching to - or starting - a run.
 */
const handleSessionImportStatus: RpcHandler = async (_params, runtime) => ({
  ok: true,
  result: runtime.sessionImports.status(),
});

function analogFallback(method: string): RpcHandler {
  return () => {
    const analog = analogResultForMethod(method);
    if (analog === null) {
      return {
        ok: false,
        code: "RPC_ERROR",
        message: `Unknown method ${method}`,
      };
    }
    return { ok: true, result: analog };
  };
}

export function implementedRpcMethods(): readonly string[] {
  return Object.keys(HANDLERS);
}

const CONCRETE_HANDLERS: { readonly [method: string]: RpcHandler } = {
  "sessionImport.status": handleSessionImportStatus,
  "agent.listProviderProfiles": handleAgentListProviderProfiles,
  "agent.getProviderProfileRateLimits": handleAgentGetProviderProfileRateLimits,
  "providers.refreshProfileStatus": handleProvidersRefreshProfileStatus,
  "providers.setProfileEnabled": handleProvidersSetProfileEnabled,
  "providers.consumeRateLimitResetCredit":
    handleProvidersConsumeRateLimitResetCredit,
  "providers.listModelProviders": handleProvidersListModelProviders,
  "providers.mcpAuth": handleProvidersMcpAuth,
  "providers.awaitMcpAuth": handleProvidersAwaitMcpAuth,
  "providers.cancelMcpAuth": handleProvidersCancelMcpAuth,
  "providers.modelProviderAuth": handleProvidersModelProviderAuth,
  "providers.awaitModelProviderAuth": handleProvidersAwaitModelProviderAuth,
  "providers.cancelModelProviderAuth": handleProvidersCancelModelProviderAuth,
  "host.status": handleHostStatus,
  "host.restart": handleHostRestart,
  "host.getRuntimeCapabilities": handleRuntimeCapabilities,
  "host.getRateLimitUsage": handleRateLimitUsage,
  "host.usage.summary": handleHostUsageSummary,
  "providers.list": handleProvidersList,
  "providers.nativeMutate": handleProvidersNativeMutate,
  "providers.detectVersion": handleProvidersDetectVersion,
  "providers.setEnabled": handleProvidersSetEnabled,
  "providers.setSelection": handleProvidersSetSelection,
  "providers.addCustomPath": handleProvidersAddCustomPath,
  "providers.removeCustomPath": handleProvidersRemoveCustomPath,
  "providers.setApiKey": handleProvidersSetApiKey,
  "providers.clearApiKey": handleProvidersClearApiKey,
  "providers.setTerminalAgentArgs": handleProvidersSetTerminalAgentArgs,
  "providers.setEnvOverride": handleProvidersSetEnvOverride,
  "providers.deleteEnvOverride": handleProvidersDeleteEnvOverride,
  "providers.startLogin": handleProvidersStartLogin,
  "providers.startTerminalLogin": handleProvidersStartTerminalLogin,
  "providers.awaitLogin": handleProvidersAwaitLogin,
  "providers.cancelLogin": handleProvidersCancelLogin,
  "providers.submitLoginCode": handleProvidersSubmitLoginCode,
  "providers.touchLogin": handleProvidersTouchLogin,
  "snapshots.getLocalStorageSize": handleSnapshotSize,
  "snapshots.clearLocalSnapshots": handleSnapshotClear,
  "snapshots.readSnapshotDiff": handleSnapshotReadDiff,
  "editor.openPaths": handleEditorOpenPaths,
  "agent.create": handleAgentCreate,
  "agent.sendMessage": handleAgentSendMessage,
  "agent.list": handleAgentList,
  "agent.getTranscript": handleAgentGetTranscript,
  "agent.stop": handleAgentStop,
  "agent.gui.listHarnesses": handleGuiListHarnesses,
  "agent.gui.listModels": handleGuiListModels,
  "agent.gui.listCommands": handleGuiListCommands,
  "agent.gui.getPlan": handleGuiGetPlan,
  "agent.listHarnessModels": handleListHarnessModels,
  "agent.inbox.ack": handleInboxAck,
  "agent.inbox.read": handleInboxRead,
  "agent.tui.listHarnesses": handleTuiListHarnesses,
  "agent.tui.prepareLaunch": handleTuiPrepareLaunch,
  "agent.tui.generateTitle": handleTuiGenerateTitle,
  "agent.tui.recordActivity": handleTuiRecordActivity,
  "agent.tui.turnEnded": handleTuiTurnEnded,
  "agent.tui.promptSubmitted": handleTuiPromptSubmitted,
  "agent.selectionGuide": handleSelectionGuide,
  "agent.selectionGuide.getGlobal": handleSelectionGuideGlobalGet,
  "agent.selectionGuide.setGlobal": handleSelectionGuideGlobalSet,
  "agent.selectionGuide.resetGlobalToDefault": handleSelectionGuideGlobalReset,
  "agent.selectionGuide.getGlobalOnboardingDraft":
    handleSelectionGuideOnboardingDraft,
  "speech.getModelStatus": handleSpeechModelStatus,
  "speech.ensureModel": handleSpeechModelStatus,
  "epic.create": handleEpicCreate,
  "epic.listTasks": handleEpicListTasks,
  "epic.updateTitle": handleEpicUpdateTitle,
  "epic.batchDelete": handleEpicBatchDelete,
  "phase.migrateToEpic": handlePhaseMigrateToEpic,
  "epic.createChat": handleEpicCreateChat,
  "epic.renameChat": handleEpicRenameChat,
  "epic.deleteChat": handleEpicDeleteChat,
  "epic.recordViewed": handleEpicRecordViewed,
  "epic.updateChatRunSettings": handleEpicUpdateChatRunSettings,
  "epic.getChatRunSettings": handleEpicGetChatRunSettings,
  "epic.getTaskContexts": handleEpicGetTaskContexts,
  "epic.listChatRecords": handleEpicListChatRecords,
  "epic.createTuiAgent": handleEpicCreateTuiAgent,
  "epic.deleteTuiAgent": handleEpicDeleteTuiAgent,
  "epic.renameTuiAgent": handleEpicRenameTuiAgent,
  "epic.listTuiAgents": handleEpicListTuiAgents,
  "epic.listCloudChats": handleEpicListCloudChats,
  "epic.listChatPublicationTargets": handleEpicListChatPublicationTargets,
  "epic.chatBackupStatus": handleEpicChatBackupStatus,
  "host.chatFork.get": handleHostChatForkGet,
  "host.notifications.indicatorState": handleNotificationsIndicatorState,
  "host.notifications.list": handleNotificationsList,
  "host.notifications.markRead": handleNotificationsMarkRead,
  "host.notifications.markAllRead": handleNotificationsMarkAllRead,
  "host.notifications.resolve": handleNotificationsResolve,
  "host.notifications.clearAll": handleNotificationsClearAll,
  "host.notifications.getConfig": handleNotificationsGetConfig,
  "host.notifications.setConfig": handleNotificationsSetConfig,
  "terminal.plain.create": handlePlainTerminalCreate,
  "terminal.plain.list": handlePlainTerminalList,
  "terminal.plain.rename": handlePlainTerminalRename,
  "terminal.plain.ensureRunning": handlePlainTerminalEnsureRunning,
  "terminal.plain.close": handlePlainTerminalClose,
  "terminal.plain.importLegacy": handlePlainTerminalImportLegacy,
  [epicGetWorkspaceContextV10.method]: handleEpicGetWorkspaceContext,
  [browserSavedLoginSitesV10.method]: handleBrowserSavedLoginSites,
  [configLogLevelsGetV10.method]: handleConfigLogLevelsGet,
  [configLogLevelsSetV10.method]: handleConfigLogLevelsSet,
  [hostIdentityGetV10.method]: handleHostIdentityGet,
  [hostIdentitySetV10.method]: handleHostIdentitySet,
  [hostUpdateCheckV11.method]: handleHostUpdateCheck,
  [hostGetInstallationInfoV11.method]: handleHostGetInstallationInfo,
  [hostServiceStatusV10.method]: handleHostServiceStatus,
  "epic.listCollaborators": handleEpicListCollaborators,
  "epic.grantAccess": handleEpicGrantAccess,
  "epic.batchUpdateRoles": handleEpicBatchUpdateRoles,
  "epic.revokeCollaborator": handleEpicRevokeCollaborator,
  "epic.removeRepo": handleEpicRemoveRepo,
  "epic.reparentChat": handleEpicReparentChat,
  "epic.mentionEpics": handleEpicMentionEpics,
  "epic.mentionSpecs": handleEpicMentionSpecs,
  "epic.mentionTickets": handleEpicMentionTickets,
  "epic.mentionStories": handleEpicMentionStories,
  "epic.mentionReviews": handleEpicMentionReviews,
  "epic.createArtifact": handleEpicCreateArtifact,
  "epic.deleteArtifact": handleEpicDeleteArtifact,
  "epic.renameArtifact": handleEpicRenameArtifact,
  "epic.updateArtifactStatus": handleEpicUpdateArtifactStatus,
  "epic.reparentArtifact": handleEpicReparentArtifact,
  "epic.resolveArtifactByPath": handleEpicResolveArtifactByPath,
  "epic.createCommentThread": handleEpicCreateCommentThread,
  "epic.replyToCommentThread": handleEpicReplyToCommentThread,
  "epic.editComment": handleEpicEditComment,
  "epic.deleteComment": handleEpicDeleteComment,
  "epic.setCommentThreadResolved": handleEpicSetCommentThreadResolved,
  "epic.deleteCommentThread": handleEpicDeleteCommentThread,
  "epic.listCommentThreads": handleEpicListCommentThreads,
  "comments.listThreads": handleCommentsListThreads,
  "comments.setThreadStatus": handleCommentsSetThreadStatus,
  "workspace.prepareFolders": handleWorkspacePrepareFolders,
  "workspace.listDirectory": handleWorkspaceListDirectory,
  "workspace.readFile": handleWorkspaceReadFile,
  "workspace.writeFile": handleWorkspaceWriteFile,
  "workspace.browseFolders": handleWorkspaceBrowseFolders,
  "workspace.searchPaths": handleWorkspaceSearchPaths,
  "workspace.searchText": handleWorkspaceSearchText,
  "workspace.listFileTree": handleWorkspaceListFileTree,
  "workspace.mentionFolders": handleWorkspaceMentionFolders,
  "workspace.mentionFiles": handleWorkspaceMentionFiles,
  "workspace.mentionWorktrees": handleWorkspaceMentionWorktrees,
  "workspace.mentionGitRoot": handleWorkspaceMentionGitRoot,
  "workspace.mentionGitBranches": handleWorkspaceMentionGitBranches,
  "workspace.mentionGitCommits": handleWorkspaceMentionGitCommits,
  "workspace.resolvePathsByRepoIdentifiers": handleWorkspaceResolvePaths,
  "worktree.listAllForHost": handleWorktreeListAll,
  "worktree.getBinding": handleWorktreeGetBinding,
  "worktree.listBindingsForEpic": handleWorktreeListBindingsForEpic,
  "worktree.create": handleWorktreeCreate,
  "worktree.createPaths": handleWorktreeCreatePaths,
  "worktree.import": handleWorktreeImport,
  "worktree.delete": handleWorktreeDelete,
  "worktree.setEntryMode": handleWorktreeSetEntryMode,
  "worktree.listBranches": handleWorktreeListBranches,
  "worktree.listByWorkspacePaths": handleWorktreeListByWorkspacePaths,
  "worktree.retrySetup": handleWorktreeRetrySetup,
  "worktree.setRepoScripts": handleWorktreeSetRepoScripts,
  "workspaceBinding.removeEntry": handleWorkspaceBindingRemoveEntry,
  "git.getCapabilities": handleGitCapabilities,
  "git.listChangedFiles": handleGitListChangedFiles,
  "git.getFileDiff": handleGitGetFileDiff,
  "git.getFileDiffs": handleGitGetFileDiffs,
  "git.getFileContents": handleGitGetFileContents,
  "terminal.list": handleTerminalList,
  "terminal.create": handleTerminalCreate,
  "terminal.kill": handleTerminalKill,
  "terminal.rename": handleTerminalRename,
  "terminal.readOutput": handleTerminalReadOutput,
  "epic.prepareArtifactImage": handlePrepareArtifactImage,
  "epic.finishArtifactImage": handleFinishArtifactImage,
  "epic.fetchArtifactAttachment": handleFetchArtifactAttachment,
  "epic.setChatArchived": handleEpicSetChatArchived,
  "epic.updateChatProfile": handleEpicUpdateChatProfile,
  "epic.retryMigration": handleEpicRetryMigration,
  "epic.setPinned": handleEpicSetPinned,
  "epic.searchArtifacts": handleEpicSearchArtifacts,
  "config.shell.get": handleConfigShellGet,
  "config.shell.set": handleConfigShellSet,
  "config.shell.add": handleConfigShellAdd,
  "config.shell.remove": handleConfigShellRemove,
  "config.shell.revertArgs": handleConfigShellRevertArgs,
  "config.shell.reset": handleConfigShellReset,
  "config.shell.listDetected": handleConfigShellListDetected,
  "config.shell.probe": handleConfigShellProbe,
  "config.env.list": handleConfigEnvList,
  "config.env.set": handleConfigEnvSet,
  "config.env.delete": handleConfigEnvDelete,
  "lifecycle.claimShutdown": handleClaimShutdown,
  "lifecycle.commitShutdown": handleCommitShutdown,
  "lifecycle.releaseShutdown": handleReleaseShutdown,
  "host.update.install": handleHostUpdateInstall,
  "host.service.register": handleHostServiceRegister,
  "host.service.deregister": handleHostServiceDeregister,
  "host.doctor": handleHostDoctor,
  "diagnostics.logs.list": handleDiagnosticsLogsList,
  "diagnostics.logs.tail": handleDiagnosticsLogsTail,
  "chat.locateRow": handleChatLocateRow,
  "chat.readAccumulatedFileChange": handleChatReadAccumulatedFileChange,
  "epic.readChatAttachment": handleReadChatAttachment,
  "agent.roles.claim": handleAgentRolesClaim,
  "agent.roles.list": handleAgentRolesList,
  "agent.roles.relinquish": handleAgentRolesRelinquish,
  "host.notificationHooks.status": handleNotificationHooksStatus,
  "host.notificationHooks.save": handleNotificationHooksSave,
  "host.notificationHooks.test": handleNotificationHooksTest,
  "agent.configure": handleAgentConfigure,
  "agent.fork": handleAgentFork,
  "agent.tui.validateForkProfile": handleValidateTuiForkProfile,
  "managedCommand.start": handleManagedCommandStart,
  "managedCommand.stop": handleManagedCommandStop,
  "managedCommand.configure": handleManagedCommandConfigure,
  "managedCommand.delete": handleManagedCommandDelete,
  "managedCommand.deliverHeld": handleManagedCommandDeliverHeld,
  "resources.listLocalServers": handleResourcesListLocalServers,
  "resources.kill": handleResourcesKill,
  "worktree.listHolders": handleWorktreeListHolders,
  "worktree.setRepoBranchPrefix": handleWorktreeSetRepoBranchPrefix,
};

const HANDLERS: { readonly [method: string]: RpcHandler } =
  fillFloor(CONCRETE_HANDLERS);

function fillFloor(concrete: { readonly [method: string]: RpcHandler }): {
  readonly [method: string]: RpcHandler;
} {
  const filled: { [method: string]: RpcHandler } = { ...concrete };
  for (const method of RELEASED_FLOOR_METHOD_NAMES) {
    if (filled[method] === undefined) {
      filled[method] = floorUnavailable(method);
    }
  }
  return filled;
}
