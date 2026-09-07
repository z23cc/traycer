import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  CURRENT_CLIENT_COMPATIBILITY_EPOCH,
  SERVES_EVERY_INSTALLED_MAJOR,
  splitConnectionManifest,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { changeDigest } from "../snapshots/snapshots";
import { startHost, type StartedHost } from "../start-host";

describe("local GUI send without cloud login", () => {
  let started: StartedHost | null = null;
  let tempDir: string | null = null;

  afterEach(async () => {
    if (started !== null) {
      await started.close();
      started = null;
    }
    if (tempDir !== null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("starts a folded landing turn from epic.create with a dummy host token", async () => {
    const setup = await boot();
    tempDir = setup.tempDir;
    started = setup.started;
    const created = await call(
      started.rpcUrl,
      "epic.create",
      { major: 1, minor: 0 },
      {
        epic: {
          id: "epic-1",
          title: "Local send",
          initialUserPrompt: "你好呀你好",
          ticketCount: 0,
          specCount: 0,
          storyCount: 0,
          reviewCount: 0,
          status: "active",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          createdBy: "local",
          version: "2.0.0",
        },
        repoIdentifiers: [],
        workspaces: [{ workspacePath: setup.workspace }],
        chat: {
          chatId: "chat-1",
          parentId: null,
          hostId: started.runtime.hostId,
          title: "",
          worktreeIntent: null,
          initialMessage: {
            messageId: "msg-user-1",
            clientActionId: "action-1",
            content: promptDoc("你好呀你好"),
            sender: {
              type: "user",
              userId: "b6c080e5-7ae0-405b-8195-7b09ff6c55b8",
            },
            settings: {
              harnessId: "claude",
              model: "default",
              permissionMode: "full_access",
              reasoningEffort: null,
              serviceTier: null,
              agentMode: "regular",
              profileId: null,
            },
            accountContext: { type: "PERSONAL" },
          },
        },
      },
    );
    expect(created).toMatchObject({ initialTurnStarted: true });

    const viewed = await call(
      started.rpcUrl,
      "epic.recordViewed",
      {
        major: 1,
        minor: 0,
      },
      { epicId: "epic-1" },
    );
    expect(viewed).toMatchObject({ viewedAt: expect.any(Number) });

    const contexts = await call(
      started.rpcUrl,
      "epic.getTaskContexts",
      {
        major: 1,
        minor: 2,
      },
      { taskIds: ["epic-1", "missing"] },
    );
    expect(contexts).toMatchObject({
      tasks: {
        "epic-1": { status: "found" },
        missing: { status: "confirmed-absent" },
      },
    });

    const records = await call(
      started.rpcUrl,
      "epic.listChatRecords",
      {
        major: 1,
        minor: 0,
      },
      { epicId: "epic-1" },
    );
    expect(records).toMatchObject({
      chats: [
        expect.objectContaining({
          chatId: "chat-1",
          ownerUserId: "b6c080e5-7ae0-405b-8195-7b09ff6c55b8",
          title: "你好呀你好",
          isTitleEditedByUser: true,
        }),
      ],
    });
    const tui = await call(
      started.rpcUrl,
      "epic.listTuiAgents",
      {
        major: 1,
        minor: 0,
      },
      { epicId: "epic-1" },
    );
    expect(tui).toEqual({ tuiAgents: [] });
    const cloud = await call(
      started.rpcUrl,
      "epic.listCloudChats",
      {
        major: 1,
        minor: 0,
      },
      { taskId: "epic-1" },
    );
    expect(cloud).toEqual({ chats: [] });
    const fork = await call(
      started.rpcUrl,
      "host.chatFork.get",
      {
        major: 1,
        minor: 0,
      },
      {},
    );
    expect(fork).toEqual({ event: null });
    const bindings = await call(
      started.rpcUrl,
      "worktree.listBindingsForEpic",
      {
        major: 1,
        minor: 2,
      },
      { epicId: "epic-1" },
    );
    expect(bindings).toMatchObject({
      rows: [expect.objectContaining({ workspacePath: setup.workspace })],
    });
    const publication = await call(
      started.rpcUrl,
      "epic.listChatPublicationTargets",
      { major: 1, minor: 0 },
      { epicId: "epic-1", chatIds: ["chat-1"] },
    );
    expect(publication).toEqual({ redirected: [] });

    const snapshot = await waitForChatText(
      started.rpcUrl.replace(/\/rpc$/u, "/stream"),
      "epic-1",
      "chat-1",
      "assistant-ok",
      40,
      50,
    );
    const blob = JSON.stringify(snapshot);
    expect(blob).toContain("你好呀你好");
    expect(blob).toContain("assistant-ok");
    expect(blob).toContain('"kind":"user"');
  });

  it("accepts a chat.subscribe send without a JWT subject", async () => {
    const setup = await boot();
    tempDir = setup.tempDir;
    started = setup.started;
    await call(
      started.rpcUrl,
      "epic.create",
      { major: 1, minor: 0 },
      {
        epic: {
          id: "epic-2",
          title: "Follow-up",
          initialUserPrompt: "",
          ticketCount: 0,
          specCount: 0,
          storyCount: 0,
          reviewCount: 0,
          status: "active",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          createdBy: "local",
          version: "2.0.0",
        },
        repoIdentifiers: [],
        workspaces: [{ workspacePath: setup.workspace }],
        chat: {
          chatId: "chat-2",
          parentId: null,
          hostId: started.runtime.hostId,
          title: "Root",
          worktreeIntent: null,
          initialMessage: null,
        },
      },
    );
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    const frames = await sendOnChat(streamUrl, {
      epicId: "epic-2",
      chatId: "chat-2",
      clientActionId: "action-2",
      messageId: "msg-user-2",
      text: "second turn",
    });
    expect(frames.some((frame) => jsonHas(frame, "actionAck"))).toBe(true);
    expect(frames.some((frame) => jsonHas(frame, "accepted"))).toBe(true);
    const snapshot = await waitForChatText(
      streamUrl,
      "epic-2",
      "chat-2",
      "assistant-ok",
      40,
      50,
    );
    expect(JSON.stringify(snapshot)).toContain("second turn");
  });

  it("finishes the windowed index with a final skeletonChunk", async () => {
    const setup = await boot();
    tempDir = setup.tempDir;
    started = setup.started;
    await call(
      started.rpcUrl,
      "epic.create",
      { major: 1, minor: 0 },
      {
        epic: {
          id: "epic-3",
          title: "Windowed index",
          initialUserPrompt: "",
          ticketCount: 0,
          specCount: 0,
          storyCount: 0,
          reviewCount: 0,
          status: "active",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          createdBy: "local",
          version: "2.0.0",
        },
        repoIdentifiers: [],
        workspaces: [{ workspacePath: setup.workspace }],
        chat: {
          chatId: "chat-3",
          parentId: null,
          hostId: started.runtime.hostId,
          title: "Root",
          worktreeIntent: null,
          initialMessage: {
            messageId: "msg-user-3",
            clientActionId: "action-3",
            content: promptDoc("skeleton please"),
            sender: {
              type: "user",
              userId: "b6c080e5-7ae0-405b-8195-7b09ff6c55b8",
            },
            settings: {
              harnessId: "claude",
              model: "default",
              permissionMode: "full_access",
              reasoningEffort: null,
              serviceTier: null,
              agentMode: "regular",
              profileId: null,
            },
            accountContext: { type: "PERSONAL" },
          },
        },
      },
    );
    await waitForChatText(
      started.rpcUrl.replace(/\/rpc$/u, "/stream"),
      "epic-3",
      "chat-3",
      "assistant-ok",
      40,
      50,
    );
    const windowed = await subscribeWindowed(
      started.rpcUrl.replace(/\/rpc$/u, "/stream"),
      "epic-3",
      "chat-3",
    );
    const snapshot = windowed.snapshot as {
      snapshot: {
        rowCount: number;
        indexRevision: number | null;
        tail: { rowIds: readonly string[] };
        worktreeBinding: {
          entries: readonly { workspacePath: string }[];
        } | null;
        chat: { title: string; isTitleEditedByUser: boolean };
      };
    };
    const chunk = windowed.skeletonChunk as {
      chunk: {
        fromOrdinal: number;
        isFinal: boolean;
        entries: readonly { rowId: string }[];
      };
    };
    expect(snapshot.snapshot.indexRevision).toBeGreaterThanOrEqual(1);
    expect(chunk.chunk.isFinal).toBe(true);
    expect(chunk.chunk.fromOrdinal).toBe(0);
    expect(chunk.chunk.entries).toHaveLength(snapshot.snapshot.rowCount);
    expect(snapshot.snapshot.rowCount).toBeGreaterThanOrEqual(2);
    expect(snapshot.snapshot.tail.rowIds).toEqual(
      chunk.chunk.entries.map((entry) => entry.rowId),
    );
    expect(snapshot.snapshot.worktreeBinding).toMatchObject({
      entries: [{ workspacePath: setup.workspace }],
    });
    expect(snapshot.snapshot.chat.title).toBe("Root");
    expect(snapshot.snapshot.chat.isTitleEditedByUser).toBe(true);
  });

  it("deletes a suffix and edits a user message", async () => {
    const setup = await boot();
    tempDir = setup.tempDir;
    started = setup.started;
    await call(
      started.rpcUrl,
      "epic.create",
      { major: 1, minor: 0 },
      {
        epic: {
          id: "epic-4",
          title: "Edit",
          initialUserPrompt: "",
          ticketCount: 0,
          specCount: 0,
          storyCount: 0,
          reviewCount: 0,
          status: "active",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          createdBy: "local",
          version: "2.0.0",
        },
        repoIdentifiers: [],
        workspaces: [{ workspacePath: setup.workspace }],
        chat: {
          chatId: "chat-4",
          parentId: null,
          hostId: started.runtime.hostId,
          title: "Root",
          worktreeIntent: null,
          initialMessage: null,
        },
      },
    );
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    await sendOnChat(streamUrl, {
      epicId: "epic-4",
      chatId: "chat-4",
      clientActionId: "action-4a",
      messageId: "msg-user-4a",
      text: "keep this",
    });
    await waitForChatText(
      streamUrl,
      "epic-4",
      "chat-4",
      "assistant-ok",
      40,
      50,
    );
    await sendOnChat(streamUrl, {
      epicId: "epic-4",
      chatId: "chat-4",
      clientActionId: "action-4b",
      messageId: "msg-user-4b",
      text: "drop this",
    });
    await waitForChatText(streamUrl, "epic-4", "chat-4", "drop this", 40, 50);
    await waitForChatText(
      streamUrl,
      "epic-4",
      "chat-4",
      "assistant-ok",
      40,
      50,
    );
    const deleted = await sendChatAction(streamUrl, {
      kind: "deleteMessageSuffix",
      epicId: "epic-4",
      chatId: "chat-4",
      clientActionId: "action-4c",
      fromMessageId: "msg-user-4b",
    });
    expect(jsonHas(deleted, "accepted")).toBe(true);
    const afterDelete = await waitForChatText(
      streamUrl,
      "epic-4",
      "chat-4",
      "keep this",
      40,
      50,
    );
    expect(JSON.stringify(afterDelete)).not.toContain("drop this");
    const edited = await sendChatAction(streamUrl, {
      kind: "editUserMessage",
      epicId: "epic-4",
      chatId: "chat-4",
      clientActionId: "action-4d",
      targetMessageId: "msg-user-4a",
      messageId: "msg-user-4e",
      content: promptDoc("edited prompt"),
      sender: { type: "user", userId: "local" },
      settings: {
        harnessId: "claude",
        model: "default",
        permissionMode: "full_access",
        reasoningEffort: null,
        serviceTier: null,
        agentMode: "regular",
        profileId: null,
      },
      accountContext: { type: "PERSONAL" },
      worktreeIntent: null,
      revertFileChanges: false,
      revertArtifacts: false,
    });
    expect(jsonHas(edited, "accepted")).toBe(true);
    const afterEdit = await waitForChatText(
      streamUrl,
      "epic-4",
      "chat-4",
      "edited prompt",
      40,
      50,
    );
    const blob = JSON.stringify(afterEdit);
    expect(blob).toContain("edited prompt");
    expect(blob).not.toContain("keep this");
  });

  it("queues a follow-up send while a print is running", async () => {
    const setup = await bootWithCli(
      "#!/bin/sh\nsleep 0.4\nprintf 'slow-ok\\n'\n",
    );
    tempDir = setup.tempDir;
    started = setup.started;
    await call(
      started.rpcUrl,
      "epic.create",
      { major: 1, minor: 0 },
      {
        epic: {
          id: "epic-5",
          title: "Queue",
          initialUserPrompt: "",
          ticketCount: 0,
          specCount: 0,
          storyCount: 0,
          reviewCount: 0,
          status: "active",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          createdBy: "local",
          version: "2.0.0",
        },
        repoIdentifiers: [],
        workspaces: [{ workspacePath: setup.workspace }],
        chat: {
          chatId: "chat-5",
          parentId: null,
          hostId: started.runtime.hostId,
          title: "Root",
          worktreeIntent: null,
          initialMessage: null,
        },
      },
    );
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    const frames = await sendTwoOnChat(streamUrl, {
      epicId: "epic-5",
      chatId: "chat-5",
    });
    expect(frames.some((frame) => jsonHas(frame, "queueChanged"))).toBe(true);
    const snapshot = await waitForChatText(
      streamUrl,
      "epic-5",
      "chat-5",
      "slow-ok",
      80,
      50,
    );
    const blob = JSON.stringify(snapshot);
    expect(blob).toContain("first-turn");
    expect(blob).toContain("queued-followup");
    expect(blob).toContain("slow-ok");
  });
  /**
   * A failing tool call, in the record shapes a real `claude -p
   * --output-format stream-json --include-partial-messages` run emits.
   *
   * Two things are locked here, and both were wrong before. The tool RESULT
   * rides a `user` record this parser used to drop entirely, so a call that
   * exited 1 was reported as one that completed - the usage fact is the
   * durable trace of the fix. And the call itself arrives TWICE (the partial
   * `content_block_start` with an empty input, then the complete `assistant`
   * record), which the counter used to charge twice.
   */
  /**
   * The pinned todo dock is painted from the SNAPSHOT, not from the rows, so a
   * `TodoWrite` has to reach the store to survive a reopen. The list also has
   * to be the LATEST one - the client's fold carries a semantic todo forward
   * until a newer one replaces it, and this is the host answering that fold.
   */
  it("pins the latest TodoWrite list onto the snapshot", async () => {
    const stdout = [
      '{"type":"system","subtype":"init","session_id":"sess-todo"}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_t1","name":"TodoWrite","input":{"todos":[{"content":"first pass","status":"in_progress","activeForm":"First pass"}]}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"ok","tool_use_id":"toolu_t1"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_t2","name":"TodoWrite","input":{"todos":[{"content":"first pass","status":"completed","activeForm":"First pass"},{"content":"second pass","status":"in_progress","activeForm":"Second pass"}]}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"ok","tool_use_id":"toolu_t2"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"todo-ok"}]}}',
      '{"type":"result","subtype":"success","usage":{"input_tokens":5,"output_tokens":2}}',
    ];
    const setup = await bootWithCli(
      [
        "#!/bin/sh",
        ...stdout.map((line) => `printf '%s\n' '${line}'`),
        "",
      ].join("\n"),
    );
    tempDir = setup.tempDir;
    started = setup.started;
    await call(
      started.rpcUrl,
      "epic.create",
      { major: 1, minor: 0 },
      {
        epic: {
          id: "epic-7",
          title: "Todos",
          initialUserPrompt: "",
          ticketCount: 0,
          specCount: 0,
          storyCount: 0,
          reviewCount: 0,
          status: "active",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          createdBy: "local",
          version: "2.0.0",
        },
        repoIdentifiers: [],
        workspaces: [{ workspacePath: setup.workspace }],
        chat: {
          chatId: "chat-7",
          parentId: null,
          hostId: started.runtime.hostId,
          title: "Root",
          worktreeIntent: null,
          initialMessage: null,
        },
      },
    );
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    await sendOnChat(streamUrl, {
      epicId: "epic-7",
      chatId: "chat-7",
      clientActionId: "action-7",
      messageId: "msg-user-7",
      text: "plan it",
    });
    const snapshot = await waitForChatText(
      streamUrl,
      "epic-7",
      "chat-7",
      "todo-ok",
      80,
      50,
    );

    const chat = started.runtime.store
      .snapshot()
      .chats.find((row) => row.chatId === "chat-7");
    expect(chat?.pinnedTodo?.id).toBe("toolu_t2");
    expect(chat?.pinnedTodo?.items.map((item) => item.status)).toEqual([
      "completed",
      "in_progress",
    ]);
    // On the wire, where the dock reads it. The text appears nowhere else:
    // a persisted assistant turn carries only its text block.
    expect(JSON.stringify(snapshot)).toContain("second pass");
  });

  /**
   * The count and the summaries are one fact told twice, and the client
   * watchdogs the pair: a snapshot promising N changes with fewer summaries
   * delivered reads as a lost stream, not as a small chat. This host used to
   * publish a running tally of EDITS with no summaries at all.
   */
  it("streams a summary for every file it counts", async () => {
    // Absolute, as every Claude edit input is, and deliberately a path that
    // does not exist: the fake CLI writes nothing, so both calls describe a
    // file that was never there - one accumulated row, created.
    const target = join(tmpdir(), `traycer-edit-${String(Date.now())}.ts`);
    const stdout = [
      '{"type":"system","subtype":"init","session_id":"sess-edit"}',
      `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_w1","name":"Write","input":{"file_path":"${target}","content":"one"}}]}}`,
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"ok","tool_use_id":"toolu_w1"}]}}',
      `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_w2","name":"Edit","input":{"file_path":"${target}","old_string":"one","new_string":"two"}}]}}`,
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"ok","tool_use_id":"toolu_w2"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"edit-ok"}]}}',
      '{"type":"result","subtype":"success","usage":{"input_tokens":5,"output_tokens":2}}',
    ];
    const setup = await bootWithCli(
      [
        "#!/bin/sh",
        ...stdout.map((line) => `printf '%s\n' '${line}'`),
        "",
      ].join("\n"),
    );
    tempDir = setup.tempDir;
    started = setup.started;
    await call(
      started.rpcUrl,
      "epic.create",
      { major: 1, minor: 0 },
      {
        epic: {
          id: "epic-8",
          title: "Edits",
          initialUserPrompt: "",
          ticketCount: 0,
          specCount: 0,
          storyCount: 0,
          reviewCount: 0,
          status: "active",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          createdBy: "local",
          version: "2.0.0",
        },
        repoIdentifiers: [],
        workspaces: [{ workspacePath: setup.workspace }],
        chat: {
          chatId: "chat-8",
          parentId: null,
          hostId: started.runtime.hostId,
          title: "Root",
          worktreeIntent: null,
          initialMessage: null,
        },
      },
    );
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    await sendOnChat(streamUrl, {
      epicId: "epic-8",
      chatId: "chat-8",
      clientActionId: "action-8",
      messageId: "msg-user-8",
      text: "edit it",
    });
    await waitForChatText(streamUrl, "epic-8", "chat-8", "edit-ok", 80, 50);

    // Two edits, ONE file: the panel lists files, and the count is the length
    // of the list it will be measured against.
    const chat = started.runtime.store
      .snapshot()
      .chats.find((row) => row.chatId === "chat-8");
    expect(chat?.accumulatedChanges).toHaveLength(1);
    // Created by the first call and still a creation after the second: the
    // file did not exist when this chat started.
    expect(chat?.accumulatedChanges[0]?.operation).toBe("create");

    const frames = await collectChatFrames(streamUrl, "epic-8", "chat-8");
    const summaries = frames.flatMap((frame) =>
      readSummaries(frame, "epic-8", "chat-8"),
    );
    expect(summaries).toHaveLength(1);
    // The hooks were asked for and reported nothing - the fake CLI runs
    // none - so the row says the capture failed, not that nothing tried.
    expect(summaries[0]).toMatchObject({
      operation: "create",
      diffSource: "none",
      reason: "capture_failed",
      hasContents: false,
      counts: null,
    });
  });

  it("records a failed tool call once, as a failure", async () => {
    const stdout = [
      '{"type":"system","subtype":"init","session_id":"sess-err"}',
      '{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_e1","name":"Bash","input":{}}}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_e1","name":"Bash","input":{"command":"cat /nope"}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"Exit code 1","is_error":true,"tool_use_id":"toolu_e1"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"tool-failed-ok"}]}}',
      '{"type":"result","subtype":"success","usage":{"input_tokens":5,"output_tokens":2}}',
    ];
    const setup = await bootWithCli(
      [
        "#!/bin/sh",
        ...stdout.map((line) => `printf '%s\\n' '${line}'`),
        "",
      ].join("\n"),
    );
    tempDir = setup.tempDir;
    started = setup.started;
    await call(
      started.rpcUrl,
      "epic.create",
      { major: 1, minor: 0 },
      {
        epic: {
          id: "epic-6",
          title: "Tool error",
          initialUserPrompt: "",
          ticketCount: 0,
          specCount: 0,
          storyCount: 0,
          reviewCount: 0,
          status: "active",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          createdBy: "local",
          version: "2.0.0",
        },
        repoIdentifiers: [],
        workspaces: [{ workspacePath: setup.workspace }],
        chat: {
          chatId: "chat-6",
          parentId: null,
          hostId: started.runtime.hostId,
          title: "Root",
          worktreeIntent: null,
          initialMessage: null,
        },
      },
    );
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    await sendOnChat(streamUrl, {
      epicId: "epic-6",
      chatId: "chat-6",
      clientActionId: "action-6",
      messageId: "msg-user-6",
      text: "break something",
    });
    await waitForChatText(
      streamUrl,
      "epic-6",
      "chat-6",
      "tool-failed-ok",
      80,
      50,
    );

    const facts = started.runtime.store.snapshot().usageFacts;
    const fact = facts.find((row) => row.chatId === "chat-6");
    expect(fact?.toolCallCount).toBe(1);
    expect(fact?.toolCallErrorCount).toBe(1);
  });

  /**
   * The whole point of persisting blocks: a chat reopened tomorrow shows what
   * the turn DID, not just what it said. This subscribes fresh - no live
   * deltas - so the only thing that can carry a tool call or an edit here is
   * the stored turn.
   */
  it("keeps a reopened turn's tool call and edit", async () => {
    const target = join(tmpdir(), `traycer-blocks-${String(Date.now())}.ts`);
    const stdout = [
      '{"type":"system","subtype":"init","session_id":"sess-blocks"}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_b1","name":"Bash","input":{"command":"ls"}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"ok","tool_use_id":"toolu_b1"}]}}',
      `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_b2","name":"Write","input":{"file_path":"${target}","content":"x"}}]}}`,
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"ok","tool_use_id":"toolu_b2"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"blocks-ok"}]}}',
      '{"type":"result","subtype":"success","usage":{"input_tokens":5,"output_tokens":2}}',
    ];
    const setup = await bootWithCli(
      [
        "#!/bin/sh",
        ...stdout.map((line) => `printf '%s\n' '${line}'`),
        "",
      ].join("\n"),
    );
    tempDir = setup.tempDir;
    started = setup.started;
    await seedChat(started, setup.workspace, "epic-9", "chat-9");
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    await sendOnChat(streamUrl, {
      epicId: "epic-9",
      chatId: "chat-9",
      clientActionId: "action-9",
      messageId: "msg-user-9",
      text: "do things",
    });
    const frames = await waitForSealedBlocks(
      streamUrl,
      "epic-9",
      "chat-9",
      "file_change",
      80,
      50,
    );
    const blocks = assistantBlocks(frames, "epic-9", "chat-9");
    // Both calls survive, the Write included: hiding the edit call behind its
    // file card is the GUI's job, and it needs both blocks to do it.
    expect(blocks.map((block) => Reflect.get(block, "type")).sort()).toEqual([
      "file_change",
      "text",
      "tool_call",
      "tool_call",
    ]);
    // The raw input is dropped by the reducer on the way in - it is the file
    // body for an edit, and this store is a JSON file - so the persisted call
    // keeps the derived header instead.
    const bash = blocks.find(
      (block) => Reflect.get(block, "toolName") === "Bash",
    );
    expect(bash).toMatchObject({ status: "completed" });
    expect(Reflect.get(bash ?? {}, "input")).toBeUndefined();
    expect(Reflect.get(bash ?? {}, "inputSummary")).toContain("ls");
    // Still paired the way the GUI folds them: the card carries the call's id.
    expect(
      blocks.find((block) => Reflect.get(block, "type") === "file_change"),
    ).toMatchObject({
      blockId: `toolu_b2:${target}`,
      filePath: target,
      operation: "create",
    });
  });

  /**
   * A harness that dies mid-call, with no reply to show for it. The turn ends
   * either way, and the status the reopened chat shows is now permanent - so
   * a call that never returned must not read "completed" forever.
   *
   * No text on purpose: text is what makes this host file a non-zero exit as
   * a normal reply, and a normal reply IS a clean end for everything still
   * open. This one has nothing to file.
   */
  it("reopens a turn that died mid-call as interrupted, not completed", async () => {
    const stdout = [
      '{"type":"system","subtype":"init","session_id":"sess-dead"}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_d1","name":"Bash","input":{"command":"sleep 1"}}]}}',
    ];
    const setup = await bootWithCli(
      [
        "#!/bin/sh",
        ...stdout.map((line) => `printf '%s\n' '${line}'`),
        "exit 3",
        "",
      ].join("\n"),
    );
    tempDir = setup.tempDir;
    started = setup.started;
    await seedChat(started, setup.workspace, "epic-10", "chat-10");
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    await sendOnChat(streamUrl, {
      epicId: "epic-10",
      chatId: "chat-10",
      clientActionId: "action-10",
      messageId: "msg-user-10",
      text: "die halfway",
    });
    const frames = await waitForSealedBlocks(
      streamUrl,
      "epic-10",
      "chat-10",
      "error",
      80,
      50,
    );
    const blocks = assistantBlocks(frames, "epic-10", "chat-10");
    expect(
      blocks.find((block) => Reflect.get(block, "type") === "tool_call"),
    ).toMatchObject({ toolName: "Bash", status: "interrupted" });
    // And the reason it stopped is still there, which is the other half of
    // reopening a failed turn: the error used to be a live-only block.
    expect(
      blocks.find((block) => Reflect.get(block, "type") === "error"),
    ).toMatchObject({ recoverable: false, status: "errored" });
  });

  /**
   * A subagent, reported entirely on the parent's stream. Two things have to
   * be true at once: the card exists, and the child's own work is NOT filed
   * as the main agent's - neither its tool calls nor its closing text.
   */
  it("keeps a subagent's card and none of its work", async () => {
    const stdout = [
      '{"type":"system","subtype":"init","session_id":"sess-task"}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_p1","name":"Task","input":{"description":"List files","subagent_type":"Explore","prompt":"list the files here"}}]}}',
      '{"type":"system","subtype":"task_started","task_id":"task-77","tool_use_id":"toolu_p1","description":"List files","subagent_type":"Explore","prompt":"list the files here"}',
      '{"type":"assistant","parent_tool_use_id":"toolu_p1","message":{"content":[{"type":"tool_use","id":"toolu_c1","name":"Bash","input":{"command":"ls -la"}}]}}',
      '{"type":"user","parent_tool_use_id":"toolu_p1","message":{"content":[{"type":"tool_result","content":"a.txt","tool_use_id":"toolu_c1"}]}}',
      '{"type":"system","subtype":"task_progress","task_id":"task-77","description":"Running ls"}',
      '{"type":"assistant","parent_tool_use_id":"toolu_p1","message":{"content":[{"type":"text","text":"CHILD-TEXT-LEAK"}]}}',
      '{"type":"system","subtype":"task_notification","task_id":"task-77","tool_use_id":"toolu_p1","status":"completed","summary":"one file"}',
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"one file","tool_use_id":"toolu_p1"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"task-ok"}]}}',
      '{"type":"result","subtype":"success","usage":{"input_tokens":5,"output_tokens":2}}',
    ];
    const setup = await bootWithCli(
      [
        "#!/bin/sh",
        ...stdout.map((line) => `printf '%s\n' '${line}'`),
        "",
      ].join("\n"),
    );
    tempDir = setup.tempDir;
    started = setup.started;
    await seedChat(started, setup.workspace, "epic-11", "chat-11");
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    await sendOnChat(streamUrl, {
      epicId: "epic-11",
      chatId: "chat-11",
      clientActionId: "action-11",
      messageId: "msg-user-11",
      text: "delegate it",
    });
    const frames = await waitForSealedBlocks(
      streamUrl,
      "epic-11",
      "chat-11",
      "subagent",
      80,
      50,
    );
    const blocks = assistantBlocks(frames, "epic-11", "chat-11");
    expect(
      blocks.find((block) => Reflect.get(block, "type") === "subagent"),
    ).toMatchObject({
      blockId: "task-77",
      name: "List files",
      agentType: "Explore",
      // Named so the GUI drops the `Task` row this card stands in for.
      spawnToolCallId: "toolu_p1",
      progressUpdates: ["Running ls"],
      result: "one file",
      status: "completed",
    });
    // The child's Bash call is the child's. Only the spawning `Task` call is
    // this turn's.
    expect(
      blocks
        .filter((block) => Reflect.get(block, "type") === "tool_call")
        .map((block) => Reflect.get(block, "toolName")),
    ).toEqual(["Task"]);
    // And the child's closing words are not the assistant's. This is the
    // assertion the block types alone would pass either way.
    const text = blocks.find((block) => Reflect.get(block, "type") === "text");
    expect(Reflect.get(text ?? {}, "text")).toBe("task-ok");
  });

  /**
   * The real diff. The hooks cannot run under a fake CLI, so the test plays
   * them: it writes what the pre and post hooks would have - the blobs and the
   * two sidecars keyed by the call - and the host reads them when the call's
   * result arrives, exactly as it would from the hooks.
   */
  it("serves the before and after the hooks captured around an edit", async () => {
    const target = join(tmpdir(), `traycer-snap-${String(Date.now())}.ts`);
    // The first Edit is refused before its hooks run, as Claude does live for
    // a file it has not read - so no sidecar exists for it on either side.
    const stdout = [
      '{"type":"system","subtype":"init","session_id":"sess-snap"}',
      `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_s0","name":"Edit","input":{"file_path":"${target}","old_string":"one","new_string":"two"}}]}}`,
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"File has not been read yet.","is_error":true,"tool_use_id":"toolu_s0"}]}}',
      `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_s1","name":"Edit","input":{"file_path":"${target}","old_string":"one","new_string":"two"}}]}}`,
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"ok","tool_use_id":"toolu_s1"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"snap-ok"}]}}',
      '{"type":"result","subtype":"success","usage":{"input_tokens":5,"output_tokens":2}}',
    ];
    const setup = await bootWithCli(
      [
        "#!/bin/sh",
        ...stdout.map((line) => `printf '%s\n' '${line}'`),
        "",
      ].join("\n"),
    );
    tempDir = setup.tempDir;
    started = setup.started;
    const before = await playHook(tempDir, "toolu_s1", "pre", "one\nsame\n");
    const after = await playHook(tempDir, "toolu_s1", "post", "two\nsame\n");
    await seedChat(started, setup.workspace, "epic-12", "chat-12");
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    await sendOnChat(streamUrl, {
      epicId: "epic-12",
      chatId: "chat-12",
      clientActionId: "action-12",
      messageId: "msg-user-12",
      text: "edit it",
    });
    const frames = await waitForSealedBlocks(
      streamUrl,
      "epic-12",
      "chat-12",
      "file_change",
      80,
      50,
    );
    const blocks = assistantBlocks(frames, "epic-12", "chat-12");
    // One card, for the edit that happened. The refused call never reached
    // the file, so it gets no card - and its errored row stays visible, which
    // a card with its id would have hidden.
    const cards = blocks.filter(
      (block) => Reflect.get(block, "type") === "file_change",
    );
    expect(cards).toHaveLength(1);
    expect(
      blocks.find((block) => Reflect.get(block, "blockId") === "toolu_s0"),
    ).toMatchObject({ type: "tool_call", status: "errored" });
    expect(cards[0]).toMatchObject({
      status: "completed",
      // Existence on both sides is what the captures know that the call's
      // input did not.
      operation: "edit",
      diffSource: "snapshot",
      beforeHash: before,
      afterHash: after,
      additions: 1,
      deletions: 1,
      reason: "snapshot",
    });
    const summaries = frames.flatMap((frame) =>
      readSummaries(frame, "epic-12", "chat-12"),
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      diffSource: "snapshot",
      reason: "snapshot",
      hasContents: true,
      undoable: true,
      digest: changeDigest(before, after),
      counts: { additions: 1, deletions: 1 },
    });

    // The two reads the panel and the card make, and the refusal for a
    // version this host no longer describes.
    expect(
      await call(
        started.rpcUrl,
        "chat.readAccumulatedFileChange",
        {
          major: 1,
          minor: 0,
        },
        {
          epicId: "epic-12",
          chatId: "chat-12",
          filePath: target,
          digest: changeDigest(before, after),
        },
      ),
    ).toEqual({
      stale: false,
      beforeContent: "one\nsame\n",
      afterContent: "two\nsame\n",
    });
    expect(
      await call(
        started.rpcUrl,
        "chat.readAccumulatedFileChange",
        {
          major: 1,
          minor: 0,
        },
        {
          epicId: "epic-12",
          chatId: "chat-12",
          filePath: target,
          digest: "-:-",
        },
      ),
    ).toEqual({ stale: true });
    expect(
      await call(
        started.rpcUrl,
        "snapshots.readSnapshotDiff",
        {
          major: 1,
          minor: 0,
        },
        { beforeHash: before, afterHash: after },
      ),
    ).toEqual({
      beforeContent: "one\nsame\n",
      afterContent: "two\nsame\n",
      reason: "snapshot",
    });
    expect(
      await call(
        started.rpcUrl,
        "snapshots.readSnapshotDiff",
        {
          major: 1,
          minor: 0,
        },
        { beforeHash: before, afterHash: "0".repeat(64) },
      ),
    ).toMatchObject({ reason: "blob_missing" });
    expect(
      await call(
        started.rpcUrl,
        "snapshots.getLocalStorageSize",
        {
          major: 1,
          minor: 0,
        },
        {},
      ),
    ).toEqual({ bytes: "one\nsame\n".length + "two\nsame\n".length });

    // The panel's Undo. The file was never on disk here - the hooks were
    // played by hand - so the revert is what puts the first before there.
    const reverted = await sendActionUntil(
      streamUrl,
      {
        kind: "revertFileChanges",
        epicId: "epic-12",
        chatId: "chat-12",
        clientActionId: "revert-12",
        fromMessageId: null,
        filePaths: null,
        revertArtifacts: true,
      },
      "restoreCompleted",
    );
    expect(
      reverted.find((f) => Reflect.get(f ?? {}, "kind") === "actionAck"),
    ).toMatchObject({ action: "revertFileChanges", status: "accepted" });
    expect(
      reverted.find((f) => Reflect.get(f ?? {}, "kind") === "restoreCompleted"),
    ).toMatchObject({
      results: [{ filePath: target, status: "restored", operation: "edit" }],
    });
    expect(await readFile(target, "utf8")).toBe("one\nsame\n");
    await rm(target, { force: true });
    // Back at its first before, the file has not changed since the chat
    // started - and the panel lists files that have.
    const afterRevert = await collectChatFrames(
      streamUrl,
      "epic-12",
      "chat-12",
    );
    expect(
      afterRevert.flatMap((frame) =>
        readSummaries(frame, "epic-12", "chat-12"),
      ),
    ).toEqual([]);
    expect(
      await sendActionUntil(
        streamUrl,
        {
          kind: "revertFileChanges",
          epicId: "epic-12",
          chatId: "chat-12",
          clientActionId: "revert-12b",
          fromMessageId: null,
          filePaths: null,
          revertArtifacts: true,
        },
        "actionAck",
      ),
    ).toContainEqual(
      expect.objectContaining({
        status: "rejected",
        code: "NOTHING_TO_REVERT",
      }),
    );
  });
});

