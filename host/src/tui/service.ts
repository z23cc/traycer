import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import {
  tuiHarnessIdSchema,
  type TuiHarnessId,
} from "@traycer/protocol/host/agent/shared";
import type {
  GenerateTuiAgentTitleRequest,
  PrepareTuiLaunchRequestV11,
  PrepareTuiLaunchResponse,
  RecordTuiAgentActivityRequestV11,
  TuiAgentPromptSubmittedRequestV11,
  TuiAgentTurnEndedRequest,
  TuiHarnessOption,
} from "@traycer/protocol/host/agent/tui/unary-schemas";
import type { CreateTuiAgentRequest } from "@traycer/protocol/host/epic/unary-schemas";
import {
  PROVIDER_DISPLAY_NAMES,
  TUI_HARNESS_ID_TO_PROVIDER_ID,
} from "@traycer/protocol/host/provider-schemas";
import { providerCliIdentity } from "../providers/service";
import { isReservedAgentId } from "@traycer/protocol/host/agent/roles";
import type { HostRuntime } from "../runtime";
import type { StoredTuiAgent } from "../store/host-store";
import { findBinding } from "../worktree/service";

const CURSOR_UNSUPPORTED =
  "agent.tui.prepareLaunch: Cursor TUI is not currently supported.";
const CLAUDE_PROBE_UNSUPPORTED =
  "agent.tui.prepareLaunch: Claude TUI launch probes are not supported.";

export function listTuiHarnesses(runtime: HostRuntime): TuiHarnessOption[] {
  const harnesses: TuiHarnessOption[] = [];
  for (const harnessId of tuiHarnessIdSchema.options) {
    const providerId = TUI_HARNESS_ID_TO_PROVIDER_ID[harnessId];
    const identity = providerCliIdentity(runtime.store, providerId);
    const cursorBlocked = harnessId === "cursor";
    const available = !cursorBlocked && identity.path !== null;
    harnesses.push({
      id: harnessId,
      label: PROVIDER_DISPLAY_NAMES[providerId],
      enabled: identity.enabled,
      available,
      error: cursorBlocked
        ? "Cursor TUI is not currently supported."
        : available
          ? null
          : "CLI not found on PATH",
      availabilityPending: false,
    });
  }
  return harnesses;
}

export async function prepareTuiLaunch(
  runtime: HostRuntime,
  request: PrepareTuiLaunchRequestV11,
): Promise<PrepareTuiLaunchResponse> {
  if (request.harnessId === "cursor") {
    throw new Error(CURSOR_UNSUPPORTED);
  }
  if (
    request.forkSourceHarnessSessionId !== null &&
    request.harnessSessionId !== null
  ) {
    throw new Error(
      "agent.tui.prepareLaunch: fork launches must not pass an existing destination harnessSessionId.",
    );
  }
  if (
    request.forkSourceHarnessSessionId !== null &&
    request.tuiAgentId === null
  ) {
    throw new Error(
      "agent.tui.prepareLaunch: probe launches must not pass forkSourceHarnessSessionId.",
    );
  }
  if (
    request.forkSourceTuiAgentId !== null &&
    request.forkSourceHarnessSessionId === null
  ) {
    throw new Error(
      "agent.tui.prepareLaunch: forkSourceTuiAgentId requires forkSourceHarnessSessionId.",
    );
  }

  const workspace = resolveTuiWorkspace(runtime, request);
  if (request.tuiAgentId === null) {
    if (request.harnessId === "claude") {
      throw new Error(CLAUDE_PROBE_UNSUPPORTED);
    }
    return {
      harnessId: request.harnessId,
      harnessSessionId: request.harnessId === "opencode" ? randomUUID() : null,
      terminalShellCommand: null,
      terminalShellArgs: null,
      hostId: runtime.hostId,
      workingDirectory: workspace.workingDirectory,
      workspaceFolders: workspace.workspaceFolders,
      worktreeBusyPaths: workspace.worktreeBusyPaths,
    };
  }

  const providerId = TUI_HARNESS_ID_TO_PROVIDER_ID[request.harnessId];
  const identity = providerCliIdentity(runtime.store, providerId);
  if (identity.path === null) {
    throw new Error(
      `agent.tui.prepareLaunch: no executable CLI for harness '${request.harnessId}'`,
    );
  }
  const extra =
    request.terminalAgentArgs === null
      ? splitTerminalAgentArgs(identity.terminalAgentArgs)
      : splitTerminalAgentArgs(request.terminalAgentArgs);
  const plan = buildTuiLaunchPlan({
    harnessId: request.harnessId,
    binaryPath: canonicalize(identity.path),
    harnessSessionId: request.harnessSessionId,
    forkSourceHarnessSessionId: request.forkSourceHarnessSessionId,
    model: request.model,
    extraArgs: extra,
  });
  await persistPreparedSession(
    runtime,
    request.epicId,
    request.tuiAgentId,
    plan.harnessSessionId,
  );
  return {
    harnessId: plan.harnessId,
    harnessSessionId: plan.harnessSessionId,
    terminalShellCommand: plan.terminalShellCommand,
    terminalShellArgs: plan.terminalShellArgs,
    hostId: runtime.hostId,
    workingDirectory: workspace.workingDirectory,
    workspaceFolders: workspace.workspaceFolders,
    worktreeBusyPaths: workspace.worktreeBusyPaths,
  };
}

