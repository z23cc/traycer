import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { ProviderId } from "@traycer/protocol/host/provider-ids";
import { PROVIDER_DISPLAY_NAMES } from "@traycer/protocol/host/provider-schemas";
import type { TerminalScope } from "@traycer/protocol/host/terminal/unary-schemas";
import {
  listProviderCliStates,
  providerCliIdentity,
  spawnEnvForProvider,
} from "./service";
import { PROVIDER_LOGIN_CAPABILITY } from "./login-capability";
import type { HostRuntime } from "../runtime";
import type { HostStore } from "../store/host-store";

const LOGIN_HARD_CAP_MS = 15 * 60_000;
const LOGIN_ROLLING_MS = 3 * 60_000;

type LoginJob = {
  readonly providerId: ProviderId;
  readonly child: ChildProcess;
  readonly done: Promise<void>;
  readonly spawnedAt: number;
  readonly codePasteCapable: boolean;
  codeSubmitted: boolean;
  exitCode: number | null;
  killTimer: NodeJS.Timeout;
};

type FinishedLogin = {
  readonly codeSubmitted: boolean;
  readonly exitCode: number | null;
};

const JOBS = new Map<ProviderId, LoginJob>();
const LAST_FINISHED = new Map<ProviderId, FinishedLogin>();
const TERMINAL_LOGIN_SESSIONS = new Map<ProviderId, string>();

export function startProviderLogin(
  store: HostStore,
  providerId: ProviderId,
): { url: string | null; started: boolean; profileId: string | null } {
  const capability = PROVIDER_LOGIN_CAPABILITY[providerId];
  if (capability === null || capability.terminalLogin !== null) {
    return { url: null, started: false, profileId: null };
  }
  const oauthArgs = capability.oauthArgs;
  if (oauthArgs === null || oauthArgs.length === 0) {
    return { url: null, started: false, profileId: null };
  }
  const existing = JOBS.get(providerId);
  if (existing !== undefined) {
    return { url: null, started: true, profileId: null };
  }
  const identity = providerCliIdentity(store, providerId);
  if (identity.path === null) {
    return { url: null, started: false, profileId: null };
  }
  const codePasteCapable = capability.codePaste !== null;
  let child: ChildProcess;
  try {
    child = spawn(identity.path, [...oauthArgs], {
      env: spawnEnvForProvider(store, providerId),
      stdio: codePasteCapable
        ? ["pipe", "ignore", "ignore"]
        : ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
  } catch {
    return { url: null, started: false, profileId: null };
  }
  const spawnedAt = Date.now();
  const jobHolder: { current: LoginJob | null } = { current: null };
  const done = new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      const current = jobHolder.current;
      if (current !== null) {
        clearTimeout(current.killTimer);
        LAST_FINISHED.set(providerId, {
          codeSubmitted: current.codeSubmitted,
          exitCode: current.exitCode,
        });
      }
      JOBS.delete(providerId);
      resolve();
    };
    child.once("exit", (code) => {
      if (jobHolder.current !== null) {
        jobHolder.current.exitCode = code;
      }
      finish();
    });
    child.once("error", () => {
      finish();
    });
  });
  const job: LoginJob = {
    providerId,
    child,
    done,
    spawnedAt,
    codePasteCapable,
    codeSubmitted: false,
    exitCode: null,
    killTimer: setTimeout(() => undefined, LOGIN_ROLLING_MS),
  };
  jobHolder.current = job;
  JOBS.set(providerId, job);
  armDeadline(job);
  return { url: null, started: true, profileId: null };
}

export function submitProviderLoginCode(
  providerId: ProviderId,
  code: string,
): "accepted" | "noActiveLogin" {
  const job = JOBS.get(providerId);
  if (job === undefined || !job.codePasteCapable || job.child.stdin === null) {
    return "noActiveLogin";
  }
  job.child.stdin.write(`${code}\n`);
  job.codeSubmitted = true;
  armDeadline(job);
  return "accepted";
}

export function touchProviderLogin(providerId: ProviderId): boolean {
  const job = JOBS.get(providerId);
  if (job === undefined) {
    return false;
  }
  armDeadline(job);
  return true;
}