/**
 * What one hook invocation leaves behind, written by hand: the body in the
 * blob store and the sidecar the host settles the call from.
 */
async function playHook(
  dataDir: string,
  toolUseId: string,
  side: "pre" | "post",
  body: string,
): Promise<string> {
  const hash = createHash("sha256").update(body).digest("hex");
  const dir = join(dataDir, "snapshots");
  await mkdir(join(dir, "blobs"), { recursive: true });
  await mkdir(join(dir, "pending"), { recursive: true });
  await writeFile(join(dir, "blobs", hash), body);
  await writeFile(
    join(dir, "pending", `${toolUseId}.${side}.json`),
    JSON.stringify({ hash, reason: "snapshot" }),
  );
  return hash;
}

/** The blocks of the last assistant message in a fresh subscribe's snapshot. */
function assistantBlocks(
  frames: readonly unknown[],
  epicId: string,
  chatId: string,
): readonly object[] {
  for (const frame of frames) {
    if (
      frame === null ||
      typeof frame !== "object" ||
      Reflect.get(frame, "kind") !== "snapshot" ||
      Reflect.get(frame, "epicId") !== epicId ||
      Reflect.get(frame, "chatId") !== chatId
    ) {
      continue;
    }
    const messages = Reflect.get(
      Reflect.get(Reflect.get(frame, "snapshot") ?? {}, "tail") ?? {},
      "messages",
    );
    if (!Array.isArray(messages)) {
      continue;
    }
    const assistant = messages.filter(
      (message: unknown) =>
        typeof message === "object" &&
        message !== null &&
        Reflect.get(message, "role") === "assistant",
    );
    const last: unknown = assistant[assistant.length - 1];
    const blocks = Reflect.get(last ?? {}, "blocks");
    return Array.isArray(blocks)
      ? blocks.filter(
          (block: unknown): block is object =>
            typeof block === "object" && block !== null,
        )
      : [];
  }
  return [];
}

