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
      permissionMode: null,
      harnessId: null,
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
      permissionMode: null,
      harnessId: null,
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
      permissionMode: null,
      harnessId: null,
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
      "claude",
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
    // The queue's life is on the timeline, as released: the item accepted
    // with itself as metadata, then started. The start lands a beat after
    // the first turn's reply, so it is waited for rather than assumed.
    const eventsOf = (snap: object) =>
      readArray(Reflect.get(snap, "tail") ?? {}, "events");
    const events = eventsOf(
      await waitForSnapshot(
        streamUrl,
        "epic-5",
        "chat-5",
        (snap) =>
          eventsOf(snap).some(
            (e) => Reflect.get(e ?? {}, "type") === "queue.started",
          ),
        80,
        50,
      ),
    );
    const added = events.find(
      (e) => Reflect.get(e ?? {}, "type") === "queue.added",
    );
    expect(added).toMatchObject({
      message: "Queued message accepted.",
      queueItemId: expect.any(String),
      metadata: {
        item: { queueItemId: Reflect.get(added ?? {}, "queueItemId") },
      },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "queue.started",
        message: "Queued prompt started.",
        queueItemId: Reflect.get(added ?? {}, "queueItemId"),
      }),
    );
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
      "claude",
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
      permissionMode: null,
      harnessId: null,
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
      "claude",
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
      permissionMode: null,
      harnessId: null,
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
    const summaries = latestSummaries(frames, "epic-8", "chat-8");
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
      "claude",
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
      permissionMode: null,
      harnessId: null,
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
      "claude",
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
      permissionMode: null,
      harnessId: null,
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
      "claude",
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
      permissionMode: null,
      harnessId: null,
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
  /**
   * A subagent, reported entirely on the parent's stream, with a nested one
   * under it. Three things at once: the card exists with the child's tool
   * activity nested under it, the child's own words are NOT the parent's, and
   * a second-level card hangs off the first by the one hop the stream allows
   * - while a card whose spawn call was never seen stays unparented, which is
   * the contract's "unknown" rather than a guess.
   */
  it("nests a subagent's work under its card, and a child card under that", async () => {
    const stdout = [
      '{"type":"system","subtype":"init","session_id":"sess-task"}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_p1","name":"Task","input":{"description":"List files","subagent_type":"Explore","prompt":"list the files here"}}]}}',
      '{"type":"system","subtype":"task_started","task_id":"task-77","tool_use_id":"toolu_p1","description":"List files","subagent_type":"Explore","prompt":"list the files here"}',
      '{"type":"assistant","parent_tool_use_id":"toolu_p1","message":{"content":[{"type":"tool_use","id":"toolu_c1","name":"Bash","input":{"command":"ls -la"}}]}}',
      '{"type":"user","parent_tool_use_id":"toolu_p1","message":{"content":[{"type":"tool_result","content":"a.txt","tool_use_id":"toolu_c1"}]}}',
      '{"type":"system","subtype":"task_progress","task_id":"task-77","description":"Running ls"}',
      // The child spawns its own agent. Recorded live: the spawn call is in the
      // child's record, the nested task names that call, and the nested
      // agent's transcript is not in this stream at all.
      '{"type":"assistant","parent_tool_use_id":"toolu_p1","message":{"content":[{"type":"tool_use","id":"toolu_c2","name":"Agent","input":{"description":"Nested","subagent_type":"Explore","prompt":"ls again"}}]}}',
      '{"type":"system","subtype":"task_started","task_id":"task-88","tool_use_id":"toolu_c2","description":"Nested","subagent_type":"Explore","spawn_depth":2,"prompt":"ls again"}',
      '{"type":"system","subtype":"task_notification","task_id":"task-88","tool_use_id":"toolu_c2","status":"completed","summary":"nested done"}',
      '{"type":"user","parent_tool_use_id":"toolu_p1","message":{"content":[{"type":"tool_result","content":"nested done","tool_use_id":"toolu_c2"}]}}',
      // A task whose spawn call this stream never carried.
      '{"type":"system","subtype":"task_started","task_id":"task-99","tool_use_id":"toolu_never","description":"Orphan","subagent_type":"Explore","spawn_depth":3,"prompt":"orphan work"}',
      '{"type":"assistant","parent_tool_use_id":"toolu_p1","message":{"content":[{"type":"text","text":"CHILD-TEXT-LEAK"}]}}',
      // A plain Bash call reports as a task too (recorded live: `local_bash`,
      // no prompt). It is the tool call's own card, not a subagent's.
      '{"type":"system","subtype":"task_started","task_id":"task-bash","tool_use_id":"toolu_c1","description":"List files","is_backgrounded":false,"task_type":"local_bash"}',
      '{"type":"system","subtype":"task_notification","task_id":"task-bash","tool_use_id":"toolu_c1","status":"completed","output_file":"","summary":"List files"}',
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
      "claude",
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
      permissionMode: null,
      harnessId: null,
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
    const card = (id: string) =>
      blocks.find(
        (block) =>
          Reflect.get(block, "type") === "subagent" &&
          Reflect.get(block, "blockId") === id,
      );
    expect(card("task-77")).toMatchObject({
      name: "List files",
      agentType: "Explore",
      parentBlockId: null,
      // Named so the GUI drops the `Task` row this card stands in for.
      spawnToolCallId: "toolu_p1",
      // The child's tool activity streams on the card, by the protocol's own
      // policy, beside the progress the harness reported.
      progressUpdates: ["Bash · ls -la", "Running ls", "Agent · Nested"],
      result: "one file",
      status: "completed",
    });
    // One hop up, exactly: the nested card's spawn call was made under the
    // first card.
    expect(card("task-88")).toMatchObject({
      parentBlockId: "task-77",
      spawnToolCallId: "toolu_c2",
      result: "nested done",
    });
    // And no hop for a spawn call this stream never carried.
    expect(card("task-99")).toMatchObject({ parentBlockId: null });
    // The Bash call's task opened no card - and its end closed none.
    expect(card("task-bash")).toBeUndefined();
    // The child's Bash call is the child's: nested under the card, not the
    // turn's. Only the spawning `Task` call is the turn's own.
    const calls = blocks.filter(
      (block) => Reflect.get(block, "type") === "tool_call",
    );
    expect(
      calls.find((block) => Reflect.get(block, "toolName") === "Bash"),
    ).toMatchObject({ parentBlockId: "task-77", status: "completed" });
    expect(
      calls
        .filter((block) => Reflect.get(block, "parentBlockId") === null)
        .map((block) => Reflect.get(block, "toolName")),
    ).toEqual(["Task"]);
    // And the child's closing words are not the assistant's. This is the
    // assertion the block types alone would pass either way.
    const text = blocks.find((block) => Reflect.get(block, "type") === "text");
    expect(Reflect.get(text ?? {}, "text")).toBe("task-ok");
    // Nor are they in the stored reply, which is what gets stuffed back into
    // the next prompt when the session cannot be resumed.
    const stored = started.runtime.store
      .snapshot()
      .chats.find((row) => row.chatId === "chat-11");
    expect(stored?.turns.at(-1)?.prompt).toBe("task-ok");
  });

  /**
   * The real diff. The hooks cannot run under a fake CLI, so the test plays
   * them: it writes what the pre and post hooks would have - the blobs and the
   * two sidecars keyed by the call - and the host reads them when the call's
   * result arrives, exactly as it would from the hooks.
   */
  it("serves the before and after the hooks captured around an edit", async () => {
    // The first Edit is refused before its hooks run, as Claude does live for
    // a file it has not read - so no sidecar exists for it on either side.
    const stdout = [
      '{"type":"system","subtype":"init","session_id":"sess-snap"}',
      `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_s0","name":"Edit","input":{"file_path":"__TARGET__","old_string":"one","new_string":"two"}}]}}`,
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"File has not been read yet.","is_error":true,"tool_use_id":"toolu_s0"}]}}',
      `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_s1","name":"Edit","input":{"file_path":"__TARGET__","old_string":"one","new_string":"two"}}]}}`,
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"ok","tool_use_id":"toolu_s1"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"snap-ok"}]}}',
      '{"type":"result","subtype":"success","usage":{"input_tokens":5,"output_tokens":2}}',
    ];
    const setup = await bootWithCli(
      ["#!/bin/sh", ...stdout.map(printfLine), ""].join("\n"),
      "claude",
    );
    tempDir = setup.tempDir;
    started = setup.started;
    // Inside the workspace: a revert only restores paths under the turn's
    // roots, as released, and the fake CLI learns the path from the env.
    const target = join(setup.workspace, "snap-target.ts");
    process.env.TRAYCER_TEST_EDIT_TARGET = target;
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
      permissionMode: null,
      harnessId: null,
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
    const summaries = latestSummaries(frames, "epic-12", "chat-12");
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
    expect(latestSummaries(afterRevert, "epic-12", "chat-12")).toEqual([]);
    // The turn's checkpoint is the record a revert reads: one event, its
    // manifest listing the edit with both hashes, named by the user message.
    const captured = readArray(
      Reflect.get(
        Reflect.get(
          afterRevert.find(
            (f) => Reflect.get(f ?? {}, "kind") === "snapshot",
          ) ?? {},
          "snapshot",
        ) ?? {},
        "tail",
      ) ?? {},
      "events",
    ).find((e) => Reflect.get(e ?? {}, "type") === "checkpoint.captured");
    expect(captured).toMatchObject({
      messageId: "msg-user-12",
      metadata: {
        schemaVersion: 1,
        capturingHostId: started.runtime.hostId,
        allowedRoots: [setup.workspace],
        entries: [
          {
            filePath: target,
            operation: "edit",
            beforeHash: before,
            afterHash: after,
            undoable: true,
            reason: "snapshot",
          },
        ],
      },
    });
    // A revert is replayable, as released: the same checkpoint restores the
    // same before again, and nothing is "already reverted".
    const again = await sendActionUntil(
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
      "restoreCompleted",
    );
    expect(
      again.find((f) => Reflect.get(f ?? {}, "kind") === "restoreCompleted"),
    ).toMatchObject({
      checkpointId: "revert-12b",
      results: [{ filePath: target, status: "restored" }],
    });
    expect(await readFile(target, "utf8")).toBe("one\nsame\n");
    await rm(target, { force: true });
  });

  /**
   * Undo from a message on. Two turns edit the same file; a revert scoped to
   * the second puts back what the second turn found, not what the first did
   * - and the panel then shows the first turn's change alone. A message the
   * chat does not have scopes nothing, as released.
   */
  it("reverts only the turns from a given message on", async () => {
    const script = [
      "#!/bin/sh",
      "read -r prompt",
      'case "$prompt" in *first*) id=toolu_t1;; *) id=toolu_t2;; esac',
      `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"sess-scope"}'`,
      `printf '%s\\n' "{\\"type\\":\\"assistant\\",\\"message\\":{\\"content\\":[{\\"type\\":\\"tool_use\\",\\"id\\":\\"$id\\",\\"name\\":\\"Edit\\",\\"input\\":{\\"file_path\\":\\"$TRAYCER_TEST_EDIT_TARGET\\",\\"old_string\\":\\"a\\",\\"new_string\\":\\"b\\"}}]}}"`,
      `printf '%s\\n' "{\\"type\\":\\"user\\",\\"message\\":{\\"content\\":[{\\"type\\":\\"tool_result\\",\\"content\\":\\"ok\\",\\"tool_use_id\\":\\"$id\\"}]}}"`,
      `printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"edited"}]}}'`,
      `printf '%s\\n' '{"type":"result","subtype":"success","usage":{"input_tokens":5,"output_tokens":2}}'`,
      "",
    ].join("\n");
    const setup = await bootWithCli(script, "claude");
    tempDir = setup.tempDir;
    started = setup.started;
    const target = join(setup.workspace, "scope-target.ts");
    process.env.TRAYCER_TEST_EDIT_TARGET = target;
    const one = await playHook(tempDir, "toolu_t1", "pre", "one\n");
    const two = await playHook(tempDir, "toolu_t1", "post", "two\n");
    await playHook(tempDir, "toolu_t2", "pre", "two\n");
    await playHook(tempDir, "toolu_t2", "post", "three\n");
    await seedChat(started, setup.workspace, "epic-30", "chat-30");
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    const checkpoints = (snapshot: object): number =>
      readArray(Reflect.get(snapshot, "tail") ?? {}, "events").filter(
        (e) => Reflect.get(e ?? {}, "type") === "checkpoint.captured",
      ).length;
    await sendOnChat(streamUrl, {
      epicId: "epic-30",
      chatId: "chat-30",
      clientActionId: "action-30a",
      messageId: "msg-user-30a",
      text: "first edit",
      permissionMode: null,
      harnessId: null,
    });
    await waitForSnapshot(
      streamUrl,
      "epic-30",
      "chat-30",
      (snapshot) =>
        checkpoints(snapshot) === 1 &&
        Reflect.get(snapshot, "runStatus") === "idle",
      80,
      50,
    );
    await sendOnChat(streamUrl, {
      epicId: "epic-30",
      chatId: "chat-30",
      clientActionId: "action-30b",
      messageId: "msg-user-30b",
      text: "second edit",
      permissionMode: null,
      harnessId: null,
    });
    await waitForSnapshot(
      streamUrl,
      "epic-30",
      "chat-30",
      (snapshot) =>
        checkpoints(snapshot) === 2 &&
        Reflect.get(snapshot, "runStatus") === "idle",
      80,
      50,
    );
    const revert = (clientActionId: string, fromMessageId: string | null) =>
      sendActionUntil(
        streamUrl,
        {
          kind: "revertFileChanges",
          epicId: "epic-30",
          chatId: "chat-30",
          clientActionId,
          fromMessageId,
          filePaths: null,
          revertArtifacts: true,
        },
        "restoreCompleted",
      );
    const completed = (frames: readonly unknown[]) =>
      frames.find((f) => Reflect.get(f ?? {}, "kind") === "restoreCompleted");
    // From the second message: back to what the second turn found.
    expect(completed(await revert("revert-30a", "msg-user-30b"))).toMatchObject(
      {
        results: [{ filePath: target, status: "restored", operation: "edit" }],
      },
    );
    expect(await readFile(target, "utf8")).toBe("two\n");
    // The panel now describes the first turn alone.
    expect(
      latestSummaries(
        await collectChatFrames(streamUrl, "epic-30", "chat-30"),
        "epic-30",
        "chat-30",
      ),
    ).toMatchObject([{ digest: changeDigest(one, two) }]);
    // A message this chat never had scopes nothing.
    expect(completed(await revert("revert-30b", "msg-nope"))).toMatchObject({
      results: [],
    });
    expect(await readFile(target, "utf8")).toBe("two\n");
    // Everything: back to before the first turn, and the panel is empty.
    expect(completed(await revert("revert-30c", null))).toMatchObject({
      results: [{ filePath: target, status: "restored" }],
    });
    expect(await readFile(target, "utf8")).toBe("one\n");
    expect(
      latestSummaries(
        await collectChatFrames(streamUrl, "epic-30", "chat-30"),
        "epic-30",
        "chat-30",
      ),
    ).toEqual([]);
    await rm(target, { force: true });
  });

  /**
   * The host's own gate on Undo. The GUI disables the button while a turn
   * runs, but a click and a turn start can cross on the wire - and a revert
   * accepted mid-turn writes the first before back under an agent still
   * working on the file. Seen live; reproduced here by opening a print
   * directly rather than racing a CLI.
   */
  it("refuses a revert while a turn is running", async () => {
    const setup = await boot();
    tempDir = setup.tempDir;
    started = setup.started;
    await seedChat(started, setup.workspace, "epic-13", "chat-13");
    started.runtime.guiRuns.beginPrint("chat-13", {
      harnessId: "claude",
      model: "default",
      userMessageId: null,
      assistantMessageId: "assistant-13",
      turnId: "turn:13",
      resumed: false,
      startedAt: Date.now(),
    });
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    const frames = await sendActionUntil(
      streamUrl,
      {
        kind: "revertFileChanges",
        epicId: "epic-13",
        chatId: "chat-13",
        clientActionId: "revert-13",
        fromMessageId: null,
        filePaths: null,
        revertArtifacts: true,
      },
      "actionAck",
    );
    expect(frames).toContainEqual(
      expect.objectContaining({
        kind: "actionAck",
        status: "rejected",
        code: "CHECKPOINT_RESTORE_ACTIVE_TURN",
      }),
    );
    started.runtime.guiRuns.endPrint("chat-13", "assistant-13");
  });

  /**
   * The permission flow, end to end. The fake CLI does what the real one does
   * on the stdio channel: reads the prompt off stdin, asks before its tool,
   * and waits for the answer - then reports the tool as run or refused by
   * what it was told. Under `supervised` the question reaches the GUI.
   */
  it("asks the user before a tool under supervised, and relays the answer", async () => {
    const setup = await bootWithCli(
      askingCli("Bash", '{"command":"rm -rf build"}', "Run rm -rf build"),
      "claude",
    );
    tempDir = setup.tempDir;
    started = setup.started;
    await seedChat(started, setup.workspace, "epic-14", "chat-14");
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    await sendOnChat(streamUrl, {
      epicId: "epic-14",
      chatId: "chat-14",
      clientActionId: "action-14",
      messageId: "msg-user-14",
      text: "clean the build",
      permissionMode: "supervised",
      harnessId: null,
    });
    // The question lands on the snapshot, which is where a reopened tab
    // finds it.
    const asked = await waitForSnapshot(
      streamUrl,
      "epic-14",
      "chat-14",
      (snapshot) => readArray(snapshot, "pendingApprovals").length === 1,
      80,
      50,
    );
    const pending = readArray(asked, "pendingApprovals")[0];
    expect(pending).toMatchObject({
      toolName: "Bash",
      description: "Run rm -rf build",
      input: { command: "rm -rf build" },
      kind: "tool",
    });
    const approvalId = String(Reflect.get(pending ?? {}, "approvalId"));
    expect(approvalId.endsWith(":approval")).toBe(true);
    // Answered: the ack, the resolution frame, and the CLI carrying on.
    const answered = await sendActionUntil(
      streamUrl,
      {
        kind: "approvalDecision",
        epicId: "epic-14",
        chatId: "chat-14",
        clientActionId: "decide-14",
        approvalId,
        decision: { approved: true },
      },
      "approvalResolved",
    );
    expect(answered).toContainEqual(
      expect.objectContaining({ kind: "actionAck", status: "accepted" }),
    );
    expect(answered).toContainEqual(
      expect.objectContaining({
        kind: "approvalResolved",
        approvalId,
        decision: { approved: true },
      }),
    );
    const frames = await waitForSealedBlocks(
      streamUrl,
      "epic-14",
      "chat-14",
      "approval",
      80,
      50,
    );
    const blocks = assistantBlocks(frames, "epic-14", "chat-14");
    expect(
      blocks.find((block) => Reflect.get(block, "type") === "approval"),
    ).toMatchObject({
      blockId: approvalId,
      toolName: "Bash",
      decision: { approved: true, reason: null },
    });
    expect(
      blocks.find((block) => Reflect.get(block, "type") === "tool_call"),
    ).toMatchObject({ toolName: "Bash", status: "completed" });
    expect(
      blocks.find((block) => Reflect.get(block, "type") === "text"),
    ).toMatchObject({ text: "allowed-ok" });
    // A second answer has nothing to land on.
    expect(
      await sendActionUntil(
        streamUrl,
        {
          kind: "approvalDecision",
          epicId: "epic-14",
          chatId: "chat-14",
          clientActionId: "decide-14b",
          approvalId,
          decision: { approved: true },
        },
        "actionAck",
      ),
    ).toContainEqual(
      expect.objectContaining({
        status: "rejected",
        code: "APPROVAL_NOT_FOUND",
      }),
    );
  });

  /**
   * An edit is a file question, with the paths the GUI shows and the frame
   * the file panel listens on. Denied: the CLI is told why, the tool errors,
   * and the log says who said no.
   */
  it("asks about a file edit as a file edit, and relays a denial", async () => {
    const target = join(tmpdir(), `traycer-perm-${String(Date.now())}.ts`);
    const setup = await bootWithCli(
      askingCli("Write", `{"file_path":"${target}","content":"x"}`, "perm.ts"),
      "claude",
    );
    tempDir = setup.tempDir;
    started = setup.started;
    await seedChat(started, setup.workspace, "epic-15", "chat-15");
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    await sendOnChat(streamUrl, {
      epicId: "epic-15",
      chatId: "chat-15",
      clientActionId: "action-15",
      messageId: "msg-user-15",
      text: "write it",
      permissionMode: "supervised",
      harnessId: null,
    });
    const asked = await waitForSnapshot(
      streamUrl,
      "epic-15",
      "chat-15",
      (snapshot) =>
        readArray(snapshot, "pendingFileEditApprovals").length === 1,
      80,
      50,
    );
    const pending = readArray(asked, "pendingFileEditApprovals")[0];
    expect(pending).toMatchObject({
      toolName: "Write",
      paths: [target],
      // Not on disk yet, so the edit would create it.
      operation: "create",
    });
    expect(readArray(asked, "pendingApprovals")).toEqual([]);
    const approvalId = String(Reflect.get(pending ?? {}, "approvalId"));
    const answered = await sendActionUntil(
      streamUrl,
      {
        kind: "fileEditApprovalDecision",
        epicId: "epic-15",
        chatId: "chat-15",
        clientActionId: "decide-15",
        approvalId,
        decision: { approved: false, reason: "not that file" },
      },
      "fileEditApprovalResolved",
    );
    expect(answered).toContainEqual(
      expect.objectContaining({
        kind: "fileEditApprovalResolved",
        approvalId,
        decision: { approved: false, reason: "not that file" },
      }),
    );
    const frames = await waitForSealedBlocks(
      streamUrl,
      "epic-15",
      "chat-15",
      "tool_call",
      80,
      50,
    );
    const blocks = assistantBlocks(frames, "epic-15", "chat-15");
    expect(
      blocks.find((block) => Reflect.get(block, "type") === "tool_call"),
    ).toMatchObject({
      toolName: "Write",
      status: "errored",
      error: "not that file",
    });
    expect(
      blocks.find((block) => Reflect.get(block, "type") === "text"),
    ).toMatchObject({ text: "denied-ok" });
    const events = readArray(
      Reflect.get(
        Reflect.get(
          frames.find((f) => Reflect.get(f ?? {}, "kind") === "snapshot") ?? {},
          "snapshot",
        ) ?? {},
        "tail",
      ) ?? {},
      "events",
    ).map((event) => Reflect.get(event ?? {}, "type"));
    expect(events).toContain("approval.requested");
    expect(events).toContain("approval.denied");
  });

  /**
   * `full_access` is the host answering yes, not the CLI never asking: the
   * CLI still runs in `default` and asks, and nothing reaches the GUI.
   */
  it("answers for the user under full_access without asking", async () => {
    const setup = await bootWithCli(
      askingCli("Bash", '{"command":"ls"}', "Run ls"),
      "claude",
    );
    tempDir = setup.tempDir;
    started = setup.started;
    await seedChat(started, setup.workspace, "epic-16", "chat-16");
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    const sent = await sendOnChat(streamUrl, {
      epicId: "epic-16",
      chatId: "chat-16",
      clientActionId: "action-16",
      messageId: "msg-user-16",
      text: "list",
      permissionMode: "full_access",
      harnessId: null,
    });
    expect(
      sent.some((f) => Reflect.get(f ?? {}, "kind") === "approvalRequested"),
    ).toBe(false);
    const frames = await waitForSealedBlocks(
      streamUrl,
      "epic-16",
      "chat-16",
      "tool_call",
      80,
      50,
    );
    const blocks = assistantBlocks(frames, "epic-16", "chat-16");
    expect(
      blocks.some((block) => Reflect.get(block, "type") === "approval"),
    ).toBe(false);
    expect(
      blocks.find((block) => Reflect.get(block, "type") === "tool_call"),
    ).toMatchObject({ toolName: "Bash", status: "completed" });
    expect(
      blocks.find((block) => Reflect.get(block, "type") === "text"),
    ).toMatchObject({ text: "allowed-ok" });
  });

  /**
   * A stop with a question open answers it for the user. The CLI is told
   * "Aborted", the frame resolves, and the log says the question was
   * abandoned rather than denied.
   */
  it("abandons an open question when the turn is stopped", async () => {
    const setup = await bootWithCli(
      askingCli("Bash", '{"command":"ls"}', "Run ls"),
      "claude",
    );
    tempDir = setup.tempDir;
    started = setup.started;
    await seedChat(started, setup.workspace, "epic-17", "chat-17");
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    await sendOnChat(streamUrl, {
      epicId: "epic-17",
      chatId: "chat-17",
      clientActionId: "action-17",
      messageId: "msg-user-17",
      text: "list",
      permissionMode: "supervised",
      harnessId: null,
    });
    const asked = await waitForSnapshot(
      streamUrl,
      "epic-17",
      "chat-17",
      (snapshot) => readArray(snapshot, "pendingApprovals").length === 1,
      80,
      50,
    );
    const approvalId = String(
      Reflect.get(readArray(asked, "pendingApprovals")[0] ?? {}, "approvalId"),
    );
    const stopped = await sendActionUntil(
      streamUrl,
      {
        kind: "stop",
        epicId: "epic-17",
        chatId: "chat-17",
        clientActionId: "stop-17",
      },
      "approvalResolved",
    );
    expect(stopped).toContainEqual(
      expect.objectContaining({
        kind: "approvalResolved",
        approvalId,
        decision: { approved: false, reason: "Aborted" },
      }),
    );
    // The stop shows as `stopping` before the process is gone, as released.
    expect(stopped).toContainEqual(
      expect.objectContaining({
        kind: "turnStateChanged",
        runStatus: "stopping",
        activeTurn: expect.objectContaining({ status: "stopping" }),
      }),
    );
    const after = await waitForSnapshot(
      streamUrl,
      "epic-17",
      "chat-17",
      (snapshot) =>
        Reflect.get(snapshot, "runStatus") === "idle" &&
        readArray(snapshot, "pendingApprovals").length === 0,
      80,
      50,
    );
    expect(
      readArray(Reflect.get(after, "tail") ?? {}, "events").map((e) =>
        Reflect.get(e ?? {}, "type"),
      ),
    ).toContain("approval.abandoned");
  });

  /**
   * A question the agent asks the user, under `full_access` on purpose: a
   * question is not a permission, and no mode answers it for the user. The
   * fake CLI checks the answer reaches it the way the real one reads it - as
   * an `answers` map on the tool's own input.
   */
  it("opens an interview for AskUserQuestion and relays the answer", async () => {
    const setup = await bootWithCli(askingInterviewCli(), "claude");
    tempDir = setup.tempDir;
    started = setup.started;
    await seedChat(started, setup.workspace, "epic-18", "chat-18");
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    await sendOnChat(streamUrl, {
      epicId: "epic-18",
      chatId: "chat-18",
      clientActionId: "action-18",
      messageId: "msg-user-18",
      text: "ask me",
      permissionMode: "full_access",
      harnessId: null,
    });
    const asked = await waitForSnapshot(
      streamUrl,
      "epic-18",
      "chat-18",
      (snapshot) => readArray(snapshot, "pendingInterviews").length === 1,
      80,
      50,
    );
    const blockId = String(
      Reflect.get(readArray(asked, "pendingInterviews")[0] ?? {}, "blockId"),
    );
    expect(blockId).toBe("toolu_q1:interview");
    // Judged, and to no row: the asking turn is not persisted yet, so this
    // snapshot has nothing that could draw the card.
    expect(
      readArray(Reflect.get(asked, "derived") ?? {}, "interviewAnswerability"),
    ).toEqual([{ blockId, ordinal: null }]);
    const answered = await sendActionUntil(
      streamUrl,
      {
        kind: "interviewAnswer",
        epicId: "epic-18",
        chatId: "chat-18",
        clientActionId: "answer-18",
        blockId,
        answers: [
          {
            questionId: null,
            question: "Which color?",
            values: ["Blue"],
            notes: null,
          },
        ],
      },
      "interviewAnswered",
    );
    expect(answered).toContainEqual(
      expect.objectContaining({ kind: "actionAck", status: "accepted" }),
    );
    expect(answered).toContainEqual(
      expect.objectContaining({
        kind: "interviewAnswered",
        blockId,
        answers: [
          expect.objectContaining({
            question: "Which color?",
            values: ["Blue"],
          }),
        ],
      }),
    );
    const frames = await waitForSealedBlocks(
      streamUrl,
      "epic-18",
      "chat-18",
      "interview",
      80,
      50,
    );
    const blocks = assistantBlocks(frames, "epic-18", "chat-18");
    expect(
      blocks.find((block) => Reflect.get(block, "type") === "interview"),
    ).toMatchObject({
      blockId,
      toolName: "AskUserQuestion",
      status: "completed",
      questions: [
        expect.objectContaining({
          question: "Which color?",
          header: "Color",
          multiSelect: false,
          options: [
            { label: "Red", description: null, preview: null },
            { label: "Blue", description: "The color blue", preview: null },
          ],
        }),
      ],
      answers: [expect.objectContaining({ values: ["Blue"] })],
    });
    expect(
      blocks.find((block) => Reflect.get(block, "type") === "text"),
    ).toMatchObject({ text: "you chose Blue" });
    const events = readArray(
      Reflect.get(
        Reflect.get(
          frames.find((f) => Reflect.get(f ?? {}, "kind") === "snapshot") ?? {},
          "snapshot",
        ) ?? {},
        "tail",
      ) ?? {},
      "events",
    ).map((event) => Reflect.get(event ?? {}, "type"));
    expect(events).toContain("interview.requested");
    expect(events).toContain("interview.resolved");
    expect(
      await sendActionUntil(
        streamUrl,
        {
          kind: "interviewAnswer",
          epicId: "epic-18",
          chatId: "chat-18",
          clientActionId: "answer-18b",
          blockId,
          answers: [],
        },
        "actionAck",
      ),
    ).toContainEqual(
      expect.objectContaining({
        status: "rejected",
        code: "INTERVIEW_NOT_FOUND",
      }),
    );
  });

  /**
   * A stop with a question open fails the question: the CLI is refused with
   * "Aborted", the card errors, and the log says so.
   */
  it("fails an open question when the turn is stopped", async () => {
    const setup = await bootWithCli(askingInterviewCli(), "claude");
    tempDir = setup.tempDir;
    started = setup.started;
    await seedChat(started, setup.workspace, "epic-19", "chat-19");
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    await sendOnChat(streamUrl, {
      epicId: "epic-19",
      chatId: "chat-19",
      clientActionId: "action-19",
      messageId: "msg-user-19",
      text: "ask me",
      permissionMode: "supervised",
      harnessId: null,
    });
    await waitForSnapshot(
      streamUrl,
      "epic-19",
      "chat-19",
      (snapshot) => readArray(snapshot, "pendingInterviews").length === 1,
      80,
      50,
    );
    const stopped = await sendActionUntil(
      streamUrl,
      {
        kind: "stop",
        epicId: "epic-19",
        chatId: "chat-19",
        clientActionId: "stop-19",
      },
      "interviewErrored",
    );
    expect(stopped).toContainEqual(
      expect.objectContaining({
        kind: "interviewErrored",
        blockId: "toolu_q1:interview",
        reason: "Aborted",
      }),
    );
    const after = await waitForSnapshot(
      streamUrl,
      "epic-19",
      "chat-19",
      (snapshot) =>
        Reflect.get(snapshot, "runStatus") === "idle" &&
        readArray(snapshot, "pendingInterviews").length === 0,
      80,
      50,
    );
    expect(
      readArray(Reflect.get(after, "tail") ?? {}, "events").map((e) =>
        Reflect.get(e ?? {}, "type"),
      ),
    ).toContain("interview.errored");
  });

  /**
   * Codex, end to end, against a fake app-server that speaks the JSON-RPC
   * the real one does - recorded live: `initialize`, `thread/start`,
   * `turn/start`, an announced file change, the approval request that gates
   * it, and the item's completion. The fake writes the file only when told
   * yes, which is what makes the host's own before/after real.
   */
  it("asks about a Codex file change, and captures it around the approval", async () => {
    const target = join(tmpdir(), `traycer-codex-${String(Date.now())}.txt`);
    const setup = await bootWithCli(fakeCodexAppServer(target), "codex");
    tempDir = setup.tempDir;
    started = setup.started;
    await seedChat(started, setup.workspace, "epic-20", "chat-20");
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    await sendOnChat(streamUrl, {
      epicId: "epic-20",
      chatId: "chat-20",
      clientActionId: "action-20",
      messageId: "msg-user-20",
      text: "make the file",
      permissionMode: "supervised",
      harnessId: "codex",
    });
    const asked = await waitForSnapshot(
      streamUrl,
      "epic-20",
      "chat-20",
      (snapshot) =>
        readArray(snapshot, "pendingFileEditApprovals").length === 1,
      80,
      50,
    );
    const pending = readArray(asked, "pendingFileEditApprovals")[0];
    // The paths come from the item's announcement, not the request - which
    // names only the item.
    expect(pending).toMatchObject({
      toolName: "apply_patch",
      paths: [target],
      operation: "create",
    });
    const approvalId = String(Reflect.get(pending ?? {}, "approvalId"));
    expect(approvalId).toBe("item-fc-1:file-edit");
    const answered = await sendActionUntil(
      streamUrl,
      {
        kind: "fileEditApprovalDecision",
        epicId: "epic-20",
        chatId: "chat-20",
        clientActionId: "decide-20",
        approvalId,
        decision: { approved: true },
      },
      "fileEditApprovalResolved",
    );
    expect(answered).toContainEqual(
      expect.objectContaining({ kind: "actionAck", status: "accepted" }),
    );
    const frames = await waitForSealedBlocks(
      streamUrl,
      "epic-20",
      "chat-20",
      "file_change",
      80,
      50,
    );
    const blocks = assistantBlocks(frames, "epic-20", "chat-20");
    expect(await readFile(target, "utf8")).toBe("hi\n");
    expect(
      blocks.find((block) => Reflect.get(block, "type") === "file_change"),
    ).toMatchObject({
      blockId: `item-fc-1:${target}`,
      operation: "create",
      diffSource: "snapshot",
      beforeHash: null,
      additions: 1,
      deletions: 0,
      reason: "snapshot",
    });
    expect(
      blocks.find((block) => Reflect.get(block, "type") === "text"),
    ).toMatchObject({ text: "codex-ok" });
    // The item opened no tool row - its card is the file - so none closes.
    expect(
      blocks.some((block) => Reflect.get(block, "type") === "tool_call"),
    ).toBe(false);
    expect(latestSummaries(frames, "epic-20", "chat-20")[0]).toMatchObject({
      filePath: target,
      operation: "create",
      hasContents: true,
      undoable: true,
      counts: { additions: 1, deletions: 0 },
    });
    await rm(target, { force: true });
  });

  /** `full_access` answers the app-server's question itself; nothing reaches the GUI. */
  it("answers a Codex approval itself under full_access", async () => {
    const target = join(tmpdir(), `traycer-codex-${String(Date.now())}-fa.txt`);
    const setup = await bootWithCli(fakeCodexAppServer(target), "codex");
    tempDir = setup.tempDir;
    started = setup.started;
    await seedChat(started, setup.workspace, "epic-21", "chat-21");
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    const sent = await sendOnChat(streamUrl, {
      epicId: "epic-21",
      chatId: "chat-21",
      clientActionId: "action-21",
      messageId: "msg-user-21",
      text: "make the file",
      permissionMode: "full_access",
      harnessId: "codex",
    });
    expect(
      sent.some(
        (f) => Reflect.get(f ?? {}, "kind") === "fileEditApprovalRequested",
      ),
    ).toBe(false);
    const frames = await waitForSealedBlocks(
      streamUrl,
      "epic-21",
      "chat-21",
      "file_change",
      80,
      50,
    );
    const blocks = assistantBlocks(frames, "epic-21", "chat-21");
    expect(await readFile(target, "utf8")).toBe("hi\n");
    expect(
      blocks.find((block) => Reflect.get(block, "type") === "file_change"),
    ).toMatchObject({ diffSource: "snapshot", operation: "create" });
    await rm(target, { force: true });
  });

  /**
   * Codex asking the user a question. The fake sends the schema's
   * `item/tool/requestUserInput` and reads the answer back the way the real
   * server does - keyed by question id - which is the released host's
   * mapping, not the text-keyed one Claude takes.
   */
  it("opens an interview for Codex's request_user_input and answers by id", async () => {
    const setup = await bootWithCli(askingCodexAppServer(), "codex");
    tempDir = setup.tempDir;
    started = setup.started;
    await seedChat(started, setup.workspace, "epic-22", "chat-22");
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    await sendOnChat(streamUrl, {
      epicId: "epic-22",
      chatId: "chat-22",
      clientActionId: "action-22",
      messageId: "msg-user-22",
      text: "ask me",
      permissionMode: "full_access",
      harnessId: "codex",
    });
    const asked = await waitForSnapshot(
      streamUrl,
      "epic-22",
      "chat-22",
      (snapshot) => readArray(snapshot, "pendingInterviews").length === 1,
      80,
      50,
    );
    const blockId = String(
      Reflect.get(readArray(asked, "pendingInterviews")[0] ?? {}, "blockId"),
    );
    expect(blockId).toBe("q-item-1:interview");
    const answered = await sendActionUntil(
      streamUrl,
      {
        kind: "interviewAnswer",
        epicId: "epic-22",
        chatId: "chat-22",
        clientActionId: "answer-22",
        blockId,
        answers: [
          {
            questionId: "q1",
            question: "Which color?",
            values: ["Blue"],
            notes: null,
          },
        ],
      },
      "interviewAnswered",
    );
    expect(answered).toContainEqual(
      expect.objectContaining({ kind: "actionAck", status: "accepted" }),
    );
    const frames = await waitForSealedBlocks(
      streamUrl,
      "epic-22",
      "chat-22",
      "interview",
      80,
      50,
    );
    const blocks = assistantBlocks(frames, "epic-22", "chat-22");
    expect(
      blocks.find((block) => Reflect.get(block, "type") === "interview"),
    ).toMatchObject({
      blockId,
      toolName: "request_user_input",
      title: "Codex needs your input",
      status: "completed",
      questions: [
        expect.objectContaining({
          questionId: "q1",
          question: "Which color?",
          header: "Color",
        }),
      ],
      answers: [expect.objectContaining({ values: ["Blue"] })],
    });
    expect(
      blocks.find((block) => Reflect.get(block, "type") === "text"),
    ).toMatchObject({ text: "you chose Blue" });
  });

  /**
   * Plan mode, end to end. `/plan …` runs the CLI in its plan mode - the fake
   * reports which mode it was given - and the plan comes back as an
   * `ExitPlanMode` question this host refuses with the released host's
   * sentence, having captured the plan as a card. A plan past the preview cap
   * lives in the blob store, and `agent.gui.getPlan` serves it whole.
   */
  it("turns a /plan turn's ExitPlanMode into a plan card the GUI can fetch", async () => {
    const setup = await bootWithCli(planningCli(), "claude");
    tempDir = setup.tempDir;
    started = setup.started;
    await seedChat(started, setup.workspace, "epic-23", "chat-23");
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    await sendOnChat(streamUrl, {
      epicId: "epic-23",
      chatId: "chat-23",
      clientActionId: "action-23",
      messageId: "msg-user-23",
      text: "/plan add a readme",
      permissionMode: "full_access",
      harnessId: null,
    });
    const frames = await waitForSealedBlocks(
      streamUrl,
      "epic-23",
      "chat-23",
      "plan",
      80,
      50,
    );
    const blocks = assistantBlocks(frames, "epic-23", "chat-23");
    const plan = blocks.find((block) => Reflect.get(block, "type") === "plan");
    expect(plan).toMatchObject({
      planStatus: "ready",
      title: "Plan",
      source: {
        harnessId: "claude",
        sessionId: "sess-plan",
        kind: "plan-mode",
      },
      metadata: { providerEvent: "ExitPlanMode" },
      approvalId: null,
    });
    const planId = String(Reflect.get(plan ?? {}, "planId"));
    expect(planId.startsWith("claude:sess-plan:turn:")).toBe(true);
    expect(planId.endsWith(":toolu_plan1")).toBe(true);
    expect(Reflect.get(plan ?? {}, "blockId")).toBe(`plan:${planId}`);
    // Past the cap: the card carries the first part and a ref to the rest.
    expect(String(Reflect.get(plan ?? {}, "markdownPreview"))).toHaveLength(
      4000,
    );
    expect(Reflect.get(plan ?? {}, "fullContentRef")).toMatchObject({
      kind: "plan_content",
    });
    // The CLI was run in plan mode, and told to stop once the plan was captured.
    const text = String(
      Reflect.get(
        blocks.find((block) => Reflect.get(block, "type") === "text") ?? {},
        "text",
      ),
    );
    expect(text).toContain("mode-plan");
    expect(text).toContain("plan-ready");
    const fetched = await call(
      started.rpcUrl,
      "agent.gui.getPlan",
      { major: 1, minor: 0 },
      {
        epicId: "epic-23",
        chatId: "chat-23",
        planId,
      },
    );
    expect(fetched).toMatchObject({
      planId,
      planStatus: "ready",
      unavailableReason: null,
      contentHash: expect.any(String),
    });
    const markdown = String(Reflect.get(fetched ?? {}, "markdown"));
    expect(markdown.startsWith("# Add README")).toBe(true);
    expect(markdown.length).toBeGreaterThan(4000);
  });

  /**
   * Same-turn steering, recorded live: a second user record on Claude's
   * stdin before its `result` is taken at the next tool boundary and answered
   * in the same `result`. The fake CLI blocks on that second record, so the
   * reply can only carry the steer's words if the host actually wrote them.
   */
  it("steers a queued prompt into the running Claude turn", async () => {
    const setup = await bootWithCli(steeringCli(), "claude");
    tempDir = setup.tempDir;
    started = setup.started;
    await seedChat(started, setup.workspace, "epic-24", "chat-24");
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    await sendOnChat(streamUrl, {
      epicId: "epic-24",
      chatId: "chat-24",
      clientActionId: "action-24",
      messageId: "msg-user-24",
      text: "start",
      permissionMode: null,
      harnessId: null,
    });
    const running = await waitForSnapshot(
      streamUrl,
      "epic-24",
      "chat-24",
      (snapshot) => Reflect.get(snapshot, "activeTurn") !== null,
      80,
      50,
    );
    expect(Reflect.get(running, "activeTurn")).toMatchObject({
      sameTurnSteeringSupported: true,
    });
    const queueItemId = await queueFollowUp(
      streamUrl,
      "epic-24",
      "chat-24",
      "msg-user-24b",
      "also mention pineapple",
      "auto",
    );
    const steered = await sendActionUntil(
      streamUrl,
      {
        kind: "queueSteerNow",
        epicId: "epic-24",
        chatId: "chat-24",
        clientActionId: "steer-24",
        queueItemId,
        newSettings: null,
      },
      "eventAppended",
    );
    expect(steered).toContainEqual(
      expect.objectContaining({
        kind: "actionAck",
        action: "queueSteerNow",
        status: "accepted",
      }),
    );
    const frames = await waitForSealedBlocks(
      streamUrl,
      "epic-24",
      "chat-24",
      "steer",
      80,
      50,
    );
    const blocks = assistantBlocks(frames, "epic-24", "chat-24");
    expect(
      blocks.find((block) => Reflect.get(block, "type") === "steer"),
    ).toMatchObject({
      blockId: `steer:${queueItemId}`,
      queueItemId,
      messageId: "msg-user-24b",
      mode: "safe_point",
      content: promptDoc("also mention pineapple"),
      sender: { type: "user", userId: "local" },
    });
    // The reply carries the steer's words - the CLI got the record.
    expect(
      blocks
        .filter((block) => Reflect.get(block, "type") === "text")
        .map((block) => Reflect.get(block, "text"))
        .join(""),
    ).toContain("steered:also mention pineapple");
    const snapshot = Reflect.get(
      frames.find((f) => Reflect.get(f ?? {}, "kind") === "snapshot") ?? {},
      "snapshot",
    );
    expect(readArray(Reflect.get(snapshot, "queue") ?? {}, "items")).toEqual(
      [],
    );
    expect(
      readArray(Reflect.get(snapshot, "tail") ?? {}, "events").map((e) =>
        Reflect.get(e ?? {}, "type"),
      ),
    ).toEqual(
      expect.arrayContaining(["queue.steerRequested", "queue.steered"]),
    );
  });

  /** Mod-Enter: the send itself asks for the running turn, no queue action. */
  it("steers a send marked after_safe_point straight into the running turn", async () => {
    const setup = await bootWithCli(steeringCli(), "claude");
    tempDir = setup.tempDir;
    started = setup.started;
    await seedChat(started, setup.workspace, "epic-25", "chat-25");
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    await sendOnChat(streamUrl, {
      epicId: "epic-25",
      chatId: "chat-25",
      clientActionId: "action-25",
      messageId: "msg-user-25",
      text: "start",
      permissionMode: null,
      harnessId: null,
    });
    await waitForSnapshot(
      streamUrl,
      "epic-25",
      "chat-25",
      (snapshot) => Reflect.get(snapshot, "activeTurn") !== null,
      80,
      50,
    );
    const queueItemId = await queueFollowUp(
      streamUrl,
      "epic-25",
      "chat-25",
      "msg-user-25b",
      "and cherries",
      "after_safe_point",
    );
    const frames = await waitForSealedBlocks(
      streamUrl,
      "epic-25",
      "chat-25",
      "steer",
      80,
      50,
    );
    const blocks = assistantBlocks(frames, "epic-25", "chat-25");
    expect(
      blocks.find((block) => Reflect.get(block, "type") === "steer"),
    ).toMatchObject({ queueItemId, messageId: "msg-user-25b" });
    expect(JSON.stringify(blocks)).toContain("steered:and cherries");
  });

  /**
   * Codex takes a steer over `turn/steer`, quoting the running turn's id.
   * The fake app-server answers it, then speaks the steer's words.
   */
  it("steers a queued prompt into the running Codex turn over turn/steer", async () => {
    const setup = await bootWithCli(steeringCodexAppServer(false), "codex");
    tempDir = setup.tempDir;
    started = setup.started;
    await seedChat(started, setup.workspace, "epic-26", "chat-26");
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    await sendOnChat(streamUrl, {
      epicId: "epic-26",
      chatId: "chat-26",
      clientActionId: "action-26",
      messageId: "msg-user-26",
      text: "start",
      permissionMode: null,
      harnessId: "codex",
    });
    await waitForSnapshot(
      streamUrl,
      "epic-26",
      "chat-26",
      (snapshot) => Reflect.get(snapshot, "activeTurn") !== null,
      80,
      50,
    );
    const queueItemId = await queueFollowUp(
      streamUrl,
      "epic-26",
      "chat-26",
      "msg-user-26b",
      "use turn steer",
      "auto",
    );
    await sendActionUntil(
      streamUrl,
      {
        kind: "queueSteerNow",
        epicId: "epic-26",
        chatId: "chat-26",
        clientActionId: "steer-26",
        queueItemId,
        newSettings: null,
      },
      "eventAppended",
    );
    const frames = await waitForSealedBlocks(
      streamUrl,
      "epic-26",
      "chat-26",
      "steer",
      80,
      50,
    );
    const blocks = assistantBlocks(frames, "epic-26", "chat-26");
    expect(
      blocks.find((block) => Reflect.get(block, "type") === "steer"),
    ).toMatchObject({ queueItemId, mode: "safe_point" });
    expect(JSON.stringify(blocks)).toContain(
      "steered:turn-fake-1:use turn steer",
    );
  });

  /**
   * A steer the app-server refuses is the follow-up's problem, not the
   * turn's: the turn goes on, the item waits for the next one and says why.
   */
  it("falls back to the next turn when Codex refuses the steer", async () => {
    const setup = await bootWithCli(steeringCodexAppServer(true), "codex");
    tempDir = setup.tempDir;
    started = setup.started;
    await seedChat(started, setup.workspace, "epic-27", "chat-27");
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    await sendOnChat(streamUrl, {
      epicId: "epic-27",
      chatId: "chat-27",
      clientActionId: "action-27",
      messageId: "msg-user-27",
      text: "start",
      permissionMode: null,
      harnessId: "codex",
    });
    await waitForSnapshot(
      streamUrl,
      "epic-27",
      "chat-27",
      (snapshot) => Reflect.get(snapshot, "activeTurn") !== null,
      80,
      50,
    );
    const queueItemId = await queueFollowUp(
      streamUrl,
      "epic-27",
      "chat-27",
      "msg-user-27b",
      "refused",
      "auto",
    );
    await sendActionUntil(
      streamUrl,
      {
        kind: "queueSteerNow",
        epicId: "epic-27",
        chatId: "chat-27",
        clientActionId: "steer-27",
        queueItemId,
        newSettings: null,
      },
      "eventAppended",
    );
    const fellBack = await waitForSnapshot(
      streamUrl,
      "epic-27",
      "chat-27",
      (snapshot) =>
        readArray(Reflect.get(snapshot, "tail") ?? {}, "events").some(
          (e) => Reflect.get(e ?? {}, "type") === "queue.fallback",
        ),
      80,
      50,
    );
    expect(
      readArray(Reflect.get(fellBack, "tail") ?? {}, "events").find(
        (e) => Reflect.get(e ?? {}, "type") === "queue.fallback",
      ),
    ).toMatchObject({
      queueItemId,
      message: expect.stringContaining("no active turn to steer"),
    });
    // The first turn sealed without a steer block; the item ran after it.
    const frames = await waitForSealedBlocks(
      streamUrl,
      "epic-27",
      "chat-27",
      "text",
      80,
      50,
    );
    const blocks = assistantBlocks(frames, "epic-27", "chat-27");
    expect(blocks.some((block) => Reflect.get(block, "type") === "steer")).toBe(
      false,
    );
    expect(JSON.stringify(blocks)).toContain("first");
  });

  /**
   * A `/compact` turn's card is drawn from the CLI's own records - the
   * status that opens it and the boundary that closes it with the numbers -
   * under the released host's id, so a second compaction in the same session
   * is a second card.
   */
  it("draws a compaction card from the status and boundary records", async () => {
    const stdout = [
      '{"type":"system","subtype":"init","session_id":"sess-compact"}',
      '{"type":"system","subtype":"status","status":"compacting","session_id":"sess-compact"}',
      '{"type":"system","subtype":"status","status":null,"compact_result":"success","session_id":"sess-compact"}',
      '{"type":"system","subtype":"compact_boundary","session_id":"sess-compact","compact_metadata":{"trigger":"manual","pre_tokens":24157,"post_tokens":2118,"duration_ms":4378}}',
      // Recorded live: the compact turn says nothing and counts nothing, and
      // its `result` is still the end of it.
      '{"type":"result","subtype":"success","is_error":false,"num_turns":0,"stop_reason":null,"usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}',
    ];
    const setup = await bootWithCli(
      [
        "#!/bin/sh",
        "read -r prompt",
        ...stdout.map((line) => `printf '%s\n' '${line}'`),
        "",
      ].join("\n"),
      "claude",
    );
    tempDir = setup.tempDir;
    started = setup.started;
    // The hook cannot run under a fake CLI; the test leaves what it would
    // have left, keyed by the session the records name.
    await mkdir(join(tempDir, "snapshots", "pending"), { recursive: true });
    await writeFile(
      join(tempDir, "snapshots", "pending", "compact.sess-compact.json"),
      JSON.stringify({ summary: "three." }),
    );
    await seedChat(started, setup.workspace, "epic-28", "chat-28");
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    await sendOnChat(streamUrl, {
      epicId: "epic-28",
      chatId: "chat-28",
      clientActionId: "action-28",
      messageId: "msg-user-28",
      text: "/compact",
      permissionMode: null,
      harnessId: null,
    });
    const frames = await waitForSealedBlocks(
      streamUrl,
      "epic-28",
      "chat-28",
      "compaction",
      80,
      50,
    );
    const blocks = assistantBlocks(frames, "epic-28", "chat-28");
    const cards = blocks.filter(
      (block) => Reflect.get(block, "type") === "compaction",
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      status: "completed",
      trigger: "manual",
      preTokens: 24157,
      postTokens: 2118,
      durationMs: 4378,
      // The hook's words, on the same card as the boundary's numbers.
      summary: "three.",
    });
    expect(String(Reflect.get(cards[0] ?? {}, "blockId"))).toMatch(
      /^compaction:sess-compact:1:[0-9a-f-]{36}$/u,
    );
    // And the turn ended on that result - completed, not "no output".
    const snapshot = Reflect.get(
      frames.find((f) => Reflect.get(f ?? {}, "kind") === "snapshot") ?? {},
      "snapshot",
    );
    expect(Reflect.get(snapshot, "runStatus")).toBe("idle");
    // The meter reads what the boundary said, not the count of a result
    // that counted nothing.
    expect(
      Reflect.get(
        Reflect.get(snapshot, "derived") ?? {},
        "latestAssistantUsage",
      ),
    ).toMatchObject({
      contextTokens: 2118,
      inputTokens: 2118,
      outputTokens: 0,
    });
    expect(
      readArray(Reflect.get(snapshot, "tail") ?? {}, "events").map((e) =>
        Reflect.get(e ?? {}, "type"),
      ),
    ).toContain("turn.completed");
  });

  /**
   * A command sent to the background outlives the turn, recorded live: the
   * `result` comes while it runs, the CLI keeps going with stdin open, and
   * when the command ends the CLI opens a turn of its own to say so. The
   * host keeps the process, lists the command on the panel, files the CLI's
   * own turn as a turn of the chat, and continues the next send in the same
   * process - the fake would answer a fresh spawn with "started" again.
   */
  it("keeps the process for a background command and takes its own turn", async () => {
    const setup = await bootWithCli(backgroundCli(), "claude");
    tempDir = setup.tempDir;
    started = setup.started;
    await seedChat(started, setup.workspace, "epic-31", "chat-31");
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    await sendOnChat(streamUrl, {
      epicId: "epic-31",
      chatId: "chat-31",
      clientActionId: "action-31",
      messageId: "msg-user-31",
      text: "run it in the background",
      permissionMode: null,
      harnessId: null,
    });
    const items = (snapshot: object) => readArray(snapshot, "backgroundItems");
    const texts = (snapshot: object) =>
      readArray(Reflect.get(snapshot, "tail") ?? {}, "messages")
        .filter((m) => Reflect.get(m ?? {}, "role") === "assistant")
        .map((m) => JSON.stringify(Reflect.get(m ?? {}, "blocks")));
    const starts = (snapshot: object) =>
      readArray(Reflect.get(snapshot, "tail") ?? {}, "events").filter(
        (e) => Reflect.get(e ?? {}, "type") === "turn.started",
      );
    // The turn ended; the command did not.
    const running = await waitForSnapshot(
      streamUrl,
      "epic-31",
      "chat-31",
      (snapshot) =>
        Reflect.get(snapshot, "runStatus") === "idle" &&
        items(snapshot).length === 1,
      80,
      50,
    );
    expect(items(running)).toEqual([
      {
        kind: "command",
        taskId: "bg1",
        title: "sleep 8 && echo done",
        blockId: "toolu_bg1",
        parentTaskId: null,
        scheduledFor: null,
        individualStopUnavailable: null,
      },
    ]);
    expect(texts(running).join("")).toContain("started");
    // A follow-up while it runs continues in the kept process - a fresh
    // spawn of the fake would have answered "started" again.
    await sendOnChat(streamUrl, {
      epicId: "epic-31",
      chatId: "chat-31",
      clientActionId: "action-31b",
      messageId: "msg-user-31b",
      text: "follow up",
      permissionMode: null,
      harnessId: null,
    });
    await waitForChatText(
      streamUrl,
      "epic-31",
      "chat-31",
      "next:follow up",
      80,
      50,
    );
    // The command ended, and the CLI's own turn about it is the chat's -
    // begun by no user message.
    const reported = await waitForSnapshot(
      streamUrl,
      "epic-31",
      "chat-31",
      (snapshot) =>
        Reflect.get(snapshot, "runStatus") === "idle" &&
        items(snapshot).length === 0 &&
        texts(snapshot).join("").includes("bg-done"),
      120,
      50,
    );
    expect(starts(reported)).toHaveLength(3);
    expect(Reflect.get(starts(reported)[2] ?? {}, "messageId")).toBeNull();
  }, 15_000);

  /** The panel's stop on a background command: a `stop_task` the CLI answers by ending it. */
  it("stops a background command through the CLI", async () => {
    const setup = await bootWithCli(backgroundStopCli(), "claude");
    tempDir = setup.tempDir;
    started = setup.started;
    await seedChat(started, setup.workspace, "epic-32", "chat-32");
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    await sendOnChat(streamUrl, {
      epicId: "epic-32",
      chatId: "chat-32",
      clientActionId: "action-32",
      messageId: "msg-user-32",
      text: "run it in the background",
      permissionMode: null,
      harnessId: null,
    });
    await waitForSnapshot(
      streamUrl,
      "epic-32",
      "chat-32",
      (snapshot) =>
        Reflect.get(snapshot, "runStatus") === "idle" &&
        readArray(snapshot, "backgroundItems").length === 1,
      80,
      50,
    );
    expect(
      await sendActionUntil(
        streamUrl,
        {
          kind: "stopBackgroundItem",
          epicId: "epic-32",
          chatId: "chat-32",
          clientActionId: "stop-32-nope",
          taskId: "nope",
        },
        "actionAck",
      ),
    ).toContainEqual(
      expect.objectContaining({
        status: "rejected",
        code: "BACKGROUND_ITEM_NOT_FOUND",
      }),
    );
    const stopped = await sendActionUntil(
      streamUrl,
      {
        kind: "stopBackgroundItem",
        epicId: "epic-32",
        chatId: "chat-32",
        clientActionId: "stop-32",
        taskId: "bg1",
      },
      "turnStateChanged",
    );
    expect(stopped).toContainEqual(
      expect.objectContaining({
        kind: "actionAck",
        action: "stopBackgroundItem",
        status: "accepted",
      }),
    );
    await waitForSnapshot(
      streamUrl,
      "epic-32",
      "chat-32",
      (snapshot) => readArray(snapshot, "backgroundItems").length === 0,
      80,
      50,
    );
    // A stopped task reports no turn of its own, so the kept process has
    // nothing left to say: after the grace it is let go.
    expect(started.runtime.guiRuns.isDetached("chat-32")).toBe(true);
    await new Promise<void>((resolve) => {
      const poll = (): void => {
        if (!started?.runtime.guiRuns.isDetached("chat-32")) {
          resolve();
          return;
        }
        setTimeout(poll, 100);
      };
      poll();
    });
  }, 12_000);

  /** A declined Codex interview answers `{answers: {}}`, as released - not an entry per question. */
  it("declines a Codex request_user_input with an empty answers map", async () => {
    const setup = await bootWithCli(askingCodexAppServer(), "codex");
    tempDir = setup.tempDir;
    started = setup.started;
    await seedChat(started, setup.workspace, "epic-33", "chat-33");
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    await sendOnChat(streamUrl, {
      epicId: "epic-33",
      chatId: "chat-33",
      clientActionId: "action-33",
      messageId: "msg-user-33",
      text: "ask me",
      permissionMode: "full_access",
      harnessId: "codex",
    });
    const asked = await waitForSnapshot(
      streamUrl,
      "epic-33",
      "chat-33",
      (snapshot) => readArray(snapshot, "pendingInterviews").length === 1,
      80,
      50,
    );
    const blockId = String(
      Reflect.get(readArray(asked, "pendingInterviews")[0] ?? {}, "blockId"),
    );
    await sendActionUntil(
      streamUrl,
      {
        kind: "interviewError",
        epicId: "epic-33",
        chatId: "chat-33",
        clientActionId: "dismiss-33",
        blockId,
        reason: "Question dismissed.",
      },
      "actionAck",
    );
    await waitForChatText(
      streamUrl,
      "epic-33",
      "chat-33",
      "declined-ok",
      80,
      50,
    );
  });

  /**
   * The released diff budget: both sides together over 256 KiB is a change
   * described without a diff - `too_large`, no hashes - not a line diff that
   * stalls the host. Each side alone is well under the capture cap.
   */
  it("marks an edit whose two sides exceed the diff budget as too_large", async () => {
    const stdout = [
      '{"type":"system","subtype":"init","session_id":"sess-big"}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_big","name":"Edit","input":{"file_path":"__TARGET__","old_string":"a","new_string":"b"}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"ok","tool_use_id":"toolu_big"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"big-ok"}]}}',
      '{"type":"result","subtype":"success","usage":{"input_tokens":5,"output_tokens":2}}',
    ];
    const setup = await bootWithCli(
      ["#!/bin/sh", "read -r prompt", ...stdout.map(printfLine), ""].join("\n"),
      "claude",
    );
    tempDir = setup.tempDir;
    started = setup.started;
    process.env.TRAYCER_TEST_EDIT_TARGET = join(setup.workspace, "big.txt");
    const bigBefore = `${"x".repeat(1023)}\n`.repeat(150);
    const bigAfter = `${"y".repeat(1023)}\n`.repeat(150);
    await playHook(tempDir, "toolu_big", "pre", bigBefore);
    await playHook(tempDir, "toolu_big", "post", bigAfter);
    await seedChat(started, setup.workspace, "epic-34", "chat-34");
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    await sendOnChat(streamUrl, {
      epicId: "epic-34",
      chatId: "chat-34",
      clientActionId: "action-34",
      messageId: "msg-user-34",
      text: "edit it",
      permissionMode: null,
      harnessId: null,
    });
    const frames = await waitForSealedBlocks(
      streamUrl,
      "epic-34",
      "chat-34",
      "file_change",
      80,
      50,
    );
    const card = assistantBlocks(frames, "epic-34", "chat-34").find(
      (block) => Reflect.get(block, "type") === "file_change",
    );
    expect(card).toMatchObject({
      status: "completed",
      diffSource: "none",
      reason: "too_large",
      beforeHash: null,
      afterHash: null,
      additions: 0,
      deletions: 0,
    });
  });

  /**
   * A relative edit path is relative to the workspace, as released - not to
   * wherever this host process runs. Under `auto_accept_edits` such an edit
   * is inside the workspace and is approved without a question.
   */
  it("reads a relative edit path against the workspace when auto-accepting", async () => {
    const setup = await bootWithCli(
      askingCli(
        "Edit",
        '{"file_path":"rel-note.txt","old_string":"a","new_string":"b"}',
        "Edit rel-note.txt",
      ),
      "claude",
    );
    tempDir = setup.tempDir;
    started = setup.started;
    await seedChat(started, setup.workspace, "epic-35", "chat-35");
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    await sendOnChat(streamUrl, {
      epicId: "epic-35",
      chatId: "chat-35",
      clientActionId: "action-35",
      messageId: "msg-user-35",
      text: "edit it",
      permissionMode: "auto_accept_edits",
      harnessId: null,
    });
    // Allowed by the host itself: the fake got the allow and said so.
    await waitForChatText(
      streamUrl,
      "epic-35",
      "chat-35",
      "allowed-ok",
      80,
      50,
    );
    const frames = await collectChatFrames(streamUrl, "epic-35", "chat-35");
    const snapshot = Reflect.get(
      frames.find((f) => Reflect.get(f ?? {}, "kind") === "snapshot") ?? {},
      "snapshot",
    );
    expect(readArray(snapshot, "pendingFileEditApprovals")).toEqual([]);
  });

  /**
   * An artifact is the agent's to write: an edit to an `index.md` under the
   * epic's artifact root is approved in every mode (the released host's
   * auto-approved edit root), shows as an artifact operation beside the file
   * change, and the turn's checkpoint tags the entry with the artifact.
   */
  it("approves an artifact edit without asking and files it as an artifact operation", async () => {
    const stdout = [
      '{"type":"system","subtype":"init","session_id":"sess-art"}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_art","name":"Edit","input":{"file_path":"__TARGET__","old_string":"a","new_string":"b"}}]}}',
      '{"type":"control_request","request_id":"req-art","request":{"subtype":"can_use_tool","tool_name":"Edit","input":{"file_path":"__TARGET__","old_string":"a","new_string":"b"},"description":"Edit the spec","tool_use_id":"toolu_art"}}',
    ];
    const script = [
      "#!/bin/sh",
      "read -r prompt",
      ...stdout.map(printfLine),
      "read -r answer",
      'case "$answer" in',
      '  *\'"behavior":"allow"\'*)',
      `    printf '%s\\n' '{"type":"user","message":{"content":[{"type":"tool_result","content":"ok","tool_use_id":"toolu_art"}]}}'`,
      `    printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"artifact-ok"}]}}'`,
      "    ;;",
      "  *)",
      `    printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"artifact-denied"}]}}'`,
      "    ;;",
      "esac",
      `printf '%s\\n' '{"type":"result","subtype":"success","usage":{"input_tokens":5,"output_tokens":2}}'`,
      "",
    ].join("\n");
    const setup = await bootWithCli(script, "claude");
    tempDir = setup.tempDir;
    started = setup.started;
    await seedChat(started, setup.workspace, "epic-36", "chat-36");
    const created = (await call(
      started.rpcUrl,
      "epic.createArtifact",
      { major: 1, minor: 0 },
      {
        epicId: "epic-36",
        parentId: null,
        artifactType: "spec",
        title: "Overview",
      },
    )) as { artifactId: string };
    const row = started.runtime.store
      .snapshot()
      .artifacts.find((entry) => entry.artifactId === created.artifactId);
    if (row === undefined) {
      throw new Error("artifact not stored");
    }
    const target = join(
      tempDir,
      "epics",
      "epic-36",
      "artifacts",
      row.folderName,
      "index.md",
    );
    process.env.TRAYCER_TEST_EDIT_TARGET = target;
    const before = await playHook(
      tempDir,
      "toolu_art",
      "pre",
      "# Overview\na\n",
    );
    const after = await playHook(
      tempDir,
      "toolu_art",
      "post",
      "# Overview\nb\n",
    );
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    await sendOnChat(streamUrl, {
      epicId: "epic-36",
      chatId: "chat-36",
      clientActionId: "action-36",
      messageId: "msg-user-36",
      text: "update the spec",
      permissionMode: "supervised",
      harnessId: null,
    });
    // Supervised, and still no question: the fake got the allow and said so.
    await waitForChatText(
      streamUrl,
      "epic-36",
      "chat-36",
      "artifact-ok",
      80,
      50,
    );
    const frames = await waitForSealedBlocks(
      streamUrl,
      "epic-36",
      "chat-36",
      "artifact_operation",
      80,
      50,
    );
    const blocks = assistantBlocks(frames, "epic-36", "chat-36");
    expect(
      blocks.find(
        (block) => Reflect.get(block, "type") === "artifact_operation",
      ),
    ).toMatchObject({
      blockId: `toolu_art:${target}:artifact`,
      operation: "update",
      kind: "spec",
      artifactId: created.artifactId,
      title: "Overview",
      beforeHash: before,
      afterHash: after,
    });
    const snapshot = Reflect.get(
      frames.find((f) => Reflect.get(f ?? {}, "kind") === "snapshot") ?? {},
      "snapshot",
    );
    const captured = readArray(
      Reflect.get(snapshot, "tail") ?? {},
      "events",
    ).find((e) => Reflect.get(e ?? {}, "type") === "checkpoint.captured");
    expect(captured).toMatchObject({
      metadata: {
        entries: [
          {
            filePath: target,
            artifact: {
              artifactId: created.artifactId,
              kind: "spec",
              title: "Overview",
            },
          },
        ],
      },
    });
  });
});

