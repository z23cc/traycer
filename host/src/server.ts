import { createServer, type Server } from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { HostFrame } from "@traycer/protocol/framework/ws-protocol";
import { deleteChatRequestSchema } from "@traycer/protocol/host/epic/unary-schemas";
import { worktreeWorkspaceSummarySchemaV13 } from "@traycer/protocol/host/worktree-schemas";
import {
  startAgentA2AMcpBridge,
  type AgentA2AMcpBridge,
  wrapTurnRunnerWithAgentA2A,
} from "./a2a-mcp-bridge";
import { createProcessTurnRunner, type TurnRunner } from "./cli-runner";
import { createHandlers, type MethodDispatcher } from "./handlers";
import { createRpcSession } from "./rpc-session";
import { RepoWorkspacePersistence } from "./repo-workspace-persistence";
import {
  createStreamSession,
  STREAM_PING_INTERVAL_MS,
  STREAM_PONG_TIMEOUT_MS,
} from "./stream-session";
import { HostState } from "./store";
import { AgentSelectionGuideStore } from "./agent-selection-guide";
import { summarizeWorktreeWorkspacePaths } from "./worktree-summary";

export type HostServerOptions = {
  readonly runner: TurnRunner | undefined;
  readonly hostHome?: string;
  readonly worktreeRoot?: string;
};

export type HostServer = {
  readonly port: number;
  readonly websocketUrl: string;
  readonly state: HostState;
  readonly close: () => Promise<void>;
};

export async function startHostServer(
  port: number,
  hostId: string,
  options: HostServerOptions | undefined,
): Promise<HostServer> {
  const repoWorkspacePersistence =
    options?.hostHome === undefined
      ? undefined
      : await RepoWorkspacePersistence.open(options.hostHome);
  const state = new HostState(
    hostId,
    repoWorkspacePersistence,
    options?.worktreeRoot,
  );
  const selectionGuide = new AgentSelectionGuideStore(options?.hostHome);
  let methodDispatcher: MethodDispatcher | null = null;
  const a2aMcpBridge = await startAgentA2AMcpBridge(
    (request) => {
      const dispatcher = methodDispatcher;
      if (dispatcher === null) {
        return {
          ok: false,
          code: "RPC_ERROR",
          message: "Traycer A2A MCP bridge is not ready",
        };
      }
      return dispatcher("agent.sendMessage", request);
    },
    async (request) => ({
      ok: true,
      result: await state.stopAgentFromAgent(request),
    }),
    async (request) => ({
      ok: true,
      result: await state.archiveAgentFromAgent(request),
    }),
    (request) => state.listAgents(request),
    (request) => state.getAgentTranscriptFromAgent(request),
    (request) => state.createAgent(request),
    async (identity) => {
      state.listAgents({
        epicId: identity.epicId,
        senderAgentId: identity.agentId,
        scope: "user",
      });
      return await selectionGuide.getForAgent();
    },
    {
      list: async (identity) => ({
        workspaces: (
          await summarizeWorktreeWorkspacePaths(
            state.workspacePathsForAgentEpic(identity.epicId, identity.agentId),
            { forceRefresh: true, environment: "include" },
          )
        ).map((summary) => worktreeWorkspaceSummarySchemaV13.parse(summary)),
      }),
      create: (request) => state.createWorktreePaths(request),
    },
    {
      configure: (request) => state.configureAgentFromAgent(request),
      fork: (request) => state.forkAgent(request),
      comments: {
        list: (request) => state.listCommentThreadsByPath(request),
        setStatus: (request) => state.setCommentThreadStatusByPath(request),
      },
    },
  );
  const baseRunner = options?.runner ?? createProcessTurnRunner(process.env);
  const runner = wrapTurnRunnerWithAgentA2A(baseRunner, a2aMcpBridge);
  const handlers = createHandlers(state, runner, selectionGuide);
  const handleMethod = withAgentA2ASessionRelease(
    handlers.handleMethod,
    a2aMcpBridge,
  );
  methodDispatcher = handleMethod;
  const httpServer = createServer((req, res) => {
    if (pathnameOf(req.url) === "/activity") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ busy: state.hasInflightTurns() }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const sockets = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (request, socket, head) => {
    const path = pathnameOf(request.url);
    if (path !== "/rpc" && path !== "/stream") {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      if (path === "/stream") {
        attachStream(ws, state, runner);
        return;
      }
      attachRpc(ws, handleMethod);
    });
  });
  let boundPort: number;
  try {
    boundPort = await listen(httpServer, port);
  } catch (error) {
    await a2aMcpBridge.close();
    throw error;
  }
  let closePromise: Promise<void> | null = null;
  return {
    port: boundPort,
    websocketUrl: `ws://127.0.0.1:${boundPort}/rpc`,
    state,
    close: () => {
      if (closePromise === null) {
        closePromise = closeHostServer(
          state,
          a2aMcpBridge,
          sockets,
          httpServer,
        );
      }
      return closePromise;
    },
  };
}

