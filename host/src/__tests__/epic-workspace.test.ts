import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import {
  CURRENT_CLIENT_COMPATIBILITY_EPOCH,
  SERVES_EVERY_INSTALLED_MAJOR,
  splitConnectionManifest,
} from "@traycer/protocol/framework/index";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { artifactBodyFragmentName } from "@traycer/protocol/persistence/epic/artifacts";
import { xmlFragmentToMarkdown } from "../epic/artifact-body";
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
    const home = await call(
      started.rpcUrl,
      "workspace.prepareFolders",
      {
        major: 1,
        minor: 4,
      },
      {
        operation: "getHomeDir",
        folderPaths: null,
        path: null,
        bumpRecency: null,
      },
    );
    expect(home).toMatchObject({
      operation: "getHomeDir",
      homeDir: expect.any(String),
    });

    const workspace = join(tempDir, "proj");
    await mkdir(workspace);
    await writeFile(join(workspace, "README.md"), "hello\n");
    const canonical = await realpath(workspace);
    const prepared = await call(
      started.rpcUrl,
      "workspace.prepareFolders",
      {
        major: 1,
        minor: 4,
      },
      {
        operation: "prepare",
        folderPaths: [workspace],
        path: null,
        bumpRecency: true,
      },
    );
    expect(prepared).toMatchObject({
      operation: "prepare",
      folders: [{ workspacePath: canonical, workspaceName: "proj" }],
    });

    const created = await call(
      started.rpcUrl,
      "epic.create",
      { major: 1, minor: 0 },
      {
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
      },
    );
    expect(created).toMatchObject({
      roomInfo: null,
      task: { epic: { light: { id: "epic-1", title: "First task" } } },
    });

    const listed = await call(
      started.rpcUrl,
      "epic.listTasks",
      { major: 1, minor: 3 },
      {
        limit: 20,
        filters: null,
        extensionPhaseVersion: "1.0.0",
        extensionEpicVersion: "2.0.0",
      },
    );
    expect(listed).toMatchObject({
      hasMore: false,
      tasks: [{ epic: { light: { id: "epic-1" } } }],
    });

    const tree = await call(
      started.rpcUrl,
      "workspace.listDirectory",
      {
        major: 1,
        minor: 0,
      },
      {
        workspacePath: workspace,
        directoryPath: ".",
      },
    );
    expect(tree).toMatchObject({
      workspacePath: workspace,
      entries: expect.arrayContaining([
        expect.objectContaining({ name: "README.md", kind: "file" }),
      ]),
    });

    const binding = await call(
      started.rpcUrl,
      "worktree.getBinding",
      {
        major: 1,
        minor: 0,
      },
      {
        epicId: "epic-1",
        ownerId: "chat-1",
        ownerKind: "chat",
      },
    );
    expect(binding).toMatchObject({
      binding: {
        entries: [
          expect.objectContaining({ workspacePath: canonical, mode: "local" }),
        ],
      },
    });

    const renamed = await call(
      started.rpcUrl,
      "epic.renameChat",
      {
        major: 1,
        minor: 0,
      },
      { epicId: "epic-1", chatId: "chat-1", title: "Renamed chat" },
    );
    expect(renamed).toEqual({ updated: true });
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
        expect.objectContaining({ chatId: "chat-1", title: "Renamed chat" }),
      ],
    });
    const deleted = await call(
      started.rpcUrl,
      "epic.deleteChat",
      {
        major: 1,
        minor: 0,
      },
      { epicId: "epic-1", chatId: "chat-1" },
    );
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
    await call(
      started.rpcUrl,
      "epic.create",
      { major: 1, minor: 0 },
      {
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
      },
    );
    const listed = await call(
      started.rpcUrl,
      "epic.listTasks",
      { major: 1, minor: 3 },
      {
        limit: 20,
        filters: null,
        extensionPhaseVersion: "1.0.0",
        extensionEpicVersion: "2.0.0",
      },
    );
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

  it("round-trips local artifacts, mentions, and comment threads", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    await call(
      started.rpcUrl,
      "epic.create",
      { major: 1, minor: 0 },
      {
        epic: {
          id: "epic-art",
          title: "Artifact epic",
          initialUserPrompt: "plan it",
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
        workspaces: [],
        chat: null,
      },
    );
    const created = (await call(
      started.rpcUrl,
      "epic.createArtifact",
      { major: 1, minor: 0 },
      {
        epicId: "epic-art",
        parentId: null,
        artifactType: "spec",
        title: "Overview",
      },
    )) as { artifactId: string };
    expect(created.artifactId.length).toBeGreaterThan(0);
    const mentions = await call(
      started.rpcUrl,
      "epic.mentionSpecs",
      { major: 1, minor: 0 },
      { query: "over", limit: 10 },
    );
    expect(mentions).toMatchObject({
      entries: [
        expect.objectContaining({
          kind: "epic-artifact",
          artifactType: "spec",
          artifactId: created.artifactId,
          label: "Overview",
        }),
      ],
    });
    const resolved = await call(
      started.rpcUrl,
      "epic.resolveArtifactByPath",
      { major: 1, minor: 0 },
      {
        epicId: "epic-art",
        filePath: `${tempDir}/epics/epic-art/artifacts/overview/index.md`,
      },
    );
    expect(resolved).toEqual({
      artifact: { artifactId: created.artifactId, kind: "spec" },
    });
    const renamed = await call(
      started.rpcUrl,
      "epic.renameArtifact",
      { major: 1, minor: 0 },
      {
        epicId: "epic-art",
        artifactId: created.artifactId,
        title: "Project overview",
      },
    );
    expect(renamed).toEqual({ updated: true });
    const comment = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "looks good" }],
        },
      ],
    };
    const thread = (await call(
      started.rpcUrl,
      "epic.createCommentThread",
      { major: 1, minor: 0 },
      {
        epicId: "epic-art",
        artifactType: "spec",
        artifactId: created.artifactId,
        content: comment,
        quotedText: "Overview",
      },
    )) as { threadId: string };
    const listed = await call(
      started.rpcUrl,
      "epic.listCommentThreads",
      { major: 1, minor: 0 },
      {
        epicId: "epic-art",
        artifactType: "spec",
        artifactId: created.artifactId,
      },
    );
    expect(listed).toMatchObject({
      threads: [
        expect.objectContaining({
          threadId: thread.threadId,
          resolved: false,
          data: expect.objectContaining({ quotedText: "Overview" }),
        }),
      ],
    });
    const commentsListed = await call(
      started.rpcUrl,
      "comments.listThreads",
      { major: 1, minor: 0 },
      {
        epicId: "epic-art",
        artifactPaths: ["artifacts/overview/index.md"],
        status: "all",
      },
    );
    expect(commentsListed).toMatchObject({
      artifacts: [
        expect.objectContaining({
          artifactPath: "artifacts/overview/index.md",
          kind: "spec",
          title: "Project overview",
        }),
      ],
    });
    const resolvedThread = await call(
      started.rpcUrl,
      "comments.setThreadStatus",
      { major: 1, minor: 0 },
      {
        epicId: "epic-art",
        updates: [
          {
            artifactPath: "artifacts/overview/index.md",
            threadIds: [thread.threadId],
            status: "resolved",
          },
        ],
      },
    );
    expect(resolvedThread).toMatchObject({
      updated: [
        {
          artifactPath: "artifacts/overview/index.md",
          threadId: thread.threadId,
          status: "resolved",
        },
      ],
      failed: [],
    });
    const deleted = await call(
      started.rpcUrl,
      "epic.deleteArtifact",
      { major: 1, minor: 0 },
      { epicId: "epic-art", artifactId: created.artifactId },
    );
    expect(deleted).toEqual({ deleted: true });
    const emptyMentions = await call(
      started.rpcUrl,
      "epic.mentionSpecs",
      { major: 1, minor: 0 },
      { query: "", limit: 10 },
    );
    expect(emptyMentions).toEqual({ entries: [] });
  });

  it("seeds artifacts into epic.subscribe and emits dirtySnapshot", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    await call(
      started.rpcUrl,
      "epic.create",
      { major: 1, minor: 0 },
      {
        epic: {
          id: "epic-y",
          title: "Yjs epic",
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
        workspaces: [],
        chat: null,
      },
    );
    const created = (await call(
      started.rpcUrl,
      "epic.createArtifact",
      { major: 1, minor: 0 },
      {
        epicId: "epic-y",
        parentId: null,
        artifactType: "ticket",
        title: "First ticket",
      },
    )) as { artifactId: string };
    const migrated = await call(
      started.rpcUrl,
      "phase.migrateToEpic",
      { major: 1, minor: 0 },
      { phaseId: "epic-y" },
    );
    expect(migrated).toEqual({ epicId: "epic-y" });
    const frames = await subscribeEpic(started.rpcUrl, "epic-y");
    const snapshot = frames.find(
      (frame) => frame.kind === "snapshot" && frame.binary !== null,
    );
    expect(snapshot).toBeDefined();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, snapshot?.binary ?? new Uint8Array());
    const artifacts = doc.getMap("epic").get("artifacts");
    expect(artifacts instanceof Y.Map).toBe(true);
    const entry =
      artifacts instanceof Y.Map ? artifacts.get(created.artifactId) : null;
    expect(entry instanceof Y.Map).toBe(true);
    if (entry instanceof Y.Map) {
      expect(entry.get("kind")).toBe("ticket");
      expect(entry.get("title")).toBe("First ticket");
      expect(typeof entry.get("artifactRoomId")).toBe("string");
    }
    expect(
      frames.some(
        (frame) => frame.kind === "dirtySnapshot" && frame.rootDirty === false,
      ),
    ).toBe(true);
    expect(frames.some((frame) => frame.kind === "artifactRoomState")).toBe(
      true,
    );
  });

  it("nests child artifact folders on disk and resolves the chain", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    await call(
      started.rpcUrl,
      "epic.create",
      { major: 1, minor: 0 },
      {
        epic: {
          id: "epic-nest",
          title: "Nested",
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
        workspaces: [],
        chat: null,
      },
    );
    const parent = (await call(
      started.rpcUrl,
      "epic.createArtifact",
      { major: 1, minor: 0 },
      {
        epicId: "epic-nest",
        parentId: null,
        artifactType: "ticket",
        title: "Ticket breakdown",
      },
    )) as { artifactId: string };
    const child = (await call(
      started.rpcUrl,
      "epic.createArtifact",
      { major: 1, minor: 0 },
      {
        epicId: "epic-nest",
        parentId: parent.artifactId,
        artifactType: "ticket",
        title: "Something",
      },
    )) as { artifactId: string };
    const nestedPath = join(
      tempDir,
      "epics",
      "epic-nest",
      "artifacts",
      "ticket-breakdown",
      "something",
      "index.md",
    );
    expect(await readFile(nestedPath, "utf8")).toContain("kind: ticket");
    const resolved = await call(
      started.rpcUrl,
      "epic.resolveArtifactByPath",
      { major: 1, minor: 0 },
      { epicId: "epic-nest", filePath: nestedPath },
    );
    expect(resolved).toEqual({
      artifact: { artifactId: child.artifactId, kind: "ticket" },
    });
    const reparented = await call(
      started.rpcUrl,
      "epic.reparentArtifact",
      { major: 1, minor: 0 },
      {
        epicId: "epic-nest",
        artifactId: child.artifactId,
        newParentId: null,
      },
    );
    expect(reparented).toEqual({ updated: true });
    const rootPath = join(
      tempDir,
      "epics",
      "epic-nest",
      "artifacts",
      "something",
      "index.md",
    );
    expect(await readFile(rootPath, "utf8")).toContain("kind: ticket");
  });

  it("loads index.md into the artifact room and writes a room update back", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    await call(
      started.rpcUrl,
      "epic.create",
      { major: 1, minor: 0 },
      {
        epic: {
          id: "epic-body",
          title: "Body epic",
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
        workspaces: [],
        chat: null,
      },
    );
    const created = (await call(
      started.rpcUrl,
      "epic.createArtifact",
      { major: 1, minor: 0 },
      {
        epicId: "epic-body",
        parentId: null,
        artifactType: "spec",
        title: "Live spec",
      },
    )) as { artifactId: string };
    const indexPath = join(
      tempDir,
      "epics",
      "epic-body",
      "artifacts",
      "live-spec",
      "index.md",
    );
    await writeFile(
      indexPath,
      `---\ntitle: "Live spec"\nkind: spec\n---\n\nOSS body\n`,
      "utf8",
    );
    const frames = await subscribeEpic(started.rpcUrl, "epic-body");
    const roomSnapshot = frames.find(
      (frame) => frame.kind === "artifactRoomSnapshot" && frame.binary !== null,
    );
    expect(roomSnapshot?.binary).toBeDefined();
    const room = new Y.Doc();
    Y.applyUpdate(room, roomSnapshot?.binary ?? new Uint8Array());
    const fragment = room.getXmlFragment(
      artifactBodyFragmentName(created.artifactId),
    );
    expect(xmlFragmentToMarkdown(fragment)).toBe("OSS body");
    const paragraph = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    text.insert(0, "Edited locally");
    paragraph.insert(0, [text]);
    fragment.insert(fragment.length, [paragraph]);
    const seeded = new Y.Doc();
    Y.applyUpdate(seeded, roomSnapshot?.binary ?? new Uint8Array());
    const before = Y.encodeStateVector(seeded);
    seeded.destroy();
    const update = Y.encodeStateAsUpdate(room, before);
    const root = new Y.Doc();
    const rootSnapshot = frames.find(
      (frame) => frame.kind === "snapshot" && frame.binary !== null,
    );
    Y.applyUpdate(root, rootSnapshot?.binary ?? new Uint8Array());
    const artifacts = root.getMap("epic").get("artifacts");
    const entry =
      artifacts instanceof Y.Map ? artifacts.get(created.artifactId) : null;
    const roomId = entry instanceof Y.Map ? entry.get("artifactRoomId") : null;
    expect(typeof roomId).toBe("string");
    if (typeof roomId !== "string") {
      return;
    }
    started.runtime.epics.applyRoomUpdate(
      started.runtime,
      "epic-body",
      roomId,
      update,
    );
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 50);
    });
    const written = await readFile(indexPath, "utf8");
    expect(written).toContain("OSS body");
    expect(written).toContain("Edited locally");
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