export type CreateTuiAgentResult = {
  readonly tuiAgentId: string;
};

export async function createTuiAgent(
  runtime: HostRuntime,
  request: CreateTuiAgentRequest,
): Promise<CreateTuiAgentResult> {
  if (request.harnessId === "cursor") {
    throw new Error(
      "epic.createTuiAgent: Cursor TUI is not currently supported.",
    );
  }
  if (request.hostId !== runtime.hostId) {
    throw new Error(
      `epic.createTuiAgent: hostId '${request.hostId}' does not match this host.`,
    );
  }
  if (
    (request.harnessId === "claude" || request.harnessId === "opencode") &&
    request.harnessSessionId === null
  ) {
    throw new Error(
      `epic.createTuiAgent: harnessSessionId is required for ${request.harnessId}`,
    );
  }
  const epic = runtime.store
    .snapshot()
    .epics.find((row) => row.id === request.epicId);
  if (epic === undefined) {
    throw new Error("Epic not found");
  }
  const requestedId = request.tuiAgentId;
  const tuiAgentId =
    requestedId === undefined ||
    requestedId === null ||
    requestedId.length === 0
      ? randomUUID()
      : requestedId;
  // See `reservedIdRefusal` in the epic handlers: an agent that could be named
  // `traycer:system` could forge every system notice this host sends.
  if (isReservedAgentId(tuiAgentId)) {
    throw new Error(
      `'${tuiAgentId}' is a reserved agent id and may not be created.`,
    );
  }
  const workspaceMode =
    request.workspaceMode === undefined ? null : request.workspaceMode;
  const now = Date.now();
  const record: StoredTuiAgent = {
    archivedAt: null,
    tuiAgentId,
    epicId: request.epicId,
    parentId: request.parentId,
    title: request.title,
    harnessId: request.harnessId,
    harnessSessionId: request.harnessSessionId,
    terminalAgentArgs: request.terminalAgentArgs,
    terminalShellCommand: request.terminalShellCommand,
    terminalShellArgs:
      request.terminalShellArgs === null
        ? null
        : [...request.terminalShellArgs],
    hostId: request.hostId,
    workspaceFolders: [...request.workspaceFolders],
    workspaceMode,
    model: request.model,
    reasoningEffort: request.reasoningEffort,
    agentMode: request.agentMode,
    profileId: request.profileId,
    forkSourceHarnessSessionId: request.forkSourceHarnessSessionId,
    titleEditedByUser: false,
    createdAt: now,
    updatedAt: now,
  };
  await runtime.store.mutate((state) => {
    state.tuiAgents = state.tuiAgents.filter(
      (row) => row.tuiAgentId !== tuiAgentId,
    );
    state.tuiAgents.push(record);
    state.agents = state.agents.filter((row) => row.id !== tuiAgentId);
    state.agents.push({
      id: tuiAgentId,
      epicId: request.epicId,
      parentId: request.parentId,
      hostId: request.hostId,
      surface: "tui",
      harnessId: request.harnessId,
      title: request.title,
      createdAt: now,
      stopped: false,
    });
  });
  return { tuiAgentId };
}