/**
 * A fake CLI that reports the mode it was run in, then asks to leave plan
 * mode with a plan long enough to overflow the card's preview - and stops
 * when refused with the released host's sentence.
 */
function planningCli(): string {
  const plan = `# Add README\\n\\n${"- step: write the readme and check it\\n".repeat(140)}`;
  return [
    "#!/bin/sh",
    "read -r prompt",
    'case "$*" in *"--permission-mode plan"*) mode=mode-plan ;; *) mode=mode-default ;; esac',
    `printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-plan"}'`,
    `printf '%s\n' "{\\"type\\":\\"assistant\\",\\"message\\":{\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"$mode \\"}]}}"`,
    `printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_plan1","name":"ExitPlanMode","input":{"plan":"${plan}"}}]}}'`,
    `printf '%s\n' '{"type":"control_request","request_id":"req-plan","request":{"subtype":"can_use_tool","tool_name":"ExitPlanMode","input":{"plan":"${plan}"},"tool_use_id":"toolu_plan1"}}'`,
    "read -r answer",
    'case "$answer" in',
    '  *"Plan captured and shown to the user as a plan card"*)',
    `    printf '%s\n' '{"type":"user","message":{"content":[{"type":"tool_result","content":"Plan captured","is_error":true,"tool_use_id":"toolu_plan1"}]}}'`,
    `    printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"plan-ready"}]}}'`,
    "    ;;",
    "  *)",
    `    printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"plan-allowed"}]}}'`,
    "    ;;",
    "esac",
    `printf '%s\n' '{"type":"result","subtype":"success","usage":{"input_tokens":5,"output_tokens":2}}'`,
    "",
  ].join("\n");
}

