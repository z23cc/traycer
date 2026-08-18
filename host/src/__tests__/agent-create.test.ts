import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { splitConnectionManifest } from "@traycer/protocol/framework/capability-manifest";
import { upgradeResponseToVersion } from "@traycer/protocol/framework/versioned-rpc";
import { hostFrameSchema } from "@traycer/protocol/framework/ws-protocol";
import {
  createAgentResponseSchema,
  createAgentRequestSchemaV30,
  listAgentsRequestSchema,
  listAgentsResponseSchema,
  listAgentsResponseSchemaV60,
} from "@traycer/protocol/host/agent/shared";
import {
  chatSubscribeClientFrameSchema,
  chatSubscribeServerFrameSchema,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { getChatRunSettingsResponseSchema } from "@traycer/protocol/host/epic/chat-records";
import { createEpicRequestSchema } from "@traycer/protocol/host/epic/unary-schemas";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  worktreeCreatePathsResponseSchema,
  worktreeGetBindingResponseSchema,
} from "@traycer/protocol/host/worktree-schemas";
import type { TurnRequest, TurnRunner } from "../cli-runner";
import { startHostServer, type HostServer } from "../server";

const HOST_ID = "host-local";

describe("agent.create", () => {
  const servers: HostServer[] = [];
  const sockets: WebSocket[] = [];
  const tempRoots: string[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.terminate();
    }
    while (servers.length > 0) {
      const server = servers.pop();
      if (server !== undefined) {
        await server.close();
      }
    }
    for (const root of tempRoots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates a GUI child bound to a CLI-created worktree and runs there", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-agent-create-"));
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    const worktreeRoot = join(root, "managed");
    await mkdir(workspace);
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
    execFileSync("git", [
      "-C",
      workspace,
      "remote",
      "add",
      "origin",
      "https://github.com/traycer-test/agent-create.git",
    ]);
    await writeFile(join(workspace, "README.md"), "base\n");
    execFileSync("git", ["-C", workspace, "add", "README.md"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);

    const requests: TurnRequest[] = [];
    const runner: TurnRunner = {
      async run(request, emit) {
        requests.push(request);
        emit({ kind: "text", text: "child reply" });
        return { text: "child reply", sessionId: null };
      },
    };
    const server = await startHostServer(0, HOST_ID, {
      runner,
      worktreeRoot,
    });
    servers.push(server);
    const rpcConnection = await openRpc(server.websocketUrl, sockets);
    expect(rpcConnection.openAck).toMatchObject({
      kind: "openAck",
      manifest: {
        "agent.create": { major: 3, minor: 0 },
        "agent.list": { major: 6, minor: 0 },
      },
    });

    await createParentEpic(rpcConnection, "epic-agent-create", "parent-agent");

    const createdPathsFrame = await rpc(
      rpcConnection,
      "create-path",
      "worktree.createPaths",
      { major: 1, minor: 0 },
      {
        entries: [
          {
            workspacePath: workspace,
            branch: {
              type: "new",
              name: "feature/child-agent",
              source: "main",
              carryUncommittedChanges: false,
            },
          },
        ],
      },
    );
    expect(createdPathsFrame).toMatchObject({
      kind: "response",
      error: null,
    });
    const createdPaths = worktreeCreatePathsResponseSchema.parse(
      responseResult(createdPathsFrame),
    );
    const worktreePath = createdPaths.entries[0]?.path;
    if (worktreePath === undefined) {
      throw new Error("worktree.createPaths did not return a checkout path");
    }
    const canonicalWorkspace = await realpath(workspace);

    const createFrame = await rpc(
      rpcConnection,
      "agent-create",
      "agent.create",
      { major: 3, minor: 0 },
      createAgentRequestSchemaV30.parse({
        senderAgentId: "parent-agent",
        epicId: "epic-agent-create",
        name: "CLI child",
        surface: "gui",
        harnessId: "codex",
        model: "gpt-5.4",
        agentMode: "regular",
        reasoningEffort: null,
        fastMode: null,
        permissionMode: "full_access",
        profileSelection: { kind: "ambient" },
        // This is the exact `traycer agent create --cwd <path>` shape. The
        // host must recognize that the path lives under its managed root and
        // reconstruct the source workspace rather than treating it as Local.
        workspace: { entries: [{ path: worktreePath }] },
      }),
    );
    expect(createFrame).toMatchObject({ kind: "response", error: null });
    const createdAgent = createAgentResponseSchema.parse(
      responseResult(createFrame),
    );
    expect(createdAgent.warnings).toEqual([]);

    const freshRpc = await openRpc(server.websocketUrl, sockets);
    const bindingFrame = await rpc(
      freshRpc,
      "binding-get",
      "worktree.getBinding",
      { major: 1, minor: 0 },
      {
        epicId: "epic-agent-create",
        ownerId: createdAgent.agentId,
        ownerKind: "chat",
      },
    );
    const binding = worktreeGetBindingResponseSchema.parse(
      responseResult(bindingFrame),
    );
    expect(binding).toMatchObject({
      binding: {
        entries: [
          {
            workspacePath: canonicalWorkspace,
            worktreePath,
            mode: "worktree",
            branch: "feature/child-agent",
            isPrimary: true,
            isImported: true,
          },
        ],
      },
      missingWorktreePaths: [],
    });

    const listFrame = await rpc(
      freshRpc,
      "agent-list",
      "agent.list",
      { major: 6, minor: 0 },
      listAgentsRequestSchema.parse({
        epicId: "epic-agent-create",
        senderAgentId: "parent-agent",
        scope: "all",
      }),
    );
    expect(listFrame).toMatchObject({ kind: "response", error: null });
    const listed = listAgentsResponseSchemaV60.parse(responseResult(listFrame));
    expect(responseResult(listFrame)).toEqual(listed);
    expect(listed.caller).toEqual({
      agentId: "parent-agent",
      canSendMessages: true,
    });
    expect(listed.scope).toBe("all");
    expect(listed.agents).toHaveLength(2);
    expect(listed.agents.find((agent) => agent.id === "parent-agent")).toEqual({
      id: "parent-agent",
      parentId: null,
      hostId: HOST_ID,
      isLocal: true,
      surface: "gui",
      harnessId: null,
      isSelf: true,
      title: "Parent agent",
      capabilities: { readTranscript: true, sendMessage: true },
      active: false,
      folderPaths: [],
      isWorktree: false,
    });
    expect(
      listed.agents.find((agent) => agent.id === createdAgent.agentId),
    ).toEqual({
      id: createdAgent.agentId,
      parentId: "parent-agent",
      hostId: HOST_ID,
      isLocal: true,
      surface: "gui",
      harnessId: "codex",
      isSelf: false,
      title: "CLI child",
      capabilities: { readTranscript: true, sendMessage: true },
      active: false,
      folderPaths: [worktreePath],
      isWorktree: true,
    });
    const canonicalList = listAgentsResponseSchema.parse(
      upgradeResponseToVersion(
        hostRpcRegistry["agent.list"],
        { major: 6, minor: 0 },
        { major: 7, minor: 0 },
        listed,
      ),
    );
    expect(canonicalList.agents.map((agent) => agent.runConfig)).toEqual([
      null,
      null,
    ]);
    expect(
      await rpc(
        freshRpc,
        "agent-list-missing-sender",
        "agent.list",
        { major: 6, minor: 0 },
        {
          epicId: "epic-agent-create",
          senderAgentId: "missing-agent",
          scope: "user",
        },
      ),
    ).toMatchObject({
      kind: "response",
      result: null,
      error: {
        code: "RPC_ERROR",
        message: "agent.list: sender agent 'missing-agent' was not found.",
      },
    });
    expect(
      await rpc(
        freshRpc,
        "status-after-agent-list-error",
        "host.status",
        { major: 1, minor: 0 },
        {},
      ),
    ).toMatchObject({
      kind: "response",
      result: { ready: true },
      error: null,
    });

    const stream = await openStream(server.websocketUrl, sockets);
    stream.ws.send(
      JSON.stringify({
        kind: "subscribe",
        method: "chat.subscribe",
        schemaVersion: { major: 1, minor: 6 },
        params: {
          epicId: "epic-agent-create",
          chatId: createdAgent.agentId,
        },
      }),
    );
    const snapshot = chatSubscribeServerFrameSchema.parse(
      JSON.parse(await stream.pump.next()),
    );
    expect(snapshot).toMatchObject({
      kind: "snapshot",
      snapshot: {
        chat: {
          id: createdAgent.agentId,
          parentId: "parent-agent",
          title: "CLI child",
          isTitleEditedByUser: true,
          settings: {
            harnessId: "codex",
            model: "gpt-5.4",
            permissionMode: "full_access",
            reasoningEffort: null,
            serviceTier: null,
            agentMode: "regular",
            profileId: null,
          },
        },
        worktreeBinding: binding.binding,
      },
    });

    stream.ws.send(
      JSON.stringify(
        chatSubscribeClientFrameSchema.parse({
          kind: "send",
          hasBinaryPayload: false,
          epicId: "epic-agent-create",
          chatId: createdAgent.agentId,
          clientActionId: "child-action",
          messageId: "child-message",
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "run in the worktree" }],
              },
            ],
          },
          sender: { type: "user", userId: "local-user" },
          settings: {
            harnessId: "codex",
            model: "gpt-5.4",
            permissionMode: "full_access",
            reasoningEffort: null,
            serviceTier: null,
            agentMode: "regular",
            profileId: null,
          },
          accountContext: { type: "PERSONAL" },
        }),
      ),
    );
    await waitForStreamFrame(stream.pump, "actionAck");
    await server.state.waitForIdle("epic-agent-create", createdAgent.agentId);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.cwd).toBe(worktreePath);

    const exactBindingFrame = await rpc(
      rpcConnection,
      "agent-create-exact-binding",
      "agent.create",
      { major: 3, minor: 0 },
      createAgentRequestSchemaV30.parse({
        senderAgentId: "parent-agent",
        epicId: "epic-agent-create",
        name: null,
        surface: "gui",
        harnessId: "codex",
        model: "gpt-5.4",
        agentMode: "regular",
        reasoningEffort: null,
        fastMode: null,
        permissionMode: "full_access",
        profileSelection: { kind: "ambient" },
        // Exact `traycer agent create --workspace-entry SOURCE=RUN` shape.
        workspace: {
          entries: [{ path: worktreePath, workspacePath: canonicalWorkspace }],
        },
      }),
    );
    const exactBindingAgent = createAgentResponseSchema.parse(
      responseResult(exactBindingFrame),
    );
    const exactBindingRead = await rpc(
      freshRpc,
      "agent-exact-binding-read",
      "worktree.getBinding",
      { major: 1, minor: 0 },
      {
        epicId: "epic-agent-create",
        ownerId: exactBindingAgent.agentId,
        ownerKind: "chat",
      },
    );
    expect(
      worktreeGetBindingResponseSchema.parse(responseResult(exactBindingRead)),
    ).toMatchObject({
      binding: {
        entries: [
          {
            workspacePath: canonicalWorkspace,
            worktreePath,
            mode: "worktree",
            isPrimary: true,
            isImported: true,
          },
        ],
      },
    });
  });

  it("warns and clears catalog options absent from the local model", async () => {
    const server = await startHostServer(0, HOST_ID, {
      runner: {
        async run() {
          return { text: "", sessionId: null };
        },
      },
    });
    servers.push(server);
    const connection = await openRpc(server.websocketUrl, sockets);
    await createParentEpic(connection, "epic-catalog", "parent-catalog");

    const createdFrame = await rpc(
      connection,
      "agent-create-catalog",
      "agent.create",
      { major: 3, minor: 0 },
      createAgentRequestSchemaV30.parse({
        senderAgentId: "parent-catalog",
        epicId: "epic-catalog",
        name: null,
        surface: "gui",
        harnessId: "codex",
        model: "gpt-5.4",
        agentMode: "regular",
        reasoningEffort: "low",
        fastMode: true,
        permissionMode: "full_access",
        profileSelection: { kind: "ambient" },
        workspace: null,
      }),
    );
    expect(createdFrame).toMatchObject({ kind: "response", error: null });
    const created = createAgentResponseSchema.parse(
      responseResult(createdFrame),
    );
    expect(created.warnings).toEqual([
      "reasoningEffort 'low' is not available for model 'gpt-5.4' and was ignored.",
      "fastMode is not available for model 'gpt-5.4' and was ignored.",
    ]);

    const settingsFrame = await rpc(
      connection,
      "agent-create-settings",
      "epic.getChatRunSettings",
      { major: 1, minor: 0 },
      { epicId: "epic-catalog", chatId: created.agentId },
    );
    expect(
      getChatRunSettingsResponseSchema.parse(responseResult(settingsFrame)),
    ).toMatchObject({
      settings: {
        harnessId: "codex",
        model: "gpt-5.4",
        reasoningEffort: null,
        serviceTier: null,
      },
    });
  });

  it("resolves an explicitly empty GUI model to the catalog default", async () => {
    const server = await startHostServer(0, HOST_ID, {
      runner: {
        async run() {
          return { text: "", sessionId: null };
        },
      },
    });
    servers.push(server);
    const connection = await openRpc(server.websocketUrl, sockets);
    await createParentEpic(
      connection,
      "epic-default-model",
      "parent-default-model",
    );

    const createdFrame = await rpc(
      connection,
      "agent-create-default-model",
      "agent.create",
      { major: 3, minor: 0 },
      createAgentRequestSchemaV30.parse({
        senderAgentId: "parent-default-model",
        epicId: "epic-default-model",
        name: null,
        surface: "gui",
        harnessId: "codex",
        model: "",
        agentMode: "regular",
        reasoningEffort: null,
        fastMode: null,
        permissionMode: "full_access",
        profileSelection: { kind: "ambient" },
        workspace: null,
      }),
    );
    expect(createdFrame).toMatchObject({ kind: "response", error: null });
    const created = createAgentResponseSchema.parse(
      responseResult(createdFrame),
    );
    expect(created.warnings).toEqual([]);
    const settingsFrame = await rpc(
      connection,
      "agent-default-model-settings",
      "epic.getChatRunSettings",
      { major: 1, minor: 0 },
      { epicId: "epic-default-model", chatId: created.agentId },
    );
    expect(
      getChatRunSettingsResponseSchema.parse(responseResult(settingsFrame)),
    ).toMatchObject({ settings: { harnessId: "codex", model: "gpt-5.4" } });
  });

  it("inherits a parent's GUI settings and workspace binding when workspace is null", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-agent-inherit-"));
    tempRoots.push(root);
    const workspace = join(root, "parent-workspace");
    await mkdir(workspace);
    const server = await startHostServer(0, HOST_ID, {
      runner: {
        async run() {
          return { text: "", sessionId: null };
        },
      },
    });
    servers.push(server);
    const connection = await openRpc(server.websocketUrl, sockets);
    await createParentEpic(connection, "epic-inherit", "parent-inherit");

    expect(
      await rpc(
        connection,
        "parent-settings",
        "epic.updateChatRunSettings",
        { major: 1, minor: 1 },
        {
          epicId: "epic-inherit",
          chatId: "parent-inherit",
          settings: {
            harnessId: "claude",
            model: "claude-opus-4",
            permissionMode: "auto_accept_edits",
            reasoningEffort: null,
            serviceTier: null,
            agentMode: "regular",
            profileId: "parent-profile",
          },
        },
      ),
    ).toMatchObject({ kind: "response", error: null });
    expect(
      await rpc(
        connection,
        "parent-binding",
        "worktree.setEntryMode",
        { major: 1, minor: 0 },
        {
          epicId: "epic-inherit",
          ownerId: "parent-inherit",
          ownerKind: "chat",
          workspacePath: workspace,
        },
      ),
    ).toMatchObject({ kind: "response", error: null });

    const createdFrame = await rpc(
      connection,
      "agent-create-inherit",
      "agent.create",
      { major: 3, minor: 0 },
      createAgentRequestSchemaV30.parse({
        senderAgentId: "parent-inherit",
        epicId: "epic-inherit",
        name: null,
        surface: null,
        harnessId: null,
        model: null,
        agentMode: null,
        reasoningEffort: null,
        fastMode: null,
        permissionMode: null,
        profileSelection: { kind: "inherit_sender" },
        workspace: null,
      }),
    );
    expect(createdFrame).toMatchObject({ kind: "response", error: null });
    const created = createAgentResponseSchema.parse(
      responseResult(createdFrame),
    );
    expect(created.warnings).toEqual([]);

    const bindingFrame = await rpc(
      connection,
      "agent-inherited-binding",
      "worktree.getBinding",
      { major: 1, minor: 0 },
      {
        epicId: "epic-inherit",
        ownerId: created.agentId,
        ownerKind: "chat",
      },
    );
    expect(
      worktreeGetBindingResponseSchema.parse(responseResult(bindingFrame)),
    ).toMatchObject({
      binding: {
        entries: [
          {
            workspacePath: workspace,
            worktreePath: null,
            mode: "local",
            isPrimary: true,
            isImported: false,
          },
        ],
      },
      missingWorktreePaths: [],
    });

    const stream = await openStream(server.websocketUrl, sockets);
    stream.ws.send(
      JSON.stringify({
        kind: "subscribe",
        method: "chat.subscribe",
        schemaVersion: { major: 1, minor: 6 },
        params: { epicId: "epic-inherit", chatId: created.agentId },
      }),
    );
    expect(
      chatSubscribeServerFrameSchema.parse(
        JSON.parse(await stream.pump.next()),
      ),
    ).toMatchObject({
      kind: "snapshot",
      snapshot: {
        chat: {
          parentId: "parent-inherit",
          title: "",
          isTitleEditedByUser: false,
          settings: {
            harnessId: "claude",
            model: "claude-opus-4",
            permissionMode: "auto_accept_edits",
            reasoningEffort: null,
            serviceTier: null,
            agentMode: "regular",
            profileId: "parent-profile",
          },
        },
      },
    });

    const switchedFrame = await rpc(
      connection,
      "agent-create-switch-harness",
      "agent.create",
      { major: 3, minor: 0 },
      createAgentRequestSchemaV30.parse({
        senderAgentId: "parent-inherit",
        epicId: "epic-inherit",
        name: null,
        surface: null,
        harnessId: "codex",
        model: null,
        agentMode: null,
        reasoningEffort: null,
        fastMode: null,
        permissionMode: null,
        profileSelection: { kind: "inherit_sender" },
        workspace: { entries: [] },
      }),
    );
    const switched = createAgentResponseSchema.parse(
      responseResult(switchedFrame),
    );
    const switchedSettingsFrame = await rpc(
      connection,
      "agent-switch-harness-settings",
      "epic.getChatRunSettings",
      { major: 1, minor: 0 },
      { epicId: "epic-inherit", chatId: switched.agentId },
    );
    expect(
      getChatRunSettingsResponseSchema.parse(
        responseResult(switchedSettingsFrame),
      ),
    ).toEqual({
      settings: {
        harnessId: "codex",
        model: "gpt-5.4",
        permissionMode: "auto_accept_edits",
        reasoningEffort: null,
        serviceTier: null,
        agentMode: "regular",
        profileId: null,
      },
    });
  });

  it("does not materialize a binding for an explicitly empty workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-agent-empty-"));
    tempRoots.push(root);
    const parentWorkspace = join(root, "parent-workspace");
    await mkdir(parentWorkspace);
    const server = await startHostServer(0, HOST_ID, {
      runner: {
        async run() {
          return { text: "", sessionId: null };
        },
      },
    });
    servers.push(server);
    const connection = await openRpc(server.websocketUrl, sockets);
    await createParentEpic(connection, "epic-empty", "parent-empty");
    expect(
      await rpc(
        connection,
        "parent-empty-binding",
        "worktree.setEntryMode",
        { major: 1, minor: 0 },
        {
          epicId: "epic-empty",
          ownerId: "parent-empty",
          ownerKind: "chat",
          workspacePath: parentWorkspace,
        },
      ),
    ).toMatchObject({ kind: "response", error: null });

    const createdFrame = await rpc(
      connection,
      "agent-create-empty",
      "agent.create",
      { major: 3, minor: 0 },
      createAgentRequestSchemaV30.parse({
        senderAgentId: "parent-empty",
        epicId: "epic-empty",
        name: null,
        surface: "gui",
        harnessId: "codex",
        model: "gpt-5.4",
        agentMode: "regular",
        reasoningEffort: null,
        fastMode: null,
        permissionMode: "full_access",
        profileSelection: { kind: "ambient" },
        workspace: { entries: [] },
      }),
    );
    const created = createAgentResponseSchema.parse(
      responseResult(createdFrame),
    );
    const bindingFrame = await rpc(
      connection,
      "agent-empty-binding",
      "worktree.getBinding",
      { major: 1, minor: 0 },
      {
        epicId: "epic-empty",
        ownerId: created.agentId,
        ownerKind: "chat",
      },
    );
    expect(
      worktreeGetBindingResponseSchema.parse(responseResult(bindingFrame)),
    ).toEqual({ binding: null, missingWorktreePaths: [] });
  });

  it("preserves inherited repository identities and the parent's primary entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-agent-primary-"));
    tempRoots.push(root);
    const firstWorkspace = join(root, "first");
    const primaryWorkspace = join(root, "primary");
    await Promise.all([mkdir(firstWorkspace), mkdir(primaryWorkspace)]);
    const server = await startHostServer(0, HOST_ID, {
      runner: {
        async run() {
          return { text: "", sessionId: null };
        },
      },
    });
    servers.push(server);
    const connection = await openRpc(server.websocketUrl, sockets);
    await createParentEpic(connection, "epic-primary", "parent-primary");

    expect(
      await rpc(
        connection,
        "parent-multi-binding",
        "worktree.create",
        { major: 1, minor: 0 },
        {
          epicId: "epic-primary",
          ownerId: "parent-primary",
          ownerKind: "chat",
          entries: [
            {
              kind: "local",
              workspacePath: firstWorkspace,
              repoIdentifier: { owner: "acme", repo: "first" },
              isPrimary: false,
            },
            {
              kind: "local",
              workspacePath: primaryWorkspace,
              repoIdentifier: { owner: "acme", repo: "primary" },
              isPrimary: true,
            },
          ],
        },
      ),
    ).toMatchObject({ kind: "response", error: null });

    const createdFrame = await rpc(
      connection,
      "agent-create-primary",
      "agent.create",
      { major: 3, minor: 0 },
      createAgentRequestSchemaV30.parse({
        senderAgentId: "parent-primary",
        epicId: "epic-primary",
        name: null,
        surface: "gui",
        harnessId: "codex",
        model: "gpt-5.4",
        agentMode: "regular",
        reasoningEffort: null,
        fastMode: null,
        permissionMode: "full_access",
        profileSelection: { kind: "ambient" },
        workspace: null,
      }),
    );
    const created = createAgentResponseSchema.parse(
      responseResult(createdFrame),
    );
    const bindingFrame = await rpc(
      connection,
      "agent-primary-binding",
      "worktree.getBinding",
      { major: 1, minor: 0 },
      {
        epicId: "epic-primary",
        ownerId: created.agentId,
        ownerKind: "chat",
      },
    );
    expect(
      worktreeGetBindingResponseSchema.parse(responseResult(bindingFrame)),
    ).toMatchObject({
      binding: {
        entries: [
          {
            workspacePath: firstWorkspace,
            repoIdentifier: { owner: "acme", repo: "first" },
            isPrimary: false,
          },
          {
            workspacePath: primaryWorkspace,
            repoIdentifier: { owner: "acme", repo: "primary" },
            isPrimary: true,
          },
        ],
      },
    });
  });

  it("keeps the child record when an explicit workspace import fails after creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-agent-import-fail-"));
    tempRoots.push(root);
    const worktreeRoot = join(root, "managed");
    const orphanPath = join(worktreeRoot, "acme__demo", "orphan");
    await mkdir(orphanPath, { recursive: true });
    const server = await startHostServer(0, HOST_ID, {
      worktreeRoot,
      runner: {
        async run() {
          return { text: "", sessionId: null };
        },
      },
    });
    servers.push(server);
    const connection = await openRpc(server.websocketUrl, sockets);
    await createParentEpic(
      connection,
      "epic-import-fail",
      "parent-import-fail",
    );
    const epic = server.state.getEpic("epic-import-fail");
    if (epic === null) {
      throw new Error("Expected the parent epic to exist");
    }
    const chatsBefore = new Set(epic.chats.keys());

    expect(
      await rpc(
        connection,
        "agent-create-import-fail",
        "agent.create",
        { major: 3, minor: 0 },
        createAgentRequestSchemaV30.parse({
          senderAgentId: "parent-import-fail",
          epicId: "epic-import-fail",
          name: "Orphan child",
          surface: "gui",
          harnessId: "codex",
          model: "gpt-5.4",
          agentMode: "regular",
          reasoningEffort: null,
          fastMode: null,
          permissionMode: "full_access",
          profileSelection: { kind: "ambient" },
          workspace: { entries: [{ path: orphanPath }] },
        }),
      ),
    ).toMatchObject({
      kind: "response",
      result: null,
      error: { code: "RPC_ERROR" },
    });

    const childIds = [...epic.chats.keys()].filter(
      (chatId) => !chatsBefore.has(chatId),
    );
    expect(childIds).toHaveLength(1);
    const childId = childIds[0];
    if (childId === undefined) {
      throw new Error("Expected the failed import to leave one child record");
    }
    expect(epic.chats.get(childId)).toMatchObject({
      parentId: "parent-import-fail",
      title: "Orphan child",
      worktreeBinding: null,
    });
    const bindingFrame = await rpc(
      connection,
      "agent-import-fail-binding",
      "worktree.getBinding",
      { major: 1, minor: 0 },
      {
        epicId: "epic-import-fail",
        ownerId: childId,
        ownerKind: "chat",
      },
    );
    expect(
      worktreeGetBindingResponseSchema.parse(responseResult(bindingFrame)),
    ).toEqual({ binding: null, missingWorktreePaths: [] });
  });

  it("keeps inherited workspace import failures best-effort and returns an unbound child", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-agent-inherit-fail-"));
    tempRoots.push(root);
    const worktreeRoot = join(root, "managed");
    const orphanPath = join(worktreeRoot, "acme__demo", "orphan");
    await mkdir(orphanPath, { recursive: true });
    const server = await startHostServer(0, HOST_ID, {
      worktreeRoot,
      runner: {
        async run() {
          return { text: "", sessionId: null };
        },
      },
    });
    servers.push(server);
    const connection = await openRpc(server.websocketUrl, sockets);
    await createParentEpic(
      connection,
      "epic-inherit-fail",
      "parent-inherit-fail",
    );
    expect(
      await rpc(
        connection,
        "parent-inherit-fail-binding",
        "worktree.setEntryMode",
        { major: 1, minor: 0 },
        {
          epicId: "epic-inherit-fail",
          ownerId: "parent-inherit-fail",
          ownerKind: "chat",
          workspacePath: orphanPath,
        },
      ),
    ).toMatchObject({ kind: "response", error: null });

    const createdFrame = await rpc(
      connection,
      "agent-create-inherit-fail",
      "agent.create",
      { major: 3, minor: 0 },
      createAgentRequestSchemaV30.parse({
        senderAgentId: "parent-inherit-fail",
        epicId: "epic-inherit-fail",
        name: null,
        surface: "gui",
        harnessId: "codex",
        model: "gpt-5.4",
        agentMode: "regular",
        reasoningEffort: null,
        fastMode: null,
        permissionMode: "full_access",
        profileSelection: { kind: "ambient" },
        workspace: null,
      }),
    );
    expect(createdFrame).toMatchObject({ kind: "response", error: null });
    const created = createAgentResponseSchema.parse(
      responseResult(createdFrame),
    );
    const bindingFrame = await rpc(
      connection,
      "agent-inherit-fail-binding",
      "worktree.getBinding",
      { major: 1, minor: 0 },
      {
        epicId: "epic-inherit-fail",
        ownerId: created.agentId,
        ownerKind: "chat",
      },
    );
    expect(
      worktreeGetBindingResponseSchema.parse(responseResult(bindingFrame)),
    ).toEqual({ binding: null, missingWorktreePaths: [] });
  });

  it("rejects unknown models, unavailable profiles, and TUI targets before creating a child", async () => {
    const server = await startHostServer(0, HOST_ID, {
      runner: {
        async run() {
          return { text: "", sessionId: null };
        },
      },
    });
    servers.push(server);
    const connection = await openRpc(server.websocketUrl, sockets);
    await createParentEpic(connection, "epic-reject", "parent-reject");
    const epic = server.state.getEpic("epic-reject");
    if (epic === null) {
      throw new Error("Expected the parent epic to exist");
    }
    const originalChatCount = epic.chats.size;
    const base = {
      senderAgentId: "parent-reject",
      epicId: "epic-reject",
      name: null,
      surface: "gui" as const,
      harnessId: "codex" as const,
      model: "gpt-5.4",
      agentMode: "regular" as const,
      reasoningEffort: null,
      fastMode: null,
      permissionMode: "full_access" as const,
      profileSelection: { kind: "ambient" as const },
      workspace: null,
    };

    expect(
      await rpc(
        connection,
        "agent-unknown-model",
        "agent.create",
        { major: 3, minor: 0 },
        { ...base, model: "not-a-local-model" },
      ),
    ).toMatchObject({
      kind: "response",
      result: null,
      error: {
        code: "RPC_ERROR",
        message:
          "agent.create: model 'not-a-local-model' is not available for harness 'codex'.",
      },
    });
    expect(
      await rpc(
        connection,
        "agent-unsupported-harness",
        "agent.create",
        { major: 3, minor: 0 },
        { ...base, harnessId: "opencode", model: "opencode-model" },
      ),
    ).toMatchObject({
      kind: "response",
      result: null,
      error: {
        code: "E_HOST_UNSUPPORTED",
        message:
          "agent.create: gui harness 'opencode' is not supported by this local host.",
      },
    });
    expect(
      await rpc(
        connection,
        "agent-unknown-profile",
        "agent.create",
        { major: 3, minor: 0 },
        {
          ...base,
          profileSelection: {
            kind: "profile",
            profileId: "missing-profile",
          },
        },
      ),
    ).toMatchObject({
      kind: "response",
      result: null,
      error: {
        code: "RPC_ERROR",
        message:
          'No profile "missing-profile" is registered for provider "codex".',
      },
    });
    expect(
      await rpc(
        connection,
        "agent-tui-unsupported",
        "agent.create",
        { major: 3, minor: 0 },
        {
          ...base,
          surface: "tui",
          harnessId: "claude",
          model: "claude-sonnet-4",
        },
      ),
    ).toMatchObject({
      kind: "response",
      result: null,
      error: {
        code: "E_HOST_UNSUPPORTED",
        message:
          "agent.create: TUI agents are not supported by this local host yet.",
      },
    });
    expect(epic.chats.size).toBe(originalChatCount);
  });
});

