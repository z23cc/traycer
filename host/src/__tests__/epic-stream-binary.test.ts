import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import WebSocket, { type RawData } from "ws";
import { splitConnectionManifest } from "@traycer/protocol/framework/capability-manifest";
import {
  hostFrameSchema,
  type HostFrame,
} from "@traycer/protocol/framework/ws-protocol";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  type CreateArtifactRequest,
  type CreateArtifactResponse,
  createArtifactResponseSchema,
  createEpicRequestSchema,
  deleteArtifactResponseSchema,
  deleteChatResponseSchema,
  renameArtifactResponseSchema,
  renameChatResponseSchema,
  reparentArtifactResponseSchema,
  reparentChatResponseSchema,
  setChatArchivedResponseSchema,
  updateArtifactStatusResponseSchema,
  updateEpicResponseSchema,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  epicSubscribeServerFrameSchema,
  type EpicSubscribeServerFrame,
} from "@traycer/protocol/host/epic/subscribe";
import {
  chatSubscribeServerFrameSchema,
  type ChatSubscribeServerFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  artifactBodyFragmentName,
  deletedEpicArtifactSchema,
  epicArtifactSchema,
} from "@traycer/protocol/persistence/epic/artifacts";
import { scriptedTurnRunner } from "../cli-runner";
import { startHostServer, type HostServer } from "../server";

type IncomingFrame =
  | { readonly kind: "text"; readonly value: unknown }
  | { readonly kind: "binary"; readonly value: Uint8Array };

type FramePump = {
  readonly next: () => Promise<IncomingFrame>;
  readonly bufferedCount: () => number;
};

type EpicDirtySnapshot = Extract<
  EpicSubscribeServerFrame,
  { readonly kind: "dirtySnapshot" }
>;

type EpicSnapshot = Extract<
  EpicSubscribeServerFrame,
  { readonly kind: "snapshot" }
>;

type ChatSnapshot = Extract<
  ChatSubscribeServerFrame,
  { readonly kind: "snapshot" }
>;

type EpicSubscription = {
  readonly ws: WebSocket;
  readonly pump: FramePump;
  readonly snapshot: Uint8Array;
  readonly snapshotMeta: EpicSnapshot["meta"];
  readonly initialAwareness: Uint8Array[];
  readonly dirtySnapshot: EpicDirtySnapshot;
};

type RpcConnection = {
  readonly ws: WebSocket;
  readonly pump: FramePump;
};

