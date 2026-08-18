import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { splitConnectionManifest } from "@traycer/protocol/framework/capability-manifest";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { hostFrameSchema } from "@traycer/protocol/framework/ws-protocol";
import {
  createEpicRequestSchema,
  type CreateChatInitialMessage,
} from "@traycer/protocol/host/epic/unary-schemas";
import { getChatRunSettingsResponseSchema } from "@traycer/protocol/host/epic/chat-records";
import {
  worktreeGetBindingResponseSchema,
  worktreeCreateResponseSchema,
  worktreeSetEntryModeResponseSchema,
  workspaceBindingRemoveEntryResponseSchema,
  type WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import {
  chatSubscribeClientFrameSchema,
  chatSubscribeServerFrameSchema,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  scriptedTurnRunner,
  type TurnRequest,
  type TurnRunner,
} from "../cli-runner";
import { startHostServer, type HostServer } from "../server";

const HOST_ID = "host-local";
const RUNNER_REPLY = "hello from the local runner";

function epicRequest() {
  const now = Date.now();
  return createEpicRequestSchema.parse({
    epic: {
      id: "epic-1",
      title: "First task",
      initialUserPrompt: "hello",
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
    chat: {
      chatId: "chat-1",
      parentId: null,
      hostId: HOST_ID,
      title: "Chat",
      worktreeIntent: null,
      initialMessage: {
        messageId: "msg-user-1",
        clientActionId: "act-1",
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "hello" }],
            },
          ],
        },
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
        accountContext: { type: "PERSONAL" },
      },
    },
  });
}

async function openRpc(
  url: string,
): Promise<{ readonly ws: WebSocket; readonly pump: MessagePump }> {
  const ws = new WebSocket(url);
  const pump = attachPump(ws);
  await waitOpen(ws);
  const split = splitConnectionManifest(
    hostRpcRegistry,
    RELEASED_FLOOR_METHOD_NAMES,
  );
  ws.send(
    JSON.stringify({
      kind: "open",
      token: "local",
      manifest: split.manifest,
      optionalManifest: split.optionalManifest,
    }),
  );
  const ack = hostFrameSchema.parse(JSON.parse(await pump.next()));
  expect(ack.kind).toBe("openAck");
  return { ws, pump };
}

async function rpc(
  ws: WebSocket,
  pump: MessagePump,
  requestId: string,
  method: string,
  schemaVersion: { major: number; minor: number },
  params: unknown,
): Promise<unknown> {
  ws.send(
    JSON.stringify({
      kind: "request",
      requestId,
      method,
      schemaVersion,
      params,
    }),
  );
  return hostFrameSchema.parse(JSON.parse(await pump.next()));
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

type MessagePump = {
  readonly next: () => Promise<string>;
};

type StreamConnection = {
  readonly ws: WebSocket;
  readonly pump: MessagePump;
};

function attachPump(ws: WebSocket): MessagePump {
  const pending: string[] = [];
  const waiters: Array<(value: string) => void> = [];
  ws.on("message", (data) => {
    const text = data.toString();
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter(text);
      return;
    }
    pending.push(text);
  });
  return {
    next: () =>
      new Promise((resolve) => {
        const queued = pending.shift();
        if (queued !== undefined) {
          resolve(queued);
          return;
        }
        waiters.push(resolve);
      }),
  };
}

async function openStream(
  url: string,
  manifest: Record<string, { major: number; minor: number }>,
): Promise<StreamConnection> {
  const ws = new WebSocket(url);
  const pump = attachPump(ws);
  await waitOpen(ws);
  ws.send(
    JSON.stringify({
      kind: "open",
      token: "local",
      manifest,
    }),
  );
  expect(JSON.parse(await pump.next())).toMatchObject({ kind: "openAck" });
  return { ws, pump };
}

function sendSettings() {
  return {
    harnessId: "claude" as const,
    model: "claude-sonnet-4",
    permissionMode: "supervised" as const,
    reasoningEffort: null,
    serviceTier: null,
    agentMode: "regular" as const,
    profileId: null,
  };
}

function initialMessage(
  messageId: string,
  clientActionId: string,
  text: string,
): CreateChatInitialMessage {
  return {
    messageId,
    clientActionId,
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    },
    sender: { type: "user", userId: "local-user" },
    settings: sendSettings(),
    accountContext: { type: "PERSONAL" },
  };
}

function legacyNewWorktreeIntent(
  workspacePath: string,
  branchName: string,
): WorktreeIntent {
  return {
    entries: [
      {
        kind: "worktree",
        workspacePath,
        repoIdentifier: null,
        isPrimary: true,
        branch: {
          type: "new",
          name: branchName,
          source: "main",
          carryUncommittedChanges: false,
        },
        scripts: null,
      },
    ],
  };
}

function capturingRunner(reply: string): {
  readonly runner: TurnRunner;
  readonly requests: TurnRequest[];
} {
  const requests: TurnRequest[] = [];
  return {
    requests,
    runner: {
      async run(request, emit) {
        requests.push(request);
        emit({ kind: "text", text: reply });
        return { text: reply, sessionId: null };
      },
    },
  };
}

function blockingCapturingRunner(reply: string): {
  readonly runner: TurnRunner;
  readonly requests: TurnRequest[];
  readonly release: () => void;
} {
  const requests: TurnRequest[] = [];
  let releaseGate: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  return {
    requests,
    release: () => releaseGate?.(),
    runner: {
      async run(request, emit) {
        requests.push(request);
        await gate;
        emit({ kind: "text", text: reply });
        return { text: reply, sessionId: null };
      },
    },
  };
}

async function initializeGitWorkspace(workspace: string): Promise<void> {
  await mkdir(workspace);
  execFileSync("git", ["-C", workspace, "init", "-b", "main"]);
  execFileSync("git", ["-C", workspace, "config", "user.name", "Traycer Test"]);
  execFileSync("git", [
    "-C",
    workspace,
    "config",
    "user.email",
    "traycer@example.com",
  ]);
  await writeFile(join(workspace, "README.md"), "base\n");
  execFileSync("git", ["-C", workspace, "add", "README.md"]);
  execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);
}

const foldedWorktreeCases = [
  {
    label: "live random-collision",
    branch: {
      type: "new" as const,
      name: "feature/folded-random",
      source: "main",
      carryUncommittedChanges: false,
      collision: "random" as const,
      retryIdentity: "folded-random-retry",
    },
  },
  {
    label: "released collision-less",
    branch: {
      type: "new" as const,
      name: "feature/folded-released",
      source: "main",
      carryUncommittedChanges: false,
    },
  },
] as const;

