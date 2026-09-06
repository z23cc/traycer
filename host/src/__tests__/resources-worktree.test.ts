import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  handleManagedCommandDeliverHeld,
  handleManagedCommandStart,
} from "../rpc/handlers/managed-command-handlers";
import {
  handleResourcesKill,
  handleWorktreeListHolders,
  handleWorktreeSetRepoBranchPrefix,
} from "../rpc/handlers/resources-handlers";
import { readRepoBranchPrefix, writeRepoScripts } from "../worktree/service";
import { startHost, type StartedHost } from "../start-host";
import type { StoredBinding, StoredChat } from "../store/host-store";

const EMPTY_SCRIPT = {
  default: "",
  macos: null,
  windows: null,
  linux: null,
};

describe("resources and worktree holders", () => {
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

  it("lists a worktree's holders and digests them stably", async () => {
    const host = await boot();
    await seedBinding(host);
    const answer = await handleWorktreeListHolders(
      { worktreePath: "/tmp/wt-1", owner: null },
      host.runtime,
    );
    if (!answer.ok) {
      throw new Error(answer.message);
    }
    const result = answer.result as {
      holders: { ownerRef: { ownerId: string }; activity: string }[];
      holdersRevision: string;
    };
    expect(result.holders).toHaveLength(1);
    expect(result.holders[0]).toMatchObject({
      ownerRef: { epicId: "epic-1", ownerKind: "chat", ownerId: "chat-1" },
      holdKind: "chat-turn",
      // No turn is in flight, so the owner holds the path but is not working.
      activity: "idle",
      label: "Root",
    });
    expect(result.holdersRevision).toMatch(/^[0-9a-f]{64}$/u);

    // Owner mode is not filtered by the path it was asked with.
    const byOwner = await handleWorktreeListHolders(
      {
        worktreePath: "/tmp/somewhere-else",
        owner: { epicId: "epic-1", ownerKind: "chat", ownerId: "chat-1" },
      },
      host.runtime,
    );
    if (!byOwner.ok) {
      throw new Error(byOwner.message);
    }
    expect((byOwner.result as { holders: unknown[] }).holders).toHaveLength(1);

    // An unknown path is an empty inventory, not an error.
    const unknown = await handleWorktreeListHolders(
      { worktreePath: "/tmp/nope", owner: null },
      host.runtime,
    );
    expect(unknown).toMatchObject({ result: { holders: [] } });
  });

  it("round-trips a branch prefix without dropping the scripts beside it", async () => {
    const host = await boot();
    const repo = join(host.runtime.dataDir, "repo");
    await mkdir(repo, { recursive: true });

    await writeRepoScripts(repo, EMPTY_SCRIPT, EMPTY_SCRIPT);
    expect(await readRepoBranchPrefix(repo)).toEqual({ status: "absent" });

    const set = await handleWorktreeSetRepoBranchPrefix(
      { epicId: "epic-1", workspacePath: repo, branchPrefix: "duange" },
      host.runtime,
    );
    expect(set).toEqual({ ok: true, result: { updated: true } });
    expect(await readRepoBranchPrefix(repo)).toEqual({
      status: "present",
      value: "duange",
    });
    // The scripts the other writer owns survived this one.
    const file: unknown = JSON.parse(
      await readFile(join(repo, ".traycer", "environment.json"), "utf8"),
    );
    expect(file).toMatchObject({ setup: EMPTY_SCRIPT, branchPrefix: "duange" });

    // `""` is an explicit "no prefix" and is stored verbatim; null clears it.
    await handleWorktreeSetRepoBranchPrefix(
      { epicId: "epic-1", workspacePath: repo, branchPrefix: "" },
      host.runtime,
    );
    expect(await readRepoBranchPrefix(repo)).toEqual({
      status: "present",
      value: "",
    });
    await handleWorktreeSetRepoBranchPrefix(
      { epicId: "epic-1", workspacePath: repo, branchPrefix: null },
      host.runtime,
    );
    expect(await readRepoBranchPrefix(repo)).toEqual({ status: "absent" });
    // And the scripts are still there after all of that.
    expect(
      JSON.parse(
        await readFile(join(repo, ".traycer", "environment.json"), "utf8"),
      ),
    ).toMatchObject({ teardown: EMPTY_SCRIPT });
  });

  it("calls a broken environment file malformed, not absent", async () => {
    const host = await boot();
    const repo = join(host.runtime.dataDir, "repo");
    await mkdir(join(repo, ".traycer"), { recursive: true });
    await writeFile(join(repo, ".traycer", "environment.json"), "[]");
    expect(await readRepoBranchPrefix(repo)).toEqual({ status: "malformed" });
    await writeFile(
      join(repo, ".traycer", "environment.json"),
      JSON.stringify({ branchPrefix: 7 }),
    );
    expect(await readRepoBranchPrefix(repo)).toEqual({ status: "malformed" });
  });

  it("never kills a pid this host did not start", async () => {
    const host = await boot();
    // This process is very much alive and very much not ours to kill.
    const answer = await handleResourcesKill(
      { pids: [process.pid] },
      host.runtime,
    );
    expect(answer).toEqual({ ok: true, result: { killed: [] } });
    expect(process.kill(process.pid, 0)).toBe(true);
  });

  it("refuses an id-addressed managed command that does not exist", async () => {
    const host = await boot();
    const start = await handleManagedCommandStart(
      { epicId: "epic-1", commandId: "cmd-1" },
      host.runtime,
    );
    expect(start.ok).toBe(false);
    // Deliver proves the chat belongs to the epic before it answers.
    const stranger = await handleManagedCommandDeliverHeld(
      { epicId: "epic-1", chatId: "chat-1", commandIds: null },
      host.runtime,
    );
    expect(stranger.ok).toBe(false);
    await seedBinding(host);
    const owned = await handleManagedCommandDeliverHeld(
      { epicId: "epic-1", chatId: "chat-1", commandIds: null },
      host.runtime,
    );
    expect(owned).toEqual({
      ok: true,
      result: { released: [], unresolved: [], unattributed: [], held: [] },
    });
  });

  async function boot(): Promise<StartedHost> {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    return started;
  }
});

async function seedBinding(host: StartedHost): Promise<void> {
  const chat: StoredChat = {
    epicId: "epic-1",
    chatId: "chat-1",
    parentId: null,
    hostId: host.runtime.hostId,
    title: "Root",
    createdAt: 1,
    runSettings: null,
    fastMode: false,
    providerSession: null,
    turns: [],
    events: [],
    transcriptEpoch: 0,
    indexRevision: 0,
    fileChangeCount: 0,
    lastUsage: null,
    archivedAt: null,
  };
  const binding: StoredBinding = {
    epicId: "epic-1",
    ownerId: "chat-1",
    ownerKind: "chat",
    binding: {
      entries: [
        {
          workspacePath: "/tmp/repo",
          mode: "worktree",
          repoIdentifier: null,
          worktreePath: "/tmp/wt-1",
          branch: "feature",
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
  };
  await host.runtime.store.mutate((state) => {
    state.chats.push(chat);
    state.bindings.push(binding);
  });
}
