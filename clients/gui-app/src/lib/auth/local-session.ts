import type { AuthenticatedUser } from "@traycer/protocol/auth";

/**
 * Local-only session for this fork.
 *
 * The official client requires a Traycer-cloud JWT (device-flow login +
 * AuthnV3 validation) before the GUI will leave the sign-in wall. This
 * project talks to a self-hosted Host, so that cloud identity is unused.
 * A stable local bearer is still required: host WebSocket open frames
 * refuse an empty token. The Host can ignore or accept this value.
 */

export const LOCAL_AUTH_BEARER = "local";
export const LOCAL_AUTH_USER_ID = "local-user";

const LOCAL_EPOCH = new Date("2024-01-01T00:00:00.000Z");

let testOverride: boolean | null = null;

/** Test seam. `null` restores the default (off under Vitest, on otherwise). */
export function setLocalAuthEnabledForTests(enabled: boolean | null): void {
  testOverride = enabled;
}

export function isLocalAuthEnabled(): boolean {
  if (testOverride !== null) {
    return testOverride;
  }
  return import.meta.env.MODE !== "test";
}

export function isLocalAuthBearer(token: string | null): boolean {
  return token === LOCAL_AUTH_BEARER;
}

export function createLocalAuthenticatedUser(): AuthenticatedUser {
  return {
    user: {
      id: LOCAL_AUTH_USER_ID,
      name: "Local",
      providerId: "local",
      providerHandle: "local",
      providerType: "EMAIL",
      email: "local@localhost",
      avatarUrl: null,
      activatedAt: LOCAL_EPOCH,
      createdAt: LOCAL_EPOCH,
      updatedAt: LOCAL_EPOCH,
      lastSeenAt: LOCAL_EPOCH,
      privacyMode: false,
      isLearningEnabled: false,
    },
    userSubscription: {
      id: "local-sub",
      userID: LOCAL_AUTH_USER_ID,
      orgID: null,
      teamID: null,
      customerId: "local-cus",
      createdAt: LOCAL_EPOCH,
      updatedAt: LOCAL_EPOCH,
      subscriptionExpiry: null,
      trialEndsAt: null,
      subscriptionStatus: "BYOA_V3",
      hasPaymentMethod: false,
      isInTrial: false,
      rechargeRateSeconds: 0,
    },
    teamSubscriptions: [],
    payAsYouGoUsage: {
      allowPayAsYouGo: false,
    },
  };
}
