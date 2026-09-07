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

const STEER_UNSUPPORTED =
  "This turn does not take same-turn steering; queued for the next turn.";

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

/**
 * One permission question the CLI is waiting on. `requestId` is what the
 * answer must quote; `approvalId` is what the GUI quotes, and the two are
 * different ids because the GUI never sees the CLI's.
 */
export type PendingApproval = {
  /** `interview` is a question the AGENT asked the user, answered through the same channel. */
  readonly kind: "tool" | "file_edit" | "interview";
  readonly approvalId: string;
  readonly requestId: string;
  readonly toolUseId: string | null;
  readonly toolName: string;
  readonly description: string;
  readonly input: unknown;
  readonly requestedAt: number;
  /** The files a `file_edit` question is about; empty for a `tool` one. */
  readonly paths: readonly string[];
  readonly operation: "edit" | "create" | "delete" | null;
};

/**
 * The result a Codex approval request takes, by what it asked. Command and
 * file-change requests take a decision word; a permissions request takes the
 * permissions back (or none) for the turn. The released host answers the
 * same three the same way.
 */
export type InterviewAnswerValues = {
  readonly questionId: string | null;
  readonly question: string | null;
  readonly values: readonly string[];
};

function codexApprovalResult(
  allowed: boolean,
  about: { readonly toolName: string; readonly input: unknown },
  interviewAnswers: readonly InterviewAnswerValues[] | null,
): unknown {
  if (about.toolName === "request_user_input") {
    // The released host's mapping: every question the request carried gets
    // an entry keyed by its id, matched to an answer by id, then by question
    // text, then by position - empty when nothing matched, or when the user
    // declined.
    const questions = requestUserInputQuestions(about.input);
    const answers: { [id: string]: { readonly answers: readonly string[] } } =
      {};
    questions.forEach((question, index) => {
      const given = interviewAnswers ?? [];
      const match =
        given.find((answer) => answer.questionId === question.id) ??
        given.find((answer) => answer.question === question.question) ??
        given[index] ??
        null;
      answers[question.id] = {
        answers: allowed && match !== null ? [...match.values] : [],
      };
    });
    return { answers };
  }
  if (about.toolName === "permissions") {
    const requested =
      about.input !== null && typeof about.input === "object"
        ? Reflect.get(about.input, "permissions")
        : null;
    return {
      permissions:
        allowed && requested !== null && typeof requested === "object"
          ? requested
          : {},
      scope: "turn",
    };
  }
  return { decision: allowed ? "accept" : "decline" };
}

function requestUserInputQuestions(
  input: unknown,
): readonly { readonly id: string; readonly question: string }[] {
  if (input === null || typeof input !== "object") {
    return [];
  }
  const questions = Reflect.get(input, "questions");
  if (!Array.isArray(questions)) {
    return [];
  }
  return questions.flatMap((question: unknown) => {
    if (question === null || typeof question !== "object") {
      return [];
    }
    const id = Reflect.get(question, "id");
    const text = Reflect.get(question, "question");
    return typeof id === "string" && typeof text === "string"
      ? [{ id, question: text }]
      : [];
  });
}

export class GuiRunRegistry {
  private readonly runs = new Map<string, ChildProcess>();
  /** How each run's permission answers are written: Claude's control frames or Codex's JSON-RPC results. */
  private readonly channels = new Map<string, "claude" | "codex">();
  /** How a follow-up is handed to each running turn - see `steer`. */
  private readonly steerers = new Map<
    string,
    (text: string) => Promise<string | null>
  >();
  /** Open permission questions per chat, answered by the GUI or abandoned at turn end. */
  private readonly approvals = new Map<string, Map<string, PendingApproval>>();
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

  addApproval(agentId: string, pending: PendingApproval): void {
    const open =
      this.approvals.get(agentId) ?? new Map<string, PendingApproval>();
    open.set(pending.approvalId, pending);
    this.approvals.set(agentId, open);
  }

  takeApproval(agentId: string, approvalId: string): PendingApproval | null {
    const open = this.approvals.get(agentId);
    const pending = open?.get(approvalId) ?? null;
    if (open !== undefined && pending !== null) {
      open.delete(approvalId);
    }
    return pending;
  }

  takeAllApprovals(agentId: string): readonly PendingApproval[] {
    const open = this.approvals.get(agentId);
    this.approvals.delete(agentId);
    return open === undefined ? [] : [...open.values()];
  }

  approvalsOf(agentId: string): readonly PendingApproval[] {
    return [...(this.approvals.get(agentId)?.values() ?? [])];
  }

