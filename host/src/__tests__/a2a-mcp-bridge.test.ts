import { describe, expect, it } from "vitest";
import { startAgentA2AMcpBridge } from "../a2a-mcp-bridge";

const SIGNED_SEND_MESSAGE_TOOL = {
  name: "traycer_send_message",
  description:
    "Send a message to another Traycer agent in this epic. Delivery is asynchronous: this call returns as soon as the message is queued, and any reply arrives later as a new incoming message - never as this tool's result. A pending reply is not a reason to hold your turn open or to poll the peer.",
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
} as const;

describe("Agent A2A MCP bridge", () => {
  it("serves the signed send-only MCP wire contract", async () => {
    const sendRequests: unknown[] = [];
    const bridge = await startAgentA2AMcpBridge((request) => {
      sendRequests.push(request);
      return { ok: true, result: { responseId: null } };
    });
    const session = bridge.openSession({
      agentId: "sender-agent",
      epicId: "epic-a2a",
    });

    try {
      const initialized = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "bridge-contract-test", version: "1.0.0" },
        },
      });
      expect.soft(initialized.status).toBe(200);
      expect.soft(initialized.sessionId).toBeNull();
      expect.soft(initialized.body).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "traycer-a2a", version: "1.0.0" },
        },
      });

      const listed = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      expect.soft(listed.status).toBe(200);
      expect.soft(listed.body).toEqual({
        jsonrpc: "2.0",
        id: 2,
        result: { tools: [SIGNED_SEND_MESSAGE_TOOL] },
      });
      const listedTool = toolFromListResponse(listed.body);
      expect.soft(listedTool).not.toHaveProperty("inputSchema.$schema");
      expect.soft(listedTool).not.toHaveProperty("execution");

      const invalidCall = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "traycer_send_message",
          arguments: { toAgentId: 123, message: "x" },
        },
      });
      expect.soft(invalidCall.status).toBe(200);
      expect.soft(invalidCall.body).toEqual({
        jsonrpc: "2.0",
        id: 3,
        result: {
          content: [
            {
              type: "text",
              text: "traycer_send_message requires string toAgentId and message.",
            },
          ],
          isError: true,
        },
      });
      expect.soft(sendRequests).toEqual([]);

      const delivered = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "traycer_send_message",
          arguments: {
            toAgentId: "receiver-agent",
            message: "hello",
            expectReply: true,
            responseId: null,
            senderAgentId: "spoofed-sender",
            epicId: "spoofed-epic",
          },
        },
      });
      expect.soft(delivered.body).toEqual({
        jsonrpc: "2.0",
        id: 4,
        result: {
          content: [
            { type: "text", text: JSON.stringify({ responseId: null }) },
          ],
        },
      });
      expect.soft(sendRequests).toEqual([
        {
          senderAgentId: "sender-agent",
          epicId: "epic-a2a",
          receiverAgentId: "receiver-agent",
          prompt: "hello",
          expectReply: true,
          responseId: null,
        },
      ]);
    } finally {
      session.dispose();
      await bridge.close();
    }
  });

  it("rejects an incorrect Bearer token", async () => {
    const bridge = await startAgentA2AMcpBridge(() => ({
      ok: true,
      result: { responseId: null },
    }));
    const session = bridge.openSession({
      agentId: "bearer-agent",
      epicId: "epic-a2a",
    });

    try {
      const rejected = await postMcp(
        session.url,
        "incorrect-token",
        initializeRequest(10),
      );
      expect(rejected).toEqual({
        status: 401,
        sessionId: null,
        body: { error: "Unauthorized" },
      });
    } finally {
      session.dispose();
      await bridge.close();
    }
  });

  it("rejects a non-loopback Origin", async () => {
    const bridge = await startAgentA2AMcpBridge(() => ({
      ok: true,
      result: { responseId: null },
    }));
    const session = bridge.openSession({
      agentId: "origin-agent",
      epicId: "epic-a2a",
    });

    try {
      const rejected = await postMcpWithOrigin(
        session.url,
        session.token,
        "https://attacker.example",
        initializeRequest(11),
      );
      expect(rejected).toEqual({
        status: 403,
        sessionId: null,
        body: { error: "Forbidden" },
      });
    } finally {
      session.dispose();
      await bridge.close();
    }
  });

  it("revokes an agent Bearer when its session is released", async () => {
    const bridge = await startAgentA2AMcpBridge(() => ({
      ok: true,
      result: { responseId: null },
    }));
    const session = bridge.openSession({
      agentId: "revoked-agent",
      epicId: "epic-a2a",
    });

    try {
      const accepted = await postMcp(
        session.url,
        session.token,
        initializeRequest(12),
      );
      expect(accepted.status).toBe(200);

      bridge.releaseSession({
        agentId: "revoked-agent",
        epicId: "epic-a2a",
      });
      const rejected = await postMcp(
        session.url,
        session.token,
        initializeRequest(13),
      );
      expect(rejected).toEqual({
        status: 401,
        sessionId: null,
        body: { error: "Unauthorized" },
      });
    } finally {
      session.dispose();
      await bridge.close();
    }
  });

  it("isolates the same agent id across epics and revokes only the exact identity", async () => {
    const sendRequests: unknown[] = [];
    const bridge = await startAgentA2AMcpBridge((request) => {
      sendRequests.push(request);
      return { ok: true, result: { responseId: null } };
    });
    const epicA = bridge.openSession({
      agentId: "shared-agent",
      epicId: "epic-a",
    });
    const epicB = bridge.openSession({
      agentId: "shared-agent",
      epicId: "epic-b",
    });

    try {
      expect(epicA.token).not.toBe(epicB.token);

      const sentFromA = await postMcp(
        epicA.url,
        epicA.token,
        sendMessageRequest(20, "from epic A"),
      );
      const sentFromB = await postMcp(
        epicB.url,
        epicB.token,
        sendMessageRequest(21, "from epic B"),
      );
      expect(sentFromA.status).toBe(200);
      expect(sentFromB.status).toBe(200);
      expect(sendRequests).toEqual([
        expect.objectContaining({
          senderAgentId: "shared-agent",
          epicId: "epic-a",
          prompt: "from epic A",
        }),
        expect.objectContaining({
          senderAgentId: "shared-agent",
          epicId: "epic-b",
          prompt: "from epic B",
        }),
      ]);

      bridge.releaseSession({
        agentId: "shared-agent",
        epicId: "epic-a",
      });
      const revokedA = await postMcp(
        epicA.url,
        epicA.token,
        initializeRequest(22),
      );
      expect(revokedA).toEqual({
        status: 401,
        sessionId: null,
        body: { error: "Unauthorized" },
      });

      const stillSentFromB = await postMcp(
        epicB.url,
        epicB.token,
        sendMessageRequest(23, "still from epic B"),
      );
      expect(stillSentFromB.status).toBe(200);
      expect(sendRequests.at(-1)).toEqual(
        expect.objectContaining({
          senderAgentId: "shared-agent",
          epicId: "epic-b",
          prompt: "still from epic B",
        }),
      );
    } finally {
      epicA.dispose();
      epicB.dispose();
      await bridge.close();
    }
  });
});

