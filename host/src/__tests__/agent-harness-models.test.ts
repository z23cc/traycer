import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { splitConnectionManifest } from "@traycer/protocol/framework/capability-manifest";
import {
  hostFrameSchema,
  type HostFrame,
} from "@traycer/protocol/framework/ws-protocol";
import { listHarnessModelsResponseSchema } from "@traycer/protocol/host/agent/shared";
import {
  agentGetProviderProfileRateLimitsResponseSchema,
  agentListProviderProfilesResponseSchema,
} from "@traycer/protocol/host/agent/profiles";
import { createEpicRequestSchema } from "@traycer/protocol/host/epic/unary-schemas";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { scriptedTurnRunner } from "../cli-runner";
import { startHostServer, type HostServer } from "../server";

describe("agent harness models", () => {
  const servers: HostServer[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.terminate();
    }
    while (servers.length > 0) {
      await servers.pop()?.close();
    }
  });

  it("lists the local model catalog through the released public RPC", async () => {
    const server = await startHostServer(0, "host-local", {
      runner: scriptedTurnRunner([]),
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
    expect(await nextHostFrame(ws)).toMatchObject({
      kind: "openAck",
      manifest: {
        "agent.listHarnessModels": { major: 2, minor: 0 },
      },
      optionalManifest: {
        "agent.listProviderProfiles": { major: 4, minor: 0 },
        "agent.getProviderProfileRateLimits": { major: 4, minor: 0 },
      },
    });

    expect(
      listHarnessModelsResponseSchema.parse(
        await rpcResult(ws, "models-codex", "codex"),
      ),
    ).toEqual({
      harnessId: "codex",
      models: [
        {
          id: "gpt-5.4",
          reasoningEfforts: [],
          fastModeAvailable: false,
        },
        {
          id: "gpt-5-codex",
          reasoningEfforts: [],
          fastModeAvailable: false,
        },
      ],
    });
    expect(
      listHarnessModelsResponseSchema.parse(
        await rpcResult(ws, "models-unsupported", "opencode"),
      ),
    ).toEqual({ harnessId: "opencode", models: [] });

    const now = Date.now();
    await rpcMethod(
      ws,
      "create-profile-agent",
      "epic.create",
      { major: 1, minor: 0 },
      createEpicRequestSchema.parse({
        epic: {
          id: "epic-profiles",
          title: "Provider profiles",
          initialUserPrompt: "",
          ticketCount: 0,
          specCount: 0,
          storyCount: 0,
          reviewCount: 0,
          status: "active",
          createdAt: now,
          updatedAt: now,
          createdBy: "local-user",
          version: "1.0.0",
        },
        repoIdentifiers: [],
        workspaces: [],
        chat: {
          chatId: "profile-agent",
          parentId: null,
          hostId: "host-local",
          title: "Profile agent",
          workspaceMode: "folderless",
          worktreeIntent: null,
          initialMessage: null,
        },
      }),
    );
    expect(
      agentListProviderProfilesResponseSchema.parse(
        await rpcMethod(
          ws,
          "profiles-codex",
          "agent.listProviderProfiles",
          { major: 4, minor: 0 },
          {
            epicId: "epic-profiles",
            senderAgentId: "profile-agent",
            harnessId: "codex",
          },
        ),
      ),
    ).toEqual({
      providerId: "codex",
      profiles: [
        {
          selection: { kind: "ambient" },
          label: "Terminal account",
          authStatus: "unknown",
          rateLimitStatus: "unknown",
          usageUpdatedAt: null,
          isEffectiveLastUsed: true,
        },
      ],
    });
    expect(
      agentGetProviderProfileRateLimitsResponseSchema.parse(
        await rpcMethod(
          ws,
          "profile-rate-limits",
          "agent.getProviderProfileRateLimits",
          { major: 4, minor: 0 },
          {
            epicId: "epic-profiles",
            senderAgentId: "profile-agent",
            harnessId: "codex",
            profileSelection: { kind: "ambient" },
          },
        ),
      ),
    ).toEqual({
      rateLimits: {
        provider: "codex",
        available: false,
        reason: "rate_limits_not_available",
      },
      usageUpdatedAt: null,
    });
  });
});

async function rpcResult(
  ws: WebSocket,
  requestId: string,
  harnessId: string,
): Promise<unknown> {
  return await rpcMethod(
    ws,
    requestId,
    "agent.listHarnessModels",
    { major: 2, minor: 0 },
    { epicId: null, senderAgentId: null, harnessId },
  );
}

async function rpcMethod(
  ws: WebSocket,
  requestId: string,
  method: string,
  schemaVersion: { readonly major: number; readonly minor: number },
  params: unknown,
): Promise<unknown> {
  ws.send(
    JSON.stringify({
      kind: "request",
      requestId,
      method,
      schemaVersion,
      params,
    }),
  );
  const frame = await nextHostFrame(ws);
  if (frame.kind !== "response" || frame.requestId !== requestId) {
    throw new Error(`Expected response ${requestId}`);
  }
  if (frame.error !== null) {
    throw new Error(`${frame.error.code}: ${frame.error.message}`);
  }
  return frame.result;
}

async function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

async function nextHostFrame(ws: WebSocket): Promise<HostFrame> {
  return await new Promise<HostFrame>((resolve, reject) => {
    ws.once("message", (data) => {
      try {
        resolve(hostFrameSchema.parse(JSON.parse(data.toString())));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    ws.once("error", reject);
  });
}
