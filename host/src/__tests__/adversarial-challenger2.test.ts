import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { type RawData } from "ws";
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
import { getWorkspaceContextResponseSchema } from "@traycer/protocol/host/epic/lane-unaries";
import { earlyMetaEpicSchema } from "@traycer/protocol/host/epic/snapshot-meta";
import { browserSavedLoginSitesResponseSchema } from "@traycer/protocol/host/browser/contracts";
import { earlyMetaForEpic } from "../stream/epic-hub";
import { startHost, type StartedHost } from "../start-host";

interface RpcErrorObject {
  readonly code: string;
  readonly message: string;
}

interface RpcFrameResponse {
  readonly ok: boolean;
  readonly result: unknown;
  readonly error: RpcErrorObject | null;
}

interface RpcVersion {
  readonly major: number;
  readonly minor: number;
}

interface SnapshotMetaWire {
  readonly schemaVersion: string;
  readonly epicLight: Record<string, unknown> | null;
  readonly permissionRole: string | null;
  readonly repos: readonly Record<string, unknown>[];
  readonly workspaces: readonly Record<string, unknown>[];
  readonly repoMapping: readonly Record<string, unknown>[];
  readonly workspaceFolders: readonly Record<string, unknown>[];
  readonly unresolvedRepos: readonly Record<string, unknown>[];
  readonly hostStateVectorBase64: string;
  readonly roomId: string;
}

