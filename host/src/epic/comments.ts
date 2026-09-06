import { randomUUID } from "node:crypto";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  CommentsListArtifact,
  CommentThreadStatusFilter,
} from "@traycer/protocol/host/comments/schemas";
import type { CommentThreadWire } from "@traycer/protocol/host/epic/unary-schemas";
import { LOCAL_USER_ID } from "../local-user";
import type { HostRuntime } from "../runtime";
import type { StoredComment, StoredCommentThread } from "../store/host-store";
import { artifactRelativePath, findArtifact } from "./artifacts";

const LOCAL_HANDLE = "local";

export async function createCommentThread(
  runtime: HostRuntime,
  epicId: string,
  artifactType: string,
  artifactId: string,
  content: JsonContent,
  quotedText: string,
): Promise<string | null> {
  if (!artifactMatches(runtime, epicId, artifactId, artifactType)) {
    return null;
  }
  const threadId = randomUUID();
  const now = Date.now();
  await runtime.store.mutate((state) => {
    state.commentThreads.push({
      epicId,
      artifactType,
      artifactId,
      threadId,
      createdAt: now,
      createdByUserId: LOCAL_USER_ID,
      quotedText,
      resolved: false,
      comments: [newComment(content, now)],
    });
  });
  return threadId;
}

export async function replyToCommentThread(
  runtime: HostRuntime,
  epicId: string,
  artifactType: string,
  artifactId: string,
  threadId: string,
  content: JsonContent,
): Promise<boolean> {
  const thread = findThread(runtime, epicId, artifactId, threadId);
  if (thread === null || thread.artifactType !== artifactType) {
    return false;
  }
  const now = Date.now();
  await runtime.store.mutate((state) => {
    const row = mutateThread(
      state.commentThreads,
      epicId,
      artifactId,
      threadId,
    );
    if (row === null) {
      return;
    }
    row.comments.push(newComment(content, now));
  });
  return true;
}

export async function editComment(
  runtime: HostRuntime,
  epicId: string,
  artifactType: string,
  artifactId: string,
  threadId: string,
  commentId: string,
  content: JsonContent,
): Promise<boolean> {
  const thread = findThread(runtime, epicId, artifactId, threadId);
  if (thread === null || thread.artifactType !== artifactType) {
    return false;
  }
  const now = Date.now();
  const updated = await runtime.store.mutate((state) => {
    const row = mutateThread(
      state.commentThreads,
      epicId,
      artifactId,
      threadId,
    );
    if (row === null) {
      return false;
    }
    const comment = row.comments.find((entry) => entry.commentId === commentId);
    if (comment === undefined) {
      return false;
    }
    comment.content = content;
    comment.updatedAt = now;
    return true;
  });
  return updated;
}

export async function deleteComment(
  runtime: HostRuntime,
  epicId: string,
  artifactType: string,
  artifactId: string,
  threadId: string,
  commentId: string,
): Promise<boolean> {
  const thread = findThread(runtime, epicId, artifactId, threadId);
  if (thread === null || thread.artifactType !== artifactType) {
    return false;
  }
  return runtime.store.mutate((state) => {
    const row = mutateThread(
      state.commentThreads,
      epicId,
      artifactId,
      threadId,
    );
    if (row === null) {
      return false;
    }
    const before = row.comments.length;
    row.comments = row.comments.filter(
      (entry) => entry.commentId !== commentId,
    );
    return row.comments.length !== before;
  });
}

export async function setCommentThreadResolved(
  runtime: HostRuntime,
  epicId: string,
  artifactType: string,
  artifactId: string,
  threadId: string,
  resolved: boolean,
): Promise<boolean> {
  const thread = findThread(runtime, epicId, artifactId, threadId);
  if (thread === null || thread.artifactType !== artifactType) {
    return false;
  }
  await runtime.store.mutate((state) => {
    const row = mutateThread(
      state.commentThreads,
      epicId,
      artifactId,
      threadId,
    );
    if (row !== null) {
      row.resolved = resolved;
    }
  });
  return true;
}

export async function deleteCommentThread(
  runtime: HostRuntime,
  epicId: string,
  artifactType: string,
  artifactId: string,
  threadId: string,
): Promise<boolean> {
  const thread = findThread(runtime, epicId, artifactId, threadId);
  if (thread === null || thread.artifactType !== artifactType) {
    return false;
  }
  await runtime.store.mutate((state) => {
    state.commentThreads = state.commentThreads.filter(
      (row) =>
        !(
          row.epicId === epicId &&
          row.artifactId === artifactId &&
          row.threadId === threadId
        ),
    );
  });
  return true;
}

export function listCommentThreads(
  runtime: HostRuntime,
  epicId: string,
  artifactType: string,
  artifactId: string,
): CommentThreadWire[] {
  return runtime.store
    .snapshot()
    .commentThreads.filter(
      (row) =>
        row.epicId === epicId &&
        row.artifactType === artifactType &&
        row.artifactId === artifactId,
    )
    .sort((left, right) => left.createdAt - right.createdAt)
    .map(toWire);
}

