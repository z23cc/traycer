import { spawn } from "node:child_process";
import type { ChatRunSettings } from "@traycer/protocol/persistence/epic/schemas";
import {
  runCodexAppServer,
  runCodexAppServerWithAgentA2A,
} from "./codex-app-server";
import { launchSpec } from "./cli-args";
import {
  encodeClaudeControlAllow,
  encodeClaudeUserMessage,
} from "./claude-stdin";
import { OutputDecoder, type DecodedEvent } from "./cli-parse";
import {
  harnessCommandOf,
  resolveHarnessExecutable,
  type HarnessCommand,
} from "./cli-resolve";

export type TurnRequest = Readonly<
  Pick<
    ChatRunSettings,
    "harnessId" | "model" | "permissionMode" | "reasoningEffort" | "serviceTier"
  >
> & {
  readonly prompt: string;
  readonly cwd: string | null;
  readonly sessionId: string | null;
  readonly signal: AbortSignal;
  readonly traycerAgentEnv?: {
    readonly agentId: string;
    readonly epicId: string;
    readonly cliSurface: "full" | "readonly";
  };
  readonly traycerA2AMcp?: AgentA2AMcpLaunchContext;
};

export type AgentA2AMcpLaunchContext = {
  readonly url: string;
  readonly token: string;
};

export type TurnChunk =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "reasoning"; readonly text: string }
  | { readonly kind: "session"; readonly sessionId: string }
  | {
      readonly kind: "tool_start";
      readonly blockId: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly kind: "tool_end";
      readonly blockId: string;
      readonly name: string;
    }
  | {
      readonly kind: "tool_error";
      readonly blockId: string;
      readonly name: string;
      readonly error: string;
    }
  | {
      readonly kind: "command_start";
      readonly blockId: string;
      readonly command: string;
      readonly cwd: string;
    }
  | {
      readonly kind: "command_end";
      readonly blockId: string;
      readonly command: string;
      readonly exitCode: number | null;
    };

export type TurnResult = {
  readonly text: string;
  readonly sessionId: string | null;
};

export type TurnRunner = {
  readonly run: (
    request: TurnRequest,
    emit: (chunk: TurnChunk) => void,
  ) => Promise<TurnResult>;
};

export function scriptedTurnRunner(chunks: readonly string[]): TurnRunner {
  return {
    async run(_request, emit) {
      let text = "";
      for (const chunk of chunks) {
        text += chunk;
        emit({ kind: "text", text: chunk });
      }
      return { text, sessionId: null };
    },
  };
}

export function createProcessTurnRunner(env: NodeJS.ProcessEnv): TurnRunner {
  return {
    run(request, emit) {
      return runProcess(request, emit, env);
    },
  };
}

async function runProcess(
  request: TurnRequest,
  emit: (chunk: TurnChunk) => void,
  env: NodeJS.ProcessEnv,
): Promise<TurnResult> {
  const processEnv = agentProcessEnv(env, request.traycerAgentEnv);
  const harness = harnessCommandOf(request.harnessId);
  if (harness === null) {
    return emitNotice(
      `Harness "${request.harnessId}" is not wired on this local host yet.`,
      emit,
    );
  }
  const command = resolveHarnessExecutable(harness, env);
  if (command === null) {
    return emitNotice(missingBinaryMessage(harness), emit);
  }
  if (harness === "codex") {
    const a2aMcp = request.traycerA2AMcp;
    if (a2aMcp === undefined) {
      return await runCodexAppServer(command, request, emit, processEnv);
    }
    return await runCodexAppServerWithAgentA2A(
      command,
      request,
      emit,
      {
        ...processEnv,
        TRAYCER_A2A_MCP_TOKEN: a2aMcp.token,
      },
      a2aMcp.url,
    );
  }
  const spec = launchSpec(command, harness, {
    model: request.model,
    permissionMode: request.permissionMode,
    prompt: request.prompt,
    sessionId: request.sessionId,
  });
  const args =
    request.traycerA2AMcp === undefined
      ? spec.args
      : [...spec.args, ...claudeAgentA2AMcpArgs(request.traycerA2AMcp)];
  return await spawnClaudeAndCollect(
    spec.command,
    args,
    request,
    emit,
    processEnv,
  );
}