/**
 * A fake Codex app-server that asks the user one question over
 * `item/tool/requestUserInput` and reads the answer by question id.
 */
function askingCodexAppServer(): string {
  return [
    "#!/bin/sh",
    "read -r init",
    `printf '%s\n' '{"id":1,"result":{"userAgent":"fake"}}'`,
    "read -r threadstart",
    `printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread-fake-2"}}}'`,
    "read -r turnstart",
    `printf '%s\n' '{"id":3,"result":{"turn":{"id":"turn-fake-2","status":"inProgress"}}}'`,
    `printf '%s\n' '{"id":9,"method":"item/tool/requestUserInput","params":{"threadId":"thread-fake-2","turnId":"turn-fake-2","itemId":"q-item-1","isBlocking":true,"questions":[{"id":"q1","header":"Color","question":"Which color?","options":[{"label":"Red","description":"r"},{"label":"Blue","description":"b"}]}]}}'`,
    "read -r answer",
    'case "$answer" in',
    '  *\'"q1":{"answers":["Blue"]}\'*)',
    `    printf '%s\n' '{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"msg-2","text":"you chose Blue"},"threadId":"thread-fake-2","turnId":"turn-fake-2"}}'`,
    "    ;;",
    // A declined interview answers nothing per question, as released.
    "  *'\"answers\":{}'*)",
    `    printf '%s\n' '{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"msg-2","text":"declined-ok"},"threadId":"thread-fake-2","turnId":"turn-fake-2"}}'`,
    "    ;;",
    "  *)",
    `    printf '%s\n' '{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"msg-2","text":"no-answer"},"threadId":"thread-fake-2","turnId":"turn-fake-2"}}'`,
    "    ;;",
    "esac",
    `printf '%s\n' '{"method":"turn/completed","params":{"threadId":"thread-fake-2","turn":{"id":"turn-fake-2","status":"completed","error":null}}}'`,
    "read -r eof || true",
    "",
  ].join("\n");
}