export async function awaitProviderLogin(
  store: HostStore,
  providerId: ProviderId,
): Promise<{
  state: unknown;
  existingProfileId: null;
  codeRejected: boolean;
}> {
  const job = JOBS.get(providerId);
  if (job !== undefined) {
    await job.done;
  }
  const finished = LAST_FINISHED.get(providerId);
  const listed = await listProviderCliStates(store, false);
  const found = listed.providers.find((row) => row.providerId === providerId);
  return {
    state: found === undefined ? null : found,
    existingProfileId: null,
    codeRejected:
      finished !== undefined &&
      finished.codeSubmitted &&
      finished.exitCode !== null &&
      finished.exitCode !== 0,
  };
}

export function cancelProviderLogin(providerId: ProviderId): boolean {
  const job = JOBS.get(providerId);
  if (job === undefined) {
    return false;
  }
  job.child.kill("SIGTERM");
  return true;
}

function armDeadline(job: LoginJob): void {
  clearTimeout(job.killTimer);
  const remainingHard = LOGIN_HARD_CAP_MS - (Date.now() - job.spawnedAt);
  if (remainingHard <= 0) {
    job.child.kill("SIGTERM");
    return;
  }
  const wait =
    remainingHard < LOGIN_ROLLING_MS ? remainingHard : LOGIN_ROLLING_MS;
  job.killTimer = setTimeout(() => {
    job.child.kill("SIGTERM");
  }, wait);
}

export type TerminalLoginStart =
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly replacedSessionId: string | null;
    }
  | { readonly ok: false; readonly message: string };

export function startProviderTerminalLogin(
  runtime: HostRuntime,
  providerId: ProviderId,
  scope: TerminalScope,
  cols: number,
  rows: number,
): TerminalLoginStart {
  const capability = PROVIDER_LOGIN_CAPABILITY[providerId];
  const displayName = PROVIDER_DISPLAY_NAMES[providerId];
  if (capability === null || capability.terminalLogin === null) {
    return {
      ok: false,
      message: `${displayName} does not support signing in from a terminal.`,
    };
  }
  const identity = providerCliIdentity(runtime.store, providerId);
  if (identity.path === null) {
    return {
      ok: false,
      message: `${displayName} CLI was not found.`,
    };
  }
  const loginArgs =
    capability.oauthArgs === null ? [] : [...capability.oauthArgs];
  const replacedSessionId = killPredecessorLoginSession(runtime, providerId);
  const sessionId = randomUUID();
  const home = homedir();
  const cwd = home.length > 0 ? home : process.cwd();
  const now = Date.now();
  runtime.terminals.put({
    sessionId,
    scope,
    sessionKind: "terminal",
    cwd,
    currentCwd: cwd,
    shellCommand: identity.path,
    shellArgs: loginArgs,
    cols,
    rows,
    status: "running",
    exitCode: null,
    exitReason: null,
    createdAt: now,
    title: `${displayName} sign-in`,
    activeProcessName: null,
    lifecycleOwner: "manager",
  });
  runtime.pty.spawn({
    sessionId,
    command: identity.path,
    args: loginArgs,
    cwd,
    cols,
    rows,
    extraEnv: extraEnvForTerminalLogin(runtime.store, providerId),
    // A provider login runs the CLI the host resolved, not the user's shell:
    // it takes the login env above and no config-file overrides.
    envOverrides: {},
  });
  TERMINAL_LOGIN_SESSIONS.set(providerId, sessionId);
  return { ok: true, sessionId, replacedSessionId };
}

function killPredecessorLoginSession(
  runtime: HostRuntime,
  providerId: ProviderId,
): string | null {
  const previous = TERMINAL_LOGIN_SESSIONS.get(providerId);
  if (previous === undefined) {
    return null;
  }
  runtime.pty.kill(previous);
  runtime.terminals.kill(previous);
  TERMINAL_LOGIN_SESSIONS.delete(providerId);
  return previous;
}

function extraEnvForTerminalLogin(
  store: HostStore,
  providerId: ProviderId,
): { readonly [key: string]: string } {
  const extra: { [key: string]: string } = {};
  const spawnEnv = spawnEnvForProvider(store, providerId);
  for (const [key, value] of Object.entries(spawnEnv)) {
    if (typeof value === "string" && process.env[key] !== value) {
      extra[key] = value;
    }
  }
  extra.COPILOT_AUTO_UPDATE = "false";
  return extra;
}
