import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { splitConnectionManifest } from "@traycer/protocol/framework/capability-manifest";
import {
  hostFrameSchema,
  type HostFrame,
} from "@traycer/protocol/framework/ws-protocol";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  batchDeleteResponseSchema,
  createTuiAgentResponseSchema,
  createEpicRequestSchema,
  listEpicCollaboratorsResponseSchema,
  listTasksResponseSchema,
  removeEpicRepoResponseSchema,
} from "@traycer/protocol/host/epic/unary-schemas";
import { listGuiAgentModelsResponseSchema } from "@traycer/protocol/host/agent/gui/unary-schemas";
import {
  listTuiHarnessesResponseSchema,
  prepareTuiLaunchResponseSchema,
} from "@traycer/protocol/host/agent/tui/unary-schemas";
import { listAgentsResponseSchemaV60 } from "@traycer/protocol/host/agent/shared";
import {
  snapshotsClearLocalSnapshotsResponseSchema,
  snapshotsGetLocalStorageSizeResponseSchema,
  snapshotsReadSnapshotDiffResponseSchema,
} from "@traycer/protocol/host/snapshot-schemas";
import {
  speechEnsureModelResponseSchema,
  speechGetModelStatusResponseSchema,
} from "@traycer/protocol/host/speech/contracts";
import { listTerminalsResponseSchemaV22 } from "@traycer/protocol/host/terminal/unary-schemas";
import {
  providerIdSchema,
  providersListResponseSchema,
} from "@traycer/protocol/host/provider-schemas";
import { worktreeSetRepoScriptsResponseSchema } from "@traycer/protocol/host/worktree-schemas";
import { scriptedTurnRunner } from "../cli-runner";
import { startHostServer, type HostServer } from "../server";

