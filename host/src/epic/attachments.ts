import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SupportedImageMediaType } from "@traycer/protocol/persistence/epic/images";
import type { HostRuntime } from "../runtime";

/**
 * Artifact images live per EPIC, not per artifact: an artifact's folder is
 * renamed whenever its title changes (see `artifactIndexPath`), and a moved
 * folder must not orphan the bytes its body references.
 *
 * The `src` an image node carries is `attachments/<sha256>.<ext>` - the hash
 * IS the address, which is what lets a body re-read from `index.md` recover
 * the `attachmentHash` the renderer needs from the markdown link alone.
 */
export const ATTACHMENT_DIR = "attachments";
export const MAX_ARTIFACT_IMAGE_BYTES = 30 * 1024 * 1024;

const IMAGE_TYPES: readonly {
  readonly mediaType: SupportedImageMediaType;
  readonly extension: string;
}[] = [
  { mediaType: "image/png", extension: "png" },
  { mediaType: "image/jpeg", extension: "jpg" },
  { mediaType: "image/gif", extension: "gif" },
  { mediaType: "image/webp", extension: "webp" },
  { mediaType: "image/svg+xml", extension: "svg" },
];

export type StagedImage = {
  readonly operationId: string;
  readonly epicId: string;
  readonly hash: string;
  readonly mediaType: SupportedImageMediaType;
  readonly src: string;
  readonly bytes: Uint8Array;
};

/**
 * Prepared-but-uncommitted images, keyed by `operationId`. The bytes are held
 * in memory, not in a temp file: a prepare whose host died is exactly the
 * `unknown-operation` the contract already has, and nothing outlives the
 * process to be swept later.
 */
const staged = new Map<string, StagedImage>();

export function attachmentsDir(runtime: HostRuntime, epicId: string): string {
  return join(runtime.dataDir, "epics", epicId, ATTACHMENT_DIR);
}

export function attachmentSrc(hash: string, extension: string): string {
  return `${ATTACHMENT_DIR}/${hash}.${extension}`;
}

/** `png` -> `image/png`; `null` for an extension this host never wrote. */
export function mediaTypeForExtension(
  extension: string,
): SupportedImageMediaType | null {
  return (
    IMAGE_TYPES.find((row) => row.extension === extension)?.mediaType ?? null
  );
}

/** `image/png` -> `png`; `null` for a type the renderer cannot display. */
export function extensionFor(mediaType: string): string | null {
  return (
    IMAGE_TYPES.find((row) => row.mediaType === mediaType)?.extension ?? null
  );
}

/**
 * The media type of the BYTES, from their magic bytes - never a caller's
 * claim. `fetchArtifactAttachment` documents its `mediaType` as
 * host-authoritative for this reason.
 */
export function sniffMediaType(
  bytes: Uint8Array,
): SupportedImageMediaType | null {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47])) {
    return "image/png";
  }
  if (starts(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (starts(bytes, [0x47, 0x49, 0x46, 0x38])) {
    return "image/gif";
  }
  if (
    starts(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    starts(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return "image/webp";
  }
  const head = Buffer.from(bytes.subarray(0, 256)).toString("utf8").trimStart();
  if (head.startsWith("<svg") || head.startsWith("<?xml")) {
    return "image/svg+xml";
  }
  return null;
}

export function stageImage(
  epicId: string,
  bytes: Uint8Array,
): StagedImage | null {
  const mediaType = sniffMediaType(bytes);
  const extension = mediaType === null ? null : extensionFor(mediaType);
  if (mediaType === null || extension === null) {
    return null;
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  const entry: StagedImage = {
    operationId: randomUUID(),
    epicId,
    hash,
    mediaType,
    src: attachmentSrc(hash, extension),
    bytes,
  };
  staged.set(entry.operationId, entry);
  return entry;
}

export async function commitStagedImage(
  runtime: HostRuntime,
  operationId: string,
): Promise<boolean> {
  const entry = staged.get(operationId);
  if (entry === undefined) {
    return false;
  }
  await mkdir(attachmentsDir(runtime, entry.epicId), { recursive: true });
  await writeFile(
    join(runtime.dataDir, "epics", entry.epicId, entry.src),
    entry.bytes,
  );
  staged.delete(operationId);
  return true;
}

export function abortStagedImage(operationId: string): boolean {
  return staged.delete(operationId);
}

export async function readAttachment(
  runtime: HostRuntime,
  epicId: string,
  hash: string,
): Promise<{
  readonly bytes: Buffer;
  readonly mediaType: SupportedImageMediaType;
} | null> {
  const dir = attachmentsDir(runtime, epicId);
  for (const row of IMAGE_TYPES) {
    try {
      const bytes = await readFile(join(dir, `${hash}.${row.extension}`));
      const mediaType = sniffMediaType(bytes);
      if (mediaType === null) {
        continue;
      }
      return { bytes, mediaType };
    } catch {
      // Try the next extension; an absent attachment is data, not a failure.
    }
  }
  return null;
}

function starts(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) {
    return false;
  }
  return prefix.every((byte, index) => bytes[index] === byte);
}
