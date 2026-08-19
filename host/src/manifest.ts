import { splitConnectionManifest } from "@traycer/protocol/framework/capability-manifest";
import type { SplitConnectionManifest } from "@traycer/protocol/framework/capability-manifest";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-rpc-types";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";

const IMPLEMENTED_OPTIONAL_METHOD_NAMES = [
  "agent.configure",
  "agent.fork",
  "agent.getProviderProfileRateLimits",
  "agent.inbox.ack",
  "agent.listProviderProfiles",
  "epic.getChatRunSettings",
  "epic.setChatArchived",
  "epic.updateChatProfile",
  "epic.updateChatRunSettings",
  "host.notifications.list",
] as const;

export function hostConnectionManifest(): SplitConnectionManifest {
  const split = splitConnectionManifest(
    hostRpcRegistry,
    RELEASED_FLOOR_METHOD_NAMES,
  );
  const optionalManifest: Record<string, SchemaVersion> = {};
  for (const method of IMPLEMENTED_OPTIONAL_METHOD_NAMES) {
    const version = split.optionalManifest[method];
    if (version === undefined) {
      throw new Error(`Missing optional RPC contract for ${method}`);
    }
    optionalManifest[method] = version;
  }
  return {
    manifest: {
      ...split.manifest,
      "agent.list": { major: 6, minor: 0 },
      "git.listChangedFiles": { major: 1, minor: 0 },
      "host.getRateLimitUsage": { major: 3, minor: 0 },
      "workspace.prepareFolders": { major: 1, minor: 0 },
      "worktree.create": { major: 1, minor: 0 },
      "worktree.createPaths": { major: 1, minor: 0 },
      "worktree.listByWorkspacePaths": { major: 1, minor: 3 },
    },
    optionalManifest,
  };
}
