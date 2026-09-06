import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import type { PreparedWorkspaceFolder } from "@traycer/protocol/host/epic/unary-schemas";
import type { WorkspaceValidatePathResponse } from "@traycer/protocol/host/workspace/unary-schemas";
import { inspectRepo } from "../git/git";
import type { HostStore, StoredRecent } from "../store/host-store";

const SKIP_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  ".next",
  "out",
]);

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

export async function prepareFolders(folderPaths: readonly string[]): Promise<{
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

export async function writeWorkspaceFile(
  workspacePath: string,
  filePath: string,
  expectedRevision: string,
  content: string,
): Promise<
  | { readonly status: "saved"; readonly revision: string }
  | {
      readonly status: "conflict";
      readonly currentRevision: string;
      readonly error: string;
    }
  | { readonly status: "error"; readonly error: string }
> {
  const target = await resolveWriteTarget(workspacePath, filePath);
  if (!target.ok) {
    return { status: "error", error: target.message };
  }
  let current = "";
  try {
    current = await readFile(target.absolute, "utf8");
  } catch {
    current = "";
  }
  const currentRevision = sha256Utf8(current);
  if (currentRevision !== expectedRevision && current !== content) {
    return {
      status: "conflict",
      currentRevision,
      error: "file changed since the expected revision",
    };
  }
  await mkdir(dirname(target.absolute), { recursive: true });
  await writeFile(target.absolute, content, "utf8");
  return { status: "saved", revision: sha256Utf8(content) };
}

export async function browseFolders(directoryPath: string | null): Promise<{
  readonly directoryPath: string;
  readonly parentPath: string | null;
  readonly entries: readonly {
    readonly path: string;
    readonly name: string;
    readonly hidden: boolean;
  }[];
}> {
  const home = homeDir();
  const start =
    directoryPath === null || directoryPath.length === 0 ? home : directoryPath;
  const resolved = await realpath(start);
  const parent = dirname(resolved);
  const parentPath = parent === resolved ? null : parent;
  let names: string[] = [];
  try {
    names = await readdir(resolved);
  } catch {
    names = [];
  }
  const entries: {
    path: string;
    name: string;
    hidden: boolean;
  }[] = [];
  for (const name of names) {
    const absolute = join(resolved, name);
    try {
      const stats = await lstat(absolute);
      if (!stats.isDirectory()) {
        continue;
      }
      entries.push({
        path: absolute,
        name,
        hidden: name.startsWith("."),
      });
    } catch {
      continue;
    }
  }
  return { directoryPath: resolved, parentPath, entries };
}

export async function searchWorkspacePaths(
  root: string,
  query: string,
  limit: number,
  kinds: "files" | "folders" | "both",
): Promise<{
  readonly results: readonly {
    readonly kind: "file" | "folder";
    readonly relPath: string;
    readonly name: string;
  }[];
  readonly truncated: boolean;
}> {
  const validation = await validateWorkspacePath(root);
  if (!validation.ok) {
    return { results: [], truncated: false };
  }
  const rootPath = validation.resolvedPath;
  const needle = query.toLowerCase();
  const results: {
    kind: "file" | "folder";
    relPath: string;
    name: string;
  }[] = [];
  let truncated = false;
  async function walk(dir: string): Promise<void> {
    if (results.length >= limit) {
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
      if (results.length >= limit) {
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
      const relPath = toPosixRelative(rootPath, absolute);
      const matches =
        needle.length === 0 || name.toLowerCase().includes(needle);
      if (stats.isDirectory()) {
        if (matches && (kinds === "folders" || kinds === "both")) {
          results.push({ kind: "folder", relPath, name });
        }
        await walk(absolute);
        continue;
      }
      if (
        stats.isFile() &&
        matches &&
        (kinds === "files" || kinds === "both")
      ) {
        results.push({ kind: "file", relPath, name });
      }
    }
  }
  await walk(rootPath);
  return { results, truncated };
}

export async function searchWorkspaceText(
  root: string,
  query: string,
  limit: number,
): Promise<{
  readonly matches: readonly {
    readonly relPath: string;
    readonly lineNumber: number;
    readonly text: string;
  }[];
  readonly truncated: boolean;
}> {
  const validation = await validateWorkspacePath(root);
  if (!validation.ok) {
    return { matches: [], truncated: false };
  }
  const rootPath = validation.resolvedPath;
  const needle = query.toLowerCase();
  const matches: {
    relPath: string;
    lineNumber: number;
    text: string;
  }[] = [];
  let truncated = false;
  async function walk(dir: string): Promise<void> {
    if (matches.length >= limit) {
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
      if (matches.length >= limit) {
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
      if (!stats.isFile() || needle.length === 0) {
        continue;
      }
      let text = "";
      try {
        text = await readFile(absolute, "utf8");
      } catch {
        continue;
      }
      const lines = text.split("\n");
      const relPath = toPosixRelative(rootPath, absolute);
      for (let index = 0; index < lines.length; index += 1) {
        if (matches.length >= limit) {
          truncated = true;
          return;
        }
        const line = lines[index] ?? "";
        if (line.toLowerCase().includes(needle)) {
          matches.push({
            relPath,
            lineNumber: index + 1,
            text: line.slice(0, 240),
          });
        }
      }
    }
  }
  await walk(rootPath);
  return { matches, truncated };
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

async function resolveWriteTarget(
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
  const rel = relative(root.resolvedPath, candidate);
  if (rel.startsWith("..") || rel === "..") {
    return { ok: false, message: "Path escapes workspace" };
  }
  return { ok: true, absolute: candidate };
}

function sha256Utf8(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
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
