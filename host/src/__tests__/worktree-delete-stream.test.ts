import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { worktreeDeleteByPathServerFrameSchemaV12 } from "@traycer/protocol/host/worktree-delete-stream";
import { runWorktreeDelete, type DeleteEvent } from "../worktree/delete-stream";
import { WorktreeDeleteCommands } from "../stream/worktree-delete";
import { startHost, type StartedHost } from "../start-host";

describe("worktree delete", () => {
  let started: StartedHost | null = null;
  let dirs: string[] = [];

  afterEach(async () => {
    if (started !== null) {
      await started.close();
      started = null;
    }
    for (const dir of dirs) {
      await rm(dir, { recursive: true, force: true });
    }
    dirs = [];
  });

  it("refuses a path this host does not manage, before the remover", async () => {
    const host = await boot();
    const stranger = await temp();
    await writeFile(join(stranger, "keep.txt"), "not yours");
    const events = await collect(host, {
      worktreePath: stranger,
      scripts: null,
      stopOwners: false,
    });
    expect(events).toEqual([
      {
        kind: "failed",
        reason: expect.stringContaining("not a worktree"),
        busy: false,
        holders: [],
      },
    ]);
    // The remover falls back to `rm -rf`, so the guard has to hold BEFORE it.
    expect(existsSync(join(stranger, "keep.txt"))).toBe(true);
  });

  it("tears down, removes, and reports the directory gone", async () => {
    const host = await boot();
    const repo = await temp();
    const worktree = join(repo, "..", `wt-${String(Date.now())}`);
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "probe@example.com"]);
    git(repo, ["config", "user.name", "probe"]);
    await writeFile(join(repo, "a.txt"), "one");
    git(repo, ["add", "a.txt"]);
    git(repo, ["commit", "-qm", "first"]);
    git(repo, ["worktree", "add", "-q", worktree, "-b", "probe-branch"]);
    dirs.push(worktree);
    expect(existsSync(worktree)).toBe(true);
    // The worktree's own environment file is what `scripts: null` means.
    await mkdir(join(worktree, ".traycer"), { recursive: true });
    await writeFile(
      join(worktree, ".traycer", "environment.json"),
      JSON.stringify({
        setup: { default: "", macos: null, windows: null, linux: null },
        teardown: {
          default: "echo tearing-down",
          macos: null,
          windows: null,
          linux: null,
        },
        updatedAt: 1,
      }),
    );
    await register(host, repo, worktree);

    // A binding IS a holder, so the default refuses and names who is holding.
    const refused = await collect(host, {
      worktreePath: worktree,
      scripts: null,
      stopOwners: false,
    });
    expect(refused).toMatchObject([{ kind: "failed", busy: true }]);
    expect(refused[0].kind === "failed" ? refused[0].holders.length : 0).toBe(
      1,
    );
    expect(existsSync(worktree)).toBe(true);

    const events = await collect(host, {
      worktreePath: worktree,
      scripts: null,
      stopOwners: true,
    });
    expect(events.map((event) => event.kind)).toEqual([
      "started",
      "phase",
      "output",
      "phase",
      "complete",
    ]);
    expect(events[0]).toMatchObject({ kind: "started", hasTeardown: true });
    expect(events[2]).toMatchObject({
      kind: "output",
      channel: "stdout",
      chunk: expect.stringContaining("tearing-down"),
    });
    expect(events.at(-1)).toEqual({ kind: "complete", deleted: true });
    expect(existsSync(worktree)).toBe(false);
    // The binding entry goes with it, or the row outlives the directory.
    expect(
      host.runtime.store
        .snapshot()
        .bindings.flatMap((row) => row.binding.entries)
        .some((entry) => entry.worktreePath === worktree),
    ).toBe(false);
  });

  it("skips the teardown phase when there is no teardown to run", async () => {
    const host = await boot();
    const repo = await temp();
    const worktree = join(repo, "..", `wt2-${String(Date.now())}`);
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "probe@example.com"]);
    git(repo, ["config", "user.name", "probe"]);
    await writeFile(join(repo, "a.txt"), "one");
    git(repo, ["add", "a.txt"]);
    git(repo, ["commit", "-qm", "first"]);
    git(repo, ["worktree", "add", "-q", worktree, "-b", "probe-branch-2"]);
    dirs.push(worktree);
    await register(host, repo, worktree);

    const events = await collect(host, {
      worktreePath: worktree,
      scripts: null,
      stopOwners: true,
    });
    expect(events[0]).toMatchObject({ kind: "started", hasTeardown: false });
    expect(events.map((event) => event.kind)).toEqual([
      "started",
      "phase",
      "complete",
    ]);
    expect(events[1]).toMatchObject({ phase: "remove" });
  });

  it("replays a finished command to a socket that observes it later", async () => {
    const host = await boot();
    const commands = new WorktreeDeleteCommands();
    const commandId = "3f1c6e2a-9d84-4d2f-9d1b-2f7a1c0e5b44";
    const first = new FakeSocket();
    expect(
      commands.attach(first as never, host.runtime, {
        mode: "start",
        commandId,
        source: "settings",
        targets: [{ worktreePath: "/nope/not/a/worktree", scripts: null }],
      }),
    ).toBe(true);
    await settle();
    expect(first.frames.map((f) => f.kind)).toEqual([
      "target.failed",
      "command.complete",
    ]);

    // A command outlives its socket: an observe arriving after the work is
    // done must replay the terminal frame, not hang on a delete that already
    // happened.
    const later = new FakeSocket();
    expect(
      commands.attach(later as never, host.runtime, {
        mode: "observe",
        commandId,
      }),
    ).toBe(true);
    expect(later.frames.map((f) => f.kind)).toEqual([
      "target.failed",
      "command.complete",
    ]);

    // An unknown command is answered, never left silent.
    const stranger = new FakeSocket();
    commands.attach(stranger as never, host.runtime, {
      mode: "observe",
      commandId: "7b2d4e1f-0a63-4c98-8e5d-1f3b9c7a2d60",
    });
    expect(stranger.frames.at(-1)).toMatchObject({ kind: "command.failed" });
  });

  it("shapes a busy refusal per the negotiated minor", () => {
    // The `@1.2` union is the widest, so a frame legal there and carrying the
    // fields this host emits proves the shape without a live socket.
    const frame = worktreeDeleteByPathServerFrameSchemaV12.parse({
      kind: "failed",
      reason: "The worktree is in use.",
      holders: [],
      code: "WORKTREE_BUSY",
      hasBinaryPayload: false,
    });
    expect(frame).toMatchObject({ kind: "failed", code: "WORKTREE_BUSY" });
  });

  async function collect(
    host: StartedHost,
    target: {
      readonly worktreePath: string;
      readonly scripts: null;
      readonly stopOwners: boolean;
    },
  ): Promise<DeleteEvent[]> {
    const events: DeleteEvent[] = [];
    await runWorktreeDelete(host.runtime, target, (event) => {
      events.push(event);
    });
    return events;
  }

  async function register(
    host: StartedHost,
    workspacePath: string,
    worktreePath: string,
  ): Promise<void> {
    await host.runtime.store.mutate((state) => {
      state.bindings.push({
        epicId: "epic-1",
        ownerId: "chat-1",
        ownerKind: "chat",
        binding: {
          entries: [
            {
              workspacePath,
              mode: "worktree",
              repoIdentifier: null,
              worktreePath,
              branch: "probe-branch",
              isPrimary: true,
              isImported: false,
              setupState: "not_required",
              setupTerminalSessionId: null,
              setupExitCode: null,
              setupFailedAt: null,
              createdAt: 1,
            },
          ],
        },
      });
    });
  }

  async function boot(): Promise<StartedHost> {
    const dir = await temp();
    started = await startHost({
      argv: ["--host-data-dir", dir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    return started;
  }

  async function temp(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "traycer-wt-"));
    dirs.push(dir);
    return dir;
  }
});

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  readonly frames: { readonly kind: string }[] = [];

  send(payload: string): void {
    this.frames.push(JSON.parse(payload) as { readonly kind: string });
  }
}

/** Lets the runner's own awaits drain before the frames are read. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
}

function git(cwd: string, args: readonly string[]): void {
  const run = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  if (run.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  }
}
