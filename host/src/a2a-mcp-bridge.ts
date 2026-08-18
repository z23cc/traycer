import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  sendAgentMessageResponseSchema,
  type SendAgentMessageRequest,
} from "@traycer/protocol/host/agent/shared";
import type {
  AgentA2AMcpLaunchContext,
  TurnRequest,
  TurnRunner,
} from "./cli-runner";
import type { HandlerResult } from "./handlers";

type AgentA2AMcpIdentity = {
  readonly agentId: string;
  readonly epicId: string;
};

type AgentA2AMcpSession = AgentA2AMcpLaunchContext & {
  readonly dispose: () => void;
};

export type AgentA2AMcpBridge = {
  readonly openSession: (identity: AgentA2AMcpIdentity) => AgentA2AMcpSession;
  readonly releaseSession: (identity: AgentA2AMcpIdentity) => void;
  readonly close: () => Promise<void>;
};

export type AgentA2AMcpSend = (
  request: SendAgentMessageRequest,
) => HandlerResult | Promise<HandlerResult>;

const SEND_MESSAGE_DESCRIPTION =
  "Send a message to another Traycer agent in this epic. Delivery is asynchronous: this call returns as soon as the message is queued, and any reply arrives later as a new incoming message - never as this tool's result. A pending reply is not a reason to hold your turn open or to poll the peer.";

const SEND_MESSAGE_TOOL = {
  name: "traycer_send_message",
  description: SEND_MESSAGE_DESCRIPTION,
  inputSchema: {
    type: "object",
    required: ["toAgentId", "message"],
    properties: {
      toAgentId: {
        type: "string",
        description:
          "Target Traycer agent id. An unambiguous id prefix of at least 4 characters is accepted.",
      },
      message: {
        type: "string",
        description: "Message to deliver.",
      },
      expectReply: {
        anyOf: [{ type: "boolean" }, { type: "null" }],
        description:
          "Whether the receiver should reply. Without it the peer processes your message and never reports back. Repeat expectReply sends to the same agent join its open thread (same response id) instead of opening parallel requests.",
      },
      responseId: {
        anyOf: [{ type: "string" }, { type: "null" }],
        description:
          "Broker response id, or any unambiguous prefix of at least 4 characters, when replying to a pending request. The id names the whole thread with that sender: one reply with it answers every message received under it, and only a reply carrying it completes the request.",
      },
    },
  },
} satisfies Tool;

export async function startAgentA2AMcpBridge(
  sendMessage: AgentA2AMcpSend,
): Promise<AgentA2AMcpBridge> {
  const identities = new Map<string, AgentA2AMcpIdentity>();
  const tokensBySessionKey = new Map<string, string>();
  const activeRequestClosers = new Set<() => void>();
  let closed = false;
  const httpServer = createServer((request, response) => {
    void handleMcpRequest({
      request,
      response,
      identities,
      sendMessage,
      activeRequestClosers,
    }).catch(() => {
      if (!response.headersSent) {
        writeJson(response, 500, {
          jsonrpc: "2.0",
          error: { code: -32_603, message: "Internal server error" },
          id: null,
        });
        return;
      }
      response.destroy();
    });
  });
  const port = await listen(httpServer);
  const url = `http://127.0.0.1:${String(port)}/mcp`;

  return {
    openSession(identity): AgentA2AMcpSession {
      if (closed) {
        throw new Error("Traycer A2A MCP bridge is closed");
      }
      const sessionKey = agentSessionKey(identity);
      const token = tokensBySessionKey.get(sessionKey) ?? randomUUID();
      tokensBySessionKey.set(sessionKey, token);
      identities.set(token, identity);
      return {
        url,
        token,
        dispose(): void {
          // The provider session may issue a final MCP call while its turn is
          // settling. Keep the agent-scoped lease alive across resumed turns;
          // chat deletion or host shutdown owns revocation.
        },
      };
    },
    releaseSession(identity): void {
      const sessionKey = agentSessionKey(identity);
      const token = tokensBySessionKey.get(sessionKey);
      if (token === undefined) {
        return;
      }
      tokensBySessionKey.delete(sessionKey);
      identities.delete(token);
    },
    close(): Promise<void> {
      if (closed) {
        return Promise.resolve();
      }
      closed = true;
      identities.clear();
      tokensBySessionKey.clear();
      for (const closeRequest of activeRequestClosers) {
        closeRequest();
      }
      activeRequestClosers.clear();
      return closeServer(httpServer);
    },
  };
}

function agentSessionKey(identity: AgentA2AMcpIdentity): string {
  return JSON.stringify([identity.epicId, identity.agentId]);
}

export function wrapTurnRunnerWithAgentA2A(
  runner: TurnRunner,
  bridge: AgentA2AMcpBridge,
): TurnRunner {
  return {
    async run(request, emit) {
      const identity = request.traycerAgentEnv;
      if (identity === undefined) {
        return await runner.run(request, emit);
      }
      const session = bridge.openSession({
        agentId: identity.agentId,
        epicId: identity.epicId,
      });
      try {
        const wrappedRequest: TurnRequest = {
          ...request,
          traycerA2AMcp: { url: session.url, token: session.token },
        };
        return await runner.run(wrappedRequest, emit);
      } finally {
        session.dispose();
      }
    },
  };
}

