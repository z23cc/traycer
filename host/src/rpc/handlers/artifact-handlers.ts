import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import {
  commentsListThreadsRequestSchema,
  commentsSetThreadStatusRequestSchema,
} from "@traycer/protocol/host/comments/schemas";
import {
  createArtifactRequestSchema,
  createCommentThreadRequestSchema,
  deleteArtifactRequestSchema,
  deleteCommentRequestSchema,
  deleteCommentThreadRequestSchema,
  editCommentRequestSchema,
  epicArtifactMentionId,
  epicArtifactMentionToken,
  epicMentionArtifactsRequestSchema,
  listCommentThreadsRequestSchema,
  renameArtifactRequestSchema,
  reparentArtifactRequestSchema,
  replyToCommentThreadRequestSchema,
  resolveArtifactByPathRequestSchema,
  setCommentThreadResolvedRequestSchema,
  updateArtifactStatusRequestSchema,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  artifactRelativePath,
  createArtifact,
  deleteArtifact,
  findArtifact,
  renameArtifact,
  reparentArtifact,
  resolveArtifactByPath,
  updateArtifactStatus,
} from "../../epic/artifacts";
import type { HostRuntime } from "../../runtime";
import {
  createCommentThread,
  deleteComment,
  deleteCommentThread,
  editComment,
  listCommentsArtifacts,
  listCommentThreads,
  replyToCommentThread,
  setCommentThreadResolved,
  setThreadStatusByPath,
} from "../../epic/comments";
import { publishEpic } from "../../stream/epic-hub";
import type { RpcHandler, RpcHandlerResult } from "./types";

export const handleEpicCreateArtifact: RpcHandler = async (params, runtime) => {
  const parsed = createArtifactRequestSchema.safeParse(params);
  if (!parsed.success) {
    return fail(parsed.error.message);
  }
  const artifactId = await createArtifact(
    runtime,
    parsed.data.epicId,
    parsed.data.parentId,
    parsed.data.artifactType,
    parsed.data.title,
  );
  if (artifactId === null) {
    return fail("Epic or parent artifact not found");
  }
  await publishEpic(runtime, parsed.data.epicId);
  return { ok: true, result: { artifactId } };
};

export const handleEpicDeleteArtifact: RpcHandler = async (params, runtime) => {
  const parsed = deleteArtifactRequestSchema.safeParse(params);
  if (!parsed.success) {
    return fail(parsed.error.message);
  }
  const deleted = await deleteArtifact(
    runtime,
    parsed.data.epicId,
    parsed.data.artifactId,
  );
  if (deleted) {
    await publishEpic(runtime, parsed.data.epicId);
  }
  return { ok: true, result: { deleted } };
};

export const handleEpicRenameArtifact: RpcHandler = async (params, runtime) => {
  const parsed = renameArtifactRequestSchema.safeParse(params);
  if (!parsed.success) {
    return fail(parsed.error.message);
  }
  const updated = await renameArtifact(
    runtime,
    parsed.data.epicId,
    parsed.data.artifactId,
    parsed.data.title,
  );
  if (updated) {
    await publishEpic(runtime, parsed.data.epicId);
  }
  return { ok: true, result: { updated } };
};

export const handleEpicUpdateArtifactStatus: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = updateArtifactStatusRequestSchema.safeParse(params);
  if (!parsed.success) {
    return fail(parsed.error.message);
  }
  const existing = findArtifact(
    runtime,
    parsed.data.epicId,
    parsed.data.artifactId,
  );
  if (existing === null || existing.kind !== parsed.data.artifactType) {
    return { ok: true, result: { updated: false } };
  }
  const updated = await updateArtifactStatus(
    runtime,
    parsed.data.epicId,
    parsed.data.artifactId,
    parsed.data.status,
  );
  if (updated) {
    await publishEpic(runtime, parsed.data.epicId);
  }
  return { ok: true, result: { updated } };
};

