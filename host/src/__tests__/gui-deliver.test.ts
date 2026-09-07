import {
  chmod,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
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

describe("GUI catalog, deliver, inbox, and TUI hooks", () => {
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

  it("lists GUI harnesses and a default model catalog", async () => {
    const setup = await boot();
    tempDir = setup.tempDir;
    started = setup.started;
    const listed = await call(
      started.rpcUrl,
      "agent.gui.listHarnesses",
      {
        major: 8,
        minor: 0,
      },
      {},
    );
    const record = listed as {
      harnesses: readonly {
        id: string;
        available: boolean;
        modes: readonly string[];
      }[];
    };
    expect(
      record.harnesses.some((row) => row.id === "claude" && row.available),
    ).toBe(true);
    const claude = record.harnesses.find((row) => row.id === "claude");
    expect(claude?.modes).toEqual(["gui", "tui"]);
    const models = await call(
      started.rpcUrl,
      "agent.gui.listModels",
      {
        major: 1,
        minor: 0,
      },
      { harnessId: "claude", workingDirectory: null },
    );
    const modelRecord = models as {
      models: readonly { slug: string; label: string }[];
    };
    expect(modelRecord.models.map((row) => row.slug)).toEqual([
      "default",
      "sonnet",
      "claude-fable-5[1m]",
      "opus",
      "haiku",
    ]);
    expect(modelRecord.models[0]).toMatchObject({
      slug: "default",
      label: "Default (Sonnet 5)",
    });
    const commands = await call(
      started.rpcUrl,
      "agent.gui.listCommands",
      {
        major: 1,
        minor: 0,
      },
      { harnessId: "claude", workingDirectory: null, workingDirectories: [] },
    );
    expect(commands).toMatchObject({
      harnessId: "claude",
      commands: [
        expect.objectContaining({
          name: "compact",
          kind: "slash-command",
          metadata: { providerKind: "compaction" },
        }),
        // The released host's entry: `/plan <prompt>`, a permission-mode command.
        expect.objectContaining({
          name: "plan",
          argumentHint: "<prompt>",
          metadata: {
            catalogSource: "providerMode",
            providerKind: "permission-mode",
            permissionMode: "plan",
          },
        }),
      ],
    });
    const harnessModels = await call(
      started.rpcUrl,
      "agent.listHarnessModels",
      {
        major: 2,
        minor: 0,
      },
      { epicId: null, senderAgentId: null, harnessId: "claude" },
    );
    expect(harnessModels).toMatchObject({
      harnessId: "claude",
      models: expect.arrayContaining([
        expect.objectContaining({
          id: "default",
          reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
          fastModeAvailable: false,
        }),
        expect.objectContaining({ id: "opus", fastModeAvailable: true }),
        expect.objectContaining({ id: "haiku" }),
      ]),
    });
    const cleared = await call(
      started.rpcUrl,
      "snapshots.clearLocalSnapshots",
      {
        major: 1,
        minor: 0,
      },
      {},
    );
    expect(cleared).toEqual({ clearedBytes: 0 });
  });

  it("delivers an A2A prompt through the GUI CLI and records the assistant turn", async () => {
    const setup = await boot();
    tempDir = setup.tempDir;
    started = setup.started;
    await seedEpic(started, tempDir);
    const created = await call(
      started.rpcUrl,
      "agent.create",
      {
        major: 3,
        minor: 0,
      },
      {
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
      },
    );
    const agentId = (created as { agentId: string }).agentId;
    const sent = await call(
      started.rpcUrl,
      "agent.sendMessage",
      {
        major: 1,
        minor: 0,
      },
      {
        senderAgentId: "chat-1",
        epicId: "epic-1",
        receiverAgentId: agentId,
        prompt: "hello from parent",
        responseId: null,
        expectReply: true,
      },
    );
    expect(sent).toMatchObject({ responseId: expect.any(String) });
    const transcript = await call(
      started.rpcUrl,
      "agent.getTranscript",
      {
        major: 1,
        minor: 0,
      },
      { epicId: "epic-1", agentId },
    );
    expect(String((transcript as { transcript: string }).transcript)).toContain(
      "assistant-ok",
    );
    // The released host's answer for a plan the chat never held: not found,
    // rather than a plan with nothing behind it.
    await expect(
      call(
        started.rpcUrl,
        "agent.gui.getPlan",
        { major: 1, minor: 0 },
        { epicId: "epic-1", chatId: agentId, planId: "plan-1" },
      ),
    ).rejects.toThrow("PLAN_NOT_FOUND");
  });

  it("enqueues TUI inbox mail and accepts hook RPCs", async () => {
    const setup = await boot();
    tempDir = setup.tempDir;
    started = setup.started;
    await seedEpic(started, tempDir);
    await call(
      started.rpcUrl,
      "epic.createTuiAgent",
      { major: 1, minor: 1 },
      {
        epicId: "epic-1",
        parentId: "chat-1",
        title: "",
        harnessId: "claude",
        harnessSessionId: "sess-1",
        terminalAgentArgs: null,
        terminalShellCommand: setup.claudePath,
        terminalShellArgs: ["--resume", "sess-1"],
        hostId: started.runtime.hostId,
        workspaceFolders: [],
        workspaceMode: "inherit",
        model: null,
        reasoningEffort: null,
        agentMode: "regular",
        tuiAgentId: "tui-1",
        profileId: null,
        forkSourceHarnessSessionId: null,
      },
    );
    await call(
      started.rpcUrl,
      "agent.sendMessage",
      { major: 1, minor: 0 },
      {
        senderAgentId: "chat-1",
        epicId: "epic-1",
        receiverAgentId: "tui-1",
        prompt: "ping tui",
        responseId: null,
        expectReply: false,
      },
    );
    const inbox = await call(
      started.rpcUrl,
      "agent.inbox.read",
      {
        major: 2,
        minor: 0,
      },
      { epicId: "epic-1", agentId: "tui-1", after: null },
    );
    expect(inbox).toMatchObject({
      nextCursor: null,
      messages: [
        expect.objectContaining({ prompt: "ping tui", fromAgentId: "chat-1" }),
      ],
    });
    const titled = await call(
      started.rpcUrl,
      "agent.tui.generateTitle",
      {
        major: 1,
        minor: 0,
      },
      {
        epicId: "epic-1",
        tuiAgentId: "tui-1",
        harnessSessionId: null,
        harnessId: "claude",
        promptText: "Implement the inbox path",
      },
    );
    expect(titled).toEqual({ accepted: true });
    const activity = await call(
      started.rpcUrl,
      "agent.tui.recordActivity",
      {
        major: 1,
        minor: 1,
      },
      {
        epicId: "epic-1",
        tuiAgentId: "tui-1",
        harnessSessionId: null,
        harnessId: "claude",
        event: "start",
        observedHarnessSessionId: null,
      },
    );
    expect(activity).toEqual({ accepted: true });
    const ended = await call(
      started.rpcUrl,
      "agent.tui.turnEnded",
      {
        major: 1,
        minor: 0,
      },
      { epicId: "epic-1", tuiAgentId: "tui-1", harnessId: "claude" },
    );
    expect(ended).toEqual({ accepted: true });
    const submitted = await call(
      started.rpcUrl,
      "agent.tui.promptSubmitted",
      {
        major: 1,
        minor: 1,
      },
      {
        epicId: "epic-1",
        tuiAgentId: "tui-1",
        harnessSessionId: null,
        harnessId: "claude",
        observedHarnessSessionId: null,
        worktreeIntent: null,
      },
    );
    expect(submitted).toEqual({ accepted: true, pendingPromptContext: null });
  });
});

type Booted = {
  readonly tempDir: string;
  readonly started: StartedHost;
  readonly claudePath: string;
};

async function boot(): Promise<Booted> {
  const tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
  const binDir = join(tempDir, "bin");
  await mkdir(binDir);
  const claudePath = await writeFakeCli(join(binDir, "claude"));
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
      path: claudePath,
    },
  );
  return { tempDir, started, claudePath };
}

async function seedEpic(started: StartedHost, tempDir: string): Promise<void> {
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
        id: "epic-1",
        title: "GUI path",
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
    },
  );
}

async function writeFakeCli(path: string): Promise<string> {
  await writeFile(path, "#!/bin/sh\nprintf 'assistant-ok\\n'\n");
  await chmod(path, 0o755);
  return realpath(path);
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
