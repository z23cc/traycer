import {
  isStrictSemVer,
  isValidCompatibilityEpoch,
  type ClientCompatibilityRequirement,
  type ClientHandshakeIdentity,
} from "@traycer/protocol/framework/index";
import {
  HOST_MINIMUM_COMPATIBILITY_EPOCH,
  HOST_RELEASE_CHANNEL,
} from "./version";

export function evaluateClientEpoch(
  identity: ClientHandshakeIdentity | undefined,
): ClientCompatibilityRequirement | null {
  const observedKind =
    identity !== undefined && typeof identity.kind === "string"
      ? identity.kind
      : null;
  const appVersion =
    identity !== undefined && typeof identity.appVersion === "string"
      ? identity.appVersion
      : null;
  const appVersionStatus =
    appVersion === null
      ? "missing"
      : isStrictSemVer(appVersion)
        ? "valid"
        : "invalid";
  const observedEpoch =
    identity !== undefined && typeof identity.compatibilityEpoch === "number"
      ? identity.compatibilityEpoch
      : null;

  if (observedEpoch === null) {
    return makeRequirement("missing-epoch", null, {
      observedKind,
      appVersion,
      appVersionStatus,
    });
  }
  if (!isValidCompatibilityEpoch(observedEpoch)) {
    return makeRequirement("invalid-epoch", observedEpoch, {
      observedKind,
      appVersion,
      appVersionStatus,
    });
  }
  if (observedEpoch < HOST_MINIMUM_COMPATIBILITY_EPOCH) {
    return makeRequirement("below-minimum", observedEpoch, {
      observedKind,
      appVersion,
      appVersionStatus,
    });
  }
  return null;
}

function makeRequirement(
  failure: ClientCompatibilityRequirement["failure"],
  observedEpoch: number | null,
  diagnostics: {
    readonly observedKind: string | null;
    readonly appVersion: string | null;
    readonly appVersionStatus: "valid" | "missing" | "invalid";
  },
): ClientCompatibilityRequirement {
  return {
    minimumCompatibilityEpoch: HOST_MINIMUM_COMPATIBILITY_EPOCH,
    observedCompatibilityEpoch: observedEpoch,
    failure,
    observedClientKind: diagnostics.observedKind,
    observedClientAppVersion: diagnostics.appVersion,
    observedClientAppVersionStatus: diagnostics.appVersionStatus,
    minimumKnownClientAppVersion: null,
    upgradeChannel: null,
    hostReleaseChannel: HOST_RELEASE_CHANNEL,
  };
}

export function epochRejectionReason(
  requirement: ClientCompatibilityRequirement,
): string {
  if (requirement.failure === "missing-epoch") {
    return "This Traycer client is too old for this host. Update the app and retry.";
  }
  if (requirement.failure === "invalid-epoch") {
    return "This Traycer client sent an invalid compatibility epoch. Update the app and retry.";
  }
  return "This Traycer client is too old for this host. Update the app and retry.";
}
