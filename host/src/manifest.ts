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

export function hostUnaryManifests(): SplitConnectionManifest {
  return splitConnectionManifest(
    hostRpcRegistry,
    RELEASED_FLOOR_METHOD_NAMES,
    SERVES_EVERY_INSTALLED_MAJOR,
  );
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
  "git.streamFileAsset",
  "managedCommand.subscribeOutput",
  "migration.run",
  "pr.subscribeDetail",
  "resources.subscribe",
  "sessionImport.run",
  "sessionImport.scan",
  "speech.dictate",
  "workspace.streamAsset",
  "worktree.deleteBatchByPath",
  "worktree.deleteByPath",
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
