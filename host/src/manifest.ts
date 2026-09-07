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
 * `UNSERVED_STREAM_METHOD_NAMES` withdraws for the same reason, and the two
 * differ only in what authorizes it. A unary needs the `degrade` field on its
 * registry line, which is what makes the omission legible to a client rather
 * than a hole; a stream has no such field, because streams are
 * intersection-negotiated and non-advertisement IS the mechanism. A stream
 * also refuses at subscribe, since a per-method `INCOMPATIBLE` close is the
 * only answer that channel has; a unary refusal is an ordinary error reply.
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
 * Streams this host neither advertises nor serves.
 *
 * Withdrawn from the advertised manifest first, because that is how a stream
 * says "I do not have this": streams are intersection-negotiated and carry no
 * `degrade` field at all - `pr-contracts.ts` states the rule outright, "a peer
 * lacking these methods simply doesn't advertise them", and
 * `managedCommand.subscribeOutput`'s registry note says the same from the
 * other side ("a host that lacks the managed-command subsystem rejects the
 * open as an unknown method"). The client then hides the affordance rather
 * than opening a subscription that dies.
 *
 * Refused at subscribe as well, for a client that asks anyway: the reject is
 * the per-method `INCOMPATIBLE` close those contracts document. Withdrawal
 * removes the control; the refusal is still the answer.
 *
 * The alternative was an analog snapshot, and it is worse than an empty one:
 * a frame built by filling a schema FABRICATES the entity it is about - a
 * managed command with a pid, a PR, an artifact doc with an authority epoch, a
 * screencast that started, a worktree deletion in progress, a dictation model
 * that is ready. A client cannot tell those from real ones.
 *
 * `browser.sessions` is in this set even though "no browser sessions" sounds
 * like a true empty answer. It is a two-way stream: the client sends
 * `openTab`, `closeTab` and `captureTabPreview` INTO it, so an empty snapshot
 * from a host with no browser subsystem is not an honest nothing, it is a
 * panel that looks live and swallows every click. A stream whose empty frame
 * really is the answer stays served - `pr.subscribeListForEpic` sends one with
 * `sourceStatus: "gh-unavailable"`, which says no sweep ran rather than
 * claiming this epic has no pull requests.
 */
export const UNSERVED_STREAM_METHOD_NAMES: readonly string[] = [
  "browser.screencast",
  "browser.sessions",
  "host.communicationGraph.subscribe",
  "host.notifications.cloudFeed.subscribe",
  "managedCommand.subscribeOutput",
  "migration.run",
  "pr.subscribeDetail",
  "speech.dictate",
];

/**
 * Stream methods this OSS host advertises: every one it actually routes.
 *
 * There is no third category any more. A subscribe that reaches neither a
 * route nor `UNSERVED_STREAM_METHOD_NAMES` is refused rather than answered
 * with a filled-in frame - see `connection.ts`.
 */
export const OSS_STREAM_METHOD_NAMES: readonly string[] = Object.keys(
  hostStreamRpcRegistry,
).filter((method) => !UNSERVED_STREAM_METHOD_NAMES.includes(method));

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