/** One epic with one root chat, the shape every send test starts from. */
async function seedChat(
  started: StartedHost,
  workspace: string,
  epicId: string,
  chatId: string,
): Promise<void> {
  await call(
    started.rpcUrl,
    "epic.create",
    { major: 1, minor: 0 },
    {
      epic: {
        id: epicId,
        title: "Blocks",
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: "local",
        version: "2.0.0",
      },
      repoIdentifiers: [],
      workspaces: [{ workspacePath: workspace }],
      chat: {
        chatId,
        parentId: null,
        hostId: started.runtime.hostId,
        title: "Root",
        worktreeIntent: null,
        initialMessage: null,
      },
    },
  );
}

/**
 * Every frame a fresh subscribe produces, collected for a moment rather than
 * until an expected one: the accumulated-change chunk rides AFTER the snapshot
 * and skeleton, so a helper that settles on those two never sees it.
 */
async function collectChatFrames(
  url: string,
  epicId: string,
  chatId: string,
): Promise<readonly unknown[]> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const frames: unknown[] = [];
  const done = new Promise<void>((resolve) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }
      const parsed: unknown = JSON.parse(String(data));
      frames.push(parsed);
      if (frames.length === 1) {
        socket.send(
          JSON.stringify({
            kind: "subscribe",
            method: "chat.subscribe",
            schemaVersion: { major: 1, minor: 8 },
            params: { epicId, chatId },
          }),
        );
        setTimeout(() => socket.close(), 400);
      }
    });
    socket.once("close", () => resolve());
    socket.once("error", () => resolve());
  });
  socket.send(
    JSON.stringify({
      kind: "open",
      token: "local-dev-token",
      manifest: {},
      clientIdentity: {
        kind: "cli",
        compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
        appVersion: "0.1.0",
      },
    }),
  );
  await done;
  return frames;
}