describe("Adversarial Challenger 2: epic.getWorkspaceContext@1.0 & browser.savedLoginSites@1.0", () => {
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

  describe("1. epic.getWorkspaceContext@1.0: Missing & Invalid epicId Adversarial Tests", () => {
    it("rejects empty string epicId with RPC_ERROR and never returns empty context", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const frame = await rpcExchange(
        started.rpcUrl,
        "epic.getWorkspaceContext",
        { major: 1, minor: 0 },
        { epicId: "" },
      );

      expect(frame.ok).toBe(false);
      expect(frame.result).toBeNull();
      expect(frame.error).toMatchObject({ code: "RPC_ERROR" });
      expect(frame.error?.message).not.toContain(
        "is not implemented by this OSS host",
      );
    });

    it("rejects non-existent UUIDs and random identifiers with RPC_ERROR", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const nonExistentIds: readonly string[] = [
        "00000000-0000-0000-0000-000000000000",
        "c0ffee00-dead-beef-cafe-000000000000",
        "99999999-9999-9999-9999-999999999999",
        "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        "epic-that-does-not-exist-in-store",
      ];

      for (const missingId of nonExistentIds) {
        const frame = await rpcExchange(
          started.rpcUrl,
          "epic.getWorkspaceContext",
          { major: 1, minor: 0 },
          { epicId: missingId },
        );

        expect(frame.ok).toBe(false);
        expect(frame.result).toBeNull();
        expect(frame.error).toMatchObject({ code: "RPC_ERROR" });
        expect(frame.error?.message).toContain(missingId);
        expect(frame.error?.message).not.toContain(
          "is not implemented by this OSS host",
        );
      }
    });

    it("rejects special characters, path traversal, injection vectors, and malformed strings with RPC_ERROR", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const specialCases: readonly string[] = [
        "../../../../etc/passwd",
        "..\\..\\windows\\system32",
        "epic\0injected",
        "<script>alert('xss')</script>",
        "   ",
        "\t\n\r",
        "🚀🔥_epic",
        "日本語エピック",
        "' OR '1'='1",
        "; DROP TABLE epics; --",
        "$(rm -rf /)",
        '{"epicId": "nested"}',
        "a".repeat(5000),
      ];

      for (const specialId of specialCases) {
        const frame = await rpcExchange(
          started.rpcUrl,
          "epic.getWorkspaceContext",
          { major: 1, minor: 0 },
          { epicId: specialId },
        );

        expect(frame.ok).toBe(false);
        expect(frame.result).toBeNull();
        expect(frame.error).toMatchObject({ code: "RPC_ERROR" });
        expect(frame.error?.message).not.toContain(
          "is not implemented by this OSS host",
        );
      }
    });

    it("rejects non-object params, missing keys, and invalid types with RPC_ERROR", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const invalidParams: readonly unknown[] = [
        {},
        { epicId: 12345 },
        { epicId: true },
        { epicId: null },
        { epicId: ["item"] },
        { epicId: { id: "test" } },
        null,
        [],
        "epicId",
      ];

      for (const badParam of invalidParams) {
        const frame = await rpcExchange(
          started.rpcUrl,
          "epic.getWorkspaceContext",
          { major: 1, minor: 0 },
          badParam,
        );

        expect(frame.ok).toBe(false);
        expect(frame.result).toBeNull();
        expect(frame.error).toMatchObject({ code: "RPC_ERROR" });
        expect(frame.error?.message).not.toContain(
          "is not implemented by this OSS host",
        );
      }
    });
  });

  describe("2. epic.getWorkspaceContext@1.0: Response Schema Strict Conformance (7 Fields of EarlyMetaEpic)", () => {
    it("strictly verifies all 7 fields of EarlyMetaEpic for a rich multi-repo multi-workspace epic", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const projDir1 = join(tempDir, "workspace-1");
      const projDir2 = join(tempDir, "workspace-2");
      await mkdir(projDir1, { recursive: true });
      await mkdir(projDir2, { recursive: true });
      await writeFile(join(projDir1, "package.json"), "{}", "utf8");
      await writeFile(join(projDir2, "package.json"), "{}", "utf8");
      const canonical1 = await realpath(projDir1);
      const canonical2 = await realpath(projDir2);

      const now = Date.now();
      await callSuccess(
        started.rpcUrl,
        "epic.create",
        { major: 1, minor: 0 },
        {
          epic: {
            id: "epic-adv-full",
            title: "Adversarial Full Spec Epic",
            initialUserPrompt: "Build an adversarial test suite",
            ticketCount: 10,
            specCount: 5,
            storyCount: 3,
            reviewCount: 1,
            status: "active",
            createdAt: now,
            updatedAt: now,
            createdBy: "tester",
            version: "2.0.0",
          },
          repoIdentifiers: [
            { owner: "org1", repo: "repo-frontend" },
            { owner: "org2", repo: "repo-backend" },
          ],
          workspaces: [
            { workspacePath: canonical1 },
            { workspacePath: canonical2 },
          ],
          chat: null,
        },
      );

      const frame = await rpcExchange(
        started.rpcUrl,
        "epic.getWorkspaceContext",
        { major: 1, minor: 0 },
        { epicId: "epic-adv-full" },
      );

      expect(frame.ok).toBe(true);
      expect(frame.error).toBeNull();

      const parsedWire = getWorkspaceContextResponseSchema.safeParse(
        frame.result,
      );
      expect(parsedWire.success).toBe(true);
      if (!parsedWire.success) {
        return;
      }

      const context = parsedWire.data.context;

      // Verify strict earlyMetaEpicSchema conformance
      const strictParse = earlyMetaEpicSchema.strict().safeParse(context);
      expect(strictParse.success).toBe(true);

      // Verify exactly 7 top-level keys exist on context
      const expectedKeys = [
        "epicLight",
        "permissionRole",
        "repoMapping",
        "repos",
        "unresolvedRepos",
        "workspaceFolders",
        "workspaces",
      ].sort();
      expect(Object.keys(context).sort()).toEqual(expectedKeys);

      // Field 1: epicLight
      expect(context.epicLight).not.toBeNull();
      expect(context.epicLight).toMatchObject({
        id: "epic-adv-full",
        title: "Adversarial Full Spec Epic",
        initialUserPrompt: "Build an adversarial test suite",
        ticketCount: 10,
        specCount: 5,
        storyCount: 3,
        reviewCount: 1,
        status: "active",
        createdAt: now,
        updatedAt: expect.any(Number),
        createdBy: "tester",
        version: "2.0.0",
      });

      // Field 2: permissionRole strictly "owner"
      expect(context.permissionRole).toBe("owner");

      // Field 3: repos (associations)
      expect(context.repos).toHaveLength(2);
      expect(context.repos).toEqual([
        {
          task: { taskId: "epic-adv-full", taskType: "epic" },
          repoIdentifier: { owner: "org1", repo: "repo-frontend" },
          createdAt: now,
          createdBy: "tester",
        },
        {
          task: { taskId: "epic-adv-full", taskType: "epic" },
          repoIdentifier: { owner: "org2", repo: "repo-backend" },
          createdAt: now,
          createdBy: "tester",
        },
      ]);

      // Field 4: workspaces
      expect(context.workspaces).toHaveLength(2);
      expect(context.workspaces).toEqual([
        {
          task: { taskId: "epic-adv-full", taskType: "epic" },
          hostId: started.runtime.hostId,
          workspacePath: canonical1,
          createdAt: now,
        },
        {
          task: { taskId: "epic-adv-full", taskType: "epic" },
          hostId: started.runtime.hostId,
          workspacePath: canonical2,
          createdAt: now,
        },
      ]);

      // Field 5: repoMapping
      expect(context.repoMapping).toEqual([]);

      // Field 6: workspaceFolders
      expect(context.workspaceFolders).toHaveLength(2);
      expect(context.workspaceFolders).toEqual([
        {
          workspacePath: canonical1,
          hostId: started.runtime.hostId,
          repoIdentifier: null,
          lastSyncedAt: null,
        },
        {
          workspacePath: canonical2,
          hostId: started.runtime.hostId,
          repoIdentifier: null,
          lastSyncedAt: null,
        },
      ]);

      // Field 7: unresolvedRepos
      expect(context.unresolvedRepos).toEqual([]);
    });

    it("verifies context for an epic with zero repos and zero workspaces", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const now = Date.now();
      await callSuccess(
        started.rpcUrl,
        "epic.create",
        { major: 1, minor: 0 },
        {
          epic: {
            id: "epic-adv-empty",
            title: "Empty Epic",
            initialUserPrompt: "Empty Prompt",
            ticketCount: 0,
            specCount: 0,
            storyCount: 0,
            reviewCount: 0,
            status: "active",
            createdAt: now,
            updatedAt: now,
            createdBy: "tester",
            version: "2.0.0",
          },
          repoIdentifiers: [],
          workspaces: [],
          chat: null,
        },
      );

      const frame = await rpcExchange(
        started.rpcUrl,
        "epic.getWorkspaceContext",
        { major: 1, minor: 0 },
        { epicId: "epic-adv-empty" },
      );

      expect(frame.ok).toBe(true);
      const parsed = getWorkspaceContextResponseSchema.safeParse(frame.result);
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        return;
      }

      expect(parsed.data.context.permissionRole).toBe("owner");
      expect(parsed.data.context.repos).toEqual([]);
      expect(parsed.data.context.workspaces).toEqual([]);
      expect(parsed.data.context.repoMapping).toEqual([]);
      expect(parsed.data.context.workspaceFolders).toEqual([]);
      expect(parsed.data.context.unresolvedRepos).toEqual([]);
    });

    it("verifies title projection falls back to initialUserPrompt when title is empty", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const now = Date.now();
      await callSuccess(
        started.rpcUrl,
        "epic.create",
        { major: 1, minor: 0 },
        {
          epic: {
            id: "epic-adv-fallback-title",
            title: "",
            initialUserPrompt: "Fix critical payment crash in checkout flow",
            ticketCount: 1,
            specCount: 1,
            storyCount: 1,
            reviewCount: 0,
            status: "active",
            createdAt: now,
            updatedAt: now,
            createdBy: "tester",
            version: "2.0.0",
          },
          repoIdentifiers: [],
          workspaces: [],
          chat: null,
        },
      );

      const frame = await rpcExchange(
        started.rpcUrl,
        "epic.getWorkspaceContext",
        { major: 1, minor: 0 },
        { epicId: "epic-adv-fallback-title" },
      );

      expect(frame.ok).toBe(true);
      const parsed = getWorkspaceContextResponseSchema.safeParse(frame.result);
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        return;
      }

      expect(parsed.data.context.epicLight?.title).toBe(
        "Fix critical payment crash in checkout flow",
      );
    });

    it("verifies context for phase.migrateToEpic preset", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      await callSuccess(
        started.rpcUrl,
        "phase.migrateToEpic",
        { major: 1, minor: 0 },
        { phaseId: "phase-migrated-adv" },
      );

      const frame = await rpcExchange(
        started.rpcUrl,
        "epic.getWorkspaceContext",
        { major: 1, minor: 0 },
        { epicId: "phase-migrated-adv" },
      );

      expect(frame.ok).toBe(true);
      const parsed = getWorkspaceContextResponseSchema.safeParse(frame.result);
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        return;
      }

      expect(parsed.data.context.permissionRole).toBe("owner");
      expect(parsed.data.context.epicLight?.id).toBe("phase-migrated-adv");
      expect(parsed.data.context.epicLight?.title).toBe("Migrated phase");
      expect(parsed.data.context.repos).toEqual([]);
      expect(parsed.data.context.workspaces).toEqual([]);
      expect(parsed.data.context.workspaceFolders).toEqual([]);
      expect(parsed.data.context.repoMapping).toEqual([]);
      expect(parsed.data.context.unresolvedRepos).toEqual([]);
    });
  });

  describe("3. Isomorphism between epic.getWorkspaceContext and snapshotMeta", () => {
    it("confirms context matches live WebSocket stream snapshotMeta exactly", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const projDir = join(tempDir, "workspace-stream");
      await mkdir(projDir, { recursive: true });
      await writeFile(join(projDir, "package.json"), "{}", "utf8");
      const canonical = await realpath(projDir);

      const now = Date.now();
      await callSuccess(
        started.rpcUrl,
        "epic.create",
        { major: 1, minor: 0 },
        {
          epic: {
            id: "epic-stream-isomorphism",
            title: "Stream Isomorphism Test",
            initialUserPrompt: "Verify isomorphism with stream",
            ticketCount: 2,
            specCount: 1,
            storyCount: 1,
            reviewCount: 0,
            status: "active",
            createdAt: now,
            updatedAt: now,
            createdBy: "tester",
            version: "2.0.0",
          },
          repoIdentifiers: [{ owner: "org", repo: "test-repo" }],
          workspaces: [{ workspacePath: canonical }],
          chat: null,
        },
      );

      // 1. Fetch unary workspace context
      const unaryFrame = await rpcExchange(
        started.rpcUrl,
        "epic.getWorkspaceContext",
        { major: 1, minor: 0 },
        { epicId: "epic-stream-isomorphism" },
      );
      expect(unaryFrame.ok).toBe(true);
      const unaryParsed = getWorkspaceContextResponseSchema.safeParse(
        unaryFrame.result,
      );
      expect(unaryParsed.success).toBe(true);
      if (!unaryParsed.success) {
        return;
      }
      const unaryContext = unaryParsed.data.context;

      // 2. Open live stream subscription and capture snapshotMeta
      const streamMeta = await streamSnapshotExchange(
        started.rpcUrl,
        "epic-stream-isomorphism",
      );

      // 3. Verify exact 7-field isomorphism between unary context and stream snapshotMeta
      expect(unaryContext.epicLight).toEqual(streamMeta.epicLight);
      expect(unaryContext.permissionRole).toBe(streamMeta.permissionRole);
      expect(unaryContext.repos).toEqual(streamMeta.repos);
      expect(unaryContext.workspaces).toEqual(streamMeta.workspaces);
      expect(unaryContext.repoMapping).toEqual(streamMeta.repoMapping);
      expect(unaryContext.workspaceFolders).toEqual(
        streamMeta.workspaceFolders,
      );
      expect(unaryContext.unresolvedRepos).toEqual(streamMeta.unresolvedRepos);
    });

    it("confirms context is directly identical to earlyMetaForEpic helper", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const now = Date.now();
      await callSuccess(
        started.rpcUrl,
        "epic.create",
        { major: 1, minor: 0 },
        {
          epic: {
            id: "epic-helper-identity",
            title: "Helper Identity Epic",
            initialUserPrompt: "Test direct helper output",
            ticketCount: 4,
            specCount: 2,
            storyCount: 2,
            reviewCount: 0,
            status: "active",
            createdAt: now,
            updatedAt: now,
            createdBy: "tester",
            version: "2.0.0",
          },
          repoIdentifiers: [],
          workspaces: [],
          chat: null,
        },
      );

      const frame = await rpcExchange(
        started.rpcUrl,
        "epic.getWorkspaceContext",
        { major: 1, minor: 0 },
        { epicId: "epic-helper-identity" },
      );
      expect(frame.ok).toBe(true);
      const parsed = getWorkspaceContextResponseSchema.safeParse(frame.result);
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        return;
      }

      const helperMeta = earlyMetaForEpic(
        started.runtime,
        "epic-helper-identity",
      );
      expect(helperMeta).not.toBeNull();
      expect(parsed.data.context).toEqual(helperMeta);
    });

    it("handles concurrent calls to epic.getWorkspaceContext deterministically without race conditions", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const now = Date.now();
      await callSuccess(
        started.rpcUrl,
        "epic.create",
        { major: 1, minor: 0 },
        {
          epic: {
            id: "epic-concurrent-test",
            title: "Concurrent Read Epic",
            initialUserPrompt: "Concurrent read prompt",
            ticketCount: 3,
            specCount: 2,
            storyCount: 1,
            reviewCount: 0,
            status: "active",
            createdAt: now,
            updatedAt: now,
            createdBy: "tester",
            version: "2.0.0",
          },
          repoIdentifiers: [],
          workspaces: [],
          chat: null,
        },
      );

      const promises = Array.from({ length: 10 }, async () => {
        if (started === null) {
          throw new Error("started is null");
        }
        return rpcExchange(
          started.rpcUrl,
          "epic.getWorkspaceContext",
          { major: 1, minor: 0 },
          { epicId: "epic-concurrent-test" },
        );
      });

      const results = await Promise.all(promises);
      for (const frame of results) {
        expect(frame.ok).toBe(true);
        expect(frame.error).toBeNull();
        const parsed = getWorkspaceContextResponseSchema.safeParse(
          frame.result,
        );
        expect(parsed.success).toBe(true);
        if (parsed.success) {
          expect(parsed.data.context.epicLight?.id).toBe(
            "epic-concurrent-test",
          );
          expect(parsed.data.context.permissionRole).toBe("owner");
        }
      }
    });
  });

  describe("4. browser.savedLoginSites@1.0: Strict Request Schema & Empty Sites Response", () => {
    it("rejects extra unrecognized parameters with RPC_ERROR due to .strict()", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const extraKeyPayloads: readonly Record<string, unknown>[] = [
        { unexpectedKey: "test" },
        { filter: "active" },
        { sites: [] },
        { kind: "sites" },
        { userId: "user-123" },
        { count: 10, offset: 0 },
        { extra: { nested: true } },
      ];

      for (const payload of extraKeyPayloads) {
        const frame = await rpcExchange(
          started.rpcUrl,
          "browser.savedLoginSites",
          { major: 1, minor: 0 },
          payload,
        );

        expect(frame.ok).toBe(false);
        expect(frame.result).toBeNull();
        expect(frame.error).toMatchObject({ code: "RPC_ERROR" });
        expect(frame.error?.message).not.toContain(
          "is not implemented by this OSS host",
        );
      }
    });

    it("rejects invalid request types (non-object or array) with RPC_ERROR", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const invalidTypes: readonly unknown[] = [
        null,
        [],
        "sites",
        12345,
        true,
        false,
      ];

      for (const badType of invalidTypes) {
        const frame = await rpcExchange(
          started.rpcUrl,
          "browser.savedLoginSites",
          { major: 1, minor: 0 },
          badType,
        );

        expect(frame.ok).toBe(false);
        expect(frame.result).toBeNull();
        expect(frame.error).toMatchObject({ code: "RPC_ERROR" });
        expect(frame.error?.message).not.toContain(
          "is not implemented by this OSS host",
        );
      }
    });

    it("returns { kind: 'sites', sites: [] } with strict key set for valid empty request", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const frame = await rpcExchange(
        started.rpcUrl,
        "browser.savedLoginSites",
        { major: 1, minor: 0 },
        {},
      );

      expect(frame.ok).toBe(true);
      expect(frame.error).toBeNull();

      const parsed = browserSavedLoginSitesResponseSchema.safeParse(
        frame.result,
      );
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        return;
      }

      expect(frame.result).toEqual({ kind: "sites", sites: [] });

      if (typeof frame.result === "object" && frame.result !== null) {
        expect(Object.keys(frame.result).sort()).toEqual(["kind", "sites"]);
      }
    });

    it("handles concurrent calls to browser.savedLoginSites deterministically", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const promises = Array.from({ length: 10 }, async () => {
        if (started === null) {
          throw new Error("started is null");
        }
        return rpcExchange(
          started.rpcUrl,
          "browser.savedLoginSites",
          { major: 1, minor: 0 },
          {},
        );
      });

      const results = await Promise.all(promises);
      for (const frame of results) {
        expect(frame.ok).toBe(true);
        expect(frame.error).toBeNull();
        expect(frame.result).toEqual({ kind: "sites", sites: [] });
      }
    });
  });
});

