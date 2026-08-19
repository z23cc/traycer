import type { SchemaVersion } from "@traycer/protocol/framework";
import type { StreamMethodFrameEnvelope } from "@traycer/protocol/framework/stream-ws-protocol";
import {
  agentInboxSubscribeClientFrameSchema,
  agentInboxSubscribeOpenRequestSchema,
  agentInboxSubscribeServerFrameSchemaV10,
  agentInboxSubscribeServerFrameSchemaV11,
  agentInboxSubscribeServerFrameSchemaV12,
} from "@traycer/protocol/host/agent/inbox";
import type { HostState } from "./store";
import { AgentInboxServiceError } from "./agent-inbox-service";

type StreamSend = (data: string | Uint8Array) => void;

export type AgentInboxStreamBinding = {
  readonly method: "agent.inbox.subscribe";
  readonly onFrame: (
    envelope: StreamMethodFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ) => void;
  readonly dispose: () => void;
};

export type OpenAgentInboxStreamResult =
  | { readonly accepted: true; readonly binding: AgentInboxStreamBinding }
  | {
      readonly accepted: false;
      readonly code: string;
      readonly reason: string;
    };

export function openAgentInboxStream(
  send: StreamSend,
  state: HostState,
  schemaVersion: SchemaVersion,
  params: unknown,
): OpenAgentInboxStreamResult {
  if (
    schemaVersion.major !== 1 ||
    schemaVersion.minor < 0 ||
    schemaVersion.minor > 2
  ) {
    return {
      accepted: false,
      code: "E_HOST_UNSUPPORTED",
      reason: `agent.inbox.subscribe ${schemaVersion.major}.${schemaVersion.minor} is not implemented`,
    };
  }
  const parsed = agentInboxSubscribeOpenRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      accepted: false,
      code: "E_INVALID_ARGUMENT",
      reason: parsed.error.message,
    };
  }
  const { epicId, agentId } = parsed.data;
  const emit = (frame: unknown): void => {
    const projected = projectFrame(schemaVersion, frame);
    if (projected.success) send(JSON.stringify(projected.data));
  };
  let dispose: () => void;
  try {
    dispose = state.subscribeAgentInbox(epicId, agentId, (item) => {
      emit({ kind: "message", hasBinaryPayload: false, item });
      if (schemaVersion.minor < 2) {
        state.acknowledgeAgentInbox({
          epicId,
          agentId,
          eventIds: [item.eventId],
        });
      }
    });
  } catch (error) {
    return {
      accepted: false,
      code:
        error instanceof AgentInboxServiceError
          ? error.code
          : "E_INVALID_ARGUMENT",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    accepted: true,
    binding: {
      method: "agent.inbox.subscribe",
      onFrame: (envelope) => {
        const frame = agentInboxSubscribeClientFrameSchema.safeParse(envelope);
        if (frame.success && frame.data.kind === "ping") {
          emit({ kind: "pong", hasBinaryPayload: false });
        }
      },
      dispose,
    },
  };
}

function projectFrame(schemaVersion: SchemaVersion, frame: unknown) {
  if (schemaVersion.minor >= 2) {
    return agentInboxSubscribeServerFrameSchemaV12.safeParse(frame);
  }
  if (schemaVersion.minor === 1) {
    return agentInboxSubscribeServerFrameSchemaV11.safeParse(frame);
  }
  return agentInboxSubscribeServerFrameSchemaV10.safeParse(frame);
}
