import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InboxMonitor } from "../stream/inbox";
import { startHost, type StartedHost } from "../start-host";

type Frame = { readonly kind: string; readonly [key: string]: unknown };

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  readonly frames: Frame[] = [];

  send(payload: string): void {
    this.frames.push(JSON.parse(payload) as Frame);
  }
}

describe("agent.inbox.subscribe", () => {
  let started: StartedHost | null = null;
  let tempDir: string | null = null;

  afterEach(async () => {
    if (started !== null) {
      await started.close();
      started = null;
    }
    if (tempDir !== null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("drains the durable queue on subscribe, newest last", async () => {
    const host = await boot();
    enqueue(host, "first", false);
    enqueue(host, "second", true);
    const socket = new FakeSocket();
    monitorFor(host, socket, 2).drain();

    expect(socket.frames.map((frame) => frame.kind)).toEqual([
      "message",
      "message",
    ]);
    const items = socket.frames.map((frame) => frame.item as Frame);
    expect(items.map((item) => item.prompt)).toEqual(["first", "second"]);
    expect(items[1].reply).toEqual({
      expectsReply: true,
      responseId: "r-second",
    });
    // `@1.2` carries the durable key, so the monitor acks for itself and the
    // rows are still queued until it does.
    expect(items[0].eventId).toEqual(expect.any(String));
    expect(host.runtime.inbox.pending("tui-1")).toHaveLength(2);
  });

  it("acks on behalf of a monitor too old to carry the key", async () => {
    const host = await boot();
    enqueue(host, "only", false);
    const socket = new FakeSocket();
    monitorFor(host, socket, 1).drain();

    // No `eventId` at `@1.1`, so `agent.inbox.ack` structurally cannot
    // arrive - the row is retired here rather than queued forever.
    expect((socket.frames[0].item as Frame).eventId).toBeUndefined();
    expect(host.runtime.inbox.pending("tui-1")).toEqual([]);
  });

  it("answers ping with pong through the registry", async () => {
    const host = await boot();
    const socket = new FakeSocket();
    host.runtime.inboxMonitors.add(
      socket as never,
      monitorFor(host, socket, 2),
    );
    expect(
      host.runtime.inboxMonitors.handleFrame(socket as never, {
        kind: "ping",
        hasBinaryPayload: false,
      }),
    ).toBe(true);
    expect(socket.frames).toEqual([{ kind: "pong", hasBinaryPayload: false }]);
    // A frame this stream does not own is left for another handler.
    expect(
      host.runtime.inboxMonitors.handleFrame(socket as never, {
        kind: "watch",
      }),
    ).toBe(false);
  });

  function monitorFor(
    host: StartedHost,
    socket: FakeSocket,
    minor: number,
  ): InboxMonitor {
    return new InboxMonitor(
      socket as never,
      host.runtime,
      "tui-1",
      "epic-1",
      minor,
    );
  }

  function enqueue(
    host: StartedHost,
    prompt: string,
    expectsReply: boolean,
  ): void {
    host.runtime.inbox.enqueue({
      epicId: "epic-1",
      toAgentId: "tui-1",
      fromAgentId: "chat-1",
      senderTitle: "Root",
      senderHarnessId: "claude",
      prompt,
      expectsReply,
      responseId: expectsReply ? `r-${prompt}` : null,
    });
  }

  async function boot(): Promise<StartedHost> {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    return started;
  }
});
