import type { WebSocket } from "ws";
import type { RoleAwarenessEvent } from "@traycer/protocol/host/agent/roles";
import type { InboxEnvelope } from "../agent/inbox";
import type { HostRuntime } from "../runtime";

/**
 * `agent.inbox.subscribe` - one connected monitor for one agent.
 *
 * The stream drains whatever the durable inbox already holds for the agent,
 * then pushes each new envelope as it is enqueued. Role awareness rides the
 * same connection but is NEVER queued: a peer's claim is delivered only to a
 * monitor connected at that moment, so a reconnecting monitor reads current
 * roles from its prompt instead of replaying a stale broadcast.
 */
const AWARENESS_MINOR = 1;
/** `eventId` lands at `@1.2`; below it a monitor cannot ack, so we ack for it. */
const DURABLE_ACK_MINOR = 2;

export class InboxMonitor {
  constructor(
    private readonly socket: WebSocket,
    private readonly runtime: HostRuntime,
    readonly agentId: string,
    readonly epicId: string,
    private readonly minor: number,
  ) {}

  /** Everything queued for this agent, oldest first. */
  drain(): void {
    for (const envelope of this.runtime.inbox.pending(this.agentId)) {
      this.deliver(envelope);
    }
  }

  deliver(envelope: InboxEnvelope): void {
    const item = {
      reply: envelope.expectsReply
        ? { expectsReply: true, responseId: envelope.responseId ?? "" }
        : { expectsReply: false },
      fromAgentId: envelope.fromAgentId,
      senderTitle: envelope.senderTitle,
      senderHarnessId: envelope.senderHarnessId,
      epicId: envelope.epicId,
      prompt: envelope.prompt,
      enqueuedAt: envelope.enqueuedAt,
      ...(this.minor >= DURABLE_ACK_MINOR ? { eventId: envelope.eventId } : {}),
    };
    this.send({ kind: "message", hasBinaryPayload: false, item });
    if (this.minor < DURABLE_ACK_MINOR) {
      // A monitor below `@1.2` has no `eventId` and so can never call
      // `agent.inbox.ack`. Retiring the row here is the at-most-once behaviour
      // those monitors were always built against - the alternative is a row
      // queued forever for an ack that structurally cannot arrive.
      this.runtime.inbox.ack(this.agentId, [envelope.eventId]);
    }
  }

  /** `@1.0` never negotiated this frame, so it is never sent one. */
  announce(event: RoleAwarenessEvent): boolean {
    if (this.minor < AWARENESS_MINOR) {
      return false;
    }
    return this.send({
      kind: "role-awareness",
      hasBinaryPayload: false,
      event,
    });
  }

  pong(): void {
    this.send({ kind: "pong", hasBinaryPayload: false });
  }

  private send(frame: unknown): boolean {
    if (this.socket.readyState !== this.socket.OPEN) {
      return false;
    }
    this.socket.send(JSON.stringify(frame));
    return true;
  }
}

/** Every connected inbox monitor, so a delivery can find the live ones. */
export class InboxMonitorRegistry {
  private readonly monitors = new Map<WebSocket, InboxMonitor>();

  add(socket: WebSocket, monitor: InboxMonitor): void {
    this.monitors.set(socket, monitor);
  }

  remove(socket: WebSocket): void {
    this.monitors.delete(socket);
  }

  forAgent(agentId: string): readonly InboxMonitor[] {
    return [...this.monitors.values()].filter(
      (monitor) => monitor.agentId === agentId,
    );
  }

  inEpic(epicId: string): readonly InboxMonitor[] {
    return [...this.monitors.values()].filter(
      (monitor) => monitor.epicId === epicId,
    );
  }

  handleFrame(socket: WebSocket, frame: unknown): boolean {
    const monitor = this.monitors.get(socket);
    if (monitor === undefined || frame === null || typeof frame !== "object") {
      return false;
    }
    if (Reflect.get(frame, "kind") !== "ping") {
      return false;
    }
    monitor.pong();
    return true;
  }
}
