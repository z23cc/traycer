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
