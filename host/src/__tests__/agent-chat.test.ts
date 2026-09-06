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

describe("agent create/send and chat.subscribe", () => {
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

  it("creates an agent, records a send, and snapshots it on chat.subscribe", async () => {
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
        id: "epic-1",
        title: "Agent path",
        initialUserPrompt: "go",
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
        chatId: "chat-1",
        parentId: null,
        hostId: started.runtime.hostId,
        title: "Root",
        worktreeIntent: null,
        initialMessage: null,
      },
    });

    const created = await call(started.rpcUrl, "agent.create", {
      major: 3,
      minor: 0,
    }, {
      senderAgentId: "chat-1",
      epicId: "epic-1",
      name: "Child",
      surface: "gui",
      harnessId: "claude",
      model: null,
      agentMode: null,
      reasoningEffort: null,
      fastMode: null,
      workspace: { entries: [] },
      profileSelection: { kind: "ambient" },
      permissionMode: "full_access",
    });
    expect(created).toMatchObject({
      warnings: [],
      agentId: expect.any(String),
    });
    const agentId = (created as { agentId: string }).agentId;

    const sent = await call(started.rpcUrl, "agent.sendMessage", {
      major: 1,
      minor: 0,
    }, {
      senderAgentId: "chat-1",
      epicId: "epic-1",
      receiverAgentId: agentId,
      prompt: "hello from parent",
      responseId: null,
      expectReply: false,
    });
    expect(sent).toMatchObject({ responseId: null });

    const listed = await call(started.rpcUrl, "agent.list", { major: 1, minor: 0 }, {
      epicId: "epic-1",
      senderAgentId: "chat-1",
      scope: "all",
    });
    expect(listed).toMatchObject({
      agents: expect.arrayContaining([
        expect.objectContaining({ id: "chat-1" }),
        expect.objectContaining({ id: agentId, parentId: "chat-1" }),
      ]),
    });

    const transcript = await call(started.rpcUrl, "agent.getTranscript", {
      major: 1,
      minor: 0,
    }, {
      epicId: "epic-1",
      agentId,
    });
    expect(String((transcript as { transcript: string }).transcript)).toContain(
      "hello from parent",
    );

    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    const snapshot = await subscribeChat(streamUrl, "epic-1", agentId);
    const frame = snapshot as {
      kind: string;
      chatId: string;
      snapshot: {
        chat: { id: string };
        tail: { messages: readonly unknown[] };
      };
    };
    expect(frame.kind).toBe("snapshot");
    expect(frame.chatId).toBe(agentId);
    expect(frame.snapshot.chat.id).toBe(agentId);
    const blob = JSON.stringify(frame.snapshot.tail.messages);
    expect(blob).toContain("hello from parent");
  });
});

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
  return { result: record.result, error: record.error };
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
      token: "test-token",
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
    throw new Error(`expected snapshot, got ${JSON.stringify(frames)}`);
  }
  return snapshot;
}