export async function deleteTuiAgent(
  runtime: HostRuntime,
  epicId: string,
  tuiAgentId: string,
): Promise<boolean> {
  return runtime.store.mutate((state) => {
    const existed = state.tuiAgents.some(
      (row) => row.epicId === epicId && row.tuiAgentId === tuiAgentId,
    );
    state.tuiAgents = state.tuiAgents.filter(
      (row) => !(row.epicId === epicId && row.tuiAgentId === tuiAgentId),
    );
    state.agents = state.agents.filter((row) => row.id !== tuiAgentId);
    return existed;
  });
}

export async function renameTuiAgent(
  runtime: HostRuntime,
  epicId: string,
  tuiAgentId: string,
  title: string,
): Promise<boolean> {
  return runtime.store.mutate((state) => {
    const index = state.tuiAgents.findIndex(
      (row) => row.epicId === epicId && row.tuiAgentId === tuiAgentId,
    );
    if (index < 0) {
      return false;
    }
    const current = state.tuiAgents[index];
    state.tuiAgents[index] = {
      ...current,
      title,
      titleEditedByUser: true,
      updatedAt: Date.now(),
    };
    const agentIndex = state.agents.findIndex((row) => row.id === tuiAgentId);
    if (agentIndex >= 0) {
      state.agents[agentIndex] = {
        ...state.agents[agentIndex],
        title,
      };
    }
    return true;
  });
}

type TuiWorkspaceContext = {
  readonly workingDirectory: string;
  readonly workspaceFolders: string[];
  readonly worktreeBusyPaths: string[];
};

type TuiLaunchPlan = {
  readonly harnessId: TuiHarnessId;
  readonly harnessSessionId: string | null;
  readonly terminalShellCommand: string;
  readonly terminalShellArgs: string[];
};

type TuiLaunchPlanInput = {
  readonly harnessId: TuiHarnessId;
  readonly binaryPath: string;
  readonly harnessSessionId: string | null;
  readonly forkSourceHarnessSessionId: string | null;
  readonly model: string | null;
  readonly extraArgs: readonly string[];
};

function buildTuiLaunchPlan(input: TuiLaunchPlanInput): TuiLaunchPlan {
  if (input.harnessId === "claude") {
    const sessionId = input.harnessSessionId ?? randomUUID();
    const args: string[] = [];
    if (input.forkSourceHarnessSessionId !== null) {
      args.push("--resume", input.forkSourceHarnessSessionId, "--fork-session");
      args.push("--session-id", sessionId);
    } else {
      args.push("--resume", sessionId);
    }
    pushModelFlag(args, "--model", input.model);
    args.push(...input.extraArgs);
    return {
      harnessId: "claude",
      harnessSessionId: sessionId,
      terminalShellCommand: input.binaryPath,
      terminalShellArgs: args,
    };
  }
  if (input.harnessId === "codex") {
    if (input.forkSourceHarnessSessionId !== null) {
      throw new Error(
        "agent.tui.prepareLaunch: OSS host has no local analog for Codex TUI fork",
      );
    }
    const args: string[] = [];
    if (input.harnessSessionId !== null) {
      args.push("resume", input.harnessSessionId);
    }
    pushModelFlag(args, "-m", input.model);
    args.push(...input.extraArgs);
    return {
      harnessId: "codex",
      harnessSessionId: input.harnessSessionId,
      terminalShellCommand: input.binaryPath,
      terminalShellArgs: args,
    };
  }
  if (input.forkSourceHarnessSessionId !== null) {
    throw new Error(
      "agent.tui.prepareLaunch: OSS host has no local analog for OpenCode TUI fork",
    );
  }
  const sessionId = input.harnessSessionId ?? randomUUID();
  const args = ["--session", sessionId];
  pushModelFlag(args, "--model", input.model);
  args.push(...input.extraArgs);
  return {
    harnessId: "opencode",
    harnessSessionId: sessionId,
    terminalShellCommand: input.binaryPath,
    terminalShellArgs: args,
  };
}

