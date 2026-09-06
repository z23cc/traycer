import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  diagnosticsLogsTailRequestSchema,
  type DiagnosticsLogTarget,
} from "@traycer/protocol/host/diagnostics/schemas";
import {
  doctorTriviallyGreenIssueCodesForVantage,
  hostDoctorIssueSchema,
} from "@traycer/protocol/host/maintenance/schemas";
import { z } from "zod";
import { readCliInvocation } from "../../cli-invocation";
import type { HostRuntime } from "../../runtime";
import type { RpcHandler } from "./types";

/** Desktop's established tail window; the host clamps rather than trusts. */
const MIN_TAIL_LINES = 1;
const MAX_TAIL_LINES = 500;
/** A doctor sweep probes ports and processes; past this it is not answering. */
const DOCTOR_TIMEOUT_MS = 30_000;
const DOCTOR_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function hostLogPath(runtime: HostRuntime): string {
  return join(runtime.dataDir, "host.log");
}

/**
 * `~/.traycer/cli/cli.log`. The host resolves the SHARED CLI surface and not
 * a slot-nested one on purpose: it knows its own data dir, never the
 * environment label the CLI nests under, and inventing one would name a file
 * that is not this machine's CLI log.
 */
function cliLogPath(): string {
  return join(homedir(), ".traycer", "cli", "cli.log");
}

export const handleDiagnosticsLogsList: RpcHandler = (_params, runtime) => ({
  ok: true,
  result: {
    logs: [
      { target: "host", label: "Host", path: hostLogPath(runtime) },
      { target: "cli", label: "CLI", path: cliLogPath() },
    ],
  },
});

export const handleDiagnosticsLogsTail: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = diagnosticsLogsTailRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const target: DiagnosticsLogTarget = parsed.data.target;
  const requested = Math.trunc(parsed.data.tailLines);
  const tailLines = Math.min(
    MAX_TAIL_LINES,
    Math.max(MIN_TAIL_LINES, Number.isFinite(requested) ? requested : 0),
  );
  const path = target === "host" ? hostLogPath(runtime) : cliLogPath();
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    // Only the CLI log can be genuinely absent. This host is running, so an
    // unwritten host log means "nothing logged yet" - an empty tail.
    if (target === "cli") {
      return {
        ok: true,
        result: { status: "unavailable", target: "cli", reason: "missing" },
      };
    }
    return {
      ok: true,
      result: {
        status: "available",
        target,
        path,
        lines: [],
        truncated: false,
      },
    };
  }
  const all = content.split("\n");
  if (all.length > 0 && all[all.length - 1] === "") {
    all.pop();
  }
  const lines = all.slice(Math.max(0, all.length - tailLines));
  return {
    ok: true,
    result: {
      status: "available",
      target,
      path,
      lines,
      truncated: lines.length < all.length,
    },
  };
};

const doctorOutputSchema = z.object({
  issues: z.array(hostDoctorIssueSchema),
});

/**
 * The doctor engine lives in the CLI, which the host spawns rather than
 * imports. Without a recorded invocation vector there is no CLI to run, and
 * `cli-unavailable` is the answer - never an empty `ok`, which would report a
 * host as diagnosed and healthy when nothing diagnosed it.
 *
 * `triviallyGreenIssueCodes` is the local-WebSocket set: this call arrived on
 * the loopback listener the codes are about, which is the proof they need.
 */
export const handleHostDoctor: RpcHandler = async (_params, runtime) => {
  const invocation = await readCliInvocation(runtime.dataDir);
  if (invocation === null) {
    return { ok: true, result: { status: "cli-unavailable" } };
  }
  const run = await runCli(invocation.command, [
    ...invocation.args,
    "host",
    "doctor",
    "--json",
  ]);
  if (run.status === "spawn-failed") {
    return { ok: true, result: { status: "cli-unavailable" } };
  }
  if (run.status === "failed") {
    return { ok: true, result: { status: "cli-failed" } };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(run.stdout);
  } catch {
    return { ok: true, result: { status: "invalid-output" } };
  }
  const report = doctorOutputSchema.safeParse(payload);
  if (!report.success) {
    return { ok: true, result: { status: "invalid-output" } };
  }
  return {
    ok: true,
    result: {
      status: "ok",
      issues: report.data.issues,
      triviallyGreenIssueCodes: [
        ...doctorTriviallyGreenIssueCodesForVantage("local-ws"),
      ],
    },
  };
};

type CliRun =
  | { readonly status: "spawn-failed" }
  | { readonly status: "failed" }
  | { readonly status: "ok"; readonly stdout: string };

/**
 * `traycer host doctor` exits non-zero when it FINDS something, so the exit
 * code is a report, not a failure - only a signal, a timeout or unparseable
 * output is one.
 */
function runCli(command: string, args: readonly string[]): Promise<CliRun> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let settled = false;
    const settle = (run: CliRun): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(run);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ status: "failed" });
    }, DOCTOR_TIMEOUT_MS);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length <= DOCTOR_MAX_OUTPUT_BYTES) {
        stdout += chunk.toString("utf8");
      }
    });
    child.on("error", () => {
      settle({ status: "spawn-failed" });
    });
    child.on("close", (code, signal) => {
      settle(
        signal === null && code !== null
          ? { status: "ok", stdout }
          : { status: "failed" },
      );
    });
  });
}
