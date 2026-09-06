import { randomUUID } from "node:crypto";
import type { ShutdownClaimIntent } from "@traycer/protocol/host/lifecycle/schemas";

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
