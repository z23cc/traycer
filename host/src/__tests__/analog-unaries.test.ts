import {
  mkdir,
  mkdtemp,
  readFile,
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
import { getWorkspaceContextResponseSchema } from "@traycer/protocol/host/epic/lane-unaries";
import { browserSavedLoginSitesResponseSchema } from "@traycer/protocol/host/browser/contracts";
import { configLogLevelsResponseSchema } from "@traycer/protocol/host/config/schemas";
import { hostIdentitySchema } from "@traycer/protocol/host/identity/schemas";
import {
  hostGetInstallationInfoResponseV11Schema,
  hostServiceStatusResponseSchema,
  hostUpdateCheckResponseSchemaV11,
} from "@traycer/protocol/host/maintenance/schemas";
import { hostInstallRecordSchema } from "@traycer/protocol/config/installation-records";
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

describe("7 optional analog unaries (@traycer/protocol conformance)", () => {
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

  describe("1. Schema Contract Tests", () => {
    it("epic.getWorkspaceContext@1.0 returns response conforming to schema", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      await callSuccess(
        started.rpcUrl,
        "phase.migrateToEpic",
        { major: 1, minor: 0 },
        { phaseId: "epic-schema-1" },
      );

      const frame = await rpcExchange(
        started.rpcUrl,
        "epic.getWorkspaceContext",
        { major: 1, minor: 0 },
        { epicId: "epic-schema-1" },
      );

      expect(frame.ok).toBe(true);
      expect(frame.error).toBeNull();
      const parsed = getWorkspaceContextResponseSchema.safeParse(frame.result);
      expect(parsed.success).toBe(true);
    });

    it("browser.savedLoginSites@1.0 returns response conforming to schema", async () => {
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
      expect(frame.result).toEqual({ kind: "sites", sites: [] });
    });

    it("config.logLevels.get@1.0 & config.logLevels.set@1.0 return responses conforming to schema", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const getFrame = await rpcExchange(
        started.rpcUrl,
        "config.logLevels.get",
        { major: 1, minor: 0 },
        {},
      );
      expect(getFrame.ok).toBe(true);
      expect(getFrame.error).toBeNull();
      const parsedGet = configLogLevelsResponseSchema.safeParse(
        getFrame.result,
      );
      expect(parsedGet.success).toBe(true);

      const setFrame = await rpcExchange(
        started.rpcUrl,
        "config.logLevels.set",
        { major: 1, minor: 0 },
        { scope: "cli", level: "debug" },
      );
      expect(setFrame.ok).toBe(true);
      expect(setFrame.error).toBeNull();
      const parsedSet = configLogLevelsResponseSchema.safeParse(
        setFrame.result,
      );
      expect(parsedSet.success).toBe(true);
    });

    it("host.identity.get@1.0 & host.identity.set@1.0 return responses conforming to schema", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const getFrame = await rpcExchange(
        started.rpcUrl,
        "host.identity.get",
        { major: 1, minor: 0 },
        {},
      );
      expect(getFrame.ok).toBe(true);
      expect(getFrame.error).toBeNull();
      const parsedGet = hostIdentitySchema.safeParse(getFrame.result);
      expect(parsedGet.success).toBe(true);

      const setFrame = await rpcExchange(
        started.rpcUrl,
        "host.identity.set",
        { major: 1, minor: 0 },
        { customName: "Office Workstation" },
      );
      expect(setFrame.ok).toBe(true);
      expect(setFrame.error).toBeNull();
      const parsedSet = hostIdentitySchema.safeParse(setFrame.result);
      expect(parsedSet.success).toBe(true);
    });

    it("host.update.check@1.1 returns response conforming to schema", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const frame = await rpcExchange(
        started.rpcUrl,
        "host.update.check",
        { major: 1, minor: 1 },
        { includePreReleases: false },
      );
      expect(frame.ok).toBe(true);
      expect(frame.error).toBeNull();
      const parsed = hostUpdateCheckResponseSchemaV11.safeParse(frame.result);
      expect(parsed.success).toBe(true);
    });

    it("host.getInstallationInfo@1.1 returns response conforming to schema", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const frame = await rpcExchange(
        started.rpcUrl,
        "host.getInstallationInfo",
        { major: 1, minor: 1 },
        {},
      );
      expect(frame.ok).toBe(true);
      expect(frame.error).toBeNull();
      const parsed = hostGetInstallationInfoResponseV11Schema.safeParse(
        frame.result,
      );
      expect(parsed.success).toBe(true);
    });

    it("host.service.status@1.0 returns response conforming to schema", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const frame = await rpcExchange(
        started.rpcUrl,
        "host.service.status",
        { major: 1, minor: 0 },
        {},
      );
      expect(frame.ok).toBe(true);
      expect(frame.error).toBeNull();
      const parsed = hostServiceStatusResponseSchema.safeParse(frame.result);
      expect(parsed.success).toBe(true);
    });
  });

  describe("2. Invalid Parameter Tests", () => {
    it("epic.getWorkspaceContext returns RPC_ERROR when epicId does not exist", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const frame = await rpcExchange(
        started.rpcUrl,
        "epic.getWorkspaceContext",
        { major: 1, minor: 0 },
        { epicId: "non-existent-epic-id-404" },
      );

      expect(frame.ok).toBe(false);
      expect(frame.result).toBeNull();
      expect(frame.error).toMatchObject({ code: "RPC_ERROR" });
      expect(frame.error?.message).not.toContain(
        "is not implemented by this OSS host",
      );
      expect(frame.error?.message).toContain("non-existent-epic-id-404");
    });

    it("epic.getWorkspaceContext returns RPC_ERROR on empty epicId string", async () => {
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

    it("host.identity.set returns RPC_ERROR when customName exceeds 80 characters", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const tooLongName = "a".repeat(81);
      const frame = await rpcExchange(
        started.rpcUrl,
        "host.identity.set",
        { major: 1, minor: 0 },
        { customName: tooLongName },
      );

      expect(frame.ok).toBe(false);
      expect(frame.result).toBeNull();
      expect(frame.error).toMatchObject({ code: "RPC_ERROR" });
      expect(frame.error?.message).not.toContain(
        "is not implemented by this OSS host",
      );
    });

    it("config.logLevels.set returns RPC_ERROR on invalid scope", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const frame = await rpcExchange(
        started.rpcUrl,
        "config.logLevels.set",
        { major: 1, minor: 0 },
        { scope: "desktop", level: "info" },
      );

      expect(frame.ok).toBe(false);
      expect(frame.result).toBeNull();
      expect(frame.error).toMatchObject({ code: "RPC_ERROR" });
      expect(frame.error?.message).not.toContain(
        "is not implemented by this OSS host",
      );
    });

    it("config.logLevels.set returns RPC_ERROR on invalid log level", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const frame = await rpcExchange(
        started.rpcUrl,
        "config.logLevels.set",
        { major: 1, minor: 0 },
        { scope: "host", level: "verbose" },
      );

      expect(frame.ok).toBe(false);
      expect(frame.result).toBeNull();
      expect(frame.error).toMatchObject({ code: "RPC_ERROR" });
      expect(frame.error?.message).not.toContain(
        "is not implemented by this OSS host",
      );
    });

    it("browser.savedLoginSites returns RPC_ERROR on extra unrecognized properties", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const frame = await rpcExchange(
        started.rpcUrl,
        "browser.savedLoginSites",
        { major: 1, minor: 0 },
        { unrecognizedProperty: true },
      );

      expect(frame.ok).toBe(false);
      expect(frame.result).toBeNull();
      expect(frame.error).toMatchObject({ code: "RPC_ERROR" });
      expect(frame.error?.message).not.toContain(
        "is not implemented by this OSS host",
      );
    });
  });

  describe("3. Pre-set Epic Tests", () => {
    it("populates epicLight, repos, workspaces, and workspaceFolders for epic.create", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const projDir = join(tempDir, "workspace-a");
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
            id: "epic-preset-1",
            title: "Preset Task Title",
            initialUserPrompt: "Preset User Prompt",
            ticketCount: 3,
            specCount: 2,
            storyCount: 1,
            reviewCount: 0,
            status: "active",
            createdAt: now,
            updatedAt: now,
            createdBy: "local",
            version: "2.0.0",
          },
          repoIdentifiers: [{ owner: "org", repo: "frontend-repo" }],
          workspaces: [{ workspacePath: canonical }],
          chat: null,
        },
      );

      const frame = await rpcExchange(
        started.rpcUrl,
        "epic.getWorkspaceContext",
        { major: 1, minor: 0 },
        { epicId: "epic-preset-1" },
      );

      expect(frame.ok).toBe(true);
      expect(frame.error).toBeNull();
      expect(
        getWorkspaceContextResponseSchema.safeParse(frame.result).success,
      ).toBe(true);

      expect(frame.result).toMatchObject({
        context: {
          epicLight: {
            id: "epic-preset-1",
            title: "Preset Task Title",
            initialUserPrompt: "Preset User Prompt",
            ticketCount: 3,
            specCount: 2,
            storyCount: 1,
            reviewCount: 0,
            status: "active",
            createdAt: expect.any(Number),
            updatedAt: expect.any(Number),
            createdBy: "local",
            version: "2.0.0",
          },
          permissionRole: "owner",
          repos: [
            {
              task: { taskId: "epic-preset-1", taskType: "epic" },
              repoIdentifier: { owner: "org", repo: "frontend-repo" },
              createdAt: expect.any(Number),
              createdBy: "local",
            },
          ],
          workspaces: [
            {
              task: { taskId: "epic-preset-1", taskType: "epic" },
              hostId: started.runtime.hostId,
              workspacePath: canonical,
              createdAt: expect.any(Number),
            },
          ],
          repoMapping: [],
          workspaceFolders: [
            {
              workspacePath: canonical,
              hostId: started.runtime.hostId,
              repoIdentifier: null,
              lastSyncedAt: null,
            },
          ],
          unresolvedRepos: [],
        },
      });
    });

    it("returns valid context for phase.migrateToEpic preset", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      await callSuccess(
        started.rpcUrl,
        "phase.migrateToEpic",
        { major: 1, minor: 0 },
        { phaseId: "phase-migrated-42" },
      );

      const frame = await rpcExchange(
        started.rpcUrl,
        "epic.getWorkspaceContext",
        { major: 1, minor: 0 },
        { epicId: "phase-migrated-42" },
      );

      expect(frame.ok).toBe(true);
      expect(frame.error).toBeNull();
      expect(
        getWorkspaceContextResponseSchema.safeParse(frame.result).success,
      ).toBe(true);

      expect(frame.result).toMatchObject({
        context: {
          epicLight: {
            id: "phase-migrated-42",
            title: "Migrated phase",
            status: "active",
          },
          permissionRole: "owner",
          repos: [],
          workspaces: [],
          repoMapping: [],
          workspaceFolders: [],
          unresolvedRepos: [],
        },
      });
    });
  });

  describe("4. State Persistence Tests", () => {
    it("config.logLevels.set updates and persists CLI and host log levels", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const initialGet = await callSuccess(
        started.rpcUrl,
        "config.logLevels.get",
        { major: 1, minor: 0 },
        {},
      );
      expect(initialGet).toEqual({
        cliLogLevel: "info",
        hostLogLevel: "info",
      });

      const setCli = await callSuccess(
        started.rpcUrl,
        "config.logLevels.set",
        { major: 1, minor: 0 },
        { scope: "cli", level: "debug" },
      );
      expect(setCli).toEqual({
        cliLogLevel: "debug",
        hostLogLevel: "info",
      });

      const verifyCli = await callSuccess(
        started.rpcUrl,
        "config.logLevels.get",
        { major: 1, minor: 0 },
        {},
      );
      expect(verifyCli).toEqual({
        cliLogLevel: "debug",
        hostLogLevel: "info",
      });

      const setHost = await callSuccess(
        started.rpcUrl,
        "config.logLevels.set",
        { major: 1, minor: 0 },
        { scope: "host", level: "warn" },
      );
      expect(setHost).toEqual({
        cliLogLevel: "debug",
        hostLogLevel: "warn",
      });

      const verifyHost = await callSuccess(
        started.rpcUrl,
        "config.logLevels.get",
        { major: 1, minor: 0 },
        {},
      );
      expect(verifyHost).toEqual({
        cliLogLevel: "debug",
        hostLogLevel: "warn",
      });

      const persistedJson = await readFile(
        join(tempDir, "log-levels.json"),
        "utf8",
      );
      expect(JSON.parse(persistedJson)).toEqual({
        cliLogLevel: "debug",
        hostLogLevel: "warn",
      });
    });

    it("host.identity.set normalizes whitespace, rejects long names, and reflects in effectiveName", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const initialGet = (await callSuccess(
        started.rpcUrl,
        "host.identity.get",
        { major: 1, minor: 0 },
        {},
      )) as {
        systemName: string;
        customName: string | null;
        effectiveName: string;
      };

      expect(typeof initialGet.systemName).toBe("string");
      expect(initialGet.systemName.length).toBeGreaterThan(0);
      expect(initialGet.customName).toBeNull();
      expect(initialGet.effectiveName).toBe(initialGet.systemName);

      const setNameWithSpaces = (await callSuccess(
        started.rpcUrl,
        "host.identity.set",
        { major: 1, minor: 0 },
        { customName: "  my   server  " },
      )) as {
        systemName: string;
        customName: string | null;
        effectiveName: string;
      };

      expect(setNameWithSpaces.customName).toBe("my server");
      expect(setNameWithSpaces.effectiveName).toBe("my server");

      const verifyGet = (await callSuccess(
        started.rpcUrl,
        "host.identity.get",
        { major: 1, minor: 0 },
        {},
      )) as {
        systemName: string;
        customName: string | null;
        effectiveName: string;
      };

      expect(verifyGet.customName).toBe("my server");
      expect(verifyGet.effectiveName).toBe("my server");

      const boundaryNameRaw =
        "  " + "a".repeat(70) + "   " + "b".repeat(9) + "  ";
      const boundaryExpected = "a".repeat(70) + " " + "b".repeat(9);
      expect(boundaryExpected.length).toBe(80);

      const setBoundary = (await callSuccess(
        started.rpcUrl,
        "host.identity.set",
        { major: 1, minor: 0 },
        { customName: boundaryNameRaw },
      )) as {
        systemName: string;
        customName: string | null;
        effectiveName: string;
      };
      expect(setBoundary.customName).toBe(boundaryExpected);
      expect(setBoundary.effectiveName).toBe(boundaryExpected);

      const persistedIdentity = await readFile(
        join(tempDir, "host-name.json"),
        "utf8",
      );
      expect(JSON.parse(persistedIdentity)).toEqual({
        customName: boundaryExpected,
      });

      const clearWhitespace = (await callSuccess(
        started.rpcUrl,
        "host.identity.set",
        { major: 1, minor: 0 },
        { customName: "    " },
      )) as {
        systemName: string;
        customName: string | null;
        effectiveName: string;
      };
      expect(clearWhitespace.customName).toBeNull();
      expect(clearWhitespace.effectiveName).toBe(initialGet.systemName);

      const clearNull = (await callSuccess(
        started.rpcUrl,
        "host.identity.set",
        { major: 1, minor: 0 },
        { customName: null },
      )) as {
        systemName: string;
        customName: string | null;
        effectiveName: string;
      };
      expect(clearNull.customName).toBeNull();
      expect(clearNull.effectiveName).toBe(initialGet.systemName);
    });
  });

  describe("5. Maintenance & Installation Info Tests", () => {
    it("host.update.check@1.1 returns cli-unavailable outcome", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const resDefault = await callSuccess(
        started.rpcUrl,
        "host.update.check",
        { major: 1, minor: 1 },
        {},
      );
      expect(resDefault).toEqual({ outcome: "cli-unavailable" });

      const resIncludePre = await callSuccess(
        started.rpcUrl,
        "host.update.check",
        { major: 1, minor: 1 },
        { includePreReleases: true },
      );
      expect(resIncludePre).toEqual({ outcome: "cli-unavailable" });
    });

    it("host.service.status@1.0 returns externally-managed outcome", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const res = await callSuccess(
        started.rpcUrl,
        "host.service.status",
        { major: 1, minor: 0 },
        {},
      );
      expect(res).toEqual({ outcome: "externally-managed" });
    });

    it("host.getInstallationInfo@1.1 returns unmanaged when install/install.json is absent or corrupt", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const resAbsent = await callSuccess(
        started.rpcUrl,
        "host.getInstallationInfo",
        { major: 1, minor: 1 },
        {},
      );
      expect(resAbsent).toEqual({ status: "unmanaged" });

      const installDir = join(tempDir, "install");
      await mkdir(installDir, { recursive: true });
      await writeFile(
        join(installDir, "install.json"),
        "invalid-json-content{{{",
        "utf8",
      );

      const resCorrupt = await callSuccess(
        started.rpcUrl,
        "host.getInstallationInfo",
        { major: 1, minor: 1 },
        {},
      );
      expect(resCorrupt).toEqual({ status: "unmanaged" });
    });

    it("host.getInstallationInfo@1.1 returns managed when install/install.json has valid record", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const validInstallRecord = {
        installId: "inst-test-12345",
        version: "1.2.0",
        runtimeVersion: "1.2.0",
        platform: "darwin",
        arch: "arm64",
        installedAt: "2026-09-06T12:00:00.000Z",
        source: { kind: "registry", value: "official" },
        archiveSha256: null,
        signatureVerifiedAt: "2026-09-06T12:00:00.000Z",
        signatureKeyId: "key-traycer-test",
        sizeBytes: 15432100,
        executablePath: "/usr/local/bin/traycer-host",
        executableSha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      };
      expect(
        hostInstallRecordSchema.safeParse(validInstallRecord).success,
      ).toBe(true);

      const installDir = join(tempDir, "install");
      await mkdir(installDir, { recursive: true });
      await writeFile(
        join(installDir, "install.json"),
        JSON.stringify(validInstallRecord, null, 2),
        "utf8",
      );

      const res = await callSuccess(
        started.rpcUrl,
        "host.getInstallationInfo",
        { major: 1, minor: 1 },
        {},
      );

      expect(
        hostGetInstallationInfoResponseV11Schema.safeParse(res).success,
      ).toBe(true);
      expect(res).toEqual({
        status: "managed",
        installRecord: validInstallRecord,
        stagedRecord: null,
        cliManifest: null,
      });
    });

    it("browser.savedLoginSites@1.0 returns empty sites array", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const res = await callSuccess(
        started.rpcUrl,
        "browser.savedLoginSites",
        { major: 1, minor: 0 },
        {},
      );

      expect(res).toEqual({ kind: "sites", sites: [] });
    });
  });
});

async function boot(): Promise<{
  readonly started: StartedHost;
  readonly tempDir: string;
}> {
  const tempDir = await mkdtemp(join(tmpdir(), "traycer-analog-tests-"));
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
    socket.on("message", (data: WebSocket.RawData) => {
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