describe("epic stream binary updates", () => {
  const servers: HostServer[] = [];
  const sockets: WebSocket[] = [];
  const awarenessInstances: Awareness[] = [];

  afterEach(async () => {
    for (const awareness of awarenessInstances.splice(0)) {
      awareness.destroy();
    }
    for (const socket of sockets.splice(0)) {
      socket.close();
    }
    while (servers.length > 0) {
      const server = servers.pop();
      if (server !== undefined) {
        await server.close();
      }
    }
  });

  it("applies a paired Yjs update, echoes it to every subscriber, and includes it in later snapshots", async () => {
    const server = await startHostServer(0, "host-local", {
      runner: scriptedTurnRunner([]),
    });
    servers.push(server);
    seedEpic(server);
    const streamUrl = server.websocketUrl.replace("/rpc", "/stream");
    const first = await subscribeEpic(streamUrl, sockets);
    const second = await subscribeEpic(streamUrl, sockets);

    const edited = new Y.Doc();
    Y.applyUpdate(edited, first.snapshot);
    const beforeEdit = Y.encodeStateVector(edited);
    edited.getMap("epic").set("title", "Edited over binary stream");
    const update = Y.encodeStateAsUpdate(edited, beforeEdit);

    first.ws.send(
      JSON.stringify({
        kind: "applyUpdate",
        epicId: "epic-1",
        hasBinaryPayload: true,
      }),
    );
    first.ws.send(update);

    const sourceEnvelope = expectText(await first.pump.next());
    expect(epicSubscribeServerFrameSchema.parse(sourceEnvelope)).toEqual({
      kind: "update",
      epicId: "epic-1",
      hasBinaryPayload: true,
    });
    const sourceUpdate = expectBinary(await first.pump.next());
    const sourceDoc = new Y.Doc();
    Y.applyUpdate(sourceDoc, first.snapshot);
    Y.applyUpdate(sourceDoc, sourceUpdate);
    expect(sourceDoc.getMap("epic").get("title")).toBe(
      "Edited over binary stream",
    );

    const peerEnvelope = expectText(await second.pump.next());
    expect(epicSubscribeServerFrameSchema.parse(peerEnvelope)).toEqual({
      kind: "update",
      epicId: "epic-1",
      hasBinaryPayload: true,
    });
    const peerUpdate = expectBinary(await second.pump.next());
    const peerDoc = new Y.Doc();
    Y.applyUpdate(peerDoc, second.snapshot);
    Y.applyUpdate(peerDoc, peerUpdate);
    expect(peerDoc.getMap("epic").get("title")).toBe(
      "Edited over binary stream",
    );

    expect(first.pump.bufferedCount()).toBe(0);

    const late = await subscribeEpic(streamUrl, sockets);
    const lateDoc = new Y.Doc();
    Y.applyUpdate(lateDoc, late.snapshot);
    expect(lateDoc.getMap("epic").get("title")).toBe(
      "Edited over binary stream",
    );
    const lateLight = late.snapshotMeta.epicLight;
    if (lateLight === null) {
      throw new Error("Late snapshot did not include epic light metadata");
    }
    expect(lateLight.title).toBe("Edited over binary stream");
  });

  it("closes the host while an epic stream is still connected", async () => {
    const server = await startHostServer(0, "host-local", {
      runner: scriptedTurnRunner([]),
    });
    servers.push(server);
    seedEpic(server);
    const streamUrl = server.websocketUrl.replace("/rpc", "/stream");
    await subscribeEpic(streamUrl, sockets);

    const serverIndex = servers.indexOf(server);
    servers.splice(serverIndex, 1);
    await expect(
      Promise.race([
        server.close().then(() => "closed"),
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("timed-out"), 1_000);
        }),
      ]),
    ).resolves.toBe("closed");
  });

  it("fans awareness out to peers and snapshots it for later subscribers", async () => {
    const server = await startHostServer(0, "host-local", {
      runner: scriptedTurnRunner([]),
    });
    servers.push(server);
    seedEpic(server);
    const streamUrl = server.websocketUrl.replace("/rpc", "/stream");
    const first = await subscribeEpic(streamUrl, sockets);
    const second = await subscribeEpic(streamUrl, sockets);
    const sourceAwareness = trackedAwareness(awarenessInstances);
    sourceAwareness.setLocalState({ user: { name: "Ada" } });
    const update = encodeAwarenessUpdate(sourceAwareness, [
      sourceAwareness.clientID,
    ]);

    first.ws.send(
      JSON.stringify({
        kind: "awareness",
        epicId: "epic-1",
        hasBinaryPayload: true,
      }),
    );
    first.ws.send(update);

    expect(
      epicSubscribeServerFrameSchema.parse(
        expectText(await second.pump.next()),
      ),
    ).toEqual({
      kind: "awareness",
      epicId: "epic-1",
      hasBinaryPayload: true,
    });
    const peerAwareness = trackedAwareness(awarenessInstances);
    applyAwarenessUpdate(
      peerAwareness,
      expectBinary(await second.pump.next()),
      "test",
    );
    expect([...peerAwareness.getStates().values()]).toContainEqual({
      user: { name: "Ada" },
    });
    expect(first.pump.bufferedCount()).toBe(0);

    const late = await subscribeEpic(streamUrl, sockets);
    expect(late.initialAwareness).toHaveLength(1);
    const lateAwareness = trackedAwareness(awarenessInstances);
    applyAwarenessUpdate(lateAwareness, late.initialAwareness[0], "test");
    expect([...lateAwareness.getStates().values()]).toContainEqual({
      user: { name: "Ada" },
    });
  });

  it("does not advertise the host itself as a collaboration peer", async () => {
    const server = await startHostServer(0, "host-local", {
      runner: scriptedTurnRunner([]),
    });
    servers.push(server);
    seedEpic(server);
    seedArtifactRoomReference(server, "artifact-1", "artifact-room-1");
    const epic = server.state.getEpic("epic-1");
    if (epic === null) {
      throw new Error("Missing test epic");
    }
    const room = epic.artifactRooms.getRoom("artifact-room-1");
    if (room === null) {
      throw new Error("Missing test artifact room");
    }

    expect(epic.awareness.getLocalState()).toBeNull();
    expect(room.awareness.getLocalState()).toBeNull();
  });

  it("opens a referenced artifact room and sends its ready snapshot", async () => {
    const server = await startHostServer(0, "host-local", {
      runner: scriptedTurnRunner([]),
    });
    servers.push(server);
    seedEpic(server);
    seedArtifactRoomReference(server, "artifact-1", "artifact-room-1");
    const streamUrl = server.websocketUrl.replace("/rpc", "/stream");
    const subscribed = await subscribeEpic(streamUrl, sockets);

    const room = await receiveArtifactRoomBootstrap(
      subscribed.pump,
      "artifact-room-1",
    );

    expect(Buffer.from(Y.encodeStateVector(room.doc)).toString("base64")).toBe(
      room.hostStateVectorBase64,
    );
  });

  it("echoes an artifact room edit to source and peers and preserves it for late subscribers", async () => {
    const server = await startHostServer(0, "host-local", {
      runner: scriptedTurnRunner([]),
    });
    servers.push(server);
    seedEpic(server);
    seedArtifactRoomReference(server, "artifact-1", "artifact-room-1");
    const streamUrl = server.websocketUrl.replace("/rpc", "/stream");
    const first = await subscribeEpic(streamUrl, sockets);
    const second = await subscribeEpic(streamUrl, sockets);
    const firstRoom = await receiveArtifactRoomBootstrap(
      first.pump,
      "artifact-room-1",
    );
    const secondRoom = await receiveArtifactRoomBootstrap(
      second.pump,
      "artifact-room-1",
    );
    const sourceReplica = cloneDoc(firstRoom.doc);
    const beforeEdit = Y.encodeStateVector(firstRoom.doc);
    const paragraph = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    text.insert(0, "Artifact body over stream");
    paragraph.insert(0, [text]);
    firstRoom.doc
      .getXmlFragment(artifactBodyFragmentName("artifact-1"))
      .insert(0, [paragraph]);
    const update = Y.encodeStateAsUpdate(firstRoom.doc, beforeEdit);

    first.ws.send(
      JSON.stringify({
        kind: "artifactRoomApplyUpdate",
        epicId: "epic-1",
        artifactRoomId: "artifact-room-1",
        hasBinaryPayload: true,
      }),
    );
    first.ws.send(update);

    const sourceUpdate = await receiveArtifactRoomUpdate(
      first.pump,
      "artifact-room-1",
      sourceReplica,
    );
    const peerUpdate = await receiveArtifactRoomUpdate(
      second.pump,
      "artifact-room-1",
      secondRoom.doc,
    );
    expect(artifactRoomText(sourceUpdate.doc, "artifact-1")).toContain(
      "Artifact body over stream",
    );
    expect(artifactRoomText(peerUpdate.doc, "artifact-1")).toContain(
      "Artifact body over stream",
    );

    const late = await subscribeEpic(streamUrl, sockets);
    const lateRoom = await receiveArtifactRoomBootstrap(
      late.pump,
      "artifact-room-1",
    );
    expect(artifactRoomText(lateRoom.doc, "artifact-1")).toContain(
      "Artifact body over stream",
    );
  });

  it("fans artifact room awareness to peers without echoing the source", async () => {
    const server = await startHostServer(0, "host-local", {
      runner: scriptedTurnRunner([]),
    });
    servers.push(server);
    seedEpic(server);
    seedArtifactRoomReference(server, "artifact-1", "artifact-room-1");
    const streamUrl = server.websocketUrl.replace("/rpc", "/stream");
    const first = await subscribeEpic(streamUrl, sockets);
    const second = await subscribeEpic(streamUrl, sockets);
    await receiveArtifactRoomBootstrap(first.pump, "artifact-room-1");
    await receiveArtifactRoomBootstrap(second.pump, "artifact-room-1");
    const sourceAwareness = trackedAwareness(awarenessInstances);
    sourceAwareness.setLocalState({ cursor: { anchor: 4, head: 4 } });

    first.ws.send(
      JSON.stringify({
        kind: "artifactRoomAwareness",
        epicId: "epic-1",
        artifactRoomId: "artifact-room-1",
        hasBinaryPayload: true,
      }),
    );
    first.ws.send(
      encodeAwarenessUpdate(sourceAwareness, [sourceAwareness.clientID]),
    );

    expect(
      epicSubscribeServerFrameSchema.parse(
        expectText(await second.pump.next()),
      ),
    ).toEqual({
      kind: "artifactRoomAwareness",
      epicId: "epic-1",
      artifactRoomId: "artifact-room-1",
      hasBinaryPayload: true,
    });
    const peerAwareness = trackedAwareness(awarenessInstances);
    applyAwarenessUpdate(
      peerAwareness,
      expectBinary(await second.pump.next()),
      "test",
    );
    expect([...peerAwareness.getStates().values()]).toContainEqual({
      cursor: { anchor: 4, head: 4 },
    });
    expect(first.pump.bufferedCount()).toBe(0);
  });

  it("lists every live artifact room as clean in the v1.1 dirty snapshot", async () => {
    const server = await startHostServer(0, "host-local", {
      runner: scriptedTurnRunner([]),
    });
    servers.push(server);
    seedEpic(server);
    seedArtifactRoomReference(server, "artifact-1", "artifact-room-1");
    const streamUrl = server.websocketUrl.replace("/rpc", "/stream");

    const subscribed = await subscribeEpic(streamUrl, sockets);

    expect(subscribed.dirtySnapshot).toEqual({
      kind: "dirtySnapshot",
      epicId: "epic-1",
      rootDirty: false,
      rooms: [{ artifactRoomId: "artifact-room-1", dirty: false }],
      hasBinaryPayload: false,
    });
  });

  it("creates an artifact through RPC and publishes its canonical root entry and room", async () => {
    const server = await startHostServer(0, "host-local", {
      runner: scriptedTurnRunner([]),
    });
    servers.push(server);
    const publicEpic = await createPublicEpic(server, sockets);
    const createdArtifactFrame = await rpcRequest(
      publicEpic.rpc.ws,
      publicEpic.rpc.pump,
      "create-artifact",
      "epic.createArtifact",
      { major: 1, minor: 0 },
      {
        epicId: "epic-1",
        parentId: null,
        artifactType: "spec",
        title: "New spec",
      },
    );
    if (createdArtifactFrame.kind !== "response") {
      throw new Error("Expected createArtifact response");
    }
    expect(createdArtifactFrame.error).toBeNull();
    const createdArtifact = createArtifactResponseSchema.parse(
      createdArtifactFrame.result,
    );
    expect(createdArtifact.artifactId.length).toBeGreaterThan(0);

    const published = await receiveCreatedArtifact(
      publicEpic.subscription.pump,
      publicEpic.subscription.snapshot,
      createdArtifact.artifactId,
    );
    const parsedArtifact = epicArtifactSchema.parse(published.entry.toJSON());
    expect(parsedArtifact).toMatchObject({
      id: createdArtifact.artifactId,
      kind: "spec",
      folderName: "new-spec",
      title: "New spec",
      parentId: null,
      createdManually: true,
      artifactRoomId: published.roomId,
    });
    expect(published.entry.has("content")).toBe(false);
    expect(published.metaRoomIds).toContain(published.roomId);
    expect(
      Buffer.from(Y.encodeStateVector(published.roomDoc)).toString("base64"),
    ).toBe(published.hostStateVectorBase64);
  });

  it("updates the epic title through RPC and publishes the root change", async () => {
    const server = await startHostServer(0, "host-local", {
      runner: scriptedTurnRunner([]),
    });
    servers.push(server);
    const publicEpic = await createPublicEpic(server, sockets);
    const updatedAt = Date.now() + 500;
    const titleFrame = await rpcRequest(
      publicEpic.rpc.ws,
      publicEpic.rpc.pump,
      "update-epic-title",
      "epic.updateTitle",
      { major: 1, minor: 0 },
      {
        epicDelta: {
          id: "epic-1",
          title: "Renamed over public RPC",
          updatedAt,
        },
      },
    );
    if (titleFrame.kind !== "response") {
      throw new Error("Expected updateTitle response");
    }
    expect(updateEpicResponseSchema.parse(titleFrame.result)).toEqual({
      updated: true,
    });
    const rootDoc = new Y.Doc();
    Y.applyUpdate(rootDoc, publicEpic.subscription.snapshot);
    await applyRootUpdatesUntil(
      publicEpic.subscription.pump,
      rootDoc,
      () => rootDoc.getMap("epic").get("title") === "Renamed over public RPC",
    );
    expect(rootDoc.getMap("epic").toJSON()).toMatchObject({
      title: "Renamed over public RPC",
      isTitleEditedByUser: true,
      updatedAt,
    });
    const late = await subscribeEpic(
      server.websocketUrl.replace("/rpc", "/stream"),
      sockets,
    );
    expect(late.snapshotMeta.epicLight).toMatchObject({
      title: "Renamed over public RPC",
      updatedAt,
    });
  });

  it("publishes chat mutations and reconciles a GUI-style stream reparent", async () => {
    const server = await startHostServer(0, "host-local", {
      runner: scriptedTurnRunner([]),
    });
    servers.push(server);
    const publicEpic = await createPublicEpic(server, sockets);
    await createChatViaRpc(publicEpic.rpc, "create-parent-chat", {
      chatId: "parent-chat",
      parentId: null,
      title: "Parent chat",
    });
    await createChatViaRpc(publicEpic.rpc, "create-child-chat", {
      chatId: "child-chat",
      parentId: "parent-chat",
      title: "Child chat",
    });
    const rootDoc = new Y.Doc();
    Y.applyUpdate(rootDoc, publicEpic.subscription.snapshot);
    await applyRootUpdatesUntil(
      publicEpic.subscription.pump,
      rootDoc,
      () =>
        chatEntry(rootDoc, "parent-chat") !== null &&
        chatEntry(rootDoc, "child-chat") !== null,
    );

    const renameFrame = await rpcRequest(
      publicEpic.rpc.ws,
      publicEpic.rpc.pump,
      "rename-child-chat",
      "epic.renameChat",
      { major: 1, minor: 0 },
      {
        epicId: "epic-1",
        chatId: "child-chat",
        title: "Renamed child chat",
      },
    );
    if (renameFrame.kind !== "response") {
      throw new Error("Expected renameChat response");
    }
    expect(renameChatResponseSchema.parse(renameFrame.result)).toEqual({
      updated: true,
    });
    await applyRootUpdatesUntil(
      publicEpic.subscription.pump,
      rootDoc,
      () =>
        chatEntry(rootDoc, "child-chat")?.get("title") === "Renamed child chat",
    );
    expect(chatEntry(rootDoc, "child-chat")?.toJSON()).toMatchObject({
      title: "Renamed child chat",
      isTitleEditedByUser: true,
    });

    const reparentFrame = await rpcRequest(
      publicEpic.rpc.ws,
      publicEpic.rpc.pump,
      "reparent-child-chat",
      "epic.reparentChat",
      { major: 1, minor: 0 },
      { epicId: "epic-1", chatId: "child-chat", newParentId: null },
    );
    if (reparentFrame.kind !== "response") {
      throw new Error("Expected reparentChat response");
    }
    expect(reparentChatResponseSchema.parse(reparentFrame.result)).toEqual({
      updated: true,
    });
    await applyRootUpdatesUntil(
      publicEpic.subscription.pump,
      rootDoc,
      () => chatEntry(rootDoc, "child-chat")?.get("parentId") === null,
    );

    const guiDoc = cloneDoc(rootDoc);
    const beforeGuiReparent = Y.encodeStateVector(guiDoc);
    const guiChild = chatEntry(guiDoc, "child-chat");
    if (guiChild === null) {
      throw new Error("Missing GUI child chat");
    }
    guiChild.set("parentId", "parent-chat");
    guiChild.set("updatedAt", Date.now() + 1_000);
    publicEpic.subscription.ws.send(
      JSON.stringify({
        kind: "applyUpdate",
        epicId: "epic-1",
        hasBinaryPayload: true,
      }),
    );
    publicEpic.subscription.ws.send(
      Y.encodeStateAsUpdate(guiDoc, beforeGuiReparent),
    );
    await applyRootUpdatesUntil(
      publicEpic.subscription.pump,
      rootDoc,
      () => chatEntry(rootDoc, "child-chat")?.get("parentId") === "parent-chat",
    );
    const chatSnapshot = await subscribeChat(
      server.websocketUrl.replace("/rpc", "/stream"),
      sockets,
      "child-chat",
    );
    expect(chatSnapshot.snapshot.chat).toMatchObject({
      id: "child-chat",
      title: "Renamed child chat",
      parentId: "parent-chat",
      isTitleEditedByUser: true,
    });

    const archiveFrame = await rpcRequest(
      publicEpic.rpc.ws,
      publicEpic.rpc.pump,
      "archive-child-chat",
      "epic.setChatArchived",
      { major: 1, minor: 0 },
      { epicId: "epic-1", chatId: "child-chat", archived: true },
    );
    if (archiveFrame.kind !== "response") {
      throw new Error("Expected setChatArchived response");
    }
    expect(setChatArchivedResponseSchema.parse(archiveFrame.result)).toEqual({
      updated: true,
    });
    await applyRootUpdatesUntil(
      publicEpic.subscription.pump,
      rootDoc,
      () =>
        typeof chatEntry(rootDoc, "child-chat")?.get("archivedAt") === "number",
    );
    const archivedSnapshot = await subscribeChat(
      server.websocketUrl.replace("/rpc", "/stream"),
      sockets,
      "child-chat",
    );
    expect(archivedSnapshot.snapshot.chat.archivedAt).toEqual(
      expect.any(Number),
    );

    const deleteFrame = await rpcRequest(
      publicEpic.rpc.ws,
      publicEpic.rpc.pump,
      "delete-parent-chat",
      "epic.deleteChat",
      { major: 1, minor: 0 },
      { epicId: "epic-1", chatId: "parent-chat" },
    );
    if (deleteFrame.kind !== "response") {
      throw new Error("Expected deleteChat response");
    }
    expect(deleteChatResponseSchema.parse(deleteFrame.result)).toEqual({
      deleted: true,
    });
    await applyRootUpdatesUntil(
      publicEpic.subscription.pump,
      rootDoc,
      () => chatEntry(rootDoc, "parent-chat") === null,
    );
    expect(chatEntry(rootDoc, "child-chat")?.get("parentId")).toBe(
      "parent-chat",
    );
  });

  it("archives a terminal-agent record through RPC and the epic stream", async () => {
    const server = await startHostServer(0, "host-local", {
      runner: scriptedTurnRunner([]),
    });
    servers.push(server);
    const publicEpic = await createPublicEpic(server, sockets);
    const storedEpic = server.state.getEpic("epic-1");
    if (storedEpic === null) {
      throw new Error("Missing public epic");
    }
    const tuiAgents = storedEpic.doc.getMap<unknown>("epic").get("tuiAgents");
    if (!(tuiAgents instanceof Y.Map)) {
      throw new Error("Missing terminal-agent map");
    }
    const tuiAgent = new Y.Map<unknown>();
    tuiAgent.set("id", "tui-1");
    tuiAgent.set("hostId", "host-local");
    tuiAgent.set("archivedAt", null);
    tuiAgent.set("updatedAt", 100);
    tuiAgents.set("tui-1", tuiAgent);

    const rootDoc = new Y.Doc();
    Y.applyUpdate(rootDoc, publicEpic.subscription.snapshot);
    await applyRootUpdatesUntil(
      publicEpic.subscription.pump,
      rootDoc,
      () => tuiAgentEntry(rootDoc, "tui-1") !== null,
    );
    const archiveFrame = await rpcRequest(
      publicEpic.rpc.ws,
      publicEpic.rpc.pump,
      "archive-tui",
      "epic.setChatArchived",
      { major: 1, minor: 0 },
      { epicId: "epic-1", chatId: "tui-1", archived: true },
    );
    if (archiveFrame.kind !== "response") {
      throw new Error("Expected terminal-agent archive response");
    }
    expect(setChatArchivedResponseSchema.parse(archiveFrame.result)).toEqual({
      updated: true,
    });
    await applyRootUpdatesUntil(
      publicEpic.subscription.pump,
      rootDoc,
      () =>
        typeof tuiAgentEntry(rootDoc, "tui-1")?.get("archivedAt") === "number",
    );
    expect(tuiAgentEntry(rootDoc, "tui-1")?.get("updatedAt")).toEqual(
      expect.any(Number),
    );

    const late = await subscribeEpic(
      server.websocketUrl.replace("/rpc", "/stream"),
      sockets,
    );
    const lateDoc = new Y.Doc();
    Y.applyUpdate(lateDoc, late.snapshot);
    expect(tuiAgentEntry(lateDoc, "tui-1")?.get("archivedAt")).toEqual(
      expect.any(Number),
    );

    const remoteAgent = new Y.Map<unknown>();
    remoteAgent.set("id", "tui-remote");
    remoteAgent.set("hostId", "host-remote");
    remoteAgent.set("archivedAt", null);
    tuiAgents.set("tui-remote", remoteAgent);
    const remoteFrame = await rpcRequest(
      publicEpic.rpc.ws,
      publicEpic.rpc.pump,
      "archive-remote-tui",
      "epic.setChatArchived",
      { major: 1, minor: 0 },
      { epicId: "epic-1", chatId: "tui-remote", archived: true },
    );
    expect(remoteFrame).toMatchObject({
      kind: "response",
      result: null,
      error: {
        code: "RPC_ERROR",
        message: expect.stringContaining(
          "TARGET_NOT_LOCAL: epic.setChatArchived refused to archive agent 'tui-remote'",
        ),
      },
    });

    const hostlessAgent = new Y.Map<unknown>();
    hostlessAgent.set("id", "tui-hostless");
    hostlessAgent.set("hostId", null);
    hostlessAgent.set("archivedAt", null);
    tuiAgents.set("tui-hostless", hostlessAgent);
    const hostlessFrame = await rpcRequest(
      publicEpic.rpc.ws,
      publicEpic.rpc.pump,
      "archive-hostless-tui",
      "epic.setChatArchived",
      { major: 1, minor: 0 },
      { epicId: "epic-1", chatId: "tui-hostless", archived: true },
    );
    expect(hostlessFrame).toMatchObject({
      kind: "response",
      result: null,
      error: {
        code: "RPC_ERROR",
        message: expect.stringContaining(
          "its record carries no usable host id",
        ),
      },
    });
  });

  it("renames an artifact and updates ticket status through RPC and root updates", async () => {
    const server = await startHostServer(0, "host-local", {
      runner: scriptedTurnRunner([]),
    });
    servers.push(server);
    const publicEpic = await createPublicEpic(server, sockets);
    const createdFrame = await rpcRequest(
      publicEpic.rpc.ws,
      publicEpic.rpc.pump,
      "create-ticket",
      "epic.createArtifact",
      { major: 1, minor: 0 },
      {
        epicId: "epic-1",
        parentId: null,
        artifactType: "ticket",
        title: "Roadmap / Item",
      },
    );
    if (createdFrame.kind !== "response") {
      throw new Error("Expected createArtifact response");
    }
    const created = createArtifactResponseSchema.parse(createdFrame.result);
    const published = await receiveCreatedArtifact(
      publicEpic.subscription.pump,
      publicEpic.subscription.snapshot,
      created.artifactId,
    );
    const createdAt = published.entry.get("createdAt");

    const renamedFrame = await rpcRequest(
      publicEpic.rpc.ws,
      publicEpic.rpc.pump,
      "rename-ticket",
      "epic.renameArtifact",
      { major: 1, minor: 0 },
      {
        epicId: "epic-1",
        artifactId: created.artifactId,
        title: "Renamed ticket",
      },
    );
    if (renamedFrame.kind !== "response") {
      throw new Error("Expected renameArtifact response");
    }
    expect(renameArtifactResponseSchema.parse(renamedFrame.result)).toEqual({
      updated: true,
    });
    const statusFrame = await rpcRequest(
      publicEpic.rpc.ws,
      publicEpic.rpc.pump,
      "status-ticket",
      "epic.updateArtifactStatus",
      { major: 1, minor: 0 },
      {
        epicId: "epic-1",
        artifactId: created.artifactId,
        artifactType: "ticket",
        status: 2,
      },
    );
    if (statusFrame.kind !== "response") {
      throw new Error("Expected updateArtifactStatus response");
    }
    expect(
      updateArtifactStatusResponseSchema.parse(statusFrame.result),
    ).toEqual({ updated: true });

    await applyRootUpdatesUntil(
      publicEpic.subscription.pump,
      published.rootDoc,
      () =>
        published.entry.get("title") === "Renamed ticket" &&
        published.entry.get("status") === 2,
    );
    expect(published.entry.toJSON()).toMatchObject({
      title: "Renamed ticket",
      folderName: "roadmap-item",
      status: 2,
    });
    expect(published.entry.get("updatedAt")).toEqual(expect.any(Number));
    expect(Number(published.entry.get("updatedAt"))).toBeGreaterThanOrEqual(
      Number(createdAt),
    );
  });

  it("reparents an artifact through RPC without changing its stable identity fields", async () => {
    const server = await startHostServer(0, "host-local", {
      runner: scriptedTurnRunner([]),
    });
    servers.push(server);
    const rpc = await openRpc(server.websocketUrl, sockets);
    const createdEpic = await rpcRequest(
      rpc.ws,
      rpc.pump,
      "create-reparent-epic",
      "epic.create",
      { major: 1, minor: 0 },
      epicRequest(),
    );
    expect(createdEpic).toMatchObject({ kind: "response", error: null });
    const firstParent = await createArtifactViaRpc(rpc, "create-first-parent", {
      epicId: "epic-1",
      parentId: null,
      artifactType: "spec",
      title: "First parent",
    });
    const secondParent = await createArtifactViaRpc(
      rpc,
      "create-second-parent",
      {
        epicId: "epic-1",
        parentId: null,
        artifactType: "story",
        title: "Second parent",
      },
    );
    const child = await createArtifactViaRpc(rpc, "create-moved-child", {
      epicId: "epic-1",
      parentId: firstParent.artifactId,
      artifactType: "ticket",
      title: "Moved child",
    });
    const subscription = await subscribeEpic(
      server.websocketUrl.replace("/rpc", "/stream"),
      sockets,
    );
    const rootDoc = new Y.Doc();
    Y.applyUpdate(rootDoc, subscription.snapshot);
    const childEntry = artifactEntry(rootDoc, child.artifactId);
    if (childEntry === null) {
      throw new Error("Missing child artifact");
    }
    const stableFields = {
      kind: childEntry.get("kind"),
      title: childEntry.get("title"),
      folderName: childEntry.get("folderName"),
      status: childEntry.get("status"),
      artifactRoomId: childEntry.get("artifactRoomId"),
    };
    const beforeUpdatedAt = Number(childEntry.get("updatedAt"));

    const reparentedFrame = await rpcRequest(
      rpc.ws,
      rpc.pump,
      "reparent-child",
      "epic.reparentArtifact",
      { major: 1, minor: 0 },
      {
        epicId: "epic-1",
        artifactId: child.artifactId,
        newParentId: secondParent.artifactId,
      },
    );
    if (reparentedFrame.kind !== "response") {
      throw new Error("Expected reparentArtifact response");
    }
    expect(
      reparentArtifactResponseSchema.parse(reparentedFrame.result),
    ).toEqual({ updated: true });
    await applyRootUpdatesUntil(
      subscription.pump,
      rootDoc,
      () => childEntry.get("parentId") === secondParent.artifactId,
    );
    expect(childEntry.toJSON()).toMatchObject({
      ...stableFields,
      parentId: secondParent.artifactId,
    });
    expect(Number(childEntry.get("updatedAt"))).toBeGreaterThanOrEqual(
      beforeUpdatedAt,
    );
  });

  it("deletes an artifact through RPC, publishes a tombstone, and clears its room body", async () => {
    const server = await startHostServer(0, "host-local", {
      runner: scriptedTurnRunner([]),
    });
    servers.push(server);
    const publicEpic = await createPublicEpic(server, sockets);
    const createdFrame = await rpcRequest(
      publicEpic.rpc.ws,
      publicEpic.rpc.pump,
      "create-deleted-spec",
      "epic.createArtifact",
      { major: 1, minor: 0 },
      {
        epicId: "epic-1",
        parentId: null,
        artifactType: "spec",
        title: "Disposable spec",
      },
    );
    if (createdFrame.kind !== "response") {
      throw new Error("Expected createArtifact response");
    }
    const created = createArtifactResponseSchema.parse(createdFrame.result);
    const published = await receiveCreatedArtifact(
      publicEpic.subscription.pump,
      publicEpic.subscription.snapshot,
      created.artifactId,
    );
    const sourceReplica = cloneDoc(published.roomDoc);
    const beforeBody = Y.encodeStateVector(published.roomDoc);
    const bodyText = new Y.XmlText();
    bodyText.insert(0, "Delete this body");
    published.roomDoc
      .getXmlFragment(artifactBodyFragmentName(created.artifactId))
      .insert(0, [bodyText]);
    const bodyUpdate = Y.encodeStateAsUpdate(published.roomDoc, beforeBody);
    publicEpic.subscription.ws.send(
      JSON.stringify({
        kind: "artifactRoomApplyUpdate",
        epicId: "epic-1",
        artifactRoomId: published.roomId,
        hasBinaryPayload: true,
      }),
    );
    publicEpic.subscription.ws.send(bodyUpdate);
    const hostRoom = await receiveArtifactRoomUpdate(
      publicEpic.subscription.pump,
      published.roomId,
      sourceReplica,
    );
    expect(artifactRoomText(hostRoom.doc, created.artifactId)).toContain(
      "Delete this body",
    );

    const deletedFrame = await rpcRequest(
      publicEpic.rpc.ws,
      publicEpic.rpc.pump,
      "delete-spec",
      "epic.deleteArtifact",
      { major: 1, minor: 0 },
      { epicId: "epic-1", artifactId: created.artifactId },
    );
    if (deletedFrame.kind !== "response") {
      throw new Error("Expected deleteArtifact response");
    }
    expect(deleteArtifactResponseSchema.parse(deletedFrame.result)).toEqual({
      deleted: true,
    });

    const tombstone = await receiveArtifactDeletion(
      publicEpic.subscription.pump,
      published.rootDoc,
      hostRoom.doc,
      created.artifactId,
      published.roomId,
    );
    expect(deletedEpicArtifactSchema.parse(tombstone.toJSON())).toMatchObject({
      id: created.artifactId,
      kind: "spec",
      title: "Disposable spec",
      artifactRoomId: published.roomId,
    });
  });

  it("continues an optimistic root deletion by cascading descendants and clearing every body", async () => {
    const server = await startHostServer(0, "host-local", {
      runner: scriptedTurnRunner([]),
    });
    servers.push(server);
    const rpc = await openRpc(server.websocketUrl, sockets);
    const createdEpic = await rpcRequest(
      rpc.ws,
      rpc.pump,
      "create-optimistic-delete-epic",
      "epic.create",
      { major: 1, minor: 0 },
      epicRequest(),
    );
    expect(createdEpic).toMatchObject({ kind: "response", error: null });
    const parent = await createArtifactViaRpc(rpc, "create-delete-parent", {
      epicId: "epic-1",
      parentId: null,
      artifactType: "spec",
      title: "Delete parent",
    });
    const child = await createArtifactViaRpc(rpc, "create-delete-child", {
      epicId: "epic-1",
      parentId: parent.artifactId,
      artifactType: "ticket",
      title: "Delete child",
    });
    const grandchild = await createArtifactViaRpc(
      rpc,
      "create-delete-grandchild",
      {
        epicId: "epic-1",
        parentId: child.artifactId,
        artifactType: "review",
        title: "Delete grandchild",
      },
    );
    const statusFrame = await rpcRequest(
      rpc.ws,
      rpc.pump,
      "status-delete-child",
      "epic.updateArtifactStatus",
      { major: 1, minor: 0 },
      {
        epicId: "epic-1",
        artifactId: child.artifactId,
        artifactType: "ticket",
        status: 2,
      },
    );
    expect(statusFrame).toMatchObject({ kind: "response", error: null });

    const subscription = await subscribeEpic(
      server.websocketUrl.replace("/rpc", "/stream"),
      sockets,
    );
    expect(subscription.snapshotMeta.epicLight).toMatchObject({
      specCount: 1,
      ticketCount: 1,
      storyCount: 0,
      reviewCount: 1,
    });
    const rootDoc = new Y.Doc();
    Y.applyUpdate(rootDoc, subscription.snapshot);
    const parentEntry = artifactEntry(rootDoc, parent.artifactId);
    const roomId = parentEntry?.get("artifactRoomId");
    if (parentEntry === null || typeof roomId !== "string") {
      throw new Error("Missing parent artifact room");
    }
    const roomBootstrap = await receiveArtifactRoomBootstrap(
      subscription.pump,
      roomId,
    );
    const roomBeforeBodies = cloneDoc(roomBootstrap.doc);
    const beforeBodies = Y.encodeStateVector(roomBootstrap.doc);
    for (const artifactId of [
      parent.artifactId,
      child.artifactId,
      grandchild.artifactId,
    ]) {
      const bodyText = new Y.XmlText();
      bodyText.insert(0, `Body for ${artifactId}`);
      roomBootstrap.doc
        .getXmlFragment(artifactBodyFragmentName(artifactId))
        .insert(0, [bodyText]);
    }
    subscription.ws.send(
      JSON.stringify({
        kind: "artifactRoomApplyUpdate",
        epicId: "epic-1",
        artifactRoomId: roomId,
        hasBinaryPayload: true,
      }),
    );
    subscription.ws.send(
      Y.encodeStateAsUpdate(roomBootstrap.doc, beforeBodies),
    );
    const roomWithBodies = await receiveArtifactRoomUpdate(
      subscription.pump,
      roomId,
      roomBeforeBodies,
    );
    for (const artifactId of [
      parent.artifactId,
      child.artifactId,
      grandchild.artifactId,
    ]) {
      expect(artifactRoomText(roomWithBodies.doc, artifactId)).toContain(
        `Body for ${artifactId}`,
      );
    }

    const rootBeforeOptimisticDelete = cloneDoc(rootDoc);
    const beforeOptimisticDelete = Y.encodeStateVector(rootDoc);
    optimisticallyDeleteRoot(rootDoc, parent.artifactId);
    subscription.ws.send(
      JSON.stringify({
        kind: "applyUpdate",
        epicId: "epic-1",
        hasBinaryPayload: true,
      }),
    );
    subscription.ws.send(
      Y.encodeStateAsUpdate(rootDoc, beforeOptimisticDelete),
    );
    await applyRootUpdatesUntil(
      subscription.pump,
      rootBeforeOptimisticDelete,
      () =>
        artifactEntry(rootBeforeOptimisticDelete, parent.artifactId) === null &&
        deletedArtifactEntry(rootBeforeOptimisticDelete, parent.artifactId) !==
          null,
    );
    expect(
      artifactEntry(rootBeforeOptimisticDelete, child.artifactId)?.get(
        "parentId",
      ),
    ).toBe(parent.artifactId);

    const deletedFrame = await rpcRequest(
      rpc.ws,
      rpc.pump,
      "delete-optimistic-parent",
      "epic.deleteArtifact",
      { major: 1, minor: 0 },
      { epicId: "epic-1", artifactId: parent.artifactId },
    );
    if (deletedFrame.kind !== "response") {
      throw new Error("Expected deleteArtifact response");
    }
    expect(deleteArtifactResponseSchema.parse(deletedFrame.result)).toEqual({
      deleted: true,
    });

    const artifactIds = [
      parent.artifactId,
      child.artifactId,
      grandchild.artifactId,
    ];
    await receiveArtifactSubtreeDeletion(
      subscription.pump,
      rootBeforeOptimisticDelete,
      roomWithBodies.doc,
      artifactIds,
      roomId,
    );
    for (const artifactId of artifactIds) {
      expect(artifactEntry(rootBeforeOptimisticDelete, artifactId)).toBeNull();
      const tombstone = deletedArtifactEntry(
        rootBeforeOptimisticDelete,
        artifactId,
      );
      if (tombstone === null) {
        throw new Error(`Missing tombstone for ${artifactId}`);
      }
      deletedEpicArtifactSchema.parse(tombstone.toJSON());
      expect(
        roomWithBodies.doc.getXmlFragment(artifactBodyFragmentName(artifactId))
          .length,
      ).toBe(0);
    }
    expect(
      deletedArtifactEntry(rootBeforeOptimisticDelete, child.artifactId)?.get(
        "status",
      ),
    ).toBe(2);
    expect(rootMetaRoomIds(rootBeforeOptimisticDelete)).toContain(roomId);

    const repeatedDelete = await rpcRequest(
      rpc.ws,
      rpc.pump,
      "repeat-delete-optimistic-parent",
      "epic.deleteArtifact",
      { major: 1, minor: 0 },
      { epicId: "epic-1", artifactId: parent.artifactId },
    );
    if (repeatedDelete.kind !== "response") {
      throw new Error("Expected repeated deleteArtifact response");
    }
    expect(deleteArtifactResponseSchema.parse(repeatedDelete.result)).toEqual({
      deleted: true,
    });
  });
});

