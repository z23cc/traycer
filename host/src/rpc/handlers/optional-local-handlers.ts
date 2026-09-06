import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  configEnvDeleteRequestSchema,
  configEnvListRequestSchema,
  configEnvSetRequestSchema,
  configShellAddRequestSchema,
  configShellGetRequestSchema,
  configShellListDetectedRequestSchema,
  configShellProbeRequestSchema,
  configShellRemoveRequestSchema,
  configShellResetRequestSchema,
  configShellRevertArgsRequestSchema,
  configShellSetRequestSchema,
} from "@traycer/protocol/host/config/schemas";
// `~/.traycer/cli/config.json` is the one shell store the CLI, the host, and
// every PTY spawn read - see `@traycer/protocol/config/store`.
import {
  addShell,
  deleteEnvOverride,
  listEnvOverrides,
  listShells,
  loadEffectiveShellConfig,
  probeShellPath,
  removeShell,
  resetShell,
  revertShellArgs,
  setEnvOverride,
  setShell,
} from "@traycer/protocol/config/store";
import {
  searchArtifactsRequestSchema,
  setEpicPinnedRequestSchema,
} from "@traycer/protocol/host/epic/unary-schemas";
import { gitGetFileContentsRequestSchema } from "@traycer/protocol/host/git-schemas";
import { readTerminalOutputRequestSchema } from "@traycer/protocol/host/terminal/unary-schemas";
import {
  workspaceBrowseFoldersRequestSchema,
  workspaceSearchPathsRequestSchema,
  workspaceSearchTextRequestSchema,
  workspaceWriteFileRequestSchema,
} from "@traycer/protocol/host/workspace/unary-schemas";
import {
  artifactFolderSegments,
  readArtifactMarkdown,
} from "../../epic/artifact-body";
import {
  browseFolders,
  searchWorkspacePaths,
  searchWorkspaceText,
  writeWorkspaceFile,
} from "../../workspace/workspace";
import type { RpcHandler } from "./types";

export const handleWorkspaceWriteFile: RpcHandler = async (params) => {
  const parsed = workspaceWriteFileRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const written = await writeWorkspaceFile(
    parsed.data.workspacePath,
    parsed.data.filePath,
    parsed.data.expectedRevision,
    parsed.data.content,
  );
  return {
    ok: true,
    result: {
      workspacePath: parsed.data.workspacePath,
      filePath: parsed.data.filePath,
      ...written,
    },
  };
};

export const handleWorkspaceBrowseFolders: RpcHandler = async (params) => {
  const parsed = workspaceBrowseFoldersRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const listed = await browseFolders(parsed.data.directoryPath);
  return { ok: true, result: listed };
};

export const handleWorkspaceSearchPaths: RpcHandler = async (params) => {
  const parsed = workspaceSearchPathsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const reference = parsed.data.reference;
  if (!("root" in reference)) {
    return {
      ok: true,
      result: {
        epicId: parsed.data.epicId,
        source: { kind: "epic-artifacts" },
        outcome: "ready",
        results: [],
        truncated: false,
      },
    };
  }
  const searched = await searchWorkspacePaths(
    reference.root,
    parsed.data.query,
    parsed.data.limit,
    parsed.data.kinds,
  );
  return {
    ok: true,
    result: {
      epicId: parsed.data.epicId,
      root: reference.root,
      outcome: "ready",
      results: searched.results,
      truncated: searched.truncated,
    },
  };
};

export const handleWorkspaceSearchText: RpcHandler = async (params) => {
  const parsed = workspaceSearchTextRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const reference = parsed.data.reference;
  if (!("root" in reference)) {
    return {
      ok: true,
      result: {
        epicId: parsed.data.epicId,
        source: { kind: "epic-artifacts" },
        outcome: "ready",
        results: [],
        truncated: false,
      },
    };
  }
  const searched = await searchWorkspaceText(
    reference.root,
    parsed.data.query,
    parsed.data.limit,
  );
  return {
    ok: true,
    result: {
      epicId: parsed.data.epicId,
      root: reference.root,
      outcome: "ready",
      results: searched.matches.map((row) => ({
        relPath: row.relPath,
        lineNumber: row.lineNumber,
        column: 1,
        preview: { text: row.text, ranges: [] },
      })),
      truncated: searched.truncated,
    },
  };
};

