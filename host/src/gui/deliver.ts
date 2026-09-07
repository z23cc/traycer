import { spawn, type ChildProcess } from "node:child_process";
import { accumulateEvent } from "@traycer/protocol/host/agent/gui/agent-runtime-accumulator";
import type { RuntimeEvent } from "@traycer/protocol/host/agent/gui/agent-runtime";
import type { ContentBlock } from "@traycer/protocol/persistence/epic/content-blocks";
import { providerCliIdentity, spawnEnvForProvider } from "../providers/service";
import { snapshotHookSettings } from "../snapshots/snapshots";
import type { HostRuntime } from "../runtime";
import { providerIdForHarness } from "./harness-map";
import {
  parseProviderStdoutLine,
  type ProviderStreamEvent,
} from "./provider-stream";

const PRINT_TIMEOUT_MS = 600_000;
const KILL_GRACE_MS = 2_000;
const OUTPUT_FLUSH_MS = 250;

export type GuiPrintTurnState = {
  readonly harnessId: string;
  readonly model: string;
  readonly userMessageId: string | null;
  readonly assistantMessageId: string;
  readonly turnId: string;
  readonly resumed: boolean;
  readonly compact: boolean;
  readonly startedAt: number;
};

export class GuiRunRegistry {
  private readonly runs = new Map<string, ChildProcess>();
  private readonly prints = new Map<string, GuiPrintTurnState>();
  /**
   * The blocks each running turn has produced so far, folded from the same
   * deltas the GUI receives.
   *
   * Kept here rather than in the turn's own scope because the turn's terminal
   * events are emitted from `finishPrint`, which runs outside it - and those
   * are the events that finalize every still-streaming block. Reset when a
   * turn begins; deliberately NOT cleared when one ends, since `endPrint` runs
   * before the completed turn is written to disk.
   */
  private readonly turnBlocks = new Map<string, ContentBlock[]>();
  private readonly stopped = new Set<string>();
  private readonly inflight = new Set<Promise<void>>();
  private disposing = false;

  beginPrint(agentId: string, state: GuiPrintTurnState): void {
    this.stopped.delete(agentId);
    this.prints.set(agentId, state);
    this.turnBlocks.set(agentId, []);
  }

  /**
   * Fold one broadcast delta into the running turn's blocks.
   *
   * This is the protocol's own reducer, the same one the GUI runs over the
   * same events, so the persisted turn and the live one cannot disagree about
   * what happened - and the raw tool input the reducer drops on the way stays
   * out of the store.
   */
  foldTurnBlock(agentId: string, event: RuntimeEvent): void {
    const current = this.turnBlocks.get(agentId);
    if (current === undefined) {
      return;
    }
    this.turnBlocks.set(agentId, accumulateEvent(current, event));
  }

  blocksOf(agentId: string): readonly ContentBlock[] {
    return this.turnBlocks.get(agentId) ?? [];
  }

  endPrint(agentId: string, assistantMessageId: string | null): void {
    const current = this.prints.get(agentId);
    if (current === undefined) {
      return;
    }
    if (
      assistantMessageId !== null &&
      current.assistantMessageId !== assistantMessageId
    ) {
      return;
    }
    this.prints.delete(agentId);
    this.stopped.delete(agentId);
  }

  /** The live child of one GUI chat turn, for resource attribution. */
  pidOf(agentId: string): number | null {
    return this.runs.get(agentId)?.pid ?? null;
  }

  /** Agents with a running child right now. */
  runningAgentIds(): readonly string[] {
    return [...this.runs.keys()];
  }

  track(work: Promise<void>): void {
    const wrapped = work.then(
      () => undefined,
      () => undefined,
    );
    this.inflight.add(wrapped);
    void wrapped.finally(() => {
      this.inflight.delete(wrapped);
    });
  }

  isDisposing(): boolean {
    return this.disposing;
  }

  printState(agentId: string): GuiPrintTurnState | null {
    return this.prints.get(agentId) ?? null;
  }

  printCount(): number {
    return this.prints.size;
  }

  requestStop(agentId: string): boolean {
    if (!this.prints.has(agentId) && !this.runs.has(agentId)) {
      return false;
    }
    this.stopped.add(agentId);
    const child = this.runs.get(agentId);
    if (child !== undefined) {
      child.kill("SIGTERM");
    }
    return true;
  }

  wasStopped(agentId: string): boolean {
    return this.stopped.has(agentId);
  }

  set(agentId: string, child: ChildProcess): void {
    const current = this.runs.get(agentId);
    if (current !== undefined) {
      current.kill("SIGTERM");
    }
    this.runs.set(agentId, child);
  }

