import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, resolve, sep } from "node:path";

export type WorkspaceDirEntry = {
  readonly path: string;
  readonly name: string;
  readonly kind: "file" | "directory" | "symlink" | "other";
};

export function listWorkspaceDirectory(
  workspacePath: string,
  directoryPath: string,
): { readonly entries: WorkspaceDirEntry[] } | { readonly error: string } {
  const target = resolveUnderWorkspace(workspacePath, directoryPath);
  if (target === null) {
    return { error: "directoryPath is outside the workspace" };
  }
  try {
    const names = readdirSync(target);
    const entries: WorkspaceDirEntry[] = [];
    for (const name of names) {
      if (entries.length >= 500) {
        break;
      }
      const child = resolve(target, name);
      entries.push({
        path: child,
        name,
        kind: entryKind(child),
      });
    }
    return { entries };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function readWorkspaceFile(
  workspacePath: string,
  filePath: string,
  maxBytes: number,
): {
  readonly content: string | null;
  readonly truncated: boolean;
  readonly error: string | null;
} {
  const target = resolveUnderWorkspace(workspacePath, filePath);
  if (target === null) {
    return {
      content: null,
      truncated: false,
      error: "filePath is outside the workspace",
    };
  }
  try {
    const buffer = readFileSync(target);
    const truncated = buffer.byteLength > maxBytes;
    const slice = truncated ? buffer.subarray(0, maxBytes) : buffer;
    return {
      content: slice.toString("utf8"),
      truncated,
      error: null,
    };
  } catch (error) {
    return {
      content: null,
      truncated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function resolveUnderWorkspace(
  workspacePath: string,
  requested: string,
): string | null {
  const root = resolve(workspacePath);
  const target = isAbsolute(requested)
    ? resolve(requested)
    : resolve(root, requested);
  if (target === root || target.startsWith(`${root}${sep}`)) {
    return target;
  }
  return null;
}

function entryKind(path: string): WorkspaceDirEntry["kind"] {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      return "symlink";
    }
    if (stat.isDirectory()) {
      return "directory";
    }
    if (stat.isFile()) {
      return "file";
    }
    return "other";
  } catch {
    return "other";
  }
}

export function displayNameOfPath(path: string): string {
  const name = basename(path);
  return name.length > 0 ? name : path;
}
