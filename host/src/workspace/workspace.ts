import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import type { PreparedWorkspaceFolder } from "@traycer/protocol/host/epic/unary-schemas";
import type { WorkspaceValidatePathResponse } from "@traycer/protocol/host/workspace/unary-schemas";
import { inspectRepo } from "../git/git";
import type { HostStore, StoredRecent } from "../store/host-store";

const SKIP_DIR_NAMES = new Set([".git", "node_modules", "dist", ".next", "out"]);

export async function validateWorkspacePath(
  path: string,
): Promise<WorkspaceValidatePathResponse> {
  if (!isAbsolute(path)) {
    return { ok: false, reason: "NOT_ABSOLUTE" };
  }
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory()) {
      return { ok: false, reason: "NOT_A_DIRECTORY" };
    }
    const resolved = await realpath(path);
    return { ok: true, resolvedPath: resolved };
  } catch (error) {
    const code = nodeErrorCode(error);
    if (code === "EACCES" || code === "EPERM") {
      return { ok: false, reason: "NO_PERMISSION" };
    }
    return { ok: false, reason: "NOT_FOUND" };
  }
}

export async function prepareFolders(
  folderPaths: readonly string[],
): Promise<{
  readonly folders: PreparedWorkspaceFolder[];
  readonly repoIdentifiers: NonNullable<
    PreparedWorkspaceFolder["repoIdentifier"]
  >[];
}> {
  const folders: PreparedWorkspaceFolder[] = [];
  const repoIdentifiers: NonNullable<
    PreparedWorkspaceFolder["repoIdentifier"]
  >[] = [];
  for (const folderPath of folderPaths) {
    const validation = await validateWorkspacePath(folderPath);
    if (!validation.ok) {
      continue;
    }
    const facts = inspectRepo(validation.resolvedPath);
    const repoIdentifier = facts === null ? null : facts.repoIdentifier;
    folders.push({
      workspacePath: validation.resolvedPath,
      workspaceName: basename(validation.resolvedPath),
      repoIdentifier,
      repoUrl: facts === null ? null : facts.remoteUrl,
    });
    if (repoIdentifier !== null) {
      repoIdentifiers.push(repoIdentifier);
    }
  }
  return { folders, repoIdentifiers };
}

export async function recordRecent(
  store: HostStore,
  path: string,
  bumpRecency: boolean,
): Promise<StoredRecent[]> {
  const validation = await validateWorkspacePath(path);
  if (!validation.ok) {
    return store.snapshot().recents;
  }
  return store.mutate((state) => {
    const now = new Date().toISOString();
    const without = state.recents.filter(
      (entry) => entry.path !== validation.resolvedPath,
    );
    if (bumpRecency) {
      state.recents = [
        { path: validation.resolvedPath, lastOpenedAt: now },
        ...without,
      ].slice(0, 20);
    } else {
      state.recents = without;
    }
    return state.recents;
  });
}

export async function forgetRecent(
  store: HostStore,
  path: string,
): Promise<StoredRecent[]> {
  return store.mutate((state) => {
    state.recents = state.recents.filter((entry) => entry.path !== path);
    return state.recents;
  });
}

export function homeDir(): string {
  return homedir();
}

export async function listDirectory(
  workspacePath: string,
  directoryPath: string,
): Promise<
  | {
      readonly ok: true;
      readonly entries: readonly {
        readonly path: string;
        readonly name: string;
        readonly kind: "file" | "directory" | "symlink" | "other";
      }[];
    }
  | { readonly ok: false; readonly message: string }
> {
  const resolved = await resolveInsideWorkspace(workspacePath, directoryPath);
  if (!resolved.ok) {
    return resolved;
  }
  try {
    const names = await readdir(resolved.absolute);
    const entries = [];
    for (const name of names) {
      const absolute = join(resolved.absolute, name);
      const rel = toPosixRelative(workspacePath, absolute);
      let kind: "file" | "directory" | "symlink" | "other" = "other";
      try {
        const stats = await lstat(absolute);
        if (stats.isSymbolicLink()) {
          kind = "symlink";
        } else if (stats.isDirectory()) {
          kind = "directory";
        } else if (stats.isFile()) {
          kind = "file";
        }
      } catch {
        kind = "other";
      }
      entries.push({ path: rel, name, kind });
    }
    return { ok: true, entries };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

export async function readWorkspaceFile(
  workspacePath: string,
  filePath: string,
  maxBytes: number,
): Promise<{
  readonly content: string | null;
  readonly truncated: boolean;
  readonly error: string | null;
}> {
  const resolved = await resolveInsideWorkspace(workspacePath, filePath);
  if (!resolved.ok) {
    return { content: null, truncated: false, error: resolved.message };
  }
  try {
    const buffer = await readFile(resolved.absolute);
    if (buffer.byteLength > maxBytes) {
      return {
        content: buffer.subarray(0, maxBytes).toString("utf8"),
        truncated: true,
        error: null,
      };
    }
    return {
      content: buffer.toString("utf8"),
      truncated: false,
      error: null,
    };
  } catch (error) {
    return { content: null, truncated: false, error: errorMessage(error) };
  }
}

export async function listFileTree(
  workspacePath: string,
  maxFiles: number,
): Promise<{
  readonly files: readonly { readonly path: string; readonly name: string }[];
  readonly truncated: boolean;
}> {
  const validation = await validateWorkspacePath(workspacePath);
  if (!validation.ok) {
    return { files: [], truncated: false };
  }
  const root = validation.resolvedPath;
  const files: { path: string; name: string }[] = [];
  let truncated = false;
  async function walk(dir: string): Promise<void> {
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      if (SKIP_DIR_NAMES.has(name)) {
        continue;
      }
      const absolute = join(dir, name);
      let stats;
      try {
        stats = await lstat(absolute);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!stats.isFile()) {
        continue;
      }
      files.push({
        path: toPosixRelative(root, absolute),
        name,
      });
    }
  }
  await walk(root);
  return { files, truncated };
}

export async function createAndPrepare(
  path: string,
): Promise<WorkspaceValidatePathResponse> {
  if (!isAbsolute(path)) {
    return { ok: false, reason: "NOT_ABSOLUTE" };
  }
  try {
    await mkdir(path, { recursive: true });
  } catch (error) {
    const code = nodeErrorCode(error);
    if (code === "EACCES" || code === "EPERM") {
      return { ok: false, reason: "NO_PERMISSION" };
    }
    return { ok: false, reason: "NOT_FOUND" };
  }
  return validateWorkspacePath(path);
}

async function resolveInsideWorkspace(
  workspacePath: string,
  relativePath: string,
): Promise<
  | { readonly ok: true; readonly absolute: string }
  | { readonly ok: false; readonly message: string }
> {
  const root = await validateWorkspacePath(workspacePath);
  if (!root.ok) {
    return { ok: false, message: `Invalid workspace: ${root.reason}` };
  }
  const candidate = isAbsolute(relativePath)
    ? relativePath
    : join(root.resolvedPath, relativePath);
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
  const rel = relative(root.resolvedPath, resolved);
  if (rel.startsWith("..") || rel === "..") {
    return { ok: false, message: "Path escapes workspace" };
  }
  return { ok: true, absolute: resolved };
}

function toPosixRelative(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/");
}

function nodeErrorCode(error: unknown): string | null {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = Reflect.get(error, "code");
    return typeof code === "string" ? code : null;
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
