import * as Y from "yjs";
import type { StreamMethodFrameEnvelope } from "@traycer/protocol/framework/stream-ws-protocol";
import {
  notificationsSubscribeClientFrameSchema,
  notificationsSubscribeOpenRequestSchema,
} from "@traycer/protocol/host/notifications/subscribe";
import { HostState } from "./store";

type StreamSend = (data: string | Uint8Array) => void;

export type NotificationsStreamBinding = {
  readonly method: "notifications.subscribe";
  readonly onFrame: (
    envelope: StreamMethodFrameEnvelope,
    binaryPayload: Uint8Array | null,
  ) => void;
  readonly dispose: () => void;
};

export type OpenNotificationsStreamResult =
  | {
      readonly accepted: true;
      readonly binding: NotificationsStreamBinding;
    }
  | {
      readonly accepted: false;
      readonly code: "E_INVALID_ARGUMENT";
      readonly reason: string;
    };

const CLIENT_UPDATE_ORIGIN = Symbol.for("notifications-stream-resolver/client");

export function openNotificationsStream(
  send: StreamSend,
  state: HostState,
  params: unknown,
): OpenNotificationsStreamResult {
  const parsed = notificationsSubscribeOpenRequestSchema.safeParse(params);
  if (!parsed.success) {
    return {
      accepted: false,
      code: "E_INVALID_ARGUMENT",
      reason: parsed.error.message,
    };
  }

  const doc = state.getNotificationsDoc();
  const sendPaired = (frame: unknown, payload: Uint8Array): void => {
    send(JSON.stringify(frame));
    send(payload);
  };
  const onDocUpdate = (update: Uint8Array): void => {
    sendPaired(
      {
        kind: "update",
        hasBinaryPayload: true,
      },
      update,
    );
  };

  doc.on("update", onDocUpdate);
  sendPaired(
    {
      kind: "snapshot",
      meta: { schemaVersion: "1.0.0" },
      hasBinaryPayload: true,
    },
    Y.encodeStateAsUpdate(doc),
  );

  let disposed = false;
  return {
    accepted: true,
    binding: {
      method: "notifications.subscribe",
      onFrame: (envelope, binaryPayload) => {
        const frame =
          notificationsSubscribeClientFrameSchema.safeParse(envelope);
        if (!frame.success) {
          return;
        }
        if (
          frame.data.kind !== "applyUpdate" ||
          !frame.data.hasBinaryPayload ||
          binaryPayload === null
        ) {
          return;
        }
        try {
          Y.applyUpdate(doc, binaryPayload, CLIENT_UPDATE_ORIGIN);
        } catch {
          return;
        }
      },
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        doc.off("update", onDocUpdate);
      },
    },
  };
}