type Pump = { readonly next: () => Promise<string> };
type RpcConnection = {
  readonly ws: WebSocket;
  readonly pump: Pump;
  readonly openAck: unknown;
};

function attachPump(ws: WebSocket): Pump {
  const pending: string[] = [];
  const waiters: Array<(value: string) => void> = [];
  ws.on("message", (data) => {
    const value = data.toString();
    const waiter = waiters.shift();
    if (waiter === undefined) {
      pending.push(value);
      return;
    }
    waiter(value);
  });
  return {
    next: () =>
      new Promise((resolve) => {
        const value = pending.shift();
        if (value === undefined) {
          waiters.push(resolve);
          return;
        }
        resolve(value);
      }),
  };
}

async function waitForOpen(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

async function openRpc(
  url: string,
  sockets: WebSocket[],
): Promise<RpcConnection> {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const pump = attachPump(ws);
  await waitForOpen(ws);
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
  const openAck = hostFrameSchema.parse(JSON.parse(await pump.next()));
  return { ws, pump, openAck };
}

async function openStream(
  rpcUrl: string,
  sockets: WebSocket[],
): Promise<{ readonly ws: WebSocket; readonly pump: Pump }> {
  const ws = new WebSocket(rpcUrl.replace("/rpc", "/stream"));
  sockets.push(ws);
  const pump = attachPump(ws);
  await waitForOpen(ws);
  ws.send(
    JSON.stringify({
      kind: "open",
      token: "local",
      manifest: { "chat.subscribe": { major: 1, minor: 6 } },
    }),
  );
  expect(JSON.parse(await pump.next())).toMatchObject({ kind: "openAck" });
  return { ws, pump };
}

async function rpc(
  connection: RpcConnection,
  requestId: string,
  method: string,
  schemaVersion: { readonly major: number; readonly minor: number },
  params: unknown,
): Promise<unknown> {
  connection.ws.send(
    JSON.stringify({
      kind: "request",
      requestId,
      method,
      schemaVersion,
      params,
    }),
  );
  return hostFrameSchema.parse(JSON.parse(await connection.pump.next()));
}

async function createParentEpic(
  connection: RpcConnection,
  epicId: string,
  chatId: string,
): Promise<void> {
  const now = Date.now();
  const frame = await rpc(
    connection,
    `epic-create-${epicId}`,
    "epic.create",
    { major: 1, minor: 0 },
    createEpicRequestSchema.parse({
      epic: {
        id: epicId,
        title: "Agent create task",
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
      chat: {
        chatId,
        parentId: null,
        hostId: HOST_ID,
        title: "Parent agent",
        worktreeIntent: null,
        initialMessage: null,
      },
    }),
  );
  expect(frame).toMatchObject({ kind: "response", error: null });
}

function responseResult(frame: unknown): unknown {
  if (
    typeof frame !== "object" ||
    frame === null ||
    !("kind" in frame) ||
    frame.kind !== "response" ||
    !("result" in frame)
  ) {
    throw new Error("Expected an RPC response with a result");
  }
  return frame.result;
}

async function waitForStreamFrame(pump: Pump, kind: string): Promise<unknown> {
  for (;;) {
    const frame = chatSubscribeServerFrameSchema.parse(
      JSON.parse(await pump.next()),
    );
    if (frame.kind === kind) {
      return frame;
    }
  }
}
