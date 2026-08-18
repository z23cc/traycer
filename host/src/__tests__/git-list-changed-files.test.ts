import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
  gitGetFileDiffResponseSchema,
  gitGetFileDiffsResponseSchema,
  gitListChangedFilesResponseSchema,
} from "@traycer/protocol/host/git-schemas";
import { startHostServer, type HostServer } from "../server";

describe("git.listChangedFiles", () => {
  const servers: HostServer[] = [];
  const sockets: WebSocket[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    while (servers.length > 0) await servers.pop()?.close();
    while (roots.length > 0) {
      const root = roots.pop();
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    }
  });

  it("returns the released parent-repository snapshot from a real Git checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-git-status-"));
    roots.push(root);
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Traycer Test");
    git(root, "config", "user.email", "traycer@example.com");
    await writeFile(join(root, "tracked.txt"), "one\n");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-m", "initial");
    const headSha = git(root, "rev-parse", "HEAD").trim();

    await writeFile(join(root, "tracked.txt"), "one\ntwo\n");
    await writeFile(join(root, "staged.txt"), "staged\n");
    git(root, "add", "staged.txt");
    await writeFile(join(root, "staged.txt"), "staged\nworktree\n");
    await writeFile(join(root, "untracked.txt"), "loose\n");
    const nested = join(root, "nested");
    await mkdir(nested);

    const server = await startHostServer(0, "host-git-status", undefined);
    servers.push(server);
    const connection = await openRpc(server.websocketUrl, sockets);
    expect(connection.manifest["git.listChangedFiles"]).toEqual({
      major: 1,
      minor: 0,
    });

    const first = gitListChangedFilesResponseSchema.parse(
      responseResult(
        await rpc(connection, "git.listChangedFiles", {
          hostId: "host-git-status",
          runningDir: nested,
          ignoreWhitespace: false,
        }),
      ),
    );
    expect(first).toMatchObject({
      runningDir: await realpath(root),
      headSha,
      branch: "main",
      repoMode: "normal",
      repoState: { kind: "clean" },
    });
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.files).toEqual([
      expect.objectContaining({
        path: "staged.txt",
        previousPath: null,
        status: "added",
        stage: "staged",
        isBinary: false,
        insertions: 1,
        deletions: 0,
        sizeBytes: 16,
        stagedOid: expect.stringMatching(/^[a-f0-9]{40,64}$/u),
        worktreeOid: expect.stringMatching(/^[a-f0-9]{40,64}$/u),
      }),
      expect.objectContaining({
        path: "staged.txt",
        previousPath: null,
        status: "modified",
        stage: "unstaged",
        isBinary: false,
        insertions: 1,
        deletions: 0,
        sizeBytes: 16,
        stagedOid: expect.stringMatching(/^[a-f0-9]{40,64}$/u),
        worktreeOid: expect.stringMatching(/^[a-f0-9]{40,64}$/u),
      }),
      expect.objectContaining({
        path: "tracked.txt",
        previousPath: null,
        status: "modified",
        stage: "unstaged",
        isBinary: false,
        insertions: 1,
        deletions: 0,
        sizeBytes: 8,
        stagedOid: expect.stringMatching(/^[a-f0-9]{40,64}$/u),
        worktreeOid: expect.stringMatching(/^[a-f0-9]{40,64}$/u),
      }),
      expect.objectContaining({
        path: "untracked.txt",
        previousPath: null,
        status: "untracked",
        stage: "untracked",
        isBinary: false,
        insertions: 1,
        deletions: 0,
        sizeBytes: 6,
        stagedOid: null,
        worktreeOid: expect.stringMatching(/^[a-f0-9]{40,64}$/u),
      }),
    ]);

    const repeated = gitListChangedFilesResponseSchema.parse(
      responseResult(
        await rpc(connection, "git.listChangedFiles", {
          hostId: "host-git-status",
          runningDir: root,
          ignoreWhitespace: true,
        }),
      ),
    );
    expect(repeated.fingerprint).toBe(first.fingerprint);

    await writeFile(join(root, "untracked.txt"), "loose\nchanged\n");
    const changed = gitListChangedFilesResponseSchema.parse(
      responseResult(
        await rpc(connection, "git.listChangedFiles", {
          hostId: "host-git-status",
          runningDir: root,
          ignoreWhitespace: false,
        }),
      ),
    );
    expect(changed.fingerprint).not.toBe(first.fingerprint);
  });

  it("returns staged and unstaged patches and enforces single and batch byte budgets", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-git-diff-"));
    roots.push(root);
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Traycer Test");
    git(root, "config", "user.email", "traycer@example.com");
    await writeFile(join(root, "tracked.txt"), "one\n");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-m", "initial");
    const headSha = git(root, "rev-parse", "HEAD").trim();
    await writeFile(join(root, "tracked.txt"), "one\ntwo\n");
    await writeFile(join(root, "staged.txt"), "staged\n");
    git(root, "add", "staged.txt");
    await writeFile(join(root, "untracked.txt"), "loose\n");

    const server = await startHostServer(0, "host-git-diff", undefined);
    servers.push(server);
    const connection = await openRpc(server.websocketUrl, sockets);
    const unstaged = gitGetFileDiffResponseSchema.parse(
      responseResult(
        await rpc(connection, "git.getFileDiff", {
          hostId: "host-git-diff",
          runningDir: root,
          filePath: "tracked.txt",
          previousPath: null,
          stage: "unstaged",
          ignoreWhitespace: false,
          byteBudget: null,
        }),
      ),
    );
    expect(unstaged).toMatchObject({
      filePath: "tracked.txt",
      headSha,
      isTruncated: false,
      truncatedAfterBytes: null,
      isBinary: false,
    });
    expect(unstaged.patch).toContain("+two");
    expect(unstaged.stagedOid).toMatch(/^[a-f0-9]{40,64}$/u);
    expect(unstaged.worktreeOid).toMatch(/^[a-f0-9]{40,64}$/u);

    const truncated = gitGetFileDiffResponseSchema.parse(
      responseResult(
        await rpc(connection, "git.getFileDiff", {
          hostId: "host-git-diff",
          runningDir: root,
          filePath: "tracked.txt",
          previousPath: null,
          stage: "unstaged",
          ignoreWhitespace: false,
          byteBudget: 32,
        }),
      ),
    );
    expect(truncated).toMatchObject({
      isTruncated: true,
      truncatedAfterBytes: 32,
    });
    expect(Buffer.byteLength(truncated.patch)).toBeLessThanOrEqual(32);

    const untracked = gitGetFileDiffResponseSchema.parse(
      responseResult(
        await rpc(connection, "git.getFileDiff", {
          hostId: "host-git-diff",
          runningDir: root,
          filePath: "untracked.txt",
          previousPath: null,
          stage: "untracked",
          ignoreWhitespace: false,
          byteBudget: null,
        }),
      ),
    );
    expect(untracked.patch).toContain("+loose");
    expect(untracked.stagedOid).toBeNull();
    expect(untracked.worktreeOid).toMatch(/^[a-f0-9]{40,64}$/u);

    const batch = gitGetFileDiffsResponseSchema.parse(
      responseResult(
        await rpc(connection, "git.getFileDiffs", {
          hostId: "host-git-diff",
          runningDir: root,
          files: [
            {
              filePath: "tracked.txt",
              previousPath: null,
              stage: "unstaged",
            },
            {
              filePath: "staged.txt",
              previousPath: null,
              stage: "staged",
            },
          ],
          ignoreWhitespace: false,
          byteBudget: 1_048_576,
        }),
      ),
    );
    expect(batch.runningDir).toBe(await realpath(root));
    expect(batch.headSha).toBe(headSha);
    expect(batch.diffs.map((diff) => diff.filePath)).toEqual([
      "tracked.txt",
      "staged.txt",
    ]);
    expect(batch.diffs[0]?.patch).toContain("+two");
    expect(batch.diffs[1]?.patch).toContain("+staged");
    expect(
      batch.diffs.reduce(
        (bytes, diff) => bytes + Buffer.byteLength(diff.patch),
        0,
      ),
    ).toBeLessThanOrEqual(1_048_576);
  });
});

