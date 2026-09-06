import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
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

describe("TUI prepareLaunch and createTuiAgent", () => {
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

  it("lists TUI harnesses from the provider catalog", async () => {
    const setup = await boot();
    tempDir = setup.tempDir;
    started = setup.started;
    const listed = await call(started.rpcUrl, "agent.tui.listHarnesses", {
      major: 1,
      minor: 0,
    }, {});
    expect(listed).toMatchObject({
      harnesses: [
        expect.objectContaining({
          id: "claude",
          label: "Claude Code",
          available: true,
          availabilityPending: false,
          error: null,
        }),
        expect.objectContaining({
          id: "codex",
          label: "Codex",
          available: true,
          error: null,
        }),
        expect.objectContaining({
          id: "opencode",
          label: "OpenCode",
          available: true,
          error: null,
        }),
        expect.objectContaining({
          id: "cursor",
          label: "Cursor",
          available: false,
          error: "Cursor TUI is not currently supported.",
        }),
      ],
    });
  });

  it("prepares a Claude launch, hands it to the PTY, and persists the TUI agent", async () => {
    const setup = await boot();
    tempDir = setup.tempDir;
    started = setup.started;
    const workspace = join(tempDir, "proj");
    await mkdir(workspace);
    await writeFile(join(workspace, "README.md"), "hello\n");
    const canonical = await realpath(workspace);

    await call(started.rpcUrl, "epic.create", { major: 1, minor: 0 }, {
      epic: {
        id: "epic-1",
        title: "TUI path",
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

    const prepared = await call(started.rpcUrl, "agent.tui.prepareLaunch", {
      major: 1,
      minor: 1,
    }, {
      harnessId: "claude",
      epicId: "epic-1",
      model: null,
      reasoningEffort: null,
      agentMode: "regular",
      tuiAgentId: "tui-1",
      harnessSessionId: null,
      terminalAgentArgs: "--permission-mode acceptEdits",
      workspaceMode: "inherit",
      forkSourceHarnessSessionId: null,
      profileId: null,
      forkSourceTuiAgentId: null,
    });
    const launch = prepared as {
      harnessId: string;
      harnessSessionId: string | null;
      terminalShellCommand: string | null;
      terminalShellArgs: readonly string[] | null;
      hostId: string;
      workingDirectory: string;
      workspaceFolders: readonly string[];
      worktreeBusyPaths: readonly string[];
    };
    expect(launch.harnessId).toBe("claude");
    expect(launch.hostId).toBe(started.runtime.hostId);
    expect(launch.workingDirectory).toBe(canonical);
    expect(launch.workspaceFolders).toEqual([canonical]);
    expect(launch.worktreeBusyPaths).toEqual([]);
    expect(launch.harnessSessionId).toEqual(expect.any(String));
    expect(launch.terminalShellCommand).toBe(setup.claudePath);
    expect(launch.terminalShellArgs).toEqual([
      "--resume",
      launch.harnessSessionId,
      "--permission-mode",
      "acceptEdits",
    ]);

    const created = await call(started.rpcUrl, "terminal.create", {
      major: 2,
      minor: 1,
    }, {
      scope: { kind: "epic", epicId: "epic-1" },
      sessionKind: "terminal-agent",
      tuiHarnessId: "claude",
      cwd: launch.workingDirectory,
      shellCommand: launch.terminalShellCommand,
      shellArgs: launch.terminalShellArgs,
      cols: 80,
      rows: 24,
      desiredSessionId: "tui-1",
      worktreeBusyPaths: launch.worktreeBusyPaths,
      themeHint: null,
    });
    expect(created).toMatchObject({
      session: {
        sessionId: "tui-1",
        sessionKind: "terminal-agent",
        status: "running",
        shellCommand: setup.claudePath,
        shellArgs: launch.terminalShellArgs,
      },
    });

    const persisted = await call(started.rpcUrl, "epic.createTuiAgent", {
      major: 1,
      minor: 1,
    }, {
      epicId: "epic-1",
      parentId: "chat-1",
      title: "Claude TUI",
      harnessId: "claude",
      harnessSessionId: launch.harnessSessionId,
      terminalAgentArgs: "--permission-mode acceptEdits",
      terminalShellCommand: launch.terminalShellCommand,
      terminalShellArgs: launch.terminalShellArgs,
      hostId: launch.hostId,
      workspaceFolders: launch.workspaceFolders,
      workspaceMode: "inherit",
      model: null,
      reasoningEffort: null,
      agentMode: "regular",
      tuiAgentId: "tui-1",
      profileId: null,
      forkSourceHarnessSessionId: null,
    });
    expect(persisted).toEqual({ tuiAgentId: "tui-1" });

    const renamed = await call(started.rpcUrl, "epic.renameTuiAgent", {
      major: 1,
      minor: 0,
    }, {
      epicId: "epic-1",
      tuiAgentId: "tui-1",
      title: "Renamed TUI",
    });
    expect(renamed).toEqual({ updated: true });

    const killed = await call(started.rpcUrl, "terminal.kill", {
      major: 1,
      minor: 0,
    }, { sessionId: "tui-1" });
    expect(killed).toMatchObject({ killed: true });

    const deleted = await call(started.rpcUrl, "epic.deleteTuiAgent", {
      major: 1,
      minor: 0,
    }, { epicId: "epic-1", tuiAgentId: "tui-1" });
    expect(deleted).toEqual({ deleted: true });
  });

  it("rejects cursor, Claude probes, and fork-with-destination-session", async () => {
    const setup = await boot();
    tempDir = setup.tempDir;
    started = setup.started;

    const cursor = await rpcExchange(started.rpcUrl, "agent.tui.prepareLaunch", {
      major: 1,
      minor: 1,
    }, {
      harnessId: "cursor",
      epicId: "epic-1",
      model: null,
      reasoningEffort: null,
      agentMode: "regular",
      tuiAgentId: "tui-cursor",
      harnessSessionId: null,
      terminalAgentArgs: null,
      forkSourceHarnessSessionId: null,
      profileId: null,
      forkSourceTuiAgentId: null,
    });
    expect(errorMessage(cursor.error)).toContain(
      "Cursor TUI is not currently supported.",
    );

    const probe = await rpcExchange(started.rpcUrl, "agent.tui.prepareLaunch", {
      major: 1,
      minor: 1,
    }, {
      harnessId: "claude",
      epicId: "epic-1",
      model: null,
      reasoningEffort: null,
      agentMode: "regular",
      tuiAgentId: null,
      harnessSessionId: null,
      terminalAgentArgs: null,
      forkSourceHarnessSessionId: null,
      profileId: null,
      forkSourceTuiAgentId: null,
    });
    expect(errorMessage(probe.error)).toContain(
      "Claude TUI launch probes are not supported.",
    );

    const forked = await rpcExchange(started.rpcUrl, "agent.tui.prepareLaunch", {
      major: 1,
      minor: 1,
    }, {
      harnessId: "claude",
      epicId: "epic-1",
      model: null,
      reasoningEffort: null,
      agentMode: "regular",
      tuiAgentId: "tui-fork",
      harnessSessionId: "dest-session",
      terminalAgentArgs: null,
      forkSourceHarnessSessionId: "source-session",
      profileId: null,
      forkSourceTuiAgentId: "source-tui",
    });
    expect(errorMessage(forked.error)).toContain(
      "fork launches must not pass an existing destination harnessSessionId",
    );
  });

  it("returns a Codex first-launch with a null harness session id", async () => {
    const setup = await boot();
    tempDir = setup.tempDir;
    started = setup.started;
    const workspace = join(tempDir, "proj");
    await mkdir(workspace);
    const canonical = await realpath(workspace);
    await call(started.rpcUrl, "epic.create", { major: 1, minor: 0 }, {
      epic: {
        id: "epic-1",
        title: "Codex path",
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

    const prepared = await call(started.rpcUrl, "agent.tui.prepareLaunch", {
      major: 1,
      minor: 1,
    }, {
      harnessId: "codex",
      epicId: "epic-1",
      model: null,
      reasoningEffort: null,
      agentMode: "regular",
      tuiAgentId: "tui-codex",
      harnessSessionId: null,
      terminalAgentArgs: null,
      forkSourceHarnessSessionId: null,
      profileId: null,
      forkSourceTuiAgentId: null,
    });
    expect(prepared).toMatchObject({
      harnessId: "codex",
      harnessSessionId: null,
      terminalShellCommand: setup.codexPath,
      terminalShellArgs: [],
      workingDirectory: canonical,
    });
  });
});

type Booted = {
  readonly tempDir: string;
  readonly started: StartedHost;
  readonly claudePath: string;
  readonly codexPath: string;
};

async function boot(): Promise<Booted> {
  const tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
  const binDir = join(tempDir, "bin");
  await mkdir(binDir);
  const claudePath = await writeFakeCli(join(binDir, "claude"));
  const codexPath = await writeFakeCli(join(binDir, "codex"));
  const opencodePath = await writeFakeCli(join(binDir, "opencode"));
  const started = await startHost({
    argv: ["--host-data-dir", tempDir],
    listenHost: "127.0.0.1",
    listenPort: 0,
  });
  await call(started.rpcUrl, "providers.addCustomPath", { major: 2, minor: 1 }, {
    providerId: "claude-code",
    path: claudePath,
  });
  await call(started.rpcUrl, "providers.addCustomPath", { major: 2, minor: 1 }, {
    providerId: "codex",
    path: codexPath,
  });
  await call(started.rpcUrl, "providers.addCustomPath", { major: 2, minor: 1 }, {
    providerId: "opencode",
    path: opencodePath,
  });
  return { tempDir, started, claudePath, codexPath };
}

async function writeFakeCli(path: string): Promise<string> {
  await writeFile(path, "#!/bin/sh\nexec /bin/sleep 60\n");
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

function errorMessage(error: unknown): string {
  if (error === null || typeof error !== "object") {
    return String(error);
  }
  const record = error as Record<string, unknown>;
  return typeof record.message === "string" ? record.message : JSON.stringify(error);
}