function epicRequest() {
  const now = Date.now();
  return createEpicRequestSchema.parse({
    epic: {
      id: "epic-1",
      title: "Binary stream task",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "active",
      createdAt: now,
      updatedAt: now,
      createdBy: "local-user",
      version: "1.0.0",
    },
    repoIdentifiers: [],
    workspaces: [],
    chat: null,
  });
}

function seedEpic(server: HostServer): void {
  server.state.createEpic(epicRequest());
}

function seedArtifactRoomReference(
  server: HostServer,
  artifactId: string,
  artifactRoomId: string,
): void {
  const epic = server.state.getEpic("epic-1");
  if (epic === null) {
    throw new Error("Missing test epic");
  }
  epic.doc.transact(() => {
    epic.doc.getMap("meta").set("artifactRoomIds", [artifactRoomId]);
    const epicMap = epic.doc.getMap<unknown>("epic");
    const artifacts = new Y.Map<unknown>();
    const artifact = new Y.Map<unknown>();
    artifact.set("id", artifactId);
    artifact.set("kind", "spec");
    artifact.set("title", "Artifact room spec");
    artifact.set("parentId", null);
    artifact.set("createdAt", Date.now());
    artifact.set("updatedAt", Date.now());
    artifact.set("artifactRoomId", artifactRoomId);
    artifacts.set(artifactId, artifact);
    epicMap.set("artifacts", artifacts);
  });
}