/** The summaries an `accumulatedChanges` frame carries for this chat. */
function readSummaries(
  frame: unknown,
  epicId: string,
  chatId: string,
): readonly unknown[] {
  if (frame === null || typeof frame !== "object") {
    return [];
  }
  if (
    Reflect.get(frame, "kind") !== "accumulatedChanges" ||
    Reflect.get(frame, "epicId") !== epicId ||
    Reflect.get(frame, "chatId") !== chatId
  ) {
    return [];
  }
  const chunk = Reflect.get(frame, "chunk");
  if (chunk === null || typeof chunk !== "object") {
    return [];
  }
  const summaries = Reflect.get(chunk, "summaries");
  return Array.isArray(summaries) ? summaries : [];
}

type Booted = {
  readonly tempDir: string;
  readonly started: StartedHost;
  readonly workspace: string;
};

async function boot(): Promise<Booted> {
  return bootWithCli("#!/bin/sh\nprintf 'assistant-ok\\n'\n");
}

async function bootWithCli(script: string): Promise<Booted> {
  const tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
  const binDir = join(tempDir, "bin");
  await mkdir(binDir);
  const claudePath = join(binDir, "claude");
  await writeFile(claudePath, script);
  await chmod(claudePath, 0o755);
  const workspace = join(tempDir, "proj");
  await mkdir(workspace);
  await writeFile(join(workspace, "README.md"), "hello\n");
  const started = await startHost({
    argv: ["--host-data-dir", tempDir],
    listenHost: "127.0.0.1",
    listenPort: 0,
  });
  await call(
    started.rpcUrl,
    "providers.addCustomPath",
    { major: 2, minor: 1 },
    {
      providerId: "claude-code",
      path: await realpath(claudePath),
    },
  );
  return { tempDir, started, workspace: await realpath(workspace) };
}