describe("local released-baseline methods", () => {
  const servers: HostServer[] = [];
  const sockets: WebSocket[] = [];
  const temporaryDirectories: string[] = [];
  const originalCodexHome = process.env.CODEX_HOME;
  const originalClaudePath = process.env.TRAYCER_CLAUDE_PATH;

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.terminate();
    }
    while (servers.length > 0) {
      await servers.pop()?.close();
    }
    while (temporaryDirectories.length > 0) {
      const directory = temporaryDirectories.pop();
      if (directory !== undefined) {
        await rm(directory, { recursive: true, force: true });
      }
    }
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
    if (originalClaudePath === undefined) {
      delete process.env.TRAYCER_CLAUDE_PATH;
    } else {
      process.env.TRAYCER_CLAUDE_PATH = originalClaudePath;
    }
  });

  it("reports an unavailable local speech engine without entering an error poll", async () => {
    const { server, socket } = await openHost();
    servers.push(server);
    sockets.push(socket);

    socket.send(
      JSON.stringify({
        kind: "request",
        requestId: "speech-status",
        method: "speech.getModelStatus",
        schemaVersion: { major: 1, minor: 0 },
        params: { modelId: null },
      }),
    );

    const response = expectResponse(
      await nextHostFrame(socket),
      "speech-status",
    );
    expect(response.error).toBeNull();
    expect(speechGetModelStatusResponseSchema.parse(response.result)).toEqual({
      modelId: "default",
      installed: false,
      downloadState: "absent",
      downloadProgress: null,
      sizeBytes: null,
      errorMessage: null,
      engineAvailable: false,
    });
  });

  it("lists an empty local terminal inventory without failing the terminal UI", async () => {
    const { server, socket } = await openHost();
    servers.push(server);
    sockets.push(socket);

    socket.send(
      JSON.stringify({
        kind: "request",
        requestId: "terminal-list",
        method: "terminal.list",
        schemaVersion: { major: 2, minor: 2 },
        params: { scope: { kind: "independent" } },
      }),
    );

    const response = expectResponse(
      await nextHostFrame(socket),
      "terminal-list",
    );
    expect(response.error).toBeNull();
    expect(listTerminalsResponseSchemaV22.parse(response.result)).toEqual({
      sessions: [],
      homeCwd: homedir(),
    });
  });

  it("reports zero bytes when the local host has no snapshot store", async () => {
    const { server, socket } = await openHost();
    servers.push(server);
    sockets.push(socket);

    socket.send(
      JSON.stringify({
        kind: "request",
        requestId: "snapshot-size",
        method: "snapshots.getLocalStorageSize",
        schemaVersion: { major: 1, minor: 0 },
        params: {},
      }),
    );

    const response = expectResponse(
      await nextHostFrame(socket),
      "snapshot-size",
    );
    expect(response.error).toBeNull();
    expect(
      snapshotsGetLocalStorageSizeResponseSchema.parse(response.result),
    ).toEqual({ bytes: 0 });
  });

  it("returns honest no-engine and no-snapshot fallbacks for released local methods", async () => {
    const { server, socket } = await openHost();
    servers.push(server);
    sockets.push(socket);

    socket.send(
      JSON.stringify({
        kind: "request",
        requestId: "ensure-speech-model",
        method: "speech.ensureModel",
        schemaVersion: { major: 1, minor: 0 },
        params: { modelId: null },
      }),
    );
    const speech = expectResponse(
      await nextHostFrame(socket),
      "ensure-speech-model",
    );
    expect(speech.error).toBeNull();
    expect(speechEnsureModelResponseSchema.parse(speech.result)).toEqual({
      modelId: "default",
      installed: false,
      downloadState: "absent",
      downloadProgress: null,
      sizeBytes: null,
      errorMessage: "On-device speech is not available on this local host.",
      engineAvailable: false,
    });

    socket.send(
      JSON.stringify({
        kind: "request",
        requestId: "clear-local-snapshots",
        method: "snapshots.clearLocalSnapshots",
        schemaVersion: { major: 1, minor: 0 },
        params: {},
      }),
    );
    const cleared = expectResponse(
      await nextHostFrame(socket),
      "clear-local-snapshots",
    );
    expect(cleared.error).toBeNull();
    expect(
      snapshotsClearLocalSnapshotsResponseSchema.parse(cleared.result),
    ).toEqual({ clearedBytes: 0 });

    socket.send(
      JSON.stringify({
        kind: "request",
        requestId: "read-missing-snapshot-diff",
        method: "snapshots.readSnapshotDiff",
        schemaVersion: { major: 1, minor: 0 },
        params: { beforeHash: "before", afterHash: "after" },
      }),
    );
    const diff = expectResponse(
      await nextHostFrame(socket),
      "read-missing-snapshot-diff",
    );
    expect(diff.error).toBeNull();
    expect(snapshotsReadSnapshotDiffResponseSchema.parse(diff.result)).toEqual({
      beforeContent: null,
      afterContent: null,
      reason: "blob_missing",
    });
  });

  it("persists repository scripts and removes only the requested epic repository", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "traycer-repo-settings-"));
    temporaryDirectories.push(workspace);
    const { server, socket } = await openHost();
    servers.push(server);
    sockets.push(socket);
    const now = Date.now();
    socket.send(
      JSON.stringify({
        kind: "request",
        requestId: "create-repo-settings-epic",
        method: "epic.create",
        schemaVersion: { major: 1, minor: 0 },
        params: createEpicRequestSchema.parse({
          epic: {
            id: "epic-repo-settings",
            title: "Repository settings",
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
          repoIdentifiers: [
            { owner: "acme", repo: "primary" },
            { owner: "acme", repo: "keep" },
          ],
          workspaces: [{ workspacePath: workspace }],
          chat: null,
        }),
      }),
    );
    expect(
      expectResponse(await nextHostFrame(socket), "create-repo-settings-epic")
        .error,
    ).toBeNull();

    const setup = {
      default: "bun install",
      macos: "bun install --frozen-lockfile",
      windows: null,
      linux: null,
    };
    const teardown = {
      default: "",
      macos: null,
      windows: null,
      linux: null,
    };
    socket.send(
      JSON.stringify({
        kind: "request",
        requestId: "set-repo-scripts",
        method: "worktree.setRepoScripts",
        schemaVersion: { major: 1, minor: 0 },
        params: {
          epicId: "epic-repo-settings",
          workspacePath: workspace,
          setup,
          teardown,
        },
      }),
    );
    const scripts = expectResponse(
      await nextHostFrame(socket),
      "set-repo-scripts",
    );
    expect(scripts.error).toBeNull();
    expect(worktreeSetRepoScriptsResponseSchema.parse(scripts.result)).toEqual({
      updated: true,
    });
    expect(
      JSON.parse(
        await readFile(join(workspace, ".traycer", "environment.json"), "utf8"),
      ),
    ).toMatchObject({ setup, teardown });

    for (const [requestId, expectedSuccess] of [
      ["remove-repo", true],
      ["remove-repo-again", false],
    ] as const) {
      socket.send(
        JSON.stringify({
          kind: "request",
          requestId,
          method: "epic.removeRepo",
          schemaVersion: { major: 1, minor: 0 },
          params: {
            epicId: "epic-repo-settings",
            repoIdentifier: { owner: "acme", repo: "primary" },
          },
        }),
      );
      const removed = expectResponse(await nextHostFrame(socket), requestId);
      expect(removed.error).toBeNull();
      expect(removeEpicRepoResponseSchema.parse(removed.result)).toEqual({
        success: expectedSuccess,
      });
    }
  });

  it("reports every provider even when its local CLI is unavailable", async () => {
    const { server, socket } = await openHost();
    servers.push(server);
    sockets.push(socket);

    socket.send(
      JSON.stringify({
        kind: "request",
        requestId: "providers-list",
        method: "providers.list",
        schemaVersion: { major: 7, minor: 0 },
        params: { forceAuthRefresh: false, native: null },
      }),
    );

    const response = expectResponse(
      await nextHostFrame(socket),
      "providers-list",
    );
    expect(response.error).toBeNull();
    const catalog = providersListResponseSchema.parse(response.result);
    expect(catalog.providers.map((provider) => provider.providerId)).toEqual(
      providerIdSchema.options,
    );
    expect(catalog.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerId: "claude-code" }),
        expect.objectContaining({ providerId: "codex" }),
      ]),
    );
  });

  it("reports cloud collaborators as unavailable for a local epic", async () => {
    const { server, socket } = await openHost();
    servers.push(server);
    sockets.push(socket);
    const now = Date.now();
    socket.send(
      JSON.stringify({
        kind: "request",
        requestId: "create-local-epic",
        method: "epic.create",
        schemaVersion: { major: 1, minor: 0 },
        params: createEpicRequestSchema.parse({
          epic: {
            id: "epic-local-collaborators",
            title: "Local",
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
        }),
      }),
    );
    expect(
      expectResponse(await nextHostFrame(socket), "create-local-epic").error,
    ).toBeNull();

    socket.send(
      JSON.stringify({
        kind: "request",
        requestId: "list-local-collaborators",
        method: "epic.listCollaborators",
        schemaVersion: { major: 1, minor: 0 },
        params: { epicId: "epic-local-collaborators" },
      }),
    );
    const response = expectResponse(
      await nextHostFrame(socket),
      "list-local-collaborators",
    );
    expect(response.error).toBeNull();
    expect(listEpicCollaboratorsResponseSchema.parse(response.result)).toEqual({
      collaborators: [],
      collaboratorsAvailable: false,
    });
  });

  it("batch-deletes local tasks and reports missing rows without failing the request", async () => {
    const { server, socket } = await openHost();
    servers.push(server);
    sockets.push(socket);
    const now = Date.now();
    for (const [index, id] of ["epic-delete-a", "epic-delete-b"].entries()) {
      socket.send(
        JSON.stringify({
          kind: "request",
          requestId: `create-${id}`,
          method: "epic.create",
          schemaVersion: { major: 1, minor: 0 },
          params: createEpicRequestSchema.parse({
            epic: {
              id,
              title: id,
              initialUserPrompt: "",
              ticketCount: 0,
              specCount: 0,
              storyCount: 0,
              reviewCount: 0,
              status: "active",
              createdAt: now + index,
              updatedAt: now + index,
              createdBy: "local-user",
              version: "1.0.0",
            },
            repoIdentifiers: [],
            workspaces: [],
            chat: null,
          }),
        }),
      );
      expect(
        expectResponse(await nextHostFrame(socket), `create-${id}`).error,
      ).toBeNull();
    }

    socket.send(
      JSON.stringify({
        kind: "request",
        requestId: "batch-delete-local-epics",
        method: "epic.batchDelete",
        schemaVersion: { major: 1, minor: 0 },
        params: {
          ids: ["epic-delete-a", "missing-epic", "epic-delete-b"],
        },
      }),
    );
    const deleted = expectResponse(
      await nextHostFrame(socket),
      "batch-delete-local-epics",
    );
    expect(deleted.error).toBeNull();
    expect(batchDeleteResponseSchema.parse(deleted.result)).toEqual({
      results: [
        { taskId: "epic-delete-a", success: true },
        {
          taskId: "missing-epic",
          success: false,
          errorMessage: "Task 'missing-epic' was not found",
        },
        { taskId: "epic-delete-b", success: true },
      ],
    });

    socket.send(
      JSON.stringify({
        kind: "request",
        requestId: "list-after-batch-delete",
        method: "epic.listTasks",
        schemaVersion: { major: 1, minor: 0 },
        params: {
          limit: 50,
          filters: null,
          extensionPhaseVersion: "1.0.0",
          extensionEpicVersion: "1.0.0",
        },
      }),
    );
    const listed = expectResponse(
      await nextHostFrame(socket),
      "list-after-batch-delete",
    );
    expect(listed.error).toBeNull();
    expect(listTasksResponseSchema.parse(listed.result)).toEqual({
      tasks: [],
      hasMore: false,
    });
  });

  it("lists the installed Codex models instead of a stale bundled catalog", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "traycer-codex-home-"));
    temporaryDirectories.push(codexHome);
    process.env.CODEX_HOME = codexHome;
    await writeFile(
      join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: "gpt-5.6-sol",
            display_name: "GPT-5.6-Sol",
            description: "Frontier coding model",
            visibility: "list",
            default_reasoning_level: "low",
            supported_reasoning_levels: [
              { effort: "low", description: "Fast responses" },
              { effort: "xhigh", description: "Deeper reasoning" },
            ],
            service_tiers: [
              {
                id: "priority",
                name: "Fast",
                description: "Increased speed",
              },
            ],
          },
          {
            slug: "gpt-5.6-luna",
            display_name: "GPT-5.6-Luna",
            description: null,
            visibility: "list",
            default_reasoning_level: "medium",
            supported_reasoning_levels: [
              { effort: "medium", description: null },
            ],
            service_tiers: [],
          },
          {
            slug: "internal-model",
            display_name: "Internal",
            visibility: "hidden",
          },
        ],
      }),
      "utf8",
    );

    const { server, socket } = await openHost();
    servers.push(server);
    sockets.push(socket);
    socket.send(
      JSON.stringify({
        kind: "request",
        requestId: "list-codex-models",
        method: "agent.gui.listModels",
        schemaVersion: { major: 1, minor: 0 },
        params: { harnessId: "codex", workingDirectory: null },
      }),
    );

    const response = expectResponse(
      await nextHostFrame(socket),
      "list-codex-models",
    );
    expect(response.error).toBeNull();
    expect(listGuiAgentModelsResponseSchema.parse(response.result)).toEqual({
      harnessId: "codex",
      models: [
        {
          harnessId: "codex",
          slug: "gpt-5.6-sol",
          label: "GPT-5.6-Sol",
          description: "Frontier coding model",
          contextWindow: null,
          maxOutputTokens: null,
          defaultReasoningEffort: "low",
          supportedReasoningEfforts: [
            { id: "low", label: "Low", description: "Fast responses" },
            {
              id: "xhigh",
              label: "Extra high",
              description: "Deeper reasoning",
            },
          ],
          defaultServiceTier: null,
          supportedServiceTiers: [
            {
              id: "priority",
              label: "Fast",
              description: "Increased speed",
            },
          ],
          metadata: {},
        },
        {
          harnessId: "codex",
          slug: "gpt-5.6-luna",
          label: "GPT-5.6-Luna",
          description: null,
          contextWindow: null,
          maxOutputTokens: null,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { id: "medium", label: "Medium", description: null },
          ],
          defaultServiceTier: null,
          supportedServiceTiers: [],
          metadata: {},
        },
      ],
    });
  });

  it("uses current Claude model aliases instead of retired versioned models", async () => {
    const { server, socket } = await openHost();
    servers.push(server);
    sockets.push(socket);
    socket.send(
      JSON.stringify({
        kind: "request",
        requestId: "list-claude-models",
        method: "agent.gui.listModels",
        schemaVersion: { major: 1, minor: 0 },
        params: { harnessId: "claude", workingDirectory: null },
      }),
    );

    const response = expectResponse(
      await nextHostFrame(socket),
      "list-claude-models",
    );
    expect(response.error).toBeNull();
    const catalog = listGuiAgentModelsResponseSchema.parse(response.result);
    expect(catalog.models.map(({ slug, label }) => ({ slug, label }))).toEqual([
      { slug: "sonnet", label: "Claude Sonnet 5" },
      { slug: "opus", label: "Claude Opus 5" },
      { slug: "fable", label: "Claude Fable 5" },
    ]);
  });

  it("prepares and persists a folderless Claude terminal agent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "traycer-tui-flow-"));
    temporaryDirectories.push(directory);
    const claudePath = join(directory, "claude");
    await writeFile(claudePath, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(claudePath, 0o700);
    process.env.TRAYCER_CLAUDE_PATH = claudePath;

    const { server, socket } = await openHost();
    servers.push(server);
    sockets.push(socket);
    const now = Date.now();
    socket.send(
      JSON.stringify({
        kind: "request",
        requestId: "create-tui-epic",
        method: "epic.create",
        schemaVersion: { major: 1, minor: 0 },
        params: createEpicRequestSchema.parse({
          epic: {
            id: "epic-tui",
            title: "Terminal task",
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
        }),
      }),
    );
    expect(
      expectResponse(await nextHostFrame(socket), "create-tui-epic").error,
    ).toBeNull();

    socket.send(
      JSON.stringify({
        kind: "request",
        requestId: "list-tui-harnesses",
        method: "agent.tui.listHarnesses",
        schemaVersion: { major: 1, minor: 0 },
        params: {},
      }),
    );
    const harnesses = expectResponse(
      await nextHostFrame(socket),
      "list-tui-harnesses",
    );
    expect(harnesses.error).toBeNull();
    expect(
      listTuiHarnessesResponseSchema.parse(harnesses.result).harnesses,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "claude", available: true }),
      ]),
    );

    socket.send(
      JSON.stringify({
        kind: "request",
        requestId: "prepare-tui",
        method: "agent.tui.prepareLaunch",
        schemaVersion: { major: 1, minor: 1 },
        params: {
          harnessId: "claude",
          epicId: "epic-tui",
          model: "sonnet",
          reasoningEffort: null,
          agentMode: "regular",
          tuiAgentId: "tui-agent-1",
          harnessSessionId: null,
          terminalAgentArgs: "--verbose",
          workspaceMode: "folderless",
          forkSourceHarnessSessionId: null,
          forkSourceTuiAgentId: null,
          profileId: null,
        },
      }),
    );
    const preparedFrame = expectResponse(
      await nextHostFrame(socket),
      "prepare-tui",
    );
    expect(preparedFrame.error).toBeNull();
    const prepared = prepareTuiLaunchResponseSchema.parse(preparedFrame.result);
    expect(prepared).toMatchObject({
      harnessId: "claude",
      terminalShellCommand: claudePath,
      workspaceFolders: [],
      worktreeBusyPaths: [],
      hostId: "host-local",
    });
    expect(prepared.harnessSessionId).not.toBeNull();
    const terminalShellArgs = prepared.terminalShellArgs;
    if (terminalShellArgs === null) {
      throw new Error("Expected Claude terminal shell arguments");
    }
    expect(terminalShellArgs).toEqual([
      "--session-id",
      prepared.harnessSessionId,
      "--model",
      "sonnet",
      "--plugin-dir",
      expect.any(String),
      "--verbose",
    ]);
    const pluginPath = terminalShellArgs[5];
    if (pluginPath === undefined) {
      throw new Error("Expected a Claude TUI plugin path");
    }
    expect(
      JSON.parse(
        await readFile(join(pluginPath, "monitors", "monitors.json"), "utf8"),
      ),
    ).toEqual([
      {
        name: "traycer-agent-inbox",
        command: '"${TRAYCER_CLI}" monitor',
        description: "Inbound messages from other Traycer agents",
      },
    ]);
    expect(
      JSON.parse(
        await readFile(join(pluginPath, "hooks", "hooks.json"), "utf8"),
      ),
    ).toMatchObject({
      hooks: {
        SessionStart: expect.any(Array),
        UserPromptSubmit: expect.any(Array),
        Stop: expect.any(Array),
      },
    });

    socket.send(
      JSON.stringify({
        kind: "request",
        requestId: "persist-tui",
        method: "epic.createTuiAgent",
        schemaVersion: { major: 1, minor: 1 },
        params: {
          epicId: "epic-tui",
          parentId: null,
          title: "Terminal agent",
          harnessId: "claude",
          harnessSessionId: prepared.harnessSessionId,
          terminalAgentArgs: "--verbose",
          terminalShellCommand: prepared.terminalShellCommand,
          terminalShellArgs: prepared.terminalShellArgs,
          hostId: prepared.hostId,
          workspaceFolders: prepared.workspaceFolders,
          workspaceMode: "folderless",
          model: "sonnet",
          reasoningEffort: null,
          agentMode: "regular",
          tuiAgentId: "tui-agent-1",
          profileId: null,
          forkSourceHarnessSessionId: null,
        },
      }),
    );
    const persisted = expectResponse(
      await nextHostFrame(socket),
      "persist-tui",
    );
    expect(persisted.error).toBeNull();
    expect(createTuiAgentResponseSchema.parse(persisted.result)).toEqual({
      tuiAgentId: "tui-agent-1",
    });

    socket.send(
      JSON.stringify({
        kind: "request",
        requestId: "list-tui-agent",
        method: "agent.list",
        schemaVersion: { major: 6, minor: 0 },
        params: {
          epicId: "epic-tui",
          senderAgentId: "tui-agent-1",
          scope: "user",
        },
      }),
    );
    const agents = listAgentsResponseSchemaV60.parse(
      expectResponse(await nextHostFrame(socket), "list-tui-agent").result,
    );
    expect(agents.caller).toEqual({
      agentId: "tui-agent-1",
      canSendMessages: true,
    });
    expect(agents.agents).toEqual([
      expect.objectContaining({
        id: "tui-agent-1",
        surface: "tui",
        harnessId: "claude",
        folderPaths: [],
        isWorktree: false,
        capabilities: { readTranscript: false, sendMessage: true },
      }),
    ]);
  });
});