async function receiveArtifactRoomBootstrap(
  pump: FramePump,
  artifactRoomId: string,
): Promise<{
  readonly doc: Y.Doc;
  readonly hostStateVectorBase64: string;
}> {
  expect(
    epicSubscribeServerFrameSchema.parse(expectText(await pump.next())),
  ).toEqual({
    kind: "artifactRoomState",
    epicId: "epic-1",
    artifactRoomId,
    state: "ready",
    hasBinaryPayload: false,
  });
  const envelope = epicSubscribeServerFrameSchema.parse(
    expectText(await pump.next()),
  );
  if (envelope.kind !== "artifactRoomSnapshot") {
    throw new Error("Expected artifact room snapshot");
  }
  expect(envelope).toMatchObject({
    epicId: "epic-1",
    artifactRoomId,
    hasBinaryPayload: true,
  });
  const doc = new Y.Doc();
  Y.applyUpdate(doc, expectBinary(await pump.next()));
  return {
    doc,
    hostStateVectorBase64: envelope.hostArtifactRoomStateVectorBase64,
  };
}

async function receiveArtifactRoomUpdate(
  pump: FramePump,
  artifactRoomId: string,
  baseDoc: Y.Doc,
): Promise<{
  readonly doc: Y.Doc;
  readonly hostStateVectorBase64: string;
}> {
  const envelope = epicSubscribeServerFrameSchema.parse(
    expectText(await pump.next()),
  );
  if (envelope.kind !== "artifactRoomUpdate") {
    throw new Error("Expected artifact room update");
  }
  expect(envelope).toMatchObject({
    epicId: "epic-1",
    artifactRoomId,
    hasBinaryPayload: true,
  });
  const doc = cloneDoc(baseDoc);
  Y.applyUpdate(doc, expectBinary(await pump.next()));
  expect(Buffer.from(Y.encodeStateVector(doc)).toString("base64")).toBe(
    envelope.hostArtifactRoomStateVectorBase64,
  );
  return {
    doc,
    hostStateVectorBase64: envelope.hostArtifactRoomStateVectorBase64,
  };
}

