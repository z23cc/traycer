import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  TurnCheckpointManifest,
  TurnCheckpointManifestEntry,
} from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import {
  earliestEntriesByPath,
  isPathInAllowedRoots,
} from "../stream/chat-actions";

const root = "/work/proj";

function manifest(
  checkpointId: string,
  entries: readonly TurnCheckpointManifestEntry[],
): TurnCheckpointManifest {
  return {
    schemaVersion: 1,
    checkpointId,
    capturingUserId: "local",
    capturingHostId: "host",
    allowedRoots: [root],
    workingDirectory: root,
    capturedAt: 1,
    entries: [...entries],
  };
}

function entry(
  filePath: string,
  undoable: boolean,
  artifact: TurnCheckpointManifestEntry["artifact"],
): TurnCheckpointManifestEntry {
  return {
    filePath,
    operation: "edit",
    beforeHash: undoable ? "a".repeat(64) : null,
    afterHash: undoable ? "b".repeat(64) : null,
    undoable,
    reason: undoable ? "snapshot" : "capture_failed",
    artifact,
  };
}

/**
 * A cumulative revert restores each path to its earliest turn, as the
 * released host does - unless that turn could not be undone and a later one
 * can, and a later turn's artifact tag is carried onto an earlier entry.
 */
describe("cumulative revert entries", () => {
  const file = join(root, "a.txt");
  const tag = { artifactId: "art-1", kind: "spec" as const, title: "Spec" };

  it("keeps the earliest entry, upgrading one that could not be undone", () => {
    const first = manifest("t1", [entry(file, true, null)]);
    const second = manifest("t2", [entry(file, true, null)]);
    expect(earliestEntriesByPath([first, second]).get(file)).toEqual({
      manifest: first,
      entry: first.entries[0],
    });
    const failed = manifest("t1", [entry(file, false, null)]);
    expect(earliestEntriesByPath([failed, second]).get(file)).toEqual({
      manifest: second,
      entry: second.entries[0],
    });
  });

  it("carries a later artifact tag onto an untagged earlier entry", () => {
    const first = manifest("t1", [entry(file, true, null)]);
    const second = manifest("t2", [entry(file, true, tag)]);
    expect(earliestEntriesByPath([first, second]).get(file)).toEqual({
      manifest: first,
      entry: { ...first.entries[0], artifact: tag },
    });
    // A tag without an id is no tag; a blank path is no entry.
    const unminted = manifest("t2", [
      entry(file, true, { artifactId: null, kind: null, title: null }),
      entry("", true, tag),
    ]);
    expect(earliestEntriesByPath([first, unminted]).get(file)).toEqual({
      manifest: first,
      entry: first.entries[0],
    });
    expect(earliestEntriesByPath([first, unminted]).has("")).toBe(false);
  });
});

describe("allowed roots", () => {
  it("accepts the root itself and unnormalised paths under it, nothing above", () => {
    expect(isPathInAllowedRoots(root, [root])).toBe(true);
    expect(isPathInAllowedRoots(join(root, "src", "..", "a.txt"), [root])).toBe(
      true,
    );
    expect(isPathInAllowedRoots(`${root}/`, [root])).toBe(true);
    expect(
      isPathInAllowedRoots(join(root, "..", "other", "a.txt"), [root]),
    ).toBe(false);
    expect(isPathInAllowedRoots("/work/projects/a.txt", [root])).toBe(false);
    expect(isPathInAllowedRoots(join(root, "a.txt"), [])).toBe(false);
  });
});
