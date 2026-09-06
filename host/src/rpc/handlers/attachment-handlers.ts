import {
  finishArtifactImageRequestSchema,
  prepareArtifactImageRequestSchema,
  MAX_ARTIFACT_IMAGE_BYTES,
} from "@traycer/protocol/host/epic/unary-schemas";
import { fetchArtifactAttachmentRequestSchema } from "@traycer/protocol/host/epic/artifact-attachment";
import {
  abortStagedImage,
  commitStagedImage,
  readAttachment,
  stageImage,
} from "../../epic/attachments";
import type { RpcHandler } from "./types";

export const handlePrepareArtifactImage: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = prepareArtifactImageRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const source = parsed.data.source;
  if (source.kind === "remote") {
    // The local plane does not fetch from the network on a client's behalf.
    return {
      ok: true,
      result: {
        ok: false,
        state: "blocked-path",
        message: "This host does not fetch remote images.",
      },
    };
  }
  const bytes = Buffer.from(source.base64, "base64");
  if (bytes.byteLength > MAX_ARTIFACT_IMAGE_BYTES) {
    return {
      ok: true,
      result: {
        ok: false,
        state: "oversized",
        message: "Image exceeds the 30 MB artifact image limit.",
      },
    };
  }
  const stagedImage = await stageImage(runtime, parsed.data.epicId, bytes);
  if (stagedImage === null) {
    return {
      ok: true,
      result: {
        ok: false,
        state: "invalid-image",
        message: "Unsupported image format.",
      },
    };
  }
  return {
    ok: true,
    result: {
      ok: true,
      operationId: stagedImage.operationId,
      attachmentHash: stagedImage.hash,
      mediaType: stagedImage.mediaType,
      src: stagedImage.src,
    },
  };
};

export const handleFinishArtifactImage: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = finishArtifactImageRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  if (!parsed.data.commit) {
    const aborted = await abortStagedImage(parsed.data.operationId);
    return {
      ok: true,
      result: { status: aborted ? "aborted" : "unknown-operation" },
    };
  }
  const committed = await commitStagedImage(runtime, parsed.data.operationId);
  return {
    ok: true,
    result: committed ? { committed: true } : { status: "unknown-operation" },
  };
};

export const handleFetchArtifactAttachment: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = fetchArtifactAttachmentRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const found = await readAttachment(
    runtime,
    parsed.data.epicId,
    parsed.data.hash,
  );
  // An absent attachment is data, never an RPC failure - the contract says so
  // precisely so a caller cannot enumerate what it may not read.
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