function resolveTuiWorkspace(
  runtime: HostRuntime,
  request: PrepareTuiLaunchRequestV11,
): TuiWorkspaceContext {
  const workspaceMode =
    request.workspaceMode === undefined ? null : request.workspaceMode;
  if (workspaceMode === "folderless") {
    return {
      workingDirectory: runtime.dataDir,
      workspaceFolders: [],
      worktreeBusyPaths: [],
    };
  }
  if (request.tuiAgentId !== null) {
    const binding = findBinding(
      runtime,
      request.epicId,
      request.tuiAgentId,
      "terminal-agent",
    );
    if (binding !== undefined && binding.binding.entries.length > 0) {
      const ordered = [
        ...binding.binding.entries.filter((entry) => entry.isPrimary),
        ...binding.binding.entries.filter((entry) => !entry.isPrimary),
      ];
      const folders = uniqueCanonical(
        ordered.map((entry) => entry.worktreePath ?? entry.workspacePath),
      );
      const busy = uniqueCanonical(
        ordered.flatMap((entry) => {
          if (entry.mode !== "worktree" || entry.worktreePath === null) {
            return [];
          }
          return [entry.worktreePath];
        }),
      );
      return {
        workingDirectory: folders[0] ?? fallbackCwd(runtime),
        workspaceFolders: folders,
        worktreeBusyPaths: busy,
      };
    }
  }
  const epic = runtime.store
    .snapshot()
    .epics.find((row) => row.id === request.epicId);
  const folders =
    epic === undefined ? [] : uniqueCanonical([...epic.workspaces]);
  return {
    workingDirectory: folders[0] ?? fallbackCwd(runtime),
    workspaceFolders: folders,
    worktreeBusyPaths: [],
  };
}

async function persistPreparedSession(
  runtime: HostRuntime,
  epicId: string,
  tuiAgentId: string,
  harnessSessionId: string | null,
): Promise<void> {
  if (harnessSessionId === null) {
    return;
  }
  await runtime.store.mutate((state) => {
    const index = state.tuiAgents.findIndex(
      (row) => row.epicId === epicId && row.tuiAgentId === tuiAgentId,
    );
    if (index < 0) {
      return;
    }
    state.tuiAgents[index] = {
      ...state.tuiAgents[index],
      harnessSessionId,
      updatedAt: Date.now(),
    };
  });
}

function splitTerminalAgentArgs(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return [];
  }
  return trimmed.split(/\s+/u);
}

function pushModelFlag(
  args: string[],
  flag: string,
  model: string | null,
): void {
  if (model === null || model.length === 0) {
    return;
  }
  args.push(flag, model);
}

