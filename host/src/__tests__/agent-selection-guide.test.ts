import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { splitConnectionManifest } from "@traycer/protocol/framework/capability-manifest";
import {
  hostFrameSchema,
  type HostFrame,
} from "@traycer/protocol/framework/ws-protocol";
import {
  agentSelectionGuideGlobalGetResponseSchema,
  agentSelectionGuideGlobalOnboardingDraftGetResponseSchema,
  agentSelectionGuideGlobalResetResponseSchema,
  agentSelectionGuideGlobalSetResponseSchema,
  agentSelectionGuideResponseSchema,
} from "@traycer/protocol/host/agent/shared";
import { createEpicRequestSchema } from "@traycer/protocol/host/epic/unary-schemas";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { scriptedTurnRunner } from "../cli-runner";
import { startHostServer, type HostServer } from "../server";

const GENERATED_GUIDE = [
  "# Agent Selection Guide",
  "",
  "For implementation tasks, use the `claude` harness with latest Opus model and high reasoning effort. In the handoff, ask the child agent to use the `traycer-implement` skill.",
  "",
  "For review tasks, use the `codex` harness with latest GPT model and high reasoning effort. In the handoff, ask the child agent to use the `traycer-review` skill.",
  "",
].join("\n");

describe("agent selection guide", () => {
  const roots: string[] = [];
  const servers: HostServer[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.terminate();
    }
    while (servers.length > 0) {
      const server = servers.pop();
      if (server !== undefined) {
        await server.close();
      }
    }
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists and resets the global guide through the released public RPCs", async () => {
    const hostHome = await mkdtemp(join(tmpdir(), "traycer-guide-host-"));
    roots.push(hostHome);
    const server = await startHostServer(0, "host-local", {
      runner: scriptedTurnRunner([]),
      hostHome,
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
        "agent.selectionGuide": { major: 1, minor: 0 },
        "agent.selectionGuide.getGlobal": { major: 1, minor: 0 },
        "agent.selectionGuide.getGlobalOnboardingDraft": {
          major: 1,
          minor: 0,
        },
        "agent.selectionGuide.setGlobal": { major: 1, minor: 0 },
        "agent.selectionGuide.resetGlobalToDefault": { major: 1, minor: 0 },
      },
    });

    const draft =
      agentSelectionGuideGlobalOnboardingDraftGetResponseSchema.parse(
        await rpcResult(
          ws,
          "guide-draft",
          "agent.selectionGuide.getGlobalOnboardingDraft",
          {},
        ),
      );
    expect(draft).toEqual({
      content: null,
      generatedDefaultContent: GENERATED_GUIDE,
      providersSettled: true,
    });

    const initialized = agentSelectionGuideGlobalGetResponseSchema.parse(
      await rpcResult(ws, "guide-get", "agent.selectionGuide.getGlobal", {}),
    );
    expect(initialized).toEqual({
      content: GENERATED_GUIDE,
      generatedDefaultContent: GENERATED_GUIDE,
    });
    expect(
      await readFile(join(hostHome, "agent-selection-guide.md"), "utf8"),
    ).toBe(GENERATED_GUIDE);
    expect(
      await readFile(
        join(hostHome, ".agent-selection-guide.meta.json"),
        "utf8",
      ),
    ).toBe('{\n  "guideVersion": 1\n}\n');

    const custom = "# My guide\n\nUse Codex for review.\n";
    expect(
      agentSelectionGuideGlobalSetResponseSchema.parse(
        await rpcResult(ws, "guide-set", "agent.selectionGuide.setGlobal", {
          content: custom,
        }),
      ),
    ).toEqual({ content: custom, generatedDefaultContent: GENERATED_GUIDE });
    expect(
      await readFile(join(hostHome, "agent-selection-guide.md"), "utf8"),
    ).toBe(custom);

    const now = Date.now();
    await rpcResult(
      ws,
      "guide-epic",
      "epic.create",
      createEpicRequestSchema.parse({
        epic: {
          id: "epic-guide",
          title: "Guide task",
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
          chatId: "guide-agent",
          parentId: null,
          hostId: "host-local",
          title: "Guide agent",
          workspaceMode: "folderless",
          worktreeIntent: null,
          initialMessage: null,
        },
      }),
    );
    expect(
      agentSelectionGuideResponseSchema.parse(
        await rpcResult(ws, "guide-agent-read", "agent.selectionGuide", {
          epicId: "epic-guide",
          senderAgentId: "guide-agent",
        }),
      ),
    ).toEqual({
      status: "found",
      sources: [
        {
          kind: "global",
          path: join(hostHome, "agent-selection-guide.md"),
          priority: 1,
          content: custom,
        },
      ],
    });

    expect(
      agentSelectionGuideGlobalResetResponseSchema.parse(
        await rpcResult(
          ws,
          "guide-reset",
          "agent.selectionGuide.resetGlobalToDefault",
          {},
        ),
      ),
    ).toEqual({
      content: GENERATED_GUIDE,
      generatedDefaultContent: GENERATED_GUIDE,
    });
  });
});

async function rpcResult(
  ws: WebSocket,
  requestId: string,
  method: string,
  params: unknown,
): Promise<unknown> {
  ws.send(
    JSON.stringify({
      kind: "request",
      requestId,
      method,
      schemaVersion: { major: 1, minor: 0 },
      params,
    }),
  );
  const frame = await nextHostFrame(ws);
  if (frame.kind !== "response" || frame.requestId !== requestId) {
    throw new Error(`Expected response ${requestId}`);
  }
  expect(frame.error).toBeNull();
  return frame.result;
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

function nextHostFrame(ws: WebSocket): Promise<HostFrame> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => {
      resolve(hostFrameSchema.parse(JSON.parse(data.toString())));
    });
    ws.once("error", reject);
  });
}
