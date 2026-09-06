import { spawn, type ChildProcess } from "node:child_process";
import type { ProviderId } from "@traycer/protocol/host/provider-ids";
import {
  listProviderCliStates,
  providerCliIdentity,
  spawnEnvForProvider,
} from "./service";
import { PROVIDER_LOGIN_CAPABILITY } from "./login-capability";
import type { HostStore } from "../store/host-store";

const LOGIN_TIMEOUT_MS = 15 * 60_000;

type LoginJob = {
  readonly providerId: ProviderId;
  readonly child: ChildProcess;
  readonly done: Promise<void>;
};

const JOBS = new Map<ProviderId, LoginJob>();

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
  let child: ChildProcess;
  try {
    child = spawn(identity.path, [...oauthArgs], {
      env: spawnEnvForProvider(store, providerId),
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
  } catch {
    return { url: null, started: false, profileId: null };
  }
  const done = new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      JOBS.delete(providerId);
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish();
    }, LOGIN_TIMEOUT_MS);
    child.once("exit", finish);
    child.once("error", finish);
  });
  JOBS.set(providerId, { providerId, child, done });
  return { url: null, started: true, profileId: null };
}

export async function awaitProviderLogin(
  store: HostStore,
  providerId: ProviderId,
): Promise<{
  state: unknown;
  existingProfileId: null;
  codeRejected: false;
}> {
  const job = JOBS.get(providerId);
  if (job !== undefined) {
    await job.done;
  }
  const listed = await listProviderCliStates(store);
  const found = listed.providers.find((row) => row.providerId === providerId);
  return {
    state: found === undefined ? null : found,
    existingProfileId: null,
    codeRejected: false,
  };
}

export function cancelProviderLogin(providerId: ProviderId): boolean {
  const job = JOBS.get(providerId);
  if (job === undefined) {
    return false;
  }
  job.child.kill("SIGTERM");
  JOBS.delete(providerId);
  return true;
}