function artifactRoomText(doc: Y.Doc, artifactId: string): string {
  return doc.getXmlFragment(artifactBodyFragmentName(artifactId)).toString();
}

function cloneDoc(source: Y.Doc): Y.Doc {
  const clone = new Y.Doc();
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(source));
  return clone;
}

async function receiveCreatedArtifact(
  pump: FramePump,
  rootSnapshot: Uint8Array,
  artifactId: string,
): Promise<{
  readonly entry: Y.Map<unknown>;
  readonly rootDoc: Y.Doc;
  readonly roomId: string;
  readonly roomDoc: Y.Doc;
  readonly hostStateVectorBase64: string;
  readonly metaRoomIds: string[];
}> {
  const rootDoc = new Y.Doc();
  Y.applyUpdate(rootDoc, rootSnapshot);
  const readyRooms = new Set<string>();
  const roomSnapshots = new Map<
    string,
    { readonly doc: Y.Doc; readonly hostStateVectorBase64: string }
  >();
  for (;;) {
    const entry = artifactEntry(rootDoc, artifactId);
    const roomId = entry?.get("artifactRoomId");
    if (entry !== null && typeof roomId === "string" && roomId.length > 0) {
      const room = roomSnapshots.get(roomId);
      if (room !== undefined && readyRooms.has(roomId)) {
        return {
          entry,
          rootDoc,
          roomId,
          roomDoc: room.doc,
          hostStateVectorBase64: room.hostStateVectorBase64,
          metaRoomIds: rootMetaRoomIds(rootDoc),
        };
      }
    }

    const frame = epicSubscribeServerFrameSchema.parse(
      expectText(await pump.next()),
    );
    if (frame.kind === "update") {
      Y.applyUpdate(rootDoc, expectBinary(await pump.next()));
      continue;
    }
    if (frame.kind === "artifactRoomState" && frame.state === "ready") {
      readyRooms.add(frame.artifactRoomId);
      continue;
    }
    if (frame.kind === "artifactRoomSnapshot") {
      const roomDoc = new Y.Doc();
      Y.applyUpdate(roomDoc, expectBinary(await pump.next()));
      roomSnapshots.set(frame.artifactRoomId, {
        doc: roomDoc,
        hostStateVectorBase64: frame.hostArtifactRoomStateVectorBase64,
      });
    }
  }
}

