import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { ArtifactRoomManager } from "../artifact-rooms";

describe("ArtifactRoomManager", () => {
  it("discovers metadata-only and artifact-only rooms and retains them", () => {
    const doc = new Y.Doc();
    const metadataRoomIds = new Y.Array<string>();
    const artifacts = new Y.Map<unknown>();
    const artifact = artifactEntry("artifact-1");
    artifact.set("artifactRoomId", "artifact-only-room");
    doc.transact(() => {
      doc.getMap<unknown>("meta").set("artifactRoomIds", metadataRoomIds);
      metadataRoomIds.push(["metadata-only-room"]);
      doc.getMap<unknown>("epic").set("artifacts", artifacts);
      artifacts.set("artifact-1", artifact);
    });
    const manager = new ArtifactRoomManager(doc);

    expect(manager.listRooms().map((room) => room.id)).toEqual([
      "metadata-only-room",
      "artifact-only-room",
    ]);

    doc.transact(() => {
      metadataRoomIds.delete(0, metadataRoomIds.length);
      artifacts.delete("artifact-1");
    });
    expect(manager.listRooms().map((room) => room.id)).toEqual([
      "metadata-only-room",
      "artifact-only-room",
    ]);

    manager.dispose();
    doc.destroy();
  });

  it("repairs roomless metadata while preserving legacy inline bodies", () => {
    const doc = new Y.Doc();
    const artifacts = new Y.Map<unknown>();
    const routed = artifactEntry("artifact-routed");
    const legacyInline = artifactEntry("artifact-inline");
    legacyInline.set("content", new Y.XmlFragment());
    doc.transact(() => {
      doc.getMap<unknown>("epic").set("artifacts", artifacts);
      artifacts.set("artifact-routed", routed);
      artifacts.set("artifact-inline", legacyInline);
    });

    const manager = new ArtifactRoomManager(doc);

    const routedRoomId = routed.get("artifactRoomId");
    expect(routedRoomId).toEqual(expect.any(String));
    expect(String(routedRoomId).length).toBeGreaterThan(0);
    expect(manager.getRoom(String(routedRoomId))).not.toBeNull();
    expect(legacyInline.get("artifactRoomId")).toBe("");
    const metadataRoomIds = doc.getMap<unknown>("meta").get("artifactRoomIds");
    expect(metadataRoomIds).toBeInstanceOf(Y.Array);
    if (!(metadataRoomIds instanceof Y.Array)) {
      throw new Error("Missing artifact room metadata");
    }
    expect(metadataRoomIds.toArray()).toEqual([routedRoomId]);

    manager.dispose();
    doc.destroy();
  });
});

function artifactEntry(artifactId: string): Y.Map<unknown> {
  const artifact = new Y.Map<unknown>();
  artifact.set("id", artifactId);
  artifact.set("kind", "spec");
  artifact.set("title", "Legacy artifact");
  artifact.set("folderName", artifactId);
  artifact.set("parentId", null);
  artifact.set("artifactRoomId", "");
  artifact.set("createdAt", 1);
  artifact.set("updatedAt", 1);
  artifact.set("createdManually", false);
  return artifact;
}
