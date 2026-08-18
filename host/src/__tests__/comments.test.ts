import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { splitConnectionManifest } from "@traycer/protocol/framework/capability-manifest";
import {
  hostFrameSchema,
  type HostFrame,
} from "@traycer/protocol/framework/ws-protocol";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  createCommentThreadResponseSchema,
  createEpicRequestSchema,
  listCommentThreadsResponseSchema,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  commentsListThreadsResponseSchema,
  commentsSetThreadStatusResponseSchema,
} from "@traycer/protocol/host/comments";
import { startHostServer, type HostServer } from "../server";

const EPIC_ID = "epic-comments";
const CONTENT = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "First review note" }],
    },
  ],
} as const;

describe("local host comment threads", () => {
  const servers: HostServer[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    while (servers.length > 0) await servers.pop()?.close();
  });

  it("serves one comment model through GUI CRUD and path-based agent APIs", async () => {
    const server = await startHostServer(0, "host-comments", undefined);
    servers.push(server);
    server.state.createEpic(
      createEpicRequestSchema.parse({
        epic: {
          id: EPIC_ID,
          title: "Comment task",
          initialUserPrompt: "",
          ticketCount: 0,
          specCount: 0,
          storyCount: 0,
          reviewCount: 0,
          status: "active",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          createdBy: "local-user",
          version: "1.0.0",
        },
        repoIdentifiers: [],
        workspaces: [],
        chat: null,
      }),
    );
    const artifact = server.state.createArtifact({
      epicId: EPIC_ID,
      parentId: null,
      artifactType: "spec",
      title: "Spec one",
    });
    const connection = await openRpc(server.websocketUrl, sockets);

    const created = createCommentThreadResponseSchema.parse(
      responseResult(
        await rpc(connection, "create-thread", "epic.createCommentThread", {
          epicId: EPIC_ID,
          artifactType: "spec",
          artifactId: artifact.artifactId,
          content: CONTENT,
          quotedText: "quoted section",
        }),
      ),
    );
    const initial = listCommentThreadsResponseSchema.parse(
      responseResult(
        await rpc(connection, "list-initial", "epic.listCommentThreads", {
          epicId: EPIC_ID,
          artifactType: "spec",
          artifactId: artifact.artifactId,
        }),
      ),
    );
    expect(initial.threads).toEqual([
      {
        threadId: created.threadId,
        resolved: false,
        createdAt: expect.any(Number),
        comments: [
          {
            commentId: expect.any(String),
            content: CONTENT,
            createdAt: expect.any(Number),
            updatedAt: null,
            author: { userId: "local-user", fallbackHandle: null },
          },
        ],
        data: {
          createdByUserId: "local-user",
          createdByHandle: null,
          quotedText: "quoted section",
        },
      },
    ]);
    const firstCommentId = initial.threads[0]?.comments[0]?.commentId;
    if (firstCommentId === undefined) throw new Error("Missing first comment");

    await expectOk(connection, "reply", "epic.replyToCommentThread", {
      epicId: EPIC_ID,
      artifactType: "spec",
      artifactId: artifact.artifactId,
      threadId: created.threadId,
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Follow-up" }],
          },
        ],
      },
    });
    await expectOk(connection, "edit", "epic.editComment", {
      epicId: EPIC_ID,
      artifactType: "spec",
      artifactId: artifact.artifactId,
      threadId: created.threadId,
      commentId: firstCommentId,
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Edited review note" }],
          },
        ],
      },
    });
    await expectOk(connection, "resolve", "epic.setCommentThreadResolved", {
      epicId: EPIC_ID,
      artifactType: "spec",
      artifactId: artifact.artifactId,
      threadId: created.threadId,
      resolved: true,
    });

    const artifactPath = `/Users/remote/.traycer/epics/${EPIC_ID}/artifacts/spec-one/index.md`;
    const aggregated = commentsListThreadsResponseSchema.parse(
      responseResult(
        await rpc(connection, "list-by-path", "comments.listThreads", {
          epicId: EPIC_ID,
          artifactPaths: [artifactPath],
          status: "resolved",
        }),
      ),
    );
    expect(aggregated).toMatchObject({
      artifacts: [
        {
          artifactPath,
          kind: "spec",
          title: "Spec one",
          warning: null,
          threads: [
            {
              thread: {
                threadId: created.threadId,
                resolved: true,
                comments: [
                  {
                    commentId: firstCommentId,
                    updatedAt: expect.any(Number),
                  },
                  { content: expect.any(Object) },
                ],
              },
              anchorStatus: "unavailable",
              anchorOrder: null,
            },
          ],
        },
      ],
    });

    expect(
      commentsSetThreadStatusResponseSchema.parse(
        responseResult(
          await rpc(connection, "reopen-by-path", "comments.setThreadStatus", {
            epicId: EPIC_ID,
            updates: [
              {
                artifactPath,
                threadIds: [created.threadId, "missing-thread"],
                status: "open",
              },
            ],
          }),
        ),
      ),
    ).toEqual({
      updated: [
        {
          artifactPath,
          threadId: created.threadId,
          status: "open",
        },
      ],
      failed: [
        {
          artifactPath,
          threadId: "missing-thread",
          reason: expect.any(String),
        },
      ],
    });

    const afterReopen = listCommentThreadsResponseSchema.parse(
      responseResult(
        await rpc(connection, "list-after-reopen", "epic.listCommentThreads", {
          epicId: EPIC_ID,
          artifactType: "spec",
          artifactId: artifact.artifactId,
        }),
      ),
    );
    const secondCommentId = afterReopen.threads[0]?.comments[1]?.commentId;
    if (secondCommentId === undefined) throw new Error("Missing reply comment");
    expect(afterReopen.threads[0]?.resolved).toBe(false);

    await expectOk(connection, "delete-comment", "epic.deleteComment", {
      epicId: EPIC_ID,
      artifactType: "spec",
      artifactId: artifact.artifactId,
      threadId: created.threadId,
      commentId: secondCommentId,
    });
    await expectOk(connection, "delete-thread", "epic.deleteCommentThread", {
      epicId: EPIC_ID,
      artifactType: "spec",
      artifactId: artifact.artifactId,
      threadId: created.threadId,
    });
    expect(
      listCommentThreadsResponseSchema.parse(
        responseResult(
          await rpc(connection, "list-empty", "epic.listCommentThreads", {
            epicId: EPIC_ID,
            artifactType: "spec",
            artifactId: artifact.artifactId,
          }),
        ),
      ),
    ).toEqual({ threads: [] });
  });
});

