import { randomUUID } from "node:crypto";
import {
  harnessIdSchema,
  type AgentSummary,
} from "@traycer/protocol/host/agent/shared";
import { runGuiPrintTurn } from "../gui/deliver";
import type { HostRuntime } from "../runtime";
import type { StoredAgent, StoredChat, StoredTurn } from "../store/host-store";

export type CreateAgentInput = {
  readonly senderAgentId: string;
  readonly epicId: string;
  readonly name: string | null;
  readonly surface: "gui" | "tui" | null;
  readonly harnessId: string | null;
};

export type SendAgentInput = {
  readonly senderAgentId: string;
  readonly epicId: string;
  readonly receiverAgentId: string;
  readonly prompt: string;
  readonly responseId: string | null;
  readonly expectReply: boolean;
};

export async function createLocalAgent(
  runtime: HostRuntime,
  input: CreateAgentInput,
): Promise<{ readonly agentId: string; readonly warnings: readonly string[] }> {
  const sender = runtime.store
    .snapshot()
    .agents.find((row) => row.id === input.senderAgentId);
  const now = Date.now();
  const agentId = randomUUID();
  const surface = input.surface ?? sender?.surface ?? "gui";
  const harnessId = input.harnessId ?? sender?.harnessId ?? "claude";
  const title = input.name ?? "";
  const agent: StoredAgent = {
    id: agentId,
    epicId: input.epicId,
    parentId: input.senderAgentId,
    hostId: runtime.hostId,
    surface,
    harnessId,
    title: input.name,
    createdAt: now,
    stopped: false,
  };
  await runtime.store.mutate((state) => {
    state.agents = state.agents.filter((row) => row.id !== agentId);
    state.agents.push(agent);
    if (surface === "gui") {
      const chat: StoredChat = {
        epicId: input.epicId,
        chatId: agentId,
        parentId: input.senderAgentId,
        hostId: runtime.hostId,
        title,
        createdAt: now,
        runSettings: null,
        providerSession: null,
        turns: [],
        events: [],
        transcriptEpoch: 0,
        indexRevision: 0,
        accumulatedChanges: [],
        lastUsage: null,
        archivedAt: null,
        lastAuthFailureTurnId: null,
        pinnedTodo: null,
        fastMode: false,
      };
      state.chats = state.chats.filter((row) => row.chatId !== agentId);
      state.chats.push(chat);
    }
  });
  return { agentId, warnings: [] };
}

export async function sendLocalAgentMessage(
  runtime: HostRuntime,
  input: SendAgentInput,
): Promise<{ readonly responseId: string | null }> {
  const snapshot = runtime.store.snapshot();
  const sender = snapshot.agents.find((row) => row.id === input.senderAgentId);
  if (sender === undefined) {
    throw new Error(
      `agent.sendMessage: sender agent '${input.senderAgentId}' was not found.`,
    );
  }
  if (sender.hostId !== runtime.hostId) {
    throw new Error(
      `agent.sendMessage: SENDER_NOT_LOCAL - sender '${input.senderAgentId}' is not local to host '${runtime.hostId}'.`,
    );
  }
  const receiver = snapshot.agents.find(
    (row) => row.id === input.receiverAgentId,
  );
  if (receiver === undefined) {
    throw new Error(
      `agent.sendMessage: RECEIVER_NOT_FOUND - '${input.receiverAgentId}'.`,
    );
  }
  if (receiver.hostId !== runtime.hostId) {
    throw new Error(
      `agent.sendMessage: RECEIVER_NOT_LOCAL - '${input.receiverAgentId}' is not local to host '${runtime.hostId}'.`,
    );
  }
  if (receiver.stopped) {
    throw new Error(
      `agent.sendMessage: RECEIVER_CANCELLING - '${input.receiverAgentId}' is being stopped`,
    );
  }
  const responseId = input.expectReply
    ? (input.responseId ?? randomUUID())
    : input.responseId;
  const turn: StoredTurn = {
    messageId: randomUUID(),
    timestamp: Date.now(),
    role: "user",
    prompt: input.prompt,
    fromAgentId: sender.id,
    fromTitle: sender.title ?? sender.id,
    fromHarnessId: sender.harnessId,
    expectReply: input.expectReply,
    responseId,
    userId: null,
    content: null,
    turnId: null,
    blocks: null,
  };
  await runtime.store.mutate((state) => {
    let chat = state.chats.find((row) => row.chatId === receiver.id);
    if (chat === undefined) {
      chat = {
        epicId: input.epicId,
        chatId: receiver.id,
        parentId: receiver.parentId,
        hostId: runtime.hostId,
        title: receiver.title ?? "",
        // The chat exists to hold this turn, so it cannot be younger than it -
        // a second clock read here would date the receiver after the delivery
        // it was created for, and the communication graph reads that ordering.
        createdAt: turn.timestamp,
        runSettings: null,
        providerSession: null,
        turns: [],
        events: [],
        transcriptEpoch: 0,
        indexRevision: 0,
        accumulatedChanges: [],
        lastUsage: null,
        archivedAt: null,
        lastAuthFailureTurnId: null,
        pinnedTodo: null,
        fastMode: false,
      };
      state.chats.push(chat);
    }
    chat.turns.push(turn);
  });
  if (receiver.surface === "tui") {
    const envelope = runtime.inbox.enqueue({
      epicId: input.epicId,
      toAgentId: receiver.id,
      fromAgentId: sender.id,
      senderTitle: sender.title,
      senderHarnessId: sender.harnessId,
      prompt: input.prompt,
      expectsReply: input.expectReply,
      responseId,
    });
    // A monitor attached right now sees it immediately; one that attaches
    // later drains the same durable row on subscribe.
    for (const monitor of runtime.inboxMonitors.forAgent(receiver.id)) {
      monitor.deliver(envelope);
    }
    return { responseId };
  }
  if (!input.expectReply) {
    return { responseId };
  }
  const cwd = guiWorkingDirectory(runtime, receiver.epicId);
  const replyText = await runGuiPrintTurn(runtime, {
    agentId: receiver.id,
    harnessId: receiver.harnessId ?? "claude",
    prompt: input.prompt,
    cwd,
    model: null,
    permissionMode: "full_access",
    sessionId: null,
    autonomous: false,
    onEvent: () => {
      return;
    },
  });
  const reply: StoredTurn = {
    messageId: randomUUID(),
    timestamp: Date.now(),
    role: "assistant",
    prompt: replyText,
    fromAgentId: receiver.id,
    fromTitle: receiver.title ?? receiver.id,
    fromHarnessId: receiver.harnessId,
    expectReply: false,
    responseId,
    userId: null,
    content: null,
    turnId: null,
    blocks: null,
  };
  await runtime.store.mutate((state) => {
    const chat = state.chats.find((row) => row.chatId === receiver.id);
    if (chat === undefined) {
      return;
    }
    chat.turns.push(reply);
  });
  return { responseId };
}