export const handleEpicReparentArtifact: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = reparentArtifactRequestSchema.safeParse(params);
  if (!parsed.success) {
    return fail(parsed.error.message);
  }
  const updated = await reparentArtifact(
    runtime,
    parsed.data.epicId,
    parsed.data.artifactId,
    parsed.data.newParentId,
  );
  if (updated) {
    await publishEpic(runtime, parsed.data.epicId);
  }
  return { ok: true, result: { updated } };
};

export const handleEpicResolveArtifactByPath: RpcHandler = (
  params,
  runtime,
) => {
  const parsed = resolveArtifactByPathRequestSchema.safeParse(params);
  if (!parsed.success) {
    return fail(parsed.error.message);
  }
  const found = resolveArtifactByPath(
    runtime,
    parsed.data.epicId,
    parsed.data.filePath,
  );
  if (found === null || !isArtifactKind(found.kind)) {
    return { ok: true, result: { artifact: null } };
  }
  return {
    ok: true,
    result: { artifact: { artifactId: found.artifactId, kind: found.kind } },
  };
};

export const handleEpicMentionSpecs: RpcHandler = (params, runtime) =>
  mentionArtifacts(params, runtime, "spec");

export const handleEpicMentionTickets: RpcHandler = (params, runtime) =>
  mentionArtifacts(params, runtime, "ticket");

export const handleEpicMentionStories: RpcHandler = (params, runtime) =>
  mentionArtifacts(params, runtime, "story");

export const handleEpicMentionReviews: RpcHandler = (params, runtime) =>
  mentionArtifacts(params, runtime, "review");

export const handleEpicCreateCommentThread: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = createCommentThreadRequestSchema.safeParse(params);
  if (!parsed.success) {
    return fail(parsed.error.message);
  }
  const threadId = await createCommentThread(
    runtime,
    parsed.data.epicId,
    parsed.data.artifactType,
    parsed.data.artifactId,
    parsed.data.content,
    parsed.data.quotedText,
  );
  if (threadId === null) {
    return fail("Artifact not found");
  }
  return { ok: true, result: { threadId } };
};

export const handleEpicReplyToCommentThread: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = replyToCommentThreadRequestSchema.safeParse(params);
  if (!parsed.success) {
    return fail(parsed.error.message);
  }
  const ok = await replyToCommentThread(
    runtime,
    parsed.data.epicId,
    parsed.data.artifactType,
    parsed.data.artifactId,
    parsed.data.threadId,
    parsed.data.content,
  );
  if (!ok) {
    return fail("Comment thread not found");
  }
  return { ok: true, result: { ok: true } };
};

export const handleEpicEditComment: RpcHandler = async (params, runtime) => {
  const parsed = editCommentRequestSchema.safeParse(params);
  if (!parsed.success) {
    return fail(parsed.error.message);
  }
  const ok = await editComment(
    runtime,
    parsed.data.epicId,
    parsed.data.artifactType,
    parsed.data.artifactId,
    parsed.data.threadId,
    parsed.data.commentId,
    parsed.data.content,
  );
  if (!ok) {
    return fail("Comment not found");
  }
  return { ok: true, result: { ok: true } };
};

export const handleEpicDeleteComment: RpcHandler = async (params, runtime) => {
  const parsed = deleteCommentRequestSchema.safeParse(params);
  if (!parsed.success) {
    return fail(parsed.error.message);
  }
  const ok = await deleteComment(
    runtime,
    parsed.data.epicId,
    parsed.data.artifactType,
    parsed.data.artifactId,
    parsed.data.threadId,
    parsed.data.commentId,
  );
  if (!ok) {
    return fail("Comment not found");
  }
  return { ok: true, result: { ok: true } };
};