export const handleGitGetFileContents: RpcHandler = async (params) => {
  const parsed = gitGetFileContentsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const absolute = join(parsed.data.runningDir, parsed.data.filePath);
  try {
    const contents = await readFile(absolute, "utf8");
    const name = basename(parsed.data.filePath);
    return {
      ok: true,
      result: {
        runningDir: parsed.data.runningDir,
        filePath: parsed.data.filePath,
        oldFile: null,
        newFile: { name, contents },
        worktreeFile: { name, contents },
        error: null,
      },
    };
  } catch (error: unknown) {
    return {
      ok: true,
      result: {
        runningDir: parsed.data.runningDir,
        filePath: parsed.data.filePath,
        oldFile: null,
        newFile: null,
        worktreeFile: null,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
};

export const handleTerminalReadOutput: RpcHandler = async (params, runtime) => {
  const parsed = readTerminalOutputRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const session = runtime.terminals
    .list({ kind: "epic", epicId: parsed.data.epicId })
    .find(
      (row) =>
        row.sessionId === parsed.data.sessionId ||
        row.sessionId.startsWith(parsed.data.sessionId),
    );
  if (session === undefined) {
    return { ok: false, code: "RPC_ERROR", message: "session not found" };
  }
  const dir = join(runtime.dataDir, "terminal-output");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${session.sessionId}.txt`);
  await writeFile(path, runtime.pty.scrollback(session.sessionId), "utf8");
  return { ok: true, result: { path } };
};

export const handleEpicSetPinned: RpcHandler = async (params, runtime) => {
  const parsed = setEpicPinnedRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  let pinned = parsed.data.pinned;
  await runtime.store.mutate((state) => {
    const epic = state.epics.find((row) => row.id === parsed.data.epicId);
    if (epic === undefined) {
      return;
    }
    epic.pinned = parsed.data.pinned;
    pinned = epic.pinned;
  });
  return { ok: true, result: { pinned } };
};

export const handleEpicSearchArtifacts: RpcHandler = async (
  params,
  runtime,
) => {
  const parsed = searchArtifactsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const needle = parsed.data.query.toLowerCase();
  const rows = runtime.store
    .snapshot()
    .artifacts.filter((row) => row.epicId === parsed.data.epicId);
  const results = [];
  for (const artifact of rows) {
    if (results.length >= parsed.data.limit) {
      break;
    }
    const sources: ("title" | "path" | "body")[] = [];
    if (
      parsed.data.fields.title &&
      artifact.title.toLowerCase().includes(needle)
    ) {
      sources.push("title");
    }
    const relativePath = artifactFolderSegments(rows, artifact).join("/");
    if (
      parsed.data.fields.path &&
      relativePath.toLowerCase().includes(needle)
    ) {
      sources.push("path");
    }
    if (parsed.data.fields.body && needle.length > 0) {
      const markdown = await readArtifactMarkdown(runtime, artifact);
      if (markdown.toLowerCase().includes(needle)) {
        sources.push("body");
      }
    }
    if (sources.length === 0 && needle.length > 0) {
      continue;
    }
    results.push({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      title: artifact.title,
      status: artifact.status,
      relativePath,
      breadcrumb: artifactFolderSegments(rows, artifact),
      sources: sources.length > 0 ? sources : ["title"],
      score: 1,
      snippets: [],
    });
  }
  return {
    ok: true,
    result: {
      outcome: "ready",
      results,
      truncated: results.length >= parsed.data.limit,
    },
  };
};

export const handleConfigShellGet: RpcHandler = async (params) => {
  const parsed = configShellGetRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const shell = await loadEffectiveShellConfig();
  return {
    ok: true,
    result: {
      path: shell.path,
      args: [...shell.args],
      synthesised: shell.synthesised,
    },
  };
};

export const handleConfigShellSet: RpcHandler = async (params) => {
  const parsed = configShellSetRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const updated = await setShell(
    parsed.data.path,
    parsed.data.args === null ? null : [...parsed.data.args],
  );
  return {
    ok: true,
    result: {
      path: updated.path,
      args: updated.args === null ? null : [...updated.args],
    },
  };
};

export const handleConfigShellAdd: RpcHandler = async (params) => {
  const parsed = configShellAddRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const added = await addShell(parsed.data.path);
  return {
    ok: true,
    result: {
      path: added.path,
      entries: added.entries.map((entry) => ({
        path: entry.path,
        args: entry.args === null ? null : [...entry.args],
      })),
    },
  };
};

export const handleConfigShellRemove: RpcHandler = async (params) => {
  const parsed = configShellRemoveRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return { ok: true, result: await removeShell(parsed.data.path) };
};

export const handleConfigShellRevertArgs: RpcHandler = async (params) => {
  const parsed = configShellRevertArgsRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return { ok: true, result: await revertShellArgs(parsed.data.path) };
};

export const handleConfigShellReset: RpcHandler = async (params) => {
  const parsed = configShellResetRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  await resetShell();
  return { ok: true, result: { reset: true } };
};

export const handleConfigShellListDetected: RpcHandler = async (params) => {
  const parsed = configShellListDetectedRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const shells = await listShells();
  return {
    ok: true,
    result: { shells: shells.map((shell) => ({ ...shell })) },
  };
};

export const handleConfigShellProbe: RpcHandler = async (params) => {
  const parsed = configShellProbeRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  return { ok: true, result: await probeShellPath(parsed.data.path) };
};

export const handleConfigEnvList: RpcHandler = async (params) => {
  const parsed = configEnvListRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const overrides = await listEnvOverrides();
  return {
    ok: true,
    result: {
      entries: Object.entries(overrides).map(([key, value]) => ({
        key,
        value,
      })),
    },
  };
};

export const handleConfigEnvSet: RpcHandler = async (params) => {
  const parsed = configEnvSetRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  await setEnvOverride(parsed.data.key, parsed.data.value);
  return {
    ok: true,
    result: { key: parsed.data.key, value: parsed.data.value },
  };
};

export const handleConfigEnvDelete: RpcHandler = async (params) => {
  const parsed = configEnvDeleteRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, code: "RPC_ERROR", message: parsed.error.message };
  }
  const deleted = await deleteEnvOverride(parsed.data.key);
  return { ok: true, result: { key: parsed.data.key, deleted } };
};
