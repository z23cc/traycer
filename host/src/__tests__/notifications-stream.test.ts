import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { type RawData } from "ws";
import * as Y from "yjs";
import {
  notificationsSubscribeServerFrameSchemaV10,
  type NotificationsSubscribeServerFrameV10,
} from "@traycer/protocol/host/notifications/subscribe";
import {
  NOTIFICATION_EVENT_TYPES,
  type NotificationEntry,
} from "@traycer/protocol/notifications/notification-entry";
import {
  NOTIFICATIONS_ARRAY_KEY,
  createNotificationRoomEntryMap,
  parseNotificationRoomEntry,
  type NotificationRoomEntryMap,
} from "@traycer/protocol/notifications/notification-room";
import { scriptedTurnRunner } from "../cli-runner";
import { openNotificationsStream } from "../notifications-stream";
import { startHostServer, type HostServer } from "../server";
import { HostState } from "../store";

type IncomingFrame =
  | { readonly kind: "text"; readonly value: unknown }
  | { readonly kind: "binary"; readonly value: Uint8Array };

type FramePump = {
  readonly next: () => Promise<IncomingFrame>;
  readonly bufferedCount: () => number;
};

type NotificationsSnapshot = Extract<
  NotificationsSubscribeServerFrameV10,
  { readonly kind: "snapshot" }
>;

type NotificationsSubscription = {
  readonly ws: WebSocket;
  readonly pump: FramePump;
  readonly snapshot: Uint8Array;
  readonly snapshotMeta: NotificationsSnapshot["meta"];
};

