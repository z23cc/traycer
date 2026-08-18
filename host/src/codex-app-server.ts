import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface, type Interface } from "node:readline";
import type { TurnChunk, TurnRequest, TurnResult } from "./cli-runner";

type JsonRpcRecord = { readonly [key: string]: unknown };

type PendingRequest = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
};

const INITIALIZE_PARAMS = {
  protocolVersion: "2025-01-01",
  capabilities: { experimentalApi: true },
  clientInfo: { name: "traycer-agents", version: "1.0.0" },
} as const;

const APPROVAL_POLICY = {
  approvalPolicy: "untrusted",
  approvalsReviewer: "user",
} as const;

const INITIALIZE_TIMEOUT_MS = 30_000;

export function runCodexAppServer(
  command: string,
  request: TurnRequest,
  emit: (chunk: TurnChunk) => void,
  env: NodeJS.ProcessEnv,
): Promise<TurnResult> {
  return runCodexAppServerWithArgs(
    command,
    codexAppServerArgs(null),
    request,
    emit,
    env,
  );
}

export function runCodexAppServerWithAgentA2A(
  command: string,
  request: TurnRequest,
  emit: (chunk: TurnChunk) => void,
  env: NodeJS.ProcessEnv,
  mcpUrl: string,
): Promise<TurnResult> {
  return runCodexAppServerWithArgs(
    command,
    codexAppServerArgs(mcpUrl),
    request,
    emit,
    env,
  );
}

