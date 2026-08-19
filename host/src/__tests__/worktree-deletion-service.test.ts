import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorktreeDeletionService,
  type WorktreeDeletionEvent,
} from "../worktree-deletion-service";

describe("WorktreeDeletionService", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    for (const root of tempRoots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deletes a registered worktree under the managed root", async () => {
    const fixture = await createWorktreeFixture(tempRoots);
    const events: WorktreeDeletionEvent[] = [];
    const service = new WorktreeDeletionService(fixture.managedRoot);

    const result = await service.delete(
      {
        worktreePath: fixture.worktreePath,
        expectedRepositoryRoot: fixture.repositoryRoot,
      },
      {
        isBusy: () => false,
        reportEvent: (event) => {
          events.push(event);
        },
      },
    );

    expect(result).toEqual({
      deleted: true,
      worktreePath: fixture.worktreePath,
      repositoryRoot: fixture.repositoryRoot,
      pruneWarning: null,
    });
    await expect(stat(fixture.worktreePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      git(fixture.repositoryRoot, ["worktree", "list", "--porcelain"]),
    ).not.toContain(fixture.worktreePath);
    expect(events).toEqual([
      {
        kind: "started",
        worktreePath: fixture.worktreePath,
        repositoryRoot: fixture.repositoryRoot,
      },
      { kind: "phase", phase: "remove" },
      { kind: "complete", deleted: true },
    ]);
  });

  it("refuses to delete a repository root", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "traycer-worktree-delete-root-"),
    );
    tempRoots.push(temporaryRoot);
    const root = await realpath(temporaryRoot);
    const managedRoot = join(root, "managed");
    const repositoryRoot = join(managedRoot, "group", "repository");
    await mkdir(repositoryRoot, { recursive: true });
    git(repositoryRoot, ["init", "-b", "main"]);
    const service = new WorktreeDeletionService(managedRoot);

    await expect(
      service.delete(
        { worktreePath: repositoryRoot, expectedRepositoryRoot: null },
        { isBusy: () => false, reportEvent: () => undefined },
      ),
    ).rejects.toMatchObject({ code: "REPOSITORY_ROOT" });
    await expect(stat(repositoryRoot)).resolves.toBeDefined();
  });

  it("refuses to delete an arbitrary unregistered directory", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "traycer-worktree-delete-arbitrary-"),
    );
    tempRoots.push(temporaryRoot);
    const root = await realpath(temporaryRoot);
    const managedRoot = join(root, "managed");
    const arbitraryPath = join(managedRoot, "group", "user-data");
    await mkdir(arbitraryPath, { recursive: true });
    await writeFile(join(arbitraryPath, "keep.txt"), "do not delete\n");
    const service = new WorktreeDeletionService(managedRoot);

    await expect(
      service.delete(
        { worktreePath: arbitraryPath, expectedRepositoryRoot: null },
        { isBusy: () => false, reportEvent: () => undefined },
      ),
    ).rejects.toMatchObject({ code: "UNREGISTERED_WORKTREE" });
    await expect(stat(join(arbitraryPath, "keep.txt"))).resolves.toBeDefined();
  });

  it("refuses to delete a registered worktree outside the managed root", async () => {
    const fixture = await createWorktreeFixture(tempRoots);
    const outsidePath = join(fixture.repositoryRoot, "..", "outside-worktree");
    git(fixture.repositoryRoot, [
      "worktree",
      "add",
      "-b",
      "feature/outside-delete-service",
      outsidePath,
      "HEAD",
    ]);
    const service = new WorktreeDeletionService(fixture.managedRoot);

    await expect(
      service.delete(
        { worktreePath: outsidePath, expectedRepositoryRoot: null },
        { isBusy: () => false, reportEvent: () => undefined },
      ),
    ).rejects.toMatchObject({ code: "OUTSIDE_MANAGED_ROOT" });
    await expect(stat(outsidePath)).resolves.toBeDefined();
  });

  it("refuses a busy worktree before reporting deletion progress", async () => {
    const fixture = await createWorktreeFixture(tempRoots);
    const busyChecks: Array<{
      readonly worktreePath: string;
      readonly repositoryRoot: string;
    }> = [];
    const events: WorktreeDeletionEvent[] = [];
    const service = new WorktreeDeletionService(fixture.managedRoot);

    await expect(
      service.delete(
        {
          worktreePath: fixture.worktreePath,
          expectedRepositoryRoot: fixture.repositoryRoot,
        },
        {
          isBusy: async (target) => {
            busyChecks.push(target);
            return true;
          },
          reportEvent: (event) => {
            events.push(event);
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "BUSY",
      message: expect.stringContaining(fixture.worktreePath),
    });
    expect(busyChecks).toEqual([
      {
        worktreePath: fixture.worktreePath,
        repositoryRoot: fixture.repositoryRoot,
      },
    ]);
    expect(events).toEqual([]);
    await expect(stat(fixture.worktreePath)).resolves.toBeDefined();
  });

  it("preserves Git's detailed failure when removal is refused", async () => {
    const fixture = await createWorktreeFixture(tempRoots);
    git(fixture.repositoryRoot, [
      "worktree",
      "lock",
      "--reason",
      "deliberate test lock",
      fixture.worktreePath,
    ]);
    const events: WorktreeDeletionEvent[] = [];
    const service = new WorktreeDeletionService(fixture.managedRoot);

    await expect(
      service.delete(
        {
          worktreePath: fixture.worktreePath,
          expectedRepositoryRoot: fixture.repositoryRoot,
        },
        {
          isBusy: () => false,
          reportEvent: (event) => {
            events.push(event);
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "GIT_REMOVE_FAILED",
      message: expect.stringContaining("deliberate test lock"),
    });
    await expect(stat(fixture.worktreePath)).resolves.toBeDefined();
    expect(events).toEqual([
      {
        kind: "started",
        worktreePath: fixture.worktreePath,
        repositoryRoot: fixture.repositoryRoot,
      },
      { kind: "phase", phase: "remove" },
    ]);
  });

  it("does not delete replacement data when the target changes after validation", async () => {
    const fixture = await createWorktreeFixture(tempRoots);
    const parkedWorktree = `${fixture.worktreePath}-parked`;
    const replacementFile = join(fixture.worktreePath, "keep.txt");
    const service = new WorktreeDeletionService(fixture.managedRoot);

    await expect(
      service.delete(
        {
          worktreePath: fixture.worktreePath,
          expectedRepositoryRoot: fixture.repositoryRoot,
        },
        {
          isBusy: () => false,
          reportEvent: async (event) => {
            if (event.kind !== "phase") {
              return;
            }
            await rename(fixture.worktreePath, parkedWorktree);
            await mkdir(fixture.worktreePath);
            await writeFile(replacementFile, "unowned replacement data\n");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "TARGET_CHANGED" });
    await expect(stat(replacementFile)).resolves.toBeDefined();
    await expect(stat(parkedWorktree)).resolves.toBeDefined();
  });
});

async function createWorktreeFixture(tempRoots: string[]): Promise<{
  readonly repositoryRoot: string;
  readonly managedRoot: string;
  readonly worktreePath: string;
}> {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "traycer-worktree-delete-"),
  );
  tempRoots.push(temporaryRoot);
  const root = await realpath(temporaryRoot);
  const repositoryRoot = join(root, "repository");
  const managedRoot = join(root, "managed");
  const worktreePath = join(managedRoot, "local__repository", "feature");
  await Promise.all([
    mkdir(repositoryRoot),
    mkdir(join(managedRoot, "local__repository"), { recursive: true }),
  ]);
  git(repositoryRoot, ["init", "-b", "main"]);
  git(repositoryRoot, ["config", "user.name", "Traycer Test"]);
  git(repositoryRoot, ["config", "user.email", "traycer@example.com"]);
  await writeFile(join(repositoryRoot, "README.md"), "base\n");
  git(repositoryRoot, ["add", "README.md"]);
  git(repositoryRoot, ["commit", "-m", "base"]);
  git(repositoryRoot, [
    "worktree",
    "add",
    "-b",
    "feature/delete-service",
    worktreePath,
    "HEAD",
  ]);
  return { repositoryRoot, managedRoot, worktreePath };
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  });
}