/**
 * A fake Codex app-server: answers the three requests this host sends, then
 * announces one file change, asks about it, and applies it only on "accept".
 * Every line is the recorded shape, trimmed to what the host reads.
 */
function fakeCodexAppServer(target: string): string {
  const fc = `{"type":"fileChange","id":"item-fc-1","changes":[{"path":"${target}","kind":{"type":"add"},"diff":"hi\\\\n"}]`;
  return [
    "#!/bin/sh",
    "read -r init",
    `printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"userAgent":"fake"}}'`,
    "read -r threadstart",
    `printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"thread":{"id":"thread-fake-1"}}}'`,
    `printf '%s\n' '{"jsonrpc":"2.0","method":"thread/started","params":{"thread":{"id":"thread-fake-1"}}}'`,
    "read -r turnstart",
    `printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"turn":{"id":"turn-fake-1","status":"inProgress"}}}'`,
    `printf '%s\n' '{"jsonrpc":"2.0","method":"item/started","params":{"item":${fc},"status":"inProgress"},"threadId":"thread-fake-1","turnId":"turn-fake-1"}}'`,
    `printf '%s\n' '{"jsonrpc":"2.0","id":7,"method":"item/fileChange/requestApproval","params":{"threadId":"thread-fake-1","turnId":"turn-fake-1","itemId":"item-fc-1","startedAtMs":1,"reason":null,"grantRoot":null}}'`,
    "read -r answer",
    'case "$answer" in',
    '  *\'"decision":"accept"\'*)',
    `    printf 'hi\\n' > "${target}"`,
    `    printf '%s\n' '{"jsonrpc":"2.0","method":"item/completed","params":{"item":${fc},"status":"completed"},"threadId":"thread-fake-1","turnId":"turn-fake-1"}}'`,
    "    ;;",
    "  *)",
    `    printf '%s\n' '{"jsonrpc":"2.0","method":"item/completed","params":{"item":${fc},"status":"declined"},"threadId":"thread-fake-1","turnId":"turn-fake-1"}}'`,
    "    ;;",
    "esac",
    `printf '%s\n' '{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"itemId":"msg-1","delta":"codex-ok"}}'`,
    `printf '%s\n' '{"jsonrpc":"2.0","method":"item/completed","params":{"item":{"type":"agentMessage","id":"msg-1","text":"codex-ok"},"threadId":"thread-fake-1","turnId":"turn-fake-1"}}'`,
    `printf '%s\n' '{"jsonrpc":"2.0","method":"thread/tokenUsage/updated","params":{"threadId":"thread-fake-1","turnId":"turn-fake-1","tokenUsage":{"total":{"totalTokens":30},"last":{"totalTokens":30,"inputTokens":20,"outputTokens":10},"modelContextWindow":1000}}}'`,
    `printf '%s\n' '{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"thread-fake-1","turn":{"id":"turn-fake-1","status":"completed","error":null}}}'`,
    "read -r eof || true",
    "",
  ].join("\n");
}

