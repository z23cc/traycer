import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEpicRequestSchema } from "@traycer/protocol/host/epic/unary-schemas";
import type {
  WorktreeCreateResponse,
  WorktreeSetEntryModeResponse,
} from "@traycer/protocol/host/worktree-schemas";
import { HostState } from "../store";

describe("HostState worktree creation", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    for (const root of tempRoots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes a Local transition behind an in-flight create", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-worktree-queue-"));
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    execFileSync("git", ["-C", workspace, "init", "-b", "main"]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.name",
      "Traycer Test",
    ]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.email",
      "traycer@example.com",
    ]);
    await writeFile(join(workspace, "README.md"), "base\n");
    execFileSync("git", ["-C", workspace, "add", "README.md"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);
    const state = new HostState("host-local", undefined, join(root, "managed"));
    const owner = {
      epicId: "epic-1",
      ownerId: "terminal-1",
      ownerKind: "terminal-agent" as const,
    };

    const creating = state.createWorktree({
      ...owner,
      entries: [
        {
          kind: "worktree",
          workspacePath: workspace,
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "feature/queued",
            source: "main",
            carryUncommittedChanges: false,
            collision: "fail",
          },
          scripts: null,
        },
      ],
    });
    const settingLocal = state.setWorktreeEntryMode({
      ...owner,
      workspacePath: workspace,
    });
    const [created] = await Promise.all([creating, settingLocal]);

    expect(created.perEntry).toEqual([
      {
        workspacePath: workspace,
        ok: true,
        worktreePath: expect.any(String),
        branch: "feature/queued",
        errorMessage: null,
      },
    ]);

    expect(state.getBinding(owner).binding).toMatchObject({
      entries: [
        {
          workspacePath: workspace,
          mode: "local",
          worktreePath: null,
          branch: null,
        },
      ],
    });
    state.dispose();
  });

  it("rechecks chat activity before applying a queued Local transition", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "traycer-worktree-active-owner-queue-"),
    );
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    execFileSync("git", ["-C", workspace, "init", "-b", "main"]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.name",
      "Traycer Test",
    ]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.email",
      "traycer@example.com",
    ]);
    await writeFile(join(workspace, "README.md"), "base\n");
    execFileSync("git", ["-C", workspace, "add", "README.md"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);

    const hookEntered = join(root, "post-checkout-entered");
    const hookRelease = join(root, "post-checkout-release");
    const hook = join(workspace, ".git", "hooks", "post-checkout");
    await writeFile(
      hook,
      [
        "#!/bin/sh",
        ': > "$TRAYCER_TEST_ACTIVE_QUEUE_HOOK_ENTERED"',
        'while [ ! -f "$TRAYCER_TEST_ACTIVE_QUEUE_HOOK_RELEASE" ]; do',
        "  sleep 0.01",
        "done",
        "",
      ].join("\n"),
    );
    await chmod(hook, 0o755);
    const restoreEnvironment = overrideEnvironment({
      TRAYCER_TEST_ACTIVE_QUEUE_HOOK_ENTERED: hookEntered,
      TRAYCER_TEST_ACTIVE_QUEUE_HOOK_RELEASE: hookRelease,
    });
    const state = new HostState("host-local", undefined, join(root, "managed"));
    createEmptyChat(state, "epic-1", "chat-1");
    const owner = {
      epicId: "epic-1",
      ownerId: "chat-1",
      ownerKind: "chat" as const,
    };
    const creating = state.createWorktree({
      ...owner,
      entries: [
        {
          kind: "worktree",
          workspacePath: workspace,
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "feature/active-owner-queue",
            source: "main",
            carryUncommittedChanges: false,
            collision: "fail",
          },
          scripts: null,
        },
      ],
    });
    let queuedMutation: Promise<WorktreeSetEntryModeResponse> | null = null;

    try {
      const hookWasEntered = await waitForPath(hookEntered, 3_000);
      if (!hookWasEntered) {
        throw new Error("Timed out waiting for the worktree checkout hook");
      }
      queuedMutation = state.setWorktreeEntryMode({
        ...owner,
        workspacePath: workspace,
      });
      state.reserveTurn(owner.epicId, owner.ownerId);
      await writeFile(hookRelease, "release\n");

      const created = await creating;
      expect(created.perEntry[0]).toMatchObject({
        ok: true,
        branch: "feature/active-owner-queue",
      });
      await expect(queuedMutation).rejects.toMatchObject({
        code: "WORKTREE_REBIND_BLOCKED",
        message: "Stop the active chat run before rebinding its worktree.",
      });
      expect(state.getBinding(owner).binding).toEqual(created.binding);
      expect(created.binding.entries[0]).toMatchObject({
        workspacePath: workspace,
        mode: "worktree",
        branch: "feature/active-owner-queue",
      });
    } finally {
      await writeFile(hookRelease, "release\n");
      await creating.catch(() => undefined);
      if (queuedMutation !== null) {
        await queuedMutation.catch(() => undefined);
      }
      state.releaseTurn(owner.epicId, owner.ownerId);
      restoreEnvironment();
      state.dispose();
    }
  });

  it("serializes competing owners at the repository mutation boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-worktree-repo-queue-"));
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    execFileSync("git", ["-C", workspace, "init", "-b", "main"]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.name",
      "Traycer Test",
    ]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.email",
      "traycer@example.com",
    ]);
    await writeFile(join(workspace, "README.md"), "base\n");
    execFileSync("git", ["-C", workspace, "add", "README.md"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);
    const linkedWorkspace = join(root, "linked-source");
    execFileSync("git", [
      "-C",
      workspace,
      "worktree",
      "add",
      "-b",
      "source-linked",
      linkedWorkspace,
      "main",
    ]);
    const state = new HostState("host-local", undefined, join(root, "managed"));
    const intent = {
      kind: "worktree" as const,
      workspacePath: workspace,
      repoIdentifier: null,
      isPrimary: true,
      branch: {
        type: "new" as const,
        name: "feature/shared",
        source: "main",
        carryUncommittedChanges: false,
        collision: "fail" as const,
      },
      scripts: null,
    };

    const results = await Promise.all([
      state.createWorktree({
        epicId: "epic-1",
        ownerId: "terminal-1",
        ownerKind: "terminal-agent",
        entries: [intent],
      }),
      state.createWorktree({
        epicId: "epic-1",
        ownerId: "terminal-2",
        ownerKind: "terminal-agent",
        entries: [{ ...intent, workspacePath: linkedWorkspace }],
      }),
    ]);
    const successful = results.filter((result) => result.perEntry[0]?.ok);
    const failed = results.filter((result) => !result.perEntry[0]?.ok);

    expect(successful).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const successfulPath = successful[0]?.perEntry[0]?.worktreePath;
    if (successfulPath === null || successfulPath === undefined) {
      throw new Error("Missing concurrently created worktree path");
    }
    expect(
      execFileSync("git", ["-C", successfulPath, "branch", "--show-current"])
        .toString()
        .trim(),
    ).toBe("feature/shared");
    expect(failed[0]?.perEntry[0]).toMatchObject({
      ok: false,
      branch: "feature/shared",
      errorMessage: expect.stringContaining("is already checked out in"),
    });
    state.dispose();
  });

  it("holds a managed-group lease through cleanup across independent clones", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "traycer-worktree-group-queue-")),
    );
    tempRoots.push(root);
    const firstWorkspace = join(root, "first-clone");
    const secondWorkspace = join(root, "second-clone");
    const outside = join(root, "outside");
    const wrapperDirectory = join(root, "bin");
    const realWorktreeRoot = join(root, "managed-real");
    const worktreeRoot = join(root, "managed");
    await Promise.all([
      mkdir(firstWorkspace),
      mkdir(outside),
      mkdir(wrapperDirectory),
      mkdir(realWorktreeRoot),
    ]);
    await symlink(realWorktreeRoot, worktreeRoot);
    execFileSync("git", ["-C", firstWorkspace, "init", "-b", "main"]);
    execFileSync("git", [
      "-C",
      firstWorkspace,
      "config",
      "user.name",
      "Traycer Test",
    ]);
    execFileSync("git", [
      "-C",
      firstWorkspace,
      "config",
      "user.email",
      "traycer@example.com",
    ]);
    await symlink(outside, join(firstWorkspace, ".traycer"));
    await writeFile(join(firstWorkspace, "README.md"), "base\n");
    execFileSync("git", ["-C", firstWorkspace, "add", "README.md", ".traycer"]);
    execFileSync("git", ["-C", firstWorkspace, "commit", "-m", "base"]);
    execFileSync("git", ["clone", "--local", firstWorkspace, secondWorkspace]);

    const realGit = execFileSync("which", ["git"]).toString().trim();
    const wrapper = join(wrapperDirectory, "git");
    const removeSignal = join(root, "remove-finished");
    const releaseSignal = join(root, "release-remove");
    const secondAddSignal = join(root, "second-add-started");
    await writeFile(
      wrapper,
      [
        "#!/bin/sh",
        'if [ "$1" = "-C" ] && [ "$2" = "$TRAYCER_TEST_SECOND_REPO" ] && [ "$3" = "worktree" ] && [ "$4" = "add" ]; then',
        '  : > "$TRAYCER_TEST_SECOND_ADD_SIGNAL"',
        "fi",
        '"$TRAYCER_TEST_REAL_GIT" "$@"',
        "status=$?",
        'if [ "$1" = "-C" ] && [ "$2" = "$TRAYCER_TEST_DELAY_REPO" ] && [ "$3" = "worktree" ] && [ "$4" = "remove" ]; then',
        '  : > "$TRAYCER_TEST_REMOVE_SIGNAL"',
        '  while [ ! -f "$TRAYCER_TEST_RELEASE_SIGNAL" ]; do sleep 0.01; done',
        "fi",
        'exit "$status"',
        "",
      ].join("\n"),
    );
    await chmod(wrapper, 0o755);

    const restoreEnvironment = overrideEnvironment({
      PATH: `${wrapperDirectory}:${process.env.PATH ?? ""}`,
      TRAYCER_TEST_REAL_GIT: realGit,
      TRAYCER_TEST_DELAY_REPO: firstWorkspace,
      TRAYCER_TEST_SECOND_REPO: secondWorkspace,
      TRAYCER_TEST_REMOVE_SIGNAL: removeSignal,
      TRAYCER_TEST_RELEASE_SIGNAL: releaseSignal,
      TRAYCER_TEST_SECOND_ADD_SIGNAL: secondAddSignal,
    });
    const state = new HostState("host-local", undefined, worktreeRoot);
    const base = {
      epicId: "epic-1",
      ownerKind: "terminal-agent" as const,
    };
    const branch = {
      type: "new" as const,
      name: "feature/shared",
      source: "main",
      carryUncommittedChanges: false,
      collision: "fail" as const,
    };
    let first: Promise<WorktreeCreateResponse> | null = null;
    let second: Promise<WorktreeCreateResponse> | null = null;
    let observer: Promise<WorktreeCreateResponse> | null = null;
    let observerSettled = false;
    try {
      first = state.createWorktree({
        ...base,
        ownerId: "terminal-first",
        entries: [
          {
            kind: "worktree",
            workspacePath: firstWorkspace,
            repoIdentifier: { owner: "Acme", repo: "Demo" },
            isPrimary: true,
            branch,
            scripts: {
              setup: { default: "", macos: null, windows: null, linux: null },
              teardown: {
                default: "",
                macos: null,
                windows: null,
                linux: null,
              },
            },
          },
        ],
      });
      expect(await waitForPath(removeSignal, 5_000)).toBe(true);

      const managedPath = join(worktreeRoot, "acme__demo", "feature-shared");
      observer = state.createWorktree({
        ...base,
        ownerId: "terminal-observer",
        entries: [
          {
            kind: "local",
            workspacePath: managedPath,
            repoIdentifier: null,
            isPrimary: true,
          },
        ],
      });
      observer.then(
        () => {
          observerSettled = true;
        },
        () => {
          observerSettled = true;
        },
      );
      await new Promise<void>((resolveWait) => {
        setTimeout(resolveWait, 50);
      });
      second = state.createWorktree({
        ...base,
        ownerId: "terminal-second",
        entries: [
          {
            kind: "worktree",
            workspacePath: secondWorkspace,
            repoIdentifier: { owner: "Acme", repo: "Demo" },
            isPrimary: true,
            branch,
            scripts: null,
          },
        ],
      });
      expect(await waitForPath(secondAddSignal, 300)).toBe(false);
      expect(observerSettled).toBe(false);
      await writeFile(releaseSignal, "release\n");

      const [failed, created] = await Promise.all([first, second]);
      await expect(observer).rejects.toThrow(
        `worktree.import: managed worktree ${managedPath} has no resolvable source workspace`,
      );
      expect(failed.perEntry[0]).toMatchObject({
        ok: false,
        errorMessage: expect.stringContaining("unsafe path"),
      });
      expect(created.perEntry).toEqual([
        {
          workspacePath: secondWorkspace,
          ok: true,
          worktreePath: join(worktreeRoot, "acme__demo", "feature-shared"),
          branch: "feature/shared",
          errorMessage: null,
        },
      ]);
      const createdPath = created.perEntry[0]?.worktreePath;
      if (createdPath === null || createdPath === undefined) {
        throw new Error("Missing cross-clone worktree path");
      }
      expect((await stat(createdPath)).isDirectory()).toBe(true);
      expect(
        execFileSync("git", ["-C", createdPath, "branch", "--show-current"])
          .toString()
          .trim(),
      ).toBe("feature/shared");
    } finally {
      await writeFile(releaseSignal, "release\n");
      restoreEnvironment();
      await Promise.allSettled(
        [first, second, observer].filter((value) => value !== null),
      );
      state.dispose();
    }
  });

  it("releases failed reservations without reclaiming unowned debris", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-worktree-debris-"));
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    const worktreeRoot = join(root, "managed");
    await mkdir(workspace);
    execFileSync("git", ["-C", workspace, "init", "-b", "main"]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.name",
      "Traycer Test",
    ]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.email",
      "traycer@example.com",
    ]);
    await writeFile(join(workspace, "README.md"), "base\n");
    execFileSync("git", ["-C", workspace, "add", "README.md"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);
    const state = new HostState("host-local", undefined, worktreeRoot);
    const repoIdentifier = { owner: "Acme", repo: "Demo" };
    const group = join(worktreeRoot, "acme__demo");
    const failedPath = join(group, "feature-invalid");

    const failed = await state.createWorktree({
      epicId: "epic-1",
      ownerId: "terminal-failed",
      ownerKind: "terminal-agent",
      entries: [
        {
          kind: "worktree",
          workspacePath: workspace,
          repoIdentifier,
          isPrimary: true,
          branch: {
            type: "new",
            name: "feature/invalid",
            source: "missing-source",
            carryUncommittedChanges: false,
            collision: "fail",
          },
          scripts: null,
        },
      ],
    });

    expect(failed.perEntry[0]).toMatchObject({ ok: false });
    await expect(stat(failedPath)).rejects.toMatchObject({ code: "ENOENT" });

    const debrisPath = join(group, "feature-dead");
    const missingGitDirectory = join(
      workspace,
      ".git",
      "worktrees",
      "missing-entry",
    );
    await mkdir(debrisPath, { recursive: true });
    await writeFile(
      join(debrisPath, ".git"),
      `gitdir: ${missingGitDirectory}\n`,
    );

    const recovered = await state.createWorktree({
      epicId: "epic-1",
      ownerId: "terminal-recovered",
      ownerKind: "terminal-agent",
      entries: [
        {
          kind: "worktree",
          workspacePath: workspace,
          repoIdentifier,
          isPrimary: true,
          branch: {
            type: "new",
            name: "feature/dead",
            source: "main",
            carryUncommittedChanges: false,
            collision: "fail",
          },
          scripts: null,
        },
      ],
    });

    expect(recovered.perEntry).toEqual([
      {
        workspacePath: workspace,
        ok: true,
        worktreePath: `${debrisPath}-2`,
        branch: "feature/dead",
        errorMessage: null,
      },
    ]);
    expect(await readFile(join(debrisPath, ".git"), "utf8")).toContain(
      missingGitDirectory,
    );
    expect(
      execFileSync("git", ["-C", `${debrisPath}-2`, "branch", "--show-current"])
        .toString()
        .trim(),
    ).toBe("feature/dead");

    const protectedPath = join(group, "feature-user-data");
    const sentinel = join(protectedPath, "UNTRACKED-USER-DATA");
    await mkdir(protectedPath);
    await Promise.all([
      writeFile(
        join(protectedPath, ".git"),
        `gitdir: ${join(workspace, ".git", "worktrees", "missing-user-data")}\n`,
      ),
      writeFile(sentinel, "keep me\n"),
    ]);
    const protectedResult = await state.createWorktree({
      epicId: "epic-1",
      ownerId: "terminal-protected",
      ownerKind: "terminal-agent",
      entries: [
        {
          kind: "worktree",
          workspacePath: workspace,
          repoIdentifier,
          isPrimary: true,
          branch: {
            type: "new",
            name: "feature/user-data",
            source: "main",
            carryUncommittedChanges: false,
            collision: "fail",
          },
          scripts: null,
        },
      ],
    });
    expect(protectedResult.perEntry[0]?.worktreePath).toBe(
      `${protectedPath}-2`,
    );
    expect(await readFile(sentinel, "utf8")).toBe("keep me\n");

    const foreignPath = join(group, "feature-foreign");
    const foreignMarker = join(foreignPath, ".git");
    await mkdir(foreignPath);
    await writeFile(
      foreignMarker,
      `gitdir: ${join(root, "foreign", "worktrees", "gone")}\n`,
    );
    const foreignResult = await state.createWorktree({
      epicId: "epic-1",
      ownerId: "terminal-foreign",
      ownerKind: "terminal-agent",
      entries: [
        {
          kind: "worktree",
          workspacePath: workspace,
          repoIdentifier,
          isPrimary: true,
          branch: {
            type: "new",
            name: "feature/foreign",
            source: "main",
            carryUncommittedChanges: false,
            collision: "fail",
          },
          scripts: null,
        },
      ],
    });
    expect(foreignResult.perEntry[0]?.worktreePath).toBe(`${foreignPath}-2`);
    expect(await readFile(foreignMarker, "utf8")).toContain(
      join(root, "foreign", "worktrees", "gone"),
    );
    state.dispose();
  });

  it("rejects a managed repository group that is a symlink", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "traycer-worktree-group-symlink-")),
    );
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    const worktreeRoot = join(root, "managed");
    const outside = join(root, "outside");
    await Promise.all([mkdir(workspace), mkdir(worktreeRoot), mkdir(outside)]);
    execFileSync("git", ["-C", workspace, "init", "-b", "main"]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.name",
      "Traycer Test",
    ]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.email",
      "traycer@example.com",
    ]);
    await writeFile(join(workspace, "README.md"), "base\n");
    execFileSync("git", ["-C", workspace, "add", "README.md"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);
    await symlink(outside, join(worktreeRoot, "acme__demo"));
    const state = new HostState("host-local", undefined, worktreeRoot);

    const result = await state.createWorktree({
      epicId: "epic-1",
      ownerId: "terminal-group-symlink",
      ownerKind: "terminal-agent",
      entries: [
        {
          kind: "worktree",
          workspacePath: workspace,
          repoIdentifier: { owner: "Acme", repo: "Demo" },
          isPrimary: true,
          branch: {
            type: "new",
            name: "feature/escape",
            source: "main",
            carryUncommittedChanges: false,
            collision: "fail",
          },
          scripts: null,
        },
      ],
    });
    expect(result.binding).toEqual({ entries: [] });
    expect(result.perEntry[0]).toMatchObject({
      ok: false,
      branch: "feature/escape",
      errorMessage: expect.stringContaining("unsafe managed worktree group"),
    });
    await expect(stat(join(outside, "feature-escape"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(() =>
      execFileSync("git", [
        "-C",
        workspace,
        "show-ref",
        "--verify",
        "--quiet",
        "refs/heads/feature/escape",
      ]),
    ).toThrow();
    state.dispose();
  });

  it("preserves an ambiguous checkout that a failing hook left registered", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-worktree-hook-fail-"));
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    const worktreeRoot = join(root, "managed");
    await mkdir(workspace);
    execFileSync("git", ["-C", workspace, "init", "-b", "main"]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.name",
      "Traycer Test",
    ]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.email",
      "traycer@example.com",
    ]);
    await writeFile(join(workspace, "README.md"), "base\n");
    execFileSync("git", ["-C", workspace, "add", "README.md"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);
    const baseCommit = execFileSync("git", [
      "-C",
      workspace,
      "rev-parse",
      "HEAD",
    ])
      .toString()
      .trim();
    const hook = join(workspace, ".git", "hooks", "post-checkout");
    await writeFile(hook, "#!/bin/sh\nexit 42\n");
    await chmod(hook, 0o755);
    const state = new HostState("host-local", undefined, worktreeRoot);
    const entry = {
      kind: "worktree" as const,
      workspacePath: workspace,
      repoIdentifier: { owner: "Acme", repo: "Demo" },
      isPrimary: true,
      branch: {
        type: "new" as const,
        name: "feature/hook",
        source: "main",
        carryUncommittedChanges: false,
        collision: "fail" as const,
      },
      scripts: null,
    };

    const failed = await state.createWorktree({
      epicId: "epic-1",
      ownerId: "terminal-failed-hook",
      ownerKind: "terminal-agent",
      entries: [entry],
    });

    expect(failed.perEntry[0]).toMatchObject({
      ok: false,
      branch: "feature/hook",
    });
    expect(
      execFileSync("git", ["-C", workspace, "worktree", "list", "--porcelain"])
        .toString()
        .includes("branch refs/heads/feature/hook"),
    ).toBe(true);
    expect(
      execFileSync("git", [
        "-C",
        workspace,
        "rev-parse",
        "refs/heads/feature/hook",
      ])
        .toString()
        .trim(),
    ).toBe(baseCommit);
    const expectedPath = join(worktreeRoot, "acme__demo", "feature-hook");
    expect((await stat(expectedPath)).isDirectory()).toBe(true);
    state.dispose();
  });

  it("stops random retries when a failing hook leaves its checkout registered", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "traycer-worktree-random-hook-fail-"),
    );
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    execFileSync("git", ["-C", workspace, "init", "-b", "main"]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.name",
      "Traycer Test",
    ]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.email",
      "traycer@example.com",
    ]);
    await writeFile(join(workspace, "README.md"), "base\n");
    execFileSync("git", ["-C", workspace, "add", "README.md"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);
    const hook = join(workspace, ".git", "hooks", "post-checkout");
    await writeFile(hook, "#!/bin/sh\nexit 42\n");
    await chmod(hook, 0o755);
    const before = execFileSync("git", [
      "-C",
      workspace,
      "worktree",
      "list",
      "--porcelain",
    ])
      .toString()
      .split("\n")
      .filter((line) => line.startsWith("worktree ")).length;
    const state = new HostState("host-local", undefined, join(root, "managed"));

    const result = await state.createWorktree({
      epicId: "epic-1",
      ownerId: "terminal-random-hook",
      ownerKind: "terminal-agent",
      entries: [
        {
          kind: "worktree",
          workspacePath: workspace,
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "feature/random-hook",
            source: "main",
            carryUncommittedChanges: false,
            collision: "random",
            retryIdentity: "random-hook-operation",
          },
          scripts: null,
        },
      ],
    });

    const failure = result.perEntry[0];
    expect(failure).toMatchObject({
      ok: false,
      branch: "feature/random-hook",
      worktreePath: null,
      errorMessage: expect.stringContaining(
        "git worktree add failed for feature/random-hook at",
      ),
    });
    if (failure?.errorMessage === null || failure?.errorMessage === undefined) {
      throw new Error("Missing random hook failure message");
    }
    expect(failure.errorMessage).not.toContain(
      "Could not find an available generated branch",
    );
    const after = execFileSync("git", [
      "-C",
      workspace,
      "worktree",
      "list",
      "--porcelain",
    ])
      .toString()
      .split("\n")
      .filter((line) => line.startsWith("worktree ")).length;
    expect(after).toBeLessThanOrEqual(before + 1);
    state.dispose();
  });

  it("preserves a fresh branch when a failing checkout hook advanced its tip", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "traycer-worktree-hook-commit-fail-"),
    );
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    const worktreeRoot = join(root, "managed");
    const hookCommitPath = join(root, "hook-commit");
    await mkdir(workspace);
    execFileSync("git", ["-C", workspace, "init", "-b", "main"]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.name",
      "Traycer Test",
    ]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.email",
      "traycer@example.com",
    ]);
    await writeFile(join(workspace, "README.md"), "base\n");
    execFileSync("git", ["-C", workspace, "add", "README.md"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);
    const hook = join(workspace, ".git", "hooks", "post-checkout");
    await writeFile(
      hook,
      [
        "#!/bin/sh",
        "echo hook-created > hook-created.txt",
        "git add hook-created.txt",
        "git commit -m hook-created >/dev/null",
        'git rev-parse HEAD > "$TRAYCER_TEST_HOOK_COMMIT"',
        "exit 42",
        "",
      ].join("\n"),
    );
    await chmod(hook, 0o755);
    const restoreEnvironment = overrideEnvironment({
      TRAYCER_TEST_HOOK_COMMIT: hookCommitPath,
    });
    const state = new HostState("host-local", undefined, worktreeRoot);
    try {
      const result = await state.createWorktree({
        epicId: "epic-1",
        ownerId: "terminal-hook-commit",
        ownerKind: "terminal-agent",
        entries: [
          {
            kind: "worktree",
            workspacePath: workspace,
            repoIdentifier: { owner: "Acme", repo: "Demo" },
            isPrimary: true,
            branch: {
              type: "new",
              name: "feature/hook-commit",
              source: "main",
              carryUncommittedChanges: false,
              collision: "fail",
            },
            scripts: null,
          },
        ],
      });

      expect(result.perEntry[0]).toMatchObject({
        ok: false,
        branch: "feature/hook-commit",
      });
      const hookCommit = (await readFile(hookCommitPath, "utf8")).trim();
      expect(
        execFileSync("git", [
          "-C",
          workspace,
          "rev-parse",
          "refs/heads/feature/hook-commit",
        ])
          .toString()
          .trim(),
      ).toBe(hookCommit);
      expect(
        execFileSync("git", [
          "-C",
          workspace,
          "worktree",
          "list",
          "--porcelain",
        ])
          .toString()
          .includes("branch refs/heads/feature/hook-commit"),
      ).toBe(true);
      expect(
        (
          await stat(join(worktreeRoot, "acme__demo", "feature-hook-commit"))
        ).isDirectory(),
      ).toBe(true);
    } finally {
      restoreEnvironment();
      state.dispose();
    }
  });

  it("does not delete a same-named branch created externally after preflight", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "traycer-worktree-branch-race-")),
    );
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    const wrapperDirectory = join(root, "bin");
    await Promise.all([mkdir(workspace), mkdir(wrapperDirectory)]);
    execFileSync("git", ["-C", workspace, "init", "-b", "main"]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.name",
      "Traycer Test",
    ]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.email",
      "traycer@example.com",
    ]);
    await writeFile(join(workspace, "README.md"), "base\n");
    execFileSync("git", ["-C", workspace, "add", "README.md"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);
    const tree = execFileSync("git", [
      "-C",
      workspace,
      "rev-parse",
      "HEAD^{tree}",
    ])
      .toString()
      .trim();
    const externalCommit = execFileSync("git", [
      "-C",
      workspace,
      "commit-tree",
      tree,
      "-p",
      "HEAD",
      "-m",
      "external branch",
    ])
      .toString()
      .trim();
    const realGit = execFileSync("which", ["git"]).toString().trim();
    const injected = join(root, "branch-injected");
    const wrapper = join(wrapperDirectory, "git");
    await writeFile(
      wrapper,
      [
        "#!/bin/sh",
        'if [ "$1" = "-C" ] && [ "$2" = "$TRAYCER_TEST_RACE_REPO" ] && [ "$3" = "worktree" ] && [ "$4" = "add" ] && [ "$5" = "-b" ] && [ ! -f "$TRAYCER_TEST_RACE_SIGNAL" ]; then',
        '  "$TRAYCER_TEST_REAL_GIT" -C "$2" branch "$TRAYCER_TEST_RACE_BRANCH" "$TRAYCER_TEST_RACE_COMMIT"',
        '  : > "$TRAYCER_TEST_RACE_SIGNAL"',
        "fi",
        'exec "$TRAYCER_TEST_REAL_GIT" "$@"',
        "",
      ].join("\n"),
    );
    await chmod(wrapper, 0o755);
    const restoreEnvironment = overrideEnvironment({
      PATH: `${wrapperDirectory}:${process.env.PATH ?? ""}`,
      TRAYCER_TEST_REAL_GIT: realGit,
      TRAYCER_TEST_RACE_REPO: workspace,
      TRAYCER_TEST_RACE_SIGNAL: injected,
      TRAYCER_TEST_RACE_BRANCH: "feature/race",
      TRAYCER_TEST_RACE_COMMIT: externalCommit,
    });
    const state = new HostState("host-local", undefined, join(root, "managed"));
    try {
      const result = await state.createWorktree({
        epicId: "epic-1",
        ownerId: "terminal-race",
        ownerKind: "terminal-agent",
        entries: [
          {
            kind: "worktree",
            workspacePath: workspace,
            repoIdentifier: { owner: "Acme", repo: "Demo" },
            isPrimary: true,
            branch: {
              type: "new",
              name: "feature/race",
              source: "main",
              carryUncommittedChanges: false,
              collision: "fail",
            },
            scripts: null,
          },
        ],
      });

      expect(result.binding).toEqual({ entries: [] });
      expect(result.perEntry[0]).toMatchObject({
        ok: false,
        branch: "feature/race",
      });
      expect(
        execFileSync("git", [
          "-C",
          workspace,
          "rev-parse",
          "refs/heads/feature/race",
        ])
          .toString()
          .trim(),
      ).toBe(externalCommit);
    } finally {
      restoreEnvironment();
      state.dispose();
    }
  });

  it("adopts a same-tip branch left by a transient first add failure", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "traycer-worktree-add-retry-")),
    );
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    const wrapperDirectory = join(root, "bin");
    const worktreeRoot = join(root, "managed");
    await Promise.all([mkdir(workspace), mkdir(wrapperDirectory)]);
    execFileSync("git", ["-C", workspace, "init", "-b", "main"]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.name",
      "Traycer Test",
    ]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.email",
      "traycer@example.com",
    ]);
    await writeFile(join(workspace, "README.md"), "base\n");
    execFileSync("git", ["-C", workspace, "add", "README.md"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);

    const realGit = execFileSync("which", ["git"]).toString().trim();
    const injected = join(root, "first-add-failed");
    const wrapper = join(wrapperDirectory, "git");
    await writeFile(
      wrapper,
      [
        "#!/bin/sh",
        'if [ "$1" = "-C" ] && [ "$2" = "$TRAYCER_TEST_RETRY_REPO" ] && [ "$3" = "worktree" ] && [ "$4" = "add" ] && [ "$5" = "-b" ] && [ ! -f "$TRAYCER_TEST_RETRY_SIGNAL" ]; then',
        '  "$TRAYCER_TEST_REAL_GIT" -C "$2" branch "$TRAYCER_TEST_RETRY_BRANCH" main',
        '  : > "$TRAYCER_TEST_RETRY_SIGNAL"',
        "  exit 42",
        "fi",
        'exec "$TRAYCER_TEST_REAL_GIT" "$@"',
        "",
      ].join("\n"),
    );
    await chmod(wrapper, 0o755);
    const restoreEnvironment = overrideEnvironment({
      PATH: `${wrapperDirectory}:${process.env.PATH ?? ""}`,
      TRAYCER_TEST_REAL_GIT: realGit,
      TRAYCER_TEST_RETRY_REPO: workspace,
      TRAYCER_TEST_RETRY_SIGNAL: injected,
      TRAYCER_TEST_RETRY_BRANCH: "feature/transient",
    });
    const state = new HostState("host-local", undefined, worktreeRoot);
    try {
      const result = await state.createWorktree({
        epicId: "epic-1",
        ownerId: "terminal-transient",
        ownerKind: "terminal-agent",
        entries: [
          {
            kind: "worktree",
            workspacePath: workspace,
            repoIdentifier: { owner: "Acme", repo: "Demo" },
            isPrimary: true,
            branch: {
              type: "new",
              name: "feature/transient",
              source: "main",
              carryUncommittedChanges: false,
              collision: "fail",
            },
            scripts: null,
          },
        ],
      });

      expect(result.perEntry).toEqual([
        {
          workspacePath: workspace,
          ok: true,
          worktreePath: join(worktreeRoot, "acme__demo", "feature-transient"),
          branch: "feature/transient",
          errorMessage: null,
        },
      ]);
      expect(
        execFileSync("git", [
          "-C",
          result.perEntry[0]?.worktreePath ?? "",
          "branch",
          "--show-current",
        ])
          .toString()
          .trim(),
      ).toBe("feature/transient");
    } finally {
      restoreEnvironment();
      state.dispose();
    }
  });

  it("rewrites a Local intent for a managed checkout into an imported binding", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "traycer-worktree-local-import-")),
    );
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    const realWorktreeRoot = join(root, "managed-real");
    const worktreeRoot = join(root, "managed");
    const managedPath = join(worktreeRoot, "group", "linked");
    await mkdir(realWorktreeRoot);
    await symlink(realWorktreeRoot, worktreeRoot);
    await Promise.all([
      mkdir(workspace),
      mkdir(join(worktreeRoot, "group"), { recursive: true }),
    ]);
    execFileSync("git", ["-C", workspace, "init", "-b", "main"]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.name",
      "Traycer Test",
    ]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.email",
      "traycer@example.com",
    ]);
    await writeFile(join(workspace, "README.md"), "base\n");
    execFileSync("git", ["-C", workspace, "add", "README.md"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);
    execFileSync("git", [
      "-C",
      workspace,
      "worktree",
      "add",
      "-b",
      "linked",
      managedPath,
      "main",
    ]);
    const state = new HostState("host-local", undefined, worktreeRoot);
    const owner = {
      epicId: "epic-1",
      ownerId: "terminal-1",
      ownerKind: "terminal-agent" as const,
    };
    await state.setWorktreeEntryMode({ ...owner, workspacePath: managedPath });

    const result = await state.createWorktree({
      ...owner,
      entries: [
        {
          kind: "local",
          workspacePath: managedPath,
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    });

    expect(result.perEntry).toEqual([
      {
        workspacePath: await realpath(workspace),
        ok: true,
        worktreePath: managedPath,
        branch: "linked",
        errorMessage: null,
      },
    ]);
    expect(result.binding.entries).toEqual([
      expect.objectContaining({
        workspacePath: await realpath(workspace),
        mode: "worktree",
        worktreePath: managedPath,
        branch: "linked",
        isPrimary: true,
        isImported: true,
      }),
    ]);
    const nested = join(managedPath, "nested");
    await mkdir(nested);
    const nestedResult = await state.createWorktree({
      epicId: "epic-1",
      ownerId: "terminal-nested",
      ownerKind: "terminal-agent",
      entries: [
        {
          kind: "local",
          workspacePath: nested,
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    });
    expect(nestedResult.binding.entries).toEqual([
      expect.objectContaining({
        workspacePath: nested,
        mode: "local",
        worktreePath: null,
        isImported: false,
      }),
    ]);

    const independentRepo = join(worktreeRoot, "independent", "repo");
    await mkdir(independentRepo, { recursive: true });
    execFileSync("git", ["-C", independentRepo, "init", "-b", "main"]);
    const independentResult = await state.createWorktree({
      epicId: "epic-1",
      ownerId: "terminal-independent",
      ownerKind: "terminal-agent",
      entries: [
        {
          kind: "local",
          workspacePath: independentRepo,
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    });
    expect(independentResult.binding.entries).toEqual([
      expect.objectContaining({
        workspacePath: independentRepo,
        mode: "local",
        worktreePath: null,
        isImported: false,
      }),
    ]);
    const outsideRepo = join(root, "outside-repo");
    const escapePath = join(worktreeRoot, "escape", "repo");
    await Promise.all([
      mkdir(outsideRepo),
      mkdir(join(worktreeRoot, "escape"), { recursive: true }),
    ]);
    execFileSync("git", ["-C", outsideRepo, "init", "-b", "main"]);
    await symlink(outsideRepo, escapePath);
    const escapeResult = await state.createWorktree({
      epicId: "epic-1",
      ownerId: "terminal-escape",
      ownerKind: "terminal-agent",
      entries: [
        {
          kind: "local",
          workspacePath: escapePath,
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    });
    expect(escapeResult.binding.entries).toEqual([
      expect.objectContaining({
        workspacePath: escapePath,
        mode: "local",
        worktreePath: null,
        isImported: false,
      }),
    ]);
    const aliasPath = join(worktreeRoot, "group", "linked-alias");
    await symlink(managedPath, aliasPath);
    const aliasResult = await state.createWorktree({
      epicId: "epic-1",
      ownerId: "terminal-alias",
      ownerKind: "terminal-agent",
      entries: [
        {
          kind: "local",
          workspacePath: aliasPath,
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    });
    expect(aliasResult.binding.entries).toEqual([
      expect.objectContaining({
        workspacePath: aliasPath,
        mode: "local",
        worktreePath: null,
        isImported: false,
      }),
    ]);
    const orphan = join(worktreeRoot, "group", "orphan");
    await mkdir(orphan);
    await expect(
      state.createWorktree({
        epicId: "epic-1",
        ownerId: "terminal-orphan",
        ownerKind: "terminal-agent",
        entries: [
          {
            kind: "local",
            workspacePath: orphan,
            repoIdentifier: null,
            isPrimary: true,
          },
        ],
      }),
    ).rejects.toThrow(
      `worktree.import: managed worktree ${orphan} has no resolvable source workspace`,
    );
    state.dispose();
  });

  it("does not let an in-flight create resurrect a deleted chat binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-worktree-delete-race-"));
    tempRoots.push(root);
    const local = join(root, "local");
    await mkdir(local);
    const state = new HostState("host-local", undefined, join(root, "managed"));
    const now = Date.now();
    state.createEpic(
      createEpicRequestSchema.parse({
        epic: {
          id: "epic-1",
          title: "Race task",
          initialUserPrompt: "",
          ticketCount: 0,
          specCount: 0,
          storyCount: 0,
          reviewCount: 0,
          status: "active",
          createdAt: now,
          updatedAt: now,
          createdBy: "local-user",
          version: "1.0.0",
        },
        repoIdentifiers: [],
        workspaces: [],
        chat: null,
      }),
    );
    state.createChat({
      epicId: "epic-1",
      chatId: "chat-1",
      parentId: null,
      hostId: "host-local",
      title: "Race chat",
      settings: null,
      initialMessage: null,
    });

    const creating = state.createWorktree({
      epicId: "epic-1",
      ownerId: "chat-1",
      ownerKind: "chat",
      entries: [
        {
          kind: "local",
          workspacePath: local,
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    });
    const deleting = state.deleteChat({
      epicId: "epic-1",
      chatId: "chat-1",
    });
    await Promise.all([creating, deleting]);

    expect(state.getChat("epic-1", "chat-1")).toBeNull();
    expect(
      state.getBinding({
        epicId: "epic-1",
        ownerId: "chat-1",
        ownerKind: "chat",
      }).binding,
    ).toBeNull();
    state.dispose();
  });

  it("commits successful entries while preserving a failed path's old binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-worktree-partial-"));
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    const nonGit = join(root, "not-git");
    const local = join(root, "local-folder");
    const importSource = join(root, "import-source");
    const imported = join(root, "imported-worktree");
    await Promise.all([
      mkdir(workspace),
      mkdir(nonGit),
      mkdir(local),
      mkdir(importSource),
    ]);
    execFileSync("git", ["-C", workspace, "init", "-b", "main"]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.name",
      "Traycer Test",
    ]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.email",
      "traycer@example.com",
    ]);
    await writeFile(join(workspace, "README.md"), "base\n");
    execFileSync("git", ["-C", workspace, "add", "README.md"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);
    execFileSync("git", ["-C", importSource, "init", "-b", "main"]);
    execFileSync("git", [
      "-C",
      importSource,
      "config",
      "user.name",
      "Traycer Test",
    ]);
    execFileSync("git", [
      "-C",
      importSource,
      "config",
      "user.email",
      "traycer@example.com",
    ]);
    await writeFile(join(importSource, "README.md"), "import\n");
    execFileSync("git", ["-C", importSource, "add", "README.md"]);
    execFileSync("git", ["-C", importSource, "commit", "-m", "base"]);
    execFileSync("git", [
      "-C",
      importSource,
      "worktree",
      "add",
      "-b",
      "imported",
      imported,
      "main",
    ]);
    const state = new HostState("host-local", undefined, join(root, "managed"));
    const owner = {
      epicId: "epic-1",
      ownerId: "terminal-1",
      ownerKind: "terminal-agent" as const,
    };
    const old = await state.setWorktreeEntryMode({
      ...owner,
      workspacePath: nonGit,
    });
    const oldEntry = old.binding.entries[0];

    const result = await state.createWorktree({
      ...owner,
      entries: [
        {
          kind: "local",
          workspacePath: local,
          repoIdentifier: null,
          isPrimary: false,
        },
        {
          kind: "import",
          workspacePath: importSource,
          repoIdentifier: null,
          isPrimary: false,
          worktreePath: imported,
        },
        {
          kind: "worktree",
          workspacePath: workspace,
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "feature/partial",
            source: "main",
            carryUncommittedChanges: false,
            collision: "fail",
          },
          scripts: null,
        },
        {
          kind: "worktree",
          workspacePath: nonGit,
          repoIdentifier: null,
          isPrimary: false,
          branch: {
            type: "new",
            name: "feature/fails",
            source: "main",
            carryUncommittedChanges: false,
            collision: "fail",
          },
          scripts: null,
        },
      ],
    });

    expect(result.perEntry.map((entry) => entry.workspacePath)).toEqual([
      workspace,
      nonGit,
      local,
      importSource,
    ]);
    expect(result.perEntry).toEqual([
      {
        workspacePath: workspace,
        ok: true,
        worktreePath: expect.any(String),
        branch: "feature/partial",
        errorMessage: null,
      },
      {
        workspacePath: nonGit,
        ok: false,
        worktreePath: null,
        branch: "feature/fails",
        errorMessage: `Workspace is not a git repository: ${nonGit}`,
      },
      {
        workspacePath: local,
        ok: true,
        worktreePath: null,
        branch: null,
        errorMessage: null,
      },
      {
        workspacePath: importSource,
        ok: true,
        worktreePath: imported,
        branch: "imported",
        errorMessage: null,
      },
    ]);
    expect(result.binding.entries).toEqual([
      { ...oldEntry, isPrimary: false },
      expect.objectContaining({
        workspacePath: workspace,
        mode: "worktree",
        branch: "feature/partial",
        isPrimary: true,
      }),
      expect.objectContaining({
        workspacePath: local,
        mode: "local",
        isPrimary: false,
      }),
      expect.objectContaining({
        workspacePath: importSource,
        mode: "worktree",
        worktreePath: imported,
        branch: "imported",
        isImported: true,
      }),
    ]);
    const createdEntry = result.binding.entries.find(
      (entry) => entry.workspacePath === workspace,
    );
    if (createdEntry === undefined) {
      throw new Error("Missing created worktree entry");
    }
    const replay = await state.createWorktree({
      ...owner,
      entries: [
        {
          kind: "worktree",
          workspacePath: workspace,
          repoIdentifier: { owner: "Ignored", repo: "OnAdoption" },
          isPrimary: false,
          branch: { type: "existing", name: "feature/partial" },
          scripts: null,
        },
      ],
    });
    expect(replay.perEntry).toEqual([
      {
        workspacePath: workspace,
        ok: true,
        worktreePath: createdEntry.worktreePath,
        branch: "feature/partial",
        errorMessage: null,
      },
    ]);
    expect(replay.binding.entries.at(-1)).toEqual(createdEntry);
    state.dispose();
  });

  it("keeps earlier worktrees bound when a later managed path cannot be allocated", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-worktree-path-error-"));
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    execFileSync("git", ["-C", workspace, "init", "-b", "main"]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.name",
      "Traycer Test",
    ]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.email",
      "traycer@example.com",
    ]);
    await writeFile(join(workspace, "README.md"), "base\n");
    execFileSync("git", ["-C", workspace, "add", "README.md"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);
    const longBranch = Array.from(
      { length: 70 },
      (_, index) => `segment-${index}`,
    ).join("/");
    const state = new HostState("host-local", undefined, join(root, "managed"));

    const result = await state.createWorktree({
      epicId: "epic-1",
      ownerId: "terminal-path-error",
      ownerKind: "terminal-agent",
      entries: [
        {
          kind: "worktree",
          workspacePath: workspace,
          repoIdentifier: { owner: "Acme", repo: "Demo" },
          isPrimary: true,
          branch: {
            type: "new",
            name: "feature/kept",
            source: "main",
            carryUncommittedChanges: false,
            collision: "fail",
          },
          scripts: null,
        },
        {
          kind: "worktree",
          workspacePath: workspace,
          repoIdentifier: { owner: "Acme", repo: "Demo" },
          isPrimary: false,
          branch: {
            type: "new",
            name: longBranch,
            source: "main",
            carryUncommittedChanges: false,
            collision: "fail",
          },
          scripts: null,
        },
      ],
    });

    expect(result.perEntry[0]).toMatchObject({
      ok: true,
      branch: "feature/kept",
      worktreePath: expect.any(String),
    });
    expect(result.perEntry[1]).toMatchObject({
      ok: false,
      branch: longBranch,
      worktreePath: null,
      errorMessage: expect.any(String),
    });
    expect(result.binding.entries).toHaveLength(1);
    expect(result.binding.entries[0]).toMatchObject({
      branch: "feature/kept",
      mode: "worktree",
    });
    state.dispose();
  });

  it("materializes an empty intent as an explicit folderless binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-worktree-empty-"));
    tempRoots.push(root);
    const state = new HostState("host-local", undefined, join(root, "managed"));
    const owner = {
      epicId: "epic-1",
      ownerId: "terminal-1",
      ownerKind: "terminal-agent" as const,
    };

    expect(await state.createWorktree({ ...owner, entries: [] })).toEqual({
      binding: { workspaceMode: "folderless", entries: [] },
      perEntry: [],
    });
    expect(state.getBinding(owner)).toEqual({
      binding: { workspaceMode: "folderless", entries: [] },
      missingWorktreePaths: [],
    });
    state.dispose();
  });

  it("blocks active chat owners while keeping terminal-agent owners exempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-worktree-active-"));
    tempRoots.push(root);
    const state = new HostState("host-local", undefined, join(root, "managed"));
    state.reserveTurn("epic-1", "owner-1");

    await expect(
      state.createWorktree({
        epicId: "epic-1",
        ownerId: "owner-1",
        ownerKind: "chat",
        entries: [],
      }),
    ).rejects.toMatchObject({
      code: "WORKTREE_REBIND_BLOCKED",
      message: "Stop the active chat run before rebinding its worktree.",
    });
    await expect(
      state.createWorktree({
        epicId: "epic-1",
        ownerId: "owner-1",
        ownerKind: "terminal-agent",
        entries: [],
      }),
    ).resolves.toEqual({
      binding: { workspaceMode: "folderless", entries: [] },
      perEntry: [],
    });

    state.releaseTurn("epic-1", "owner-1");
    state.dispose();
  });

  it("rejects a committed setup command before creating a branch or directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-worktree-setup-"));
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".traycer"), { recursive: true });
    execFileSync("git", ["-C", workspace, "init", "-b", "main"]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.name",
      "Traycer Test",
    ]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.email",
      "traycer@example.com",
    ]);
    await writeFile(
      join(workspace, ".traycer", "environment.json"),
      JSON.stringify({
        setup: {
          default: "bun install",
          macos: null,
          windows: null,
          linux: null,
        },
        teardown: {
          default: "",
          macos: null,
          windows: null,
          linux: null,
        },
        updatedAt: 1,
      }),
    );
    execFileSync("git", ["-C", workspace, "add", ".traycer/environment.json"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "environment"]);
    const state = new HostState("host-local", undefined, join(root, "managed"));
    const owner = {
      epicId: "epic-1",
      ownerId: "terminal-1",
      ownerKind: "terminal-agent" as const,
    };

    const result = await state.createWorktree({
      ...owner,
      entries: [
        {
          kind: "worktree",
          workspacePath: workspace,
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "feature/setup",
            source: "main",
            carryUncommittedChanges: false,
            collision: "fail",
          },
          scripts: null,
        },
      ],
    });

    expect(result).toEqual({
      binding: { entries: [] },
      perEntry: [
        {
          workspacePath: workspace,
          ok: false,
          worktreePath: null,
          branch: "feature/setup",
          errorMessage:
            "Worktree setup commands are not supported by this local host yet.",
        },
      ],
    });
    expect(
      execFileSync("git", [
        "-C",
        workspace,
        "branch",
        "--list",
        "feature/setup",
      ])
        .toString()
        .trim(),
    ).toBe("");
    state.dispose();
  });

  it("writes an empty setup override without inventing setup work", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-worktree-scripts-"));
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    execFileSync("git", ["-C", workspace, "init", "-b", "main"]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.name",
      "Traycer Test",
    ]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.email",
      "traycer@example.com",
    ]);
    await writeFile(join(workspace, "README.md"), "base\n");
    execFileSync("git", ["-C", workspace, "add", "README.md"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);
    await mkdir(join(workspace, ".traycer"));
    const carriedScripts = {
      setup: {
        default: "carried setup",
        macos: null,
        windows: null,
        linux: null,
      },
      teardown: {
        default: "carried teardown",
        macos: null,
        windows: null,
        linux: null,
      },
      updatedAt: 1,
    };
    await writeFile(
      join(workspace, ".traycer", "environment.json"),
      JSON.stringify(carriedScripts),
    );
    const state = new HostState("host-local", undefined, join(root, "managed"));
    const scripts = {
      setup: {
        default: "",
        macos: null,
        windows: null,
        linux: null,
      },
      teardown: {
        default: "cleanup",
        macos: null,
        windows: null,
        linux: null,
      },
    };

    const result = await state.createWorktree({
      epicId: "epic-1",
      ownerId: "terminal-1",
      ownerKind: "terminal-agent",
      entries: [
        {
          kind: "worktree",
          workspacePath: workspace,
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "feature/scripts",
            source: "main",
            carryUncommittedChanges: true,
            collision: "fail",
          },
          scripts,
        },
      ],
    });
    const created = result.binding.entries[0];
    if (created?.worktreePath === null || created?.worktreePath === undefined) {
      throw new Error("Missing created worktree path");
    }

    expect(created.setupState).toBe("not_required");
    expect(
      JSON.parse(
        await readFile(
          join(created.worktreePath, ".traycer", "environment.json"),
          "utf8",
        ),
      ),
    ).toEqual({ ...scripts, updatedAt: expect.any(Number) });
    expect(
      JSON.parse(
        await readFile(join(workspace, ".traycer", "environment.json"), "utf8"),
      ),
    ).toEqual(carriedScripts);
    state.dispose();
  });

  it("does not follow a repository-controlled scripts symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-worktree-symlink-"));
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await Promise.all([mkdir(workspace), mkdir(outside)]);
    execFileSync("git", ["-C", workspace, "init", "-b", "main"]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.name",
      "Traycer Test",
    ]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.email",
      "traycer@example.com",
    ]);
    const sentinel = join(outside, "environment.json");
    await writeFile(sentinel, "do not overwrite\n");
    await symlink(outside, join(workspace, ".traycer"));
    await writeFile(join(workspace, "README.md"), "base\n");
    execFileSync("git", ["-C", workspace, "add", "README.md", ".traycer"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);
    const state = new HostState("host-local", undefined, join(root, "managed"));

    const result = await state.createWorktree({
      epicId: "epic-1",
      ownerId: "terminal-1",
      ownerKind: "terminal-agent",
      entries: [
        {
          kind: "worktree",
          workspacePath: workspace,
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new",
            name: "feature/symlink",
            source: "main",
            carryUncommittedChanges: false,
            collision: "fail",
          },
          scripts: {
            setup: { default: "", macos: null, windows: null, linux: null },
            teardown: {
              default: "",
              macos: null,
              windows: null,
              linux: null,
            },
          },
        },
      ],
    });

    expect(result.binding).toEqual({ entries: [] });
    expect(result.perEntry[0]).toMatchObject({
      ok: false,
      errorMessage: expect.stringContaining("unsafe path"),
    });
    expect(await readFile(sentinel, "utf8")).toBe("do not overwrite\n");
    expect(
      execFileSync("git", [
        "-C",
        workspace,
        "rev-parse",
        "refs/heads/feature/symlink",
      ])
        .toString()
        .trim(),
    ).toBe(
      execFileSync("git", ["-C", workspace, "rev-parse", "main"])
        .toString()
        .trim(),
    );
    expect(
      execFileSync("git", ["-C", workspace, "worktree", "list", "--porcelain"])
        .toString()
        .includes("branch refs/heads/feature/symlink"),
    ).toBe(false);
    state.dispose();
  });

  it("keeps the branch when a failed checkout cannot be removed safely", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "traycer-worktree-cleanup-fail-")),
    );
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    const wrapperDirectory = join(root, "bin");
    const worktreeRoot = join(root, "managed");
    const group = join(worktreeRoot, "acme__demo");
    const worktreePath = join(group, "feature-stuck");
    await Promise.all([
      mkdir(workspace),
      mkdir(outside),
      mkdir(wrapperDirectory),
    ]);
    execFileSync("git", ["-C", workspace, "init", "-b", "main"]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.name",
      "Traycer Test",
    ]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.email",
      "traycer@example.com",
    ]);
    await symlink(outside, join(workspace, ".traycer"));
    await writeFile(join(workspace, "README.md"), "base\n");
    execFileSync("git", ["-C", workspace, "add", "README.md", ".traycer"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);

    const realGit = execFileSync("which", ["git"]).toString().trim();
    const wrapper = join(wrapperDirectory, "git");
    await writeFile(
      wrapper,
      [
        "#!/bin/sh",
        'if [ "$1" = "-C" ] && [ "$2" = "$TRAYCER_TEST_CLEANUP_REPO" ] && [ "$3" = "worktree" ] && [ "$4" = "remove" ]; then',
        '  chmod 0500 "$TRAYCER_TEST_CLEANUP_GROUP"',
        "  exit 42",
        "fi",
        'exec "$TRAYCER_TEST_REAL_GIT" "$@"',
        "",
      ].join("\n"),
    );
    await chmod(wrapper, 0o755);
    const restoreEnvironment = overrideEnvironment({
      PATH: `${wrapperDirectory}:${process.env.PATH ?? ""}`,
      TRAYCER_TEST_REAL_GIT: realGit,
      TRAYCER_TEST_CLEANUP_REPO: workspace,
      TRAYCER_TEST_CLEANUP_GROUP: group,
    });
    const state = new HostState("host-local", undefined, worktreeRoot);
    try {
      const result = await state.createWorktree({
        epicId: "epic-1",
        ownerId: "terminal-stuck",
        ownerKind: "terminal-agent",
        entries: [
          {
            kind: "worktree",
            workspacePath: workspace,
            repoIdentifier: { owner: "Acme", repo: "Demo" },
            isPrimary: true,
            branch: {
              type: "new",
              name: "feature/stuck",
              source: "main",
              carryUncommittedChanges: false,
              collision: "fail",
            },
            scripts: {
              setup: { default: "", macos: null, windows: null, linux: null },
              teardown: {
                default: "",
                macos: null,
                windows: null,
                linux: null,
              },
            },
          },
        ],
      });

      expect(result.binding).toEqual({ entries: [] });
      expect(result.perEntry[0]).toMatchObject({
        ok: false,
        branch: "feature/stuck",
      });
      expect((await stat(worktreePath)).isDirectory()).toBe(true);
      expect(
        execFileSync(realGit, [
          "-C",
          workspace,
          "rev-parse",
          "refs/heads/feature/stuck",
        ])
          .toString()
          .trim(),
      ).toMatch(/^[0-9a-f]{40}$/u);
      expect(
        execFileSync(realGit, [
          "-C",
          workspace,
          "worktree",
          "list",
          "--porcelain",
        ])
          .toString()
          .includes(`worktree ${worktreePath}`),
      ).toBe(true);
    } finally {
      restoreEnvironment();
      await chmod(group, 0o700).catch(() => undefined);
      state.dispose();
    }
  });

  it("retries generated branch collisions deterministically by retry identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-worktree-random-"));
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    execFileSync("git", ["-C", workspace, "init", "-b", "main"]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.name",
      "Traycer Test",
    ]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.email",
      "traycer@example.com",
    ]);
    await writeFile(join(workspace, "README.md"), "base\n");
    execFileSync("git", ["-C", workspace, "add", "README.md"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);
    execFileSync("git", ["-C", workspace, "branch", "traycer/generated"]);
    const state = new HostState("host-local", undefined, join(root, "managed"));
    const request = {
      epicId: "epic-1",
      ownerId: "terminal-1",
      ownerKind: "terminal-agent" as const,
      entries: [
        {
          kind: "worktree" as const,
          workspacePath: workspace,
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new" as const,
            name: "traycer/generated",
            source: "main",
            carryUncommittedChanges: false,
            collision: "random" as const,
            retryIdentity: "same-generated-operation",
          },
          scripts: null,
        },
      ],
    };

    const first = await state.createWorktree(request);
    expect(first.perEntry).toEqual([
      {
        workspacePath: workspace,
        ok: true,
        worktreePath: expect.any(String),
        branch: expect.stringMatching(/^traycer\/generated-/u),
        errorMessage: null,
      },
    ]);
    const firstResult = first.perEntry[0];
    if (
      firstResult === undefined ||
      firstResult.worktreePath === null ||
      firstResult.branch === null
    ) {
      throw new Error("Missing generated worktree result");
    }
    expect(
      execFileSync("git", [
        "-C",
        firstResult.worktreePath,
        "branch",
        "--show-current",
      ])
        .toString()
        .trim(),
    ).toBe(firstResult.branch);

    const replay = await state.createWorktree(request);
    expect(replay.perEntry).toEqual(first.perEntry);
    expect(replay.binding).toEqual(first.binding);

    const secondOwner = await state.createWorktree({
      ...request,
      ownerId: "terminal-2",
    });
    expect(secondOwner.perEntry).toEqual(first.perEntry);
    expect(secondOwner.binding.entries[0]?.worktreePath).toBe(
      firstResult.worktreePath,
    );

    const independent = await state.createWorktree({
      ...request,
      ownerId: "terminal-3",
      entries: [
        {
          ...request.entries[0],
          branch: {
            ...request.entries[0].branch,
            retryIdentity: "another-generated-operation",
          },
        },
      ],
    });
    expect(independent.perEntry[0]).toMatchObject({
      ok: true,
      branch: expect.stringMatching(/^traycer\/generated-/u),
    });
    expect(independent.perEntry[0]?.branch).not.toBe(firstResult.branch);
    expect(independent.perEntry[0]?.worktreePath).not.toBe(
      firstResult.worktreePath,
    );
    state.dispose();
  });

  it("keeps random retry identities independent for one owner and branch name", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "traycer-worktree-random-owner-retry-"),
    );
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    execFileSync("git", ["-C", workspace, "init", "-b", "main"]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.name",
      "Traycer Test",
    ]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.email",
      "traycer@example.com",
    ]);
    await writeFile(join(workspace, "README.md"), "base\n");
    execFileSync("git", ["-C", workspace, "add", "README.md"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);
    const state = new HostState("host-local", undefined, join(root, "managed"));
    const firstRequest = {
      epicId: "epic-1",
      ownerId: "terminal-1",
      ownerKind: "terminal-agent" as const,
      entries: [
        {
          kind: "worktree" as const,
          workspacePath: workspace,
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new" as const,
            name: "traycer/friendly",
            source: "main",
            carryUncommittedChanges: false,
            collision: "random" as const,
            retryIdentity: "friendly-operation-a",
          },
          scripts: null,
        },
      ],
    };

    const first = await state.createWorktree(firstRequest);
    expect(first.perEntry[0]).toMatchObject({
      ok: true,
      branch: "traycer/friendly",
      worktreePath: expect.any(String),
    });
    const secondRequest = {
      ...firstRequest,
      entries: [
        {
          ...firstRequest.entries[0],
          branch: {
            ...firstRequest.entries[0].branch,
            retryIdentity: "friendly-operation-b",
          },
        },
      ],
    };
    const second = await state.createWorktree(secondRequest);
    expect(second.perEntry[0]).toMatchObject({
      ok: true,
      branch: expect.stringMatching(/^traycer\/friendly-[0-9a-f]{10}$/u),
      worktreePath: expect.any(String),
    });
    expect(second.perEntry[0]?.branch).not.toBe(first.perEntry[0]?.branch);
    expect(second.perEntry[0]?.worktreePath).not.toBe(
      first.perEntry[0]?.worktreePath,
    );

    const firstReplay = await state.createWorktree(firstRequest);
    expect(firstReplay.perEntry).toEqual(first.perEntry);
    const secondReplay = await state.createWorktree(secondRequest);
    expect(secondReplay.perEntry).toEqual(second.perEntry);
    state.dispose();
  });

  it("skips a ref namespace collision when generating a random branch suffix", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "traycer-worktree-random-ref-namespace-"),
    );
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    execFileSync("git", ["-C", workspace, "init", "-b", "main"]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.name",
      "Traycer Test",
    ]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.email",
      "traycer@example.com",
    ]);
    await writeFile(join(workspace, "README.md"), "base\n");
    execFileSync("git", ["-C", workspace, "add", "README.md"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);
    execFileSync("git", ["-C", workspace, "branch", "foo/bar"]);
    const state = new HostState("host-local", undefined, join(root, "managed"));
    const request = {
      epicId: "epic-1",
      ownerId: "terminal-1",
      ownerKind: "terminal-agent" as const,
      entries: [
        {
          kind: "worktree" as const,
          workspacePath: workspace,
          repoIdentifier: null,
          isPrimary: true,
          branch: {
            type: "new" as const,
            name: "foo",
            source: "main",
            carryUncommittedChanges: false,
            collision: "random" as const,
            retryIdentity: "ref-namespace-operation",
          },
          scripts: null,
        },
      ],
    };

    const created = await state.createWorktree(request);
    expect(created.perEntry).toEqual([
      {
        workspacePath: workspace,
        ok: true,
        worktreePath: expect.any(String),
        branch: expect.stringMatching(/^foo-[0-9a-f]{10}$/u),
        errorMessage: null,
      },
    ]);
    const createdResult = created.perEntry[0];
    if (
      createdResult === undefined ||
      createdResult.worktreePath === null ||
      createdResult.branch === null
    ) {
      throw new Error("Missing namespace-collision worktree result");
    }
    expect(
      execFileSync("git", [
        "-C",
        createdResult.worktreePath,
        "branch",
        "--show-current",
      ])
        .toString()
        .trim(),
    ).toBe(createdResult.branch);

    const replay = await state.createWorktree({
      ...request,
      ownerId: "terminal-2",
    });
    expect(replay.perEntry).toEqual(created.perEntry);
    state.dispose();
  });

  it("checks out an existing local branch and rejects one already in use", async () => {
    const root = await mkdtemp(join(tmpdir(), "traycer-worktree-existing-"));
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    execFileSync("git", ["-C", workspace, "init", "-b", "main"]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.name",
      "Traycer Test",
    ]);
    execFileSync("git", [
      "-C",
      workspace,
      "config",
      "user.email",
      "traycer@example.com",
    ]);
    await writeFile(join(workspace, "README.md"), "base\n");
    execFileSync("git", ["-C", workspace, "add", "README.md"]);
    execFileSync("git", ["-C", workspace, "commit", "-m", "base"]);
    execFileSync("git", ["-C", workspace, "branch", "ready"]);
    const state = new HostState("host-local", undefined, join(root, "managed"));
    const requestBase = {
      epicId: "epic-1",
      ownerKind: "terminal-agent" as const,
    };

    const created = await state.createWorktree({
      ...requestBase,
      ownerId: "terminal-1",
      entries: [
        {
          kind: "worktree",
          workspacePath: workspace,
          repoIdentifier: null,
          isPrimary: true,
          branch: { type: "existing", name: "ready" },
          scripts: null,
        },
      ],
    });
    expect(created.perEntry).toEqual([
      {
        workspacePath: workspace,
        ok: true,
        worktreePath: expect.any(String),
        branch: "ready",
        errorMessage: null,
      },
    ]);
    const createdPath = created.perEntry[0]?.worktreePath;
    if (createdPath === null || createdPath === undefined) {
      throw new Error("Missing existing-branch worktree path");
    }
    expect(
      execFileSync("git", ["-C", createdPath, "branch", "--show-current"])
        .toString()
        .trim(),
    ).toBe("ready");
    expect(created.binding.entries).toEqual([
      expect.objectContaining({
        workspacePath: workspace,
        mode: "worktree",
        worktreePath: createdPath,
        branch: "ready",
        isImported: false,
      }),
    ]);

    const occupied = await state.createWorktree({
      ...requestBase,
      ownerId: "terminal-2",
      entries: [
        {
          kind: "worktree",
          workspacePath: workspace,
          repoIdentifier: null,
          isPrimary: true,
          branch: { type: "existing", name: "main" },
          scripts: null,
        },
      ],
    });
    expect(occupied).toEqual({
      binding: { entries: [] },
      perEntry: [
        {
          workspacePath: workspace,
          ok: false,
          worktreePath: null,
          branch: "main",
          errorMessage: `main is already checked out in ${await realpath(workspace)}`,
        },
      ],
    });
    state.dispose();
  });
});

function createEmptyChat(
  state: HostState,
  epicId: string,
  chatId: string,
): void {
  const now = Date.now();
  state.createEpic(
    createEpicRequestSchema.parse({
      epic: {
        id: epicId,
        title: "Worktree race task",
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "active",
        createdAt: now,
        updatedAt: now,
        createdBy: "local-user",
        version: "1.0.0",
      },
      repoIdentifiers: [],
      workspaces: [],
      chat: null,
    }),
  );
  state.createChat({
    epicId,
    chatId,
    parentId: null,
    hostId: "host-local",
    title: "Worktree race chat",
    settings: null,
    initialMessage: null,
  });
}

async function waitForPath(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return true;
    } catch {
      await new Promise<void>((resolveWait) => {
        setTimeout(resolveWait, 10);
      });
    }
  }
  return false;
}

function overrideEnvironment(
  values: Readonly<Record<string, string>>,
): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}
