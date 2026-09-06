import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SupportedImageMediaType } from "@traycer/protocol/persistence/epic/images";
import { sniffMediaType, IMAGE_EXTENSIONS } from "./attachments";
import type { HostRuntime } from "../runtime";

/**
 * Chat image bytes, per EPIC and separate from the artifact store.
 *
 * They are separate stores because they answer to different gates: an
 * artifact attachment is readable by anyone who can open the artifact, while
 * a chat attachment follows its referencing chat's ACL. Sharing one directory
 * would make the two indistinguishable on disk and the narrower gate would be
 * one wrong lookup away from serving the wider one's bytes.
 */
export const CHAT_ATTACHMENT_DIR = "chat-attachments";

export function chatAttachmentsDir(
  runtime: HostRuntime,
  epicId: string,
): string {
  return join(runtime.dataDir, "epics", epicId, CHAT_ATTACHMENT_DIR);
}

export async function readChatAttachment(
  runtime: HostRuntime,
  epicId: string,
  hash: string,
): Promise<{
  readonly bytes: Buffer;
  readonly mediaType: SupportedImageMediaType;
} | null> {
  const dir = chatAttachmentsDir(runtime, epicId);
  for (const extension of IMAGE_EXTENSIONS) {
    try {
      const bytes = await readFile(join(dir, `${hash}.${extension}`));
      // Host-authoritative: the type of the BYTES, never the extension they
      // happen to be filed under.
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