/**
 * A fake CLI asking the user a question over the stdio channel, and reading
 * the answer back the way the real one does: as `answers` on its own input.
 */
/**
 * Queue a second send while a turn runs and return its queue item id, read
 * from the `queueChanged` that follows the ack.
 */
async function queueFollowUp(
  url: string,
  epicId: string,
  chatId: string,
  messageId: string,
  text: string,
  deliveryPolicy: "auto" | "after_safe_point",
): Promise<string> {
  const frames = await sendActionUntil(
    url,
    {
      kind: "send",
      epicId,
      chatId,
      clientActionId: `${messageId}-action`,
      messageId,
      content: promptDoc(text),
      sender: { type: "user", userId: "local" },
      settings: null,
      accountContext: { type: "PERSONAL" },
      deliveryPolicy,
      worktreeIntent: null,
    },
    "queueChanged",
  );
  const changed = frames.find(
    (f) => Reflect.get(f ?? {}, "kind") === "queueChanged",
  );
  const item = readArray(
    Reflect.get(changed ?? {}, "queue") ?? {},
    "items",
  ).find((row) => Reflect.get(row ?? {}, "messageId") === messageId);
  const queueItemId = Reflect.get(item ?? {}, "queueItemId");
  if (typeof queueItemId !== "string") {
    throw new Error(
      `follow-up was not queued: ${JSON.stringify(frames).slice(0, 400)}`,
    );
  }
  return queueItemId;
}

