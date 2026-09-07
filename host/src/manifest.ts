import {
  SERVES_EVERY_INSTALLED_MAJOR,
  splitConnectionManifest,
  type ConnectionManifest,
  type SplitConnectionManifest,
} from "@traycer/protocol/framework/index";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";

/**
 * Non-floor unary methods this host withdraws from the manifest it advertises,
 * so a client HIDES the control instead of offering one that always fails.
 *
 * Every name here is a mutation this host refuses unconditionally, and every
 * one declares `degrade: { kind: "unsupported" }` on its registry line - the
 * channel a host is meant to use to say it lacks an optional capability. The
 * GUI reads it: the Share / Make private row entry and the sharing panel's
 * master toggle disappear (`use-chat-sharing-support.ts`), and the pack
 * version manager takes itself off screen rather than rendering four buttons
 * whose calls deterministically fail
 * (`PROVIDER_PACK_VERSION_MANAGER_CAPABILITY_METHODS`).
 *
 * READS stay advertised even when the true answer is "nothing here", because
 * an answer is worth more than a hidden affordance -
 * `epic.chatPublicationState` most of all. Withdrawing it would make the fork
 * gate PERMISSIVE: the client reads an unsupported method as "never learned",
 * which by design does not block, and a cross-host fork that cannot work would
 * start instead of being refused with a reason.
 *
 * This is the opposite mechanism from `UNSERVED_STREAM_METHOD_NAMES`, and the
 * asymmetry is in the contracts rather than in taste. A stream is advertised
 * and refused AT SUBSCRIBE because a per-method `INCOMPATIBLE` close is what
 * those contracts document as their degrade path. A unary is withdrawn AT
 * HANDSHAKE because its registry line declares an `unsupported` degrade - a
 * statement the manifest can make and a response cannot. Neither set is a
 * cleanup candidate for the other.
 *
 * Withdrawal alone stops nothing: `dispatchHostRpc` resolves a handler off the
 * REGISTRY, not off the manifest, so a client that asks anyway still reaches
 * the same refusal. What this removes is the control.
 */
export const UNADVERTISED_UNARY_METHOD_NAMES: readonly string[] = [
  "epic.setChatSharingDefault",
  "epic.setCloudChatVisibility",
  "host.notifications.cloudFeed.clear",
  "host.notifications.cloudFeed.clearAll",
  "host.notifications.cloudFeed.markAllRead",
  "host.notifications.cloudFeed.markRead",
  "host.notifications.cloudFeed.resolve",
  "providers.consumeRateLimitResetCredit",
  "providers.ensurePack",
  "providers.installPackVersion",
  "providers.refreshPackDiscovery",
  "providers.removePackVersion",
  "providers.setPackPolicy",
  "providers.usePackVersion",
];

export function hostUnaryManifests(): SplitConnectionManifest {
  const split = splitConnectionManifest(
    hostRpcRegistry,
    RELEASED_FLOOR_METHOD_NAMES,
    SERVES_EVERY_INSTALLED_MAJOR,
  );
  const withdrawn = new Set(UNADVERTISED_UNARY_METHOD_NAMES);
  const optionalManifest: {
    [method: string]: (typeof split.optionalManifest)[string];
  } = {};
  for (const method of Object.keys(split.optionalManifest)) {
    const entry = split.optionalManifest[method];
    if (entry !== undefined && !withdrawn.has(method)) {
      optionalManifest[method] = entry;
    }
  }
  // The FLOOR manifest is handed back whole. It is the half `checkCompatibility`
  // runs against, and a missing member there is a failed handshake rather than
  // a hidden button.
  return { manifest: split.manifest, optionalManifest };
}

/**
 * Streams this host cannot serve, and refuses at subscribe rather than
 * answering with an analog frame.
 *
 * The distinction is not tidiness. An analog frame is built by filling a
 * schema's required fields, so for these methods it necessarily FABRICATES the
 * entity the frame is about - a managed command with a pid, a PR, an artifact
 * doc with an authority epoch, a screencast that started, a worktree deletion
 * in progress, a dictation model that is ready. A client cannot tell those
 * from real ones. A refusal it can: a per-method `INCOMPATIBLE` close is what
 * every one of these contracts documents as its degrade path, and the client
 * keeps its poll or hides the affordance instead of rendering an invention.
 *
 * Streams whose empty frame is TRUE here are deliberately NOT in this set -
 * "no browser sessions", "no PRs", "no communication-graph events" are answers,
 * and refusing them would hide a working surface.
 */
export const UNSERVED_STREAM_METHOD_NAMES: readonly string[] = [
  "browser.screencast",
  "host.communicationGraph.subscribe",
  "host.notifications.cloudFeed.subscribe",
  "managedCommand.subscribeOutput",
  "migration.run",
  "pr.subscribeDetail",
  "speech.dictate",
];

/**
 * Stream methods this OSS host advertises. Concrete lanes send real
 * snapshots; the rest answer with a schema-valid analog snapshot so a GUI
 * that subscribed does not wait forever.
 */
export const OSS_STREAM_METHOD_NAMES: readonly string[] = Object.keys(
  hostStreamRpcRegistry,
);

export function hostStreamManifest(): ConnectionManifest {
  const full = buildStreamManifest(
    hostStreamRpcRegistry,
    SERVES_EVERY_INSTALLED_MAJOR,
  );
  const advertised: { [method: string]: (typeof full)[string] } = {};
  for (const method of OSS_STREAM_METHOD_NAMES) {
    const entry = full[method];
    if (entry !== undefined) {
      advertised[method] = entry;
    }
  }
  return advertised;
}

export function clientStreamManifestOverlap(
  advertised: ConnectionManifest,
  clientManifest: ConnectionManifest,
): ConnectionManifest {
  const overlap: { [method: string]: (typeof advertised)[string] } = {};
  for (const method of Object.keys(advertised)) {
    const entry = clientManifest[method];
    if (entry !== undefined) {
      overlap[method] = entry;
    }
  }
  return overlap;
}