async function applyRootUpdatesUntil(
  pump: FramePump,
  rootDoc: Y.Doc,
  done: () => boolean,
): Promise<void> {
  while (!done()) {
    const frame = epicSubscribeServerFrameSchema.parse(
      expectText(await pump.next()),
    );
    if (frame.kind === "update") {
      Y.applyUpdate(rootDoc, expectBinary(await pump.next()));
      continue;
    }
    if (frame.hasBinaryPayload) {
      await pump.next();
    }
  }
}

async function receiveArtifactDeletion(
  pump: FramePump,
  rootDoc: Y.Doc,
  roomDoc: Y.Doc,
  artifactId: string,
  roomId: string,
): Promise<Y.Map<unknown>> {
  let rootDeletionSeen = false;
  for (;;) {
    const tombstone = deletedArtifactEntry(rootDoc, artifactId);
    const body = roomDoc.getXmlFragment(artifactBodyFragmentName(artifactId));
    if (
      artifactEntry(rootDoc, artifactId) === null &&
      tombstone !== null &&
      body.length === 0
    ) {
      return tombstone;
    }

    const frame = epicSubscribeServerFrameSchema.parse(
      expectText(await pump.next()),
    );
    if (frame.kind === "update") {
      Y.applyUpdate(rootDoc, expectBinary(await pump.next()));
      rootDeletionSeen =
        artifactEntry(rootDoc, artifactId) === null &&
        deletedArtifactEntry(rootDoc, artifactId) !== null;
      continue;
    }
    if (frame.kind === "artifactRoomUpdate") {
      expect(rootDeletionSeen).toBe(true);
      const bytes = expectBinary(await pump.next());
      if (frame.artifactRoomId === roomId) {
        Y.applyUpdate(roomDoc, bytes);
        expect(
          Buffer.from(Y.encodeStateVector(roomDoc)).toString("base64"),
        ).toBe(frame.hostArtifactRoomStateVectorBase64);
      }
      continue;
    }
    if (frame.hasBinaryPayload) {
      await pump.next();
    }
  }
}