export const handleEpicSetCommentThreadResolved: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = setCommentThreadResolvedRequestSchema.safeParse(params);
  if (!parsed.success) {
    return fail(parsed.error.message);
  }
  const ok = await setCommentThreadResolved(
    runtime,
    parsed.data.epicId,
    parsed.data.artifactType,
    parsed.data.artifactId,
    parsed.data.threadId,
    parsed.data.resolved,
  );
  if (!ok) {
    return fail("Comment thread not found");
  }
  return { ok: true, result: { ok: true } };
};

export const handleEpicDeleteCommentThread: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = deleteCommentThreadRequestSchema.safeParse(params);
  if (!parsed.success) {
    return fail(parsed.error.message);
  }
  const ok = await deleteCommentThread(
    runtime,
    parsed.data.epicId,
    parsed.data.artifactType,
    parsed.data.artifactId,
    parsed.data.threadId,
  );
  if (!ok) {
    return fail("Comment thread not found");
  }
  return { ok: true, result: { ok: true } };
};

export const handleEpicListCommentThreads: RpcHandler = (params, runtime) => {
  const parsed = listCommentThreadsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return fail(parsed.error.message);
  }
  return {
    ok: true,
    result: {
      threads: listCommentThreads(
        runtime,
        parsed.data.epicId,
        parsed.data.artifactType,
        parsed.data.artifactId,
      ),
    },
  };
};

export const handleCommentsListThreads: RpcHandler = (params, runtime) => {
  const parsed = commentsListThreadsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return fail(parsed.error.message);
  }
  return {
    ok: true,
    result: {
      artifacts: listCommentsArtifacts(
        runtime,
        parsed.data.epicId,
        parsed.data.artifactPaths,
        parsed.data.status,
      ),
    },
  };
};

export const handleCommentsSetThreadStatus: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = commentsSetThreadStatusRequestSchema.safeParse(params);
  if (!parsed.success) {
    return fail(parsed.error.message);
  }
  const updated: {
    artifactPath: string;
    threadId: string;
    status: "open" | "resolved";
  }[] = [];
  const failed: {
    artifactPath: string;
    threadId: string;
    reason: string;
  }[] = [];
  for (const update of parsed.data.updates) {
    const result = await setThreadStatusByPath(
      runtime,
      parsed.data.epicId,
      update.artifactPath,
      update.threadIds,
      update.status === "resolved",
    );
    updated.push(...result.updated);
    failed.push(...result.failed);
  }
  return { ok: true, result: { updated, failed } };
};

function mentionArtifacts(
  params: unknown,
  runtime: HostRuntime,
  artifactType: EpicArtifactKind,
): RpcHandlerResult {
  const parsed = epicMentionArtifactsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return fail(parsed.error.message);
  }
  const snapshot = runtime.store.snapshot();
  const query = parsed.data.query.toLowerCase();
  const entries = snapshot.artifacts
    .filter((row) => row.kind === artifactType)
    .filter(
      (row) => query.length === 0 || row.title.toLowerCase().includes(query),
    )
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, parsed.data.limit)
    .map((row) => {
      const epic = snapshot.epics.find((entry) => entry.id === row.epicId);
      return {
        kind: "epic-artifact" as const,
        id: epicArtifactMentionId(artifactType, row.epicId, row.artifactId),
        token: epicArtifactMentionToken(
          artifactType,
          row.epicId,
          row.artifactId,
        ),
        epicId: row.epicId,
        epicTitle: epic === undefined ? "" : epic.title,
        artifactId: row.artifactId,
        artifactType,
        label: row.title,
        description: artifactRelativePath(row),
        status: row.status,
        updatedAt: row.updatedAt,
      };
    });
  return { ok: true, result: { entries } };
}

function isArtifactKind(kind: string): kind is EpicArtifactKind {
  return (
    kind === "spec" ||
    kind === "ticket" ||
    kind === "story" ||
    kind === "review"
  );
}

function fail(message: string): RpcHandlerResult {
  return { ok: false, code: "RPC_ERROR", message };
}