function withAgentA2ASessionRelease(
  dispatcher: MethodDispatcher,
  bridge: AgentA2AMcpBridge,
): MethodDispatcher {
  return (method, params) => {
    const handled = dispatcher(method, params);
    if (method !== "epic.deleteChat") {
      return handled;
    }
    if (handled instanceof Promise) {
      return handled.then((result) => {
        releaseDeletedAgentSession(bridge, params, result.ok);
        return result;
      });
    }
    releaseDeletedAgentSession(bridge, params, handled.ok);
    return handled;
  };
}

function releaseDeletedAgentSession(
  bridge: AgentA2AMcpBridge,
  params: unknown,
  deleted: boolean,
): void {
  if (!deleted) {
    return;
  }
  const parsed = deleteChatRequestSchema.safeParse(params);
  if (parsed.success) {
    bridge.releaseSession({
      epicId: parsed.data.epicId,
      agentId: parsed.data.chatId,
    });
  }
}

async function closeHostServer(
  state: HostState,
  a2aMcpBridge: AgentA2AMcpBridge,
  sockets: WebSocketServer,
  httpServer: Server,
): Promise<void> {
  const closeA2AMcpBridge = a2aMcpBridge.close();
  state.dispose();
  for (const client of sockets.clients) {
    client.terminate();
  }
  await closeWebSocketServer(sockets);
  await closeHttpServer(httpServer);
  await closeA2AMcpBridge;
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function attachRpc(ws: WebSocket, handleMethod: MethodDispatcher): void {
  const session = createRpcSession((frame: HostFrame) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  }, handleMethod);
  ws.on("message", (data) => {
    session.onMessage(data.toString());
  });
}

function attachStream(
  ws: WebSocket,
  state: HostState,
  runner: TurnRunner,
): void {
  const session = createStreamSession(
    (data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    },
    state,
    runner,
    {
      sendTransportPing: () => {
        if (ws.readyState === ws.OPEN) {
          ws.ping();
        }
      },
      close: (code, reason) => {
        if (ws.readyState === ws.OPEN) {
          ws.close(code, reason);
        }
      },
      pingIntervalMs: STREAM_PING_INTERVAL_MS,
      pongTimeoutMs: STREAM_PONG_TIMEOUT_MS,
    },
  );
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      session.onBinaryMessage(bytesFromRaw(data));
      return;
    }
    session.onMessage(data.toString());
  });
  ws.on("close", () => {
    session.dispose();
  });
  ws.on("error", () => {
    session.dispose();
  });
  ws.on("pong", () => {
    session.onTransportPong();
  });
}

function pathnameOf(url: string | undefined): string {
  if (url === undefined) {
    return "/";
  }
  const query = url.indexOf("?");
  return query === -1 ? url : url.slice(0, query);
}

function bytesFromRaw(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data));
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Host HTTP server bound without a port"));
        return;
      }
      resolve(address.port);
    });
  });
}