async function postMcp(
  url: string,
  token: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<{
  readonly status: number;
  readonly sessionId: string | null;
  readonly body: unknown;
}> {
  return await postMcpWithOrigin(url, token, null, payload);
}

async function postMcpWithOrigin(
  url: string,
  token: string,
  origin: string | null,
  payload: Readonly<Record<string, unknown>>,
): Promise<{
  readonly status: number;
  readonly sessionId: string | null;
  readonly body: unknown;
}> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
  if (origin !== null) {
    headers.Origin = origin;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  return {
    status: response.status,
    sessionId: response.headers.get("mcp-session-id"),
    body: parseMcpBody(await response.text()),
  };
}

function initializeRequest(id: number): Readonly<Record<string, unknown>> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "bridge-security-test", version: "1.0.0" },
    },
  };
}

function sendMessageRequest(
  id: number,
  message: string,
): Readonly<Record<string, unknown>> {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "traycer_send_message",
      arguments: { toAgentId: "receiver-agent", message },
    },
  };
}

function parseMcpBody(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const data = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .find((line) => line.length > 0);
    if (data === undefined) {
      throw new Error("MCP response was neither JSON nor SSE JSON");
    }
    return JSON.parse(data);
  }
}

function toolFromListResponse(body: unknown): unknown {
  if (
    typeof body !== "object" ||
    body === null ||
    !("result" in body) ||
    typeof body.result !== "object" ||
    body.result === null ||
    !("tools" in body.result) ||
    !Array.isArray(body.result.tools)
  ) {
    throw new Error("Expected an MCP tools/list response");
  }
  return body.result.tools[0];
}
