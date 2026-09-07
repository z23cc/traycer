import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  CURRENT_CLIENT_COMPATIBILITY_EPOCH,
  SERVES_EVERY_INSTALLED_MAJOR,
  getLatestContract,
  splitConnectionManifest,
  type AnyRpcContract,
  type MethodVersionRegistry,
  type SchemaVersion,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  hostUnaryManifests,
  UNADVERTISED_UNARY_METHOD_NAMES,
} from "../manifest";
import { implementedRpcMethods } from "../rpc/handlers";
import { startHost, type StartedHost } from "../start-host";

const STUB = "is not implemented by this OSS host";

describe("released-floor method table", () => {
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

  /**
   * The withdrawn optional mutations, checked from three sides at once: on the
   * floor would break the handshake, missing from the registry is a typo, and
   * missing a handler would mean a client that asks anyway gets an invention
   * rather than a refusal.
   */
  it("withdraws only non-floor mutations it still answers", () => {
    const floor = new Set(RELEASED_FLOOR_METHOD_NAMES);
    const implemented = new Set(implementedRpcMethods());
    const manifests = hostUnaryManifests();
    for (const method of UNADVERTISED_UNARY_METHOD_NAMES) {
      expect(floor.has(method), method).toBe(false);
      expect(Object.keys(hostRpcRegistry), method).toContain(method);
      expect(implemented.has(method), method).toBe(true);
      expect(manifests.manifest[method], method).toBeUndefined();
      expect(manifests.optionalManifest[method], method).toBeUndefined();
    }
    // The floor is handed over whole - it is the half the handshake's
    // compatibility check runs against.
    for (const method of RELEASED_FLOOR_METHOD_NAMES) {
      expect(manifests.manifest[method], method).toBeDefined();
    }
    // A read with a true answer stays advertised. Withdrawing this one turns
    // the fork dialog's gate permissive, which starts a cross-host fork that
    // cannot work instead of refusing it with a reason.
    expect(
      manifests.optionalManifest["epic.chatPublicationState"],
    ).toBeDefined();
  });

  it("registers every floor method and never returns the generic stub", async () => {
    const implemented = new Set(implementedRpcMethods());
    for (const method of RELEASED_FLOOR_METHOD_NAMES) {
      expect(implemented.has(method)).toBe(true);
    }

    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });

    const rows: string[] = [];
    for (const method of RELEASED_FLOOR_METHOD_NAMES) {
      const version = latestVersion(method);
      const frame = await rpcExchange(started.rpcUrl, method, version, {});
      expect(frame.kind).toBe("response");
      if (frame.error !== null) {
        const errorRecord =
          frame.error !== null && typeof frame.error === "object"
            ? (frame.error as Record<string, unknown>)
            : {};
        const code =
          typeof errorRecord.code === "string" ? errorRecord.code : "UNKNOWN";
        const message =
          typeof errorRecord.message === "string"
            ? errorRecord.message
            : JSON.stringify(frame.error);
        expect(message).not.toContain(STUB);
        expect(code).not.toBe("UNIMPLEMENTED");
        const compact = message.replaceAll(/\s+/gu, " ").slice(0, 60);
        rows.push(`${method}\terror\t${code}\t${compact}`);
        continue;
      }
      const latest = getLatestContract(methodRegistry(method), undefined);
      if (isRpcContract(latest)) {
        const parsed = latest.responseSchema.safeParse(frame.result);
        expect(parsed.success).toBe(true);
      }
      rows.push(`${method}\tok`);
    }
    expect(rows.length).toBe(RELEASED_FLOOR_METHOD_NAMES.length);
    console.log(`FLOOR_COVERAGE_BEGIN\n${rows.join("\n")}\nFLOOR_COVERAGE_END`);
  }, 60_000);
});

function latestVersion(method: string): SchemaVersion {
  const registry = methodRegistry(method);
  let major = 0;
  let minor = 0;
  for (const key of Object.keys(registry)) {
    if (key === "degrade") {
      continue;
    }
    const numeric = Number(key);
    if (!Number.isInteger(numeric) || numeric < major) {
      continue;
    }
    major = numeric;
    const line = Reflect.get(registry, key);
    if (line !== null && typeof line === "object" && "latestMinor" in line) {
      const latestMinor = Reflect.get(line, "latestMinor");
      minor = typeof latestMinor === "number" ? latestMinor : 0;
    }
  }
  return { major, minor };
}

function methodRegistry(method: string): MethodVersionRegistry {
  const bag: { readonly [name: string]: MethodVersionRegistry } =
    hostRpcRegistry;
  const found = bag[method];
  if (found === undefined) {
    throw new Error(`missing registry ${method}`);
  }
  return found;
}

function isRpcContract(value: unknown): value is AnyRpcContract {
  return (
    value !== null &&
    typeof value === "object" &&
    "requestSchema" in value &&
    "responseSchema" in value
  );
}

async function rpcExchange(
  url: string,
  method: string,
  schemaVersion: SchemaVersion,
  params: unknown,
): Promise<{ kind: string; result: unknown; error: unknown }> {
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
    !("kind" in response)
  ) {
    throw new Error(`expected response, got ${JSON.stringify(response)}`);
  }
  const record = response as {
    kind: string;
    result: unknown;
    error: unknown;
  };
  return record;
}
