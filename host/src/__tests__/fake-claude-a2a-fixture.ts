import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const FAKE_CLAUDE_AUTONOMOUS_REPLY =
  "I inspected the request and replied through Traycer A2A.";

const fakeClaudeA2aTraceSchema = z.object({
  agentId: z.string().nullable(),
  epicId: z.string().nullable(),
  args: z.array(z.string()),
  prompt: z.string().nullable(),
  mcpUrl: z.string().nullable(),
  discoveredTools: z.array(z.string()),
  toolCall: z
    .object({
      name: z.string(),
      arguments: z.object({
        toAgentId: z.string(),
        message: z.string(),
        expectReply: z.boolean(),
        responseId: z.string(),
      }),
    })
    .nullable(),
  toolResult: z.unknown().nullable(),
  error: z.string().nullable(),
});

export type FakeClaudeA2aTrace = z.infer<typeof fakeClaudeA2aTraceSchema>;

export async function createFakeClaudeA2aFixture(root: string): Promise<{
  readonly path: string;
  readonly tracePath: string;
}> {
  const path = join(root, "claude");
  const tracePath = join(root, "claude-a2a-trace.jsonl");
  await writeFile(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");

const reply = ${JSON.stringify(FAKE_CLAUDE_AUTONOMOUS_REPLY)};
const tracePath = process.env.TRAYCER_TEST_A2A_MCP_TRACE;
const trace = {
  agentId: process.env.TRAYCER_AGENT_ID || null,
  epicId: process.env.TRAYCER_EPIC_ID || null,
  args: process.argv.slice(2),
  prompt: null,
  mcpUrl: null,
  discoveredTools: [],
  toolCall: null,
  toolResult: null,
  error: null,
};

function recordTrace() {
  fs.appendFileSync(tracePath, JSON.stringify(trace) + "\\n");
}

function mcpServerFromArgs(args) {
  const separateIndex = args.indexOf("--mcp-config");
  let raw = null;
  if (separateIndex !== -1 && separateIndex + 1 < args.length) {
    raw = args[separateIndex + 1];
  }
  if (raw === null) {
    const combined = args.find((arg) => arg.startsWith("--mcp-config="));
    if (combined !== undefined) raw = combined.slice("--mcp-config=".length);
  }
  if (raw === null) {
    throw new Error("Expected Claude launch to include --mcp-config");
  }
  const config = JSON.parse(raw);
  const server = config && config.mcpServers && config.mcpServers.traycer_a2a;
  if (!server || typeof server.url !== "string") {
    throw new Error("Expected --mcp-config to define traycer_a2a.url");
  }
  const authorization =
    server.headers && typeof server.headers.Authorization === "string"
      ? server.headers.Authorization
      : null;
  if (authorization === null || !authorization.startsWith("Bearer ")) {
    throw new Error("Expected traycer_a2a to carry a Bearer token");
  }
  return { url: server.url, authorization };
}

function parseMcpResponse(raw) {
  if (raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const data = raw
      .split(/\\r?\\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .find((line) => line.length > 0);
    if (data === undefined) {
      throw new Error("MCP response was neither JSON nor SSE JSON");
    }
    return JSON.parse(data);
  }
}

async function callMcp(server, sessionId, payload) {
  const headers = {
    Authorization: server.authorization,
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
  if (sessionId !== null) headers["Mcp-Session-Id"] = sessionId;
  const response = await fetch(server.url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(
      "MCP " + String(payload.method) + " failed with HTTP " +
        String(response.status) + ": " + raw,
    );
  }
  return {
    body: parseMcpResponse(raw),
    sessionId: response.headers.get("mcp-session-id") || sessionId,
  };
}

function textFromInput(line) {
  const envelope = JSON.parse(line);
  const content = envelope && envelope.message && envelope.message.content;
  if (!Array.isArray(content)) {
    throw new Error("Expected a Claude stream-json user message");
  }
  const text = content.find((part) => part && part.type === "text");
  if (!text || typeof text.text !== "string") {
    throw new Error("Expected the Claude user message to contain text");
  }
  return text.text;
}

function capture(pattern, value, description) {
  const match = pattern.exec(value);
  if (match === null || typeof match[1] !== "string") {
    throw new Error("Could not read " + description + " from the agent message");
  }
  return match[1];
}

async function emitAssistant(text) {
  const payload = {
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  };
  await new Promise((resolve, reject) => {
    process.stdout.write(JSON.stringify(payload) + "\\n", (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function readInputLine() {
  const lines = readline.createInterface({ input: process.stdin });
  return await new Promise((resolve, reject) => {
    lines.once("line", (line) => {
      lines.close();
      resolve(line);
    });
    lines.once("error", reject);
  });
}

async function main() {
  trace.prompt = textFromInput(await readInputLine());
  const responseIdMatch = /responseId="([^"]+)"/.exec(trace.prompt);
  if (responseIdMatch === null) {
    recordTrace();
    await emitAssistant("Received the peer reply.");
    return;
  }

  const responseId = capture(
    /responseId="([^"]+)"/,
    trace.prompt,
    "responseId",
  );
  const toAgentId = capture(
    /\\(agent ([^)]+)\\)/,
    trace.prompt,
    "sender agent id",
  );
  const server = mcpServerFromArgs(trace.args);
  trace.mcpUrl = server.url;

  const initialized = await callMcp(server, null, {
    jsonrpc: "2.0",
    id: "initialize-1",
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "traycer-fake-claude", version: "1.0.0" },
    },
  });
  const sessionId = initialized.sessionId;
  await callMcp(server, sessionId, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  });
  const listed = await callMcp(server, sessionId, {
    jsonrpc: "2.0",
    id: "tools-list-1",
    method: "tools/list",
    params: {},
  });
  const tools =
    listed.body && listed.body.result && Array.isArray(listed.body.result.tools)
      ? listed.body.result.tools
      : [];
  trace.discoveredTools = tools
    .map((tool) => (tool && typeof tool.name === "string" ? tool.name : null))
    .filter((name) => name !== null);
  if (!trace.discoveredTools.includes("traycer_send_message")) {
    throw new Error("traycer_send_message was absent from tools/list");
  }

  trace.toolCall = {
    name: "traycer_send_message",
    arguments: {
      toAgentId,
      message: reply,
      expectReply: false,
      responseId,
    },
  };
  const called = await callMcp(server, sessionId, {
    jsonrpc: "2.0",
    id: "tools-call-1",
    method: "tools/call",
    params: trace.toolCall,
  });
  trace.toolResult = called.body;
  if (
    called.body &&
    called.body.result &&
    called.body.result.isError === true
  ) {
    throw new Error("traycer_send_message returned an MCP tool error");
  }
  recordTrace();
  await emitAssistant("Replied through traycer_send_message.");
}

main()
  .catch(async (error) => {
    trace.error = error instanceof Error ? error.message : String(error);
    recordTrace();
    await emitAssistant("A2A MCP unavailable: " + trace.error);
  })
  .finally(() => process.exit(0));
`,
    { mode: 0o755 },
  );
  await chmod(path, 0o755);
  return { path, tracePath };
}

export async function readFakeClaudeA2aTraces(
  tracePath: string,
): Promise<FakeClaudeA2aTrace[]> {
  const raw = await readFile(tracePath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => fakeClaudeA2aTraceSchema.parse(JSON.parse(line)));
}