async function handleMcpRequest(args: {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly identities: ReadonlyMap<string, AgentA2AMcpIdentity>;
  readonly sendMessage: AgentA2AMcpSend;
  readonly activeRequestClosers: Set<() => void>;
}): Promise<void> {
  if (pathnameOf(args.request.url) !== "/mcp") {
    writeJson(args.response, 404, { error: "Not found" });
    return;
  }
  if (!hasExpectedLoopbackHost(args.request)) {
    writeJson(args.response, 403, { error: "Forbidden" });
    return;
  }
  if (!hasAllowedOrigin(args.request)) {
    writeJson(args.response, 403, { error: "Forbidden" });
    return;
  }
  const token = bearerToken(args.request.headers.authorization);
  const identity = token === null ? undefined : args.identities.get(token);
  if (identity === undefined) {
    writeJson(args.response, 401, { error: "Unauthorized" });
    return;
  }

  const mcpServer = createAgentMcpServer(identity, args.sendMessage);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  let closed = false;
  const closeRequest = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    args.activeRequestClosers.delete(closeRequest);
    void Promise.all([transport.close(), mcpServer.close()]).catch(() => {
      return;
    });
  };
  args.activeRequestClosers.add(closeRequest);
  args.response.once("finish", closeRequest);
  args.response.once("close", closeRequest);

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(args.request, args.response);
  } catch {
    closeRequest();
    if (!args.response.headersSent) {
      writeJson(args.response, 500, {
        jsonrpc: "2.0",
        error: { code: -32_603, message: "Internal server error" },
        id: null,
      });
      return;
    }
    args.response.destroy();
  }
}

function createAgentMcpServer(
  identity: AgentA2AMcpIdentity,
  sendMessage: AgentA2AMcpSend,
): McpServer {
  const server = new McpServer(
    { name: "traycer-a2a", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [SEND_MESSAGE_TOOL],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return await callAgentTool(
      identity,
      sendMessage,
      request.params.name,
      request.params.arguments,
    );
  });
  return server;
}

async function callAgentTool(
  identity: AgentA2AMcpIdentity,
  sendMessage: AgentA2AMcpSend,
  name: string,
  rawArguments: Readonly<Record<string, unknown>> | undefined,
): Promise<CallToolResult> {
  if (name !== "traycer_send_message") {
    return toolError(`Unknown Traycer tool: ${name}`);
  }
  if (
    rawArguments === undefined ||
    typeof rawArguments.toAgentId !== "string" ||
    typeof rawArguments.message !== "string"
  ) {
    return toolError(
      "traycer_send_message requires string toAgentId and message.",
    );
  }
  const expectReply = rawArguments.expectReply;
  if (
    expectReply !== undefined &&
    expectReply !== null &&
    typeof expectReply !== "boolean"
  ) {
    return toolError(
      "traycer_send_message expectReply must be a boolean when provided.",
    );
  }
  const responseId = rawArguments.responseId;
  if (
    responseId !== undefined &&
    responseId !== null &&
    typeof responseId !== "string"
  ) {
    return toolError(
      "traycer_send_message responseId must be a string or null when provided.",
    );
  }

  try {
    const handled = await sendMessage({
      senderAgentId: identity.agentId,
      epicId: identity.epicId,
      receiverAgentId: rawArguments.toAgentId,
      prompt: rawArguments.message,
      responseId: responseId ?? null,
      expectReply: expectReply ?? false,
    });
    if (!handled.ok) {
      return sendMessageToolFailure(handled.message);
    }
    const parsed = sendAgentMessageResponseSchema.safeParse(handled.result);
    if (!parsed.success) {
      return sendMessageToolFailure(
        "agent.sendMessage returned an invalid response.",
      );
    }
    return {
      content: [{ type: "text", text: JSON.stringify(parsed.data) }],
    };
  } catch (error) {
    return sendMessageToolFailure(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function sendMessageToolFailure(message: string): CallToolResult {
  return toolError(`traycer_send_message failed: ${message}`);
}

function toolError(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function pathnameOf(url: string | undefined): string {
  if (url === undefined) {
    return "/";
  }
  const query = url.indexOf("?");
  return query === -1 ? url : url.slice(0, query);
}

function hasExpectedLoopbackHost(request: IncomingMessage): boolean {
  const host = request.headers.host;
  if (host === undefined) {
    return false;
  }
  try {
    return isLoopbackHostname(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

function hasAllowedOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) {
    return true;
  }
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function bearerToken(authorization: string | undefined): string | null {
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    return null;
  }
  const token = authorization.slice("Bearer ".length);
  return token.length === 0 || token.includes(" ") ? null : token;
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("A2A MCP server bound without a port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeAllConnections();
  });
}