export function listCommentsArtifacts(
  runtime: HostRuntime,
  epicId: string,
  artifactPaths: readonly string[] | null,
  status: CommentThreadStatusFilter,
): CommentsListArtifact[] {
  const snapshot = runtime.store.snapshot();
  const artifacts = snapshot.artifacts.filter((row) => row.epicId === epicId);
  const threads = snapshot.commentThreads.filter(
    (row) => row.epicId === epicId,
  );
  const wantedPaths = artifactPaths === null ? null : new Set(artifactPaths);
  const grouped = new Map<string, StoredCommentThread[]>();
  for (const thread of threads) {
    if (!statusMatches(thread.resolved, status)) {
      continue;
    }
    const artifact = artifacts.find(
      (row) => row.artifactId === thread.artifactId,
    );
    const path =
      artifact === undefined
        ? `artifacts/${thread.artifactId}/index.md`
        : artifactRelativePath(artifact);
    if (wantedPaths !== null && !wantedPaths.has(path)) {
      continue;
    }
    const bucket = grouped.get(path);
    if (bucket === undefined) {
      grouped.set(path, [thread]);
    } else {
      bucket.push(thread);
    }
  }
  if (wantedPaths !== null) {
    for (const path of wantedPaths) {
      if (!grouped.has(path)) {
        grouped.set(path, []);
      }
    }
  }
  const rows: CommentsListArtifact[] = [];
  for (const [artifactPath, bucket] of grouped) {
    const artifact =
      artifacts.find((row) => artifactRelativePath(row) === artifactPath) ??
      artifacts.find((row) => row.artifactId === pathArtifactId(artifactPath));
    rows.push({
      artifactPath,
      kind:
        artifact !== undefined && isArtifactKind(artifact.kind)
          ? artifact.kind
          : "spec",
      title: artifact === undefined ? artifactPath : artifact.title,
      warning: artifact === undefined ? "artifact missing" : null,
      threads: bucket
        .sort((left, right) => left.createdAt - right.createdAt)
        .map((thread, index) => ({
          thread: toWire(thread),
          anchorStatus: artifact === undefined ? "missing" : "present",
          anchorOrder: index,
          anchorWarning: null,
        })),
    });
  }
  return rows.sort((left, right) =>
    left.artifactPath.localeCompare(right.artifactPath),
  );
}

export async function setThreadStatusByPath(
  runtime: HostRuntime,
  epicId: string,
  artifactPath: string,
  threadIds: readonly string[],
  resolved: boolean,
): Promise<{
  readonly updated: readonly {
    readonly artifactPath: string;
    readonly threadId: string;
    readonly status: "open" | "resolved";
  }[];
  readonly failed: readonly {
    readonly artifactPath: string;
    readonly threadId: string;
    readonly reason: string;
  }[];
}> {
  const artifact = runtime.store
    .snapshot()
    .artifacts.find(
      (row) =>
        row.epicId === epicId && artifactRelativePath(row) === artifactPath,
    );
  const status = resolved ? "resolved" : "open";
  if (artifact === undefined) {
    return {
      updated: [],
      failed: threadIds.map((threadId) => ({
        artifactPath,
        threadId,
        reason: "artifact missing",
      })),
    };
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
  for (const threadId of threadIds) {
    const ok = await setCommentThreadResolved(
      runtime,
      epicId,
      artifact.kind,
      artifact.artifactId,
      threadId,
      resolved,
    );
    if (ok) {
      updated.push({ artifactPath, threadId, status });
    } else {
      failed.push({ artifactPath, threadId, reason: "thread missing" });
    }
  }
  return { updated, failed };
}

function artifactMatches(
  runtime: HostRuntime,
  epicId: string,
  artifactId: string,
  artifactType: string,
): boolean {
  const artifact = findArtifact(runtime, epicId, artifactId);
  return artifact !== null && artifact.kind === artifactType;
}

function findThread(
  runtime: HostRuntime,
  epicId: string,
  artifactId: string,
  threadId: string,
): StoredCommentThread | null {
  return (
    runtime.store
      .snapshot()
      .commentThreads.find(
        (row) =>
          row.epicId === epicId &&
          row.artifactId === artifactId &&
          row.threadId === threadId,
      ) ?? null
  );
}

function mutateThread(
  rows: StoredCommentThread[],
  epicId: string,
  artifactId: string,
  threadId: string,
): StoredCommentThread | null {
  return (
    rows.find(
      (row) =>
        row.epicId === epicId &&
        row.artifactId === artifactId &&
        row.threadId === threadId,
    ) ?? null
  );
}

function newComment(content: JsonContent, now: number): StoredComment {
  return {
    commentId: randomUUID(),
    content,
    createdAt: now,
    updatedAt: null,
    authorUserId: LOCAL_USER_ID,
    authorHandle: LOCAL_HANDLE,
  };
}

function toWire(thread: StoredCommentThread): CommentThreadWire {
  return {
    threadId: thread.threadId,
    resolved: thread.resolved,
    createdAt: thread.createdAt,
    comments: thread.comments.map((comment) => ({
      commentId: comment.commentId,
      content: comment.content,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      author: {
        userId: comment.authorUserId,
        fallbackHandle: comment.authorHandle,
      },
    })),
    data: {
      createdByUserId: thread.createdByUserId,
      createdByHandle: LOCAL_HANDLE,
      quotedText: thread.quotedText,
    },
  };
}

function statusMatches(
  resolved: boolean,
  status: CommentThreadStatusFilter,
): boolean {
  if (status === "all") {
    return true;
  }
  if (status === "open") {
    return !resolved;
  }
  return resolved;
}

function pathArtifactId(artifactPath: string): string {
  const parts = artifactPath.split("/");
  return parts.length >= 2 ? (parts[parts.length - 2] ?? "") : "";
}

function isArtifactKind(
  kind: string,
): kind is "spec" | "ticket" | "story" | "review" {
  return (
    kind === "spec" ||
    kind === "ticket" ||
    kind === "story" ||
    kind === "review"
  );
}
