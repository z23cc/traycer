import { gitStreamFileAssetOpenRequestSchema } from "@traycer/protocol/host/git-asset-stream";
import { workspaceStreamAssetOpenRequestSchema } from "@traycer/protocol/host/workspace/asset-stream";
import {
  AssetStreamSession,
  readGitAsset,
  readWorkspaceAsset,
} from "../workspace/asset-stream";

/**
 * The two asset methods, resolved to bytes and handed to the one session that
 * knows the frame sequence. They differ only in how the file is addressed.
 */
export async function serveAsset(
  session: AssetStreamSession,
  method: string,
  params: unknown,
): Promise<void> {
  const asset =
    method === "workspace.streamAsset"
      ? await workspaceAsset(params)
      : await gitAsset(params);
  if (typeof asset === "string") {
    session.fail(asset, `The asset could not be served (${asset}).`);
    return;
  }
  session.serve(asset);
}

async function workspaceAsset(params: unknown) {
  const parsed = workspaceStreamAssetOpenRequestSchema.safeParse(params);
  if (!parsed.success) {
    return "not-found" as const;
  }
  return readWorkspaceAsset(parsed.data.workspacePath, parsed.data.filePath);
}

async function gitAsset(params: unknown) {
  const parsed = gitStreamFileAssetOpenRequestSchema.safeParse(params);
  if (!parsed.success) {
    return "not-found" as const;
  }
  return readGitAsset(parsed.data);
}
