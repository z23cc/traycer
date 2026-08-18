import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createEpicRequestSchema } from "@traycer/protocol/host/epic/unary-schemas";
import {
  artifactBodyFragmentName,
  deletedEpicArtifactSchema,
} from "@traycer/protocol/persistence/epic/artifacts";
import { HostState, StoreError } from "../store";

describe("HostState chat sinks", () => {
  it("isolates and removes a chat sink that throws", () => {
    const state = new HostState("host-local", undefined, undefined);
    let healthyCalls = 0;
    state.subscribeChat("epic-1", "chat-1", () => {
      throw new Error("socket closed");
    });
    state.subscribeChat("epic-1", "chat-1", () => {
      healthyCalls += 1;
    });

    expect(() =>
      state.emitChat("epic-1", "chat-1", { kind: "first" }),
    ).not.toThrow();
    state.emitChat("epic-1", "chat-1", { kind: "second" });
    expect(healthyCalls).toBe(2);
  });
});

describe("HostState agent directory", () => {
  it("updates future settings during an active turn but refuses its workspace rebind", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "traycer-configure-active-"),
    );
    const state = stateWithEpic();
    const settings = {
      harnessId: "codex" as const,
      model: "gpt-5.4",
      permissionMode: "full_access" as const,
      reasoningEffort: null,
      serviceTier: null,
      agentMode: "regular" as const,
      profileId: null,
    };
    for (const chatId of ["configure-sender", "configure-target"]) {
      state.createChat({
        epicId: "epic-1",
        chatId,
        parentId: null,
        hostId: "host-local",
        title: chatId,
        settings,
        initialMessage: null,
      });
    }
    state.reserveTurn("epic-1", "configure-target");

    try {
      await expect(
        state.configureAgentFromAgent({
          epicId: "epic-1",
          senderAgentId: "configure-sender",
          agentId: "configure-target",
          harnessId: "claude",
          model: "claude-sonnet-4",
          profileSelection: { kind: "ambient" },
          reasoningEffort: null,
          fastMode: false,
          permissionMode: "auto_accept_edits",
          workspace: {
            entries: [{ path: workspace, workspacePath: null }],
          },
        }),
      ).rejects.toMatchObject({
        code: "WORKTREE_REBIND_BLOCKED",
        message: "Stop the active chat run before rebinding its worktree.",
      });
      expect(state.getChat("epic-1", "configure-target")?.settings).toEqual(
        settings,
      );

      await expect(
        state.configureAgentFromAgent({
          epicId: "epic-1",
          senderAgentId: "configure-sender",
          agentId: "configure-target",
          harnessId: "claude",
          model: "claude-sonnet-4",
          profileSelection: { kind: "ambient" },
          reasoningEffort: null,
          fastMode: false,
          permissionMode: "auto_accept_edits",
          workspace: null,
        }),
      ).resolves.toMatchObject({
        settings: {
          harnessId: "claude",
          model: "claude-sonnet-4",
          permissionMode: "auto_accept_edits",
        },
      });
      expect(state.getChat("epic-1", "configure-target")?.settings).toEqual({
        ...settings,
        harnessId: "claude",
        model: "claude-sonnet-4",
        permissionMode: "auto_accept_edits",
      });
    } finally {
      state.releaseTurn("epic-1", "configure-target");
      state.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("enumerates replicated GUI and TUI records with signed scope and capability gates", () => {
    const state = stateWithEpic();
    state.createChat({
      epicId: "epic-1",
      chatId: "caller",
      parentId: null,
      hostId: "host-local",
      title: "Caller",
      settings: {
        harnessId: "codex",
        model: "gpt-5.4",
        permissionMode: "full_access",
        reasoningEffort: null,
        serviceTier: null,
        agentMode: "regular",
        profileId: null,
      },
      initialMessage: null,
    });
    seedAgentListChat(state, {
      id: "remote-same-user",
      hostId: "host-remote",
      userId: "local-user",
      title: "Remote GUI",
      harnessId: "codex",
    });
    seedAgentListChat(state, {
      id: "future-gui",
      hostId: "host-remote",
      userId: "local-user",
      title: "Future GUI",
      harnessId: "huggingface",
    });
    seedAgentListChat(state, {
      id: "remote-other-user",
      hostId: "host-remote",
      userId: "other-user",
      title: "Other GUI",
      harnessId: "codex",
    });
    seedAgentListChat(state, {
      id: "legacy-userless",
      hostId: "host-remote",
      userId: null,
      title: "Legacy GUI",
      harnessId: "codex",
    });
    seedAgentListTui(state, {
      id: "local-claude-tui",
      hostId: "host-local",
      userId: "local-user",
      harnessId: "claude",
      archivedAt: 500,
      workspaceFolders: [" /local/tui ", "/local/tui", ""],
    });
    seedAgentListTui(state, {
      id: "remote-codex-tui",
      hostId: "host-remote",
      userId: "local-user",
      harnessId: "codex",
      archivedAt: null,
      workspaceFolders: [" /remote/tui "],
    });
    seedAgentListTui(state, {
      id: "legacy-cursor-tui",
      hostId: "host-local",
      userId: "local-user",
      harnessId: "cursor",
      archivedAt: null,
      workspaceFolders: ["/cursor"],
    });
    state.reserveTurn("epic-1", "caller");
    state.reserveTurn("epic-1", "local-claude-tui");

    const userScoped = state.listAgents({
      epicId: "epic-1",
      senderAgentId: "caller",
      scope: "user",
    });
    expect(userScoped.caller).toEqual({
      agentId: "caller",
      canSendMessages: true,
    });
    expect(userScoped.agents.map((agent) => agent.id)).toEqual([
      "caller",
      "remote-same-user",
      "future-gui",
      "local-claude-tui",
      "remote-codex-tui",
    ]);
    expect(
      userScoped.agents.find((agent) => agent.id === "caller"),
    ).toMatchObject({
      isSelf: true,
      active: true,
      capabilities: { readTranscript: true, sendMessage: true },
    });
    expect(
      userScoped.agents.find((agent) => agent.id === "remote-same-user"),
    ).toMatchObject({
      isLocal: false,
      harnessId: "codex",
      capabilities: { readTranscript: true, sendMessage: false },
      folderPaths: [],
    });
    expect(
      userScoped.agents.find((agent) => agent.id === "future-gui"),
    ).toMatchObject({
      harnessId: null,
      capabilities: { readTranscript: true, sendMessage: false },
    });
    expect(
      userScoped.agents.find((agent) => agent.id === "local-claude-tui"),
    ).toMatchObject({
      surface: "tui",
      active: false,
      capabilities: { readTranscript: true, sendMessage: true },
      folderPaths: ["/local/tui"],
      isWorktree: false,
    });
    expect(
      userScoped.agents.find((agent) => agent.id === "remote-codex-tui"),
    ).toMatchObject({
      isLocal: false,
      capabilities: { readTranscript: false, sendMessage: false },
      folderPaths: ["/remote/tui"],
    });

    const all = state.listAgents({
      epicId: "epic-1",
      senderAgentId: "caller",
      scope: "all",
    });
    expect(all.agents.map((agent) => agent.id)).toEqual([
      "caller",
      "remote-same-user",
      "future-gui",
      "remote-other-user",
      "legacy-userless",
      "local-claude-tui",
      "remote-codex-tui",
    ]);
    expect(
      all.agents.find((agent) => agent.id === "remote-other-user"),
    ).toMatchObject({
      capabilities: { readTranscript: false, sendMessage: false },
    });
    expect(
      all.agents.find((agent) => agent.id === "legacy-userless"),
    ).toMatchObject({
      capabilities: { readTranscript: false, sendMessage: false },
    });
    const remoteTuiCaller = state.listAgents({
      epicId: "epic-1",
      senderAgentId: "remote-codex-tui",
      scope: "user",
    });
    expect(remoteTuiCaller.caller).toEqual({
      agentId: "remote-codex-tui",
      canSendMessages: false,
    });
    expect(
      remoteTuiCaller.agents.find((agent) => agent.id === "remote-codex-tui"),
    ).toMatchObject({ isSelf: true, surface: "tui" });

    state.releaseTurn("epic-1", "caller");
    state.releaseTurn("epic-1", "local-claude-tui");
    expect(
      state
        .listAgents({
          epicId: "epic-1",
          senderAgentId: "caller",
          scope: "user",
        })
        .agents.find((agent) => agent.id === "caller")?.active,
    ).toBe(false);
    expect(() =>
      state.listAgents({
        epicId: "epic-1",
        senderAgentId: "missing",
        scope: "user",
      }),
    ).toThrow("agent.list: sender agent 'missing' was not found.");
    state.dispose();
  });

  it("filters another user's malformed wire row before response validation", () => {
    const state = stateWithEpic();
    state.createChat({
      epicId: "epic-1",
      chatId: "caller",
      parentId: null,
      hostId: "host-local",
      title: "Caller",
      settings: null,
      initialMessage: null,
    });
    seedAgentListChat(state, {
      id: "malformed-other-user",
      hostId: null,
      userId: "other-user",
      title: "Malformed",
      harnessId: "codex",
    });

    expect(
      state
        .listAgents({
          epicId: "epic-1",
          senderAgentId: "caller",
          scope: "user",
        })
        .agents.map((agent) => agent.id),
    ).toEqual(["caller"]);
    expect(() =>
      state.listAgents({
        epicId: "epic-1",
        senderAgentId: "caller",
        scope: "all",
      }),
    ).toThrow(
      "agent.list: GUI agent 'malformed-other-user' record is invalid.",
    );
    state.dispose();
  });

  it("repairs the missing terminal-agent collection in a legacy Epic", () => {
    const state = stateWithEpic();
    state.createChat({
      epicId: "epic-1",
      chatId: "caller",
      parentId: null,
      hostId: "host-local",
      title: "Caller",
      settings: null,
      initialMessage: null,
    });
    const epic = state.getEpic("epic-1");
    if (epic === null) {
      throw new Error("Missing test epic");
    }
    const root = epic.doc.getMap<unknown>("epic");
    root.delete("tuiAgents");

    expect(
      state.listAgents({
        epicId: "epic-1",
        senderAgentId: "caller",
        scope: "user",
      }).agents,
    ).toHaveLength(1);
    expect(root.get("tuiAgents")).toBeInstanceOf(Y.Map);
    state.dispose();
  });

  it("accepts plain TUI records and skips invalid legacy values by harness", () => {
    const state = stateWithEpic();
    state.createChat({
      epicId: "epic-1",
      chatId: "caller",
      parentId: null,
      hostId: "host-local",
      title: "Caller",
      settings: null,
      initialMessage: null,
    });
    const epic = state.getEpic("epic-1");
    const tuiAgents = epic?.doc.getMap<unknown>("epic").get("tuiAgents");
    if (!(tuiAgents instanceof Y.Map)) {
      throw new Error("Missing terminal-agent map");
    }
    tuiAgents.set("legacy-number", 42);
    tuiAgents.set("legacy-string", "junk");
    tuiAgents.set("legacy-bad-harness", { harnessId: "future" });
    tuiAgents.set("legacy-cursor", { harnessId: "cursor" });
    tuiAgents.set("plain-claude", {
      parentId: "caller",
      hostId: "host-local",
      userId: "local-user",
      title: "Plain Claude",
      archivedAt: null,
      harnessId: "claude",
      workspaceFolders: [" /plain/tui ", "/plain/tui"],
    });

    const listed = state.listAgents({
      epicId: "epic-1",
      senderAgentId: "caller",
      scope: "user",
    });
    expect(listed.agents.map((agent) => agent.id)).toEqual([
      "caller",
      "plain-claude",
    ]);
    expect(listed.agents[1]).toMatchObject({
      parentId: "caller",
      surface: "tui",
      harnessId: "claude",
      folderPaths: ["/plain/tui"],
      capabilities: { readTranscript: true, sendMessage: true },
    });
    state.dispose();
  });

  it("deduplicates binding paths and requires every entry to be a worktree", async () => {
    const state = stateWithEpic();
    for (const chatId of ["mixed", "worktrees"]) {
      state.createChat({
        epicId: "epic-1",
        chatId,
        parentId: null,
        hostId: "host-local",
        title: chatId,
        settings: null,
        initialMessage: null,
      });
    }
    await state.createWorktree({
      epicId: "epic-1",
      ownerId: "mixed",
      ownerKind: "chat",
      entries: [
        {
          kind: "local",
          workspacePath: " /plain ",
          repoIdentifier: null,
          isPrimary: true,
        },
        {
          kind: "import",
          workspacePath: "/source-a",
          worktreePath: " /shared-run ",
          repoIdentifier: null,
          isPrimary: false,
        },
      ],
    });
    await state.createWorktree({
      epicId: "epic-1",
      ownerId: "worktrees",
      ownerKind: "chat",
      entries: [
        {
          kind: "import",
          workspacePath: "/source-a",
          worktreePath: " /shared-run ",
          repoIdentifier: null,
          isPrimary: true,
        },
        {
          kind: "import",
          workspacePath: "/source-b",
          worktreePath: "/shared-run",
          repoIdentifier: null,
          isPrimary: false,
        },
      ],
    });

    const listed = state.listAgents({
      epicId: "epic-1",
      senderAgentId: "mixed",
      scope: "all",
    });
    expect(listed.agents.find((agent) => agent.id === "mixed")).toMatchObject({
      folderPaths: ["/plain", "/shared-run"],
      isWorktree: false,
    });
    expect(
      listed.agents.find((agent) => agent.id === "worktrees"),
    ).toMatchObject({
      folderPaths: ["/shared-run"],
      isWorktree: true,
    });
    state.dispose();
  });
});