async function runCodexAppServerWithArgs(
  command: string,
  commandArgs: string[],
  request: TurnRequest,
  emit: (chunk: TurnChunk) => void,
  env: NodeJS.ProcessEnv,
): Promise<TurnResult> {
  if (request.signal.aborted) {
    throw new Error("Turn was stopped");
  }
  let notificationSink: ((notification: JsonRpcRecord) => void) | null = null;
  let disconnectSink: ((error: Error) => void) | null = null;
  const transport = await CodexTransport.connect(
    command,
    commandArgs,
    request.cwd,
    env,
    (notification) => {
      notificationSink?.(notification);
    },
    (error) => {
      disconnectSink?.(error);
    },
    (serverRequest) =>
      answerCodexServerRequest(serverRequest, request.permissionMode),
  );
  let activeSessionId: string | null = null;
  let activeTurnId: string | null = null;
  let interruptSent = false;
  const stopped = deferred<void>();
  void stopped.promise.catch(() => {
    return;
  });
  const interrupt = (): void => {
    const sessionId = activeSessionId;
    const turnId = activeTurnId;
    if (sessionId !== null && turnId !== null && !interruptSent) {
      interruptSent = true;
      void transport
        .request("turn/interrupt", { threadId: sessionId, turnId })
        .catch(() => {
          return;
        });
    }
    stopped.reject(new Error("Turn was stopped"));
  };
  request.signal.addEventListener("abort", interrupt, { once: true });
  const removeAbortListener = (): void => {
    request.signal.removeEventListener("abort", interrupt);
  };
  if (request.signal.aborted) {
    interrupt();
  }
  const requestOrStop = (method: string, params: unknown): Promise<unknown> => {
    if (request.signal.aborted) {
      return stopped.promise;
    }
    return Promise.race([transport.request(method, params), stopped.promise]);
  };
  try {
    await withTimeout(
      requestOrStop("initialize", INITIALIZE_PARAMS),
      INITIALIZE_TIMEOUT_MS,
      "Codex app-server initialize timed out",
    );
    transport.markInitialized();
    const threadMethod =
      request.sessionId === null ? "thread/start" : "thread/resume";
    const thread = await requestOrStop(threadMethod, {
      ...(request.sessionId === null ? {} : { threadId: request.sessionId }),
      cwd: request.cwd,
      runtimeWorkspaceRoots: workspaceRoots(request.cwd),
      model: request.model,
      ...(request.serviceTier === null
        ? {}
        : { serviceTier: request.serviceTier }),
      ...APPROVAL_POLICY,
    });
    const sessionId = threadIdFrom(thread) ?? request.sessionId;
    if (sessionId === null) {
      throw new Error(
        `${threadMethod} response did not contain a thread or session ID`,
      );
    }
    activeSessionId = sessionId;
    emit({ kind: "session", sessionId });

    let text = "";
    const completed = deferred<void>();
    void completed.promise.catch(() => {
      return;
    });
    disconnectSink = completed.reject;
    notificationSink = (notification): void => {
      const method = stringField(notification, "method");
      const params = recordField(notification, "params");
      if (
        params !== null &&
        !belongsToActiveTurn(params, sessionId, activeTurnId)
      ) {
        return;
      }
      if (method === "item/agentMessage/delta" && params !== null) {
        const delta = stringField(params, "delta");
        if (delta !== null && delta.length > 0) {
          text += delta;
          emit({ kind: "text", text: delta });
        }
        return;
      }
      if (method === "turn/started" && params !== null) {
        activeTurnId = turnIdFrom(params) ?? activeTurnId;
        if (request.signal.aborted) {
          interrupt();
        }
        return;
      }
      if (
        (method === "item/reasoning/textDelta" ||
          method === "item/reasoning/summaryTextDelta") &&
        params !== null
      ) {
        const delta = stringField(params, "delta");
        if (delta !== null && delta.length > 0) {
          emit({ kind: "reasoning", text: delta });
        }
        return;
      }
      if (
        (method === "item/started" || method === "item/completed") &&
        params !== null
      ) {
        const item = recordField(params, "item") ?? params;
        const chunk =
          method === "item/started"
            ? startedChunkFrom(item)
            : completedChunkFrom(item);
        if (chunk !== null) {
          emit(chunk);
        }
        return;
      }
      if (method === "turn/completed") {
        const error = turnCompletionError(params);
        if (error === null) {
          completed.resolve();
        } else {
          completed.reject(error);
        }
        return;
      }
      if (method === "error") {
        if (params !== null && booleanField(params, "willRetry") === true) {
          return;
        }
        completed.reject(new Error(errorMessage(params)));
      }
    };

    const turnOutcome = await Promise.race([
      requestOrStop("turn/start", {
        threadId: sessionId,
        input: [{ type: "text", text: request.prompt, text_elements: [] }],
        cwd: request.cwd,
        runtimeWorkspaceRoots: workspaceRoots(request.cwd),
        ...APPROVAL_POLICY,
        sandboxPolicy: { type: "dangerFullAccess" },
        effort: request.reasoningEffort,
        summary: "auto",
      }).then((value) => ({ kind: "response" as const, value })),
      completed.promise.then(() => ({ kind: "completed" as const })),
    ]);
    if (turnOutcome.kind === "response") {
      activeTurnId = turnIdFrom(turnOutcome.value) ?? activeTurnId;
    }
    if (request.signal.aborted) {
      interrupt();
    }
    if (turnOutcome.kind === "response") {
      await Promise.race([completed.promise, stopped.promise]);
    }
    return { text, sessionId };
  } finally {
    removeAbortListener();
    notificationSink = null;
    disconnectSink = null;
    await transport.disconnect();
  }
}

class CodexTransport {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private readonly notification: (notification: JsonRpcRecord) => void;
  private readonly onDisconnected: (error: Error) => void;
  private readonly onServerRequest: (
    request: JsonRpcRecord,
  ) => Promise<unknown>;
  private disconnected = false;
  private initialized = false;
  private stderrTail = "";