  /**
   * Answer one of the child's permission requests on its stdin. False when
   * there is no child to answer - the run ended while the question was open.
   */
  answerPermission(
    agentId: string,
    requestId: string,
    response:
      | {
          readonly behavior: "allow";
          readonly updatedInput: unknown;
          /** The user's answers when the question was an interview; null otherwise. */
          readonly interviewAnswers: readonly InterviewAnswerValues[] | null;
        }
      | { readonly behavior: "deny"; readonly message: string },
    /** What was asked, for the channels whose answer shape depends on it. */
    about: { readonly toolName: string; readonly input: unknown },
  ): boolean {
    const child = this.runs.get(agentId);
    if (child === undefined || child.stdin === null || !child.stdin.writable) {
      return false;
    }
    if (this.channels.get(agentId) === "codex") {
      // The JSON-RPC id, quoted back exactly as it came - a number or a string.
      const id: unknown = JSON.parse(requestId);
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: codexApprovalResult(
            response.behavior === "allow",
            about,
            response.behavior === "allow" ? response.interviewAnswers : null,
          ),
        })}\n`,
      );
      return true;
    }
    child.stdin.write(
      `${JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: requestId, response },
      })}\n`,
    );
    return true;
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

  set(agentId: string, child: ChildProcess, channel: "claude" | "codex"): void {
    const current = this.runs.get(agentId);
    if (current !== undefined) {
      current.kill("SIGTERM");
    }
    this.runs.set(agentId, child);
    this.channels.set(agentId, channel);
    this.steerers.delete(agentId);
  }

  setSteerer(
    agentId: string,
    steerer: (text: string) => Promise<string | null>,
  ): void {
    this.steerers.set(agentId, steerer);
  }

  /**
   * Hand a follow-up to the running turn, to be taken at its next safe
   * point. Null once delivered; otherwise why the turn could not take it -
   * it has no channel for one, or its input already closed - and the item
   * waits for the next turn instead.
   */
  steer(agentId: string, text: string): Promise<string | null> {
    const steerer = this.steerers.get(agentId);
    return steerer === undefined
      ? Promise.resolve(STEER_UNSUPPORTED)
      : steerer(text);
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
  const channel: "claude" | "codex" | null =
    input.harnessId === "claude"
      ? "claude"
      : input.harnessId === "codex"
        ? "codex"
        : null;
  const stdioPrompt = channel !== null;
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(binaryPath, args, {
        cwd: input.cwd,
        env: spawnEnvForProvider(runtime.store, providerId),
        stdio: [stdioPrompt ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    runtime.guiRuns.set(input.agentId, child, channel ?? "claude");
    // A child that exits before reading its prompt makes the write an EPIPE,
    // which is the close handler's story to tell - not an unhandled stream
    // error's.
    child.stdin?.on("error", () => undefined);
    // Late-bound on purpose: the driver's own events - the session it opened,
    // an error answering one of its requests - must take the same door every
    // other event takes, `emit` below, which is what ends the run on a fault.
    const codex =
      channel === "codex"
        ? codexDriver(child, { ...input, onEvent: (event) => emit(event) })
        : null;
    codex?.start();
    if (codex !== null) {
      runtime.guiRuns.setSteerer(input.agentId, (text) => codex.steer(text));
    }
    if (channel === "claude" && child.stdin !== null) {
      // The prompt, as the user record the stream-json input format takes.
      // Stdin stays open after it: the permission answers ride the same pipe,
      // and the run does not end until it closes - see the `result` handling
      // below.
      const stdin = child.stdin;
      const userRecord = (text: string): string =>
        `${JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "text", text }] },
        })}\n`;
      stdin.write(userRecord(input.prompt));
      // A second user record before the `result` is same-turn steering:
      // recorded live, the CLI took it at the next tool boundary and answered
      // both in one `result` (`num_turns: 2`). It is not echoed back, so
      // delivery is the write itself; once stdin has ended there is no turn
      // left to steer.
      runtime.guiRuns.setSteerer(input.agentId, (text) => {
        if (!stdin.writable) {
          return Promise.resolve(
            "Claude reached the end of the active turn before this follow-up could be steered.",
          );
        }
        stdin.write(userRecord(text));
        return Promise.resolve(null);
      });
    }
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
    let turnFault: string | null = null;
    let flushTimer: NodeJS.Timeout | null = null;
    const emit = (event: ProviderStreamEvent): void => {
      if (event.kind === "delta") {
        if (event.text.length === 0) {
          return;
        }
        streamed += event.text;
      }
      if (event.kind === "permission_request") {
        // The CLI is now waiting on a person. A deadline that kept running
        // would file their thinking time as a hang; it re-arms on the next
        // line the CLI writes, which is the first thing it does once answered.
        disarmDeadline();
      }
      if (event.kind === "usage" && channel === "claude") {
        // `usage` rides the `result` record, which is the turn's end. With
        // stdin open the CLI would wait for a next turn; closing it is what
        // lets the process exit and the run settle.
        child.stdin?.end();
      }
      if (event.kind === "turn_end") {
        // Codex's end of turn. A failed turn is a failed run: the reply text
        // so far is not an answer, and the close handler says why.
        if (event.status === "failed" || event.status === "interrupted") {
          turnFault = `Codex turn ${event.status}${event.error === null ? "" : `: ${event.error}`}`;
        }
        child.stdin?.end();
        return;
      }
      if (event.kind === "transport_error") {
        turnFault = event.message;
        child.stdin?.end();
        return;
      }
      if (event.kind === "rpc_unsupported") {
        codex?.refuse(event.requestId, event.method);
        return;
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
      if (timer === null) {
        armDeadline();
      }
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
      if (codex?.consumeResponse(line) === true) {
        return;
      }
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
    let timer: NodeJS.Timeout | null = null;
    const armDeadline = (): void => {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer.current = setTimeout(() => {
          child.kill("SIGKILL");
        }, KILL_GRACE_MS);
      }, PRINT_TIMEOUT_MS);
    };
    const disarmDeadline = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    armDeadline();
    const settle = (): void => {
      disarmDeadline();
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
      if (turnFault !== null) {
        reject(new Error(`agent.sendMessage: ${turnFault}`));
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

/**
 * This host's side of the app-server conversation: the three requests that
 * open a turn, and the responses that advance them. Everything the server
 * says on its own is left to the parser.
 *
 * The shape is the released host's: `initialize`, then `thread/start` (or
 * `thread/resume` for a known thread), then `turn/start` with the prompt as
 * a text input, the workspace as cwd and root, `approvalPolicy: "untrusted"`
 * with `approvalsReviewer: "user"` so the server asks and this host answers,
 * and `sandboxPolicy: dangerFullAccess` because the answers ARE the gate.
 */
function codexDriver(
  child: ChildProcess,
  input: {
    readonly prompt: string;
    readonly cwd: string;
    readonly model: string | null;
    readonly sessionId: string | null;
    readonly onEvent: (event: ProviderStreamEvent) => void;
  },
): {
  readonly start: () => void;
  readonly consumeResponse: (line: string) => boolean;
  readonly refuse: (requestId: string, method: string) => void;
  /** `turn/steer` into the running turn; null once taken, else why not. */
  readonly steer: (text: string) => Promise<string | null>;
} {
  let nextId = 0;
  type Pending =
    | { readonly purpose: "initialize" | "thread" | "turn" }
    | {
        readonly purpose: "steer";
        readonly settle: (refusal: string | null) => void;
      };
  const pending = new Map<number, Pending>();
  let threadId: string | null = null;
  let turnId: string | null = null;
  const write = (frame: unknown): boolean => {
    if (child.stdin !== null && child.stdin.writable) {
      child.stdin.write(`${JSON.stringify(frame)}\n`);
      return true;
    }
    return false;
  };
  const send = (entry: Pending, method: string, params: unknown): boolean => {
    nextId += 1;
    pending.set(nextId, entry);
    return write({ jsonrpc: "2.0", id: nextId, method, params });
  };
  const model =
    input.model === null || input.model === "default" ? null : input.model;
  const policy = { approvalPolicy: "untrusted", approvalsReviewer: "user" };
  return {
    start: () => {
      send({ purpose: "initialize" }, "initialize", {
        protocolVersion: "2025-01-01",
        capabilities: { experimentalApi: true },
        clientInfo: { name: "traycer-oss-host", version: "0.1.0" },
      });
    },
    consumeResponse: (line: string): boolean => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return false;
      }
      if (parsed === null || typeof parsed !== "object") {
        return false;
      }
      const id = Reflect.get(parsed, "id");
      if (
        typeof id !== "number" ||
        Reflect.get(parsed, "method") !== undefined
      ) {
        return false;
      }
      const entry = pending.get(id);
      if (entry === undefined) {
        return false;
      }
      pending.delete(id);
      const purpose = entry.purpose;
      const error = Reflect.get(parsed, "error");
      if (error !== null && error !== undefined) {
        const message =
          typeof error === "object" && error !== null
            ? (readStringOf(error, "message") ?? JSON.stringify(error))
            : String(error);
        if (entry.purpose === "steer") {
          // A refused steer is the follow-up's problem, not the turn's: the
          // turn goes on, and the item waits for the next one.
          entry.settle(message);
          return true;
        }
        input.onEvent({
          kind: "transport_error",
          message: `${purpose}: ${message}`,
        });
        return true;
      }
      const result = Reflect.get(parsed, "result");
      if (entry.purpose === "steer") {
        entry.settle(null);
        return true;
      }
      if (purpose === "initialize") {
        send(
          { purpose: "thread" },
          input.sessionId === null ? "thread/start" : "thread/resume",
          {
            ...(input.sessionId === null ? {} : { threadId: input.sessionId }),
            cwd: input.cwd,
            ...(model === null ? {} : { model }),
            ...policy,
          },
        );
        return true;
      }
      if (purpose === "thread") {
        const thread =
          result !== null && typeof result === "object"
            ? Reflect.get(result, "thread")
            : null;
        threadId =
          (thread !== null && typeof thread === "object"
            ? readStringOf(thread, "id")
            : null) ??
          (result !== null && typeof result === "object"
            ? readStringOf(result, "threadId")
            : null) ??
          input.sessionId;
        if (threadId === null) {
          input.onEvent({
            kind: "transport_error",
            message: "thread/start returned no thread id",
          });
          return true;
        }
        input.onEvent({ kind: "session", sessionId: threadId });
        send({ purpose: "turn" }, "turn/start", {
          threadId,
          input: [{ type: "text", text: input.prompt, text_elements: [] }],
          cwd: input.cwd,
          runtimeWorkspaceRoots: [input.cwd],
          ...policy,
          sandboxPolicy: { type: "dangerFullAccess" },
          summary: "auto",
          ...(model === null ? {} : { model }),
        });
        return true;
      }
      // `turn/start` answers with the turn, whose id a steer must quote back.
      const turn =
        result !== null && typeof result === "object"
          ? Reflect.get(result, "turn")
          : null;
      turnId =
        turn !== null && typeof turn === "object"
          ? readStringOf(turn, "id")
          : null;
      return true;
    },
    steer: (text: string): Promise<string | null> => {
      const ended = "The turn ended before this follow-up could be sent.";
      if (threadId === null || turnId === null) {
        return Promise.resolve(ended);
      }
      const activeThread = threadId;
      const activeTurn = turnId;
      return new Promise<string | null>((settle) => {
        const sent = send({ purpose: "steer", settle }, "turn/steer", {
          threadId: activeThread,
          input: [{ type: "text", text, text_elements: [] }],
          expectedTurnId: activeTurn,
        });
        if (!sent) {
          settle(ended);
        }
      });
    },
    refuse: (requestId: string, method: string): void => {
      // An unanswered server request holds the turn open forever; an honest
      // refusal lets the server carry on or fail cleanly. Elicitations have
      // a cancel of their own.
      let id: unknown;
      try {
        id = JSON.parse(requestId);
      } catch {
        return;
      }
      if (method === "mcpServer/elicitation/request") {
        write({ jsonrpc: "2.0", id, result: { action: "cancel" } });
        return;
      }
      write({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `This host does not serve ${method}.`,
        },
      });
    },
  };
}

function readStringOf(record: object, key: string): string | null {
  const value = Reflect.get(record, key);
  return typeof value === "string" && value.length > 0 ? value : null;
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
    // Always `default`, whatever the chat's own mode: the CLI asks over stdio
    // and THIS host answers - allowing everything under `full_access`, asking
    // the user under `supervised` - which is what makes every mode one
    // decision made in one place. `--dangerously-skip-permissions` would make
    // the same decision inside the CLI, out of sight, and only for one mode.
    // `plan` is the one CLI mode this host does run: a `/plan` turn, where
    // the CLI withholds its edit tools and the plan comes back as an
    // `ExitPlanMode` question this host turns into a card.
    args.push(
      "--permission-mode",
      permissionMode === "plan" ? "plan" : "default",
      "--permission-prompt-tool",
      "stdio",
      "--input-format",
      "stream-json",
    );
    if (sessionId !== null) {
      args.push("--resume", sessionId);
    }
    // No prompt here: `--input-format stream-json` reads it from stdin, which
    // is also the channel the permission answers go back on.
    return args;
  }
  if (harnessId === "codex") {
    // The app-server, as the released host runs it. Model, thread, prompt,
    // sandbox and approval policy all ride JSON-RPC on stdin - see
    // `codexDriver` - and the approvals come back the same way, decided by
    // this host under every mode.
    return ["app-server", "--listen", "stdio://"];
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
    line.includes('"method":"item/completed"') ||
    line.includes('"method": "item/completed"')
  );
}

function lineTypeIs(line: string, type: string): boolean {
  return (
    line.includes(`"type":"${type}"`) || line.includes(`"type": "${type}"`)
  );
}