async function receiveArtifactSubtreeDeletion(
  pump: FramePump,
  rootDoc: Y.Doc,
  roomDoc: Y.Doc,
  artifactIds: readonly string[],
  roomId: string,
): Promise<void> {
  let rootDeletionSeen = false;
  for (;;) {
    const allDeleted = artifactIds.every(
      (artifactId) =>
        artifactEntry(rootDoc, artifactId) === null &&
        deletedArtifactEntry(rootDoc, artifactId) !== null,
    );
    const allBodiesEmpty = artifactIds.every(
      (artifactId) =>
        roomDoc.getXmlFragment(artifactBodyFragmentName(artifactId)).length ===
        0,
    );
    if (allDeleted && allBodiesEmpty) {
      return;
    }

    const frame = epicSubscribeServerFrameSchema.parse(
      expectText(await pump.next()),
    );
    if (frame.kind === "update") {
      Y.applyUpdate(rootDoc, expectBinary(await pump.next()));
      rootDeletionSeen = artifactIds.every(
        (artifactId) =>
          artifactEntry(rootDoc, artifactId) === null &&
          deletedArtifactEntry(rootDoc, artifactId) !== null,
      );
      continue;
    }
    if (frame.kind === "artifactRoomUpdate") {
      expect(rootDeletionSeen).toBe(true);
      const bytes = expectBinary(await pump.next());
      if (frame.artifactRoomId === roomId) {
        Y.applyUpdate(roomDoc, bytes);
        expect(
          Buffer.from(Y.encodeStateVector(roomDoc)).toString("base64"),
        ).toBe(frame.hostArtifactRoomStateVectorBase64);
      }
      continue;
    }
    if (frame.hasBinaryPayload) {
      await pump.next();
    }
  }
}

function optimisticallyDeleteRoot(rootDoc: Y.Doc, artifactId: string): void {
  const epic = rootDoc.getMap<unknown>("epic");
  const artifacts = epic.get("artifacts");
  const deletedArtifacts = epic.get("deletedArtifacts");
  const entry = artifactEntry(rootDoc, artifactId);
  if (
    !(artifacts instanceof Y.Map) ||
    !(deletedArtifacts instanceof Y.Map) ||
    entry === null
  ) {
    throw new Error(`Cannot optimistically delete ${artifactId}`);
  }
  const tombstone = new Y.Map<unknown>();
  tombstone.set("kind", entry.get("kind"));
  tombstone.set("id", entry.get("id"));
  tombstone.set("title", entry.get("title"));
  const artifactRoomId = entry.get("artifactRoomId");
  tombstone.set(
    "artifactRoomId",
    typeof artifactRoomId === "string" && artifactRoomId.length > 0
      ? artifactRoomId
      : null,
  );
  tombstone.set("deletedAt", new Date().toISOString());
  rootDoc.transact(() => {
    deletedArtifacts.set(artifactId, tombstone);
    artifacts.delete(artifactId);
  });
}

function artifactEntry(
  rootDoc: Y.Doc,
  artifactId: string,
): Y.Map<unknown> | null {
  const artifacts = rootDoc.getMap<unknown>("epic").get("artifacts");
  if (!(artifacts instanceof Y.Map)) {
    return null;
  }
  const entry = artifacts.get(artifactId);
  return entry instanceof Y.Map ? entry : null;
}

function chatEntry(rootDoc: Y.Doc, chatId: string): Y.Map<unknown> | null {
  const chats = rootDoc.getMap<unknown>("epic").get("chats");
  if (!(chats instanceof Y.Map)) {
    return null;
  }
  const entry = chats.get(chatId);
  return entry instanceof Y.Map ? entry : null;
}

function tuiAgentEntry(
  rootDoc: Y.Doc,
  tuiAgentId: string,
): Y.Map<unknown> | null {
  const tuiAgents = rootDoc.getMap<unknown>("epic").get("tuiAgents");
  if (!(tuiAgents instanceof Y.Map)) {
    return null;
  }
  const entry = tuiAgents.get(tuiAgentId);
  return entry instanceof Y.Map ? entry : null;
}

function deletedArtifactEntry(
  rootDoc: Y.Doc,
  artifactId: string,
): Y.Map<unknown> | null {
  const deletedArtifacts = rootDoc
    .getMap<unknown>("epic")
    .get("deletedArtifacts");
  if (!(deletedArtifacts instanceof Y.Map)) {
    return null;
  }
  const entry = deletedArtifacts.get(artifactId);
  return entry instanceof Y.Map ? entry : null;
}