  kill(agentId: string): void {
    const child = this.runs.get(agentId);
    if (child === undefined) {
      return;
    }
    this.runs.delete(agentId);
    child.kill("SIGTERM");
  }

  async disposeAll(): Promise<void> {
    this.disposing = true;
    for (const agentId of this.prints.keys()) {
      this.stopped.add(agentId);
    }
    for (const agentId of [...this.runs.keys()]) {
      this.kill(agentId);
    }
    await Promise.all([...this.inflight]);
    this.prints.clear();
    this.stopped.clear();
  }
}

export async function runGuiPrintTurn(
  runtime: HostRuntime,
  input: {
    readonly agentId: string;
    readonly harnessId: string;
    readonly prompt: string;
    readonly cwd: string;
    readonly model: string | null;
    readonly permissionMode: string | null;
    readonly sessionId: string | null;
    readonly onEvent: (event: ProviderStreamEvent) => void;
  },
): Promise<string> {
  const providerId = providerIdForHarness(input.harnessId);
  const identity = providerCliIdentity(runtime.store, providerId);
  const binaryPath = identity.path;
  if (binaryPath === null) {
    throw new Error(
      `agent.sendMessage: no executable CLI for harness '${input.harnessId}'`,
    );
  }
  const args = guiPrintArgv(
    input.harnessId,
    input.prompt,
    input.model,
    input.permissionMode,
    input.sessionId,
    // The before/after hooks behind every `file_change` card. Claude is the
    // harness with a hook surface; the others report their edits themselves
    // or not at all.
    input.harnessId === "claude" ? snapshotHookSettings(runtime.dataDir) : null,
  );
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(binaryPath, args, {
        cwd: input.cwd,
        env: spawnEnvForProvider(runtime.store, providerId),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    runtime.guiRuns.set(input.agentId, child);
    // Declared before `emit`, which arms it when the provider rejects the
    // credential.
    const killTimer: { current: NodeJS.Timeout | null } = { current: null };
    let stdout = "";
    let stderr = "";
    let streamed = "";
    let structured = false;
    let pendingPlain = "";
    let timedOut = false;
    let authFailure: {
      readonly status: number;
      readonly detail: string;
    } | null = null;
    let flushTimer: NodeJS.Timeout | null = null;
    const emit = (event: ProviderStreamEvent): void => {
      if (event.kind === "delta") {
        if (event.text.length === 0) {
          return;
        }
        streamed += event.text;
      }
      if (event.kind === "auth_failure" && authFailure === null) {
        // Stop rather than wait it out. The provider retries a rejected
        // credential ten times behind exponential backoff, and none of those
        // attempts can succeed - left alone this run holds the chat until
        // PRINT_TIMEOUT_MS and then reports a timeout, which names the symptom
        // and hides the cause. Killing here costs the retries and buys an
        // error the GUI can act on.
        authFailure = { status: event.status, detail: event.detail };
        child.kill("SIGTERM");
        killTimer.current = setTimeout(() => {
          child.kill("SIGKILL");
        }, KILL_GRACE_MS);
      }
      input.onEvent(event);
    };
    const emitDelta = (text: string): void => {
      emit({ kind: "delta", text });
    };
    const flushPlain = (): void => {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (!structured && pendingPlain.length > 0) {
        emitDelta(pendingPlain);
        pendingPlain = "";
      }
    };
    const consumeStdout = (chunk: string): void => {
      stdout += chunk;
      if (structured) {
        consumeStructured(chunk);
        return;
      }
      if (looksLikeJsonLine(stdout)) {
        structured = true;
        consumeStructured(stdout);
        pendingPlain = "";
        return;
      }
      pendingPlain += chunk;
      if (flushTimer === null) {
        flushTimer = setTimeout(() => {
          flushTimer = null;
          flushPlain();
        }, OUTPUT_FLUSH_MS);
      }
    };
    let lineBuffer = "";
    const consumeStructured = (chunk: string): void => {
      lineBuffer += chunk;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        applyStructuredLine(line);
      }
    };
    const applyStructuredLine = (line: string): void => {
      const events = parseProviderStdoutLine(line);
      const fullMessage = lineIncludesFullMessage(line);
      for (const event of events) {
        if (event.kind === "delta") {
          const text = visibleDeltaText(streamed, event.text, fullMessage);
          if (text === null) {
            continue;
          }
          emit({ kind: "delta", text });
          continue;
        }
        emit(event);
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      consumeStdout(chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer: NodeJS.Timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer.current = setTimeout(() => {
        child.kill("SIGKILL");
      }, KILL_GRACE_MS);
    }, PRINT_TIMEOUT_MS);
    const settle = (): void => {
      clearTimeout(timer);
      if (killTimer.current !== null) {
        clearTimeout(killTimer.current);
      }
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      runtime.guiRuns.kill(input.agentId);
    };
    child.once("error", (error) => {
      settle();
      reject(error);
    });
    child.once("close", (code) => {
      settle();
      if (structured && lineBuffer.length > 0) {
        applyStructuredLine(lineBuffer);
      }
      flushPlain();
      // Raw stdout is a reply only on the unstructured path. On the structured
      // one it is the event stream itself, and handing that back as the
      // assistant's words files a run that said nothing as a run that said
      // several kilobytes of JSON.
      const text =
        streamed.trim().length > 0
          ? streamed.trim()
          : structured
            ? ""
            : stdout.trim();
      const errText = stderr.trim();
      if (runtime.guiRuns.wasStopped(input.agentId)) {
        resolve(text.length > 0 ? text : "Stopped.");
        return;
      }
      // Ahead of the text check: a rejected credential can still have
      // produced a line or two of output, and resolving on that would file the
      // turn as a normal reply.
      if (authFailure !== null) {
        reject(
          new Error(
            `agent.sendMessage: harness '${input.harnessId}' rejected the credential (${String(authFailure.status)} ${authFailure.detail})${errText.length > 0 ? `: ${errText}` : ""}`,
          ),
        );
        return;
      }
      if (timedOut) {
        reject(
          new Error(
            `agent.sendMessage: harness '${input.harnessId}' timed out after ${String(PRINT_TIMEOUT_MS / 1000)}s${errText.length > 0 ? `: ${errText}` : ""}`,
          ),
        );
        return;
      }
      if (text.length > 0) {
        resolve(text);
        return;
      }
      reject(
        new Error(
          errText.length > 0
            ? `agent.sendMessage: harness '${input.harnessId}' produced no output: ${errText}`
            : `agent.sendMessage: harness '${input.harnessId}' produced no output (exit ${String(code)})`,
        ),
      );
    });
  });
}

