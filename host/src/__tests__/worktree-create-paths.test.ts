import { execFileSync, spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { splitConnectionManifest } from "@traycer/protocol/framework/capability-manifest";
import {
  hostFrameSchema,
  type HostFrame,
} from "@traycer/protocol/framework/ws-protocol";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  worktreeCreatePathsResponseSchema,
  worktreeGetBindingResponseSchema,
  worktreeListAllForHostResponseSchemaV15,
} from "@traycer/protocol/host/worktree-schemas";
import { scriptedTurnRunner } from "../cli-runner";
import { startHostServer, type HostServer } from "../server";

describe("worktree.createPaths", () => {
  const tempRoots: string[] = [];
  const servers: HostServer[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.close();
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

  it("creates a new branch checkout through the released v1.0 RPC", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-create-paths-rpc-"));
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    const managedRoot = join(root, "managed");
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
      "https://github.com/traycer-test/workspace.git",
    ]);
    await writeFile(join(workspace, "README.md"), "base\n");
    execFileSync("git", ["-C", workspace, "add", "README.md"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);

    const server = await startHostServer(0, "host-local", {
      runner: scriptedTurnRunner([]),
      worktreeRoot: managedRoot,
    });
    servers.push(server);
    const ws = new WebSocket(server.websocketUrl);
    sockets.push(ws);
    await waitForOpen(ws);
    const clientManifest = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
    );
    ws.send(
      JSON.stringify({
        kind: "open",
        token: "local",
        manifest: clientManifest.manifest,
        optionalManifest: clientManifest.optionalManifest,
      }),
    );
    const openAck = await nextHostFrame(ws);
    expect(openAck).toMatchObject({
      kind: "openAck",
      manifest: { "worktree.createPaths": { major: 1, minor: 0 } },
    });

    ws.send(
      JSON.stringify({
        kind: "request",
        requestId: "create-paths-1",
        method: "worktree.createPaths",
        schemaVersion: { major: 1, minor: 0 },
        params: {
          entries: [
            {
              workspacePath: workspace,
              branch: {
                type: "new",
                name: "feature/create-paths",
                source: "main",
                carryUncommittedChanges: false,
              },
            },
          ],
        },
      }),
    );
    const response = expectResponse(await nextHostFrame(ws), "create-paths-1");
    expect(response.error).toBeNull();
    const result = worktreeCreatePathsResponseSchema.parse(response.result);
    expect(result.perEntry).toEqual([
      {
        workspacePath: workspace,
        ok: true,
        worktreePath: result.entries[0]?.path,
        branch: "feature/create-paths",
        errorMessage: null,
      },
    ]);
    expect(result.entries).toEqual([
      {
        workspacePath: workspace,
        path: expect.any(String),
        mode: "worktree",
        repoIdentifier: { owner: "traycer-test", repo: "workspace" },
        branch: "feature/create-paths",
      },
    ]);
    const createdPath = result.entries[0]?.path;
    if (createdPath === undefined) {
      throw new Error("Missing created worktree path");
    }
    expect(createdPath.startsWith(managedRoot)).toBe(true);
    expect((await stat(createdPath)).isDirectory()).toBe(true);
    expect(
      execFileSync("git", ["-C", createdPath, "branch", "--show-current"])
        .toString()
        .trim(),
    ).toBe("feature/create-paths");

    ws.send(
      JSON.stringify({
        kind: "request",
        requestId: "list-created-worktree",
        method: "worktree.listAllForHost",
        schemaVersion: { major: 1, minor: 5 },
        params: {
          includeActivity: false,
          activityPaths: null,
          cursor: null,
          limit: null,
          forceRefresh: true,
        },
      }),
    );
    const listedFrame = expectResponse(
      await nextHostFrame(ws),
      "list-created-worktree",
    );
    expect(listedFrame.error).toBeNull();
    expect(
      worktreeListAllForHostResponseSchemaV15.parse(listedFrame.result),
    ).toEqual({
      worktrees: [
        expect.objectContaining({
          worktreePath: createdPath,
          repoLabel: "traycer-test/workspace",
          repoIdentifier: { owner: "traycer-test", repo: "workspace" },
          branch: "feature/create-paths",
          inUse: false,
          uncommittedCount: 0,
          gitRemovable: true,
          owners: [],
          presence: "present",
        }),
      ],
      nextCursor: null,
    });
  });

  it("keeps v1.0 partial failures ordered without creating an owner binding", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "traycer-create-paths-partial-rpc-"),
    );
    tempRoots.push(root);
    const nonGitWorkspace = join(root, "plain-workspace");
    const gitWorkspace = join(root, "git-workspace");
    const managedRoot = join(root, "managed");
    await mkdir(nonGitWorkspace);
    await mkdir(gitWorkspace);
    execFileSync("git", ["-C", gitWorkspace, "init", "-b", "main"]);
    execFileSync("git", [
      "-C",
      gitWorkspace,
      "config",
      "user.name",
      "Traycer Test",
    ]);
    execFileSync("git", [
      "-C",
      gitWorkspace,
      "config",
      "user.email",
      "traycer@example.com",
    ]);
    execFileSync("git", [
      "-C",
      gitWorkspace,
      "remote",
      "add",
      "origin",
      "https://github.com/traycer-test/partial-workspace.git",
    ]);
    await writeFile(join(gitWorkspace, "README.md"), "base\n");
    execFileSync("git", ["-C", gitWorkspace, "add", "README.md"]);
    execFileSync("git", ["-C", gitWorkspace, "commit", "-m", "base"]);

    const server = await startHostServer(0, "host-local", {
      runner: scriptedTurnRunner([]),
      worktreeRoot: managedRoot,
    });
    servers.push(server);
    const ws = new WebSocket(server.websocketUrl);
    sockets.push(ws);
    await waitForOpen(ws);
    const clientManifest = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
    );
    ws.send(
      JSON.stringify({
        kind: "open",
        token: "local",
        manifest: clientManifest.manifest,
        optionalManifest: clientManifest.optionalManifest,
      }),
    );
    expect(await nextHostFrame(ws)).toMatchObject({ kind: "openAck" });

    ws.send(
      JSON.stringify({
        kind: "request",
        requestId: "create-paths-partial",
        method: "worktree.createPaths",
        schemaVersion: { major: 1, minor: 0 },
        params: {
          entries: [
            {
              workspacePath: nonGitWorkspace,
              branch: {
                type: "new",
                name: "feature/plain-cannot-create",
                source: "main",
                carryUncommittedChanges: false,
              },
            },
            {
              workspacePath: gitWorkspace,
              branch: {
                type: "new",
                name: "feature/partial-success",
                source: "main",
                carryUncommittedChanges: false,
              },
            },
          ],
        },
      }),
    );
    const response = expectResponse(
      await nextHostFrame(ws),
      "create-paths-partial",
    );
    expect(response.error).toBeNull();
    const result = worktreeCreatePathsResponseSchema.parse(response.result);
    expect(result.entries).toEqual([
      {
        workspacePath: gitWorkspace,
        path: expect.any(String),
        mode: "worktree",
        repoIdentifier: {
          owner: "traycer-test",
          repo: "partial-workspace",
        },
        branch: "feature/partial-success",
      },
    ]);
    expect(result.perEntry).toEqual([
      {
        workspacePath: nonGitWorkspace,
        ok: false,
        worktreePath: null,
        branch: null,
        errorMessage: `Workspace is not a git repository: ${nonGitWorkspace}`,
      },
      {
        workspacePath: gitWorkspace,
        ok: true,
        worktreePath: result.entries[0]?.path,
        branch: "feature/partial-success",
        errorMessage: null,
      },
    ]);

    ws.send(
      JSON.stringify({
        kind: "request",
        requestId: "ownerless-binding-probe",
        method: "worktree.getBinding",
        schemaVersion: { major: 1, minor: 0 },
        params: {
          epicId: "epic-ownerless-probe",
          ownerId: "chat-ownerless-probe",
          ownerKind: "chat",
        },
      }),
    );
    const bindingResponse = expectResponse(
      await nextHostFrame(ws),
      "ownerless-binding-probe",
    );
    expect(bindingResponse.error).toBeNull();
    expect(
      worktreeGetBindingResponseSchema.parse(bindingResponse.result),
    ).toEqual({ binding: null, missingWorktreePaths: [] });
  });

  it("reports an inconclusive Git marker as a per-entry probe failure", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "traycer-create-paths-probe-failed-rpc-"),
    );
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".git"), { recursive: true });

    const server = await startHostServer(0, "host-local", {
      runner: scriptedTurnRunner([]),
      worktreeRoot: join(root, "managed"),
    });
    servers.push(server);
    const ws = new WebSocket(server.websocketUrl);
    sockets.push(ws);
    await waitForOpen(ws);
    const clientManifest = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
    );
    ws.send(
      JSON.stringify({
        kind: "open",
        token: "local",
        manifest: clientManifest.manifest,
        optionalManifest: clientManifest.optionalManifest,
      }),
    );
    expect(await nextHostFrame(ws)).toMatchObject({
      kind: "openAck",
      manifest: { "worktree.createPaths": { major: 1, minor: 0 } },
    });

    ws.send(
      JSON.stringify({
        kind: "request",
        requestId: "create-paths-probe-failed",
        method: "worktree.createPaths",
        schemaVersion: { major: 1, minor: 0 },
        params: {
          entries: [
            {
              workspacePath: workspace,
              branch: {
                type: "new",
                name: "feature/probe-failed",
                source: "main",
                carryUncommittedChanges: false,
              },
            },
          ],
        },
      }),
    );
    const response = expectResponse(
      await nextHostFrame(ws),
      "create-paths-probe-failed",
    );
    expect(response.error).toBeNull();
    expect(worktreeCreatePathsResponseSchema.parse(response.result)).toEqual({
      entries: [],
      perEntry: [
        {
          workspacePath: workspace,
          ok: false,
          worktreePath: null,
          branch: null,
          errorMessage: `Could not inspect workspace (git probe failed): ${workspace}`,
        },
      ],
    });
  });

  it("does not read or execute committed setup for an ownerless v1.0 checkout", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "traycer-create-paths-ownerless-setup-rpc-"),
    );
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    const sentinel = join(root, "setup-ran-outside-worktree");
    const managedRoot = join(root, "managed");
    await mkdir(join(workspace, ".traycer"), { recursive: true });
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
    const setupCommand = `printf ownerless-setup-ran > "${sentinel}"`;
    const committedEnvironment = `${JSON.stringify(
      {
        setup: {
          default: "",
          macos: process.platform === "darwin" ? setupCommand : null,
          windows: process.platform === "win32" ? setupCommand : null,
          linux: process.platform === "linux" ? setupCommand : null,
        },
        teardown: {
          default: "",
          macos: null,
          windows: null,
          linux: null,
        },
        updatedAt: 1,
      },
      null,
      2,
    )}\n`;
    await writeFile(
      join(workspace, ".traycer", "environment.json"),
      committedEnvironment,
    );
    execFileSync("git", ["-C", workspace, "add", ".traycer/environment.json"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "environment"]);

    const server = await startHostServer(0, "host-local", {
      runner: scriptedTurnRunner([]),
      worktreeRoot: managedRoot,
    });
    servers.push(server);
    const ws = new WebSocket(server.websocketUrl);
    sockets.push(ws);
    await waitForOpen(ws);
    const clientManifest = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
    );
    ws.send(
      JSON.stringify({
        kind: "open",
        token: "local",
        manifest: clientManifest.manifest,
        optionalManifest: clientManifest.optionalManifest,
      }),
    );
    expect(await nextHostFrame(ws)).toMatchObject({ kind: "openAck" });

    ws.send(
      JSON.stringify({
        kind: "request",
        requestId: "create-paths-ownerless-setup",
        method: "worktree.createPaths",
        schemaVersion: { major: 1, minor: 0 },
        params: {
          entries: [
            {
              workspacePath: workspace,
              branch: {
                type: "new",
                name: "feature/ownerless-setup",
                source: "main",
                carryUncommittedChanges: false,
              },
            },
          ],
        },
      }),
    );
    const response = expectResponse(
      await nextHostFrame(ws),
      "create-paths-ownerless-setup",
    );
    expect(response.error).toBeNull();
    const result = worktreeCreatePathsResponseSchema.parse(response.result);
    expect(result.perEntry).toEqual([
      {
        workspacePath: workspace,
        ok: true,
        worktreePath: result.entries[0]?.path,
        branch: "feature/ownerless-setup",
        errorMessage: null,
      },
    ]);
    const createdPath = result.entries[0]?.path;
    if (createdPath === undefined) {
      throw new Error("Missing ownerless worktree path");
    }
    await expect(access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await readFile(join(createdPath, ".traycer", "environment.json"), "utf8"),
    ).toBe(committedEnvironment);
  });

  it.skipIf(process.platform === "win32")(
    "does not open an untracked environment FIFO while inspecting the repository",
    async () => {
      const root = await mkdtemp(
        join(tmpdir(), "traycer-create-paths-ownerless-fifo-rpc-"),
      );
      tempRoots.push(root);
      const workspace = join(root, "workspace");
      const environmentPath = join(workspace, ".traycer", "environment.json");
      const readMarkerPath = join(root, "environment-was-read");
      await mkdir(join(workspace, ".traycer"), { recursive: true });
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
      execFileSync("mkfifo", [environmentPath]);

      const server = await startHostServer(0, "host-local", {
        runner: scriptedTurnRunner([]),
        worktreeRoot: join(root, "managed"),
      });
      servers.push(server);
      const ws = new WebSocket(server.websocketUrl);
      sockets.push(ws);
      await waitForOpen(ws);
      const clientManifest = splitConnectionManifest(
        hostRpcRegistry,
        RELEASED_FLOOR_METHOD_NAMES,
      );
      ws.send(
        JSON.stringify({
          kind: "open",
          token: "local",
          manifest: clientManifest.manifest,
          optionalManifest: clientManifest.optionalManifest,
        }),
      );
      expect(await nextHostFrame(ws)).toMatchObject({ kind: "openAck" });

      const fifoWriter = spawn(
        process.execPath,
        [
          "-e",
          "const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'w');fs.writeFileSync(process.argv[2],'read\\n');fs.writeSync(fd,'{}\\n');fs.closeSync(fd);",
          environmentPath,
          readMarkerPath,
        ],
        { stdio: "ignore" },
      );
      const writerExit = new Promise<void>((resolveExit) => {
        fifoWriter.once("exit", () => resolveExit());
        fifoWriter.once("error", () => resolveExit());
      });
      await new Promise<void>((resolveSpawn, rejectSpawn) => {
        fifoWriter.once("spawn", resolveSpawn);
        fifoWriter.once("error", rejectSpawn);
      });
      try {
        ws.send(
          JSON.stringify({
            kind: "request",
            requestId: "create-paths-fifo",
            method: "worktree.createPaths",
            schemaVersion: { major: 1, minor: 0 },
            params: {
              entries: [
                {
                  workspacePath: workspace,
                  branch: {
                    type: "new",
                    name: "feature/no-environment-read",
                    source: "main",
                    carryUncommittedChanges: false,
                  },
                },
              ],
            },
          }),
        );
        const response = expectResponse(
          await nextHostFrame(ws),
          "create-paths-fifo",
        );
        expect(response.error).toBeNull();
        await expect(access(readMarkerPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(
          worktreeCreatePathsResponseSchema.parse(response.result).perEntry,
        ).toEqual([
          {
            workspacePath: workspace,
            ok: true,
            worktreePath: expect.any(String),
            branch: "feature/no-environment-read",
            errorMessage: null,
          },
        ]);
      } finally {
        fifoWriter.kill("SIGKILL");
        await Promise.race([
          writerExit,
          new Promise<void>((resolveTimeout) => {
            setTimeout(resolveTimeout, 1_000);
          }),
        ]);
      }
    },
  );

  it("checks out an existing branch and reports its occupied checkout path", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "traycer-create-paths-existing-rpc-"),
    );
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    const managedRoot = join(root, "managed");
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
      "https://github.com/traycer-test/existing-workspace.git",
    ]);
    await writeFile(join(workspace, "README.md"), "base\n");
    execFileSync("git", ["-C", workspace, "add", "README.md"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);
    execFileSync("git", ["-C", workspace, "branch", "ready"]);

    const server = await startHostServer(0, "host-local", {
      runner: scriptedTurnRunner([]),
      worktreeRoot: managedRoot,
    });
    servers.push(server);
    const ws = new WebSocket(server.websocketUrl);
    sockets.push(ws);
    await waitForOpen(ws);
    const clientManifest = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
    );
    ws.send(
      JSON.stringify({
        kind: "open",
        token: "local",
        manifest: clientManifest.manifest,
        optionalManifest: clientManifest.optionalManifest,
      }),
    );
    expect(await nextHostFrame(ws)).toMatchObject({
      kind: "openAck",
      manifest: { "worktree.createPaths": { major: 1, minor: 0 } },
    });

    const params = {
      entries: [
        {
          workspacePath: workspace,
          branch: { type: "existing", name: "ready" },
        },
      ],
    };
    ws.send(
      JSON.stringify({
        kind: "request",
        requestId: "create-paths-existing",
        method: "worktree.createPaths",
        schemaVersion: { major: 1, minor: 0 },
        params,
      }),
    );
    const response = expectResponse(
      await nextHostFrame(ws),
      "create-paths-existing",
    );
    expect(response.error).toBeNull();
    const result = worktreeCreatePathsResponseSchema.parse(response.result);
    const createdPath = result.entries[0]?.path;
    if (createdPath === undefined) {
      throw new Error("Missing existing-branch worktree path");
    }
    expect(result).toEqual({
      entries: [
        {
          workspacePath: workspace,
          path: createdPath,
          mode: "worktree",
          repoIdentifier: {
            owner: "traycer-test",
            repo: "existing-workspace",
          },
          branch: "ready",
        },
      ],
      perEntry: [
        {
          workspacePath: workspace,
          ok: true,
          worktreePath: createdPath,
          branch: "ready",
          errorMessage: null,
        },
      ],
    });
    expect(
      execFileSync("git", ["-C", createdPath, "branch", "--show-current"])
        .toString()
        .trim(),
    ).toBe("ready");

    ws.send(
      JSON.stringify({
        kind: "request",
        requestId: "create-paths-existing-occupied",
        method: "worktree.createPaths",
        schemaVersion: { major: 1, minor: 0 },
        params,
      }),
    );
    const occupiedResponse = expectResponse(
      await nextHostFrame(ws),
      "create-paths-existing-occupied",
    );
    expect(occupiedResponse.error).toBeNull();
    expect(
      worktreeCreatePathsResponseSchema.parse(occupiedResponse.result),
    ).toEqual({
      entries: [],
      perEntry: [
        {
          workspacePath: workspace,
          ok: false,
          worktreePath: null,
          branch: "ready",
          errorMessage: `ready is already checked out in ${await realpath(createdPath)}`,
        },
      ],
    });
  });

  it("carries tracked and untracked changes without mutating the source checkout", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "traycer-create-paths-carry-rpc-"),
    );
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    const managedRoot = join(root, "managed");
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
      "https://github.com/traycer-test/carry-workspace.git",
    ]);
    await writeFile(join(workspace, "README.md"), "base\n");
    execFileSync("git", ["-C", workspace, "add", "README.md"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);
    const trackedContents = "base\nworking copy\n";
    const untrackedContents = "untracked draft\n";
    await writeFile(join(workspace, "README.md"), trackedContents);
    await mkdir(join(workspace, "notes"));
    await writeFile(join(workspace, "notes", "draft.txt"), untrackedContents);
    const sourceStatus = execFileSync("git", [
      "-C",
      workspace,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]).toString();

    const server = await startHostServer(0, "host-local", {
      runner: scriptedTurnRunner([]),
      worktreeRoot: managedRoot,
    });
    servers.push(server);
    const ws = new WebSocket(server.websocketUrl);
    sockets.push(ws);
    await waitForOpen(ws);
    const clientManifest = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
    );
    ws.send(
      JSON.stringify({
        kind: "open",
        token: "local",
        manifest: clientManifest.manifest,
        optionalManifest: clientManifest.optionalManifest,
      }),
    );
    expect(await nextHostFrame(ws)).toMatchObject({
      kind: "openAck",
      manifest: { "worktree.createPaths": { major: 1, minor: 0 } },
    });

    ws.send(
      JSON.stringify({
        kind: "request",
        requestId: "create-paths-carry",
        method: "worktree.createPaths",
        schemaVersion: { major: 1, minor: 0 },
        params: {
          entries: [
            {
              workspacePath: workspace,
              branch: {
                type: "new",
                name: "feature/carry",
                source: "main",
                carryUncommittedChanges: true,
              },
            },
          ],
        },
      }),
    );
    const response = expectResponse(
      await nextHostFrame(ws),
      "create-paths-carry",
    );
    expect(response.error).toBeNull();
    const result = worktreeCreatePathsResponseSchema.parse(response.result);
    const createdPath = result.entries[0]?.path;
    if (createdPath === undefined) {
      throw new Error("Missing carried worktree path");
    }
    expect(result).toEqual({
      entries: [
        {
          workspacePath: workspace,
          path: createdPath,
          mode: "worktree",
          repoIdentifier: {
            owner: "traycer-test",
            repo: "carry-workspace",
          },
          branch: "feature/carry",
        },
      ],
      perEntry: [
        {
          workspacePath: workspace,
          ok: true,
          worktreePath: createdPath,
          branch: "feature/carry",
          errorMessage: null,
        },
      ],
    });
    expect(await readFile(join(createdPath, "README.md"), "utf8")).toBe(
      trackedContents,
    );
    expect(
      await readFile(join(createdPath, "notes", "draft.txt"), "utf8"),
    ).toBe(untrackedContents);
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
      trackedContents,
    );
    expect(await readFile(join(workspace, "notes", "draft.txt"), "utf8")).toBe(
      untrackedContents,
    );
    expect(
      execFileSync("git", [
        "-C",
        workspace,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]).toString(),
    ).toBe(sourceStatus);
  });
});

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

function nextHostFrame(ws: WebSocket): Promise<HostFrame> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => {
      resolve(hostFrameSchema.parse(JSON.parse(data.toString())));
    });
    ws.once("error", reject);
  });
}

function expectResponse(
  frame: HostFrame,
  requestId: string,
): Extract<HostFrame, { readonly kind: "response" }> {
  if (frame.kind !== "response" || frame.requestId !== requestId) {
    throw new Error(`Expected response ${requestId}`);
  }
  return frame;
}