/**
 * A fake Claude that blocks on a second stdin record mid-turn, the way the
 * real one waits at a tool boundary, and answers with that record's text.
 */
/** The records of a backgrounded Bash, as recorded live, with the CLI's own turn after it. */
function backgroundRecords(): readonly string[] {
  return [
    '{"type":"system","subtype":"init","session_id":"sess-bg"}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_bg1","name":"Bash","input":{"command":"sleep 8 && echo done","run_in_background":true}}]}}',
    '{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"bg1","task_type":"local_bash","description":"sleep 8 && echo done"}],"session_id":"sess-bg"}',
    '{"type":"system","subtype":"task_started","task_id":"bg1","tool_use_id":"toolu_bg1","description":"sleep 8 && echo done","is_backgrounded":true,"task_type":"local_bash","session_id":"sess-bg"}',
    '{"type":"user","message":{"content":[{"type":"tool_result","content":"Command running in background with ID: bg1","tool_use_id":"toolu_bg1"}]}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"started"}]}}',
    '{"type":"result","subtype":"success","usage":{"input_tokens":5,"output_tokens":2}}',
  ];
}

function backgroundCli(): string {
  return [
    "#!/bin/sh",
    "read -r prompt",
    ...backgroundRecords().map(printfLine),
    // The command "runs" until the next user record arrives - a follow-up
    // sent while it runs continues in this same process.
    "read -r next",
    `text=$(printf '%s' "$next" | sed -e 's/.*"text":"\\([^"]*\\)".*/\\1/')`,
    `printf '%s\\n' "{\\"type\\":\\"assistant\\",\\"message\\":{\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"next:$text\\"}]}}"`,
    `printf '%s\\n' '{"type":"result","subtype":"success","usage":{"input_tokens":5,"output_tokens":2}}'`,
    "sleep 1",
    `printf '%s\\n' '{"type":"system","subtype":"background_tasks_changed","tasks":[],"session_id":"sess-bg"}'`,
    `printf '%s\\n' '{"type":"system","subtype":"task_updated","task_id":"bg1","patch":{"status":"completed","end_time":1}}'`,
    `printf '%s\\n' '{"type":"system","subtype":"task_notification","task_id":"bg1","tool_use_id":"toolu_bg1","status":"completed","output_file":"","summary":"Background command completed (exit code 0)"}'`,
    `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"sess-bg"}'`,
    `printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"bg-done"}]}}'`,
    `printf '%s\\n' '{"type":"result","subtype":"success","num_turns":1,"usage":{"input_tokens":3,"output_tokens":1}}'`,
    "read -r eof || true",
    "",
  ].join("\n");
}

