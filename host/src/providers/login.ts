import { spawn, type ChildProcess } from "node:child_process";
import type { ProviderId } from "@traycer/protocol/host/provider-ids";
import {
  listProviderCliStates,
  providerCliIdentity,
  spawnEnvForProvider,
} from "./service";
import { PROVIDER_LOGIN_CAPABILITY } from "./login-capability";
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
  const listed = await listProviderCliStates(store);
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
