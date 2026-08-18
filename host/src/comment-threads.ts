import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { deriveArtifactPathLayoutRootAgnostic } from "@traycer/protocol/common/artifact-path";
import { artifactBodyFragmentName } from "@traycer/protocol/persistence/epic/artifacts";
import {
  commentThreadWireSchema,
  type CommentThreadWire,
  type CreateCommentThreadRequest,
  type CreateCommentThreadResponse,
  type DeleteCommentRequest,
  type DeleteCommentResponse,
  type DeleteCommentThreadRequest,
  type DeleteCommentThreadResponse,
  type EditCommentRequest,
  type EditCommentResponse,
  type ListCommentThreadsRequest,
  type ListCommentThreadsResponse,
  type ReplyToCommentThreadRequest,
  type ReplyToCommentThreadResponse,
  type ResolveArtifactByPathRequest,
  type ResolveArtifactByPathResponse,
  type SetCommentThreadResolvedRequest,
  type SetCommentThreadResolvedResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import type {
  CommentsListThreadsRequest,
  CommentsListThreadsResponse,
  CommentsSetThreadStatusRequest,
  CommentsSetThreadStatusResponse,
} from "@traycer/protocol/host/comments";
import type { ArtifactRoomManager, StoredArtifactRoom } from "./artifact-rooms";

type CommentEpic = {
  readonly doc: Y.Doc;
  readonly artifactRooms: ArtifactRoomManager;
};

type ArtifactKind = CreateCommentThreadRequest["artifactType"];

type StoredArtifact = {
  readonly artifactId: string;
  readonly kind: ArtifactKind;
  readonly title: string;
  readonly folderName: string;
  readonly parentId: string | null;
  readonly room: StoredArtifactRoom;
};

const COMMENT_THREADS_MAP = "traycerCommentThreads";
const LOCAL_USER_ID = "local-user";

export function createCommentThread(
  epic: CommentEpic,
  request: CreateCommentThreadRequest,
): CreateCommentThreadResponse {
  const artifact = requireArtifact(
    epic,
    request.artifactId,
    request.artifactType,
  );
  const now = Date.now();
  const threadId = randomUUID();
  const thread: CommentThreadWire = {
    threadId,
    resolved: false,
    createdAt: now,
    comments: [
      {
        commentId: randomUUID(),
        content: request.content,
        createdAt: now,
        updatedAt: null,
        author: { userId: LOCAL_USER_ID, fallbackHandle: null },
      },
    ],
    data: {
      createdByUserId: LOCAL_USER_ID,
      createdByHandle: null,
      quotedText: request.quotedText,
    },
  };
  writeThread(artifact, thread);
  return { threadId };
}

export function replyToCommentThread(
  epic: CommentEpic,
  request: ReplyToCommentThreadRequest,
): ReplyToCommentThreadResponse {
  const artifact = requireArtifact(
    epic,
    request.artifactId,
    request.artifactType,
  );
  const thread = requireThread(artifact, request.threadId);
  const now = Date.now();
  writeThread(artifact, {
    ...thread,
    comments: [
      ...thread.comments,
      {
        commentId: randomUUID(),
        content: request.content,
        createdAt: now,
        updatedAt: null,
        author: { userId: LOCAL_USER_ID, fallbackHandle: null },
      },
    ],
  });
  return { ok: true };
}

export function editComment(
  epic: CommentEpic,
  request: EditCommentRequest,
): EditCommentResponse {
  const artifact = requireArtifact(
    epic,
    request.artifactId,
    request.artifactType,
  );
  const thread = requireThread(artifact, request.threadId);
  const commentIndex = thread.comments.findIndex(
    (comment) => comment.commentId === request.commentId,
  );
  if (commentIndex < 0) {
    throw new Error(
      `Comment '${request.commentId}' was not found in thread '${request.threadId}'.`,
    );
  }
  const comments = [...thread.comments];
  const comment = comments[commentIndex];
  if (comment === undefined) throw new Error("Comment index disappeared");
  comments[commentIndex] = {
    ...comment,
    content: request.content,
    updatedAt: Date.now(),
  };
  writeThread(artifact, { ...thread, comments });
  return { ok: true };
}

export function deleteComment(
  epic: CommentEpic,
  request: DeleteCommentRequest,
): DeleteCommentResponse {
  const artifact = requireArtifact(
    epic,
    request.artifactId,
    request.artifactType,
  );
  const thread = requireThread(artifact, request.threadId);
  const comments = thread.comments.filter(
    (comment) => comment.commentId !== request.commentId,
  );
  if (comments.length === thread.comments.length) {
    throw new Error(
      `Comment '${request.commentId}' was not found in thread '${request.threadId}'.`,
    );
  }
  writeThread(artifact, { ...thread, comments });
  return { ok: true };
}

export function setCommentThreadResolved(
  epic: CommentEpic,
  request: SetCommentThreadResolvedRequest,
): SetCommentThreadResolvedResponse {
  const artifact = requireArtifact(
    epic,
    request.artifactId,
    request.artifactType,
  );
  const thread = requireThread(artifact, request.threadId);
  if (thread.resolved !== request.resolved) {
    writeThread(artifact, { ...thread, resolved: request.resolved });
  }
  return { ok: true };
}

export function deleteCommentThread(
  epic: CommentEpic,
  request: DeleteCommentThreadRequest,
): DeleteCommentThreadResponse {
  const artifact = requireArtifact(
    epic,
    request.artifactId,
    request.artifactType,
  );
  const key = threadKey(artifact.artifactId, request.threadId);
  const threads = artifact.room.doc.getMap<unknown>(COMMENT_THREADS_MAP);
  if (!threads.has(key)) {
    throw new Error(`Comment thread '${request.threadId}' was not found.`);
  }
  threads.delete(key);
  return { ok: true };
}

export function listCommentThreads(
  epic: CommentEpic,
  request: ListCommentThreadsRequest,
): ListCommentThreadsResponse {
  const artifact = requireArtifact(
    epic,
    request.artifactId,
    request.artifactType,
  );
  return { threads: readThreads(artifact) };
}

export function listCommentThreadsByPath(
  epicId: string,
  epic: CommentEpic,
  request: CommentsListThreadsRequest,
): CommentsListThreadsResponse {
  const artifacts =
    request.artifactPaths === null
      ? listArtifacts(epic).map((artifact) => ({
          artifact,
          path: artifactPath(epicId, epic, artifact),
        }))
      : request.artifactPaths.flatMap((path) => {
          const artifact = artifactFromPath(epicId, epic, path);
          return artifact === null ? [] : [{ artifact, path }];
        });
  return {
    artifacts: artifacts
      .map(({ artifact, path }) => ({
        artifactPath: path,
        kind: artifact.kind,
        title: artifact.title,
        warning: null,
        threads: readThreads(artifact)
          .filter((thread) =>
            request.status === "all"
              ? true
              : request.status === "resolved"
                ? thread.resolved
                : !thread.resolved,
          )
          .map((thread) => ({
            thread,
            ...anchorState(artifact, thread),
          })),
      }))
      .filter(
        (artifact) =>
          artifact.threads.length > 0 || request.artifactPaths !== null,
      ),
  };
}

export function setCommentThreadStatusByPath(
  epicId: string,
  epic: CommentEpic,
  request: CommentsSetThreadStatusRequest,
): CommentsSetThreadStatusResponse {
  const updated: CommentsSetThreadStatusResponse["updated"] = [];
  const failed: CommentsSetThreadStatusResponse["failed"] = [];
  for (const update of request.updates) {
    const artifact = artifactFromPath(epicId, epic, update.artifactPath);
    for (const threadId of update.threadIds) {
      if (artifact === null) {
        failed.push({
          artifactPath: update.artifactPath,
          threadId,
          reason: "Artifact path does not resolve in this epic.",
        });
        continue;
      }
      const thread = findThread(artifact, threadId);
      if (thread === null) {
        failed.push({
          artifactPath: update.artifactPath,
          threadId,
          reason: `Comment thread '${threadId}' was not found.`,
        });
        continue;
      }
      writeThread(artifact, {
        ...thread,
        resolved: update.status === "resolved",
      });
      updated.push({
        artifactPath: update.artifactPath,
        threadId,
        status: update.status,
      });
    }
  }
  return { updated, failed };
}

export function resolveArtifactByPath(
  epicId: string,
  epic: CommentEpic,
  request: ResolveArtifactByPathRequest,
): ResolveArtifactByPathResponse {
  const artifact = artifactFromPath(epicId, epic, request.filePath);
  return {
    artifact:
      artifact === null
        ? null
        : { artifactId: artifact.artifactId, kind: artifact.kind },
  };
}

function requireArtifact(
  epic: CommentEpic,
  artifactId: string,
  expectedKind: ArtifactKind,
): StoredArtifact {
  const artifact = artifactFromId(epic, artifactId);
  if (artifact === null) {
    throw new Error(`Artifact '${artifactId}' was not found.`);
  }
  if (artifact.kind !== expectedKind) {
    throw new Error(
      `Artifact '${artifactId}' is '${artifact.kind}', not '${expectedKind}'.`,
    );
  }
  return artifact;
}

function artifactFromId(
  epic: CommentEpic,
  artifactId: string,
): StoredArtifact | null {
  const artifacts = epic.doc.getMap<unknown>("epic").get("artifacts");
  if (!(artifacts instanceof Y.Map)) return null;
  const entry = artifacts.get(artifactId);
  if (!(entry instanceof Y.Map)) return null;
  const kind = artifactKind(entry.get("kind") ?? entry.get("type"));
  const roomId = entry.get("artifactRoomId");
  if (kind === null || typeof roomId !== "string") return null;
  const room = epic.artifactRooms.getRoom(roomId);
  if (room === null) return null;
  const title = entry.get("title");
  const folderName = entry.get("folderName");
  const parentId = entry.get("parentId");
  return {
    artifactId,
    kind,
    title: typeof title === "string" ? title : "",
    folderName:
      typeof folderName === "string" && folderName.length > 0
        ? folderName
        : artifactId,
    parentId: typeof parentId === "string" ? parentId : null,
    room,
  };
}

function listArtifacts(epic: CommentEpic): StoredArtifact[] {
  const artifacts = epic.doc.getMap<unknown>("epic").get("artifacts");
  if (!(artifacts instanceof Y.Map)) return [];
  return [...artifacts.keys()]
    .flatMap((artifactId) => {
      const artifact = artifactFromId(epic, artifactId);
      return artifact === null ? [] : [artifact];
    })
    .sort((a, b) => a.artifactId.localeCompare(b.artifactId));
}

function artifactFromPath(
  epicId: string,
  epic: CommentEpic,
  path: string,
): StoredArtifact | null {
  const layout = deriveArtifactPathLayoutRootAgnostic(path, epicId);
  if (layout === null) return null;
  const chain = [...layout.parentSegments, layout.folderName];
  let parentId: string | null = null;
  let found: StoredArtifact | null = null;
  for (const folderName of chain) {
    found =
      listArtifacts(epic).find(
        (artifact) =>
          artifact.parentId === parentId && artifact.folderName === folderName,
      ) ?? null;
    if (found === null) return null;
    parentId = found.artifactId;
  }
  return found;
}

function artifactPath(
  epicId: string,
  epic: CommentEpic,
  artifact: StoredArtifact,
): string {
  const segments = [artifact.folderName];
  let parentId = artifact.parentId;
  const seen = new Set<string>();
  while (parentId !== null && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = artifactFromId(epic, parentId);
    if (parent === null) break;
    segments.unshift(parent.folderName);
    parentId = parent.parentId;
  }
  return join(
    homedir(),
    ".traycer",
    "epics",
    encodeURIComponent(epicId).replaceAll(".", "%2E"),
    "artifacts",
    ...segments,
    "index.md",
  );
}

function threadKey(artifactId: string, threadId: string): string {
  return JSON.stringify([artifactId, threadId]);
}

function writeThread(
  artifact: StoredArtifact,
  thread: CommentThreadWire,
): void {
  artifact.room.doc
    .getMap<unknown>(COMMENT_THREADS_MAP)
    .set(threadKey(artifact.artifactId, thread.threadId), thread);
}

function readThreads(artifact: StoredArtifact): CommentThreadWire[] {
  const prefix = JSON.stringify([artifact.artifactId]).slice(0, -1) + ",";
  return [...artifact.room.doc.getMap<unknown>(COMMENT_THREADS_MAP)]
    .flatMap(([key, value]) => {
      if (!key.startsWith(prefix)) return [];
      const parsed = commentThreadWireSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    })
    .sort(
      (a, b) =>
        a.createdAt - b.createdAt || a.threadId.localeCompare(b.threadId),
    );
}

function findThread(
  artifact: StoredArtifact,
  threadId: string,
): CommentThreadWire | null {
  const parsed = commentThreadWireSchema.safeParse(
    artifact.room.doc
      .getMap<unknown>(COMMENT_THREADS_MAP)
      .get(threadKey(artifact.artifactId, threadId)),
  );
  return parsed.success ? parsed.data : null;
}

function requireThread(
  artifact: StoredArtifact,
  threadId: string,
): CommentThreadWire {
  const thread = findThread(artifact, threadId);
  if (thread === null) {
    throw new Error(`Comment thread '${threadId}' was not found.`);
  }
  return thread;
}

function anchorState(
  artifact: StoredArtifact,
  thread: CommentThreadWire,
): {
  readonly anchorStatus: "present" | "missing" | "unavailable";
  readonly anchorOrder: number | null;
  readonly anchorWarning: string | null;
} {
  const quotedText = thread.data.quotedText?.trim() ?? "";
  const body = artifact.room.doc
    .getXmlFragment(artifactBodyFragmentName(artifact.artifactId))
    .toString();
  if (quotedText.length === 0 || body.length === 0) {
    return {
      anchorStatus: "unavailable",
      anchorOrder: null,
      anchorWarning: null,
    };
  }
  const position = body.indexOf(quotedText);
  return position < 0
    ? { anchorStatus: "missing", anchorOrder: null, anchorWarning: null }
    : { anchorStatus: "present", anchorOrder: position, anchorWarning: null };
}

function artifactKind(value: unknown): ArtifactKind | null {
  return value === "spec" ||
    value === "ticket" ||
    value === "story" ||
    value === "review"
    ? value
    : null;
}
