import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildWorktreeCreateCommand,
  resolveWorktreeBranchSelection,
} from "../worktree-create";
import { callHostRpc } from "../../internal/host-rpc";
import { CliError, CLI_ERROR_CODES } from "../../runner/errors";
import type { CommandContext } from "../../runner/runner";

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../logger", () => ({
  createCliLogger: () => loggerMock,
  errorFromUnknown: (value: unknown) =>
    value instanceof Error ? value : new Error(String(value)),
  noopLogger: loggerMock,
}));

vi.mock("../../internal/host-rpc", async () => {
  const actual = await vi.importActual<
    typeof import("../../internal/host-rpc")
  >("../../internal/host-rpc");
  return {
    ...actual,
    callHostRpc: vi.fn(),
  };
});

const rpcMock = vi.mocked(callHostRpc);

const WORKSPACE = "/Users/dev/src/traycer";
const ctx = {} as CommandContext;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("resolveWorktreeBranchSelection", () => {
  it("builds the new variant with an explicit --source-branch (no host call)", async () => {
    const branch = await resolveWorktreeBranchSelection({
      workspacePath: WORKSPACE,
      newBranch: "feature/x",
      existingBranch: null,
      sourceBranch: "main",
      carryUncommittedChanges: true,
    });

    expect(branch).toEqual({
      type: "new",
      name: "feature/x",
      source: "main",
      carryUncommittedChanges: true,
      collision: "fail",
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("resolves the workspace's current branch when --source-branch is omitted", async () => {
    rpcMock.mockResolvedValue({
      branches: [
        { name: "main", isCurrent: false, isRemoteOnly: false },
        { name: "develop", isCurrent: true, isRemoteOnly: false },
      ],
      uncommittedFileCount: 0,
    });

    const branch = await resolveWorktreeBranchSelection({
      workspacePath: WORKSPACE,
      newBranch: "feature/x",
      existingBranch: null,
      sourceBranch: null,
      carryUncommittedChanges: false,
    });

    expect(rpcMock).toHaveBeenCalledWith("worktree.listBranches", {
      workspacePath: WORKSPACE,
      includeRemote: false,
    });
    expect(branch).toEqual({
      type: "new",
      name: "feature/x",
      source: "develop",
      carryUncommittedChanges: false,
      collision: "fail",
    });
  });

  it("treats a whitespace-only --source-branch as omitted (falls back to current branch)", async () => {
    rpcMock.mockResolvedValue({
      branches: [{ name: "develop", isCurrent: true, isRemoteOnly: false }],
      uncommittedFileCount: 0,
    });

    const branch = await resolveWorktreeBranchSelection({
      workspacePath: WORKSPACE,
      newBranch: "feature/x",
      existingBranch: null,
      sourceBranch: "   ",
      carryUncommittedChanges: false,
    });

    // The whitespace value is not used verbatim; the current branch is resolved.
    expect(rpcMock).toHaveBeenCalledWith("worktree.listBranches", {
      workspacePath: WORKSPACE,
      includeRemote: false,
    });
    expect(branch).toEqual({
      type: "new",
      name: "feature/x",
      source: "develop",
      carryUncommittedChanges: false,
      collision: "fail",
    });
  });

  it("errors when no current branch resolves (detached HEAD / non-git)", async () => {
    rpcMock.mockResolvedValue({
      branches: [{ name: "main", isCurrent: false, isRemoteOnly: false }],
      uncommittedFileCount: 0,
    });

    await expect(
      resolveWorktreeBranchSelection({
        workspacePath: WORKSPACE,
        newBranch: "feature/x",
        existingBranch: null,
        sourceBranch: null,
        carryUncommittedChanges: false,
      }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.INVALID_ARGUMENT });
  });

  it("builds the existing variant with no source/carry (no host call)", async () => {
    const branch = await resolveWorktreeBranchSelection({
      workspacePath: WORKSPACE,
      newBranch: null,
      existingBranch: "release/1.0",
      sourceBranch: null,
      carryUncommittedChanges: false,
    });

    expect(branch).toEqual({ type: "existing", name: "release/1.0" });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects an empty/missing new-branch name with a clear error and no host call", async () => {
    await expect(
      resolveWorktreeBranchSelection({
        workspacePath: WORKSPACE,
        newBranch: "   ",
        existingBranch: null,
        sourceBranch: null,
        carryUncommittedChanges: false,
      }),
    ).rejects.toBeInstanceOf(CliError);

    await expect(
      resolveWorktreeBranchSelection({
        workspacePath: WORKSPACE,
        newBranch: null,
        existingBranch: null,
        sourceBranch: null,
        carryUncommittedChanges: false,
      }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.INVALID_ARGUMENT });

    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects combining --branch and --existing", async () => {
    await expect(
      resolveWorktreeBranchSelection({
        workspacePath: WORKSPACE,
        newBranch: "feature/x",
        existingBranch: "release/1.0",
        sourceBranch: null,
        carryUncommittedChanges: false,
      }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.INVALID_ARGUMENT });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects combining --source-branch with --existing instead of silently dropping it", async () => {
    await expect(
      resolveWorktreeBranchSelection({
        workspacePath: WORKSPACE,
        newBranch: null,
        existingBranch: "release/1.0",
        sourceBranch: "main",
        carryUncommittedChanges: false,
      }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.INVALID_ARGUMENT });
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe("buildWorktreeCreateCommand", () => {
  it("returns the complete successful host result after sending the canonical create-paths request", async () => {
    const response = {
      entries: [
        {
          workspacePath: WORKSPACE,
          path: "/Users/dev/.traycer/worktrees/acme__traycer/feature-x",
          mode: "worktree" as const,
          repoIdentifier: { owner: "acme", repo: "traycer" },
          branch: "feature/x",
        },
      ],
      perEntry: [
        {
          workspacePath: WORKSPACE,
          ok: true,
          worktreePath: "/Users/dev/.traycer/worktrees/acme__traycer/feature-x",
          branch: "feature/x",
          errorMessage: null,
        },
      ],
    };
    rpcMock.mockResolvedValue(response);

    const result = await buildWorktreeCreateCommand({
      workspacePath: WORKSPACE,
      newBranch: "feature/x",
      existingBranch: null,
      sourceBranch: "main",
      carryUncommittedChanges: true,
    })(ctx);

    expect(rpcMock).toHaveBeenCalledOnce();
    expect(rpcMock).toHaveBeenCalledWith("worktree.createPaths", {
      entries: [
        {
          workspacePath: WORKSPACE,
          branch: {
            type: "new",
            name: "feature/x",
            source: "main",
            carryUncommittedChanges: true,
            collision: "fail",
          },
        },
      ],
    });
    expect(result).toEqual({
      data: response,
      human: JSON.stringify(response, null, 2),
      exitCode: 0,
    });
  });

  it("preserves a per-entry failure result and exits unsuccessfully", async () => {
    const response = {
      entries: [],
      perEntry: [
        {
          workspacePath: WORKSPACE,
          ok: false,
          worktreePath: null,
          branch: "release/1.0",
          errorMessage:
            "release/1.0 is already checked out in /Users/dev/src/release",
        },
      ],
    };
    rpcMock.mockResolvedValue(response);

    const result = await buildWorktreeCreateCommand({
      workspacePath: WORKSPACE,
      newBranch: null,
      existingBranch: "release/1.0",
      sourceBranch: null,
      carryUncommittedChanges: false,
    })(ctx);

    expect(result).toEqual({
      data: response,
      human: JSON.stringify(response, null, 2),
      exitCode: 1,
    });
  });
});