function promptDoc(text: string): unknown {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

async function call(
  url: string,
  method: string,
  schemaVersion: { major: number; minor: number },
  params: unknown,
): Promise<unknown> {
  const frame = await rpcExchange(url, method, schemaVersion, params);
  if (frame.error !== null) {
    throw new Error(`RPC error: ${JSON.stringify(frame.error)}`);
  }
  return frame.result;
}

async function rpcExchange(
  url: string,
  method: string,
  schemaVersion: { major: number; minor: number },
  params: unknown,
): Promise<{ result: unknown; error: unknown }> {
  const clientManifests = splitConnectionManifest(
    hostRpcRegistry,
    RELEASED_FLOOR_METHOD_NAMES,
    SERVES_EVERY_INSTALLED_MAJOR,
  );
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const frames: unknown[] = [];
  const done = new Promise<void>((resolve, reject) => {
    socket.on("message", (data) => {
      frames.push(JSON.parse(String(data)));
      if (frames.length === 1) {
        socket.send(
          JSON.stringify({
            kind: "request",
            requestId: "1",
            method,
            schemaVersion,
            params,
          }),
        );
      }
    });
    socket.once("close", () => resolve());
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      kind: "open",
      token: "local-dev-token",
      manifest: clientManifests.manifest,
      optionalManifest: clientManifests.optionalManifest,
      clientIdentity: {
        kind: "cli",
        compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
        appVersion: "0.1.0",
      },
    }),
  );
  await done;
  const response = frames[1];
  if (
    response === null ||
    typeof response !== "object" ||
    !("kind" in response) ||
    response.kind !== "response"
  ) {
    throw new Error(`expected response, got ${JSON.stringify(response)}`);
  }
  const record = response as Record<string, unknown>;
  return { result: record.result, error: record.error };
}

