import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  CURRENT_CLIENT_COMPATIBILITY_EPOCH,
  SERVES_EVERY_INSTALLED_MAJOR,
  splitConnectionManifest,
  type MethodVersionRegistry,
  type SchemaVersion,
} from "@traycer/protocol/framework/index";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  hostStreamManifest,
  OSS_STREAM_METHOD_NAMES,
  UNSERVED_STREAM_METHOD_NAMES,
} from "../manifest";
import { implementedRpcMethods } from "../rpc/handlers";
import { startHost, type StartedHost } from "../start-host";

const STUB = "is not implemented by this OSS host";
/** The refusal an unrouted stream subscribe now gets, checked by name. */
const NO_ROUTE = "has no route for";

describe("advertised method coverage", () => {
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
   * The guard on the class of bug the analog fallback used to produce.
   *
   * A method in the registry with no handler is answered by `unimplemented`,
   * which refuses - so the day the protocol adds one, this fails here rather
   * than the host inventing a reply for a feature nobody has written. The fix
   * is to decide the answer, not to relax the test.
   */
  it("has a handler for every advertised unary method", () => {
    const implemented = new Set(implementedRpcMethods());
    const unhandled = Object.keys(hostRpcRegistry).filter(
      (method) => !implemented.has(method),
    );
    expect(unhandled).toStrictEqual([]);
  });

  /**
   * The stream half of the same guard, driven over the wire because a route is
   * an if-chain rather than a table: only the host itself can say whether a
   * method reaches one. An advertised stream that hits neither a route nor the
   * unserved list is refused by name, and this is where that shows up.
   *
   * A route-specific rejection ("epic.subscribe requires epicId") is a PASS.
   * It proves the route ran and read the empty params this sends.
   */
  it("routes every advertised stream method", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    for (const method of OSS_STREAM_METHOD_NAMES) {
      const frames = await subscribeOnce(streamUrl, method);
      expect(JSON.stringify(frames), method).not.toContain(NO_ROUTE);
    }
  }, 120_000);

  /**
   * The other half of the route test, and what keeps it from being hollow: a
   * method with no route really does come back refused by this wording, so a
   * green route test means the routes ran rather than that the string is
   * unreachable.
   */
  it("refuses a stream method nobody has decided about", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    const frames = await subscribeOnce(
      started.rpcUrl.replace(/\/rpc$/u, "/stream"),
      "stream.protocolAddedThisYesterday",
    );
    expect(JSON.stringify(frames)).toContain(NO_ROUTE);
  }, 30_000);

  it("refuses, and does not advertise, every unserved stream", async () => {
    const advertised = hostStreamManifest();
    for (const method of UNSERVED_STREAM_METHOD_NAMES) {
      expect(Object.keys(hostStreamRpcRegistry), method).toContain(method);
      expect(advertised[method], method).toBeUndefined();
      expect(OSS_STREAM_METHOD_NAMES, method).not.toContain(method);
    }

    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    for (const method of UNSERVED_STREAM_METHOD_NAMES) {
      // Withdrawn from the manifest, and still refused for a client that asks
      // anyway - with the unserved wording, not the unrouted one.
      const frames = JSON.stringify(await subscribeOnce(streamUrl, method));
      expect(frames, method).toContain("does not serve");
      expect(frames, method).not.toContain(NO_ROUTE);
    }
  }, 60_000);

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

/**
 * Opens a stream socket, subscribes with EMPTY params, and returns whatever
 * came back as text.
 *
 * `manifest: {}` skips the compatibility check on purpose: this asks what the
 * subscribe ROUTER does, and the router does not consult the manifest - the
 * withdrawal is a separate fact, checked directly against
 * `hostStreamManifest()`.
 *
 * Two shapes have to be tolerated rather than awaited. A snapshot can be
 * followed by a BINARY payload (`artifact.subscribe`), which is not JSON; and
 * a route can answer with silence (`worktree.changed` just registers a
 * subscriber), which is a pass - it means the subscribe landed somewhere. So
 * the socket is closed on a short timer rather than on an expected frame.
 */
async function subscribeOnce(
  url: string,
  method: string,
): Promise<readonly string[]> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const frames: string[] = [];
  let timer: NodeJS.Timeout | null = null;
  const done = new Promise<void>((resolve) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }
      const text = String(data);
      frames.push(text);
      if (frames.length > 1) {
        return;
      }
      socket.send(
        JSON.stringify({
          kind: "subscribe",
          method,
          schemaVersion: { major: 1, minor: 0 },
          params: {},
        }),
      );
      timer = setTimeout(() => socket.close(), 250);
    });
    socket.once("close", () => resolve());
    socket.once("error", () => resolve());
  });
  socket.send(
    JSON.stringify({
      kind: "open",
      token: "test-token",
      manifest: {},
      clientIdentity: {
        kind: "cli",
        compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
        appVersion: "0.1.0",
      },
    }),
  );
  await done;
  if (timer !== null) {
    clearTimeout(timer);
  }
  return frames;
}