function claudeAgentA2AMcpArgs(context: AgentA2AMcpLaunchContext): string[] {
  return [
    "--mcp-config",
    JSON.stringify({
      mcpServers: {
        traycer_a2a: {
          type: "http",
          url: context.url,
          headers: { Authorization: `Bearer ${context.token}` },
          alwaysLoad: true,
        },
      },
    }),
  ];
}

function agentProcessEnv(
  env: NodeJS.ProcessEnv,
  context: TurnRequest["traycerAgentEnv"],
): NodeJS.ProcessEnv {
  if (context === undefined) {
    return env;
  }
  const configuredCli = env.TRAYCER_CLI;
  return {
    ...env,
    TRAYCER_AGENT_ID: context.agentId,
    TRAYCER_EPIC_ID: context.epicId,
    TRAYCER_AGENT_CLI_SURFACE: context.cliSurface,
    TRAYCER_CLI:
      configuredCli !== undefined && configuredCli.trim().length > 0
        ? configuredCli
        : "traycer",
  };
}

function claudeLaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.NODE_OPTIONS;
  if (
    next.CLAUDE_CODE_ENTRYPOINT === undefined ||
    next.CLAUDE_CODE_ENTRYPOINT.length === 0
  ) {
    next.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";
  }
  return next;
}

function missingBinaryMessage(harness: HarnessCommand): string {
  const binary = harness;
  const envKey =
    harness === "claude" ? "TRAYCER_CLAUDE_PATH" : "TRAYCER_CODEX_PATH";
  return `${binary} was not found on PATH. Install the CLI or set ${envKey}.`;
}

function emitNotice(
  text: string,
  emit: (chunk: TurnChunk) => void,
): TurnResult {
  emit({ kind: "text", text });
  return { text, sessionId: null };
}

function spawnClaudeAndCollect(
  command: string,
  args: string[],
  request: TurnRequest,
  emit: (chunk: TurnChunk) => void,
  env: NodeJS.ProcessEnv,
): Promise<TurnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: request.cwd ?? undefined,
      env: claudeLaunchEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const decoder = new OutputDecoder();
    const stderrChunks: string[] = [];
    let settled = false;
    let sessionId: string | null = request.sessionId;

    const onDecoded = (event: DecodedEvent): void => {
      if (event.kind === "text") {
        emit({ kind: "text", text: event.text });
        return;
      }
      if (event.kind === "reasoning") {
        emit({ kind: "reasoning", text: event.text });
        return;
      }
      if (event.kind === "session") {
        sessionId = event.sessionId;
        emit({ kind: "session", sessionId: event.sessionId });
        return;
      }
      if (event.kind === "tool_start") {
        emit(event);
        return;
      }
      if (event.kind === "tool_end") {
        emit(event);
        return;
      }
      if (event.kind === "control_request") {
        child.stdin.write(encodeClaudeControlAllow(event.requestId));
        return;
      }
      if (event.kind === "result") {
        child.stdin.end();
      }
    };

    const finish = (error: Error | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      request.signal.removeEventListener("abort", onAbort);
      if (error !== null) {
        reject(error);
        return;
      }
      decoder.flush(onDecoded);
      const text = decoder.text();
      if (text.length > 0) {
        resolve({ text, sessionId });
        return;
      }
      const stderr = stderrChunks.join("").trim();
      resolve({
        text:
          stderr.length > 0
            ? stderr
            : `${request.harnessId} exited without producing any text.`,
        sessionId,
      });
    };

    const onAbort = (): void => {
      child.kill("SIGTERM");
    };

    if (request.signal.aborted) {
      child.kill("SIGTERM");
    } else {
      request.signal.addEventListener("abort", onAbort);
    }

    child.stdin.write(encodeClaudeUserMessage(request.prompt));

    child.stdout.on("data", (chunk: Buffer | string) => {
      decoder.push(chunk.toString(), onDecoded);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(chunk.toString());
    });
    child.once("error", (error) => {
      finish(error);
    });
    child.once("close", (code) => {
      if (request.signal.aborted) {
        finish(new Error("Turn was stopped"));
        return;
      }
      if (code !== 0 && decoder.text().length === 0) {
        const stderr = stderrChunks.join("").trim();
        finish(
          new Error(
            stderr.length > 0
              ? stderr
              : `${command} exited with code ${String(code)}`,
          ),
        );
        return;
      }
      finish(null);
    });
  });
}
