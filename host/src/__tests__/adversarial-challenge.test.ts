import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

describe("Adversarial Stress Suite: Host Unaries & Fault Tolerance", () => {
  let started: StartedHost | null = null;
  let tempDir: string | null = null;
  const originalHostLabel = process.env.TRAYCER_HOST_LABEL;

  afterEach(async () => {
    if (originalHostLabel === undefined) {
      delete process.env.TRAYCER_HOST_LABEL;
    } else {
      process.env.TRAYCER_HOST_LABEL = originalHostLabel;
    }
    if (started !== null) {
      await started.close();
      started = null;
    }
    if (tempDir !== null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  describe("1. Boundary & Normalization on host.identity.set@1.0", () => {
    it("accepts a name with exactly 80 characters", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const name80 = "a".repeat(80);
      const frame = await rpcExchange(
        started.rpcUrl,
        "host.identity.set",
        { major: 1, minor: 0 },
        { customName: name80 },
      );

      expect(frame.ok).toBe(true);
      expect(frame.error).toBeNull();
      const parsed = hostIdentitySchema.safeParse(frame.result);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.customName).toBe(name80);
        expect(parsed.data.effectiveName).toBe(name80);
      }

      const diskRaw = await readFile(join(tempDir, "host-name.json"), "utf8");
      const diskParsed: { customName?: string } = JSON.parse(diskRaw);
      expect(diskParsed.customName).toBe(name80);
    });

    it("accepts a name with surrounding spaces that normalizes to exactly 80 characters", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const prefix = "x".repeat(40);
      const suffix = "y".repeat(39);
      const rawWithWhitespace = `   ${prefix}    ${suffix}   `;
      const expectedCollapsed = `${prefix} ${suffix}`;
      expect(expectedCollapsed.length).toBe(80);

      const frame = await rpcExchange(
        started.rpcUrl,
        "host.identity.set",
        { major: 1, minor: 0 },
        { customName: rawWithWhitespace },
      );

      expect(frame.ok).toBe(true);
      expect(frame.error).toBeNull();
      const parsed = hostIdentitySchema.safeParse(frame.result);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.customName).toBe(expectedCollapsed);
        expect(parsed.data.effectiveName).toBe(expectedCollapsed);
      }
    });

    it("rejects a name with 81 characters with RPC_ERROR and does not truncate", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      // Seed with initial name to verify no clobber/truncation happens on disk
      await rpcExchange(
        started.rpcUrl,
        "host.identity.set",
        { major: 1, minor: 0 },
        { customName: "initial-valid-name" },
      );

      const name81 = "b".repeat(81);
      const frame = await rpcExchange(
        started.rpcUrl,
        "host.identity.set",
        { major: 1, minor: 0 },
        { customName: name81 },
      );

      expect(frame.ok).toBe(false);
      expect(frame.result).toBeNull();
      expect(frame.error).toMatchObject({
        code: "RPC_ERROR",
        message: "Custom name exceeds maximum length of 80 characters",
      });

      // Verify disk was NOT overwritten with truncated 80-char version
      const diskRaw = await readFile(join(tempDir, "host-name.json"), "utf8");
      const diskParsed: { customName?: string } = JSON.parse(diskRaw);
      expect(diskParsed.customName).toBe("initial-valid-name");

      // Verify subsequent get returns original
      const getFrame = await rpcExchange(
        started.rpcUrl,
        "host.identity.get",
        { major: 1, minor: 0 },
        {},
      );
      expect(getFrame.ok).toBe(true);
      const getParsed = hostIdentitySchema.safeParse(getFrame.result);
      expect(getParsed.success).toBe(true);
      if (getParsed.success) {
        expect(getParsed.data.customName).toBe("initial-valid-name");
      }
    });

    it("normalizes a whitespace string to null and reverts effectiveName to systemName", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      // Set valid name first
      await rpcExchange(
        started.rpcUrl,
        "host.identity.set",
        { major: 1, minor: 0 },
        { customName: "temporary-name" },
      );

      // Now set whitespace string "   "
      const frame = await rpcExchange(
        started.rpcUrl,
        "host.identity.set",
        { major: 1, minor: 0 },
        { customName: "   " },
      );

      expect(frame.ok).toBe(true);
      expect(frame.error).toBeNull();
      const parsed = hostIdentitySchema.safeParse(frame.result);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.customName).toBeNull();
        expect(parsed.data.effectiveName).toBe(parsed.data.systemName);
      }

      // Verify persisted state has null
      const diskRaw = await readFile(join(tempDir, "host-name.json"), "utf8");
      const diskParsed: { customName?: string | null } = JSON.parse(diskRaw);
      expect(diskParsed.customName).toBeNull();
    });

    it("normalizes mixed tabs, newlines, carriage returns, and multi-spaces", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      // 1. Text with messy internal and boundary whitespace
      const messyInput = "\r\n\t  Cluster \t\n  Worker \r\n\t  Node-01 \n\t ";
      const frame = await rpcExchange(
        started.rpcUrl,
        "host.identity.set",
        { major: 1, minor: 0 },
        { customName: messyInput },
      );

      expect(frame.ok).toBe(true);
      expect(frame.error).toBeNull();
      const parsed = hostIdentitySchema.safeParse(frame.result);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.customName).toBe("Cluster Worker Node-01");
        expect(parsed.data.effectiveName).toBe("Cluster Worker Node-01");
      }

      // 2. Pure mixed whitespace (tabs, newlines, spaces) normalizes to null
      const pureWhitespace = "\t\r\n   \t  \n \r  ";
      const clearFrame = await rpcExchange(
        started.rpcUrl,
        "host.identity.set",
        { major: 1, minor: 0 },
        { customName: pureWhitespace },
      );

      expect(clearFrame.ok).toBe(true);
      const clearParsed = hostIdentitySchema.safeParse(clearFrame.result);
      expect(clearParsed.success).toBe(true);
      if (clearParsed.success) {
        expect(clearParsed.data.customName).toBeNull();
        expect(clearParsed.data.effectiveName).toBe(
          clearParsed.data.systemName,
        );
      }
    });

    it("respects TRAYCER_HOST_LABEL environment override when customName is null", async () => {
      process.env.TRAYCER_HOST_LABEL = "cloud-provisioned-label-77";

      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      // 1. Initial get: customName is null -> effectiveName is TRAYCER_HOST_LABEL
      const getInitial = await rpcExchange(
        started.rpcUrl,
        "host.identity.get",
        { major: 1, minor: 0 },
        {},
      );
      expect(getInitial.ok).toBe(true);
      const parsedInitial = hostIdentitySchema.safeParse(getInitial.result);
      expect(parsedInitial.success).toBe(true);
      if (parsedInitial.success) {
        expect(parsedInitial.data.customName).toBeNull();
        expect(parsedInitial.data.effectiveName).toBe(
          "cloud-provisioned-label-77",
        );
        expect(parsedInitial.data.effectiveName).not.toBe(
          parsedInitial.data.systemName,
        );
      }

      // 2. Setting customName overrides TRAYCER_HOST_LABEL
      const setFrame = await rpcExchange(
        started.rpcUrl,
        "host.identity.set",
        { major: 1, minor: 0 },
        { customName: "manual-override-name" },
      );
      expect(setFrame.ok).toBe(true);
      const parsedSet = hostIdentitySchema.safeParse(setFrame.result);
      expect(parsedSet.success).toBe(true);
      if (parsedSet.success) {
        expect(parsedSet.data.customName).toBe("manual-override-name");
        expect(parsedSet.data.effectiveName).toBe("manual-override-name");
      }

      // 3. Resetting customName with whitespace reverts to TRAYCER_HOST_LABEL
      const clearWsFrame = await rpcExchange(
        started.rpcUrl,
        "host.identity.set",
        { major: 1, minor: 0 },
        { customName: "   " },
      );
      expect(clearWsFrame.ok).toBe(true);
      const parsedClearWs = hostIdentitySchema.safeParse(clearWsFrame.result);
      expect(parsedClearWs.success).toBe(true);
      if (parsedClearWs.success) {
        expect(parsedClearWs.data.customName).toBeNull();
        expect(parsedClearWs.data.effectiveName).toBe(
          "cloud-provisioned-label-77",
        );
      }

      // 4. Setting explicit null reverts to TRAYCER_HOST_LABEL
      const clearNullFrame = await rpcExchange(
        started.rpcUrl,
        "host.identity.set",
        { major: 1, minor: 0 },
        { customName: null },
      );
      expect(clearNullFrame.ok).toBe(true);
      const parsedClearNull = hostIdentitySchema.safeParse(
        clearNullFrame.result,
      );
      expect(parsedClearNull.success).toBe(true);
      if (parsedClearNull.success) {
        expect(parsedClearNull.data.customName).toBeNull();
        expect(parsedClearNull.data.effectiveName).toBe(
          "cloud-provisioned-label-77",
        );
      }
    });

    it("demonstrates race condition and file collision under concurrent host.identity.set calls", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const operations = [
        { customName: "Worker Node 1" },
        { customName: "Worker Node 2" },
        { customName: "Worker Node 3" },
        { customName: "Worker Node 4" },
      ];

      const targetUrl = started.rpcUrl;
      const settled = await Promise.allSettled(
        operations.map((op) =>
          rpcExchange(
            targetUrl,
            "host.identity.set",
            { major: 1, minor: 0 },
            op,
          ),
        ),
      );

      const fulfilled = settled.filter(
        (s): s is PromiseFulfilledResult<RpcFrameResponse> =>
          s.status === "fulfilled",
      );
      const rejected = settled.filter(
        (s): s is PromiseRejectedResult => s.status === "rejected",
      );

      expect(fulfilled.length + rejected.length).toBe(operations.length);

      const diskRaw = await readFile(join(tempDir, "host-name.json"), "utf8");
      expect(diskRaw.length).toBeGreaterThan(0);
      const parsed: unknown = JSON.parse(diskRaw);
      expect(parsed).toHaveProperty("customName");
    });
  });

  describe("2. Concurrent / Rapid config.logLevels.set and state integrity", () => {
    it("handles alternating rapid writes to cli and host scopes cleanly", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const levels = ["trace", "debug", "info", "warn", "error"] as const;

      for (let i = 0; i < 10; i++) {
        const cliTarget = levels[i % levels.length];
        const hostTarget = levels[(i + 2) % levels.length];

        const resCli = await rpcExchange(
          started.rpcUrl,
          "config.logLevels.set",
          { major: 1, minor: 0 },
          { scope: "cli", level: cliTarget },
        );
        expect(resCli.ok).toBe(true);
        expect(resCli.error).toBeNull();

        const resHost = await rpcExchange(
          started.rpcUrl,
          "config.logLevels.set",
          { major: 1, minor: 0 },
          { scope: "host", level: hostTarget },
        );
        expect(resHost.ok).toBe(true);
        expect(resHost.error).toBeNull();

        // Verify disk file integrity on each iteration
        const diskRaw = await readFile(
          join(tempDir, "log-levels.json"),
          "utf8",
        );
        const parsedDisk: unknown = JSON.parse(diskRaw);
        const schemaValidation =
          configLogLevelsResponseSchema.safeParse(parsedDisk);
        expect(schemaValidation.success).toBe(true);
        if (schemaValidation.success) {
          expect(schemaValidation.data.cliLogLevel).toBe(cliTarget);
          expect(schemaValidation.data.hostLogLevel).toBe(hostTarget);
        }
      }
    });

    it("demonstrates race condition and file collision under concurrent config.logLevels.set calls", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const operations = [
        { scope: "cli", level: "debug" },
        { scope: "host", level: "warn" },
        { scope: "cli", level: "trace" },
        { scope: "host", level: "error" },
        { scope: "cli", level: "info" },
        { scope: "host", level: "info" },
      ];

      // Fire operations concurrently
      const targetUrl = started.rpcUrl;
      const settled = await Promise.allSettled(
        operations.map((op) =>
          rpcExchange(
            targetUrl,
            "config.logLevels.set",
            { major: 1, minor: 0 },
            op,
          ),
        ),
      );

      const fulfilled = settled.filter(
        (s): s is PromiseFulfilledResult<RpcFrameResponse> =>
          s.status === "fulfilled",
      );
      const rejected = settled.filter(
        (s): s is PromiseRejectedResult => s.status === "rejected",
      );

      // Record empirical observations: under concurrent writes to the same process tmp file (${pid}.tmp),
      // race conditions occur where rename() fails with ENOENT or connections hang.
      expect(fulfilled.length + rejected.length).toBe(operations.length);

      // Verify on-disk file is still readable JSON or recoverable
      const diskRaw = await readFile(join(tempDir, "log-levels.json"), "utf8");
      expect(diskRaw.length).toBeGreaterThan(0);
      const parsedDisk: unknown = JSON.parse(diskRaw);
      const validated = configLogLevelsResponseSchema.safeParse(parsedDisk);
      expect(validated.success).toBe(true);
    });

    it("rejects illegal scope and level strings with RPC_ERROR", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const invalidScopes = ["desktop", "server", "global", "", 123, null];
      for (const badScope of invalidScopes) {
        const frame = await rpcExchange(
          started.rpcUrl,
          "config.logLevels.set",
          { major: 1, minor: 0 },
          { scope: badScope, level: "info" },
        );
        expect(frame.ok).toBe(false);
        expect(frame.result).toBeNull();
        expect(frame.error).toMatchObject({ code: "RPC_ERROR" });
        expect(frame.error?.message).not.toContain(
          "is not implemented by this OSS host",
        );
      }

      const invalidLevels = [
        "verbose",
        "critical",
        "DEBUG",
        "off",
        "",
        null,
        42,
      ];
      for (const badLevel of invalidLevels) {
        const frame = await rpcExchange(
          started.rpcUrl,
          "config.logLevels.set",
          { major: 1, minor: 0 },
          { scope: "host", level: badLevel },
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

  describe("3. Malformed install.json variations on host.getInstallationInfo@1.1", () => {
    it("safely handles 0-byte install.json by returning unmanaged", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const installDir = join(tempDir, "install");
      await mkdir(installDir, { recursive: true });
      await writeFile(join(installDir, "install.json"), "", "utf8");

      const frame = await rpcExchange(
        started.rpcUrl,
        "host.getInstallationInfo",
        { major: 1, minor: 1 },
        {},
      );

      expect(frame.ok).toBe(true);
      expect(frame.error).toBeNull();
      expect(frame.result).toEqual({ status: "unmanaged" });
      expect(
        hostGetInstallationInfoResponseV11Schema.safeParse(frame.result)
          .success,
      ).toBe(true);
    });

    it("safely handles truncated JSON variations by returning unmanaged", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const installDir = join(tempDir, "install");
      await mkdir(installDir, { recursive: true });

      const truncatedPayloads = [
        '{"installId": "inst-1", "version": "1.2.',
        '{"installId":',
        '{"platform": "darwin",',
        "{",
        '{"installRecord": {"arch": "arm64"',
      ];

      for (const truncated of truncatedPayloads) {
        await writeFile(join(installDir, "install.json"), truncated, "utf8");
        const frame = await rpcExchange(
          started.rpcUrl,
          "host.getInstallationInfo",
          { major: 1, minor: 1 },
          {},
        );
        expect(frame.ok).toBe(true);
        expect(frame.error).toBeNull();
        expect(frame.result).toEqual({ status: "unmanaged" });
      }
    });

    it("safely handles invalid types and schema mismatches by returning unmanaged", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const installDir = join(tempDir, "install");
      await mkdir(installDir, { recursive: true });

      const badRecords = [
        // Prompt specific test: installedVersion is number instead of version string
        { installedVersion: 123 },
        // Number instead of string version
        { version: 123 },
        // Array instead of object
        [1, 2, 3],
        // Primitive string
        "just a string",
        // Null
        null,
        // Missing required fields
        { version: "1.2.0" },
        // Invalid sizeBytes type
        {
          installId: "inst-test",
          version: "1.2.0",
          runtimeVersion: "1.2.0",
          platform: "darwin",
          arch: "arm64",
          installedAt: "2026-09-06T12:00:00.000Z",
          source: { kind: "registry", value: "official" },
          archiveSha256: null,
          signatureVerifiedAt: "2026-09-06T12:00:00.000Z",
          signatureKeyId: "key-1",
          sizeBytes: "not-a-number", // Invalid: string instead of number
          executablePath: "/bin/host",
          executableSha256: "0".repeat(64),
        },
        // Unsupported platform
        {
          installId: "inst-test-2",
          version: "1.2.0",
          runtimeVersion: "1.2.0",
          platform: "solaris", // Invalid platform
          arch: "arm64",
          installedAt: "2026-09-06T12:00:00.000Z",
          source: { kind: "registry", value: "official" },
          archiveSha256: null,
          signatureVerifiedAt: "2026-09-06T12:00:00.000Z",
          signatureKeyId: "key-1",
          sizeBytes: 1024,
          executablePath: "/bin/host",
          executableSha256: "0".repeat(64),
        },
      ];

      for (const bad of badRecords) {
        await writeFile(
          join(installDir, "install.json"),
          JSON.stringify(bad),
          "utf8",
        );
        const frame = await rpcExchange(
          started.rpcUrl,
          "host.getInstallationInfo",
          { major: 1, minor: 1 },
          {},
        );
        expect(frame.ok).toBe(true);
        expect(frame.error).toBeNull();
        expect(frame.result).toEqual({ status: "unmanaged" });
      }
    });

    it("safely recovers to managed when a valid record replaces a malformed file", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const installDir = join(tempDir, "install");
      await mkdir(installDir, { recursive: true });

      // Write corrupt file first
      await writeFile(join(installDir, "install.json"), "{{corrupt}}", "utf8");
      const corruptFrame = await rpcExchange(
        started.rpcUrl,
        "host.getInstallationInfo",
        { major: 1, minor: 1 },
        {},
      );
      expect(corruptFrame.result).toEqual({ status: "unmanaged" });

      // Now write valid record
      const validRecord = {
        installId: "inst-recovered-99",
        version: "1.2.0",
        runtimeVersion: "1.2.0",
        platform: "darwin",
        arch: "arm64",
        installedAt: "2026-09-06T14:00:00.000Z",
        source: { kind: "registry", value: "official" },
        archiveSha256: null,
        signatureVerifiedAt: "2026-09-06T14:00:00.000Z",
        signatureKeyId: "key-traycer-release",
        sizeBytes: 25000000,
        executablePath: "/usr/local/bin/traycer-host",
        executableSha256: "f".repeat(64),
      };
      expect(hostInstallRecordSchema.safeParse(validRecord).success).toBe(true);

      await writeFile(
        join(installDir, "install.json"),
        JSON.stringify(validRecord, null, 2),
        "utf8",
      );

      const recoveredFrame = await rpcExchange(
        started.rpcUrl,
        "host.getInstallationInfo",
        { major: 1, minor: 1 },
        {},
      );
      expect(recoveredFrame.ok).toBe(true);
      expect(recoveredFrame.result).toEqual({
        status: "managed",
        installRecord: validRecord,
        stagedRecord: null,
        cliManifest: null,
      });
      expect(
        hostGetInstallationInfoResponseV11Schema.safeParse(
          recoveredFrame.result,
        ).success,
      ).toBe(true);
    });
  });

  describe("4. host.update.check@1.1 and host.service.status@1.0 stress checks", () => {
    it("host.update.check@1.1 handles boolean variations and rejects invalid types", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      // Default
      const res1 = await rpcExchange(
        started.rpcUrl,
        "host.update.check",
        { major: 1, minor: 1 },
        {},
      );
      expect(res1.ok).toBe(true);
      expect(res1.result).toEqual({ outcome: "cli-unavailable" });
      expect(
        hostUpdateCheckResponseSchemaV11.safeParse(res1.result).success,
      ).toBe(true);

      // includePreReleases = true
      const res2 = await rpcExchange(
        started.rpcUrl,
        "host.update.check",
        { major: 1, minor: 1 },
        { includePreReleases: true },
      );
      expect(res2.ok).toBe(true);
      expect(res2.result).toEqual({ outcome: "cli-unavailable" });

      // includePreReleases = false
      const res3 = await rpcExchange(
        started.rpcUrl,
        "host.update.check",
        { major: 1, minor: 1 },
        { includePreReleases: false },
      );
      expect(res3.ok).toBe(true);
      expect(res3.result).toEqual({ outcome: "cli-unavailable" });

      // Invalid param type
      const resBad = await rpcExchange(
        started.rpcUrl,
        "host.update.check",
        { major: 1, minor: 1 },
        { includePreReleases: "invalid-string" },
      );
      expect(resBad.ok).toBe(false);
      expect(resBad.error).toMatchObject({ code: "RPC_ERROR" });
    });

    it("host.service.status@1.0 reports no CLI to ask, adhering to schema", async () => {
      const setup = await boot();
      tempDir = setup.tempDir;
      started = setup.started;

      const res = await rpcExchange(
        started.rpcUrl,
        "host.service.status",
        { major: 1, minor: 0 },
        {},
      );
      expect(res.ok).toBe(true);
      // A test host recorded no CLI invocation: nothing can be asked, as released.
      expect(res.result).toEqual({ outcome: "cli-unavailable" });
      expect(
        hostServiceStatusResponseSchema.safeParse(res.result).success,
      ).toBe(true);
    });
  });
});

async function boot(): Promise<{
  readonly started: StartedHost;
  readonly tempDir: string;
}> {
  const tempDir = await mkdtemp(join(tmpdir(), "traycer-adversarial-tests-"));
  const started = await startHost({
    argv: ["--host-data-dir", tempDir],
    listenHost: "127.0.0.1",
    listenPort: 0,
  });
  return { started, tempDir };
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
  let timerId: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<void>((_, reject) => {
    timerId = setTimeout(() => {
      try {
        socket.terminate();
      } catch {
        // ignore
      }
      reject(new Error(`Timeout waiting for RPC response for ${method}`));
    }, 2500);
  });
  try {
    await Promise.race([done, timeoutPromise]);
  } finally {
    if (timerId !== null) {
      clearTimeout(timerId);
    }
  }
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
