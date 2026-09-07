import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  hostStopIntentPath,
  isStopIntentWithin,
  parseStopIntent,
} from "@traycer/protocol/config/host-stop-intent";
import type { FatalErrorDetails } from "@traycer/protocol/framework/index";
import type { ShutdownClaimIntent } from "@traycer/protocol/host/lifecycle/schemas";
import { RESTART_EXIT_CODE } from "@traycer/protocol/host/lifecycle-constants";

/**
 * What the process exits with. Recorded from the released host: a restart
 * exits 87 (the protocol's `RESTART_EXIT_CODE`, which the CLI supervisor
 * relaunches on without delay), a shutdown 0 - and the launchd agent behind
 * the supervisor restarts on a non-zero exit only
 * (`KeepAlive.SuccessfulExit = false`), so the code is the whole difference
 * between coming back and staying down.
 */
export { RESTART_EXIT_CODE };

export function exitCodeForShutdownIntent(intent: ShutdownClaimIntent): number {
  return intent === "restart" ? RESTART_EXIT_CODE : 0;
}

/** A restart claim's lease, and the most a claim may ask for (released: 300 s). */
export const SHUTDOWN_CLAIM_MAX_TTL_MS = 300_000;
/** How long teardown may take before the process is exited regardless. */
export const SHUTDOWN_FORCE_EXIT_MS = 30_000;
/** How long the tombstone is good for, as the released host stamps it. */
const RESTART_TOMBSTONE_TTL_MS = 60_000;
/** A CLI stop-intent older than this is somebody else's, not this shutdown's. */
const STOP_INTENT_FRESH_MS = 30_000;

/**
 * The frame every stream client gets before a restart tears its socket
 * down, so it waits for the host to come back instead of bouncing. The
 * released host's, field for field.
 */
export function restartTombstone(now: number): FatalErrorDetails {
  return {
    code: "HOST_RESTARTING",
    reason: "The host is restarting and expects to be back shortly",
    incompatibleMethods: null,
    upgradeGuidance: null,
    retryable: true,
    restartIntent: {
      tombstoneId: randomUUID(),
      expiresAt: now + RESTART_TOMBSTONE_TTL_MS,
    },
  };
}

/**
 * Whether a SIGTERM is the CLI's `host restart` rather than a plain stop:
 * the CLI writes `stop-intent.json` beside the host's data before it signals,
 * and a fresh one naming a restart is what earns the tombstone. Anything
 * else - no file, another reason, too old - is a final shutdown.
 */
export async function hasExternalRestartIntent(
  dataDir: string,
  now: number,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(hostStopIntentPath(dataDir), "utf8");
  } catch {
    return false;
  }
  try {
    const intent = parseStopIntent(JSON.parse(raw));
    return (
      intent !== null &&
      intent.reason === "restart" &&
      isStopIntentWithin(intent, now, STOP_INTENT_FRESH_MS)
    );
  } catch {
    return false;
  }
}

/**
 * The cooperative shutdown claim `traycer host stop|restart` takes before it
 * asks this process to exit.
 *
 * Mutual exclusion is the whole point: two coordinators racing the same host
 * is what the claim exists to prevent, so a live claim held by one transition
 * denies every other one as `busy` until it commits, is released, or expires.
 * Re-claiming under the SAME `transitionId` regrants the same token, because a
 * retried dial is one transition, not two.
 */
export type ShutdownClaim = {
  readonly token: string;
  readonly transitionId: string;
  readonly intent: ShutdownClaimIntent;
  readonly expiresAt: number;
};

export class ShutdownCoordinator {
  private claim: ShutdownClaim | null = null;

  /** The live claim, or `null` once it has expired. */
  current(now: number): ShutdownClaim | null {
    if (this.claim !== null && this.claim.expiresAt <= now) {
      this.claim = null;
    }
    return this.claim;
  }

  claimFor(
    transitionId: string,
    ttl: number,
    intent: ShutdownClaimIntent,
    now: number,
  ): ShutdownClaim | null {
    const live = this.current(now);
    if (live !== null && live.transitionId !== transitionId) {
      return null;
    }
    const granted: ShutdownClaim = {
      token: live === null ? randomUUID() : live.token,
      transitionId,
      intent,
      expiresAt: now + ttl,
    };
    this.claim = granted;
    return granted;
  }

  /** Takes the claim out of the coordinator, so a commit cannot run twice. */
  take(token: string, now: number): ShutdownClaim | null {
    const live = this.current(now);
    if (live === null || live.token !== token) {
      return null;
    }
    this.claim = null;
    return live;
  }
}