/**
 * A fresh subscribe's frames once the LAST assistant turn carries a block of
 * this type - which is to say once it has been sealed. Waiting on the reply
 * text is not enough: the text lands with `persistAssistantTurn`, the blocks
 * with the seal a moment later, and a collect in between sees a turn that is
 * one text block long.
 */
async function waitForSealedBlocks(
  url: string,
  epicId: string,
  chatId: string,
  blockType: string,
  attempts: number,
  delayMs: number,
): Promise<readonly unknown[]> {
  let frames: readonly unknown[] = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    frames = await collectChatFrames(url, epicId, chatId);
    if (
      assistantBlocks(frames, epicId, chatId).some(
        (block) => Reflect.get(block, "type") === blockType,
      )
    ) {
      return frames;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }
  throw new Error(`no ${blockType} block sealed onto ${chatId}`);
}

async function waitForChatText(
  url: string,
  epicId: string,
  chatId: string,
  needle: string,
  attempts: number,
  delayMs: number,
): Promise<unknown> {
  let last: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await subscribeChat(url, epicId, chatId);
    if (JSON.stringify(last).includes(needle)) {
      return last;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }
  throw new Error(`did not observe ${needle} in ${JSON.stringify(last)}`);
}

async function subscribeWindowed(
  url: string,
  epicId: string,
  chatId: string,
): Promise<{ snapshot: unknown; skeletonChunk: unknown }> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const frames: unknown[] = [];
  let snapshot: unknown = null;
  let skeletonChunk: unknown = null;
  const done = new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error === null) {
        resolve();
        return;
      }
      reject(error);
    };
    const timer = setTimeout(() => {
      finish(
        new Error(
          `timed out waiting for windowed frames: ${JSON.stringify(frames)}`,
        ),
      );
    }, 5_000);
    socket.on("message", (data) => {
      const parsed: unknown = JSON.parse(String(data));
      frames.push(parsed);
      if (frames.length === 1) {
        socket.send(
          JSON.stringify({
            kind: "subscribe",
            method: "chat.subscribe",
            schemaVersion: { major: 1, minor: 8 },
            params: { epicId, chatId },
          }),
        );
        return;
      }
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "kind" in parsed &&
        parsed.kind === "snapshot"
      ) {
        snapshot = parsed;
      }
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "kind" in parsed &&
        parsed.kind === "skeletonChunk"
      ) {
        skeletonChunk = parsed;
      }
      if (snapshot !== null && skeletonChunk !== null) {
        finish(null);
      }
    });
    socket.once("error", (error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
  socket.send(
    JSON.stringify({
      kind: "open",
      token: "local-dev-token",
      manifest: {},
      clientIdentity: {
        kind: "cli",
        compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
        appVersion: "0.1.0",
      },
    }),
  );
  await done;
  if (snapshot === null || skeletonChunk === null) {
    throw new Error(`incomplete windowed subscribe: ${JSON.stringify(frames)}`);
  }
  return { snapshot, skeletonChunk };
}

async function subscribeChat(
  url: string,
  epicId: string,
  chatId: string,
): Promise<unknown> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const frames: unknown[] = [];
  const done = new Promise<void>((resolve, reject) => {
    socket.on("message", (data) => {
      const parsed: unknown = JSON.parse(String(data));
      frames.push(parsed);
      if (frames.length === 1) {
        socket.send(
          JSON.stringify({
            kind: "subscribe",
            method: "chat.subscribe",
            schemaVersion: { major: 1, minor: 7 },
            params: { epicId, chatId },
          }),
        );
        return;
      }
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "kind" in parsed &&
        parsed.kind === "snapshot"
      ) {
        socket.close();
      }
    });
    socket.once("close", () => resolve());
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      kind: "open",
      token: "local-dev-token",
      manifest: {},
      clientIdentity: {
        kind: "cli",
        compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
        appVersion: "0.1.0",
      },
    }),
  );
  await done;
  const snapshot = frames.find(
    (frame) =>
      frame !== null &&
      typeof frame === "object" &&
      "kind" in frame &&
      frame.kind === "snapshot",
  );
  if (snapshot === undefined) {
    throw new Error(`no snapshot in ${JSON.stringify(frames)}`);
  }
  return snapshot;
}

