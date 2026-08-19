import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  gitSubscribeStatusEventSchema,
  type GitSubscribeStatusEvent,
} from "@traycer/protocol/host/git-schemas";
import { openGitStatusStream } from "../git-status-stream";

describe("git status stream core", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    while (temporaryDirectories.length > 0) {
      const directory = temporaryDirectories.pop();
      if (directory !== undefined) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("emits an initial v1.0 snapshot and one update per new fingerprint", async () => {
    const repo = await createRepository(temporaryDirectories);
    const sent: string[] = [];
    const opened = openGitStatusStream(
      (frame) => {
        if (typeof frame === "string") sent.push(frame);
      },
      { major: 1, minor: 0 },
      { hostId: "host-local", runningDir: repo, ignoreWhitespace: false },
      { pollIntervalMs: 25, watcherDebounceMs: 5 },
    );
    if (!opened.accepted) throw new Error(opened.reason);

    expect(parseFrames(sent)).toEqual([
      expect.objectContaining({
        type: "snapshot",
        runningDir: repo,
        files: [],
      }),
    ]);

    await writeFile(join(repo, "tracked.txt"), "first\nsecond\n");
    await vi.waitFor(() => {
      expect(parseFrames(sent)).toHaveLength(2);
    });

    const frames = parseFrames(sent);
    expect(frames[1]).toMatchObject({
      type: "updated",
      runningDir: repo,
      changedPaths: ["tracked.txt"],
      files: [
        {
          path: "tracked.txt",
          status: "modified",
          stage: "unstaged",
          insertions: 1,
          deletions: 0,
        },
      ],
    });
    const initial = frames[0];
    const updated = frames[1];
    if (initial?.type !== "snapshot" || updated?.type !== "updated") {
      throw new Error("Expected a snapshot followed by an update");
    }
    expect(updated.fingerprint).not.toBe(initial.fingerprint);

    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(parseFrames(sent)).toHaveLength(2);

    opened.binding.dispose();
    opened.binding.dispose();
    await writeFile(join(repo, "after-dispose.txt"), "ignored\n");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(parseFrames(sent)).toHaveLength(2);
  });

  it("rejects a non-Git directory without opening background work", async () => {
    const directory = await mkdtemp(join(tmpdir(), "traycer-not-git-"));
    temporaryDirectories.push(directory);
    const sent: string[] = [];

    const opened = openGitStatusStream(
      (frame) => {
        if (typeof frame === "string") sent.push(frame);
      },
      { major: 1, minor: 0 },
      {
        hostId: "host-local",
        runningDir: directory,
        ignoreWhitespace: false,
      },
      { pollIntervalMs: 25, watcherDebounceMs: 5 },
    );

    expect(opened).toMatchObject({
      accepted: false,
      code: "E_INVALID_ARGUMENT",
    });
    expect(sent).toEqual([]);
  });

  it("does not claim support for later protocol minors", async () => {
    const repo = await createRepository(temporaryDirectories);

    expect(
      openGitStatusStream(
        () => {},
        { major: 1, minor: 1 },
        { hostId: "host-local", runningDir: repo, ignoreWhitespace: false },
        undefined,
      ),
    ).toEqual({
      accepted: false,
      code: "E_HOST_UNSUPPORTED",
      reason: "git.subscribeStatus 1.1 is not implemented",
    });
  });
});

async function createRepository(
  temporaryDirectories: string[],
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "traycer-git-stream-"));
  temporaryDirectories.push(directory);
  runGit(directory, ["init", "--quiet"]);
  runGit(directory, ["config", "user.email", "tests@traycer.local"]);
  runGit(directory, ["config", "user.name", "Traycer Tests"]);
  await writeFile(join(directory, "tracked.txt"), "first\n");
  runGit(directory, ["add", "tracked.txt"]);
  runGit(directory, ["commit", "--quiet", "-m", "initial"]);
  return realpath(directory);
}

function runGit(cwd: string, args: readonly string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
}

function parseFrames(frames: readonly string[]): GitSubscribeStatusEvent[] {
  return frames.map((frame) =>
    gitSubscribeStatusEventSchema.parse(JSON.parse(frame)),
  );
}