describe("notifications stream", () => {
  const servers: HostServer[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
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

  it("echoes paired Yjs updates to every subscriber and includes them in later snapshots", async () => {
    const server = await startHostServer(0, "host-local", {
      runner: scriptedTurnRunner([]),
    });
    servers.push(server);
    const streamUrl = server.websocketUrl.replace("/rpc", "/stream");
    const first = await subscribeNotifications(streamUrl, sockets);
    const second = await subscribeNotifications(streamUrl, sockets);

    expect(first.snapshotMeta).toEqual({ schemaVersion: "1.0.0" });
    const edited = new Y.Doc();
    Y.applyUpdate(edited, first.snapshot);
    const beforeEdit = Y.encodeStateVector(edited);
    const firstEntry = invitedNotification("notification-1", "Build Bot");
    edited
      .getArray<NotificationRoomEntryMap>(NOTIFICATIONS_ARRAY_KEY)
      .push([createNotificationRoomEntryMap(firstEntry)]);
    const update = Y.encodeStateAsUpdate(edited, beforeEdit);

    first.ws.send(
      JSON.stringify({ kind: "applyUpdate", hasBinaryPayload: true }),
    );
    first.ws.send(update);

    const sourceUpdate = await receiveUpdate(first);
    const sourceDoc = docFrom(first.snapshot, sourceUpdate);
    expect(readNotificationEntries(sourceDoc)).toContainEqual(firstEntry);

    const peerUpdate = await receiveUpdate(second);
    const peerDoc = docFrom(second.snapshot, peerUpdate);
    expect(readNotificationEntries(peerDoc)).toContainEqual(firstEntry);
    expect(first.pump.bufferedCount()).toBe(0);

    const late = await subscribeNotifications(streamUrl, sockets);
    const lateDoc = docFrom(late.snapshot, undefined);
    expect(readNotificationEntries(lateDoc)).toContainEqual(firstEntry);

    first.ws.close();
    await waitForClose(first.ws);
    const beforeSecondEdit = Y.encodeStateVector(peerDoc);
    const secondEntry = invitedNotification("notification-2", "Test Bot");
    peerDoc
      .getArray<NotificationRoomEntryMap>(NOTIFICATIONS_ARRAY_KEY)
      .push([createNotificationRoomEntryMap(secondEntry)]);
    const secondUpdate = Y.encodeStateAsUpdate(peerDoc, beforeSecondEdit);
    second.ws.send(
      JSON.stringify({ kind: "applyUpdate", hasBinaryPayload: true }),
    );
    second.ws.send(secondUpdate);
    Y.applyUpdate(peerDoc, await receiveUpdate(second));
    expect(readNotificationEntries(peerDoc)).toContainEqual(secondEntry);

    second.ws.close();
    late.ws.close();
    await Promise.all([waitForClose(second.ws), waitForClose(late.ws)]);
    const reconnected = await subscribeNotifications(streamUrl, sockets);
    const reconnectedDoc = docFrom(reconnected.snapshot, undefined);
    expect(readNotificationEntries(reconnectedDoc)).toContainEqual(secondEntry);

    reconnected.ws.send(
      JSON.stringify({ kind: "ping", hasBinaryPayload: false }),
    );
    expect(
      notificationsSubscribeServerFrameSchemaV10.parse(
        expectText(await reconnected.pump.next()),
      ),
    ).toEqual({ kind: "pong", hasBinaryPayload: false });
  });

  it("drops malformed method updates without closing the stream", async () => {
    const server = await startHostServer(0, "host-local", {
      runner: scriptedTurnRunner([]),
    });
    servers.push(server);
    const subscription = await subscribeNotifications(
      server.websocketUrl.replace("/rpc", "/stream"),
      sockets,
    );

    subscription.ws.send(
      JSON.stringify({ kind: "applyUpdate", hasBinaryPayload: false }),
    );
    subscription.ws.send(
      JSON.stringify({ kind: "ping", hasBinaryPayload: false }),
    );

    expect(
      notificationsSubscribeServerFrameSchemaV10.parse(
        expectText(await subscription.pump.next()),
      ),
    ).toEqual({ kind: "pong", hasBinaryPayload: false });

    subscription.ws.send(
      JSON.stringify({ kind: "applyUpdate", hasBinaryPayload: true }),
    );
    subscription.ws.send(new Uint8Array([255]));
    subscription.ws.send(
      JSON.stringify({ kind: "ping", hasBinaryPayload: false }),
    );
    expect(
      notificationsSubscribeServerFrameSchemaV10.parse(
        expectText(await subscription.pump.next()),
      ),
    ).toEqual({ kind: "pong", hasBinaryPayload: false });
  });

  it("detaches its document listener when the stream closes", () => {
    const state = new HostState("host-local", undefined, undefined);
    const sent: Array<string | Uint8Array> = [];
    const opened = openNotificationsStream((frame) => sent.push(frame), state, {
      ignoredByV10: true,
    });
    if (!opened.accepted) {
      throw new Error(opened.reason);
    }
    sent.length = 0;

    opened.binding.dispose();
    state
      .getNotificationsDoc()
      .getArray<NotificationRoomEntryMap>(NOTIFICATIONS_ARRAY_KEY)
      .push([
        createNotificationRoomEntryMap(
          invitedNotification("notification-after-close", "Build Bot"),
        ),
      ]);

    expect(sent).toEqual([]);
    state.dispose();
  });
});

async function subscribeNotifications(
  url: string,
  sockets: WebSocket[],
): Promise<NotificationsSubscription> {
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
      manifest: { "notifications.subscribe": { major: 1, minor: 1 } },
    }),
  );
  const openAck = expectText(await pump.next());
  expect(openAck).toMatchObject({
    kind: "openAck",
    manifest: {
      "notifications.subscribe": { major: 1, minor: 0 },
    },
  });
  ws.send(
    JSON.stringify({
      kind: "subscribe",
      method: "notifications.subscribe",
      schemaVersion: { major: 1, minor: 0 },
      params: {},
    }),
  );
  const frame = notificationsSubscribeServerFrameSchemaV10.parse(
    expectText(await pump.next()),
  );
  if (frame.kind !== "snapshot") {
    throw new Error("Notifications subscription did not provide a snapshot");
  }
  return {
    ws,
    pump,
    snapshot: expectBinary(await pump.next()),
    snapshotMeta: frame.meta,
  };
}

async function receiveUpdate(
  subscription: NotificationsSubscription,
): Promise<Uint8Array> {
  expect(
    notificationsSubscribeServerFrameSchemaV10.parse(
      expectText(await subscription.pump.next()),
    ),
  ).toEqual({ kind: "update", hasBinaryPayload: true });
  return expectBinary(await subscription.pump.next());
}

function docFrom(snapshot: Uint8Array, update: Uint8Array | undefined): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, snapshot);
  if (update !== undefined) {
    Y.applyUpdate(doc, update);
  }
  return doc;
}

function invitedNotification(id: string, actorName: string): NotificationEntry {
  return {
    id,
    createdAt: 1,
    readAt: null,
    event: {
      kind: NOTIFICATION_EVENT_TYPES.INVITED,
      epicId: "epic-1",
      actorName,
    },
  };
}

function readNotificationEntries(doc: Y.Doc): NotificationEntry[] {
  const entries = doc.getArray<NotificationRoomEntryMap>(
    NOTIFICATIONS_ARRAY_KEY,
  );
  const parsed: NotificationEntry[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = parseNotificationRoomEntry(entries.get(index));
    if (entry !== undefined) {
      parsed.push(entry);
    }
  }
  return parsed;
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

function waitForClose(ws: WebSocket): Promise<void> {
  if (ws.readyState === ws.CLOSED) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    ws.once("close", resolve);
  });
}
