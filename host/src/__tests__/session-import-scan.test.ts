import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionImportGroup } from "@traycer/protocol/host/session-import/candidate";
import { sessionImportScanServerFrameSchema } from "@traycer/protocol/host/session-import/scan";
import {
  groupSessions,
  readableProviders,
  readProvider,
  type DiscoveredSession,
} from "../session-import/discover";
import { serveSessionImportScan } from "../stream/session-import-scan";

type Frame = { readonly kind: string; readonly [key: string]: unknown };

/** Parses every frame through the contract's own union. */
class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  readonly frames: Frame[] = [];

  send(payload: string): void {
    this.frames.push(
      sessionImportScanServerFrameSchema.parse(JSON.parse(payload)) as Frame,
    );
  }
}

/**
 * The reader is exercised against a synthetic vendor tree rather than the
 * machine's own `~/.claude`: a test that read the developer's real sessions
 * would be neither reproducible nor decent.
 */
describe("session import discovery", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function temp(): string {
    const dir = mkdtempSync(join(tmpdir(), "traycer-scan-"));
    dirs.push(dir);
    return dir;
  }

  function claudeSession(
    root: string,
    project: string,
    id: string,
    lines: readonly object[],
  ): string {
    const dir = join(root, project);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(
      file,
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
    return file;
  }

  function turns(cwd: string, id: string, prompt: string): object[] {
    return [
      { type: "mode", sessionId: id },
      {
        type: "user",
        sessionId: id,
        cwd,
        timestamp: "2026-09-01T10:00:00.000Z",
        message: { role: "user", content: prompt },
      },
      { type: "ai-title", sessionId: id, aiTitle: `title for ${id}` },
    ];
  }

  it("describes a session from its head and groups it by repo root", () => {
    const root = temp();
    const repo = temp();
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, "packages", "api"), { recursive: true });
    claudeSession(root, "-repo", "aaa", turns(repo, "aaa", "fix the parser"));
    // A second session, run in a SUBDIRECTORY of the same checkout: the two
    // belong to one group, which is the whole point of resolving the root.
    claudeSession(
      root,
      "-repo-packages-api",
      "bbb",
      turns(join(repo, "packages", "api"), "bbb", "add a route"),
    );

    const groups = groupSessions(readProvider("claude", root, null));

    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group.location).toStrictEqual({
      kind: "folder",
      path: repo,
      workspaceId: null,
    });
    expect(group.gitBacked).toBe(true);
    expect(
      group.sessions.map((row) => row.nativeSessionId).sort(),
    ).toStrictEqual(["aaa", "bbb"]);
    const first = group.sessions.find((row) => row.nativeSessionId === "aaa");
    expect(first).toBeDefined();
    expect(first?.title).toBe("title for aaa");
    expect(first?.firstPrompt).toBe("fix the parser");
    expect(first?.createdAt).toBe(Date.parse("2026-09-01T10:00:00.000Z"));
    expect(first?.state).toStrictEqual({ kind: "importable" });
    // Never counted: the scan does not open a transcript.
    expect(first?.messageCount).toBeNull();
  });

  it("reports a session whose folder is gone as a missing folder", () => {
    const root = temp();
    claudeSession(
      root,
      "-gone",
      "ccc",
      turns("/nowhere/at/all", "ccc", "old work"),
    );

    const groups = groupSessions(readProvider("claude", root, null));

    expect(groups[0].location).toStrictEqual({
      kind: "missing_folder",
      path: "/nowhere/at/all",
    });
    expect(groups[0].gitBacked).toBe(false);
  });

  it("marks an unparseable file unreadable and an empty one empty", () => {
    const root = temp();
    const repo = temp();
    claudeSession(root, "-x", "ddd", turns(repo, "ddd", "real work"));
    mkdirSync(join(root, "-y"), { recursive: true });
    writeFileSync(join(root, "-y", "eee.jsonl"), "{not json at all\n");
    writeFileSync(
      join(root, "-y", "fff.jsonl"),
      `${JSON.stringify({ type: "mode", cwd: repo })}\n`,
    );

    const states = new Map(
      readProvider("claude", root, null).map((row) => [
        row.candidate.nativeSessionId,
        row.candidate.state,
      ]),
    );

    expect(states.get("ddd")).toStrictEqual({ kind: "importable" });
    // A file of garbage parses to no line at all, which reads as no message.
    expect(states.get("eee")).toMatchObject({
      kind: "unreadable",
      reason: "source_empty",
    });
    expect(states.get("fff")).toMatchObject({
      kind: "unreadable",
      reason: "source_empty",
    });
  });

  it("skips a session older than the scan window before opening it", () => {
    const root = temp();
    const repo = temp();
    const old = claudeSession(root, "-x", "ggg", turns(repo, "ggg", "stale"));
    claudeSession(root, "-x", "hhh", turns(repo, "hhh", "fresh"));
    const ancient = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(old, ancient, ancient);

    const found = readProvider("claude", root, Date.parse("2024-01-01"));

    expect(found.map((row) => row.candidate.nativeSessionId)).toStrictEqual([
      "hhh",
    ]);
  });

  it("reads a codex rollout's own metadata", () => {
    const root = temp();
    const repo = temp();
    const dir = join(root, "2026", "09", "01");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "rollout-2026-09-01T10-00-00-abc.jsonl"),
      `${[
        {
          type: "session_meta",
          timestamp: "2026-09-01T10:00:00.000Z",
          payload: { id: "codex-1", cwd: repo },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "ship it" }],
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n")}\n`,
    );

    const found = readProvider("codex", root, null);

    expect(found).toHaveLength(1);
    // The rollout's own id wins over the file name it was written under.
    expect(found[0].candidate.nativeSessionId).toBe("codex-1");
    expect(found[0].candidate.firstPrompt).toBe("ship it");
    expect(found[0].candidate.title).toBeNull();
    expect(found[0].folder).toBe(repo);
  });

  it("has readers for exactly the providers it names roots for", () => {
    expect(readableProviders(new Map([["claude", "/tmp/x"]]))).toStrictEqual([
      "claude",
    ]);
  });

  it("sends started, then a failure, then groups, then complete", () => {
    const root = temp();
    const repo = temp();
    claudeSession(root, "-x", "iii", turns(repo, "iii", "work"));
    const socket = new FakeSocket();

    const served = serveSessionImportScan(
      socket as never,
      { providers: ["claude", "opencode"], updatedAfter: null },
      new Map([["claude", root]]),
    );

    expect(served).toBe(true);
    expect(socket.frames.map((frame) => frame.kind)).toStrictEqual([
      "started",
      "providerFailed",
      "group",
      "complete",
    ]);
    // A provider with no reader FAILS rather than contributing nothing: the
    // wizard must be able to tell "cannot look" from "never used".
    expect(socket.frames[1]).toMatchObject({
      harness: "opencode",
      reason: "source_unreadable",
    });
    expect(socket.frames[3].totals).toStrictEqual({
      groups: 1,
      sessions: 1,
      importable: 1,
      alreadyInTraycer: 0,
      unreadable: 0,
    });
  });

  it("refuses a malformed open request", () => {
    const socket = new FakeSocket();

    expect(
      serveSessionImportScan(
        socket as never,
        { providers: [], updatedAfter: null },
        new Map(),
      ),
    ).toBe(false);
    expect(socket.frames).toHaveLength(0);
  });

  it("orders groups and sessions newest first", () => {
    const rows: DiscoveredSession[] = [
      discovered("a", 100, "/gone/one"),
      discovered("b", 300, "/gone/two"),
      discovered("c", 200, "/gone/one"),
    ];

    const groups = groupSessions(rows);

    expect(paths(groups)).toStrictEqual(["/gone/two", "/gone/one"]);
    expect(groups[1].sessions.map((row) => row.nativeSessionId)).toStrictEqual([
      "c",
      "a",
    ]);
  });

  function paths(groups: readonly SessionImportGroup[]): string[] {
    return groups.map((group) => group.location.path);
  }

  function discovered(
    id: string,
    updatedAt: number,
    folder: string,
  ): DiscoveredSession {
    return {
      file: `/tmp/${id}.jsonl`,
      candidate: {
        harness: "claude",
        nativeSessionId: id,
        title: null,
        firstPrompt: null,
        createdAt: updatedAt,
        updatedAt,
        messageCount: null,
        hasSubagents: false,
        state: { kind: "importable" },
      },
      folder,
      fallbackLabel: "x",
    };
  }
});