async function sendOnChat(
  url: string,
  input: {
    readonly epicId: string;
    readonly chatId: string;
    readonly clientActionId: string;
    readonly messageId: string;
    readonly text: string;
  },
): Promise<unknown[]> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const frames: unknown[] = [];
  const done = new Promise<void>((resolve, reject) => {
    socket.on("message", (data) => {
      const parsed: unknown = JSON.parse(String(data));
      frames.push(parsed);
      if (frames.length === 1) {
        socket.send(
          JSON.stringify({
            kind: "subscribe",
            method: "chat.subscribe",
            schemaVersion: { major: 1, minor: 7 },
            params: { epicId: input.epicId, chatId: input.chatId },
          }),
        );
        return;
      }
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "kind" in parsed &&
        parsed.kind === "snapshot" &&
        frames.length === 2
      ) {
        socket.send(
          JSON.stringify({
            kind: "send",
            hasBinaryPayload: false,
            epicId: input.epicId,
            chatId: input.chatId,
            clientActionId: input.clientActionId,
            messageId: input.messageId,
            content: promptDoc(input.text),
            sender: { type: "user", userId: "local" },
            settings: {
              harnessId: "claude",
              model: "default",
              permissionMode: "full_access",
              reasoningEffort: null,
              serviceTier: null,
              agentMode: "regular",
              profileId: null,
            },
            accountContext: { type: "PERSONAL" },
            deliveryPolicy: "auto",
            worktreeIntent: null,
          }),
        );
        return;
      }
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "kind" in parsed &&
        parsed.kind === "actionAck"
      ) {
        socket.close();
      }
    });
    socket.once("close", () => resolve());
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      kind: "open",
      token: "local-dev-token",
      manifest: {},
      clientIdentity: {
        kind: "cli",
        compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
        appVersion: "0.1.0",
      },
    }),
  );
  await done;
  return frames;
}

