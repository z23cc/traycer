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
 * Stream methods this OSS host actually serves.
 *
 * Advertising the rest of `hostStreamRpcRegistry` (via
 * `SERVES_EVERY_INSTALLED_MAJOR`) makes a GUI treat optional lanes such as
 * `epic.state.subscribe` as supported, then wait forever on snapshots this
 * host never sends. The legacy `epic.subscribe` Y.Doc path is what we
 * implement.
 */
export const OSS_STREAM_METHOD_NAMES: readonly string[] = [
  "agent.activity.subscribe",
  "chat.subscribe",
  "epic.status.subscribe",
  "epic.subscribe",
  "git.subscribeStatus",
  "notifications.subscribe",
  "terminal.subscribe",
];

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
