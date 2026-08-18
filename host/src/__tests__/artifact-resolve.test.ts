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
  createEpicRequestSchema,
  resolveArtifactByPathResponseSchema,
} from "@traycer/protocol/host/epic/unary-schemas";
import { startHostServer, type HostServer } from "../server";

const EPIC_ID = "epic-artifact-path";

describe("epic.resolveArtifactByPath", () => {
  const servers: HostServer[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    while (servers.length > 0) await servers.pop()?.close();
  });

  it("resolves a foreign-root nested index path against the live artifact chain", async () => {
    const server = await startHostServer(0, "host-artifact-path", undefined);
    servers.push(server);
    server.state.createEpic(
      createEpicRequestSchema.parse({
        epic: {
          id: EPIC_ID,
          title: "Artifact path task",
          initialUserPrompt: "",
          ticketCount: 0,
          specCount: 0,
          storyCount: 0,
          reviewCount: 0,
          status: "active",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          createdBy: "local-user",
          version: "1.0.0",
        },
        repoIdentifiers: [],
        workspaces: [],
        chat: null,
      }),
    );
    const parent = server.state.createArtifact({
      epicId: EPIC_ID,
      parentId: null,
      artifactType: "spec",
      title: "Parent spec",
    });
    const child = server.state.createArtifact({
      epicId: EPIC_ID,
      parentId: parent.artifactId,
      artifactType: "review",
      title: "Child review",
    });
    const connection = await openRpc(server.websocketUrl, sockets);
    const foreignRoot = `/Users/another-user/.traycer/epics/${EPIC_ID}/artifacts`;

    await expectResolve(
      connection,
      `${foreignRoot}/parent-spec/child-review/index.md`,
      { artifactId: child.artifactId, kind: "review" },
    );
    await expectResolve(connection, `${foreignRoot}/parent-spec/index.md`, {
      artifactId: parent.artifactId,
      kind: "spec",
    });
    await expectResolve(
      connection,
      `${foreignRoot}/parent-spec/child-review/notes.md`,
      null,
    );
    await expectResolve(
      connection,
      `/Users/another-user/.traycer/epics/other-epic/artifacts/parent-spec/index.md`,
      null,
    );

    server.state.reparentArtifact({
      epicId: EPIC_ID,
      artifactId: child.artifactId,
      newParentId: null,
    });
    await expectResolve(
      connection,
      `${foreignRoot}/parent-spec/child-review/index.md`,
      null,
    );
    await expectResolve(connection, `${foreignRoot}/child-review/index.md`, {
      artifactId: child.artifactId,
      kind: "review",
    });
  });
});

type RpcConnection = {
  readonly ws: WebSocket;
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
  hostFrameSchema.parse(JSON.parse(await nextMessage(ws)));
  return { ws, nextRequestId: 1 };
}

async function expectResolve(
  connection: RpcConnection,
  filePath: string,
  expected: {
    readonly artifactId: string;
    readonly kind: "spec" | "review";
  } | null,
): Promise<void> {
  const frame = await rpc(connection, "epic.resolveArtifactByPath", {
    epicId: EPIC_ID,
    filePath,
  });
  if (frame.kind !== "response" || frame.error !== null) {
    throw new Error("Expected successful RPC response");
  }
  expect(resolveArtifactByPathResponseSchema.parse(frame.result)).toEqual({
    artifact: expected,
  });
}

async function rpc(
  connection: RpcConnection,
  method: string,
  params: unknown,
): Promise<HostFrame> {
  const requestId = `artifact-path-${String(connection.nextRequestId++)}`;
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
