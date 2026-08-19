import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { splitConnectionManifest } from "@traycer/protocol/framework/capability-manifest";
import {
  hostFrameSchema,
  type HostFrame,
} from "@traycer/protocol/framework/ws-protocol";
import {
  prepareWorkspaceFoldersResponseSchema,
  type PreparedWorkspaceFolder,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  workspacePrepareFoldersResponseSchemaV11,
  workspaceResolvePathsByRepoIdentifiersResponseSchema,
} from "@traycer/protocol/host/workspace/unary-schemas";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { scriptedTurnRunner } from "../cli-runner";
import { ProviderConfigStore } from "../provider-config-store";
import { dispatchRequest, type DispatchOutcome } from "../dispatch";
import { createHandlers } from "../handlers";
import { startHostServer, type HostServer } from "../server";
import { HostState } from "../store";

describe("workspace.prepareFolders", () => {
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
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("canonicalizes, probes, and deduplicates folders for v1.0 and v1.1 callers", async () => {
    const fixture = createWorkspaceFixture(tempRoots);
    const state = new HostState("host-local", undefined, undefined);
    const { handleMethod } = createHandlers(
      state,
      scriptedTurnRunner([]),
      undefined,
      ProviderConfigStore.createTransient(),
    );
    const folderPaths = [
      "   ",
      `  ${fixture.repoChild}  `,
      fixture.repoRoot,
      fixture.repoAlias,
      fixture.plainFolder,
      fixture.plainFolder,
    ];

    const legacy = await dispatchRequest({
      method: "workspace.prepareFolders",
      schemaVersion: { major: 1, minor: 0 },
      params: { folderPaths },
      handleMethod,
    });
    expect(legacy.error).toBeNull();
    expect(legacy.schemaVersion).toEqual({ major: 1, minor: 0 });
    const legacyResult = prepareWorkspaceFoldersResponseSchema.parse(
      requireResult(legacy),
    );
    expect(legacyResult).toEqual({
      folders: expectedFolders(fixture),
      repoIdentifiers: [{ owner: "traycer-test", repo: "workspace-repo" }],
    });

    const current = await dispatchRequest({
      method: "workspace.prepareFolders",
      schemaVersion: { major: 1, minor: 1 },
      params: { operation: "prepare", folderPaths, path: null },
      handleMethod,
    });
    expect(current.error).toBeNull();
    expect(current.schemaVersion).toEqual({ major: 1, minor: 1 });
    expect(
      workspacePrepareFoldersResponseSchemaV11.parse(requireResult(current)),
    ).toEqual({
      operation: "prepare",
      folders: expectedFolders(fixture),
      repoIdentifiers: [{ owner: "traycer-test", repo: "workspace-repo" }],
      homeDir: null,
      validation: null,
      recentWorkspaces: null,
    });

    const resolved = await dispatchRequest({
      method: "workspace.resolvePathsByRepoIdentifiers",
      schemaVersion: { major: 1, minor: 0 },
      params: {
        repoIdentifiers: [{ owner: "TRAYCER-TEST", repo: "WORKSPACE-REPO" }],
      },
      handleMethod,
    });
    expect(
      workspaceResolvePathsByRepoIdentifiersResponseSchema.parse(
        requireResult(resolved),
      ),
    ).toEqual({
      mappings: [
        {
          repoIdentifier: {
            owner: "TRAYCER-TEST",
            repo: "WORKSPACE-REPO",
          },
          workspacePath: fixture.repoRoot,
        },
      ],
    });
    state.dispose();
  });

  it("keeps a non-Git folder and rejects a file path", async () => {
    const fixture = createWorkspaceFixture(tempRoots);
    const state = new HostState("host-local", undefined, undefined);
    const { handleMethod } = createHandlers(
      state,
      scriptedTurnRunner([]),
      undefined,
      ProviderConfigStore.createTransient(),
    );

    const plain = await dispatchRequest({
      method: "workspace.prepareFolders",
      schemaVersion: { major: 1, minor: 0 },
      params: { folderPaths: [fixture.plainFolder] },
      handleMethod,
    });
    expect(prepareWorkspaceFoldersResponseSchema.parse(requireResult(plain)))
      .toMatchInlineSnapshot(`
        {
          "folders": [
            {
              "repoIdentifier": null,
              "repoUrl": null,
              "workspaceName": "plain-folder",
              "workspacePath": "${fixture.plainFolder}",
            },
          ],
          "repoIdentifiers": [],
        }
      `);

    const invalid = await dispatchRequest({
      method: "workspace.prepareFolders",
      schemaVersion: { major: 1, minor: 0 },
      params: { folderPaths: [fixture.repoRoot, fixture.filePath] },
      handleMethod,
    });
    expect(invalid.result).toBeNull();
    expect(invalid.error).toEqual({
      code: "RPC_ERROR",
      message: `Workspace path is not a directory: ${fixture.filePath}`,
    });
    const unresolved = await dispatchRequest({
      method: "workspace.resolvePathsByRepoIdentifiers",
      schemaVersion: { major: 1, minor: 0 },
      params: {
        repoIdentifiers: [{ owner: "traycer-test", repo: "workspace-repo" }],
      },
      handleMethod,
    });
    expect(
      workspaceResolvePathsByRepoIdentifiersResponseSchema.parse(
        requireResult(unresolved),
      ),
    ).toEqual({ mappings: [] });
    state.dispose();
  });

  it("does not expose a repository URL for a non-GitHub remote", async () => {
    const fixture = createWorkspaceFixture(tempRoots);
    execFileSync("git", [
      "-C",
      fixture.repoRoot,
      "remote",
      "set-url",
      "origin",
      "https://gitlab.com/traycer-test/workspace-repo.git",
    ]);
    const state = new HostState("host-local", undefined, undefined);
    const { handleMethod } = createHandlers(
      state,
      scriptedTurnRunner([]),
      undefined,
      ProviderConfigStore.createTransient(),
    );

    const prepared = await dispatchRequest({
      method: "workspace.prepareFolders",
      schemaVersion: { major: 1, minor: 0 },
      params: { folderPaths: [fixture.repoChild] },
      handleMethod,
    });
    expect(
      prepareWorkspaceFoldersResponseSchema.parse(requireResult(prepared)),
    ).toEqual({
      folders: [
        {
          workspacePath: fixture.repoRoot,
          workspaceName: "workspace-repo",
          repoIdentifier: null,
          repoUrl: null,
        },
      ],
      repoIdentifiers: [],
    });
    state.dispose();
  });

  it("serves prepare and repo-path resolution across the public RPC session", async () => {
    const fixture = createWorkspaceFixture(tempRoots);
    const hostHome = mkdtempSync(join(tmpdir(), "traycer-host-home-"));
    tempRoots.push(hostHome);
    const server = await startHostServer(0, "host-local", {
      runner: scriptedTurnRunner([]),
      hostHome,
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
    const ack = await nextHostFrame(ws);
    expect(ack).toMatchObject({
      kind: "openAck",
      manifest: {
        "workspace.prepareFolders": { major: 1, minor: 0 },
      },
    });

    ws.send(
      JSON.stringify({
        kind: "request",
        requestId: "prepare-1",
        method: "workspace.prepareFolders",
        schemaVersion: { major: 1, minor: 0 },
        params: { folderPaths: [fixture.repoChild] },
      }),
    );
    const prepared = expectResponse(await nextHostFrame(ws), "prepare-1");
    expect(prepared.error).toBeNull();
    expect(
      prepareWorkspaceFoldersResponseSchema.parse(prepared.result),
    ).toEqual({
      folders: [expectedFolders(fixture)[0]],
      repoIdentifiers: [{ owner: "traycer-test", repo: "workspace-repo" }],
    });

    ws.close();
    await waitForClose(ws);
    await server.close();
    const restarted = await startHostServer(0, "host-local", {
      runner: scriptedTurnRunner([]),
      hostHome,
    });
    servers.push(restarted);
    const resolveWs = new WebSocket(restarted.websocketUrl);
    sockets.push(resolveWs);
    await waitForOpen(resolveWs);
    resolveWs.send(
      JSON.stringify({
        kind: "open",
        token: "local",
        manifest: clientManifest.manifest,
        optionalManifest: clientManifest.optionalManifest,
      }),
    );
    expect(await nextHostFrame(resolveWs)).toMatchObject({ kind: "openAck" });

    resolveWs.send(
      JSON.stringify({
        kind: "request",
        requestId: "resolve-1",
        method: "workspace.resolvePathsByRepoIdentifiers",
        schemaVersion: { major: 1, minor: 0 },
        params: {
          repoIdentifiers: [{ owner: "traycer-test", repo: "workspace-repo" }],
        },
      }),
    );
    const resolved = expectResponse(
      await nextHostFrame(resolveWs),
      "resolve-1",
    );
    expect(resolved.error).toBeNull();
    expect(
      workspaceResolvePathsByRepoIdentifiersResponseSchema.parse(
        resolved.result,
      ),
    ).toEqual({
      mappings: [
        {
          repoIdentifier: {
            owner: "traycer-test",
            repo: "workspace-repo",
          },
          workspacePath: fixture.repoRoot,
        },
      ],
    });

    resolveWs.send(
      JSON.stringify({
        kind: "request",
        requestId: "status-after-prepare",
        method: "host.status",
        schemaVersion: { major: 1, minor: 1 },
        params: {},
      }),
    );
    expect(
      expectResponse(await nextHostFrame(resolveWs), "status-after-prepare")
        .error,
    ).toBeNull();
  });
});

type WorkspaceFixture = {
  readonly repoRoot: string;
  readonly repoChild: string;
  readonly repoAlias: string;
  readonly plainFolder: string;
  readonly filePath: string;
};

function createWorkspaceFixture(tempRoots: string[]): WorkspaceFixture {
  const root = mkdtempSync(join(tmpdir(), "traycer-prepare-folders-"));
  tempRoots.push(root);
  const repoRoot = join(root, "workspace-repo");
  const repoChild = join(repoRoot, "packages", "app");
  const repoAlias = join(root, "workspace-repo-alias");
  const plainFolder = join(root, "plain-folder");
  const filePath = join(root, "not-a-folder.txt");
  mkdirSync(repoChild, { recursive: true });
  mkdirSync(plainFolder);
  writeFileSync(filePath, "not a directory", "utf8");
  execFileSync("git", ["init", "--quiet", repoRoot]);
  execFileSync("git", [
    "-C",
    repoRoot,
    "remote",
    "add",
    "origin",
    "https://github.com/traycer-test/workspace-repo.git",
  ]);
  symlinkSync(repoRoot, repoAlias, "dir");
  return {
    repoRoot: realpathSync(repoRoot),
    repoChild: realpathSync(repoChild),
    repoAlias,
    plainFolder: realpathSync(plainFolder),
    filePath: realpathSync(filePath),
  };
}

function expectedFolders(fixture: WorkspaceFixture): PreparedWorkspaceFolder[] {
  return [
    {
      workspacePath: fixture.repoRoot,
      workspaceName: "workspace-repo",
      repoIdentifier: { owner: "traycer-test", repo: "workspace-repo" },
      repoUrl: "https://github.com/traycer-test/workspace-repo.git",
    },
    {
      workspacePath: fixture.plainFolder,
      workspaceName: "plain-folder",
      repoIdentifier: null,
      repoUrl: null,
    },
  ];
}

function requireResult(outcome: DispatchOutcome): unknown {
  if (outcome.result === null) {
    throw new Error(outcome.error?.message ?? "Missing RPC result");
  }
  return outcome.result;
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

function waitForClose(ws: WebSocket): Promise<void> {
  if (ws.readyState === ws.CLOSED) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    ws.once("close", resolve);
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