async function subscribeEpic(
  rpcUrl: string,
  epicId: string,
): Promise<
  readonly {
    readonly kind: string;
    readonly rootDirty?: boolean;
    readonly binary: Uint8Array | null;
  }[]
> {
  const streamUrl = rpcUrl.replace(/\/rpc$/u, "/stream");
  const socket = new WebSocket(streamUrl);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const frames: {
    kind: string;
    rootDirty?: boolean;
    binary: Uint8Array | null;
  }[] = [];
  let pending: (typeof frames)[number] | null = null;
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
    }, 2_000);
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        if (pending !== null) {
          pending.binary = new Uint8Array(
            Buffer.isBuffer(data) ? data : Buffer.from(String(data)),
          );
          pending = null;
        }
        if (frames.some((frame) => frame.kind === "dirtySnapshot")) {
          clearTimeout(timer);
          socket.close();
        }
        return;
      }
      const parsed: unknown = JSON.parse(String(data));
      if (parsed === null || typeof parsed !== "object") {
        return;
      }
      const kind = Reflect.get(parsed, "kind");
      if (typeof kind !== "string") {
        return;
      }
      if (kind === "openAck") {
        socket.send(
          JSON.stringify({
            kind: "subscribe",
            method: "epic.subscribe",
            schemaVersion: { major: 1, minor: 3 },
            params: { epicId },
          }),
        );
        return;
      }
      const frame = {
        kind,
        rootDirty: Reflect.get(parsed, "rootDirty") === true ? true : false,
        binary: null as Uint8Array | null,
      };
      frames.push(frame);
      if (Reflect.get(parsed, "hasBinaryPayload") === true) {
        pending = frame;
      } else if (kind === "dirtySnapshot") {
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
      token: "test-token",
      manifest: buildStreamManifest(
        hostStreamRpcRegistry,
        SERVES_EVERY_INSTALLED_MAJOR,
      ),
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