type RpcConnection = {
  readonly ws: WebSocket;
  readonly manifest: Record<
    string,
    { readonly major: number; readonly minor: number }
  >;
  nextRequestId: number;
};

async function openRpc(
  websocketUrl: string,
  sockets: WebSocket[],
): Promise<RpcConnection> {
  const ws = new WebSocket(websocketUrl);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
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
  const opened = hostFrameSchema.parse(JSON.parse(await nextMessage(ws)));
  if (opened.kind !== "openAck") throw new Error("Expected openAck");
  return { ws, manifest: opened.manifest, nextRequestId: 1 };
}

async function rpc(
  connection: RpcConnection,
  method: string,
  params: unknown,
): Promise<HostFrame> {
  const requestId = `git-status-${String(connection.nextRequestId++)}`;
  connection.ws.send(
    JSON.stringify({
      kind: "request",
      requestId,
      method,
      schemaVersion: { major: 1, minor: 0 },
      params,
    }),
  );
  return hostFrameSchema.parse(JSON.parse(await nextMessage(connection.ws)));
}

function responseResult(frame: HostFrame): unknown {
  if (frame.kind !== "response" || frame.error !== null) {
    throw new Error(
      frame.kind === "response"
        ? `${frame.error?.code}: ${frame.error?.message}`
        : "Expected response frame",
    );
  }
  return frame.result;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData): void => {
      ws.off("error", onError);
      resolve(data.toString());
    };
    const onError = (error: Error): void => {
      ws.off("message", onMessage);
      reject(error);
    };
    ws.once("message", onMessage);
    ws.once("error", onError);
  });
}