function uniqueCanonical(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const canonical = canonicalize(path);
    if (seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

function canonicalize(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function fallbackCwd(runtime: HostRuntime): string {
  const home = homedir();
  if (home.length > 0) {
    return home;
  }
  return runtime.dataDir;
}

export async function generateTuiTitle(
  runtime: HostRuntime,
  request: GenerateTuiAgentTitleRequest,
): Promise<{ readonly accepted: boolean }> {
  const found = findTuiAgentRecord(
    runtime,
    request.epicId,
    request.tuiAgentId,
    request.harnessSessionId,
  );
  if (found === null) {
    return { accepted: false };
  }
  if (found.harnessId !== request.harnessId) {
    throw new Error(
      "agent.tui.generateTitle: harnessId does not match the persisted TUI agent.",
    );
  }
  if (found.titleEditedByUser) {
    return { accepted: false };
  }
  const title = titleFromPrompt(request.promptText);
  await runtime.store.mutate((state) => {
    const index = state.tuiAgents.findIndex(
      (row) => row.tuiAgentId === found.tuiAgentId,
    );
    if (index < 0) {
      return;
    }
    state.tuiAgents[index] = {
      ...state.tuiAgents[index],
      title,
      updatedAt: Date.now(),
    };
    const agentIndex = state.agents.findIndex(
      (row) => row.id === found.tuiAgentId,
    );
    if (agentIndex >= 0) {
      state.agents[agentIndex] = {
        ...state.agents[agentIndex],
        title,
      };
    }
  });
  return { accepted: true };
}

export async function recordTuiActivity(
  runtime: HostRuntime,
  request: RecordTuiAgentActivityRequestV11,
): Promise<{ readonly accepted: boolean }> {
  const found = findTuiAgentRecord(
    runtime,
    request.epicId,
    request.tuiAgentId,
    request.harnessSessionId,
  );
  if (found === null || found.harnessId !== request.harnessId) {
    return { accepted: false };
  }
  if (
    request.observedHarnessSessionId !== null &&
    request.harnessId === "claude" &&
    request.observedHarnessSessionId !== found.harnessSessionId
  ) {
    await runtime.store.mutate((state) => {
      const index = state.tuiAgents.findIndex(
        (row) => row.tuiAgentId === found.tuiAgentId,
      );
      if (index < 0) {
        return;
      }
      state.tuiAgents[index] = {
        ...state.tuiAgents[index],
        harnessSessionId: request.observedHarnessSessionId,
        updatedAt: Date.now(),
      };
    });
  }
  if (request.event === "start") {
    runtime.tuiActivity.start(found.tuiAgentId);
  } else if (request.event === "stop") {
    runtime.tuiActivity.stop(found.tuiAgentId);
  }
  return { accepted: true };
}

export function recordTuiTurnEnded(
  runtime: HostRuntime,
  request: TuiAgentTurnEndedRequest,
): { readonly accepted: boolean } {
  const found = findTuiAgentRecord(
    runtime,
    request.epicId,
    request.tuiAgentId,
    null,
  );
  if (found === null || found.harnessId !== request.harnessId) {
    return { accepted: false };
  }
  runtime.tuiActivity.stop(found.tuiAgentId);
  return { accepted: true };
}

export async function recordTuiPromptSubmitted(
  runtime: HostRuntime,
  request: TuiAgentPromptSubmittedRequestV11,
): Promise<{
  readonly accepted: boolean;
  readonly pendingPromptContext: string | null;
}> {
  const recorded = await recordTuiActivity(runtime, {
    epicId: request.epicId,
    tuiAgentId: request.tuiAgentId,
    harnessSessionId: request.harnessSessionId,
    harnessId: request.harnessId,
    event: "start",
    observedHarnessSessionId: request.observedHarnessSessionId,
  });
  return { accepted: recorded.accepted, pendingPromptContext: null };
}

function findTuiAgentRecord(
  runtime: HostRuntime,
  epicId: string | null,
  tuiAgentId: string | null,
  harnessSessionId: string | null,
): StoredTuiAgent | null {
  const rows = runtime.store.snapshot().tuiAgents;
  if (tuiAgentId !== null) {
    const found = rows.find((row) => {
      if (row.tuiAgentId !== tuiAgentId) {
        return false;
      }
      return epicId === null || row.epicId === epicId;
    });
    return found === undefined ? null : found;
  }
  if (harnessSessionId !== null) {
    const found = rows.find((row) => {
      if (row.harnessSessionId !== harnessSessionId) {
        return false;
      }
      return epicId === null || row.epicId === epicId;
    });
    return found === undefined ? null : found;
  }
  return null;
}

function titleFromPrompt(prompt: string): string {
  const first = prompt.split(/\r?\n/u)[0];
  const line = (first === undefined ? prompt : first).trim();
  if (line.length === 0) {
    return "New agent";
  }
  if (line.length <= 80) {
    return line;
  }
  return `${line.slice(0, 77)}...`;
}
