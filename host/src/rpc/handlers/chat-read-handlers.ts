import { readChatAttachmentRequestSchema } from "@traycer/protocol/host/epic/chat-attachment";
import {
  chatLocateRowRequestSchema,
  chatReadAccumulatedFileChangeRequestSchema,
} from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import { locateTranscriptRowOrdinal } from "@traycer/protocol/persistence/chat-transcript/locate-row";
import {
  projectTranscriptRows,
  type TranscriptRowDescriptor,
} from "@traycer/protocol/persistence/chat-transcript/row-projection";
import { readChatAttachment } from "../../epic/chat-attachments";
import { chatWindowedTranscript } from "../../stream/chat";
import type { RpcHandler } from "./types";
import { changeDigest, readBlob, snapshotDir } from "../../snapshots/snapshots";

/**
 * The ordinal of a row the client cannot place itself, in the epoch it is
 * numbered under.
 *
 * `found: false` is the ONE refusal: no such chat, no matching row, and a
 * chat this caller may not read all collapse into it so the method cannot be
 * used to sort chat ids by which ones exist.
 *
 * The projection is re-run from the SAME input the skeleton is built from, so
 * an index into it names the row the client's skeleton holds at that index. If
 * the two ever disagree in length the answer is withheld rather than sent: a
 * wrong ordinal scrolls somewhere plausible instead of failing visibly, which
 * is worse than not answering.
 */
export const handleChatLocateRow: RpcHandler = (params, runtime) => {
  const parsed = chatLocateRowRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const transcript = chatWindowedTranscript(
    runtime,
    parsed.data.epicId,
    parsed.data.chatId,
  );
  let rows: readonly TranscriptRowDescriptor[];
  try {
    rows = projectTranscriptRows({
      messages: transcript.messages,
      events: [],
      activeTurnId: null,
      chatId: parsed.data.chatId,
    });
  } catch {
    return { ok: true, result: { found: false } };
  }
  if (rows.length !== transcript.skeleton.length) {
    return { ok: true, result: { found: false } };
  }
  const ordinal = locateTranscriptRowOrdinal(
    { rows, messages: transcript.messages },
    parsed.data.target,
  );
  if (ordinal === null) {
    return { ok: true, result: { found: false } };
  }
  return {
    ok: true,
    result: { found: true, ordinal, epoch: transcript.epoch },
  };
};

/**
 * This host records that a file changed - path, operation, turn - but never
 * its contents: every `file_change.completed` it publishes carries
 * `diffSource: "none"` and `reason: "not_intercepted"`, because the harness
 * edits the working tree directly and nothing here intercepts the write.
 *
 * So there is no version of the file behind any digest, and `stale: true` is
 * the honest arm: the client re-reads the summary instead of rendering a diff
 * against contents that were never captured. `stale: false` with two nulls
 * would claim the capture succeeded and produced an empty file.
 */
/**
 * The bodies behind one accumulated-change row.
 *
 * The digest is the row's two hashes, so "stale" is exact rather than
 * revision-based: a request naming any pair but the one on the row now is a
 * request for a version this host no longer describes.
 */
export const handleChatReadAccumulatedFileChange: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = chatReadAccumulatedFileChangeRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const { epicId, chatId, filePath, digest } = parsed.data;
  const chat = runtime.store
    .snapshot()
    .chats.find((row) => row.epicId === epicId && row.chatId === chatId);
  const change = chat?.accumulatedChanges.find(
    (row) => row.filePath === filePath,
  );
  if (
    change === undefined ||
    change.reason !== "snapshot" ||
    changeDigest(change.beforeHash, change.afterHash) !== digest
  ) {
    return { ok: true, result: { stale: true } };
  }
  const dir = snapshotDir(runtime.dataDir);
  return {
    ok: true,
    result: {
      stale: false,
      beforeContent:
        change.beforeHash === null
          ? null
          : await readBlob(dir, change.beforeHash),
      afterContent:
        change.afterHash === null
          ? null
          : await readBlob(dir, change.afterHash),
    },
  };
};

/**
 * One chat image attachment's bytes from this host's own per-epic store.
 *
 * The chat id is the authorization subject, not a lookup key: a hash is a
 * content address, so answering `(epicId, hash)` alone would hand any caller
 * the contents of any chat that happens to live here. The read is gated on
 * the chat existing under the named epic on THIS host, and every failure -
 * unknown chat, unknown hash, nothing published - is the single `missing`
 * arm, which is what keeps it from being an existence oracle.
 */
export const handleReadChatAttachment: RpcHandler = async (params, runtime) => {
  const parsed = readChatAttachmentRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const chat = runtime.store
    .snapshot()
    .chats.find(
      (row) =>
        row.chatId === parsed.data.chatId && row.epicId === parsed.data.epicId,
    );
  if (chat === undefined) {
    return { ok: true, result: { ok: false, reason: "missing" } };
  }
  const found = await readChatAttachment(
    runtime,
    parsed.data.epicId,
    parsed.data.hash,
  );
  if (found === null) {
    return { ok: true, result: { ok: false, reason: "missing" } };
  }
  return {
    ok: true,
    result: {
      ok: true,
      bytesBase64: found.bytes.toString("base64"),
      mediaType: found.mediaType,
    },
  };
};