/** The same, but the command runs until a `stop_task` arrives, as recorded live. */
function backgroundStopCli(): string {
  return [
    "#!/bin/sh",
    "read -r prompt",
    ...backgroundRecords().map(printfLine),
    "read -r ctl",
    'case "$ctl" in *stop_task*) ;; *) exit 3;; esac',
    `printf '%s\\n' '{"type":"system","subtype":"background_tasks_changed","tasks":[],"session_id":"sess-bg"}'`,
    `printf '%s\\n' '{"type":"system","subtype":"task_updated","task_id":"bg1","patch":{"status":"killed","end_time":1}}'`,
    `printf '%s\\n' '{"type":"system","subtype":"task_notification","task_id":"bg1","tool_use_id":"toolu_bg1","status":"stopped","output_file":"","summary":"sleep 8 && echo done"}'`,
    `printf '%s\\n' "{\\"type\\":\\"control_response\\",\\"response\\":{\\"subtype\\":\\"success\\",\\"request_id\\":\\"x\\",\\"response\\":{}}}"`,
    "read -r eof || true",
    "",
  ].join("\n");
}

function steeringCli(): string {
  return [
    "#!/bin/sh",
    "read -r prompt",
    `printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-steer"}'`,
    `printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"first "}]}}'`,
    "read -r steer",
    `text=$(printf '%s' "$steer" | sed -e 's/.*"text":"\\([^"]*\\)".*/\\1/')`,
    `printf '%s\n' "{\\"type\\":\\"assistant\\",\\"message\\":{\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"steered:$text\\"}]}}"`,
    `printf '%s\n' '{"type":"result","subtype":"success","usage":{"input_tokens":5,"output_tokens":2}}'`,
    "",
  ].join("\n");
}