async function openHost(): Promise<{
  readonly server: HostServer;
  readonly socket: WebSocket;
}> {
  const server = await startHostServer(0, "host-local", {
    runner: scriptedTurnRunner([]),
  });
  const socket = new WebSocket(server.websocketUrl);
  await waitForOpen(socket);
  const clientManifest = splitConnectionManifest(
    hostRpcRegistry,
    RELEASED_FLOOR_METHOD_NAMES,
  );
  socket.send(
    JSON.stringify({
      kind: "open",
      token: "local",
      manifest: clientManifest.manifest,
      optionalManifest: clientManifest.optionalManifest,
    }),
  );
  expect(await nextHostFrame(socket)).toMatchObject({
    kind: "openAck",
    manifest: { "speech.getModelStatus": { major: 1, minor: 0 } },
  });
  return { server, socket };
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

async function nextHostFrame(socket: WebSocket): Promise<HostFrame> {
  return await new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(hostFrameSchema.parse(JSON.parse(data.toString())));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

function expectResponse(
  frame: HostFrame,
  requestId: string,
): Extract<HostFrame, { kind: "response" }> {
  expect(frame.kind).toBe("response");
  if (frame.kind !== "response") {
    throw new Error(`Expected response, got ${frame.kind}`);
  }
  expect(frame.requestId).toBe(requestId);
  return frame;
}