/**
 * Send one action and keep listening until a frame of `untilKind` arrives -
 * for actions whose answer is not the ack but what follows it.
 */
async function sendActionUntil(
  url: string,
  frame: Record<string, unknown>,
  untilKind: string,
): Promise<unknown[]> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const frames: unknown[] = [];
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => socket.close(), 4000);
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }
      const parsed: unknown = JSON.parse(String(data));
      frames.push(parsed);
      const kind = Reflect.get(parsed ?? {}, "kind");
      if (frames.length === 1) {
        socket.send(
          JSON.stringify({
            kind: "subscribe",
            method: "chat.subscribe",
            schemaVersion: { major: 1, minor: 8 },
            params: { epicId: frame.epicId, chatId: frame.chatId },
          }),
        );
        return;
      }
      if (kind === "snapshot" && frames.length === 2) {
        socket.send(JSON.stringify({ hasBinaryPayload: false, ...frame }));
        return;
      }
      // A rejected ack is the whole answer: nothing follows it.
      if (
        kind === untilKind ||
        (kind === "actionAck" &&
          Reflect.get(parsed ?? {}, "status") === "rejected")
      ) {
        clearTimeout(timer);
        socket.close();
      }
    });
    socket.once("close", () => resolve());
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      kind: "open",
      token: "local-dev-token",
      manifest: {},
      clientIdentity: {
        kind: "cli",
        compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
        appVersion: "0.1.0",
      },
    }),
  );
  await done;
  return frames;
}

async function sendChatAction(
  url: string,
  frame: Record<string, unknown>,
): Promise<unknown[]> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const frames: unknown[] = [];
  const done = new Promise<void>((resolve, reject) => {
    socket.on("message", (data) => {
      const parsed: unknown = JSON.parse(String(data));
      frames.push(parsed);
      if (frames.length === 1) {
        socket.send(
          JSON.stringify({
            kind: "subscribe",
            method: "chat.subscribe",
            schemaVersion: { major: 1, minor: 7 },
            params: { epicId: frame.epicId, chatId: frame.chatId },
          }),
        );
        return;
      }
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "kind" in parsed &&
        parsed.kind === "snapshot" &&
        frames.length === 2
      ) {
        socket.send(JSON.stringify({ hasBinaryPayload: false, ...frame }));
        return;
      }
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "kind" in parsed &&
        parsed.kind === "actionAck"
      ) {
        socket.close();
      }
    });
    socket.once("close", () => resolve());
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      kind: "open",
      token: "local-dev-token",
      manifest: {},
      clientIdentity: {
        kind: "cli",
        compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
        appVersion: "0.1.0",
      },
    }),
  );
  await done;
  return frames;
}

async function sendTwoOnChat(
  url: string,
  input: { readonly epicId: string; readonly chatId: string },
): Promise<unknown[]> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const frames: unknown[] = [];
  let sent = 0;
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
    }, 2_000);
    socket.on("message", (data) => {
      const parsed: unknown = JSON.parse(String(data));
      frames.push(parsed);
      if (frames.length === 1) {
        socket.send(
          JSON.stringify({
            kind: "subscribe",
            method: "chat.subscribe",
            schemaVersion: { major: 1, minor: 7 },
            params: { epicId: input.epicId, chatId: input.chatId },
          }),
        );
        return;
      }
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "kind" in parsed &&
        parsed.kind === "snapshot" &&
        sent === 0
      ) {
        sent = 1;
        socket.send(JSON.stringify(sendFrame(input, "msg-a", "first-turn")));
        return;
      }
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "kind" in parsed &&
        parsed.kind === "actionAck" &&
        sent === 1
      ) {
        sent = 2;
        socket.send(
          JSON.stringify(sendFrame(input, "msg-b", "queued-followup")),
        );
        return;
      }
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "kind" in parsed &&
        parsed.kind === "queueChanged"
      ) {
        clearTimeout(timer);
        socket.close();
      }
    });
    socket.once("close", () => resolve());
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      kind: "open",
      token: "local-dev-token",
      manifest: {},
      clientIdentity: {
        kind: "cli",
        compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
        appVersion: "0.1.0",
      },
    }),
  );
  await done;
  return frames;
}

function sendFrame(
  input: { readonly epicId: string; readonly chatId: string },
  messageId: string,
  text: string,
): Record<string, unknown> {
  return {
    kind: "send",
    hasBinaryPayload: false,
    epicId: input.epicId,
    chatId: input.chatId,
    clientActionId: `action-${messageId}`,
    messageId,
    content: promptDoc(text),
    sender: { type: "user", userId: "local" },
    settings: {
      harnessId: "claude",
      model: "default",
      permissionMode: "full_access",
      reasoningEffort: null,
      serviceTier: null,
      agentMode: "regular",
      profileId: null,
    },
    accountContext: { type: "PERSONAL" },
    deliveryPolicy: "auto",
    worktreeIntent: null,
  };
}

function jsonHas(value: unknown, needle: string): boolean {
  return JSON.stringify(value).includes(needle);
}
