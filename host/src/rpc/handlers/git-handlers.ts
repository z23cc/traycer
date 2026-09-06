import {
  gitGetFileDiffRequestSchema,
  gitGetFileDiffsRequestSchema,
  gitListChangedFilesRequestSchemaV11,
} from "@traycer/protocol/host/git-schemas";
import {
  detectGit,
  getFileDiff,
  inspectRepo,
  statusSnapshot,
} from "../../git/git";
import type { RpcHandler } from "./types";

export const handleGitCapabilities: RpcHandler = (params) => {
  const git = detectGit();
  if (params !== null && typeof params === "object" && "runningDir" in params) {
    const runningDir = Reflect.get(params, "runningDir");
    if (typeof runningDir === "string") {
      const facts = inspectRepo(runningDir);
      if (facts === null) {
        return {
          ok: true,
          result: {
            available: false,
            gitVersion: git.version,
            reason: git.available ? "Not a git repository" : "git is not installed",
          },
        };
      }
    }
  }
  if (!git.available) {
    return {
      ok: true,
      result: {
        available: false,
        gitVersion: null,
        reason: "git is not installed",
      },
    };
  }
  return {
    ok: true,
    result: {
      available: true,
      gitVersion: git.version,
      reason: null,
    },
  };
};

export const handleGitListChangedFiles: RpcHandler = (params) => {
  const parsed = gitListChangedFilesRequestSchemaV11.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const snapshot = statusSnapshot(parsed.data.runningDir);
  if (snapshot === null) {
    return {
      ok: false,
      code: "RPC_ERROR",
      message: "Not a git repository",
    };
  }
  return {
    ok: true,
    result: {
      runningDir: snapshot.runningDir,
      headSha: snapshot.headSha,
      branch: snapshot.branch,
      files: snapshot.files,
      fingerprint: snapshot.fingerprint,
      repoMode: snapshot.repoMode,
      repoState: snapshot.repoState,
      submodules: [],
    },
  };
};

export const handleGitGetFileDiff: RpcHandler = (params) => {
  const parsed = gitGetFileDiffRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const diff = getFileDiff({
    runningDir: parsed.data.runningDir,
    filePath: parsed.data.filePath,
    previousPath: parsed.data.previousPath,
    stage: parsed.data.stage,
    ignoreWhitespace: parsed.data.ignoreWhitespace,
    byteBudget: parsed.data.byteBudget,
  });
  if (diff === null) {
    return { ok: false, code: "RPC_ERROR", message: "Not a git repository" };
  }
  return { ok: true, result: diff };
};

export const handleGitGetFileDiffs: RpcHandler = (params) => {
  const parsed = gitGetFileDiffsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const facts = inspectRepo(parsed.data.runningDir);
  if (facts === null) {
    return { ok: false, code: "RPC_ERROR", message: "Not a git repository" };
  }
  const diffs = [];
  for (const file of parsed.data.files) {
    const diff = getFileDiff({
      runningDir: parsed.data.runningDir,
      filePath: file.filePath,
      previousPath: file.previousPath,
      stage: file.stage,
      ignoreWhitespace: parsed.data.ignoreWhitespace,
      byteBudget: parsed.data.byteBudget,
    });
    if (diff !== null) {
      diffs.push(diff);
    }
  }
  return {
    ok: true,
    result: {
      runningDir: facts.toplevel,
      headSha: facts.headSha,
      diffs,
    },
  };
};
