import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import {
  CURRENT_CLIENT_COMPATIBILITY_EPOCH,
  SERVES_EVERY_INSTALLED_MAJOR,
  splitConnectionManifest,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");

export async function launchHostStatusOnce(): Promise<{
  readonly hostId: string;
  readonly ready: boolean;
  readonly stderr: string;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "traycer-oss-launch-"));
  const child = spawn(
    "bun",
    ["run", "--cwd", "host", "traycer-host", "--host-data-dir", dataDir],
    { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  try {
    const pidPath = join(dataDir, "pid.json");
    let raw = "";
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        raw = await readFile(pidPath, "utf8");
        break;
      } catch {
        await new Promise<void>((resolve) => {
          setTimeout(() => resolve(), 50);
        });
      }
    }
    if (raw.length === 0) {
      throw new Error(`pid.json missing: ${stderr}`);
    }
    const pid = JSON.parse(raw) as { websocketUrl: string; hostId: string };
    const result = await callStatus(pid.websocketUrl);
    if (typeof pid.hostId !== "string" || pid.hostId.length === 0) {
      throw new Error("pid.json missing hostId");
    }
    return { hostId: pid.hostId, ready: result.ready, stderr };
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function callStatus(
  url: string,
): Promise<{ ready: boolean; hostId: string }> {
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
            method: "host.status",
            schemaVersion: { major: 1, minor: 3 },
            params: {},
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
    !("kind" in response) ||
    response.kind !== "response"
  ) {
    throw new Error(`status failed ${JSON.stringify(response)}`);
  }
  const record = response as Record<string, unknown>;
  if (record.error !== null) {
    throw new Error(`status error ${JSON.stringify(record.error)}`);
  }
  const resultRecord = record.result;
  if (
    resultRecord === null ||
    typeof resultRecord !== "object" ||
    !("ready" in resultRecord)
  ) {
    throw new Error(`status result ${JSON.stringify(record.result)}`);
  }
  const ready = Reflect.get(resultRecord, "ready");
  if (ready !== true) {
    throw new Error(`host.status ready=${String(ready)}`);
  }
  return { ready: true, hostId: "" };
}

if (process.argv[1]?.endsWith("launch-status-once.ts") === true) {
  const first = await launchHostStatusOnce();
  const second = await launchHostStatusOnce();
  if (first.ready !== true || second.ready !== true) {
    throw new Error("host.status ready was not true");
  }
  if (first.hostId.length === 0 || second.hostId.length === 0) {
    throw new Error("empty hostId");
  }
  console.log(`first hostId=${first.hostId}`);
  console.log(`second hostId=${second.hostId}`);
  console.log("launch twice succeeded");
}