/**
 * A fake Codex app-server that waits for a `turn/steer` mid-turn and either
 * takes it (speaking its text and the turn id it quoted) or refuses it with
 * the real server's error, then finishes the turn either way.
 */
function steeringCodexAppServer(refuse: boolean): string {
  return [
    "#!/bin/sh",
    "read -r init",
    `printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"userAgent":"fake"}}'`,
    "read -r threadstart",
    `printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"thread":{"id":"thread-fake-1"}}}'`,
    "read -r turnstart",
    `printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"turn":{"id":"turn-fake-1","status":"inProgress"}}}'`,
    `printf '%s\n' '{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"itemId":"msg-1","delta":"first "}}'`,
    "read -r steer",
    `text=$(printf '%s' "$steer" | sed -e 's/.*"text":"\\([^"]*\\)".*/\\1/')`,
    `expected=$(printf '%s' "$steer" | sed -e 's/.*"expectedTurnId":"\\([^"]*\\)".*/\\1/')`,
    refuse
      ? `printf '%s\n' '{"id":4,"error":{"code":-32600,"message":"no active turn to steer"}}'`
      : `printf '%s\n' '{"id":4,"result":{"turnId":"turn-fake-1"}}'`,
    refuse
      ? "true"
      : `printf '%s\n' "{\\"method\\":\\"item/agentMessage/delta\\",\\"params\\":{\\"itemId\\":\\"msg-1\\",\\"delta\\":\\"steered:$expected:$text\\"}}"`,
    `printf '%s\n' '{"jsonrpc":"2.0","method":"item/completed","params":{"item":{"type":"agentMessage","id":"msg-1","text":"first"},"threadId":"thread-fake-1","turnId":"turn-fake-1"}}'`,
    `printf '%s\n' '{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"thread-fake-1","turn":{"id":"turn-fake-1","status":"completed","error":null}}}'`,
    "read -r eof || true",
    "",
  ].join("\n");
}

function askingInterviewCli(): string {
  const input =
    '{"questions":[{"question":"Which color?","header":"Color","options":[{"label":"Red"},{"label":"Blue","description":"The color blue"}],"multiSelect":false}]}';
  return [
    "#!/bin/sh",
    "read -r prompt",
    `printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-ask"}'`,
    `printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_q1","name":"AskUserQuestion","input":${input}}]}}'`,
    `printf '%s\n' '{"type":"control_request","request_id":"req-1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":${input},"description":"Which color?","tool_use_id":"toolu_q1","requires_user_interaction":true}}'`,
    "read -r answer",
    'case "$answer" in',
    '  *\'"answers":{"Which color?":"Blue"}\'*)',
    `    printf '%s\n' '{"type":"user","message":{"content":[{"type":"tool_result","content":"The user answered: Which color?=Blue","tool_use_id":"toolu_q1"}]}}'`,
    `    printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"you chose Blue"}]}}'`,
    "    ;;",
    "  *)",
    `    printf '%s\n' '{"type":"user","message":{"content":[{"type":"tool_result","content":"no answer","is_error":true,"tool_use_id":"toolu_q1"}]}}'`,
    `    printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"no-answer"}]}}'`,
    "    ;;",
    "esac",
    `printf '%s\n' '{"type":"result","subtype":"success","usage":{"input_tokens":5,"output_tokens":2}}'`,
    "",
  ].join("\n");
}

/**
 * A fake CLI that speaks the stdio permission channel the way the real one
 * does: the prompt arrives on stdin, the question goes out with the call's
 * id, and the answer decides whether the tool "ran".
 */
function askingCli(
  toolName: string,
  inputJson: string,
  description: string,
): string {
  return [
    "#!/bin/sh",
    "read -r prompt",
    `printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-perm"}'`,
    `printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_q1","name":"${toolName}","input":${inputJson}}]}}'`,
    `printf '%s\n' '{"type":"control_request","request_id":"req-1","request":{"subtype":"can_use_tool","tool_name":"${toolName}","input":${inputJson},"description":"${description}","tool_use_id":"toolu_q1"}}'`,
    "read -r answer",
    'case "$answer" in',
    '  *\'"behavior":"allow"\'*)',
    `    printf '%s\n' '{"type":"user","message":{"content":[{"type":"tool_result","content":"ok","tool_use_id":"toolu_q1"}]}}'`,
    `    printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"allowed-ok"}]}}'`,
    "    ;;",
    "  *)",
    `    reason=$(printf '%s' "$answer" | sed -e 's/.*"message":"\\([^"]*\\)".*/\\1/')`,
    `    printf '%s\n' "{\\"type\\":\\"user\\",\\"message\\":{\\"content\\":[{\\"type\\":\\"tool_result\\",\\"content\\":\\"$reason\\",\\"is_error\\":true,\\"tool_use_id\\":\\"toolu_q1\\"}]}}"`,
    `    printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"denied-ok"}]}}'`,
    "    ;;",
    "esac",
    `printf '%s\n' '{"type":"result","subtype":"success","usage":{"input_tokens":5,"output_tokens":2}}'`,
    "",
  ].join("\n");
}

/** Poll fresh subscribes until the snapshot satisfies `ready`; returns it. */
async function waitForSnapshot(
  url: string,
  epicId: string,
  chatId: string,
  ready: (snapshot: object) => boolean,
  attempts: number,
  delayMs: number,
): Promise<object> {
  let last: object = {};
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const frames = await collectChatFrames(url, epicId, chatId);
    const frame = frames.find(
      (f) => Reflect.get(f ?? {}, "kind") === "snapshot",
    );
    const snapshot = Reflect.get(frame ?? {}, "snapshot");
    if (snapshot !== null && typeof snapshot === "object") {
      last = snapshot;
      if (ready(snapshot)) {
        return snapshot;
      }
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }
  throw new Error(
    `snapshot never became ready: ${JSON.stringify(last).slice(0, 400)}`,
  );
}

function readArray(record: object, key: string): readonly unknown[] {
  const value = Reflect.get(record, key);
  return Array.isArray(value) ? value : [];
}

/**
 * What one hook invocation leaves behind, written by hand: the body in the
 * blob store and the sidecar the host settles the call from.
 */
/**
 * One stdout line of a fake CLI. A line naming `__TARGET__` is printed
 * double-quoted so the shell fills the edit target in from the environment
 * (`TRAYCER_TEST_EDIT_TARGET`), which the test sets once it knows the
 * workspace; every other line is printed as it is.
 */
function printfLine(line: string): string {
  if (!line.includes("__TARGET__")) {
    return `printf '%s\n' '${line}'`;
  }
  const quoted = line
    .replaceAll('"', '\\"')
    .replaceAll("__TARGET__", "$TRAYCER_TEST_EDIT_TARGET");
  return `printf '%s\n' "${quoted}"`;
}

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

/**
 * The summaries of the LAST `accumulatedChanges` frame in a collection.
 *
 * Not summed across frames: a collect window can overlap a live rebroadcast
 * - every snapshot resend carries the whole set again - and summing then
 * counts each row once per frame. Each frame is the complete set, and the
 * last one is the current one.
 */
function latestSummaries(
  frames: readonly unknown[],
  epicId: string,
  chatId: string,
): readonly unknown[] {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (
      frame !== null &&
      typeof frame === "object" &&
      Reflect.get(frame, "kind") === "accumulatedChanges" &&
      Reflect.get(frame, "epicId") === epicId &&
      Reflect.get(frame, "chatId") === chatId
    ) {
      return readSummaries(frame, epicId, chatId);
    }
  }
  return [];
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
  return bootWithCli("#!/bin/sh\nprintf 'assistant-ok\\n'\n", "claude");
}

async function bootWithCli(
  script: string,
  harness: "claude" | "codex",
): Promise<Booted> {
  const tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
  const binDir = join(tempDir, "bin");
  await mkdir(binDir);
  const claudePath = join(binDir, harness);
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
      providerId: harness === "claude" ? "claude-code" : "codex",
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
    /** Null is the tests' default, `full_access`. */
    readonly permissionMode: string | null;
    /** Null is the tests' default, `claude`. */
    readonly harnessId: string | null;
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
              harnessId: input.harnessId ?? "claude",
              model: "default",
              permissionMode: input.permissionMode ?? "full_access",
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
