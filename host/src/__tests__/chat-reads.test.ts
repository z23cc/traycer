import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  handleChatLocateRow,
  handleChatReadAccumulatedFileChange,
  handleReadChatAttachment,
} from "../rpc/handlers/chat-read-handlers";
import { chatAttachmentsDir } from "../epic/chat-attachments";
import { chatWindowedTranscript } from "../stream/chat";
import type { StoredChat, StoredTurn } from "../store/host-store";
import { startHost, type StartedHost } from "../start-host";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("chat reads", () => {
  let started: StartedHost | null = null;
  let tempDir: string | null = null;

  afterEach(async () => {
    if (started !== null) {
      await started.close();
      started = null;
    }
    if (tempDir !== null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("locates a row by message id in the epoch the window is seated on", async () => {
    await boot();
    const host = requireHost();
    await seedChat(host, 7);
    const transcript = chatWindowedTranscript(host.runtime, "epic-1", "chat-1");
    // The window's coordinate space is `transcriptEpoch` - the same number the
    // snapshot seats the client on - not a hard-coded 0.
    expect(transcript.epoch).toBe(7);

    const located = handleChatLocateRow(
      {
        epicId: "epic-1",
        chatId: "chat-1",
        target: { kind: "message", messageId: "m-2" },
      },
      host.runtime,
    );
    if (!(await located).ok) {
      throw new Error("locate failed");
    }
    const result = await located;
    expect(result).toMatchObject({
      ok: true,
      result: { found: true, epoch: 7 },
    });
    const ordinal = (result as { result: { ordinal: number } }).result.ordinal;
    expect(transcript.skeleton[ordinal]?.rowId).toBe("m-2");
  });

  it("keeps the epoch across an append, and moves only the index revision", async () => {
    await boot();
    const host = requireHost();
    await seedChat(host, 3);
    const before = chatWindowedTranscript(host.runtime, "epic-1", "chat-1");
    await host.runtime.store.mutate((state) => {
      const chat = state.chats.find((row) => row.chatId === "chat-1");
      if (chat === undefined) {
        throw new Error("seed missing");
      }
      chat.turns.push(turn("m-3", 3, "user"));
      chat.indexRevision += 1;
    });
    const after = chatWindowedTranscript(host.runtime, "epic-1", "chat-1");
    // Appending renumbers no existing ordinal, so it is NOT a rebase: an epoch
    // bump here would make the client re-hydrate its whole window every turn.
    expect(after.epoch).toBe(before.epoch);
    expect(after.skeleton).toHaveLength(before.skeleton.length + 1);
  });

  it("refuses an unknown row, chat and epic with the one opaque answer", async () => {
    await boot();
    const host = requireHost();
    await seedChat(host, 0);
    for (const request of [
      {
        epicId: "epic-1",
        chatId: "chat-1",
        target: { kind: "message", messageId: "nope" },
      },
      {
        epicId: "epic-1",
        chatId: "other",
        target: { kind: "message", messageId: "m-1" },
      },
      {
        epicId: "other",
        chatId: "chat-1",
        target: { kind: "message", messageId: "m-1" },
      },
    ]) {
      const answer = await handleChatLocateRow(request, host.runtime);
      expect(answer).toEqual({ ok: true, result: { found: false } });
    }
  });

  it("calls an accumulated change stale, since no contents were captured", async () => {
    await boot();
    const host = requireHost();
    const answer = await handleChatReadAccumulatedFileChange(
      {
        epicId: "epic-1",
        chatId: "chat-1",
        filePath: "src/main.ts",
        digest: "whatever",
      },
      host.runtime,
    );
    expect(answer).toEqual({ ok: true, result: { stale: true } });
  });

  it("serves a chat attachment only for a chat that lives under the epic", async () => {
    await boot();
    const host = requireHost();
    await seedChat(host, 0);
    const hash = createHash("sha256").update(PNG).digest("hex");
    const dir = chatAttachmentsDir(host.runtime, "epic-1");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${hash}.png`), PNG);

    const found = await handleReadChatAttachment(
      { epicId: "epic-1", chatId: "chat-1", hash },
      host.runtime,
    );
    expect(found).toEqual({
      ok: true,
      result: {
        ok: true,
        bytesBase64: PNG.toString("base64"),
        mediaType: "image/png",
      },
    });

    // A hash is a content address, not a capability: naming a chat that does
    // not live here is `missing`, never the bytes and never a distinct error.
    for (const request of [
      { epicId: "epic-1", chatId: "not-a-chat", hash },
      { epicId: "epic-1", chatId: "chat-1", hash: "b".repeat(64) },
    ]) {
      expect(await handleReadChatAttachment(request, host.runtime)).toEqual({
        ok: true,
        result: { ok: false, reason: "missing" },
      });
    }
  });

  function requireHost(): StartedHost {
    if (started === null) {
      throw new Error("host not started");
    }
    return started;
  }

  async function boot(): Promise<void> {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
  }
});

async function seedChat(host: StartedHost, epoch: number): Promise<void> {
  const chat: StoredChat = {
    epicId: "epic-1",
    chatId: "chat-1",
    parentId: null,
    hostId: host.runtime.hostId,
    title: "Root",
    createdAt: 1,
    runSettings: null,
    providerSession: null,
    turns: [turn("m-1", 1, "user"), turn("m-2", 2, "user")],
    events: [],
    transcriptEpoch: epoch,
    indexRevision: 0,
    fileChangeCount: 0,
    lastUsage: null,
    archivedAt: null,
    fastMode: false,
  };
  await host.runtime.store.mutate((state) => {
    state.chats.push(chat);
  });
}

function turn(
  messageId: string,
  timestamp: number,
  role: "user" | "assistant",
): StoredTurn {
  return {
    messageId,
    timestamp,
    role,
    prompt: `message ${messageId}`,
    fromAgentId: "chat-1",
    fromTitle: "",
    fromHarnessId: null,
    expectReply: false,
    responseId: null,
    userId: "local",
    content: null,
    turnId: null,
  };
}
