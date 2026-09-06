import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
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
import { startHost, type StartedHost } from "../start-host";

describe("epic and workspace RPCs", () => {
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

  it("prepares the home dir and round-trips an epic", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    const home = await call(started.rpcUrl, "workspace.prepareFolders", {
      major: 1,
      minor: 4,
    }, {
      operation: "getHomeDir",
      folderPaths: null,
      path: null,
      bumpRecency: null,
    });
    expect(home).toMatchObject({
      operation: "getHomeDir",
      homeDir: expect.any(String),
    });

    const workspace = join(tempDir, "proj");
    await mkdir(workspace);
    await writeFile(join(workspace, "README.md"), "hello\n");
    const canonical = await realpath(workspace);
    const prepared = await call(started.rpcUrl, "workspace.prepareFolders", {
      major: 1,
      minor: 4,
    }, {
      operation: "prepare",
      folderPaths: [workspace],
      path: null,
      bumpRecency: true,
    });
    expect(prepared).toMatchObject({
      operation: "prepare",
      folders: [{ workspacePath: canonical, workspaceName: "proj" }],
    });

    const created = await call(started.rpcUrl, "epic.create", { major: 1, minor: 0 }, {
      epic: {
        id: "epic-1",
        title: "First task",
        initialUserPrompt: "do the thing",
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
        chatId: "chat-1",
        parentId: null,
        hostId: started.runtime.hostId,
        title: "Chat",
        worktreeIntent: null,
        initialMessage: null,
      },
    });
    expect(created).toMatchObject({
      roomInfo: null,
      task: { epic: { light: { id: "epic-1", title: "First task" } } },
    });

    const listed = await call(started.rpcUrl, "epic.listTasks", { major: 1, minor: 3 }, {
      limit: 20,
      filters: null,
      extensionPhaseVersion: "1.0.0",
      extensionEpicVersion: "2.0.0",
    });
    expect(listed).toMatchObject({
      hasMore: false,
      tasks: [{ epic: { light: { id: "epic-1" } } }],
    });

    const tree = await call(started.rpcUrl, "workspace.listDirectory", {
      major: 1,
      minor: 0,
    }, {
      workspacePath: workspace,
      directoryPath: ".",
    });
    expect(tree).toMatchObject({
      workspacePath: workspace,
      entries: expect.arrayContaining([
        expect.objectContaining({ name: "README.md", kind: "file" }),
      ]),
    });

    const binding = await call(started.rpcUrl, "worktree.getBinding", {
      major: 1,
      minor: 0,
    }, {
      epicId: "epic-1",
      ownerId: "chat-1",
      ownerKind: "chat",
    });
    expect(binding).toMatchObject({
      binding: {
        entries: [expect.objectContaining({ workspacePath: canonical, mode: "local" })],
      },
    });

    const renamed = await call(started.rpcUrl, "epic.renameChat", {
      major: 1,
      minor: 0,
    }, { epicId: "epic-1", chatId: "chat-1", title: "Renamed chat" });
    expect(renamed).toEqual({ updated: true });
    const records = await call(started.rpcUrl, "epic.listChatRecords", {
      major: 1,
      minor: 0,
    }, { epicId: "epic-1" });
    expect(records).toMatchObject({
      chats: [expect.objectContaining({ chatId: "chat-1", title: "Renamed chat" })],
    });
    const deleted = await call(started.rpcUrl, "epic.deleteChat", {
      major: 1,
      minor: 0,
    }, { epicId: "epic-1", chatId: "chat-1" });
    expect(deleted).toEqual({ deleted: true });
  });

  it("projects an untitled epic from the prompt and persists chat run settings", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    const workspace = join(tempDir, "proj");
    await mkdir(workspace);
    await writeFile(join(workspace, "README.md"), "hello\n");
    const canonical = await realpath(workspace);
    await call(started.rpcUrl, "epic.create", { major: 1, minor: 0 }, {
      epic: {
        id: "epic-2",
        title: "",
        initialUserPrompt: "你是啥大模型",
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
      workspaces: [{ workspacePath: canonical }],
      chat: {
        chatId: "chat-2",
        parentId: null,
        hostId: started.runtime.hostId,
        title: "",
        worktreeIntent: null,
        initialMessage: null,
      },
    });
    const listed = await call(started.rpcUrl, "epic.listTasks", { major: 1, minor: 3 }, {
      limit: 20,
      filters: null,
      extensionPhaseVersion: "1.0.0",
      extensionEpicVersion: "2.0.0",
    });
    expect(listed).toMatchObject({
      tasks: [{ epic: { light: { id: "epic-2", title: "你是啥大模型" } } }],
    });
    const updated = await call(
      started.rpcUrl,
      "epic.updateChatRunSettings",
      { major: 1, minor: 1 },
      {
        epicId: "epic-2",
        chatId: "chat-2",
        settings: {
          harnessId: "codex",
          model: "default",
          permissionMode: "full_access",
          reasoningEffort: null,
          serviceTier: null,
          agentMode: "regular",
          profileId: null,
        },
      },
    );
    expect(updated).toEqual({ updated: true });
    const settings = await call(
      started.rpcUrl,
      "epic.getChatRunSettings",
      { major: 2, minor: 0 },
      { epicId: "epic-2", chatId: "chat-2" },
    );
    expect(settings).toMatchObject({
      settings: { harnessId: "codex", model: "default" },
    });
  });
});

async function call(
  url: string,
  method: string,
  schemaVersion: { major: number; minor: number },
  params: unknown,
): Promise<unknown> {
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
      token: "test-token",
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
  if (record.error !== null) {
    throw new Error(`RPC error: ${JSON.stringify(record.error)}`);
  }
  return record.result;
}