function guiWorkingDirectory(runtime: HostRuntime, epicId: string): string {
  const epic = runtime.store.snapshot().epics.find((row) => row.id === epicId);
  const first = epic?.workspaces[0];
  if (first !== undefined && first.length > 0) {
    return first;
  }
  return runtime.dataDir;
}

export function listLocalAgents(
  runtime: HostRuntime,
  epicId: string,
  senderAgentId: string,
  scope: "user" | "all",
): {
  readonly caller: {
    readonly agentId: string;
    readonly canSendMessages: boolean;
  };
  readonly scope: "user" | "all";
  readonly agents: AgentSummary[];
} {
  void scope;
  const agents = runtime.store
    .snapshot()
    .agents.filter((row) => row.epicId === epicId)
    .map((row) => toSummary(row, runtime.hostId, senderAgentId));
  return {
    caller: { agentId: senderAgentId, canSendMessages: true },
    scope,
    agents,
  };
}

export function agentTranscript(runtime: HostRuntime, agentId: string): string {
  const chat = runtime.store
    .snapshot()
    .chats.find((row) => row.chatId === agentId);
  if (chat === undefined) {
    return "";
  }
  return chat.turns
    .map((turn) => {
      if (turn.role === "assistant") {
        return `<assistant agent="${turn.fromAgentId}">${turn.prompt}</assistant>`;
      }
      return `<user agent="${turn.fromAgentId}">${turn.prompt}</user>`;
    })
    .join("\n");
}

export async function stopLocalAgent(
  runtime: HostRuntime,
  agentId: string,
  cascade: boolean,
): Promise<readonly string[]> {
  const snapshot = runtime.store.snapshot();
  const ids = new Set<string>([agentId]);
  if (cascade) {
    let grew = true;
    while (grew) {
      grew = false;
      for (const agent of snapshot.agents) {
        if (
          agent.parentId !== null &&
          ids.has(agent.parentId) &&
          !ids.has(agent.id)
        ) {
          ids.add(agent.id);
          grew = true;
        }
      }
    }
  }
  await runtime.store.mutate((state) => {
    for (const id of ids) {
      const index = state.agents.findIndex((row) => row.id === id);
      if (index >= 0) {
        state.agents[index] = { ...state.agents[index], stopped: true };
      }
    }
  });
  for (const id of ids) {
    runtime.guiRuns.kill(id);
    runtime.tuiActivity.stop(id);
  }
  return [...ids];
}

function toSummary(
  agent: StoredAgent,
  hostId: string,
  senderAgentId: string,
): AgentSummary {
  return {
    id: agent.id,
    parentId: agent.parentId,
    hostId: agent.hostId,
    isLocal: agent.hostId === hostId,
    surface: agent.surface,
    harnessId: parsedHarnessId(agent.harnessId),
    isSelf: agent.id === senderAgentId,
    title: agent.title,
    capabilities: {
      readTranscript: true,
      sendMessage: true,
    },
    active: !agent.stopped,
    folderPaths: [],
    isWorktree: false,
    runConfig: null,
  };
}

function parsedHarnessId(value: string | null): AgentSummary["harnessId"] {
  if (value === null) {
    return null;
  }
  const parsed = harnessIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
