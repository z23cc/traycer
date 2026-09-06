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
import { analogFromSchema } from "../rpc/analog-value";
import { startHost, type StartedHost } from "../start-host";

const STUB = "is not implemented by this OSS host";

describe("advertised unary analog coverage", () => {
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

  it("builds a schema-valid analog for every unary response", () => {
    for (const method of Object.keys(hostRpcRegistry)) {
      const latest = getLatestContract(methodRegistry(method), undefined);
      if (!isRpcContract(latest)) {
        continue;
      }
      const analog = analogFromSchema(latest.responseSchema);
      const parsed = latest.responseSchema.safeParse(analog);
      expect(parsed.success, method).toBe(true);
    }
  });

  it("never returns the generic unimplemented stub", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    const methods = Object.keys(hostRpcRegistry);
    for (const method of methods) {
      const version = latestVersion(method);
      const frame = await rpcExchange(started.rpcUrl, method, version, {});
      expect(frame.kind).toBe("response");
      if (frame.error !== null && typeof frame.error === "object") {
        const message =
          "message" in frame.error && typeof frame.error.message === "string"
            ? frame.error.message
            : JSON.stringify(frame.error);
        expect(message, method).not.toContain(STUB);
      }
    }
  }, 120_000);
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