describe("HostState agent messages", () => {
  it("forbids delivery to another user's resolved GUI agent without side effects", () => {
    const state = stateWithEpic();
    const settings = {
      harnessId: "codex" as const,
      model: "gpt-5.4",
      permissionMode: "full_access" as const,
      reasoningEffort: null,
      serviceTier: null,
      agentMode: "regular" as const,
      profileId: null,
    };
    state.createChat({
      epicId: "epic-1",
      chatId: "sender-agent-full",
      parentId: null,
      hostId: "host-local",
      title: "Sender agent",
      settings,
      initialMessage: null,
    });
    state.createChat({
      epicId: "epic-1",
      chatId: "receiver-agent-full",
      parentId: "sender-agent-full",
      hostId: "host-local",
      title: "Receiver agent",
      settings,
      initialMessage: null,
    });
    chatEntry(state, "receiver-agent-full").set("userId", "other-user");
    const receiver = state.getChat("epic-1", "receiver-agent-full");
    if (receiver === null) {
      throw new Error("Missing receiver chat");
    }
    const messagesBefore = [...receiver.messages];

    let thrown: unknown = null;
    try {
      state.acceptAgentMessage({
        epicId: "epic-1",
        senderAgentId: "sender-agent-full",
        receiverAgentId: "rece",
        prompt: "This must not be delivered",
        responseId: null,
        expectReply: false,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(StoreError);
    if (!(thrown instanceof StoreError)) {
      throw new Error("Expected StoreError");
    }
    expect(thrown.code).toBe("FORBIDDEN");
    expect(thrown.message).toBe("receiver-agent-full");
    expect(state.getChat("epic-1", "receiver-agent-full")?.messages).toEqual(
      messagesBefore,
    );
    expect(state.hasInflightTurns()).toBe(false);
    state.dispose();
  });

  it("drops queued agent messages when their busy receiver is deleted", async () => {
    const state = stateWithEpic();
    const settings = {
      harnessId: "codex" as const,
      model: "gpt-5.4",
      permissionMode: "full_access" as const,
      reasoningEffort: null,
      serviceTier: null,
      agentMode: "regular" as const,
      profileId: null,
    };
    state.createChat({
      epicId: "epic-1",
      chatId: "busy-sender",
      parentId: null,
      hostId: "host-local",
      title: "Busy sender",
      settings,
      initialMessage: null,
    });
    state.createChat({
      epicId: "epic-1",
      chatId: "busy-receiver",
      parentId: "busy-sender",
      hostId: "host-local",
      title: "Busy receiver",
      settings,
      initialMessage: null,
    });
    await state.setWorktreeEntryMode({
      epicId: "epic-1",
      ownerId: "busy-receiver",
      ownerKind: "chat",
      workspacePath: process.cwd(),
    });
    state.reserveTurn("epic-1", "busy-receiver");

    expect(
      state.acceptAgentMessage({
        epicId: "epic-1",
        senderAgentId: "busy-sender",
        receiverAgentId: "busy-receiver",
        prompt: "Queue this behind the active turn",
        responseId: null,
        expectReply: false,
      }),
    ).toEqual({ response: { responseId: null }, pendingTurn: null });
    expect(state.getChat("epic-1", "busy-receiver")?.messages).toEqual([]);
    expect(state.hasInflightTurns()).toBe(true);

    expect(
      await state.deleteChat({
        epicId: "epic-1",
        chatId: "busy-receiver",
      }),
    ).toEqual({ deleted: true });
    state.releaseTurn("epic-1", "busy-receiver");

    expect(
      state.startNextQueuedAgentMessage("epic-1", "busy-receiver"),
    ).toBeNull();
    expect(state.hasInflightTurns()).toBe(false);
    state.dispose();
  });

  it("reuses a response thread across epics and settles it by ordered pair", async () => {
    const state = stateWithEpic();
    state.createEpic(epicCreationRequest("epic-2", "Second artifact task"));
    const settings = {
      harnessId: "codex" as const,
      model: "gpt-5.4",
      permissionMode: "full_access" as const,
      reasoningEffort: null,
      serviceTier: null,
      agentMode: "regular" as const,
      profileId: null,
    };
    for (const epicId of ["epic-1", "epic-2"]) {
      state.createChat({
        epicId,
        chatId: "pair-agent-a",
        parentId: null,
        hostId: "host-local",
        title: "Pair agent A",
        settings,
        initialMessage: null,
      });
      state.createChat({
        epicId,
        chatId: "pair-agent-b",
        parentId: "pair-agent-a",
        hostId: "host-local",
        title: "Pair agent B",
        settings,
        initialMessage: null,
      });
      for (const ownerId of ["pair-agent-a", "pair-agent-b"]) {
        await state.setWorktreeEntryMode({
          epicId,
          ownerId,
          ownerKind: "chat",
          workspacePath: process.cwd(),
        });
      }
    }

    const first = state.acceptAgentMessage({
      epicId: "epic-1",
      senderAgentId: "pair-agent-a",
      receiverAgentId: "pair-agent-b",
      prompt: "Open a response thread in epic one",
      responseId: null,
      expectReply: true,
    });
    expect(first.response.responseId).toEqual(expect.any(String));
    state.releaseTurn("epic-1", "pair-agent-b");
    const responseId = first.response.responseId;
    if (responseId === null) {
      throw new Error("Missing response id");
    }

    const second = state.acceptAgentMessage({
      epicId: "epic-2",
      senderAgentId: "pair-agent-a",
      receiverAgentId: "pair-agent-b",
      prompt: "Reuse the response thread in epic two",
      responseId: null,
      expectReply: true,
    });
    expect(second.response.responseId).toBe(responseId);
    state.releaseTurn("epic-2", "pair-agent-b");

    expect(
      state.acceptAgentMessage({
        epicId: "epic-2",
        senderAgentId: "pair-agent-b",
        receiverAgentId: "pair-agent-a",
        prompt: "Settle from epic two",
        responseId,
        expectReply: false,
      }),
    ).toMatchObject({
      response: { responseId: null },
      pendingTurn: { epicId: "epic-2", chatId: "pair-agent-a" },
    });
    state.releaseTurn("epic-2", "pair-agent-a");
    expect(state.hasInflightTurns()).toBe(false);
    state.dispose();
  });

  it("hydrates a replicated GUI receiver after settling its response thread", async () => {
    const state = stateWithEpic();
    const settings = {
      harnessId: "codex" as const,
      model: "gpt-5.4",
      permissionMode: "full_access" as const,
      reasoningEffort: null,
      serviceTier: null,
      agentMode: "regular" as const,
      profileId: null,
    };
    state.createChat({
      epicId: "epic-1",
      chatId: "settle-agent-a",
      parentId: null,
      hostId: "host-local",
      title: "Settle agent A",
      settings,
      initialMessage: null,
    });
    await state.setWorktreeEntryMode({
      epicId: "epic-1",
      ownerId: "settle-agent-a",
      ownerKind: "chat",
      workspacePath: process.cwd(),
    });
    await state.setWorktreeEntryMode({
      epicId: "epic-1",
      ownerId: "settle-agent-b",
      ownerKind: "chat",
      workspacePath: process.cwd(),
    });
    state.createChat({
      epicId: "epic-1",
      chatId: "settle-agent-b",
      parentId: "settle-agent-a",
      hostId: "host-local",
      title: "Settle agent B",
      settings,
      initialMessage: null,
    });

    const opened = state.acceptAgentMessage({
      epicId: "epic-1",
      senderAgentId: "settle-agent-a",
      receiverAgentId: "settle-agent-b",
      prompt: "Open the response thread",
      responseId: null,
      expectReply: true,
    });
    state.releaseTurn("epic-1", "settle-agent-b");
    const responseId = opened.response.responseId;
    if (responseId === null) {
      throw new Error("Missing response id");
    }

    const epic = state.getEpic("epic-1");
    const liveAgentA = epic?.chats.get("settle-agent-a");
    if (epic === null || liveAgentA === undefined) {
      throw new Error("Missing live agent A");
    }
    const replicatedEntry = chatEntry(state, "settle-agent-a");
    replicatedEntry.set("title", "Hydrated agent A");
    replicatedEntry.set("parentId", "persisted-parent");
    replicatedEntry.set("createdAt", 123);
    replicatedEntry.set("updatedAt", 456);
    replicatedEntry.set("archivedAt", 789);
    replicatedEntry.set("isTitleEditedByUser", true);
    replicatedEntry.set("activeSessionChain", {
      harnessId: "codex",
      sessionId: "persisted-provider-session",
      sessionWorkspaceSnapshot: {
        workspaceKind: "session-snapshot",
        primaryWorkspace: process.cwd(),
        secondaryWorkspaces: [],
      },
      coveredUntilMessageId: null,
      profileId: null,
    });
    const persistedMessages = new Y.Array<unknown>();
    persistedMessages.push([
      {
        role: "user",
        messageId: "persisted-message",
        sender: { type: "user", userId: "local-user" },
        message: {
          kind: "user",
          content: {
            type: "doc",
            content: [{ type: "paragraph" }],
          },
        },
        timestamp: 400,
        sessionAnchor: null,
      },
    ]);
    replicatedEntry.set("messages", persistedMessages);
    const persistedEvents = new Y.Array<unknown>();
    persistedEvents.push([
      {
        eventId: "persisted-event",
        type: "send.accepted",
        timestamp: 401,
        clientActionId: null,
        actor: { type: "user", userId: "local-user" },
        message: "Previously accepted.",
        turnId: null,
        messageId: "persisted-message",
        queueItemId: null,
        approvalId: null,
        blockId: null,
        severity: "info",
        metadata: null,
      },
    ]);
    replicatedEntry.set("events", persistedEvents);
    epic.chats.delete("settle-agent-a");
    expect(
      state.acceptAgentMessage({
        epicId: "epic-1",
        senderAgentId: "settle-agent-b",
        receiverAgentId: "settle-agent-a",
        prompt: "Settle and deliver through hydrated state",
        responseId,
        expectReply: false,
      }),
    ).toMatchObject({
      response: { responseId: null },
      pendingTurn: { epicId: "epic-1", chatId: "settle-agent-a" },
    });
    expect(chatEntry(state, "settle-agent-a")).toBe(replicatedEntry);
    expect(replicatedEntry.get("messages")).toBe(persistedMessages);
    expect(replicatedEntry.get("events")).toBe(persistedEvents);
    expect(state.getChat("epic-1", "settle-agent-a")).toMatchObject({
      title: "Hydrated agent A",
      parentId: "persisted-parent",
      createdAt: 123,
      archivedAt: null,
      isTitleEditedByUser: true,
      settings,
      providerSessionId: "persisted-provider-session",
      worktreeBinding: {
        entries: [
          expect.objectContaining({
            workspacePath: process.cwd(),
            mode: "local",
          }),
        ],
      },
      messages: [
        expect.objectContaining({ messageId: "persisted-message" }),
        expect.objectContaining({
          sender: expect.objectContaining({
            type: "agent",
            agentId: "settle-agent-b",
            inReplyTo: responseId,
          }),
        }),
      ],
      events: [
        expect.objectContaining({ eventId: "persisted-event" }),
        expect.objectContaining({ type: "send.accepted" }),
      ],
    });
    state.releaseTurn("epic-1", "settle-agent-a");

    expect(
      state.acceptAgentMessage({
        epicId: "epic-1",
        senderAgentId: "settle-agent-a",
        receiverAgentId: "settle-agent-b",
        prompt: "Reuse the settled id as an unknown literal",
        responseId,
        expectReply: false,
      }),
    ).toMatchObject({
      response: { responseId: null },
      pendingTurn: { epicId: "epic-1", chatId: "settle-agent-b" },
    });
    expect(
      state.getChat("epic-1", "settle-agent-b")?.messages.at(-1),
    ).toMatchObject({
      sender: { type: "agent", inReplyTo: responseId },
    });
    state.releaseTurn("epic-1", "settle-agent-b");
    expect(state.hasInflightTurns()).toBe(false);
    state.dispose();
  });

  it("refuses a valid reply while its receiver is stopping without settling or queuing it", async () => {
    const state = stateWithEpic();
    const settings = {
      harnessId: "codex" as const,
      model: "gpt-5.4",
      permissionMode: "full_access" as const,
      reasoningEffort: null,
      serviceTier: null,
      agentMode: "regular" as const,
      profileId: null,
    };
    state.createChat({
      epicId: "epic-1",
      chatId: "cancelling-agent-a",
      parentId: null,
      hostId: "host-local",
      title: "Cancelling agent A",
      settings,
      initialMessage: null,
    });
    state.createChat({
      epicId: "epic-1",
      chatId: "cancelling-agent-b",
      parentId: "cancelling-agent-a",
      hostId: "host-local",
      title: "Replying agent B",
      settings,
      initialMessage: null,
    });
    for (const ownerId of ["cancelling-agent-a", "cancelling-agent-b"]) {
      await state.setWorktreeEntryMode({
        epicId: "epic-1",
        ownerId,
        ownerKind: "chat",
        workspacePath: process.cwd(),
      });
    }

    const opened = state.acceptAgentMessage({
      epicId: "epic-1",
      senderAgentId: "cancelling-agent-a",
      receiverAgentId: "cancelling-agent-b",
      prompt: "Open a response thread",
      responseId: null,
      expectReply: true,
    });
    state.releaseTurn("epic-1", "cancelling-agent-b");
    const responseId = opened.response.responseId;
    if (responseId === null) {
      throw new Error("Missing response id");
    }

    state.activateTurn({
      epicId: "epic-1",
      chatId: "cancelling-agent-a",
      turn: {
        turnId: "turn-cancelling-a",
        status: "running",
        harnessId: "codex",
        model: "gpt-5.4",
        reasoningEffort: null,
        serviceTier: null,
        agentMode: "regular",
        profileId: null,
        userMessageId: "message-cancelling-a",
        startedAt: 1,
        updatedAt: 1,
        sameTurnSteeringSupported: false,
      },
    });
    expect(state.requestStop("epic-1", "cancelling-agent-a")).toBe(true);
    expect(state.getChat("epic-1", "cancelling-agent-a")?.runStatus).toBe(
      "stopping",
    );

    let rejectedReply: unknown = null;
    try {
      state.acceptAgentMessage({
        epicId: "epic-1",
        senderAgentId: "cancelling-agent-b",
        receiverAgentId: "cancelling-agent-a",
        prompt: "This reply must not be delivered",
        responseId,
        expectReply: false,
      });
    } catch (error) {
      rejectedReply = error;
    }
    expect(rejectedReply).toBeInstanceOf(StoreError);
    if (!(rejectedReply instanceof StoreError)) {
      throw new Error("Expected StoreError");
    }
    expect(rejectedReply).toMatchObject({
      code: "RPC_ERROR",
      message: `agent.sendMessage: RECEIVER_CANCELLING - 'cancelling-agent-a' is being stopped; the message was not delivered.`,
    });
    expect(state.getChat("epic-1", "cancelling-agent-a")?.messages).toEqual([]);

    state.finishTurn("epic-1", "cancelling-agent-a");
    expect(
      state.startNextQueuedAgentMessage("epic-1", "cancelling-agent-a"),
    ).toBeNull();
    expect(() =>
      state.acceptAgentMessage({
        epicId: "epic-1",
        senderAgentId: "cancelling-agent-a",
        receiverAgentId: "cancelling-agent-b",
        prompt: "The original thread must still reject the wrong direction",
        responseId,
        expectReply: false,
      }),
    ).toThrowError(
      `agent.sendMessage: RESPONSE_ID_MISMATCH - '${responseId}' belongs to a different (sender, receiver) pair.`,
    );
    expect(state.hasInflightTurns()).toBe(false);
    state.dispose();
  });

  it("guards and purges response threads across an agent.stop operation", async () => {
    const state = stateWithEpic();
    const settings = {
      harnessId: "codex" as const,
      model: "gpt-5.4",
      permissionMode: "full_access" as const,
      reasoningEffort: null,
      serviceTier: null,
      agentMode: "regular" as const,
      profileId: null,
    };
    for (const [chatId, parentId] of [
      ["stop-agent-a", null],
      ["stop-agent-b", "stop-agent-a"],
    ] as const) {
      state.createChat({
        epicId: "epic-1",
        chatId,
        parentId,
        hostId: "host-local",
        title: chatId,
        settings,
        initialMessage: null,
      });
      await state.setWorktreeEntryMode({
        epicId: "epic-1",
        ownerId: chatId,
        ownerKind: "chat",
        workspacePath: process.cwd(),
      });
    }
    const opened = state.acceptAgentMessage({
      epicId: "epic-1",
      senderAgentId: "stop-agent-a",
      receiverAgentId: "stop-agent-b",
      prompt: "Open a thread before stopping",
      responseId: null,
      expectReply: true,
    });
    state.releaseTurn("epic-1", "stop-agent-b");
    const responseId = opened.response.responseId;
    if (responseId === null) {
      throw new Error("Missing response id");
    }
    state.activateTurn({
      epicId: "epic-1",
      chatId: "stop-agent-a",
      turn: {
        turnId: "turn-stop-agent-a",
        status: "running",
        harnessId: "codex",
        model: "gpt-5.4",
        reasoningEffort: null,
        serviceTier: null,
        agentMode: "regular",
        profileId: null,
        userMessageId: "message-stop-agent-a",
        startedAt: 1,
        updatedAt: 1,
        sameTurnSteeringSupported: false,
      },
    });

    const stopping = state.stopAgent({
      epicId: "epic-1",
      agentId: "stop-agent-a",
      cascade: false,
    });
    expect(() =>
      state.acceptAgentMessage({
        epicId: "epic-1",
        senderAgentId: "stop-agent-b",
        receiverAgentId: "stop-agent-a",
        prompt: "Do not revive the stopping agent",
        responseId,
        expectReply: false,
      }),
    ).toThrowError(
      `agent.sendMessage: RECEIVER_CANCELLING - 'stop-agent-a' is being stopped; the message was not delivered.`,
    );
    state.finishTurn("epic-1", "stop-agent-a");
    await expect(stopping).resolves.toEqual({
      stoppedAgentIds: ["stop-agent-a"],
    });

    expect(
      state.acceptAgentMessage({
        epicId: "epic-1",
        senderAgentId: "stop-agent-a",
        receiverAgentId: "stop-agent-b",
        prompt: "The purged id is now only a literal correlation id",
        responseId,
        expectReply: false,
      }),
    ).toMatchObject({
      response: { responseId: null },
      pendingTurn: { chatId: "stop-agent-b" },
    });
    state.releaseTurn("epic-1", "stop-agent-b");
    expect(state.hasInflightTurns()).toBe(false);
    state.dispose();
  });

  it("lets an agent stop only same-user local descendants", async () => {
    const state = stateWithEpic();
    const settings = {
      harnessId: "codex" as const,
      model: "gpt-5.4",
      permissionMode: "full_access" as const,
      reasoningEffort: null,
      serviceTier: null,
      agentMode: "regular" as const,
      profileId: null,
    };
    for (const [chatId, parentId] of [
      ["caller-agent", null],
      ["target-root-agent", null],
      ["target-local-child", "target-root-agent"],
      ["target-other-user", "target-root-agent"],
      ["target-remote-child", "target-root-agent"],
    ] as const) {
      state.createChat({
        epicId: "epic-1",
        chatId,
        parentId,
        hostId: "host-local",
        title: chatId,
        settings,
        initialMessage: null,
      });
    }
    chatEntry(state, "target-other-user").set("userId", "other-user");
    chatEntry(state, "target-remote-child").set("hostId", "remote-host");
    for (const agentId of ["target-root-agent", "target-local-child"]) {
      const signal = state.activateTurn({
        epicId: "epic-1",
        chatId: agentId,
        turn: {
          turnId: `turn-${agentId}`,
          status: "running",
          harnessId: "codex",
          model: "gpt-5.4",
          reasoningEffort: null,
          serviceTier: null,
          agentMode: "regular",
          profileId: null,
          userMessageId: `message-${agentId}`,
          startedAt: 1,
          updatedAt: 1,
          sameTurnSteeringSupported: false,
        },
      });
      signal.addEventListener(
        "abort",
        () => state.finishTurn("epic-1", agentId),
        { once: true },
      );
    }

    await expect(
      state.stopAgentFromAgent({
        epicId: "epic-1",
        senderAgentId: "caller-agent",
        agentId: "target-roo",
        cascade: true,
        archive: false,
      }),
    ).resolves.toEqual({
      stoppedAgentIds: ["target-root-agent", "target-local-child"],
      archivedAgentIds: [],
      notArchivedAgentIds: [],
      skippedAgentIds: ["target-other-user", "target-remote-child"],
      failedAgentIds: [],
    });
    expect(state.getChat("epic-1", "target-root-agent")?.runStatus).toBe(
      "idle",
    );
    expect(state.getChat("epic-1", "target-local-child")?.runStatus).toBe(
      "idle",
    );
    expect(state.hasInflightTurns()).toBe(false);
    state.dispose();
  });

  it("refuses to stop the calling agent without disturbing its turn", async () => {
    const state = stateWithEpic();
    state.createChat({
      epicId: "epic-1",
      chatId: "self-caller-agent",
      parentId: null,
      hostId: "host-local",
      title: "Self caller",
      settings: {
        harnessId: "codex",
        model: "gpt-5.4",
        permissionMode: "full_access",
        reasoningEffort: null,
        serviceTier: null,
        agentMode: "regular",
        profileId: null,
      },
      initialMessage: null,
    });
    const signal = state.activateTurn({
      epicId: "epic-1",
      chatId: "self-caller-agent",
      turn: {
        turnId: "turn-self-caller",
        status: "running",
        harnessId: "codex",
        model: "gpt-5.4",
        reasoningEffort: null,
        serviceTier: null,
        agentMode: "regular",
        profileId: null,
        userMessageId: "message-self-caller",
        startedAt: 1,
        updatedAt: 1,
        sameTurnSteeringSupported: false,
      },
    });

    await expect(
      state.stopAgentFromAgent({
        epicId: "epic-1",
        senderAgentId: "self-caller-agent",
        agentId: "self-caller-agent",
        cascade: true,
        archive: true,
      }),
    ).rejects.toThrowError(
      "traycer_stop_agent: TARGET_IS_SELF - 'self-caller-agent' is the calling agent, and stopping it would abort the very turn awaiting this call. Nothing was stopped. To retire yourself once your work is done, call traycer_archive_agent with your own agent id; to stop a child, address that child directly.",
    );
    expect(signal.aborted).toBe(false);
    expect(state.getChat("epic-1", "self-caller-agent")?.runStatus).toBe(
      "running",
    );

    state.finishTurn("epic-1", "self-caller-agent");
    expect(state.hasInflightTurns()).toBe(false);
    state.dispose();
  });

  it("refuses to archive another busy agent without stopping its turn", () => {
    const state = stateWithEpic();
    const settings = {
      harnessId: "codex" as const,
      model: "gpt-5.4",
      permissionMode: "full_access" as const,
      reasoningEffort: null,
      serviceTier: null,
      agentMode: "regular" as const,
      profileId: null,
    };
    for (const chatId of ["archive-requester", "archive-busy-target"]) {
      state.createChat({
        epicId: "epic-1",
        chatId,
        parentId: null,
        hostId: "host-local",
        title: chatId,
        settings,
        initialMessage: null,
      });
    }
    const signal = state.activateTurn({
      epicId: "epic-1",
      chatId: "archive-busy-target",
      turn: {
        turnId: "turn-archive-busy-target",
        status: "running",
        harnessId: "codex",
        model: "gpt-5.4",
        reasoningEffort: null,
        serviceTier: null,
        agentMode: "regular",
        profileId: null,
        userMessageId: "message-archive-busy-target",
        startedAt: 1,
        updatedAt: 1,
        sameTurnSteeringSupported: false,
      },
    });

    expect(() =>
      state.archiveAgentFromAgent({
        epicId: "epic-1",
        senderAgentId: "archive-requester",
        agentId: "archive-busy-target",
      }),
    ).toThrowError(
      "AGENT_BUSY: traycer_archive_agent refused to archive agent 'archive-busy-target' - nothing was changed. Archiving would force the agent inactive in every list while its run kept going. A turn is in progress, or one is about to start. Stopping the agent clears a turn - but NOT a detached subagent, workflow or scheduled wake, which all survive a stop. Wait for it to go idle - or stop the agent - and retry.",
    );
    expect(signal.aborted).toBe(false);
    expect(
      state.getChat("epic-1", "archive-busy-target")?.archivedAt,
    ).toBeNull();

    state.finishTurn("epic-1", "archive-busy-target");
    expect(state.hasInflightTurns()).toBe(false);
    state.dispose();
  });

  it("archives the allowed subtree after an agent stop request settles", async () => {
    const state = stateWithEpic();
    const settings = {
      harnessId: "codex" as const,
      model: "gpt-5.4",
      permissionMode: "full_access" as const,
      reasoningEffort: null,
      serviceTier: null,
      agentMode: "regular" as const,
      profileId: null,
    };
    for (const [chatId, parentId] of [
      ["archive-caller", null],
      ["archive-target", null],
      ["archive-idle-child", "archive-target"],
    ] as const) {
      state.createChat({
        epicId: "epic-1",
        chatId,
        parentId,
        hostId: "host-local",
        title: chatId,
        settings,
        initialMessage: null,
      });
    }
    const signal = state.activateTurn({
      epicId: "epic-1",
      chatId: "archive-target",
      turn: {
        turnId: "turn-archive-target",
        status: "running",
        harnessId: "codex",
        model: "gpt-5.4",
        reasoningEffort: null,
        serviceTier: null,
        agentMode: "regular",
        profileId: null,
        userMessageId: "message-archive-target",
        startedAt: 1,
        updatedAt: 1,
        sameTurnSteeringSupported: false,
      },
    });
    signal.addEventListener(
      "abort",
      () => state.finishTurn("epic-1", "archive-target"),
      { once: true },
    );

    await expect(
      state.stopAgentFromAgent({
        epicId: "epic-1",
        senderAgentId: "archive-caller",
        agentId: "archive-target",
        cascade: true,
        archive: true,
      }),
    ).resolves.toEqual({
      stoppedAgentIds: ["archive-target"],
      archivedAgentIds: ["archive-target", "archive-idle-child"],
      notArchivedAgentIds: [],
      skippedAgentIds: [],
      failedAgentIds: [],
    });
    expect(state.getChat("epic-1", "archive-target")?.archivedAt).toEqual(
      expect.any(Number),
    );
    expect(state.getChat("epic-1", "archive-idle-child")?.archivedAt).toEqual(
      expect.any(Number),
    );
    state.dispose();
  });
});

describe("HostState chat mutations", () => {
  it("archives and unarchives a chat idempotently", () => {
    const state = stateWithEpic();
    state.createChat({
      epicId: "epic-1",
      chatId: "chat-1",
      parentId: null,
      hostId: "host-local",
      title: "Archive me",
      settings: null,
      initialMessage: null,
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);

    expect(
      state.setChatArchived({
        epicId: "epic-1",
        chatId: "chat-1",
        archived: true,
      }),
    ).toEqual({ updated: true });
    expect(chatJson(state, "chat-1")).toMatchObject({
      archivedAt: 1_000,
      updatedAt: 1_000,
    });
    expect(state.getChat("epic-1", "chat-1")).toMatchObject({
      archivedAt: 1_000,
      updatedAt: 1_000,
    });

    clock.mockReturnValue(2_000);
    expect(
      state.setChatArchived({
        epicId: "epic-1",
        chatId: "chat-1",
        archived: true,
      }),
    ).toEqual({ updated: false });
    expect(state.getChat("epic-1", "chat-1")?.updatedAt).toBe(1_000);

    expect(
      state.setChatArchived({
        epicId: "epic-1",
        chatId: "chat-1",
        archived: false,
      }),
    ).toEqual({ updated: true });
    expect(chatJson(state, "chat-1")).toMatchObject({
      archivedAt: null,
      updatedAt: 2_000,
    });
    expect(state.getChat("epic-1", "chat-1")).toMatchObject({
      archivedAt: null,
      updatedAt: 2_000,
    });

    clock.mockRestore();
    state.dispose();
  });

  it("archives terminal-agent records through the shared archive RPC", () => {
    const state = stateWithEpic();
    seedTuiAgent(state, "tui-local", "host-local", null);
    seedTuiAgent(state, "tui-remote", "host-remote", 500);
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);

    expect(
      state.setChatArchived({
        epicId: "epic-1",
        chatId: "tui-local",
        archived: true,
      }),
    ).toEqual({ updated: true });
    expect(tuiAgentJson(state, "tui-local")).toMatchObject({
      archivedAt: 1_000,
      updatedAt: 1_000,
    });

    clock.mockReturnValue(2_000);
    expect(
      state.setChatArchived({
        epicId: "epic-1",
        chatId: "tui-local",
        archived: true,
      }),
    ).toEqual({ updated: false });
    expect(tuiAgentJson(state, "tui-local").updatedAt).toBe(1_000);

    expect(() =>
      state.setChatArchived({
        epicId: "epic-1",
        chatId: "tui-remote",
        archived: true,
      }),
    ).toThrow(
      "TARGET_NOT_LOCAL: epic.setChatArchived refused to archive agent 'tui-remote' - it runs on host 'host-remote', not on this host ('host-local').",
    );
    expect(
      state.setChatArchived({
        epicId: "epic-1",
        chatId: "tui-remote",
        archived: false,
      }),
    ).toEqual({ updated: true });
    expect(tuiAgentJson(state, "tui-remote")).toMatchObject({
      archivedAt: null,
      updatedAt: 2_000,
    });

    clock.mockRestore();
    state.dispose();
  });

  it("archives doc-only chats before a colliding terminal-agent record", () => {
    const state = stateWithEpic();
    seedDocOnlyChat(state, "shared-record", "host-local", null);
    seedTuiAgent(state, "shared-record", "host-local", null);
    const clock = vi.spyOn(Date, "now").mockReturnValue(3_000);

    expect(
      state.setChatArchived({
        epicId: "epic-1",
        chatId: "shared-record",
        archived: true,
      }),
    ).toEqual({ updated: true });
    expect(chatJson(state, "shared-record")).toMatchObject({
      archivedAt: 3_000,
      updatedAt: 3_000,
    });
    expect(tuiAgentJson(state, "shared-record")).toMatchObject({
      archivedAt: null,
      updatedAt: 100,
    });
    expect(state.getChat("epic-1", "shared-record")).toBeNull();

    clock.mockRestore();
    state.dispose();
  });

  it("permits legacy and malformed-host unarchive records", () => {
    const state = stateWithEpic();
    seedTuiAgent(state, "legacy-agent", "legacy", null);
    seedTuiAgent(state, "hostless-agent", null, 500);
    const clock = vi.spyOn(Date, "now").mockReturnValue(4_000);

    expect(
      state.setChatArchived({
        epicId: "epic-1",
        chatId: "legacy-agent",
        archived: true,
      }),
    ).toEqual({ updated: true });
    expect(
      state.setChatArchived({
        epicId: "epic-1",
        chatId: "hostless-agent",
        archived: false,
      }),
    ).toEqual({ updated: true });
    expect(() =>
      state.setChatArchived({
        epicId: "epic-1",
        chatId: "hostless-agent",
        archived: true,
      }),
    ).toThrow(
      "TARGET_NOT_LOCAL: epic.setChatArchived refused to archive agent 'hostless-agent' - its record carries no usable host id, so which host runs it cannot be determined from here.",
    );

    clock.mockRestore();
    state.dispose();
  });

  it("treats malformed archivedAt values as active records", () => {
    const state = stateWithEpic();
    seedTuiAgent(state, "archive-corrupt", "host-local", "legacy-value");
    seedTuiAgent(state, "unarchive-corrupt", "host-local", "legacy-value");
    const clock = vi.spyOn(Date, "now").mockReturnValue(5_000);

    expect(
      state.setChatArchived({
        epicId: "epic-1",
        chatId: "archive-corrupt",
        archived: true,
      }),
    ).toEqual({ updated: true });
    expect(tuiAgentJson(state, "archive-corrupt")).toMatchObject({
      archivedAt: 5_000,
      updatedAt: 5_000,
    });
    expect(
      state.setChatArchived({
        epicId: "epic-1",
        chatId: "unarchive-corrupt",
        archived: false,
      }),
    ).toEqual({ updated: false });
    expect(tuiAgentJson(state, "unarchive-corrupt")).toMatchObject({
      archivedAt: "legacy-value",
      updatedAt: 100,
    });

    clock.mockRestore();
    state.dispose();
  });

  it("reports missing archive and unarchive targets with the official record error", () => {
    const state = stateWithEpic();

    let thrown: unknown = null;
    try {
      state.setChatArchived({
        epicId: "epic-1",
        chatId: "missing-chat",
        archived: true,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(StoreError);
    if (!(thrown instanceof StoreError)) {
      throw new Error("Expected StoreError");
    }
    expect(thrown).toMatchObject({
      code: "RPC_ERROR",
      message:
        "RECORD_NOT_FOUND: epic.setChatArchived found no chat or terminal-agent 'missing-chat' in epic 'epic-1'.",
    });
    expect(() =>
      state.setChatArchived({
        epicId: "epic-1",
        chatId: "missing-chat",
        archived: false,
      }),
    ).toThrow(
      "RECORD_NOT_FOUND: epic.setChatArchived found no chat or terminal-agent 'missing-chat' in epic 'epic-1'.",
    );
    state.dispose();
  });

  it("blocks archiving a working chat but permits unarchiving it", () => {
    const state = stateWithEpic();
    state.createChat({
      epicId: "epic-1",
      chatId: "working-chat",
      parentId: null,
      hostId: "host-local",
      title: "Working chat",
      settings: null,
      initialMessage: null,
    });
    expect(
      state.setChatArchived({
        epicId: "epic-1",
        chatId: "working-chat",
        archived: true,
      }),
    ).toEqual({ updated: true });
    const signal = state.activateTurn({
      epicId: "epic-1",
      chatId: "working-chat",
      turn: {
        turnId: "turn-1",
        status: "running",
        harnessId: "claude",
        model: "claude-sonnet-4",
        reasoningEffort: null,
        serviceTier: null,
        agentMode: "regular",
        profileId: null,
        userMessageId: "message-1",
        startedAt: 1,
        updatedAt: 1,
        sameTurnSteeringSupported: false,
      },
    });

    expect(
      state.setChatArchived({
        epicId: "epic-1",
        chatId: "working-chat",
        archived: false,
      }),
    ).toEqual({ updated: true });
    expect(() =>
      state.setChatArchived({
        epicId: "epic-1",
        chatId: "working-chat",
        archived: true,
      }),
    ).toThrowError(
      "AGENT_BUSY: epic.setChatArchived refused to archive agent 'working-chat' - nothing was changed.",
    );
    expect(state.getChat("epic-1", "working-chat")?.archivedAt).toBeNull();
    expect(signal.aborted).toBe(false);

    state.finishTurn("epic-1", "working-chat");
    state.dispose();
  });

  it("refuses to archive a chat owned by another host", () => {
    const state = stateWithEpic();
    state.createChat({
      epicId: "epic-1",
      chatId: "remote-chat",
      parentId: null,
      hostId: "host-remote",
      title: "Remote chat",
      settings: null,
      initialMessage: null,
    });

    expect(() =>
      state.setChatArchived({
        epicId: "epic-1",
        chatId: "remote-chat",
        archived: true,
      }),
    ).toThrowError(
      "TARGET_NOT_LOCAL: epic.setChatArchived refused to archive agent 'remote-chat' - it runs on host 'host-remote', not on this host ('host-local').",
    );
    expect(state.getChat("epic-1", "remote-chat")?.archivedAt).toBeNull();
    state.dispose();
  });

  it("automatically unarchives a chat when a new message arrives", () => {
    const state = stateWithEpic();
    state.createChat({
      epicId: "epic-1",
      chatId: "returning-chat",
      parentId: null,
      hostId: "host-local",
      title: "Returning chat",
      settings: null,
      initialMessage: null,
    });
    state.setChatArchived({
      epicId: "epic-1",
      chatId: "returning-chat",
      archived: true,
    });
    const frames: unknown[] = [];
    state.subscribeChat("epic-1", "returning-chat", (frame) => {
      frames.push(frame);
    });

    state.acceptUser({
      epicId: "epic-1",
      chatId: "returning-chat",
      messageId: "message-1",
      content: { type: "doc", content: [] },
      sender: { type: "user", userId: "local-user" },
      settings: {
        harnessId: "claude",
        model: "claude-sonnet-4",
        permissionMode: "supervised",
        reasoningEffort: null,
        serviceTier: null,
        agentMode: "regular",
        profileId: null,
      },
    });

    expect(state.getChat("epic-1", "returning-chat")?.archivedAt).toBeNull();
    expect(chatJson(state, "returning-chat")).toMatchObject({
      archivedAt: null,
    });
    expect(frames).toContainEqual(
      expect.objectContaining({
        kind: "snapshot",
        snapshot: expect.objectContaining({
          chat: expect.objectContaining({
            messages: [expect.objectContaining({ messageId: "message-1" })],
          }),
        }),
      }),
    );
    state.releaseTurn("epic-1", "returning-chat");
    state.dispose();
  });

  it("keeps a chat archived when a concurrent send is rejected", () => {
    const state = stateWithEpic();
    state.createChat({
      epicId: "epic-1",
      chatId: "busy-archived-chat",
      parentId: null,
      hostId: "host-local",
      title: "Busy archived chat",
      settings: null,
      initialMessage: null,
    });
    state.setChatArchived({
      epicId: "epic-1",
      chatId: "busy-archived-chat",
      archived: true,
    });
    state.reserveTurn("epic-1", "busy-archived-chat");

    expect(() =>
      state.acceptUser({
        epicId: "epic-1",
        chatId: "busy-archived-chat",
        messageId: "message-2",
        content: { type: "doc", content: [] },
        sender: { type: "user", userId: "local-user" },
        settings: {
          harnessId: "claude",
          model: "claude-sonnet-4",
          permissionMode: "supervised",
          reasoningEffort: null,
          serviceTier: null,
          agentMode: "regular",
          profileId: null,
        },
      }),
    ).toThrowError("A turn is already in progress");
    expect(state.getChat("epic-1", "busy-archived-chat")?.archivedAt).toEqual(
      expect.any(Number),
    );

    state.releaseTurn("epic-1", "busy-archived-chat");
    state.dispose();
  });

  it("persists the settings carried by a chat send", () => {
    const state = stateWithEpic();
    state.createChat({
      epicId: "epic-1",
      chatId: "settings-chat",
      parentId: null,
      hostId: "host-local",
      title: "Settings chat",
      settings: null,
      initialMessage: null,
    });
    const settings = {
      harnessId: "codex" as const,
      model: "gpt-5.4",
      permissionMode: "full_access" as const,
      reasoningEffort: "high",
      serviceTier: "fast",
      agentMode: "regular" as const,
      profileId: "profile-1",
    };

    state.acceptUser({
      epicId: "epic-1",
      chatId: "settings-chat",
      messageId: "message-1",
      content: { type: "doc", content: [] },
      sender: { type: "user", userId: "local-user" },
      settings,
    });

    expect(state.getChat("epic-1", "settings-chat")?.settings).toEqual(
      settings,
    );
    expect(chatJson(state, "settings-chat")).toMatchObject({ settings });
    state.releaseTurn("epic-1", "settings-chat");
    state.dispose();
  });

  it("persists initial-message settings when createChat omits its tuple", () => {
    const state = stateWithEpic();
    const settings = {
      harnessId: "codex" as const,
      model: "gpt-5.4",
      permissionMode: "full_access" as const,
      reasoningEffort: "high",
      serviceTier: "fast",
      agentMode: "regular" as const,
      profileId: null,
    };

    state.createChat({
      epicId: "epic-1",
      chatId: "initial-settings-chat",
      parentId: null,
      hostId: "host-local",
      title: "Initial settings chat",
      settings: undefined,
      initialMessage: {
        messageId: "initial-message",
        clientActionId: "initial-action",
        content: { type: "doc", content: [] },
        sender: { type: "user", userId: "local-user" },
        settings,
        accountContext: { type: "PERSONAL" },
      },
    });

    expect(state.getChat("epic-1", "initial-settings-chat")?.settings).toEqual(
      settings,
    );
    expect(chatJson(state, "initial-settings-chat")).toMatchObject({
      settings,
    });
    state.releaseTurn("epic-1", "initial-settings-chat");
    state.dispose();
  });

  it("replaces a chat's complete run-settings tuple", () => {
    const state = stateWithEpic();
    state.createChat({
      epicId: "epic-1",
      chatId: "settings-chat",
      parentId: null,
      hostId: "host-local",
      title: "Settings chat",
      settings: null,
      initialMessage: null,
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(2_000);
    const settings = {
      harnessId: "codex" as const,
      model: "gpt-5.4",
      permissionMode: "full_access" as const,
      reasoningEffort: "high",
      serviceTier: "fast",
      agentMode: "regular" as const,
      profileId: "profile-1",
    };

    expect(
      state.updateChatRunSettings({
        epicId: "epic-1",
        chatId: "settings-chat",
        settings,
      }),
    ).toEqual({ updated: true });
    expect(state.getChat("epic-1", "settings-chat")).toMatchObject({
      settings,
      updatedAt: 2_000,
    });
    expect(chatJson(state, "settings-chat")).toMatchObject({
      settings,
      updatedAt: 2_000,
    });

    clock.mockRestore();
    state.dispose();
  });

  it("reads and updates settings for a doc-only chat", () => {
    const state = stateWithEpic();
    seedDocOnlyChat(state, "doc-settings-chat", "host-local", null);
    const settings = {
      harnessId: "codex" as const,
      model: "gpt-5.4",
      permissionMode: "full_access" as const,
      reasoningEffort: "high",
      serviceTier: "fast",
      agentMode: "regular" as const,
      profileId: "ambient",
    };
    const clock = vi.spyOn(Date, "now").mockReturnValue(6_000);

    expect(
      state.updateChatRunSettings({
        epicId: "epic-1",
        chatId: "doc-settings-chat",
        settings,
      }),
    ).toEqual({ updated: true });
    expect(
      state.getChatRunSettings({
        epicId: "epic-1",
        chatId: "doc-settings-chat",
      }),
    ).toEqual({ settings });
    expect(chatJson(state, "doc-settings-chat")).toMatchObject({
      settings,
      updatedAt: 6_000,
    });
    expect(state.getChat("epic-1", "doc-settings-chat")).toBeNull();

    clock.mockReturnValue(7_000);
    expect(
      state.updateChatProfile({
        epicId: "epic-1",
        chatId: "doc-settings-chat",
        profileId: null,
      }),
    ).toEqual({ updated: true });
    expect(
      state.getChatRunSettings({
        epicId: "epic-1",
        chatId: "doc-settings-chat",
      }),
    ).toEqual({ settings: { ...settings, profileId: null } });
    expect(chatJson(state, "doc-settings-chat")).toMatchObject({
      settings: { ...settings, profileId: null },
      updatedAt: 7_000,
    });

    clock.mockRestore();
    state.dispose();
  });

  it("treats malformed doc-only settings as unconfigured", () => {
    const state = stateWithEpic();
    seedDocOnlyChat(state, "malformed-settings-chat", "host-local", null);
    const entry = chatEntry(state, "malformed-settings-chat");
    const malformed = new Y.Map<unknown>();
    malformed.set("harnessId", "codex");
    entry.set("settings", malformed);

    expect(
      state.getChatRunSettings({
        epicId: "epic-1",
        chatId: "malformed-settings-chat",
      }),
    ).toEqual({ settings: null });
    expect(
      state.updateChatProfile({
        epicId: "epic-1",
        chatId: "malformed-settings-chat",
        profileId: null,
      }),
    ).toEqual({ updated: false });
    expect(chatJson(state, "malformed-settings-chat").updatedAt).toBe(100);
    state.dispose();
  });

  it("keeps live settings authoritative over a root-only edit", () => {
    const state = stateWithEpic();
    const settings = {
      harnessId: "codex" as const,
      model: "gpt-5.4",
      permissionMode: "full_access" as const,
      reasoningEffort: "high",
      serviceTier: "fast",
      agentMode: "regular" as const,
      profileId: "profile-1",
    };
    state.createChat({
      epicId: "epic-1",
      chatId: "live-settings-chat",
      parentId: null,
      hostId: "host-local",
      title: "Live settings chat",
      settings,
      initialMessage: null,
    });
    const rootSettings = new Y.Map<unknown>();
    for (const [key, value] of Object.entries({
      ...settings,
      profileId: "ambient",
    })) {
      rootSettings.set(key, value);
    }
    chatEntry(state, "live-settings-chat").set("settings", rootSettings);

    expect(
      state.getChatRunSettings({
        epicId: "epic-1",
        chatId: "live-settings-chat",
      }),
    ).toEqual({ settings });
    expect(
      state.updateChatProfile({
        epicId: "epic-1",
        chatId: "live-settings-chat",
        profileId: "profile-1",
      }),
    ).toEqual({ updated: true });
    expect(chatJson(state, "live-settings-chat")).toMatchObject({
      settings: { ...settings, profileId: "ambient" },
    });
    state.dispose();
  });

  it("patches only the profile and leaves an unconfigured chat unchanged", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const state = stateWithEpic();
    const settings = {
      harnessId: "codex" as const,
      model: "gpt-5.4",
      permissionMode: "full_access" as const,
      reasoningEffort: "high",
      serviceTier: "fast",
      agentMode: "regular" as const,
      profileId: "profile-1",
    };
    state.createChat({
      epicId: "epic-1",
      chatId: "configured-chat",
      parentId: null,
      hostId: "host-local",
      title: "Configured chat",
      settings,
      initialMessage: null,
    });
    state.createChat({
      epicId: "epic-1",
      chatId: "unconfigured-chat",
      parentId: null,
      hostId: "host-local",
      title: "Unconfigured chat",
      settings: null,
      initialMessage: null,
    });

    clock.mockReturnValue(1_500);
    expect(
      state.updateChatProfile({
        epicId: "epic-1",
        chatId: "configured-chat",
        profileId: "profile-1",
      }),
    ).toEqual({ updated: true });
    expect(state.getChat("epic-1", "configured-chat")?.updatedAt).toBe(1_000);
    expect(chatJson(state, "configured-chat").updatedAt).toBe(1_000);

    clock.mockReturnValue(2_000);
    expect(
      state.updateChatProfile({
        epicId: "epic-1",
        chatId: "configured-chat",
        profileId: null,
      }),
    ).toEqual({ updated: true });
    expect(state.getChat("epic-1", "configured-chat")).toMatchObject({
      settings: { ...settings, profileId: null },
      updatedAt: 2_000,
    });
    expect(chatJson(state, "configured-chat")).toMatchObject({
      settings: { ...settings, profileId: null },
      updatedAt: 2_000,
    });
    clock.mockReturnValue(3_000);
    expect(() =>
      state.updateChatProfile({
        epicId: "epic-1",
        chatId: "configured-chat",
        profileId: "missing-profile",
      }),
    ).toThrow(
      'No profile "missing-profile" is registered for provider "codex".',
    );
    expect(state.getChat("epic-1", "configured-chat")).toMatchObject({
      settings: { ...settings, profileId: null },
      updatedAt: 2_000,
    });
    expect(chatJson(state, "configured-chat")).toMatchObject({
      settings: { ...settings, profileId: null },
      updatedAt: 2_000,
    });
    expect(
      state.updateChatProfile({
        epicId: "epic-1",
        chatId: "unconfigured-chat",
        profileId: "profile-2",
      }),
    ).toEqual({ updated: false });

    clock.mockRestore();
    state.dispose();
  });

  it("renames and reparents the persisted chat record", () => {
    const state = stateWithEpic();
    state.createChat({
      epicId: "epic-1",
      chatId: "chat-1",
      parentId: null,
      hostId: "host-local",
      title: "Original chat",
      settings: null,
      initialMessage: null,
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);

    expect(
      state.renameChat({
        epicId: "epic-1",
        chatId: "chat-1",
        title: "Renamed chat",
      }),
    ).toEqual({ updated: true });
    expect(chatJson(state, "chat-1")).toMatchObject({
      title: "Renamed chat",
      isTitleEditedByUser: true,
      updatedAt: 1_000,
    });
    expect(state.getChat("epic-1", "chat-1")).toMatchObject({
      title: "Renamed chat",
      isTitleEditedByUser: true,
      updatedAt: 1_000,
    });

    clock.mockReturnValue(2_000);
    expect(
      state.reparentChat({
        epicId: "epic-1",
        chatId: "chat-1",
        newParentId: "unvalidated-parent",
      }),
    ).toEqual({ updated: true });
    expect(chatJson(state, "chat-1")).toMatchObject({
      parentId: "unvalidated-parent",
      updatedAt: 2_000,
    });
    expect(state.getChat("epic-1", "chat-1")).toMatchObject({
      parentId: "unvalidated-parent",
      updatedAt: 2_000,
    });
    clock.mockRestore();
    state.dispose();
  });

  it("deletes an existing or optimistically removed chat idempotently", async () => {
    const state = stateWithEpic();
    state.createChat({
      epicId: "epic-1",
      chatId: "parent-chat",
      parentId: null,
      hostId: "host-local",
      title: "Parent chat",
      settings: null,
      initialMessage: null,
    });
    state.createChat({
      epicId: "epic-1",
      chatId: "child-chat",
      parentId: "parent-chat",
      hostId: "host-local",
      title: "Child chat",
      settings: null,
      initialMessage: null,
    });
    const epic = state.getEpic("epic-1");
    if (epic === null) {
      throw new Error("Missing test epic");
    }
    const chats = epic.doc.getMap<unknown>("epic").get("chats");
    if (!(chats instanceof Y.Map)) {
      throw new Error("Missing chats map");
    }
    const roleClaims = new Y.Map<unknown>();
    const parentClaim = new Y.Map<unknown>();
    parentClaim.set("agentId", "parent-chat");
    roleClaims.set("parent-claim", parentClaim);
    const childClaim = new Y.Map<unknown>();
    childClaim.set("agentId", "child-chat");
    roleClaims.set("child-claim", childClaim);
    epic.doc.getMap<unknown>("epic").set("roleClaims", roleClaims);
    await state.setWorktreeEntryMode({
      epicId: "epic-1",
      ownerId: "parent-chat",
      ownerKind: "chat",
      workspacePath: "/workspace/parent",
    });
    chats.delete("parent-chat");

    expect(
      await state.deleteChat({ epicId: "epic-1", chatId: "parent-chat" }),
    ).toEqual({ deleted: true });
    expect(state.getChat("epic-1", "parent-chat")).toBeNull();
    expect(chatJson(state, "child-chat")).toMatchObject({
      parentId: "parent-chat",
    });
    expect([...roleClaims.keys()]).toEqual(["child-claim"]);
    expect(
      state.getBinding({
        epicId: "epic-1",
        ownerId: "parent-chat",
        ownerKind: "chat",
      }).binding,
    ).toBeNull();
    expect(
      await state.deleteChat({ epicId: "epic-1", chatId: "parent-chat" }),
    ).toEqual({ deleted: true });

    await state.setWorktreeEntryMode({
      epicId: "epic-1",
      ownerId: "pre-owner",
      ownerKind: "chat",
      workspacePath: "/workspace/pre-owner",
    });
    expect(
      await state.deleteChat({ epicId: "epic-1", chatId: "pre-owner" }),
    ).toEqual({ deleted: true });
    expect(
      state.getBinding({
        epicId: "epic-1",
        ownerId: "pre-owner",
        ownerKind: "chat",
      }).binding,
    ).not.toBeNull();
    state.dispose();
  });

  it("rejects deleting a chat owned by another user", async () => {
    const state = stateWithEpic();
    state.createChat({
      epicId: "epic-1",
      chatId: "peer-chat",
      parentId: null,
      hostId: "host-local",
      title: "Peer chat",
      settings: null,
      initialMessage: null,
    });
    const epic = state.getEpic("epic-1");
    if (epic === null) {
      throw new Error("Missing test epic");
    }
    const chats = epic.doc.getMap<unknown>("epic").get("chats");
    if (!(chats instanceof Y.Map)) {
      throw new Error("Missing chats map");
    }
    const entry = chats.get("peer-chat");
    if (!(entry instanceof Y.Map)) {
      throw new Error("Missing peer chat");
    }
    entry.set("userId", "peer-user");

    const thrown = await state
      .deleteChat({ epicId: "epic-1", chatId: "peer-chat" })
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(StoreError);
    if (!(thrown instanceof StoreError)) {
      throw new Error("Expected StoreError");
    }
    expect(thrown).toMatchObject({ code: "FORBIDDEN", message: "peer-chat" });
    expect(state.getChat("epic-1", "peer-chat")).not.toBeNull();
    expect(chats.has("peer-chat")).toBe(true);
    state.dispose();
  });

  it("does not roll chat activity time back on an unrelated root update", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const state = stateWithEpic();
    state.createChat({
      epicId: "epic-1",
      chatId: "active-time-chat",
      parentId: null,
      hostId: "host-local",
      title: "Activity time",
      settings: null,
      initialMessage: null,
    });
    clock.mockReturnValue(2_000);
    state.acceptUser({
      epicId: "epic-1",
      chatId: "active-time-chat",
      messageId: "user-message",
      content: { type: "doc", content: [] },
      sender: { type: "user", userId: "local-user" },
      settings: {
        harnessId: "claude",
        model: "claude-sonnet-4",
        permissionMode: "supervised",
        reasoningEffort: null,
        serviceTier: null,
        agentMode: "regular",
        profileId: null,
      },
    });
    const epic = state.getEpic("epic-1");
    if (epic === null) {
      throw new Error("Missing test epic");
    }
    epic.doc.getMap("epic").set("unrelated", true);

    expect(state.getChat("epic-1", "active-time-chat")?.updatedAt).toBe(2_000);
    state.releaseTurn("epic-1", "active-time-chat");
    clock.mockRestore();
    state.dispose();
  });

  it("keeps a deleted turn running without allowing an ABA recreation", async () => {
    const state = stateWithEpic();
    state.createChat({
      epicId: "epic-1",
      chatId: "active-chat",
      parentId: null,
      hostId: "host-local",
      title: "Active chat",
      settings: null,
      initialMessage: null,
    });
    const signal = state.activateTurn({
      epicId: "epic-1",
      chatId: "active-chat",
      turn: {
        turnId: "turn-1",
        status: "running",
        harnessId: "claude",
        model: "claude-sonnet-4",
        reasoningEffort: null,
        serviceTier: null,
        agentMode: "regular",
        profileId: null,
        userMessageId: "message-1",
        startedAt: 1,
        updatedAt: 1,
        sameTurnSteeringSupported: false,
      },
    });
    let ghostFrames = 0;
    state.subscribeChat("epic-1", "active-chat", () => {
      ghostFrames += 1;
    });

    expect(
      await state.deleteChat({ epicId: "epic-1", chatId: "active-chat" }),
    ).toEqual({ deleted: true });
    expect(signal.aborted).toBe(false);
    state.emitChat("epic-1", "active-chat", { kind: "ghost" });
    expect(ghostFrames).toBe(1);
    expect(() =>
      state.createChat({
        epicId: "epic-1",
        chatId: "active-chat",
        parentId: null,
        hostId: "host-local",
        title: "Replacement chat",
        settings: null,
        initialMessage: null,
      }),
    ).toThrow("Chat active-chat is still finishing a turn");

    const idle = state.waitForIdle("epic-1", "active-chat");
    state.finishTurn("epic-1", "active-chat");
    await idle;
    expect(
      state.createChat({
        epicId: "epic-1",
        chatId: "active-chat",
        parentId: null,
        hostId: "host-local",
        title: "Replacement chat",
        settings: null,
        initialMessage: null,
      }),
    ).toMatchObject({ chatId: "active-chat" });
    state.dispose();
  });
});

describe("HostState worktree entry mode", () => {
  it("adopts pre-owner bindings and resets one rich entry to Local", async () => {
    const state = stateWithEpic();
    const first = await state.setWorktreeEntryMode({
      epicId: "epic-1",
      ownerId: "chat-prebound",
      ownerKind: "chat",
      workspacePath: "/workspace/one",
    });
    expect(first.binding.entries[0]).toMatchObject({
      workspacePath: "/workspace/one",
      mode: "local",
      isPrimary: true,
    });
    state.createChat({
      epicId: "epic-1",
      chatId: "chat-prebound",
      parentId: null,
      hostId: "host-local",
      title: "Pre-bound chat",
      settings: null,
      initialMessage: null,
    });
    const stored = state.getBinding({
      epicId: "epic-1",
      ownerId: "chat-prebound",
      ownerKind: "chat",
    }).binding;
    if (stored === null || stored.entries[0] === undefined) {
      throw new Error("Missing pre-owner binding");
    }
    stored.workspaceMode = "inherit";
    stored.entries[0] = {
      workspacePath: "/workspace/one",
      mode: "worktree",
      repoIdentifier: { owner: "Traycer", repo: "One" },
      worktreePath: "/worktrees/one",
      branch: "feature/one",
      isPrimary: true,
      isImported: true,
      setupState: "failed",
      setupTerminalSessionId: "terminal-1",
      setupExitCode: 9,
      setupFailedAt: 90,
      createdAt: 10,
      ownedSubmodules: [
        {
          repoIdentifier: { owner: "Traycer", repo: "Submodule" },
          branch: "feature/submodule",
        },
      ],
    };
    stored.entries.push({
      workspacePath: "/workspace/two",
      mode: "local",
      repoIdentifier: null,
      worktreePath: null,
      branch: null,
      isPrimary: false,
      isImported: false,
      setupState: "not_required",
      setupTerminalSessionId: null,
      setupExitCode: null,
      setupFailedAt: null,
      createdAt: 20,
      ownedSubmodules: [],
    });
    const frames: unknown[] = [];
    state.subscribeChat("epic-1", "chat-prebound", (frame) => {
      frames.push(frame);
    });

    const changed = await state.setWorktreeEntryMode({
      epicId: "epic-1",
      ownerId: "chat-prebound",
      ownerKind: "chat",
      workspacePath: "/workspace/one",
    });
    expect(changed.binding).toEqual({
      entries: [
        {
          workspacePath: "/workspace/one",
          mode: "local",
          repoIdentifier: { owner: "Traycer", repo: "One" },
          worktreePath: null,
          branch: null,
          isPrimary: true,
          isImported: false,
          setupState: "not_required",
          setupTerminalSessionId: null,
          setupExitCode: null,
          setupFailedAt: null,
          createdAt: 10,
          ownedSubmodules: [],
        },
        stored.entries[1],
      ],
    });
    expect(state.getChat("epic-1", "chat-prebound")?.worktreeBinding).toEqual(
      changed.binding,
    );
    expect(frames).toEqual([
      {
        kind: "worktreeStateChanged",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-prebound",
        worktreeBinding: changed.binding,
        missingWorktreePaths: ["/workspace/one", "/workspace/two"],
      },
    ]);

    const changedEntry = changed.binding.entries[0];
    if (changedEntry === undefined) {
      throw new Error("Missing changed binding entry");
    }
    changedEntry.ownedSubmodules = [
      {
        repoIdentifier: { owner: "Traycer", repo: "Still-Owned" },
        branch: "legacy",
      },
    ];
    const repeated = await state.setWorktreeEntryMode({
      epicId: "epic-1",
      ownerId: "chat-prebound",
      ownerKind: "chat",
      workspacePath: "/workspace/one",
    });
    expect(repeated.binding.entries[0]?.ownedSubmodules).toHaveLength(1);
    expect(frames).toHaveLength(1);
    state.dispose();
  });

  it("blocks an active chat but permits a pre-owner terminal binding", async () => {
    const state = stateWithEpic();
    state.createChat({
      epicId: "epic-1",
      chatId: "active-chat",
      parentId: null,
      hostId: "host-local",
      title: "Active chat",
      settings: null,
      initialMessage: null,
    });
    state.reserveTurn("epic-1", "active-chat");
    let failure: unknown = null;
    try {
      state.setWorktreeEntryMode({
        epicId: "epic-1",
        ownerId: "active-chat",
        ownerKind: "chat",
        workspacePath: "/workspace/blocked",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "WORKTREE_REBIND_BLOCKED",
      message: "Stop the active chat run before rebinding its worktree.",
    });
    expect(
      state.getBinding({
        epicId: "epic-1",
        ownerId: "active-chat",
        ownerKind: "chat",
      }).binding,
    ).toBeNull();

    state.reserveTurn("epic-1", "terminal-before-create");
    expect(
      (
        await state.setWorktreeEntryMode({
          epicId: "epic-1",
          ownerId: "terminal-before-create",
          ownerKind: "terminal-agent",
          workspacePath: "/workspace/terminal",
        })
      ).binding.entries[0],
    ).toMatchObject({ isPrimary: true, mode: "local" });
    expect(
      state.getBinding({
        epicId: "epic-1",
        ownerId: "terminal-before-create",
        ownerKind: "terminal-agent",
      }),
    ).toMatchObject({
      binding: {
        entries: [{ workspacePath: "/workspace/terminal", mode: "local" }],
      },
      missingWorktreePaths: ["/workspace/terminal"],
    });
    state.releaseTurn("epic-1", "active-chat");
    state.releaseTurn("epic-1", "terminal-before-create");
    state.dispose();
  });
});

describe("HostState worktree binding removal", () => {
  it("removes exact paths, repairs the primary, and publishes folderless state", async () => {
    const testHome = await mkdtemp(join(tmpdir(), "traycer-host-remove-"));
    vi.stubEnv("HOME", testHome);
    const state = stateWithEpic();
    for (const workspacePath of [
      "/workspace/one",
      "/workspace/two",
      "/workspace/three",
    ]) {
      await state.setWorktreeEntryMode({
        epicId: "epic-1",
        ownerId: "remove-chat",
        ownerKind: "chat",
        workspacePath,
      });
    }
    state.createChat({
      epicId: "epic-1",
      chatId: "remove-chat",
      parentId: null,
      hostId: "host-local",
      title: "Remove folders",
      settings: null,
      initialMessage: null,
    });
    const frames: unknown[] = [];
    state.subscribeChat("epic-1", "remove-chat", (frame) => {
      frames.push(frame);
    });

    expect(
      (
        await state.removeWorktreeBindingEntry({
          epicId: "epic-1",
          ownerId: "remove-chat",
          ownerKind: "chat",
          workspacePath: "/workspace/one",
        })
      ).binding,
    ).toMatchObject({
      entries: [
        { workspacePath: "/workspace/two", isPrimary: true },
        { workspacePath: "/workspace/three", isPrimary: false },
      ],
    });
    expect(frames).toHaveLength(1);

    const unchanged = await state.removeWorktreeBindingEntry({
      epicId: "epic-1",
      ownerId: "remove-chat",
      ownerKind: "chat",
      workspacePath: "/workspace/missing",
    });
    expect(unchanged.binding.entries).toHaveLength(2);
    expect(frames).toHaveLength(1);

    await state.removeWorktreeBindingEntry({
      epicId: "epic-1",
      ownerId: "remove-chat",
      ownerKind: "chat",
      workspacePath: "/workspace/two",
    });
    expect(
      (
        await state.removeWorktreeBindingEntry({
          epicId: "epic-1",
          ownerId: "remove-chat",
          ownerKind: "chat",
          workspacePath: "/workspace/three",
        })
      ).binding,
    ).toEqual({ workspaceMode: "folderless", entries: [] });
    expect(state.getChat("epic-1", "remove-chat")?.worktreeBinding).toEqual({
      workspaceMode: "folderless",
      entries: [],
    });
    expect(frames).toHaveLength(3);
    expect(frames.at(-1)).toMatchObject({
      kind: "worktreeStateChanged",
      worktreeBinding: { workspaceMode: "folderless", entries: [] },
      missingWorktreePaths: [],
    });
    const epic = state.getEpic("epic-1");
    if (epic === null) {
      throw new Error("Missing removal test epic");
    }
    epic.workspaces.push({
      task: { taskId: "epic-1", taskType: "epic" },
      hostId: "host-local",
      workspacePath: "/workspace/epic-fallback",
      createdAt: 1,
    });
    const listed = state.listBindingsForEpic("epic-1");
    expect(listed.rows).toEqual([]);
    expect(state.chatCwd("epic-1", "remove-chat")).toBe(listed.folderlessCwd);

    expect(
      await state.removeWorktreeBindingEntry({
        epicId: "unknown-epic",
        ownerId: "unknown-owner",
        ownerKind: "terminal-agent",
        workspacePath: "/workspace/none",
      }),
    ).toEqual({ binding: { entries: [] } });
    state.dispose();
    vi.unstubAllEnvs();
    await rm(testHome, { recursive: true, force: true });
  });

  it("blocks an active chat removal but permits terminal-agent removal", async () => {
    const state = stateWithEpic();
    for (const ownerKind of ["chat", "terminal-agent"] as const) {
      await state.setWorktreeEntryMode({
        epicId: "epic-1",
        ownerId: `${ownerKind}-owner`,
        ownerKind,
        workspacePath: "/workspace/shared",
      });
      state.reserveTurn("epic-1", `${ownerKind}-owner`);
    }

    expect(() =>
      state.removeWorktreeBindingEntry({
        epicId: "epic-1",
        ownerId: "chat-owner",
        ownerKind: "chat",
        workspacePath: "/workspace/shared",
      }),
    ).toThrow("Stop the active chat run before rebinding its worktree.");
    expect(
      await state.removeWorktreeBindingEntry({
        epicId: "epic-1",
        ownerId: "terminal-agent-owner",
        ownerKind: "terminal-agent",
        workspacePath: "/workspace/shared",
      }),
    ).toEqual({ binding: { workspaceMode: "folderless", entries: [] } });

    state.releaseTurn("epic-1", "chat-owner");
    state.releaseTurn("epic-1", "terminal-agent-owner");
    state.dispose();
  });
});

describe("HostState artifact creation", () => {
  it("derives collision-safe sibling folder names and canonical ticket defaults", () => {
    const state = stateWithEpic();
    const first = state.createArtifact({
      epicId: "epic-1",
      parentId: null,
      artifactType: "ticket",
      title: "Résumé / Plan",
    });
    const second = state.createArtifact({
      epicId: "epic-1",
      parentId: null,
      artifactType: "story",
      title: "Résumé / Plan",
    });
    const child = state.createArtifact({
      epicId: "epic-1",
      parentId: first.artifactId,
      artifactType: "spec",
      title: "Résumé / Plan",
    });

    expect(artifactJson(state, first.artifactId)).toMatchObject({
      kind: "ticket",
      folderName: "resume-plan",
      assignee: "",
      status: 0,
      createdManually: true,
    });
    expect(artifactJson(state, second.artifactId)).toMatchObject({
      kind: "story",
      folderName: "resume-plan-2",
      assignee: "",
      status: 0,
    });
    expect(artifactJson(state, child.artifactId)).toMatchObject({
      kind: "spec",
      folderName: "resume-plan",
      parentId: first.artifactId,
    });
    const roomIds = [first, second, child].map(
      (created) => artifactJson(state, created.artifactId).artifactRoomId,
    );
    expect(new Set(roomIds).size).toBe(1);
    state.dispose();
  });

  it("refreshes updatedAt for same-title renames and trusts the status request kind", () => {
    const state = stateWithEpic();
    const created = state.createArtifact({
      epicId: "epic-1",
      parentId: null,
      artifactType: "spec",
      title: "Stable folder",
    });
    const before = artifactJson(state, created.artifactId);
    const renamedAt = Number(before.updatedAt) + 100;
    const clock = vi.spyOn(Date, "now").mockReturnValue(renamedAt);

    expect(
      state.renameArtifact({
        epicId: "epic-1",
        artifactId: created.artifactId,
        title: "Stable folder",
      }),
    ).toEqual({ updated: true });
    expect(artifactJson(state, created.artifactId)).toMatchObject({
      kind: "spec",
      title: "Stable folder",
      folderName: "stable-folder",
      updatedAt: renamedAt,
    });

    const statusUpdatedAt = renamedAt + 100;
    clock.mockReturnValue(statusUpdatedAt);
    expect(
      state.updateArtifactStatus({
        epicId: "epic-1",
        artifactId: created.artifactId,
        artifactType: "ticket",
        status: 2,
      }),
    ).toEqual({ updated: true });
    expect(artifactJson(state, created.artifactId)).toMatchObject({
      kind: "spec",
      title: "Stable folder",
      folderName: "stable-folder",
      status: 2,
      updatedAt: statusUpdatedAt,
    });

    clock.mockRestore();
    state.dispose();
  });

  it("reparents an artifact and refreshes same-parent updates", () => {
    const state = stateWithEpic();
    const firstParent = state.createArtifact({
      epicId: "epic-1",
      parentId: null,
      artifactType: "spec",
      title: "First parent",
    });
    const secondParent = state.createArtifact({
      epicId: "epic-1",
      parentId: null,
      artifactType: "story",
      title: "Second parent",
    });
    const child = state.createArtifact({
      epicId: "epic-1",
      parentId: firstParent.artifactId,
      artifactType: "ticket",
      title: "Moved child",
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);

    expect(
      state.reparentArtifact({
        epicId: "epic-1",
        artifactId: child.artifactId,
        newParentId: secondParent.artifactId,
      }),
    ).toEqual({ updated: true });
    expect(artifactJson(state, child.artifactId)).toMatchObject({
      parentId: secondParent.artifactId,
      folderName: "moved-child",
      updatedAt: 1_000,
    });

    clock.mockReturnValue(2_000);
    expect(
      state.reparentArtifact({
        epicId: "epic-1",
        artifactId: child.artifactId,
        newParentId: secondParent.artifactId,
      }),
    ).toEqual({ updated: true });
    expect(artifactJson(state, child.artifactId).updatedAt).toBe(2_000);
    clock.mockRestore();
    state.dispose();
  });

  it("rejects missing parents and descendant cycles without mutating the artifact", () => {
    const state = stateWithEpic();
    const parent = state.createArtifact({
      epicId: "epic-1",
      parentId: null,
      artifactType: "spec",
      title: "Cycle parent",
    });
    const child = state.createArtifact({
      epicId: "epic-1",
      parentId: parent.artifactId,
      artifactType: "review",
      title: "Cycle child",
    });
    const before = artifactJson(state, parent.artifactId);

    expect(() =>
      state.reparentArtifact({
        epicId: "epic-1",
        artifactId: parent.artifactId,
        newParentId: "missing-parent",
      }),
    ).toThrow(
      "Parent artifact 'missing-parent' does not exist in this epic for spec",
    );
    expect(() =>
      state.reparentArtifact({
        epicId: "epic-1",
        artifactId: parent.artifactId,
        newParentId: child.artifactId,
      }),
    ).toThrow(
      `Circular parent reference detected: moving '${parent.artifactId}' would make it an ancestor of its proposed parent`,
    );
    expect(artifactJson(state, parent.artifactId)).toEqual(before);
    state.dispose();
  });

  it("starts a new room after one room reaches one hundred artifacts", () => {
    const state = stateWithEpic();
    const roomIds: unknown[] = [];
    for (let index = 0; index < 101; index += 1) {
      const created = state.createArtifact({
        epicId: "epic-1",
        parentId: null,
        artifactType: "spec",
        title: `Spec ${index}`,
      });
      roomIds.push(artifactJson(state, created.artifactId).artifactRoomId);
    }

    expect(new Set(roomIds.slice(0, 100)).size).toBe(1);
    expect(roomIds[100]).not.toBe(roomIds[0]);
    expect(state.getEpic("epic-1")?.artifactRooms.listRooms()).toHaveLength(2);
    state.dispose();
  });

  it("projects artifact counts from the live root document", () => {
    const state = stateWithEpic();
    const parent = state.createArtifact({
      epicId: "epic-1",
      parentId: null,
      artifactType: "spec",
      title: "Counted spec",
    });
    state.createArtifact({
      epicId: "epic-1",
      parentId: parent.artifactId,
      artifactType: "ticket",
      title: "Counted ticket",
    });
    state.createArtifact({
      epicId: "epic-1",
      parentId: null,
      artifactType: "story",
      title: "Counted story",
    });
    state.createArtifact({
      epicId: "epic-1",
      parentId: null,
      artifactType: "review",
      title: "Counted review",
    });

    expect(listedEpicLight(state)).toMatchObject({
      specCount: 1,
      ticketCount: 1,
      storyCount: 1,
      reviewCount: 1,
    });

    state.deleteArtifact({
      epicId: "epic-1",
      artifactId: parent.artifactId,
    });
    expect(listedEpicLight(state)).toMatchObject({
      specCount: 0,
      ticketCount: 0,
      storyCount: 1,
      reviewCount: 1,
    });

    const epic = state.getEpic("epic-1");
    if (epic === null) {
      throw new Error("Missing test epic");
    }
    const artifacts = epic.doc.getMap<unknown>("epic").get("artifacts");
    if (!(artifacts instanceof Y.Map)) {
      throw new Error("Missing artifacts map");
    }
    const streamedArtifact = new Y.Map<unknown>();
    streamedArtifact.set("kind", "ticket");
    artifacts.set("streamed-ticket", streamedArtifact);
    expect(listedEpicLight(state).ticketCount).toBe(1);
    artifacts.delete("streamed-ticket");
    expect(listedEpicLight(state).ticketCount).toBe(0);
    epic.doc.transact(() => {
      const root = epic.doc.getMap("epic");
      root.set("title", "Streamed epic title");
      root.set("updatedAt", 9_999);
    });
    expect(listedEpicLight(state)).toMatchObject({
      title: "Streamed epic title",
      updatedAt: 9_999,
    });
    state.dispose();
  });

  it("rejects an unknown parent artifact", () => {
    const state = stateWithEpic();
    let thrown: unknown = null;
    try {
      state.createArtifact({
        epicId: "epic-1",
        parentId: "missing-parent",
        artifactType: "review",
        title: "Review",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StoreError);
    if (!(thrown instanceof StoreError)) {
      throw new Error("Expected StoreError");
    }
    expect(thrown.code).toBe("RPC_ERROR");
    expect(thrown.message).toBe(
      "Parent artifact 'missing-parent' does not exist in this epic for review",
    );
    state.dispose();
  });

  it("deletes descendants from a tombstoned root and clears every room body", () => {
    const state = stateWithEpic();
    const parent = state.createArtifact({
      epicId: "epic-1",
      parentId: null,
      artifactType: "spec",
      title: "Parent",
    });
    const child = state.createArtifact({
      epicId: "epic-1",
      parentId: parent.artifactId,
      artifactType: "ticket",
      title: "Child",
    });
    const grandchild = state.createArtifact({
      epicId: "epic-1",
      parentId: child.artifactId,
      artifactType: "review",
      title: "Grandchild",
    });
    const epic = state.getEpic("epic-1");
    if (epic === null) {
      throw new Error("Missing test epic");
    }
    const artifacts = epic.doc.getMap<unknown>("epic").get("artifacts");
    const deletedArtifacts = epic.doc
      .getMap<unknown>("epic")
      .get("deletedArtifacts");
    if (!(artifacts instanceof Y.Map)) {
      throw new Error("Missing artifacts map");
    }
    expect(deletedArtifacts).toBeInstanceOf(Y.Map);
    if (!(deletedArtifacts instanceof Y.Map)) {
      throw new Error("Missing deleted artifacts map");
    }
    const roomId = artifactJson(state, parent.artifactId).artifactRoomId;
    if (typeof roomId !== "string") {
      throw new Error("Missing artifact room id");
    }
    const room = epic.artifactRooms.getRoom(roomId);
    if (room === null) {
      throw new Error("Missing artifact room");
    }
    for (const artifactId of [
      parent.artifactId,
      child.artifactId,
      grandchild.artifactId,
    ]) {
      const body = room.doc.getXmlFragment(
        artifactBodyFragmentName(artifactId),
      );
      const text = new Y.XmlText();
      text.insert(0, `Body for ${artifactId}`);
      body.insert(0, [text]);
    }

    const parentEntry = artifacts.get(parent.artifactId);
    if (!(parentEntry instanceof Y.Map)) {
      throw new Error("Missing parent artifact");
    }
    epic.doc.transact(() => {
      deletedArtifacts.set(
        parent.artifactId,
        deletedArtifactEntry(parentEntry),
      );
      artifacts.delete(parent.artifactId);
    });

    expect(
      state.deleteArtifact({
        epicId: "epic-1",
        artifactId: parent.artifactId,
      }),
    ).toEqual({ deleted: true });
    expect([...artifacts.keys()]).toEqual([]);
    expect([...deletedArtifacts.keys()].sort()).toEqual(
      [parent.artifactId, child.artifactId, grandchild.artifactId].sort(),
    );
    expect(
      deletedEpicArtifactSchema.parse(
        deletedArtifactJson(deletedArtifacts, child.artifactId),
      ),
    ).toMatchObject({
      id: child.artifactId,
      kind: "ticket",
      title: "Child",
      status: 0,
      artifactRoomId: roomId,
    });
    for (const artifactId of [
      parent.artifactId,
      child.artifactId,
      grandchild.artifactId,
    ]) {
      expect(
        room.doc.getXmlFragment(artifactBodyFragmentName(artifactId)).length,
      ).toBe(0);
    }
    state.dispose();
  });

  it("treats an already-missing artifact as an idempotent delete", () => {
    const state = stateWithEpic();
    expect(
      state.deleteArtifact({
        epicId: "epic-1",
        artifactId: "already-missing",
      }),
    ).toEqual({ deleted: true });
    state.dispose();
  });

  it("rejects a live artifact whose kind is missing", () => {
    const state = stateWithEpic();
    const epic = state.getEpic("epic-1");
    if (epic === null) {
      throw new Error("Missing test epic");
    }
    const artifacts = epic.doc.getMap<unknown>("epic").get("artifacts");
    const deletedArtifacts = epic.doc
      .getMap<unknown>("epic")
      .get("deletedArtifacts");
    if (!(artifacts instanceof Y.Map) || !(deletedArtifacts instanceof Y.Map)) {
      throw new Error("Missing artifact collections");
    }
    artifacts.set("broken-artifact", "corrupt-live-value");
    const staleTombstone = new Y.Map<unknown>();
    staleTombstone.set("kind", "spec");
    staleTombstone.set("id", "broken-artifact");
    staleTombstone.set("title", "Stale tombstone");
    staleTombstone.set("artifactRoomId", null);
    staleTombstone.set("deletedAt", new Date().toISOString());
    deletedArtifacts.set("broken-artifact", staleTombstone);

    expect(() =>
      state.deleteArtifact({
        epicId: "epic-1",
        artifactId: "broken-artifact",
      }),
    ).toThrow("Artifact 'broken-artifact' has no kind in epic doc");
    expect(artifacts.has("broken-artifact")).toBe(true);
    state.dispose();
  });

  it("keeps a committed root deletion successful when body cleanup fails", () => {
    const state = stateWithEpic();
    const created = state.createArtifact({
      epicId: "epic-1",
      parentId: null,
      artifactType: "spec",
      title: "Root mutation wins",
    });
    const epic = state.getEpic("epic-1");
    if (epic === null) {
      throw new Error("Missing test epic");
    }
    const roomId = artifactJson(state, created.artifactId).artifactRoomId;
    if (typeof roomId !== "string") {
      throw new Error("Missing artifact room id");
    }
    const clear = vi
      .spyOn(epic.artifactRooms, "clearBody")
      .mockImplementation(() => {
        throw new Error("room unavailable");
      });

    expect(
      state.deleteArtifact({
        epicId: "epic-1",
        artifactId: created.artifactId,
      }),
    ).toEqual({ deleted: true });
    expect(artifactJsonOrNull(state, created.artifactId)).toBeNull();
    expect(clear).toHaveBeenCalledWith(roomId, created.artifactId);
    clear.mockRestore();
    state.dispose();
  });

  it("validates the whole subtree before committing any tombstones", () => {
    const state = stateWithEpic();
    const parent = state.createArtifact({
      epicId: "epic-1",
      parentId: null,
      artifactType: "spec",
      title: "Parent",
    });
    const child = state.createArtifact({
      epicId: "epic-1",
      parentId: parent.artifactId,
      artifactType: "ticket",
      title: "Corrupt child",
    });
    const grandchild = state.createArtifact({
      epicId: "epic-1",
      parentId: child.artifactId,
      artifactType: "review",
      title: "Valid grandchild",
    });
    const epic = state.getEpic("epic-1");
    if (epic === null) {
      throw new Error("Missing test epic");
    }
    const epicMap = epic.doc.getMap<unknown>("epic");
    const artifacts = epicMap.get("artifacts");
    const deletedArtifacts = epicMap.get("deletedArtifacts");
    if (!(artifacts instanceof Y.Map) || !(deletedArtifacts instanceof Y.Map)) {
      throw new Error("Missing artifact collections");
    }
    const childEntry = artifacts.get(child.artifactId);
    if (!(childEntry instanceof Y.Map)) {
      throw new Error("Missing child artifact");
    }
    childEntry.delete("kind");

    expect(() =>
      state.deleteArtifact({
        epicId: "epic-1",
        artifactId: parent.artifactId,
      }),
    ).toThrow(`Artifact '${child.artifactId}' has no kind in epic doc`);
    expect([...artifacts.keys()].sort()).toEqual(
      [parent.artifactId, child.artifactId, grandchild.artifactId].sort(),
    );
    expect([...deletedArtifacts.keys()]).toEqual([]);
    state.dispose();
  });
});

describe("HostState epic title updates", () => {
  it("ignores empty deltas and applies an explicit title timestamp", () => {
    const state = stateWithEpic();
    expect(state.updateEpicTitle({ epicDelta: null })).toEqual({
      updated: false,
    });
    expect(
      state.updateEpicTitle({
        epicDelta: { id: "epic-1", status: "active", updatedAt: 123 },
      }),
    ).toEqual({ updated: false });

    expect(
      state.updateEpicTitle({
        epicDelta: {
          id: "epic-1",
          title: "Renamed epic",
          status: "ignored-status",
          updatedAt: 456,
        },
      }),
    ).toEqual({ updated: true });
    const epic = state.getEpic("epic-1");
    if (epic === null) {
      throw new Error("Missing test epic");
    }
    expect(epic.doc.getMap("epic").toJSON()).toMatchObject({
      title: "Renamed epic",
      isTitleEditedByUser: true,
      updatedAt: 456,
    });
    expect(listedEpicLight(state)).toMatchObject({
      title: "Renamed epic",
      status: "active",
      updatedAt: 456,
    });
    state.dispose();
  });

  it("sorts task lights by the live root timestamp", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(100);
    const state = stateWithEpic();
    clock.mockReturnValue(200);
    state.createEpic(epicCreationRequest("epic-2", "Second epic"));
    const first = state.getEpic("epic-1");
    if (first === null) {
      throw new Error("Missing first epic");
    }
    first.doc.getMap("epic").set("updatedAt", 300);

    const listedIds = state
      .listTasks()
      .tasks.map((task) => task.epic?.light?.id);
    expect(listedIds).toEqual(["epic-1", "epic-2"]);
    clock.mockRestore();
    state.dispose();
  });
});

function stateWithEpic(): HostState {
  const state = new HostState("host-local", undefined, undefined);
  state.createEpic(epicCreationRequest("epic-1", "Artifact task"));
  return state;
}

function epicCreationRequest(epicId: string, title: string) {
  const now = Date.now();
  return createEpicRequestSchema.parse({
    epic: {
      id: epicId,
      title,
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "active",
      createdAt: now,
      updatedAt: now,
      createdBy: "local-user",
      version: "1.0.0",
    },
    repoIdentifiers: [],
    workspaces: [],
    chat: null,
  });
}

function artifactJson(
  state: HostState,
  artifactId: string,
): Record<string, unknown> {
  const epic = state.getEpic("epic-1");
  if (epic === null) {
    throw new Error("Missing test epic");
  }
  const artifacts = epic.doc.getMap<unknown>("epic").get("artifacts");
  if (!(artifacts instanceof Y.Map)) {
    throw new Error("Missing artifacts map");
  }
  const artifact = artifacts.get(artifactId);
  if (!(artifact instanceof Y.Map)) {
    throw new Error(`Missing artifact ${artifactId}`);
  }
  return artifact.toJSON();
}

function chatJson(state: HostState, chatId: string): Record<string, unknown> {
  return chatEntry(state, chatId).toJSON();
}

function chatEntry(state: HostState, chatId: string): Y.Map<unknown> {
  const epic = state.getEpic("epic-1");
  if (epic === null) {
    throw new Error("Missing test epic");
  }
  const chats = epic.doc.getMap<unknown>("epic").get("chats");
  if (!(chats instanceof Y.Map)) {
    throw new Error("Missing chats map");
  }
  const chat = chats.get(chatId);
  if (!(chat instanceof Y.Map)) {
    throw new Error(`Missing chat ${chatId}`);
  }
  return chat;
}

function seedTuiAgent(
  state: HostState,
  tuiAgentId: string,
  hostId: unknown,
  archivedAt: unknown,
): void {
  const epic = state.getEpic("epic-1");
  if (epic === null) {
    throw new Error("Missing test epic");
  }
  const tuiAgents = epic.doc.getMap<unknown>("epic").get("tuiAgents");
  if (!(tuiAgents instanceof Y.Map)) {
    throw new Error("Missing terminal-agent map");
  }
  const record = new Y.Map<unknown>();
  record.set("id", tuiAgentId);
  record.set("hostId", hostId);
  record.set("archivedAt", archivedAt);
  record.set("updatedAt", 100);
  tuiAgents.set(tuiAgentId, record);
}

function seedDocOnlyChat(
  state: HostState,
  chatId: string,
  hostId: string,
  archivedAt: number | null,
): void {
  const epic = state.getEpic("epic-1");
  if (epic === null) {
    throw new Error("Missing test epic");
  }
  const chats = epic.doc.getMap<unknown>("epic").get("chats");
  if (!(chats instanceof Y.Map)) {
    throw new Error("Missing chats map");
  }
  const record = new Y.Map<unknown>();
  record.set("id", chatId);
  record.set("hostId", hostId);
  record.set("archivedAt", archivedAt);
  record.set("updatedAt", 100);
  chats.set(chatId, record);
}

function seedAgentListChat(
  state: HostState,
  input: {
    readonly id: string;
    readonly hostId: unknown;
    readonly userId: unknown;
    readonly title: string;
    readonly harnessId: string;
  },
): void {
  const epic = state.getEpic("epic-1");
  const chats = epic?.doc.getMap<unknown>("epic").get("chats");
  if (!(chats instanceof Y.Map)) {
    throw new Error("Missing chats map");
  }
  const record = new Y.Map<unknown>();
  record.set("id", input.id);
  record.set("parentId", "caller");
  record.set("hostId", input.hostId);
  record.set("userId", input.userId);
  record.set("title", input.title);
  record.set("createdAt", 100);
  record.set("updatedAt", 100);
  record.set("archivedAt", null);
  record.set("isTitleEditedByUser", true);
  // agent.list reads only the harness discriminator. A partially replicated
  // or legacy settings object must not erase an otherwise valid harness id.
  record.set("settings", { harnessId: input.harnessId });
  chats.set(input.id, record);
}

function seedAgentListTui(
  state: HostState,
  input: {
    readonly id: string;
    readonly hostId: string;
    readonly userId: string;
    readonly harnessId: "claude" | "codex" | "cursor";
    readonly archivedAt: number | null;
    readonly workspaceFolders: readonly string[];
  },
): void {
  const epic = state.getEpic("epic-1");
  const tuiAgents = epic?.doc.getMap<unknown>("epic").get("tuiAgents");
  if (!(tuiAgents instanceof Y.Map)) {
    throw new Error("Missing terminal-agent map");
  }
  const record = new Y.Map<unknown>();
  record.set("id", input.id);
  record.set("parentId", "caller");
  record.set("title", input.id);
  record.set("isTitleEditedByUser", true);
  record.set("createdAt", 100);
  record.set("updatedAt", 100);
  record.set("hostId", input.hostId);
  record.set("userId", input.userId);
  const workspaceFolders = new Y.Array<unknown>();
  workspaceFolders.push([...input.workspaceFolders, 42]);
  record.set("workspaceFolders", workspaceFolders);
  record.set("model", null);
  record.set("reasoningEffort", null);
  record.set("agentMode", "regular");
  record.set("terminalAgentArgs", null);
  record.set("terminalShellCommand", null);
  record.set("terminalShellArgs", null);
  record.set("profileId", null);
  record.set("archivedAt", input.archivedAt);
  record.set("harnessId", input.harnessId);
  record.set(
    "harnessSessionId",
    input.harnessId === "claude" ? `${input.id}-session` : null,
  );
  tuiAgents.set(input.id, record);
}

function tuiAgentJson(
  state: HostState,
  tuiAgentId: string,
): Record<string, unknown> {
  const epic = state.getEpic("epic-1");
  if (epic === null) {
    throw new Error("Missing test epic");
  }
  const tuiAgents = epic.doc.getMap<unknown>("epic").get("tuiAgents");
  if (!(tuiAgents instanceof Y.Map)) {
    throw new Error("Missing terminal-agent map");
  }
  const record = tuiAgents.get(tuiAgentId);
  if (!(record instanceof Y.Map)) {
    throw new Error(`Missing terminal-agent ${tuiAgentId}`);
  }
  return record.toJSON();
}

function listedEpicLight(state: HostState) {
  const task = state.listTasks().tasks[0];
  const light = task?.epic?.light;
  if (light === undefined || light === null) {
    throw new Error("Missing listed epic");
  }
  return light;
}

function artifactJsonOrNull(
  state: HostState,
  artifactId: string,
): Record<string, unknown> | null {
  const epic = state.getEpic("epic-1");
  const artifacts = epic?.doc.getMap<unknown>("epic").get("artifacts");
  if (!(artifacts instanceof Y.Map)) {
    return null;
  }
  const artifact = artifacts.get(artifactId);
  return artifact instanceof Y.Map ? artifact.toJSON() : null;
}

function deletedArtifactEntry(artifact: Y.Map<unknown>): Y.Map<unknown> {
  const tombstone = new Y.Map<unknown>();
  tombstone.set("kind", artifact.get("kind"));
  tombstone.set("id", artifact.get("id"));
  tombstone.set("title", artifact.get("title"));
  tombstone.set("artifactRoomId", artifact.get("artifactRoomId"));
  tombstone.set("deletedAt", new Date().toISOString());
  const status = artifact.get("status");
  if (status !== undefined) {
    tombstone.set("status", status);
  }
  return tombstone;
}

function deletedArtifactJson(
  deletedArtifacts: Y.Map<unknown>,
  artifactId: string,
): Record<string, unknown> {
  const tombstone = deletedArtifacts.get(artifactId);
  if (!(tombstone instanceof Y.Map)) {
    throw new Error(`Missing deleted artifact ${artifactId}`);
  }
  return tombstone.toJSON();
}