export function guiPrintArgv(
  harnessId: string,
  prompt: string,
  model: string | null,
  permissionMode: string | null,
  sessionId: string | null,
  /** Claude only: extra settings JSON, which is how the edit hooks ride in. */
  settingsJson: string | null,
): string[] {
  const modelFlag = printModelFlag(model);
  if (harnessId === "claude") {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
    ];
    if (settingsJson !== null) {
      args.push("--settings", settingsJson);
    }
    if (modelFlag !== null) {
      args.push("--model", modelFlag);
    }
    if (permissionMode === "full_access") {
      args.push("--dangerously-skip-permissions");
    }
    if (sessionId !== null) {
      args.push("--resume", sessionId);
    }
    args.push(prompt);
    return args;
  }
  if (harnessId === "codex") {
    const args = ["exec", "--json"];
    if (modelFlag !== null) {
      args.push("--model", modelFlag);
    }
    if (permissionMode === "full_access") {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    } else if (permissionMode === "auto_accept_edits") {
      args.push("--sandbox", "workspace-write");
    } else {
      args.push("--sandbox", "read-only");
    }
    if (sessionId !== null) {
      args.push("resume", sessionId);
    }
    args.push(prompt);
    return args;
  }
  if (harnessId === "opencode") {
    return modelFlag === null
      ? ["run", prompt]
      : ["run", "--model", modelFlag, prompt];
  }
  if (harnessId === "grok") {
    return modelFlag === null
      ? ["-p", prompt]
      : ["-m", modelFlag, "-p", prompt];
  }
  return modelFlag === null
    ? ["-p", prompt]
    : ["-p", "--model", modelFlag, prompt];
}

function printModelFlag(model: string | null): string | null {
  if (model === null || model.length === 0 || model === "default") {
    return null;
  }
  return model;
}

function looksLikeJsonLine(buffer: string): boolean {
  const trimmed = buffer.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

export function visibleDeltaText(
  streamed: string,
  incoming: string,
  lineIsFullMessage: boolean,
): string | null {
  if (incoming.length === 0) {
    return null;
  }
  if (!lineIsFullMessage) {
    return incoming;
  }
  if (streamed.length === 0) {
    return incoming;
  }
  if (incoming === streamed || streamed.endsWith(incoming)) {
    return null;
  }
  if (incoming.startsWith(streamed)) {
    const suffix = incoming.slice(streamed.length);
    return suffix.length === 0 ? null : suffix;
  }
  return incoming;
}

function lineIncludesFullMessage(line: string): boolean {
  return (
    lineTypeIs(line, "assistant") ||
    lineTypeIs(line, "item.completed") ||
    lineTypeIs(line, "item.updated")
  );
}

function lineTypeIs(line: string, type: string): boolean {
  return (
    line.includes(`"type":"${type}"`) || line.includes(`"type": "${type}"`)
  );
}
