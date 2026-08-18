import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  chatSubscribeClientFrameSchema,
  chatSubscribeServerFrameSchema,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  epicSubscribeClientFrameSchema,
  epicSubscribeServerFrameSchema,
} from "@traycer/protocol/host/epic/subscribe";
import { scriptedTurnRunner } from "../cli-runner";
import { HostState } from "../store";
import { createStreamSession } from "../stream-session";

type CapturedSession = {
  readonly sent: Array<string | Uint8Array>;
  readonly onMessage: (raw: string) => void;
  readonly dispose: () => void;
};

describe("stream session heartbeat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("replies to an epic subscription ping only on its own socket", () => {
    const state = stateWithChat();
    const first = subscribedSession(state, "epic.subscribe");
    const second = subscribedSession(state, "epic.subscribe");

    first.onMessage(
      JSON.stringify(
        epicSubscribeClientFrameSchema.parse({
          kind: "ping",
          hasBinaryPayload: false,
        }),
      ),
    );

    expect(
      epicSubscribeServerFrameSchema.parse(onlyJsonFrame(first.sent)),
    ).toEqual({ kind: "pong", hasBinaryPayload: false });
    expect(second.sent).toEqual([]);
    first.dispose();
    second.dispose();
  });

  it("does not broadcast a chat subscription pong to another socket", () => {
    const state = stateWithChat();
    const first = subscribedSession(state, "chat.subscribe");
    const second = subscribedSession(state, "chat.subscribe");

    first.onMessage(
      JSON.stringify(
        chatSubscribeClientFrameSchema.parse({
          kind: "ping",
          hasBinaryPayload: false,
        }),
      ),
    );

    expect(
      chatSubscribeServerFrameSchema.parse(onlyJsonFrame(first.sent)),
    ).toEqual({ kind: "pong", hasBinaryPayload: false });
    expect(second.sent).toEqual([]);
    first.dispose();
    second.dispose();
  });

  it("starts application and transport heartbeats only after subscribe", () => {
    vi.useFakeTimers();
    const harness = heartbeatHarness();
    harness.open();

    vi.advanceTimersByTime(25_000);
    expect(harness.sent).toEqual([]);
    expect(harness.transportPings).toBe(0);

    harness.subscribe();
    harness.sent.length = 0;
    vi.advanceTimersByTime(25_000);

    expect(harness.sent.map(parseJsonFrame)).toContainEqual({
      kind: "ping",
      hasBinaryPayload: false,
    });
    expect(harness.transportPings).toBe(1);
    harness.session.dispose();
  });

  it("keeps the stream alive when either application or transport pong arrives", () => {
    vi.useFakeTimers();
    const application = heartbeatHarness();
    application.open();
    application.subscribe();
    application.sent.length = 0;
    vi.advanceTimersByTime(25_000);
    application.session.onMessage(
      JSON.stringify({ kind: "pong", hasBinaryPayload: false }),
    );
    vi.advanceTimersByTime(60_000);
    expect(application.closes).toEqual([]);
    application.session.dispose();

    const transport = heartbeatHarness();
    transport.open();
    transport.subscribe();
    transport.sent.length = 0;
    vi.advanceTimersByTime(25_000);
    transport.session.onTransportPong();
    vi.advanceTimersByTime(60_000);
    expect(transport.closes).toEqual([]);
    transport.session.dispose();
  });

  it("fatally closes a subscribed stream after 60 seconds without either pong", () => {
    vi.useFakeTimers();
    const harness = heartbeatHarness();
    harness.open();
    harness.subscribe();
    harness.sent.length = 0;

    vi.advanceTimersByTime(25_000);
    vi.advanceTimersByTime(60_000);

    expect(harness.sent.map(parseJsonFrame)).toContainEqual({
      kind: "fatalError",
      details: {
        code: "STREAM_HEARTBEAT_TIMEOUT",
        reason: "No pong received within 60000ms",
        incompatibleMethods: null,
        upgradeGuidance: null,
      },
    });
    expect(harness.closes).toEqual([
      { code: 1008, reason: "No pong received within 60000ms" },
    ]);
  });

  it("clears heartbeat timers when the stream is disposed", () => {
    vi.useFakeTimers();
    const harness = heartbeatHarness();
    harness.open();
    harness.subscribe();
    harness.sent.length = 0;
    harness.session.dispose();

    vi.advanceTimersByTime(120_000);

    expect(harness.sent).toEqual([]);
    expect(harness.transportPings).toBe(0);
    expect(harness.closes).toEqual([]);
  });

  it("fatally closes when binary arrives without a paired text envelope", () => {
    const harness = heartbeatHarness();
    harness.open();
    harness.subscribe();
    harness.sent.length = 0;

    harness.session.onBinaryMessage(new Uint8Array([1, 2, 3]));

    expect(harness.sent.map(parseJsonFrame)).toEqual([
      {
        kind: "fatalError",
        details: {
          code: "STREAM_PROTOCOL_ERROR",
          reason: "Unexpected binary frame without a paired text envelope",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      },
    ]);
    expect(harness.closes).toEqual([
      {
        code: 1008,
        reason: "Unexpected binary frame without a paired text envelope",
      },
    ]);
  });

  it("pairs a generic binary envelope before method-specific dispatch", () => {
    const harness = heartbeatHarness();
    harness.open();
    harness.subscribe();
    harness.sent.length = 0;

    harness.session.onMessage(
      JSON.stringify({
        kind: "futureBinaryFrame",
        hasBinaryPayload: true,
      }),
    );
    expect(harness.sent).toEqual([]);
    expect(harness.closes).toEqual([]);

    harness.session.onMessage(
      JSON.stringify({ kind: "ping", hasBinaryPayload: false }),
    );

    expect(harness.sent.map(parseJsonFrame)).toEqual([
      {
        kind: "fatalError",
        details: {
          code: "STREAM_PROTOCOL_ERROR",
          reason: "Unexpected text frame while awaiting paired binary payload",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      },
    ]);
    expect(harness.closes).toEqual([
      {
        code: 1008,
        reason: "Unexpected text frame while awaiting paired binary payload",
      },
    ]);
  });

  it("drops an invalid Yjs update without closing the stream", () => {
    const harness = heartbeatHarness();
    harness.open();
    harness.subscribe();
    harness.sent.length = 0;

    harness.session.onMessage(
      JSON.stringify({
        kind: "applyUpdate",
        epicId: "epic-1",
        hasBinaryPayload: true,
      }),
    );
    harness.session.onBinaryMessage(new Uint8Array([0xff]));
    harness.session.onMessage(
      JSON.stringify({ kind: "ping", hasBinaryPayload: false }),
    );

    expect(harness.sent.map(parseJsonFrame)).toEqual([
      { kind: "pong", hasBinaryPayload: false },
    ]);
    expect(harness.closes).toEqual([]);
    harness.session.dispose();
  });

  it("emits dirtySnapshot only for epic.subscribe v1.1", () => {
    const v1 = epicBootstrapFrames({ major: 1, minor: 0 });
    const v1_1 = epicBootstrapFrames({ major: 1, minor: 1 });

    expect(v1).not.toContainEqual(
      expect.objectContaining({ kind: "dirtySnapshot" }),
    );
    expect(v1_1).toContainEqual({
      kind: "dirtySnapshot",
      epicId: "epic-1",
      rootDirty: false,
      rooms: [],
      hasBinaryPayload: false,
    });
  });

  it("reports invalid JSON as a transport protocol error", () => {
    const harness = heartbeatHarness();
    harness.open();
    harness.subscribe();
    harness.sent.length = 0;

    harness.session.onMessage("{");

    expect(harness.sent.map(parseJsonFrame)).toEqual([
      {
        kind: "fatalError",
        details: {
          code: "STREAM_PROTOCOL_ERROR",
          reason: expect.stringMatching(/^Invalid JSON frame: /),
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      },
    ]);
    expect(harness.closes).toEqual([
      { code: 1008, reason: expect.stringMatching(/^Invalid JSON frame: /) },
    ]);
  });

  it("routes an update by the bound subscription instead of the envelope epicId", () => {
    const harness = heartbeatHarness();
    harness.open();
    harness.subscribe();
    harness.sent.length = 0;
    const epic = harness.state.getEpic("epic-1");
    if (epic === null) {
      throw new Error("Missing test epic");
    }
    const clientDoc = new Y.Doc();
    Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(epic.doc));
    const beforeEdit = Y.encodeStateVector(clientDoc);
    clientDoc.getMap("epic").set("title", "Routed by subscription");

    harness.session.onMessage(
      JSON.stringify({
        kind: "applyUpdate",
        epicId: "different-epic-id",
        hasBinaryPayload: true,
      }),
    );
    harness.session.onBinaryMessage(
      Y.encodeStateAsUpdate(clientDoc, beforeEdit),
    );

    expect(epic.doc.getMap("epic").get("title")).toBe("Routed by subscription");
    expect(harness.closes).toEqual([]);
    harness.session.dispose();
  });

  it("treats a fatal open failure as a terminal connection state", () => {
    const harness = heartbeatHarness();

    harness.session.onMessage(
      JSON.stringify({ kind: "open", token: "", manifest: {} }),
    );
    harness.session.onMessage(
      JSON.stringify({ kind: "open", token: "local", manifest: {} }),
    );

    expect(harness.sent.map(parseJsonFrame)).toEqual([
      {
        kind: "fatalError",
        details: {
          code: "UNAUTHORIZED",
          reason: "Missing bearer token",
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      },
    ]);
    expect(harness.closes).toEqual([
      { code: 1008, reason: "Missing bearer token" },
    ]);
  });
});

function epicBootstrapFrames(schemaVersion: {
  readonly major: number;
  readonly minor: number;
}): unknown[] {
  const state = stateWithChat();
  const sent: Array<string | Uint8Array> = [];
  const session = createStreamSession(
    (data) => {
      sent.push(data);
    },
    state,
    scriptedTurnRunner([]),
    undefined,
  );
  session.onMessage(
    JSON.stringify({
      kind: "open",
      token: "local",
      manifest: { "epic.subscribe": schemaVersion },
    }),
  );
  sent.length = 0;
  session.onMessage(
    JSON.stringify({
      kind: "subscribe",
      method: "epic.subscribe",
      schemaVersion,
      params: { epicId: "epic-1" },
    }),
  );
  session.dispose();
  return sent.map(parseJsonFrame).filter((frame) => frame !== null);
}

function heartbeatHarness() {
  const state = stateWithChat();
  const sent: Array<string | Uint8Array> = [];
  const closes: Array<{ readonly code: number; readonly reason: string }> = [];
  let transportPings = 0;
  const session = createStreamSession(
    (data) => {
      sent.push(data);
    },
    state,
    scriptedTurnRunner([]),
    {
      sendTransportPing: () => {
        transportPings += 1;
      },
      close: (code, reason) => {
        closes.push({ code, reason });
      },
      pingIntervalMs: 25_000,
      pongTimeoutMs: 60_000,
    },
  );
  return {
    state,
    sent,
    closes,
    session,
    get transportPings() {
      return transportPings;
    },
    open(): void {
      session.onMessage(
        JSON.stringify({
          kind: "open",
          token: "local",
          manifest: { "epic.subscribe": { major: 1, minor: 1 } },
        }),
      );
      expect(sent).toHaveLength(1);
      sent.length = 0;
    },
    subscribe(): void {
      session.onMessage(
        JSON.stringify({
          kind: "subscribe",
          method: "epic.subscribe",
          schemaVersion: { major: 1, minor: 1 },
          params: { epicId: "epic-1" },
        }),
      );
      expect(sent.length).toBeGreaterThan(0);
    },
  };
}

function stateWithChat(): HostState {
  const state = new HostState("host-local", undefined, undefined);
  const now = Date.now();
  state.createEpic({
    epic: {
      id: "epic-1",
      title: "Heartbeat task",
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
    chat: {
      chatId: "chat-1",
      parentId: null,
      hostId: "host-local",
      title: "Heartbeat chat",
      worktreeIntent: null,
      initialMessage: null,
    },
  });
  return state;
}

function subscribedSession(
  state: HostState,
  method: "epic.subscribe" | "chat.subscribe",
): CapturedSession {
  const sent: Array<string | Uint8Array> = [];
  const stream = createStreamSession(
    (data) => {
      sent.push(data);
    },
    state,
    scriptedTurnRunner([]),
    undefined,
  );
  const schemaVersion =
    method === "epic.subscribe"
      ? { major: 1, minor: 1 }
      : { major: 1, minor: 6 };
  stream.onMessage(
    JSON.stringify({
      kind: "open",
      token: "local",
      manifest: { [method]: schemaVersion },
    }),
  );
  expect(sent).toHaveLength(1);
  sent.length = 0;
  stream.onMessage(
    JSON.stringify({
      kind: "subscribe",
      method,
      schemaVersion,
      params:
        method === "epic.subscribe"
          ? { epicId: "epic-1" }
          : { epicId: "epic-1", chatId: "chat-1" },
    }),
  );
  expect(sent.length).toBeGreaterThan(0);
  sent.length = 0;
  return { sent, onMessage: stream.onMessage, dispose: stream.dispose };
}

function onlyJsonFrame(frames: Array<string | Uint8Array>): unknown {
  expect(frames).toHaveLength(1);
  const frame = frames[0];
  expect(typeof frame).toBe("string");
  if (typeof frame !== "string") {
    throw new Error("Expected a JSON text frame");
  }
  return JSON.parse(frame);
}

function parseJsonFrame(frame: string | Uint8Array): unknown {
  if (typeof frame !== "string") {
    return null;
  }
  return JSON.parse(frame);
}