async function boot(): Promise<{
  readonly started: StartedHost;
  readonly tempDir: string;
}> {
  const tempDir = await mkdtemp(join(tmpdir(), "traycer-adv-tests-"));
  const started = await startHost({
    argv: ["--host-data-dir", tempDir],
    listenHost: "127.0.0.1",
    listenPort: 0,
  });
  return { started, tempDir };
}

async function callSuccess(
  url: string,
  method: string,
  schemaVersion: RpcVersion,
  params: unknown,
): Promise<unknown> {
  const frame = await rpcExchange(url, method, schemaVersion, params);
  if (!frame.ok || frame.error !== null) {
    throw new Error(`RPC error for ${method}: ${JSON.stringify(frame.error)}`);
  }
  return frame.result;
}

async function rpcExchange(
  url: string,
  method: string,
  schemaVersion: RpcVersion,
  params: unknown,
): Promise<RpcFrameResponse> {
  const clientManifests = splitConnectionManifest(
    hostRpcRegistry,
    RELEASED_FLOOR_METHOD_NAMES,
    SERVES_EVERY_INSTALLED_MAJOR,
  );
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      resolve();
    });
    socket.once("error", (err: Error) => {
      reject(err);
    });
  });
  const frames: unknown[] = [];
  const done = new Promise<void>((resolve, reject) => {
    socket.on("message", (data: RawData) => {
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
    socket.once("close", () => {
      resolve();
    });
    socket.once("error", (err: Error) => {
      reject(err);
    });
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
  let errorObj: RpcErrorObject | null = null;
  const rawError = "error" in response ? response.error : null;
  if (rawError !== null && typeof rawError === "object") {
    const codeVal =
      "code" in rawError && typeof rawError.code === "string"
        ? rawError.code
        : "UNKNOWN";
    const messageVal =
      "message" in rawError && typeof rawError.message === "string"
        ? rawError.message
        : "";
    errorObj = { code: codeVal, message: messageVal };
  }
  const hasError =
    errorObj !== null || ("error" in response && response.error !== null);
  const res = "result" in response ? response.result : null;
  return {
    ok: !hasError,
    result: res,
    error: errorObj,
  };
}

async function streamSnapshotExchange(
  url: string,
  epicId: string,
): Promise<SnapshotMetaWire> {
  const streamUrl = url.replace(/\/rpc$/u, "/stream");
  const socket = new WebSocket(streamUrl);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      resolve();
    });
    socket.once("error", (err: Error) => {
      reject(err);
    });
  });

  return new Promise<SnapshotMetaWire>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out waiting for snapshot frame"));
    }, 4000);

    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        return;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(String(data));
      } catch (err: unknown) {
        clearTimeout(timeout);
        socket.close();
        reject(new Error(`Failed to parse stream message: ${String(err)}`));
        return;
      }
      if (
        frame !== null &&
        typeof frame === "object" &&
        "kind" in frame &&
        frame.kind === "openAck"
      ) {
        socket.send(
          JSON.stringify({
            kind: "subscribe",
            requestId: "sub-1",
            method: "epic.subscribe",
            schemaVersion: { major: 1, minor: 3 },
            params: { epicId },
          }),
        );
        return;
      }
      if (
        frame !== null &&
        typeof frame === "object" &&
        "kind" in frame &&
        frame.kind === "snapshot" &&
        "meta" in frame &&
        frame.meta !== null &&
        typeof frame.meta === "object"
      ) {
        clearTimeout(timeout);
        const meta = frame.meta as SnapshotMetaWire;
        socket.close();
        resolve(meta);
      }
    });

    socket.once("error", (err: Error) => {
      clearTimeout(timeout);
      reject(err);
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
  });
}