function rootMetaRoomIds(rootDoc: Y.Doc): string[] {
  const stored = rootDoc.getMap<unknown>("meta").get("artifactRoomIds");
  const values = stored instanceof Y.Array ? stored.toArray() : stored;
  if (!Array.isArray(values)) {
    return [];
  }
  return values.filter((value): value is string => typeof value === "string");
}

async function createArtifactViaRpc(
  rpc: RpcConnection,
  requestId: string,
  params: CreateArtifactRequest,
): Promise<CreateArtifactResponse> {
  const frame = await rpcRequest(
    rpc.ws,
    rpc.pump,
    requestId,
    "epic.createArtifact",
    { major: 1, minor: 0 },
    params,
  );
  if (frame.kind !== "response") {
    throw new Error("Expected createArtifact response");
  }
  return createArtifactResponseSchema.parse(frame.result);
}

async function openRpc(
  url: string,
  sockets: WebSocket[],
): Promise<RpcConnection> {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const pump = attachPump(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const split = splitConnectionManifest(
    hostRpcRegistry,
    RELEASED_FLOOR_METHOD_NAMES,
  );
  ws.send(
    JSON.stringify({
      kind: "open",
      token: "local",
      manifest: split.manifest,
      optionalManifest: split.optionalManifest,
    }),
  );
  expect(hostFrameSchema.parse(expectText(await pump.next()))).toMatchObject({
    kind: "openAck",
  });
  return { ws, pump };
}

async function rpcRequest(
  ws: WebSocket,
  pump: FramePump,
  requestId: string,
  method: string,
  schemaVersion: { readonly major: number; readonly minor: number },
  params: unknown,
): Promise<HostFrame> {
  ws.send(
    JSON.stringify({
      kind: "request",
      requestId,
      method,
      schemaVersion,
      params,
    }),
  );
  return hostFrameSchema.parse(expectText(await pump.next()));
}

async function createChatViaRpc(
  rpc: RpcConnection,
  requestId: string,
  chat: {
    readonly chatId: string;
    readonly parentId: string | null;
    readonly title: string;
  },
): Promise<void> {
  const frame = await rpcRequest(
    rpc.ws,
    rpc.pump,
    requestId,
    "epic.createChat",
    { major: 1, minor: 0 },
    {
      epicId: "epic-1",
      chatId: chat.chatId,
      parentId: chat.parentId,
      hostId: "host-local",
      title: chat.title,
      settings: null,
      worktreeIntent: null,
      initialMessage: null,
    },
  );
  expect(frame).toMatchObject({
    kind: "response",
    error: null,
    result: { chatId: chat.chatId, initialTurnStarted: false },
  });
}

async function createPublicEpic(
  server: HostServer,
  sockets: WebSocket[],
): Promise<{
  readonly rpc: RpcConnection;
  readonly subscription: EpicSubscription;
}> {
  const rpc = await openRpc(server.websocketUrl, sockets);
  const createdEpic = await rpcRequest(
    rpc.ws,
    rpc.pump,
    "create-epic",
    "epic.create",
    { major: 1, minor: 0 },
    epicRequest(),
  );
  expect(createdEpic).toMatchObject({ kind: "response", error: null });
  const subscription = await subscribeEpic(
    server.websocketUrl.replace("/rpc", "/stream"),
    sockets,
  );
  return { rpc, subscription };
}

async function subscribeChat(
  url: string,
  sockets: WebSocket[],
  chatId: string,
): Promise<ChatSnapshot> {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const pump = attachPump(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(
    JSON.stringify({
      kind: "open",
      token: "local",
      manifest: { "chat.subscribe": { major: 1, minor: 6 } },
    }),
  );
  expect(expectText(await pump.next())).toMatchObject({ kind: "openAck" });
  ws.send(
    JSON.stringify({
      kind: "subscribe",
      method: "chat.subscribe",
      schemaVersion: { major: 1, minor: 6 },
      params: { epicId: "epic-1", chatId },
    }),
  );
  const frame = chatSubscribeServerFrameSchema.parse(
    expectText(await pump.next()),
  );
  if (frame.kind !== "snapshot") {
    throw new Error("Expected chat snapshot");
  }
  return frame;
}

async function subscribeEpic(
  url: string,
  sockets: WebSocket[],
): Promise<EpicSubscription> {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const pump = attachPump(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(
    JSON.stringify({
      kind: "open",
      token: "local",
      manifest: { "epic.subscribe": { major: 1, minor: 1 } },
    }),
  );
  expect(expectText(await pump.next())).toMatchObject({ kind: "openAck" });
  ws.send(
    JSON.stringify({
      kind: "subscribe",
      method: "epic.subscribe",
      schemaVersion: { major: 1, minor: 1 },
      params: { epicId: "epic-1" },
    }),
  );

  let snapshot: Uint8Array | null = null;
  let snapshotMeta: EpicSnapshot["meta"] | null = null;
  const initialAwareness: Uint8Array[] = [];
  let dirtySnapshot: EpicDirtySnapshot | null = null;
  for (;;) {
    const incoming = await pump.next();
    if (incoming.kind === "binary") {
      throw new Error("Unexpected unpaired binary frame during subscribe");
    }
    const frame = epicSubscribeServerFrameSchema.parse(incoming.value);
    if (frame.kind === "snapshot") {
      snapshotMeta = frame.meta;
      snapshot = expectBinary(await pump.next());
    }
    if (frame.kind === "awareness") {
      initialAwareness.push(expectBinary(await pump.next()));
    }
    if (frame.kind === "dirtySnapshot") {
      dirtySnapshot = frame;
    }
    if (frame.kind === "cloudSyncStatus") {
      break;
    }
  }
  if (snapshot === null) {
    throw new Error("Epic subscription did not provide a snapshot");
  }
  if (snapshotMeta === null) {
    throw new Error("Epic subscription did not provide snapshot metadata");
  }
  if (dirtySnapshot === null) {
    throw new Error("Epic subscription did not provide a dirty snapshot");
  }
  return {
    ws,
    pump,
    snapshot,
    snapshotMeta,
    initialAwareness,
    dirtySnapshot,
  };
}

function trackedAwareness(instances: Awareness[]): Awareness {
  const awareness = new Awareness(new Y.Doc());
  instances.push(awareness);
  return awareness;
}

function attachPump(ws: WebSocket): FramePump {
  const pending: IncomingFrame[] = [];
  const waiters: Array<(frame: IncomingFrame) => void> = [];
  ws.on("message", (data, isBinary) => {
    const frame: IncomingFrame = isBinary
      ? { kind: "binary", value: bytesFromRaw(data) }
      : { kind: "text", value: JSON.parse(data.toString()) };
    const waiter = waiters.shift();
    if (waiter === undefined) {
      pending.push(frame);
      return;
    }
    waiter(frame);
  });
  return {
    next: () => {
      const frame = pending.shift();
      if (frame !== undefined) {
        return Promise.resolve(frame);
      }
      return new Promise<IncomingFrame>((resolve, reject) => {
        let timeout: NodeJS.Timeout;
        const waiter = (incoming: IncomingFrame): void => {
          clearTimeout(timeout);
          resolve(incoming);
        };
        timeout = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          reject(new Error("Timed out waiting for frame"));
        }, 2_000);
        waiters.push(waiter);
      });
    },
    bufferedCount: () => pending.length,
  };
}

function bytesFromRaw(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data));
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function expectText(frame: IncomingFrame): unknown {
  if (frame.kind !== "text") {
    throw new Error("Expected text frame");
  }
  return frame.value;
}

function expectBinary(frame: IncomingFrame): Uint8Array {
  if (frame.kind !== "binary") {
    throw new Error("Expected binary frame");
  }
  return frame.value;
}
