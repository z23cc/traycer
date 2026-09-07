import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  handleAgentConfigure,
  handleAgentFork,
  handleValidateTuiForkProfile,
} from "../rpc/handlers/agent-config-handlers";
import { startHost, type StartedHost } from "../start-host";
import type { StoredChat, StoredTurn } from "../store/host-store";

describe("agent.configure", () => {
  let started: StartedHost | null = null;
  let tempDir: string | null = null;

  afterEach(async () => {
    await teardown();
  });

  async function teardown(): Promise<void> {
    if (started !== null) {
      await started.close();
      started = null;
    }
    if (tempDir !== null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  }

  it("persists the tuple and preserves the mode a @1.0 caller cannot state", async () => {
    const host = await boot();
    await seed(host);
    // @1.0 carries no `permissionMode`, which means "preserve current".
    const answer = await handleAgentConfigure(
      {
        epicId: "epic-1",
        senderAgentId: "chat-1",
        agentId: "chat-1",
        harnessId: "codex",
        model: "gpt-5",
        profileSelection: { kind: "ambient" },
        reasoningEffort: "high",
        fastMode: true,
      },
      host.runtime,
    );
    if (!answer.ok) {
      throw new Error(answer.message);
    }
    expect(answer.result).toEqual({
      settings: {
        harnessId: "codex",
        model: "gpt-5",
        profileSelection: { kind: "ambient" },
        reasoningEffort: "high",
        fastMode: true,
        permissionMode: "auto_accept_edits",
        agentMode: "regular",
      },
      warnings: [],
    });
    const chat = host.runtime.store
      .snapshot()
      .chats.find((row) => row.chatId === "chat-1");
    expect(chat?.fastMode).toBe(true);
    expect(chat?.runSettings).toMatchObject({
      harnessId: "codex",
      model: "gpt-5",
      permissionMode: "auto_accept_edits",
      serviceTier: "flex",
    });
  });

  it("stores a named profile and says it was never resolved", async () => {
    const host = await boot();
    await seed(host);
    const answer = await handleAgentConfigure(
      {
        epicId: "epic-1",
        senderAgentId: "chat-1",
        agentId: "chat-1",
        harnessId: "claude",
        model: "sonnet",
        profileSelection: { kind: "profile", profileId: "work" },
        reasoningEffort: null,
        fastMode: false,
        permissionMode: "supervised",
      },
      host.runtime,
    );
    if (!answer.ok) {
      throw new Error(answer.message);
    }
    const result = answer.result as {
      settings: { permissionMode: string };
      warnings: string[];
    };
    expect(result.settings.permissionMode).toBe("supervised");
    expect(result.warnings).toHaveLength(1);
  });

  it("refuses an agent that is not in the epic", async () => {
    const host = await boot();
    await seed(host);
    const answer = await handleAgentConfigure(
      {
        epicId: "epic-2",
        senderAgentId: "chat-1",
        agentId: "chat-1",
        harnessId: "claude",
        model: "sonnet",
        profileSelection: { kind: "ambient" },
        reasoningEffort: null,
        fastMode: false,
        permissionMode: null,
      },
      host.runtime,
    );
    expect(answer.ok).toBe(false);
  });

  it("forks at the latest assistant row and starts a fresh coordinate space", async () => {
    const host = await boot();
    await seed(host);
    const answer = await handleAgentFork(
      {
        epicId: "epic-1",
        senderAgentId: "chat-1",
        agentId: "chat-1",
        name: "Fork",
        permissionMode: "supervised",
        workspace: { entries: [] },
        profileSelection: { kind: "inherit" },
      },
      host.runtime,
    );
    if (!answer.ok) {
      throw new Error(answer.message);
    }
    const forked = answer.result as {
      agentId: string;
      sourceAgentId: string;
      forkedFromMessageId: string | null;
      warnings: string[];
      effectiveProfileId: string | null;
      profileOverrideApplied: boolean;
    };
    expect(forked).toMatchObject({
      sourceAgentId: "chat-1",
      forkedFromMessageId: "m-2",
      warnings: [],
      effectiveProfileId: "work",
      profileOverrideApplied: false,
    });
    const copy = host.runtime.store
      .snapshot()
      .chats.find((row) => row.chatId === forked.agentId);
    // Cut at the boundary, and numbering its own rows from a fresh epoch.
    expect(copy?.turns.map((turn) => turn.messageId)).toEqual(["m-1", "m-2"]);
    expect(copy?.transcriptEpoch).toBe(0);
    expect(copy?.parentId).toBe("chat-1");
  });

  it("answers one fork verdict per requested profile, in order", async () => {
    const host = await boot();
    const answer = handleValidateTuiForkProfile(
      {
        epicId: "epic-1",
        sourceTuiAgentId: "missing",
        targetProfileIds: [null, "work"],
      },
      host.runtime,
    );
    const resolved = await answer;
    if (!resolved.ok) {
      throw new Error(resolved.message);
    }
    const verdicts = (resolved.result as { verdicts: unknown[] }).verdicts;
    expect(verdicts).toEqual([
      {
        targetProfileId: null,
        admitted: false,
        subcode: "FORK_SOURCE_NOT_FOUND",
        message: expect.any(String),
      },
      {
        targetProfileId: "work",
        admitted: false,
        subcode: "FORK_SOURCE_NOT_FOUND",
        message: expect.any(String),
      },
    ]);
  });

  async function boot(): Promise<StartedHost> {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    return started;
  }
});

async function seed(host: StartedHost): Promise<void> {
  const chat: StoredChat = {
    epicId: "epic-1",
    chatId: "chat-1",
    parentId: null,
    hostId: host.runtime.hostId,
    title: "Root",
    createdAt: 1,
    runSettings: {
      harnessId: "claude",
      model: "sonnet",
      permissionMode: "auto_accept_edits",
      reasoningEffort: null,
      serviceTier: "flex",
      agentMode: "regular",
      profileId: "work",
    },
    fastMode: false,
    providerSession: null,
    turns: [turn("m-1", 1, "user"), turn("m-2", 2, "assistant")],
    events: [],
    transcriptEpoch: 4,
    indexRevision: 2,
    fileChangeCount: 0,
    lastUsage: null,
    archivedAt: null,
    lastAuthFailureTurnId: null,
  };
  await host.runtime.store.mutate((state) => {
    state.chats.push(chat);
  });
}

function turn(
  messageId: string,
  timestamp: number,
  role: "user" | "assistant",
): StoredTurn {
  return {
    messageId,
    timestamp,
    role,
    prompt: `message ${messageId}`,
    fromAgentId: "chat-1",
    fromTitle: "",
    fromHarnessId: role === "assistant" ? "claude" : null,
    expectReply: false,
    responseId: null,
    userId: role === "user" ? "local" : null,
    content: null,
    turnId: role === "assistant" ? `turn:${messageId}` : null,
  };
}
