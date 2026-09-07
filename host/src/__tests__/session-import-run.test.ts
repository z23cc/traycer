import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionImportRunServerFrameSchema } from "@traycer/protocol/host/session-import/run";
import {
  readProvider,
  type DiscoveredSession,
} from "../session-import/discover";
import {
  chatIdFor,
  importSession,
  readTranscript,
} from "../session-import/import";
import { SessionImportRuns } from "../stream/session-import-run";
import { startHost, type StartedHost } from "../start-host";

type Frame = { readonly kind: string; readonly [key: string]: unknown };

/** Parses every frame through the contract's own union. */
class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  readonly frames: Frame[] = [];

  send(payload: string): void {
    this.frames.push(
      sessionImportRunServerFrameSchema.parse(JSON.parse(payload)) as Frame,
    );
  }
}

describe("sessionImport.run", () => {
  let started: StartedHost | null = null;
  const dirs: string[] = [];

  afterEach(async () => {
    if (started !== null) {
      await started.close();
      started = null;
    }
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("derives a stable UUID-shaped chat id from the pair alone", () => {
    const id = chatIdFor({ harness: "claude", nativeSessionId: "abc" });
    expect(id).toBe(chatIdFor({ harness: "claude", nativeSessionId: "abc" }));
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    // The harness is part of the key, not decoration.
    expect(id).not.toBe(
      chatIdFor({ harness: "codex", nativeSessionId: "abc" }),
    );
  });

  it("reads the conversation and leaves the agent's working out of it", () => {
    const root = temp();
    const file = join(root, "s.jsonl");
    writeFileSync(
      file,
      lines([
        { type: "mode", sessionId: "s" },
        // Claude's own resume caveat: a message, never the user's prompt.
        {
          type: "user",
          isMeta: true,
          timestamp: "2026-09-01T10:00:00.000Z",
          message: { role: "user", content: "Caveat: resumed" },
        },
        {
          type: "user",
          timestamp: "2026-09-01T10:00:01.000Z",
          message: { role: "user", content: "fix the parser" },
        },
        {
          type: "assistant",
          timestamp: "2026-09-01T10:00:02.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hmm" },
              { type: "text", text: "Done." },
              { type: "tool_use", name: "Edit" },
            ],
          },
        },
        // A subagent's own conversation, not this session's.
        {
          type: "assistant",
          isSidechain: true,
          timestamp: "2026-09-01T10:00:03.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "sub" }],
          },
        },
        // Thinking only: nothing to show, so nothing is imported blank.
        {
          type: "assistant",
          timestamp: "2026-09-01T10:00:04.000Z",
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: "x" }],
          },
        },
      ]),
    );

    expect(readTranscript(file, "claude")).toStrictEqual([
      {
        role: "user",
        text: "fix the parser",
        timestamp: Date.parse("2026-09-01T10:00:01.000Z"),
      },
      {
        role: "assistant",
        text: "Done.",
        timestamp: Date.parse("2026-09-01T10:00:02.000Z"),
      },
    ]);
  });

  it("leaves out the context a CLI writes to itself as a user message", () => {
    const root = temp();
    const file = join(root, "c.jsonl");
    writeFileSync(
      file,
      lines([
        {
          type: "response_item",
          timestamp: "2026-09-01T10:00:00.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "<recommended_plugins>\nsome list\n</recommended_plugins>",
              },
            ],
          },
        },
        {
          type: "response_item",
          timestamp: "2026-09-01T10:00:01.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "你好" }],
          },
        },
        // Ambient context AND the user's own words: the message is theirs.
        {
          type: "response_item",
          timestamp: "2026-09-01T10:00:02.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: '<in-app-browser-context source="x">\nstate\n</in-app-browser-context>\n\n## My request:\nwrite it up',
              },
            ],
          },
        },
      ]),
    );

    // Codex marks its injected context with nothing but its shape, and an
    // import that kept it opens a task titled `<recommended_plugins>`.
    expect(
      readTranscript(file, "codex").map((turn) => turn.text),
    ).toStrictEqual([
      "你好",
      '<in-app-browser-context source="x">\nstate\n</in-app-browser-context>\n\n## My request:\nwrite it up',
    ]);
  });

  it("materializes an epic and a chat, then imports it exactly once", async () => {
    const host = await boot();
    const workspace = temp();
    const found = claudeSession(workspace, "sess-1", "fix the parser");

    const first = await importSession(
      host.runtime,
      { harness: "claude", nativeSessionId: "sess-1" },
      "supervised",
      found,
    );

    expect(first).toStrictEqual({
      kind: "imported",
      epicId: expect.any(String),
      chatId: chatIdFor({ harness: "claude", nativeSessionId: "sess-1" }),
    });
    if (first.kind !== "imported") {
      throw new Error(`expected an import, got ${first.kind}`);
    }
    const state = host.runtime.store.snapshot();
    const chat = state.chats.find((row) => row.chatId === first.chatId);
    expect(chat).toBeDefined();
    // The idempotency key, stored rather than derived.
    expect(chat?.providerSession).toStrictEqual({
      harnessId: "claude",
      sessionId: "sess-1",
    });
    expect(chat?.runSettings).toStrictEqual({
      permissionMode: "supervised",
      harnessId: "claude",
    });
    expect(chat?.turns.map((turn) => [turn.role, turn.prompt])).toStrictEqual([
      ["user", "fix the parser"],
      ["assistant", "Done."],
    ]);
    const epic = state.epics.find((row) => row.id === first.epicId);
    expect(epic?.workspaces).toStrictEqual([workspace]);
    // The chat is an agent too, or the GUI has a chat nothing runs in.
    expect(state.agents.some((row) => row.id === first.chatId)).toBe(true);

    const again = await importSession(
      host.runtime,
      { harness: "claude", nativeSessionId: "sess-1" },
      "supervised",
      found,
    );

    expect(again).toStrictEqual({
      kind: "skipped_already_imported",
      epicId: first.epicId,
      chatId: first.chatId,
    });
    expect(host.runtime.store.snapshot().chats).toHaveLength(1);
  });

  it("imports a session whose folder is gone, folderless", async () => {
    const host = await boot();
    const found = claudeSession("/nowhere/at/all", "sess-2", "old work");

    const outcome = await importSession(
      host.runtime,
      { harness: "claude", nativeSessionId: "sess-2" },
      "full_access",
      found,
    );

    // `missing_folder` is a location, not an error: it must not come back as
    // `workspace_bind_failed`.
    expect(outcome.kind).toBe("imported");
    const epic = host.runtime.store.snapshot().epics[0];
    expect(epic.workspaces).toStrictEqual([]);
  });

  it("fails a selection this host cannot find, on its own terms", async () => {
    const host = await boot();

    expect(
      await importSession(
        host.runtime,
        { harness: "claude", nativeSessionId: "ghost" },
        "supervised",
        null,
      ),
    ).toMatchObject({ kind: "failed", reason: "source_unreadable" });
    expect(host.runtime.store.snapshot().epics).toHaveLength(0);
  });

  it("streams started, one progress per selection, then complete", async () => {
    const host = await boot();
    const root = temp();
    const workspace = temp();
    writeClaude(root, "-w", "run-1", workspace, "first");
    const runs = new SessionImportRuns(new Map([["claude", root]]));
    const socket = new FakeSocket();

    expect(
      runs.attach(socket as never, host.runtime, {
        selections: [
          { harness: "claude", nativeSessionId: "run-1" },
          { harness: "claude", nativeSessionId: "missing" },
        ],
        permissionMode: "supervised",
      }),
    ).toBe(true);
    expect(socket.frames[0]).toStrictEqual({
      kind: "started",
      runId: expect.any(String),
      total: 2,
      // This subscription STARTED the run.
      attached: false,
      hasBinaryPayload: false,
    });
    // A run is in flight the moment it is submitted, which is the only thing
    // a Settings pane that never subscribed can see.
    expect(runs.status().active).toMatchObject({ done: 0, total: 2 });

    await settle(runs);

    expect(socket.frames.map((frame) => frame.kind)).toStrictEqual([
      "started",
      "progress",
      "progress",
      "complete",
    ]);
    expect(socket.frames[1]).toMatchObject({
      index: 0,
      total: 2,
      nativeSessionId: "run-1",
      outcome: { kind: "imported" },
    });
    expect(socket.frames[2]).toMatchObject({
      index: 1,
      outcome: { kind: "failed", reason: "source_unreadable" },
    });
    expect(socket.frames[3]).toMatchObject({
      counts: { imported: 1, skippedAlreadyImported: 0, failed: 1 },
    });
    // Nothing is running any more, and the summary outlives the socket.
    expect(runs.status().active).toBeNull();
    expect(runs.status().lastCompleted).toMatchObject({
      runId: socket.frames[3].runId,
      counts: { imported: 1, failed: 1 },
    });
  });

  it("attaches a second subscribe to the run in flight and replays it", async () => {
    const host = await boot();
    const root = temp();
    const workspace = temp();
    writeClaude(root, "-w", "run-2", workspace, "first");
    const runs = new SessionImportRuns(new Map([["claude", root]]));
    const first = new FakeSocket();
    runs.attach(first as never, host.runtime, {
      selections: [{ harness: "claude", nativeSessionId: "run-2" }],
      permissionMode: "supervised",
    });

    const second = new FakeSocket();
    runs.attach(second as never, host.runtime, {
      // Ignored: there is at most one run, and this one is already going.
      selections: [
        { harness: "claude", nativeSessionId: "a" },
        { harness: "claude", nativeSessionId: "b" },
      ],
      permissionMode: "full_access",
    });

    expect(second.frames[0]).toMatchObject({
      kind: "started",
      // The IN-FLIGHT run's total, not this submission's two.
      total: 1,
      attached: true,
      runId: first.frames[0].runId,
    });

    await settle(runs);

    // Both saw the same run to its end.
    expect(second.frames.map((frame) => frame.kind)).toStrictEqual([
      "started",
      "progress",
      "complete",
    ]);
    expect(host.runtime.store.snapshot().chats).toHaveLength(1);
  });

  function temp(): string {
    const dir = mkdtempSync(join(tmpdir(), "traycer-import-"));
    dirs.push(dir);
    return dir;
  }

  function lines(rows: readonly object[]): string {
    return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  }

  function writeClaude(
    root: string,
    project: string,
    id: string,
    cwd: string,
    prompt: string,
  ): string {
    const dir = join(root, project);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(
      file,
      lines([
        {
          type: "user",
          sessionId: id,
          cwd,
          timestamp: "2026-09-01T10:00:01.000Z",
          message: { role: "user", content: prompt },
        },
        {
          type: "assistant",
          sessionId: id,
          cwd,
          timestamp: "2026-09-01T10:00:02.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done." }],
          },
        },
      ]),
    );
    return file;
  }

  /** One discovered session, read the way the run reads it. */
  function claudeSession(
    cwd: string,
    id: string,
    prompt: string,
  ): DiscoveredSession {
    const root = temp();
    writeClaude(root, "-p", id, cwd, prompt);
    const found = readProvider("claude", root, null);
    expect(found).toHaveLength(1);
    return found[0];
  }

  /**
   * Waits for the run to finish. Polls rather than draining macrotasks: an
   * import binds its workspace through the same registration "add folder"
   * uses, which spawns git, so the run takes real time and not a fixed number
   * of ticks.
   */
  async function settle(runs: SessionImportRuns): Promise<void> {
    for (let index = 0; index < 200; index += 1) {
      if (runs.status().active === null) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("the import run never finished");
  }

  async function boot(): Promise<StartedHost> {
    started = await startHost({
      argv: ["--host-data-dir", temp()],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    return started;
  }
});
