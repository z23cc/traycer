import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import type {
  PrepareWorkspaceFoldersResponse,
  PreparedWorkspaceFolder,
  TaskRepoIdentifier,
} from "@traycer/protocol/host/epic/unary-schemas";

const GIT_READ_TIMEOUT_MS = 2_000;

export async function prepareWorkspaceFolders(
  folderPaths: readonly string[],
): Promise<PrepareWorkspaceFoldersResponse> {
  const paths = [...new Set(folderPaths.map((path) => path.trim()))].filter(
    (path) => path.length > 0,
  );
  const prepared = await Promise.all(paths.map(prepareWorkspaceFolder));
  const folders = dedupeBy(prepared, (folder) => folder.workspacePath);
  const repoIdentifiers = dedupeBy(
    folders.flatMap((folder) =>
      folder.repoIdentifier === null ? [] : [folder.repoIdentifier],
    ),
    repoIdentifierKey,
  );
  return { folders, repoIdentifiers };
}

async function prepareWorkspaceFolder(
  path: string,
): Promise<PreparedWorkspaceFolder> {
  const canonicalPath = await canonicalDirectoryPath(path);
  const gitRoot = await readGit(canonicalPath, [
    "rev-parse",
    "--show-toplevel",
  ]);
  if (gitRoot === null) {
    return {
      workspacePath: canonicalPath,
      workspaceName: basename(canonicalPath),
      repoIdentifier: null,
      repoUrl: null,
    };
  }
  const repoUrl = await readGit(gitRoot, [
    "config",
    "--get",
    "remote.origin.url",
  ]);
  const repoIdentifier =
    repoUrl === null ? null : parseGitHubRepoIdentifier(repoUrl);
  return {
    workspacePath: gitRoot,
    workspaceName: basename(gitRoot),
    repoIdentifier,
    repoUrl: repoIdentifier === null ? null : repoUrl,
  };
}

async function canonicalDirectoryPath(path: string): Promise<string> {
  const canonicalPath = await realpath(path);
  if (!(await stat(canonicalPath)).isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${path}`);
  }
  return canonicalPath;
}

function readGit(cwd: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      {
        encoding: "utf8",
        timeout: GIT_READ_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error !== null) {
          resolve(null);
          return;
        }
        const output = stdout.trim();
        resolve(output.length === 0 ? null : output);
      },
    );
  });
}

export function parseGitHubRepoIdentifier(
  remoteUrl: string,
): TaskRepoIdentifier | null {
  const githubPath = parseGitHubPath(remoteUrl);
  if (githubPath === null) {
    return null;
  }
  const segments = githubPath
    .replace(/\.git$/u, "")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const repo = segments.at(-1);
  const owner = segments.at(-2);
  return owner === undefined || repo === undefined ? null : { owner, repo };
}

function parseGitHubPath(remoteUrl: string): string | null {
  const scp = remoteUrl.match(/^[^@]+@(?<host>[^:]+):(?<path>.+)$/u);
  if (scp?.groups !== undefined) {
    return isGitHubHost(scp.groups.host) ? scp.groups.path : null;
  }
  try {
    const url = new URL(remoteUrl);
    return isGitHubHost(url.hostname) ? url.pathname : null;
  } catch {
    return null;
  }
}

function isGitHubHost(host: string): boolean {
  return host.toLowerCase().replace(/^www\./u, "") === "github.com";
}

function dedupeBy<T>(values: readonly T[], keyOf: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [keyOf(value), value])).values()];
}

function repoIdentifierKey(identifier: TaskRepoIdentifier): string {
  return `${identifier.owner}/${identifier.repo}`;
}