type RpcConnection = {
  readonly ws: WebSocket;
  nextRequestId: number;
};

async function openRpc(
  websocketUrl: string,
  sockets: WebSocket[],
): Promise<RpcConnection> {
  const ws = new WebSocket(websocketUrl);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const split = splitConnectionManifest(
    hostRpcRegistry,
    RELEASED_FLOOR_METHOD_NAMES,
  );
  ws.send(
    JSON.stringify({
      kind: "open",
      token: "local",
      manifest: split.manifest,
      optionalManifest: split.optionalManifest,
    }),
  );
  hostFrameSchema.parse(JSON.parse(await nextMessage(ws)));
  return { ws, nextRequestId: 1 };
}

async function rpc(
  connection: RpcConnection,
  label: string,
  method: string,
  params: unknown,
): Promise<HostFrame> {
  const requestId = `${label}-${String(connection.nextRequestId++)}`;
  connection.ws.send(
    JSON.stringify({
      kind: "request",
      requestId,
      method,
      schemaVersion: { major: 1, minor: 0 },
      params,
    }),
  );
  const frame = hostFrameSchema.parse(
    JSON.parse(await nextMessage(connection.ws)),
  );
  expect(frame).toMatchObject({ kind: "response", requestId, error: null });
  return frame;
}

async function expectOk(
  connection: RpcConnection,
  label: string,
  method: string,
  params: unknown,
): Promise<void> {
  expect(responseResult(await rpc(connection, label, method, params))).toEqual({
    ok: true,
  });
}

function responseResult(frame: HostFrame): unknown {
  if (frame.kind !== "response" || frame.error !== null) {
    throw new Error("Expected successful RPC response");
  }
  return frame.result;
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData): void => {
      ws.off("error", onError);
      resolve(data.toString());
    };
    const onError = (error: Error): void => {
      ws.off("message", onMessage);
      reject(error);
    };
    ws.once("message", onMessage);
    ws.once("error", onError);
  });
}