  private constructor(
    child: ChildProcessWithoutNullStreams,
    notification: (notification: JsonRpcRecord) => void,
    onDisconnected: (error: Error) => void,
    onServerRequest: (request: JsonRpcRecord) => Promise<unknown>,
  ) {
    this.child = child;
    this.notification = notification;
    this.onDisconnected = onDisconnected;
    this.onServerRequest = onServerRequest;
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-4_096);
    });
    child.stderr.on("error", (error) => {
      this.handleTransportError("stderr", error);
    });
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => {
      this.handleLine(line);
    });
    child.stdin.on("error", (error) => {
      this.handleTransportError("stdin", error);
    });
    child.stdout.on("error", (error) => {
      this.handleTransportError("stdout", error);
    });
    child.on("error", (error) => {
      this.handleTransportError("process", error);
    });
    child.once("exit", (code, signal) => {
      const wasDisconnected = this.disconnected;
      this.disconnected = true;
      const exitReason =
        signal === null
          ? `codex app-server exited with code ${String(code)}`
          : `codex app-server was killed by signal ${signal}`;
      const stderr = this.stderrTail.trim();
      const error = new Error(
        !this.initialized && stderr.length > 0
          ? `${exitReason}: ${stderr}`
          : exitReason,
      );
      this.failPending(error);
      if (!wasDisconnected) {
        this.onDisconnected(error);
      }
    });
  }

  static async connect(
    command: string,
    commandArgs: string[],
    cwd: string | null,
    env: NodeJS.ProcessEnv,
    notification: (notification: JsonRpcRecord) => void,
    onDisconnected: (error: Error) => void,
    onServerRequest: (request: JsonRpcRecord) => Promise<unknown>,
  ): Promise<CodexTransport> {
    const child = spawn(command, commandArgs, {
      cwd: cwd ?? undefined,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onSpawn = (): void => {
        cleanup();
        resolve();
      };
      const cleanup = (): void => {
        child.removeListener("error", onError);
        child.removeListener("spawn", onSpawn);
      };
      child.once("error", onError);
      child.once("spawn", onSpawn);
    });
    return new CodexTransport(
      child,
      notification,
      onDisconnected,
      onServerRequest,
    );
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.disconnected) {
      return Promise.reject(new Error("JSON-RPC client not connected"));
    }
    const id = randomUUID();
    const frame = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
        if (error === null || error === undefined) {
          return;
        }
        this.handleTransportError(
          "stdin",
          new Error(`Failed to write to Codex app-server: ${error.message}`),
        );
      });
    });
  }

  markInitialized(): void {
    this.initialized = true;
  }

  async disconnect(): Promise<void> {
    if (this.disconnected) {
      return;
    }
    await Promise.race([
      this.request("shutdown", undefined),
      delay(5_000),
    ]).catch(() => {
      return;
    });
    this.disconnected = true;
    this.lines.close();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill();
    }
    this.failPending(new Error("JSON-RPC client disconnected"));
  }

  private handleTransportError(channel: string, cause: Error): void {
    if (this.disconnected) {
      return;
    }
    this.disconnected = true;
    const error = new Error(
      `Codex app-server ${channel} error: ${cause.message}`,
    );
    this.failPending(error);
    this.onDisconnected(error);
    this.lines.close();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill();
    }
  }

  private handleLine(line: string): void {
    const parsed = parseRecord(line);
    if (parsed === null) {
      return;
    }
    const id = stringOrNumberField(parsed, "id");
    const method = stringField(parsed, "method");
    if (id !== null && method !== null) {
      void this.answerServerRequest(parsed, id);
      return;
    }
    if (id !== null && method === null) {
      const pending = this.pending.get(String(id));
      if (pending === undefined) {
        return;
      }
      this.pending.delete(String(id));
      const error = recordField(parsed, "error");
      if (error !== null) {
        pending.reject(new Error(jsonRpcError(error)));
        return;
      }
      pending.resolve(Reflect.get(parsed, "result"));
      return;
    }
    if (method !== null && id === null) {
      try {
        this.notification(parsed);
      } catch (error) {
        this.handleTransportError("notification", toError(error));
      }
    }
  }

  private async answerServerRequest(
    request: JsonRpcRecord,
    id: string | number,
  ): Promise<void> {
    try {
      const result = await this.onServerRequest(request);
      this.writeFrame({ jsonrpc: "2.0", id, result });
    } catch (error) {
      this.writeFrame({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32_603,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private writeFrame(frame: JsonRpcRecord): void {
    if (this.disconnected) {
      return;
    }
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private failPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}

function codexAppServerArgs(mcpUrl: string | null): string[] {
  const command = ["app-server", "--listen", "stdio://"];
  if (mcpUrl === null) {
    return command;
  }
  return [
    "-c",
    `mcp_servers.traycer_a2a.url=${JSON.stringify(mcpUrl)}`,
    "-c",
    'mcp_servers.traycer_a2a.bearer_token_env_var="TRAYCER_A2A_MCP_TOKEN"',
    ...command,
  ];
}

function workspaceRoots(cwd: string | null): string[] {
  return cwd === null ? [] : [cwd];
}

function threadIdFrom(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const thread = recordField(value, "thread");
  if (thread === null) {
    return null;
  }
  return stringField(thread, "id") ?? stringField(thread, "sessionId");
}

function turnIdFrom(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const direct = stringField(value, "turnId");
  if (direct !== null) {
    return direct;
  }
  const turn = recordField(value, "turn");
  return turn === null ? null : stringField(turn, "id");
}

function belongsToActiveTurn(
  params: JsonRpcRecord,
  sessionId: string,
  turnId: string | null,
): boolean {
  const notificationThreadId = stringField(params, "threadId");
  if (notificationThreadId !== null && notificationThreadId !== sessionId) {
    return false;
  }
  const notificationTurnId = turnIdFrom(params);
  return (
    turnId === null ||
    notificationTurnId === null ||
    notificationTurnId === turnId
  );
}

function errorMessage(params: JsonRpcRecord | null): string {
  if (params === null) {
    return "Codex error";
  }
  const direct = stringField(params, "message");
  if (direct !== null) {
    return direct;
  }
  const nested = recordField(params, "error");
  return nested === null
    ? "Codex error"
    : (stringField(nested, "message") ?? "Codex error");
}

function turnCompletionError(params: JsonRpcRecord | null): Error | null {
  if (params === null) {
    return null;
  }
  const turn = recordField(params, "turn");
  if (turn === null) {
    return null;
  }
  const status = stringField(turn, "status");
  if (status === "failed") {
    const error = recordField(turn, "error");
    return new Error(
      error === null
        ? "Codex turn failed"
        : (stringField(error, "message") ?? "Codex turn failed"),
    );
  }
  return status === "interrupted"
    ? new Error("Codex turn was interrupted")
    : null;
}

type ToolDescriptor = {
  readonly blockId: string;
  readonly name: string;
  readonly input: unknown;
};

function startedChunkFrom(item: JsonRpcRecord): TurnChunk | null {
  if (stringField(item, "type") === "commandExecution") {
    return {
      kind: "command_start",
      blockId: stringField(item, "id") ?? randomUUID(),
      command: stringField(item, "command") ?? "",
      cwd: stringField(item, "cwd") ?? "",
    };
  }
  const tool = toolDescriptorFrom(item);
  return tool === null
    ? null
    : {
        kind: "tool_start",
        blockId: tool.blockId,
        name: tool.name,
        input: tool.input,
      };
}

function completedChunkFrom(item: JsonRpcRecord): TurnChunk | null {
  if (stringField(item, "type") === "commandExecution") {
    return {
      kind: "command_end",
      blockId: stringField(item, "id") ?? randomUUID(),
      command: stringField(item, "command") ?? "",
      exitCode: numberField(item, "exitCode"),
    };
  }
  const tool = toolDescriptorFrom(item);
  if (tool === null) {
    return null;
  }
  if (toolCallFailed(item)) {
    return {
      kind: "tool_error",
      blockId: tool.blockId,
      name: tool.name,
      error: toolErrorMessage(item),
    };
  }
  return {
    kind: "tool_end",
    blockId: tool.blockId,
    name: tool.name,
  };
}

function toolDescriptorFrom(item: JsonRpcRecord): ToolDescriptor | null {
  const type = stringField(item, "type");
  const blockId = stringField(item, "id") ?? randomUUID();
  if (type === "mcpToolCall") {
    return {
      blockId,
      name: qualifiedToolName(
        stringField(item, "server"),
        stringField(item, "tool"),
      ),
      input: Reflect.get(item, "arguments"),
    };
  }
  if (type === "dynamicToolCall") {
    return {
      blockId,
      name: qualifiedToolName(
        stringField(item, "namespace"),
        stringField(item, "tool"),
      ),
      input: Reflect.get(item, "arguments"),
    };
  }
  if (type === "webSearch") {
    return {
      blockId,
      name: "web_search",
      input: { query: stringField(item, "query") ?? "" },
    };
  }
  if (type === "imageGeneration") {
    return {
      blockId,
      name: "image_generation",
      input: { revisedPrompt: stringField(item, "revisedPrompt") ?? "" },
    };
  }
  return null;
}

function qualifiedToolName(prefix: string | null, name: string | null): string {
  const toolName = name ?? "unknown";
  return prefix === null || prefix.length === 0
    ? toolName
    : `${prefix}/${toolName}`;
}

function toolCallFailed(item: JsonRpcRecord): boolean {
  const error = Reflect.get(item, "error");
  return (
    (error !== null && error !== undefined) ||
    booleanField(item, "success") === false ||
    stringField(item, "status") === "failed"
  );
}

function toolErrorMessage(item: JsonRpcRecord): string {
  const error = Reflect.get(item, "error");
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  if (isRecord(error)) {
    return stringField(error, "message") ?? "Tool call failed";
  }
  return "Tool call failed";
}

async function answerCodexServerRequest(
  request: JsonRpcRecord,
  permissionMode: TurnRequest["permissionMode"],
): Promise<unknown> {
  const method = stringField(request, "method");
  const fullyApproved = permissionMode === "full_access";
  if (method === "item/commandExecution/requestApproval") {
    return { decision: fullyApproved ? "accept" : "decline" };
  }
  if (method === "item/fileChange/requestApproval") {
    return {
      decision:
        fullyApproved || permissionMode === "auto_accept_edits"
          ? "accept"
          : "decline",
    };
  }
  throw new Error(`Unsupported Codex server request: ${method ?? "unknown"}`);
}

function jsonRpcError(error: JsonRpcRecord): string {
  const code = Reflect.get(error, "code");
  const message = stringField(error, "message") ?? "Unknown error";
  return `JSON-RPC error ${String(code)}: ${message}`;
}

function parseRecord(line: string): JsonRpcRecord | null {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is JsonRpcRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordField(value: JsonRpcRecord, key: string): JsonRpcRecord | null {
  const field = Reflect.get(value, key);
  return isRecord(field) ? field : null;
}

function stringField(value: JsonRpcRecord, key: string): string | null {
  const field = Reflect.get(value, key);
  return typeof field === "string" ? field : null;
}

function booleanField(value: JsonRpcRecord, key: string): boolean | null {
  const field = Reflect.get(value, key);
  return typeof field === "boolean" ? field : null;
}

function numberField(value: JsonRpcRecord, key: string): number | null {
  const field = Reflect.get(value, key);
  return typeof field === "number" ? field : null;
}

function stringOrNumberField(
  value: JsonRpcRecord,
  key: string,
): string | number | null {
  const field = Reflect.get(value, key);
  return typeof field === "string" || typeof field === "number" ? field : null;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
} {
  let resolvePromise: (value: T) => void = () => {
    return;
  };
  let rejectPromise: (error: Error) => void = () => {
    return;
  };
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function withTimeout<T>(
  operation: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, milliseconds);
    timer.unref();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