describe("epic create and chat subscribe", () => {
  const servers: HostServer[] = [];
  const tempRoots: string[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      if (server !== undefined) {
        await server.close();
      }
    }
    for (const root of tempRoots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
  });

  it("creates an epic with a folded first turn", async () => {
    const server = await startHostServer(0, HOST_ID, {
      runner: scriptedTurnRunner([RUNNER_REPLY]),
    });
    servers.push(server);
    const { ws, pump } = await openRpc(server.websocketUrl);
    const created = await rpc(
      ws,
      pump,
      "c1",
      "epic.create",
      { major: 1, minor: 0 },
      epicRequest(),
    );
    expect(created).toMatchObject({
      kind: "response",
      error: null,
      result: {
        initialTurnStarted: true,
        task: { epic: { light: { id: "epic-1", title: "First task" } } },
      },
    });
    await server.state.waitForIdle("epic-1", "chat-1");
    const listed = await rpc(
      ws,
      pump,
      "c2",
      "epic.listTasks",
      { major: 1, minor: 2 },
      {
        limit: 20,
        filters: null,
        extensionPhaseVersion: "1.0.0",
        extensionEpicVersion: "1.0.0",
      },
    );
    expect(listed).toMatchObject({
      kind: "response",
      error: null,
      result: {
        hasMore: false,
        tasks: [{ epic: { light: { id: "epic-1" } } }],
      },
    });
    ws.close();
  });

  it.each(foldedWorktreeCases)(
    "materializes a $label Git worktree before launching the folded turn",
    async ({ branch }) => {
      const root = await mkdtemp(join(tmpdir(), "traycer-folded-worktree-"));
      tempRoots.push(root);
      const workspace = join(root, "workspace");
      const worktreeRoot = join(root, "managed");
      await initializeGitWorkspace(workspace);
      const captured = capturingRunner("created in worktree");
      const server = await startHostServer(0, HOST_ID, {
        runner: captured.runner,
        worktreeRoot,
      });
      servers.push(server);
      const rpcSocket = await openRpc(server.websocketUrl);
      const create = epicRequest();
      const seed = create.chat;
      if (seed === undefined || seed === null) {
        throw new Error("Missing folded chat fixture");
      }

      const created = await rpc(
        rpcSocket.ws,
        rpcSocket.pump,
        `folded-create-${branch.name}`,
        "epic.create",
        { major: 1, minor: 0 },
        {
          ...create,
          workspaces: [{ workspacePath: workspace }],
          chat: {
            ...seed,
            workspaceMode: "inherit",
            worktreeIntent: {
              entries: [
                {
                  kind: "worktree",
                  workspacePath: workspace,
                  repoIdentifier: null,
                  isPrimary: true,
                  branch,
                  scripts: null,
                },
              ],
            },
          },
        },
      );

      expect(created).toMatchObject({
        kind: "response",
        error: null,
        result: { initialTurnStarted: true },
      });
      await server.state.waitForIdle("epic-1", "chat-1");
      expect(captured.requests).toHaveLength(1);
      const cwd = captured.requests[0]?.cwd;
      if (cwd === null || cwd === undefined) {
        throw new Error("Folded turn did not receive a worktree cwd");
      }
      expect(cwd).not.toBe(workspace);
      expect(cwd.startsWith(worktreeRoot)).toBe(true);
      expect(
        execFileSync("git", ["-C", cwd, "branch", "--show-current"])
          .toString()
          .trim(),
      ).toBe(branch.name);

      const fetched = await rpc(
        rpcSocket.ws,
        rpcSocket.pump,
        `folded-binding-${branch.name}`,
        "worktree.getBinding",
        { major: 1, minor: 0 },
        { epicId: "epic-1", ownerId: "chat-1", ownerKind: "chat" },
      );
      if (
        typeof fetched !== "object" ||
        fetched === null ||
        !("result" in fetched)
      ) {
        throw new Error("Missing folded worktree binding response");
      }
      expect(
        worktreeGetBindingResponseSchema.parse(fetched.result),
      ).toMatchObject({
        binding: {
          entries: [
            expect.objectContaining({
              workspacePath: workspace,
              mode: "worktree",
              worktreePath: cwd,
              branch: branch.name,
              isPrimary: true,
            }),
          ],
        },
        missingWorktreePaths: [],
      });
      rpcSocket.ws.close();
    },
  );

  it("prefers an explicit folderless launch over inherited folders and a conflicting intent", async () => {
    const home = await mkdtemp(join(tmpdir(), "traycer-folderless-home-"));
    tempRoots.push(home);
    vi.stubEnv("HOME", home);
    const inheritedWorkspace = join(home, "inherited-workspace");
    await mkdir(inheritedWorkspace);
    let observedCwd: string | null = null;
    const runner: TurnRunner = {
      async run(request, emit) {
        observedCwd = request.cwd;
        emit({ kind: "text", text: "isolated" });
        return { text: "isolated", sessionId: null };
      },
    };
    const server = await startHostServer(0, HOST_ID, { runner });
    servers.push(server);
    const { ws, pump } = await openRpc(server.websocketUrl);
    const create = epicRequest();
    const seed = create.chat;
    if (seed === undefined || seed === null) {
      throw new Error("Missing folderless chat fixture");
    }
    expect(
      await rpc(
        ws,
        pump,
        "folderless-create",
        "epic.create",
        { major: 1, minor: 0 },
        {
          ...create,
          workspaces: [{ workspacePath: inheritedWorkspace }],
          chat: {
            ...seed,
            workspaceMode: "folderless",
            // Folderless is authoritative even if a stale client also sends an
            // intent. Trying to provision this non-Git folder would fail.
            worktreeIntent: legacyNewWorktreeIntent(
              inheritedWorkspace,
              "feature/must-not-be-created",
            ),
          },
        },
      ),
    ).toMatchObject({
      kind: "response",
      error: null,
      result: { initialTurnStarted: true },
    });
    await server.state.waitForIdle("epic-1", "chat-1");

    const expected = join(home, ".traycer", "epics", "epic-1");
    expect(observedCwd).toBe(expected);
    expect(observedCwd).not.toBe(inheritedWorkspace);
    expect((await stat(expected)).isDirectory()).toBe(true);
    const binding = await rpc(
      ws,
      pump,
      "folderless-binding",
      "worktree.getBinding",
      { major: 1, minor: 0 },
      { epicId: "epic-1", ownerId: "chat-1", ownerKind: "chat" },
    );
    if (
      typeof binding !== "object" ||
      binding === null ||
      !("result" in binding)
    ) {
      throw new Error("Missing folderless binding response");
    }
    expect(worktreeGetBindingResponseSchema.parse(binding.result)).toEqual({
      binding: { workspaceMode: "folderless", entries: [] },
      missingWorktreePaths: [],
    });
    ws.close();
  });

  it("creates a managed Git worktree and publishes the live binding", async () => {
    const home = await mkdtemp(join(tmpdir(), "traycer-worktree-home-"));
    tempRoots.push(home);
    vi.stubEnv("HOME", home);
    const workspace = join(home, "workspace");
    const originalLocal = join(home, "original-local");
    await mkdir(workspace);
    await mkdir(originalLocal);
    execFileSync("git", ["-C", workspace, "init", "-b", "main"]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.name",
      "Traycer Test",
    ]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.email",
      "traycer@example.com",
    ]);
    await writeFile(join(workspace, "README.md"), "base\n");
    execFileSync("git", ["-C", workspace, "add", "README.md"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);
    await writeFile(join(workspace, "README.md"), "base\nworking copy\n");
    await mkdir(join(workspace, "notes"));
    await writeFile(join(workspace, "notes", "draft.txt"), "untracked\n");
    await mkdir(join(workspace, ".traycer"));
    const carriedEnvironment = {
      setup: {
        default: "carried setup",
        macos: null,
        windows: null,
        linux: null,
      },
      teardown: {
        default: "carried teardown",
        macos: null,
        windows: null,
        linux: null,
      },
      updatedAt: 1,
    };
    await writeFile(
      join(workspace, ".traycer", "environment.json"),
      JSON.stringify(carriedEnvironment),
    );
    const requestedScripts = {
      setup: { default: "", macos: null, windows: null, linux: null },
      teardown: {
        default: "cleanup",
        macos: null,
        windows: null,
        linux: null,
      },
    };

    let observedCwd: string | null = null;
    const runner: TurnRunner = {
      async run(request, emit) {
        observedCwd = request.cwd;
        emit({ kind: "text", text: "inside the worktree" });
        return { text: "inside the worktree", sessionId: null };
      },
    };
    const server = await startHostServer(0, HOST_ID, {
      runner,
      worktreeRoot: join(home, ".traycer", "worktrees"),
    });
    servers.push(server);
    const rpcSocket = await openRpc(server.websocketUrl);
    const create = epicRequest();
    const seed = create.chat;
    if (seed === undefined || seed === null) {
      throw new Error("Missing chat fixture");
    }
    await rpc(
      rpcSocket.ws,
      rpcSocket.pump,
      "worktree-epic",
      "epic.create",
      { major: 1, minor: 0 },
      { ...create, chat: { ...seed, initialMessage: null } },
    );
    await rpc(
      rpcSocket.ws,
      rpcSocket.pump,
      "worktree-original-local",
      "worktree.setEntryMode",
      { major: 1, minor: 0 },
      {
        epicId: "epic-1",
        ownerId: "chat-1",
        ownerKind: "chat",
        workspacePath: originalLocal,
      },
    );
    const stream = await openStream(
      server.websocketUrl.replace("/rpc", "/stream"),
      { "chat.subscribe": { major: 1, minor: 6 } },
    );
    stream.ws.send(
      JSON.stringify({
        kind: "subscribe",
        method: "chat.subscribe",
        schemaVersion: { major: 1, minor: 6 },
        params: { epicId: "epic-1", chatId: "chat-1" },
      }),
    );
    expect(JSON.parse(await stream.pump.next())).toMatchObject({
      kind: "snapshot",
      snapshot: {
        worktreeBinding: {
          entries: [
            {
              workspacePath: originalLocal,
              mode: "local",
              isPrimary: true,
            },
          ],
        },
      },
    });

    server.state.reserveTurn("epic-1", "chat-1");
    expect(
      await rpc(
        rpcSocket.ws,
        rpcSocket.pump,
        "worktree-create-active",
        "worktree.create",
        { major: 1, minor: 0 },
        {
          epicId: "epic-1",
          ownerId: "chat-1",
          ownerKind: "chat",
          entries: [],
        },
      ),
    ).toMatchObject({
      kind: "response",
      result: null,
      error: {
        code: "WORKTREE_REBIND_BLOCKED",
        message: "Stop the active chat run before rebinding its worktree.",
      },
    });
    server.state.releaseTurn("epic-1", "chat-1");

    const response = await rpc(
      rpcSocket.ws,
      rpcSocket.pump,
      "worktree-create",
      "worktree.create",
      { major: 1, minor: 0 },
      {
        epicId: "epic-1",
        ownerId: "chat-1",
        ownerKind: "chat",
        entries: [
          {
            kind: "worktree",
            workspacePath: workspace,
            repoIdentifier: { owner: "Acme", repo: "Workspace" },
            isPrimary: true,
            branch: {
              type: "new",
              name: "feature/local-host",
              source: "main",
              carryUncommittedChanges: true,
            },
            scripts: requestedScripts,
          },
        ],
      },
    );
    if (
      typeof response !== "object" ||
      response === null ||
      !("result" in response)
    ) {
      throw new Error("Missing worktree.create result");
    }
    const result = worktreeCreateResponseSchema.parse(response.result);
    const created = result.binding.entries.find(
      (entry) => entry.workspacePath === workspace,
    );
    expect(response).toMatchObject({ kind: "response", error: null });
    expect(result.perEntry).toEqual([
      {
        workspacePath: workspace,
        ok: true,
        worktreePath: created?.worktreePath,
        branch: "feature/local-host",
        errorMessage: null,
      },
    ]);
    expect(created).toMatchObject({
      workspacePath: workspace,
      mode: "worktree",
      repoIdentifier: { owner: "Acme", repo: "Workspace" },
      branch: "feature/local-host",
      isPrimary: true,
      isImported: false,
      setupState: "not_required",
      setupTerminalSessionId: null,
      setupExitCode: null,
      setupFailedAt: null,
      ownedSubmodules: [],
    });
    expect(result.binding.entries[0]).toMatchObject({
      workspacePath: originalLocal,
      mode: "local",
      isPrimary: false,
    });
    if (created?.worktreePath === null || created?.worktreePath === undefined) {
      throw new Error("Missing managed worktree path");
    }
    expect(
      created.worktreePath.startsWith(join(home, ".traycer", "worktrees")),
    ).toBe(true);
    expect(
      execFileSync("git", [
        "-C",
        created.worktreePath,
        "branch",
        "--show-current",
      ])
        .toString()
        .trim(),
    ).toBe("feature/local-host");
    expect(
      await readFile(join(created.worktreePath, "README.md"), "utf8"),
    ).toBe("base\nworking copy\n");
    expect(
      await readFile(join(created.worktreePath, "notes", "draft.txt"), "utf8"),
    ).toBe("untracked\n");
    expect(
      JSON.parse(
        await readFile(
          join(created.worktreePath, ".traycer", "environment.json"),
          "utf8",
        ),
      ),
    ).toEqual({ ...requestedScripts, updatedAt: expect.any(Number) });
    expect(
      JSON.parse(
        await readFile(join(workspace, ".traycer", "environment.json"), "utf8"),
      ),
    ).toEqual(carriedEnvironment);
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
      "base\nworking copy\n",
    );
    expect(
      await waitForFrame(stream.pump, (frame) => {
        return (
          typeof frame === "object" &&
          frame !== null &&
          "kind" in frame &&
          frame.kind === "worktreeStateChanged"
        );
      }),
    ).toMatchObject({
      kind: "worktreeStateChanged",
      worktreeBinding: {
        entries: [
          {
            workspacePath: originalLocal,
            mode: "local",
            isPrimary: false,
          },
          {
            workspacePath: workspace,
            worktreePath: created.worktreePath,
            branch: "feature/local-host",
          },
        ],
      },
      missingWorktreePaths: [],
    });
    const freshRpc = await openRpc(server.websocketUrl);
    const fetched = await rpc(
      freshRpc.ws,
      freshRpc.pump,
      "worktree-read-fresh-socket",
      "worktree.getBinding",
      { major: 1, minor: 0 },
      { epicId: "epic-1", ownerId: "chat-1", ownerKind: "chat" },
    );
    if (
      typeof fetched !== "object" ||
      fetched === null ||
      !("result" in fetched)
    ) {
      throw new Error("Missing worktree.getBinding result");
    }
    expect(worktreeGetBindingResponseSchema.parse(fetched.result)).toEqual({
      binding: result.binding,
      missingWorktreePaths: [],
    });

    const nonGit = join(home, "not-a-repository");
    await mkdir(nonGit);
    const partial = await rpc(
      rpcSocket.ws,
      rpcSocket.pump,
      "worktree-partial-failure",
      "worktree.create",
      { major: 1, minor: 0 },
      {
        epicId: "epic-1",
        ownerId: "chat-1",
        ownerKind: "chat",
        entries: [
          {
            kind: "worktree",
            workspacePath: nonGit,
            repoIdentifier: null,
            isPrimary: false,
            branch: {
              type: "new",
              name: "feature/cannot-create",
              source: "main",
              carryUncommittedChanges: false,
            },
            scripts: null,
          },
        ],
      },
    );
    expect(partial).toMatchObject({ kind: "response", error: null });
    if (
      typeof partial !== "object" ||
      partial === null ||
      !("result" in partial)
    ) {
      throw new Error("Missing partial worktree.create result");
    }
    expect(worktreeCreateResponseSchema.parse(partial.result)).toEqual({
      binding: result.binding,
      perEntry: [
        {
          workspacePath: nonGit,
          ok: false,
          worktreePath: null,
          branch: "feature/cannot-create",
          errorMessage: `Workspace is not a git repository: ${nonGit}`,
        },
      ],
    });

    stream.ws.send(
      JSON.stringify(
        chatSubscribeClientFrameSchema.parse({
          kind: "send",
          hasBinaryPayload: false,
          epicId: "epic-1",
          chatId: "chat-1",
          clientActionId: "worktree-send",
          messageId: "worktree-message",
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "run from the worktree" }],
              },
            ],
          },
          sender: { type: "user", userId: "local-user" },
          settings: sendSettings(),
          accountContext: { type: "PERSONAL" },
        }),
      ),
    );
    await waitForFrame(stream.pump, (frame) => {
      return (
        typeof frame === "object" &&
        frame !== null &&
        "kind" in frame &&
        frame.kind === "actionAck"
      );
    });
    await server.state.waitForIdle("epic-1", "chat-1");
    expect(observedCwd).toBe(created.worktreePath);
    freshRpc.ws.close();
    stream.ws.close();
    rpcSocket.ws.close();
  });

  it("adds and removes a Local folder through the live chat binding", async () => {
    let observedCwd: string | null = null;
    const runner: TurnRunner = {
      async run(request, emit) {
        observedCwd = request.cwd;
        emit({ kind: "text", text: "bound" });
        return { text: "bound", sessionId: null };
      },
    };
    const server = await startHostServer(0, HOST_ID, { runner });
    servers.push(server);
    const rpcSocket = await openRpc(server.websocketUrl);
    const create = epicRequest();
    const seed = create.chat;
    if (seed === undefined || seed === null) {
      throw new Error("Missing chat fixture");
    }
    await rpc(
      rpcSocket.ws,
      rpcSocket.pump,
      "binding-create",
      "epic.create",
      { major: 1, minor: 0 },
      { ...create, chat: { ...seed, initialMessage: null } },
    );
    const stream = await openStream(
      server.websocketUrl.replace("/rpc", "/stream"),
      { "chat.subscribe": { major: 1, minor: 6 } },
    );
    stream.ws.send(
      JSON.stringify({
        kind: "subscribe",
        method: "chat.subscribe",
        schemaVersion: { major: 1, minor: 6 },
        params: { epicId: "epic-1", chatId: "chat-1" },
      }),
    );
    expect(JSON.parse(await stream.pump.next())).toMatchObject({
      kind: "snapshot",
      snapshot: { worktreeBinding: null },
    });

    const changed = await rpc(
      rpcSocket.ws,
      rpcSocket.pump,
      "binding-local",
      "worktree.setEntryMode",
      { major: 1, minor: 0 },
      {
        epicId: "epic-1",
        ownerId: "chat-1",
        ownerKind: "chat",
        workspacePath: process.cwd(),
        hostId: "old-client-extra",
        mode: "worktree",
      },
    );
    expect(changed).toMatchObject({ kind: "response", error: null });
    if (
      typeof changed !== "object" ||
      changed === null ||
      !("result" in changed)
    ) {
      throw new Error("Missing setEntryMode result");
    }
    expect(worktreeSetEntryModeResponseSchema.parse(changed.result)).toEqual({
      binding: {
        entries: [
          {
            workspacePath: process.cwd(),
            mode: "local",
            repoIdentifier: null,
            worktreePath: null,
            branch: null,
            isPrimary: true,
            isImported: false,
            setupState: "not_required",
            setupTerminalSessionId: null,
            setupExitCode: null,
            setupFailedAt: null,
            createdAt: expect.any(Number),
            ownedSubmodules: [],
          },
        ],
      },
    });
    expect(
      await waitForFrame(stream.pump, (frame) => {
        return (
          typeof frame === "object" &&
          frame !== null &&
          "kind" in frame &&
          frame.kind === "worktreeStateChanged"
        );
      }),
    ).toMatchObject({
      kind: "worktreeStateChanged",
      worktreeBinding: {
        entries: [{ workspacePath: process.cwd(), mode: "local" }],
      },
      missingWorktreePaths: [],
    });

    const fetched = await rpc(
      rpcSocket.ws,
      rpcSocket.pump,
      "binding-get",
      "worktree.getBinding",
      { major: 1, minor: 0 },
      { epicId: "epic-1", ownerId: "chat-1", ownerKind: "chat" },
    );
    if (
      typeof fetched !== "object" ||
      fetched === null ||
      !("result" in fetched)
    ) {
      throw new Error("Missing getBinding result");
    }
    expect(
      worktreeGetBindingResponseSchema.parse(fetched.result),
    ).toMatchObject({
      binding: {
        entries: [{ workspacePath: process.cwd(), mode: "local" }],
      },
      missingWorktreePaths: [],
    });

    stream.ws.send(
      JSON.stringify(
        chatSubscribeClientFrameSchema.parse({
          kind: "send",
          hasBinaryPayload: false,
          epicId: "epic-1",
          chatId: "chat-1",
          clientActionId: "binding-send",
          messageId: "binding-message",
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "use the folder" }],
              },
            ],
          },
          sender: { type: "user", userId: "local-user" },
          settings: sendSettings(),
          accountContext: { type: "PERSONAL" },
        }),
      ),
    );
    await waitForFrame(stream.pump, (frame) => {
      return (
        typeof frame === "object" &&
        frame !== null &&
        "kind" in frame &&
        frame.kind === "actionAck"
      );
    });
    await server.state.waitForIdle("epic-1", "chat-1");
    expect(observedCwd).toBe(process.cwd());

    const removed = await rpc(
      rpcSocket.ws,
      rpcSocket.pump,
      "binding-remove",
      "workspaceBinding.removeEntry",
      { major: 1, minor: 0 },
      {
        epicId: "epic-1",
        ownerId: "chat-1",
        ownerKind: "chat",
        workspacePath: process.cwd(),
        hostId: "old-client-extra",
        mode: "worktree",
      },
    );
    if (
      typeof removed !== "object" ||
      removed === null ||
      !("result" in removed)
    ) {
      throw new Error("Missing removeEntry result");
    }
    expect(
      workspaceBindingRemoveEntryResponseSchema.parse(removed.result),
    ).toEqual({ binding: { workspaceMode: "folderless", entries: [] } });
    expect(
      await waitForFrame(stream.pump, (frame) => {
        return (
          typeof frame === "object" &&
          frame !== null &&
          "kind" in frame &&
          frame.kind === "worktreeStateChanged"
        );
      }),
    ).toMatchObject({
      kind: "worktreeStateChanged",
      worktreeBinding: { workspaceMode: "folderless", entries: [] },
      missingWorktreePaths: [],
    });
    const afterRemoval = await rpc(
      rpcSocket.ws,
      rpcSocket.pump,
      "binding-after-remove",
      "worktree.getBinding",
      { major: 1, minor: 0 },
      { epicId: "epic-1", ownerId: "chat-1", ownerKind: "chat" },
    );
    if (
      typeof afterRemoval !== "object" ||
      afterRemoval === null ||
      !("result" in afterRemoval)
    ) {
      throw new Error("Missing getBinding result after removal");
    }
    expect(worktreeGetBindingResponseSchema.parse(afterRemoval.result)).toEqual(
      {
        binding: { workspaceMode: "folderless", entries: [] },
        missingWorktreePaths: [],
      },
    );
    stream.ws.close();
    rpcSocket.ws.close();
  });

  it("persists command and tool outcomes through the canonical accumulator", async () => {
    const runner: TurnRunner = {
      async run(_request, emit) {
        emit({
          kind: "command_start",
          blockId: "command-1",
          command: "pwd",
          cwd: "/workspace",
        });
        emit({
          kind: "command_end",
          blockId: "command-1",
          command: "pwd",
          exitCode: 0,
        });
        emit({
          kind: "tool_start",
          blockId: "tool-1",
          name: "files/read",
          input: { path: "a.txt" },
        });
        emit({ kind: "tool_end", blockId: "tool-1", name: "files/read" });
        emit({
          kind: "tool_start",
          blockId: "tool-2",
          name: "tools/search",
          input: { query: "needle" },
        });
        emit({
          kind: "tool_error",
          blockId: "tool-2",
          name: "tools/search",
          error: "search failed",
        });
        emit({ kind: "text", text: "done" });
        return { text: "done", sessionId: "session-1" };
      },
    };
    const server = await startHostServer(0, HOST_ID, { runner });
    servers.push(server);
    const { ws, pump } = await openRpc(server.websocketUrl);
    await rpc(
      ws,
      pump,
      "rich-create",
      "epic.create",
      { major: 1, minor: 0 },
      epicRequest(),
    );
    await server.state.waitForIdle("epic-1", "chat-1");

    const chat = server.state.getChat("epic-1", "chat-1");
    const assistant = chat?.messages.find(
      (message) => message.role === "assistant",
    );
    expect(assistant?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "command",
          blockId: "command-1",
          status: "completed",
          command: "pwd",
          cwd: "/workspace",
          exitCode: 0,
        }),
        expect.objectContaining({
          type: "tool_call",
          blockId: "tool-1",
          status: "completed",
          toolName: "files/read",
        }),
        expect.objectContaining({
          type: "tool_call",
          blockId: "tool-2",
          status: "errored",
          toolName: "tools/search",
          error: "search failed",
        }),
      ]),
    );
    ws.close();
  });

  it("persists the runner reply on the folded first turn", async () => {
    const server = await startHostServer(0, HOST_ID, {
      runner: scriptedTurnRunner([RUNNER_REPLY]),
    });
    servers.push(server);
    const rpcSocket = await openRpc(server.websocketUrl);
    await rpc(
      rpcSocket.ws,
      rpcSocket.pump,
      "c1",
      "epic.create",
      { major: 1, minor: 0 },
      epicRequest(),
    );
    await server.state.waitForIdle("epic-1", "chat-1");

    const stream = await openStream(
      server.websocketUrl.replace("/rpc", "/stream"),
      {
        "chat.subscribe": { major: 1, minor: 6 },
      },
    );
    stream.ws.send(
      JSON.stringify({
        kind: "subscribe",
        method: "chat.subscribe",
        schemaVersion: { major: 1, minor: 6 },
        params: { epicId: "epic-1", chatId: "chat-1" },
      }),
    );
    const snapshot = JSON.parse(await stream.pump.next());
    expect(snapshot.kind).toBe("snapshot");
    expect(snapshot.snapshot.chat.messages).toHaveLength(2);
    expect(snapshot.snapshot.chat.messages[1]?.blocks?.[0]?.text).toBe(
      RUNNER_REPLY,
    );
    expect(snapshot.snapshot.runStatus).toBe("idle");
    stream.ws.close();
    rpcSocket.ws.close();
  });

  it("renames, reparents, and idempotently deletes a chat through RPC", async () => {
    const server = await startHostServer(0, HOST_ID, {
      runner: scriptedTurnRunner([]),
    });
    servers.push(server);
    const rpcSocket = await openRpc(server.websocketUrl);
    const create = epicRequest();
    const seed = create.chat;
    if (seed === undefined || seed === null) {
      throw new Error("Missing chat seed");
    }
    await rpc(
      rpcSocket.ws,
      rpcSocket.pump,
      "chat-mutations-create",
      "epic.create",
      { major: 1, minor: 0 },
      { ...create, chat: { ...seed, initialMessage: null } },
    );

    expect(
      await rpc(
        rpcSocket.ws,
        rpcSocket.pump,
        "chat-rename",
        "epic.renameChat",
        { major: 1, minor: 0 },
        { epicId: "epic-1", chatId: "chat-1", title: "Renamed chat" },
      ),
    ).toMatchObject({
      kind: "response",
      error: null,
      result: { updated: true },
    });
    expect(
      await rpc(
        rpcSocket.ws,
        rpcSocket.pump,
        "chat-reparent",
        "epic.reparentChat",
        { major: 1, minor: 0 },
        {
          epicId: "epic-1",
          chatId: "chat-1",
          newParentId: "unvalidated-parent",
        },
      ),
    ).toMatchObject({
      kind: "response",
      error: null,
      result: { updated: true },
    });

    const stream = await openStream(
      server.websocketUrl.replace("/rpc", "/stream"),
      { "chat.subscribe": { major: 1, minor: 6 } },
    );
    stream.ws.send(
      JSON.stringify({
        kind: "subscribe",
        method: "chat.subscribe",
        schemaVersion: { major: 1, minor: 6 },
        params: { epicId: "epic-1", chatId: "chat-1" },
      }),
    );
    expect(JSON.parse(await stream.pump.next())).toMatchObject({
      kind: "snapshot",
      snapshot: {
        chat: {
          title: "Renamed chat",
          isTitleEditedByUser: true,
          parentId: "unvalidated-parent",
        },
      },
    });
    stream.ws.close();

    expect(
      await rpc(
        rpcSocket.ws,
        rpcSocket.pump,
        "chat-delete",
        "epic.deleteChat",
        { major: 1, minor: 0 },
        { epicId: "epic-1", chatId: "chat-1" },
      ),
    ).toMatchObject({
      kind: "response",
      error: null,
      result: { deleted: true },
    });
    expect(server.state.getChat("epic-1", "chat-1")).toBeNull();
    expect(
      await rpc(
        rpcSocket.ws,
        rpcSocket.pump,
        "chat-delete-again",
        "epic.deleteChat",
        { major: 1, minor: 0 },
        { epicId: "epic-1", chatId: "chat-1" },
      ),
    ).toMatchObject({
      kind: "response",
      error: null,
      result: { deleted: true },
    });
    rpcSocket.ws.close();
  });

  it("archives a chat through RPC and publishes fresh chat snapshots", async () => {
    const server = await startHostServer(0, HOST_ID, {
      runner: scriptedTurnRunner([]),
    });
    servers.push(server);
    const rpcSocket = await openRpc(server.websocketUrl);
    const create = epicRequest();
    const seed = create.chat;
    if (seed === undefined || seed === null) {
      throw new Error("Missing chat seed");
    }
    await rpc(
      rpcSocket.ws,
      rpcSocket.pump,
      "archive-create",
      "epic.create",
      { major: 1, minor: 0 },
      { ...create, chat: { ...seed, initialMessage: null } },
    );

    const stream = await openStream(
      server.websocketUrl.replace("/rpc", "/stream"),
      { "chat.subscribe": { major: 1, minor: 6 } },
    );
    stream.ws.send(
      JSON.stringify({
        kind: "subscribe",
        method: "chat.subscribe",
        schemaVersion: { major: 1, minor: 6 },
        params: { epicId: "epic-1", chatId: "chat-1" },
      }),
    );
    expect(JSON.parse(await stream.pump.next())).toMatchObject({
      kind: "snapshot",
      snapshot: { chat: { archivedAt: null } },
    });

    expect(
      await rpc(
        rpcSocket.ws,
        rpcSocket.pump,
        "archive-chat",
        "epic.setChatArchived",
        { major: 1, minor: 0 },
        { epicId: "epic-1", chatId: "chat-1", archived: true },
      ),
    ).toMatchObject({
      kind: "response",
      error: null,
      result: { updated: true },
    });
    const archived = JSON.parse(await stream.pump.next());
    expect(archived).toMatchObject({
      kind: "snapshot",
      snapshot: { chat: { archivedAt: expect.any(Number) } },
    });

    expect(
      await rpc(
        rpcSocket.ws,
        rpcSocket.pump,
        "archive-chat-again",
        "epic.setChatArchived",
        { major: 1, minor: 0 },
        { epicId: "epic-1", chatId: "chat-1", archived: true },
      ),
    ).toMatchObject({
      kind: "response",
      error: null,
      result: { updated: false },
    });

    expect(
      await rpc(
        rpcSocket.ws,
        rpcSocket.pump,
        "unarchive-chat",
        "epic.setChatArchived",
        { major: 1, minor: 0 },
        { epicId: "epic-1", chatId: "chat-1", archived: false },
      ),
    ).toMatchObject({
      kind: "response",
      error: null,
      result: { updated: true },
    });
    expect(JSON.parse(await stream.pump.next())).toMatchObject({
      kind: "snapshot",
      snapshot: { chat: { archivedAt: null } },
    });

    stream.ws.close();
    rpcSocket.ws.close();
  });

  it("persists and reads chat run settings through optional RPCs", async () => {
    const server = await startHostServer(0, HOST_ID, {
      runner: scriptedTurnRunner([]),
    });
    servers.push(server);
    const rpcSocket = await openRpc(server.websocketUrl);
    const create = epicRequest();
    const seed = create.chat;
    if (seed === undefined || seed === null) {
      throw new Error("Missing chat seed");
    }
    await rpc(
      rpcSocket.ws,
      rpcSocket.pump,
      "settings-create",
      "epic.create",
      { major: 1, minor: 0 },
      { ...create, chat: { ...seed, initialMessage: null } },
    );

    const emptyRead = await rpc(
      rpcSocket.ws,
      rpcSocket.pump,
      "settings-empty-read",
      "epic.getChatRunSettings",
      { major: 1, minor: 0 },
      { epicId: "epic-1", chatId: "chat-1" },
    );
    if (
      typeof emptyRead !== "object" ||
      emptyRead === null ||
      !("result" in emptyRead)
    ) {
      throw new Error("Expected empty settings response");
    }
    expect(getChatRunSettingsResponseSchema.parse(emptyRead.result)).toEqual({
      settings: null,
    });

    expect(
      await rpc(
        rpcSocket.ws,
        rpcSocket.pump,
        "settings-partial-v11",
        "epic.updateChatRunSettings",
        { major: 1, minor: 1 },
        {
          epicId: "epic-1",
          chatId: "chat-1",
          settings: {
            harnessId: "codex",
            model: "gpt-5.4",
            permissionMode: "full_access",
            reasoningEffort: "high",
            agentMode: "regular",
          },
        },
      ),
    ).toMatchObject({
      kind: "response",
      result: null,
      error: { code: "RPC_ERROR" },
    });
    const readAfterRejectedPartial = await rpc(
      rpcSocket.ws,
      rpcSocket.pump,
      "settings-read-after-rejected-partial",
      "epic.getChatRunSettings",
      { major: 1, minor: 0 },
      { epicId: "epic-1", chatId: "chat-1" },
    );
    if (
      typeof readAfterRejectedPartial !== "object" ||
      readAfterRejectedPartial === null ||
      !("result" in readAfterRejectedPartial)
    ) {
      throw new Error("Expected settings response after rejected partial");
    }
    expect(
      getChatRunSettingsResponseSchema.parse(readAfterRejectedPartial.result),
    ).toEqual({ settings: null });

    expect(
      await rpc(
        rpcSocket.ws,
        rpcSocket.pump,
        "settings-update-v10",
        "epic.updateChatRunSettings",
        { major: 1, minor: 0 },
        {
          epicId: "epic-1",
          chatId: "chat-1",
          settings: {
            harnessId: "codex",
            model: "gpt-5.4",
            permissionMode: "full_access",
            reasoningEffort: "high",
            agentMode: "regular",
          },
        },
      ),
    ).toMatchObject({
      kind: "response",
      error: null,
      result: { updated: true },
    });
    const firstRead = await rpc(
      rpcSocket.ws,
      rpcSocket.pump,
      "settings-read",
      "epic.getChatRunSettings",
      { major: 1, minor: 0 },
      { epicId: "epic-1", chatId: "chat-1" },
    );
    if (
      typeof firstRead !== "object" ||
      firstRead === null ||
      !("result" in firstRead)
    ) {
      throw new Error("Expected settings response");
    }
    expect(getChatRunSettingsResponseSchema.parse(firstRead.result)).toEqual({
      settings: {
        harnessId: "codex",
        model: "gpt-5.4",
        permissionMode: "full_access",
        reasoningEffort: "high",
        serviceTier: null,
        agentMode: "regular",
        profileId: null,
      },
    });

    expect(
      await rpc(
        rpcSocket.ws,
        rpcSocket.pump,
        "settings-missing-profile",
        "epic.updateChatProfile",
        { major: 1, minor: 0 },
        { epicId: "epic-1", chatId: "chat-1", profileId: "profile-1" },
      ),
    ).toMatchObject({
      kind: "response",
      error: {
        code: "RPC_ERROR",
        message: 'No profile "profile-1" is registered for provider "codex".',
      },
      result: null,
    });

    const stream = await openStream(
      server.websocketUrl.replace("/rpc", "/stream"),
      { "chat.subscribe": { major: 1, minor: 6 } },
    );
    stream.ws.send(
      JSON.stringify({
        kind: "subscribe",
        method: "chat.subscribe",
        schemaVersion: { major: 1, minor: 6 },
        params: { epicId: "epic-1", chatId: "chat-1" },
      }),
    );
    expect(JSON.parse(await stream.pump.next())).toMatchObject({
      kind: "snapshot",
      snapshot: {
        chat: {
          settings: {
            harnessId: "codex",
            model: "gpt-5.4",
            profileId: null,
          },
        },
      },
    });

    stream.ws.close();
    rpcSocket.ws.close();
  });

  it("persists settings carried only by createChat's initial message", async () => {
    const server = await startHostServer(0, HOST_ID, {
      runner: scriptedTurnRunner(["created"]),
    });
    servers.push(server);
    const rpcSocket = await openRpc(server.websocketUrl);
    const create = epicRequest();
    await rpc(
      rpcSocket.ws,
      rpcSocket.pump,
      "initial-settings-epic",
      "epic.create",
      { major: 1, minor: 0 },
      { ...create, chat: null },
    );
    const settings = sendSettings();
    expect(
      await rpc(
        rpcSocket.ws,
        rpcSocket.pump,
        "initial-settings-chat",
        "epic.createChat",
        { major: 1, minor: 1 },
        {
          epicId: "epic-1",
          chatId: "initial-settings-chat",
          parentId: null,
          hostId: HOST_ID,
          title: "Initial settings chat",
          initialMessage: {
            messageId: "initial-settings-message",
            clientActionId: "initial-settings-action",
            content: { type: "doc", content: [] },
            sender: { type: "user", userId: "local-user" },
            settings,
            accountContext: { type: "PERSONAL" },
          },
        },
      ),
    ).toMatchObject({
      kind: "response",
      error: null,
      result: {
        chatId: "initial-settings-chat",
        initialTurnStarted: true,
      },
    });
    await server.state.waitForIdle("epic-1", "initial-settings-chat");

    const read = await rpc(
      rpcSocket.ws,
      rpcSocket.pump,
      "initial-settings-read",
      "epic.getChatRunSettings",
      { major: 1, minor: 0 },
      { epicId: "epic-1", chatId: "initial-settings-chat" },
    );
    if (typeof read !== "object" || read === null || !("result" in read)) {
      throw new Error("Expected initial settings response");
    }
    expect(getChatRunSettingsResponseSchema.parse(read.result)).toEqual({
      settings,
    });

    const stream = await openStream(
      server.websocketUrl.replace("/rpc", "/stream"),
      { "chat.subscribe": { major: 1, minor: 6 } },
    );
    stream.ws.send(
      JSON.stringify({
        kind: "subscribe",
        method: "chat.subscribe",
        schemaVersion: { major: 1, minor: 6 },
        params: { epicId: "epic-1", chatId: "initial-settings-chat" },
      }),
    );
    expect(JSON.parse(await stream.pump.next())).toMatchObject({
      kind: "snapshot",
      snapshot: { chat: { settings } },
    });

    stream.ws.close();
    rpcSocket.ws.close();
  });

  it("keeps an empty chat row without launching when createChat worktree provisioning fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-create-chat-failure-"));
    tempRoots.push(root);
    const nonGit = join(root, "not-a-repository");
    await mkdir(nonGit);
    const captured = capturingRunner("must not run");
    const server = await startHostServer(0, HOST_ID, {
      runner: captured.runner,
      worktreeRoot: join(root, "managed"),
    });
    servers.push(server);
    const rpcSocket = await openRpc(server.websocketUrl);
    const create = epicRequest();
    await rpc(
      rpcSocket.ws,
      rpcSocket.pump,
      "create-chat-failure-epic",
      "epic.create",
      { major: 1, minor: 0 },
      { ...create, chat: null },
    );

    // The signed host tolerates per-entry failures here. This local host is
    // deliberately fail-closed: keep the already-created row, but do not
    // accept the initial message or start a provider turn.
    expect(
      await rpc(
        rpcSocket.ws,
        rpcSocket.pump,
        "create-chat-failure",
        "epic.createChat",
        { major: 1, minor: 1 },
        {
          epicId: "epic-1",
          chatId: "failed-chat",
          parentId: null,
          hostId: HOST_ID,
          title: "Failed worktree chat",
          workspaceMode: "inherit",
          worktreeIntent: legacyNewWorktreeIntent(
            nonGit,
            "feature/cannot-create-chat",
          ),
          initialMessage: initialMessage(
            "failed-chat-message",
            "failed-chat-action",
            "do not persist me",
          ),
        },
      ),
    ).toMatchObject({
      kind: "response",
      result: null,
      error: {
        code: "WORKTREE_CREATE_FAILED",
        message: expect.stringContaining(
          `Workspace is not a git repository: ${nonGit}`,
        ),
      },
    });
    expect(captured.requests).toEqual([]);

    const stream = await openStream(
      server.websocketUrl.replace("/rpc", "/stream"),
      { "chat.subscribe": { major: 1, minor: 6 } },
    );
    stream.ws.send(
      JSON.stringify({
        kind: "subscribe",
        method: "chat.subscribe",
        schemaVersion: { major: 1, minor: 6 },
        params: { epicId: "epic-1", chatId: "failed-chat" },
      }),
    );
    expect(
      chatSubscribeServerFrameSchema.parse(
        JSON.parse(await stream.pump.next()),
      ),
    ).toMatchObject({
      kind: "snapshot",
      snapshot: {
        chat: { id: "failed-chat", messages: [] },
        runStatus: "idle",
        activeTurn: null,
        turnInProgress: false,
      },
    });

    stream.ws.close();
    rpcSocket.ws.close();
  });

  it("rejects a send before persisting its message when worktree provisioning fails", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "traycer-send-worktree-failure-"),
    );
    tempRoots.push(root);
    const nonGit = join(root, "not-a-repository");
    await mkdir(nonGit);
    const captured = capturingRunner("must not run");
    const server = await startHostServer(0, HOST_ID, {
      runner: captured.runner,
      worktreeRoot: join(root, "managed"),
    });
    servers.push(server);
    const rpcSocket = await openRpc(server.websocketUrl);
    const create = epicRequest();
    const seed = create.chat;
    if (seed === undefined || seed === null) {
      throw new Error("Missing send failure chat fixture");
    }
    await rpc(
      rpcSocket.ws,
      rpcSocket.pump,
      "send-failure-epic",
      "epic.create",
      { major: 1, minor: 0 },
      { ...create, chat: { ...seed, initialMessage: null } },
    );

    const stream = await openStream(
      server.websocketUrl.replace("/rpc", "/stream"),
      { "chat.subscribe": { major: 1, minor: 6 } },
    );
    stream.ws.send(
      JSON.stringify({
        kind: "subscribe",
        method: "chat.subscribe",
        schemaVersion: { major: 1, minor: 6 },
        params: { epicId: "epic-1", chatId: "chat-1" },
      }),
    );
    expect(JSON.parse(await stream.pump.next())).toMatchObject({
      kind: "snapshot",
      snapshot: { chat: { messages: [] } },
    });

    stream.ws.send(
      JSON.stringify(
        chatSubscribeClientFrameSchema.parse({
          kind: "send",
          hasBinaryPayload: false,
          epicId: "epic-1",
          chatId: "chat-1",
          clientActionId: "failed-send-action",
          messageId: "failed-send-message",
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "do not persist me" }],
              },
            ],
          },
          sender: { type: "user", userId: "local-user" },
          settings: sendSettings(),
          accountContext: { type: "PERSONAL" },
          worktreeIntent: legacyNewWorktreeIntent(
            nonGit,
            "feature/cannot-send",
          ),
        }),
      ),
    );
    const ack = chatSubscribeServerFrameSchema.parse(
      await waitForFrame(stream.pump, (frame) => {
        return (
          typeof frame === "object" &&
          frame !== null &&
          "kind" in frame &&
          frame.kind === "actionAck" &&
          "clientActionId" in frame &&
          frame.clientActionId === "failed-send-action"
        );
      }),
    );
    // Unlike the signed host's richer setup lifecycle, the local host rejects
    // at its safety boundary and must leave neither a prompt nor a new turn.
    expect(ack).toMatchObject({
      kind: "actionAck",
      clientActionId: "failed-send-action",
      action: "send",
      status: "rejected",
      code: "WORKTREE_CREATE_FAILED",
      reason: expect.stringContaining(
        `Workspace is not a git repository: ${nonGit}`,
      ),
    });
    const failedEvent = chatSubscribeServerFrameSchema.parse(
      await waitForFrame(stream.pump, (frame) => {
        return (
          typeof frame === "object" &&
          frame !== null &&
          "kind" in frame &&
          frame.kind === "eventAppended"
        );
      }),
    );
    expect(failedEvent).toMatchObject({
      kind: "eventAppended",
      event: {
        type: "send.failed",
        clientActionId: "failed-send-action",
        actor: { type: "user", userId: "local-user" },
        message: expect.stringContaining(
          `Workspace is not a git repository: ${nonGit}`,
        ),
        turnId: null,
        messageId: "failed-send-message",
        queueItemId: null,
        approvalId: null,
        blockId: null,
        severity: "warning",
        metadata: null,
      },
    });
    expect(
      chatSubscribeServerFrameSchema.parse(
        await waitForFrame(stream.pump, (frame) => {
          return (
            typeof frame === "object" &&
            frame !== null &&
            "kind" in frame &&
            frame.kind === "errorNotice"
          );
        }),
      ),
    ).toMatchObject({
      kind: "errorNotice",
      notice: {
        code: "WORKTREE_CREATE_FAILED",
        clientActionId: "failed-send-action",
      },
    });
    expect(captured.requests).toEqual([]);

    const verification = await openStream(
      server.websocketUrl.replace("/rpc", "/stream"),
      { "chat.subscribe": { major: 1, minor: 6 } },
    );
    verification.ws.send(
      JSON.stringify({
        kind: "subscribe",
        method: "chat.subscribe",
        schemaVersion: { major: 1, minor: 6 },
        params: { epicId: "epic-1", chatId: "chat-1" },
      }),
    );
    expect(
      chatSubscribeServerFrameSchema.parse(
        JSON.parse(await verification.pump.next()),
      ),
    ).toMatchObject({
      kind: "snapshot",
      snapshot: {
        chat: {
          messages: [],
          events: [
            {
              type: "send.failed",
              clientActionId: "failed-send-action",
              messageId: "failed-send-message",
              severity: "warning",
            },
          ],
        },
        runStatus: "idle",
        activeTurn: null,
        turnInProgress: false,
      },
    });

    verification.ws.close();
    stream.ws.close();
    rpcSocket.ws.close();
  });

  it("does not let a plain send overtake an earlier send provisioning a worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-send-intake-order-"));
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    await initializeGitWorkspace(workspace);
    const hookEntered = join(root, "post-checkout-entered");
    const hookRelease = join(root, "post-checkout-release");
    const hook = join(workspace, ".git", "hooks", "post-checkout");
    await writeFile(
      hook,
      [
        "#!/bin/sh",
        ': > "$TRAYCER_TEST_POST_CHECKOUT_ENTERED"',
        'while [ ! -f "$TRAYCER_TEST_POST_CHECKOUT_RELEASE" ]; do',
        "  sleep 0.01",
        "done",
        "",
      ].join("\n"),
    );
    await chmod(hook, 0o755);
    vi.stubEnv("TRAYCER_TEST_POST_CHECKOUT_ENTERED", hookEntered);
    vi.stubEnv("TRAYCER_TEST_POST_CHECKOUT_RELEASE", hookRelease);

    const captured = blockingCapturingRunner("first turn completed");
    const server = await startHostServer(0, HOST_ID, {
      runner: captured.runner,
      worktreeRoot: join(root, "managed"),
    });
    servers.push(server);
    const rpcSocket = await openRpc(server.websocketUrl);
    const create = epicRequest();
    const seed = create.chat;
    if (seed === undefined || seed === null) {
      throw new Error("Missing send ordering chat fixture");
    }
    await rpc(
      rpcSocket.ws,
      rpcSocket.pump,
      "send-ordering-epic",
      "epic.create",
      { major: 1, minor: 0 },
      {
        ...create,
        workspaces: [{ workspacePath: workspace }],
        chat: {
          ...seed,
          workspaceMode: "inherit",
          worktreeIntent: null,
          initialMessage: null,
        },
      },
    );

    const streamUrl = server.websocketUrl.replace("/rpc", "/stream");
    const first = await openStream(streamUrl, {
      "chat.subscribe": { major: 1, minor: 6 },
    });
    const second = await openStream(streamUrl, {
      "chat.subscribe": { major: 1, minor: 6 },
    });
    for (const stream of [first, second]) {
      stream.ws.send(
        JSON.stringify({
          kind: "subscribe",
          method: "chat.subscribe",
          schemaVersion: { major: 1, minor: 6 },
          params: { epicId: "epic-1", chatId: "chat-1" },
        }),
      );
      expect(JSON.parse(await stream.pump.next())).toMatchObject({
        kind: "snapshot",
        snapshot: { chat: { messages: [] } },
      });
    }

    let probe: StreamConnection | null = null;
    try {
      first.ws.send(
        JSON.stringify(
          chatSubscribeClientFrameSchema.parse({
            kind: "send",
            hasBinaryPayload: false,
            epicId: "epic-1",
            chatId: "chat-1",
            clientActionId: "provisioning-send-action",
            messageId: "provisioning-send-message",
            content: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "create my worktree" }],
                },
              ],
            },
            sender: { type: "user", userId: "local-user" },
            settings: sendSettings(),
            accountContext: { type: "PERSONAL" },
            worktreeIntent: legacyNewWorktreeIntent(
              workspace,
              "feature/serialized-send",
            ),
          }),
        ),
      );
      expect(await waitForPath(hookEntered, 3_000)).toBe(true);

      second.ws.send(
        JSON.stringify(
          chatSubscribeClientFrameSchema.parse({
            kind: "send",
            hasBinaryPayload: false,
            epicId: "epic-1",
            chatId: "chat-1",
            clientActionId: "plain-send-action",
            messageId: "plain-send-message",
            content: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "do not overtake" }],
                },
              ],
            },
            sender: { type: "user", userId: "local-user" },
            settings: sendSettings(),
            accountContext: { type: "PERSONAL" },
            worktreeIntent: null,
          }),
        ),
      );
      // Pong is a same-socket transport barrier: the server has consumed the
      // second send frame, while its per-chat intake remains queued.
      second.ws.send(JSON.stringify({ kind: "ping", hasBinaryPayload: false }));
      await waitForFrame(second.pump, (frame) => {
        return (
          typeof frame === "object" &&
          frame !== null &&
          "kind" in frame &&
          frame.kind === "pong"
        );
      });

      probe = await openStream(streamUrl, {
        "chat.subscribe": { major: 1, minor: 6 },
      });
      probe.ws.send(
        JSON.stringify({
          kind: "subscribe",
          method: "chat.subscribe",
          schemaVersion: { major: 1, minor: 6 },
          params: { epicId: "epic-1", chatId: "chat-1" },
        }),
      );
      expect(
        chatSubscribeServerFrameSchema.parse(
          JSON.parse(await probe.pump.next()),
        ),
      ).toMatchObject({
        kind: "snapshot",
        snapshot: {
          chat: { messages: [] },
          runStatus: "idle",
          activeTurn: null,
          turnInProgress: false,
        },
      });
      expect(captured.requests).toEqual([]);

      await writeFile(hookRelease, "release\n");
      const orderedFrames = await waitForFrames(first.pump, (frame) => {
        return (
          typeof frame === "object" &&
          frame !== null &&
          "kind" in frame &&
          frame.kind === "actionAck" &&
          "clientActionId" in frame &&
          frame.clientActionId === "plain-send-action"
        );
      });
      const decisiveFrames = orderedFrames.filter((frame) => {
        return (
          typeof frame === "object" &&
          frame !== null &&
          "kind" in frame &&
          (frame.kind === "actionAck" || frame.kind === "messageAccepted")
        );
      });
      expect(decisiveFrames).toEqual([
        expect.objectContaining({
          kind: "actionAck",
          clientActionId: "provisioning-send-action",
          action: "send",
          status: "accepted",
        }),
        expect.objectContaining({
          kind: "messageAccepted",
          message: expect.objectContaining({
            messageId: "provisioning-send-message",
          }),
        }),
        expect.objectContaining({
          kind: "actionAck",
          clientActionId: "plain-send-action",
          action: "send",
          status: "rejected",
          reason: "A turn is already in progress",
        }),
      ]);
      expect(captured.requests).toHaveLength(1);

      captured.release();
      await server.state.waitForIdle("epic-1", "chat-1");
      const finalSnapshot = chatSubscribeServerFrameSchema.parse(
        await waitForFrame(probe.pump, (frame) => {
          return (
            typeof frame === "object" &&
            frame !== null &&
            "kind" in frame &&
            frame.kind === "snapshot"
          );
        }),
      );
      if (finalSnapshot.kind !== "snapshot") {
        throw new Error("Expected final chat snapshot");
      }
      expect(
        finalSnapshot.snapshot.chat.messages
          .filter((message) => message.role === "user")
          .map((message) => message.messageId),
      ).toEqual(["provisioning-send-message"]);
      expect(captured.requests).toHaveLength(1);
    } finally {
      await writeFile(hookRelease, "release\n");
      captured.release();
      probe?.ws.close();
      second.ws.close();
      first.ws.close();
      rpcSocket.ws.close();
    }
  });

  it("streams turn events for a follow-up send", async () => {
    const server = await startHostServer(0, HOST_ID, {
      runner: scriptedTurnRunner(["ok"]),
    });
    servers.push(server);
    const rpcSocket = await openRpc(server.websocketUrl);
    const create = epicRequest();
    const seed = create.chat;
    expect(seed).toBeTruthy();
    if (seed === undefined || seed === null) {
      return;
    }
    await rpc(
      rpcSocket.ws,
      rpcSocket.pump,
      "c1",
      "epic.create",
      { major: 1, minor: 0 },
      {
        ...create,
        chat: { ...seed, initialMessage: null },
      },
    );

    const stream = await openStream(
      server.websocketUrl.replace("/rpc", "/stream"),
      {
        "chat.subscribe": { major: 1, minor: 6 },
      },
    );
    stream.ws.send(
      JSON.stringify({
        kind: "subscribe",
        method: "chat.subscribe",
        schemaVersion: { major: 1, minor: 6 },
        params: { epicId: "epic-1", chatId: "chat-1" },
      }),
    );
    const first = JSON.parse(await stream.pump.next());
    expect(first.snapshot.chat.messages).toHaveLength(0);

    const sendFrame = chatSubscribeClientFrameSchema.parse({
      kind: "send",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      clientActionId: "act-2",
      messageId: "msg-user-2",
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "hi" }] },
        ],
      },
      sender: { type: "user", userId: "local-user" },
      settings: sendSettings(),
      accountContext: { type: "PERSONAL" },
    });
    stream.ws.send(JSON.stringify(sendFrame));

    const kinds: string[] = [];
    let assistantText: string | null = null;
    for (let i = 0; i < 20; i += 1) {
      const raw: unknown = JSON.parse(await stream.pump.next());
      expect(chatSubscribeServerFrameSchema.safeParse(raw).success).toBe(true);
      const frame = raw as {
        readonly kind: string;
        readonly status?: string;
        readonly event?: { readonly type?: string; readonly delta?: string };
        readonly message?: {
          readonly role?: string;
          readonly blocks?: ReadonlyArray<{ readonly text?: string }>;
        };
        readonly snapshot?: {
          readonly chat?: { readonly settings?: unknown };
        };
      };
      kinds.push(
        frame.kind === "blockDelta"
          ? `blockDelta:${frame.event?.type ?? "?"}`
          : frame.kind,
      );
      if (frame.kind === "actionAck") {
        expect(frame.status).toBe("accepted");
      }
      if (
        frame.event?.type === "text.delta" &&
        frame.event.delta !== undefined
      ) {
        assistantText = `${assistantText ?? ""}${frame.event.delta}`;
      }
      if (
        frame.kind === "messageAccepted" &&
        frame.message?.role === "assistant"
      ) {
        expect(frame.message.blocks?.[0]?.text).toBe("ok");
      }
      if (frame.kind === "snapshot") {
        expect(frame.snapshot?.chat?.settings).toEqual(sendSettings());
        break;
      }
    }
    expect(kinds).toContain("worktreeStateChanged");
    expect(kinds).toContain("actionAck");
    expect(kinds).toContain("messageAccepted");
    expect(kinds).toContain("turnStateChanged");
    expect(kinds).toContain("blockDelta:turn.started");
    expect(kinds).toContain("blockDelta:text.delta");
    expect(kinds).toContain("blockDelta:turn.completed");
    expect(assistantText).toBe("ok");
    stream.ws.close();
    rpcSocket.ws.close();
  });

  it("stops an in-flight turn", async () => {
    const hanging: TurnRunner = {
      run(request, emit) {
        emit({ kind: "text", text: "partial" });
        return new Promise((_resolve, reject) => {
          const onAbort = (): void => {
            reject(new Error("Turn was stopped"));
          };
          if (request.signal.aborted) {
            onAbort();
            return;
          }
          request.signal.addEventListener("abort", onAbort);
        });
      },
    };
    const server = await startHostServer(0, HOST_ID, { runner: hanging });
    servers.push(server);
    const rpcSocket = await openRpc(server.websocketUrl);
    const create = epicRequest();
    const seed = create.chat;
    if (seed === undefined || seed === null) {
      return;
    }
    await rpc(
      rpcSocket.ws,
      rpcSocket.pump,
      "c1",
      "epic.create",
      { major: 1, minor: 0 },
      { ...create, chat: { ...seed, initialMessage: null } },
    );
    const stream = await openStream(
      server.websocketUrl.replace("/rpc", "/stream"),
      { "chat.subscribe": { major: 1, minor: 6 } },
    );
    stream.ws.send(
      JSON.stringify({
        kind: "subscribe",
        method: "chat.subscribe",
        schemaVersion: { major: 1, minor: 6 },
        params: { epicId: "epic-1", chatId: "chat-1" },
      }),
    );
    expect(JSON.parse(await stream.pump.next()).kind).toBe("snapshot");
    stream.ws.send(
      JSON.stringify(
        chatSubscribeClientFrameSchema.parse({
          kind: "send",
          hasBinaryPayload: false,
          epicId: "epic-1",
          chatId: "chat-1",
          clientActionId: "act-send",
          messageId: "msg-user-2",
          content: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "hi" }] },
            ],
          },
          sender: { type: "user", userId: "local-user" },
          settings: sendSettings(),
          accountContext: { type: "PERSONAL" },
        }),
      ),
    );
    await waitForFrame(stream.pump, (frame) => {
      return (
        typeof frame === "object" &&
        frame !== null &&
        "event" in frame &&
        typeof frame.event === "object" &&
        frame.event !== null &&
        "type" in frame.event &&
        frame.event.type === "text.delta"
      );
    });
    stream.ws.send(
      JSON.stringify({
        kind: "stop",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "act-stop",
        turnId: null,
      }),
    );
    const stopped = await waitForFrame(stream.pump, (frame) => {
      return (
        typeof frame === "object" &&
        frame !== null &&
        "event" in frame &&
        typeof frame.event === "object" &&
        frame.event !== null &&
        "type" in frame.event &&
        frame.event.type === "turn.stopped"
      );
    });
    expect(stopped).toMatchObject({
      event: { type: "turn.stopped" },
    });
    await server.state.waitForIdle("epic-1", "chat-1");
    stream.ws.close();
    rpcSocket.ws.close();
  });
});

async function waitForFrame(
  pump: MessagePump,
  match: (frame: unknown) => boolean,
): Promise<unknown> {
  for (let i = 0; i < 30; i += 1) {
    const frame: unknown = JSON.parse(await pump.next());
    if (match(frame)) {
      return frame;
    }
  }
  throw new Error("Timed out waiting for stream frame");
}

async function waitForFrames(
  pump: MessagePump,
  match: (frame: unknown) => boolean,
): Promise<unknown[]> {
  const frames: unknown[] = [];
  for (let i = 0; i < 30; i += 1) {
    const frame: unknown = JSON.parse(await pump.next());
    frames.push(frame);
    if (match(frame)) {
      return frames;
    }
  }
  throw new Error("Timed out waiting for stream frames");
}

async function waitForPath(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return true;
    } catch {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  }
  return false;
}
