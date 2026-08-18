import { spawnSync } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import type {
  WorkspaceFileMentionSuggestionsResponse,
  WorkspaceFileTreeGitStatus,
  WorkspaceFileTreeGitStatusEntry,
  WorkspaceFolderMentionSuggestionsResponse,
  WorkspaceListFileTreeRequest,
  WorkspaceListFileTreeResponse,
  WorkspacePathMentionSuggestionsRequest,
} from "@traycer/protocol/host/workspace/unary-schemas";
import type { GitChangedFileV10 } from "@traycer/protocol/host/git-schemas";
import { listGitChangedFiles } from "./git-status";

export function listWorkspaceFileTree(
  request: WorkspaceListFileTreeRequest,
): WorkspaceListFileTreeResponse {
  const scanned = scanWorkspacePaths(
    request.workspacePath,
    request.includeIgnored,
  );
  const files = scanned.files.slice(0, request.maxFiles).map((path) => ({
    path,
    name: basename(path),
  }));
  return {
    workspacePath: scanned.workspacePath,
    files,
    gitStatus: scanned.isGit
      ? gitStatus(
          scanned.workspacePath,
          request.includeIgnored,
          scanned.ignored,
        )
      : [],
    truncated: scanned.files.length > request.maxFiles,
  };
}

export function mentionWorkspaceFiles(
  request: WorkspacePathMentionSuggestionsRequest,
): WorkspaceFileMentionSuggestionsResponse {
  return {
    entries: mentionCandidates(request, "file").map(
      ({ workspacePath, relPath }) => ({
        kind: "file",
        id: `file:${workspacePath}:${relPath}`,
        label: basename(relPath),
        relPath,
        absolutePath: join(workspacePath, relPath),
        workspacePath,
        description: pathDescription(relPath),
      }),
    ),
  };
}

export function mentionWorkspaceFolders(
  request: WorkspacePathMentionSuggestionsRequest,
): WorkspaceFolderMentionSuggestionsResponse {
  return {
    entries: mentionCandidates(request, "folder").map(
      ({ workspacePath, relPath }) => {
        const displayPath = `${relPath}/`;
        return {
          kind: "folder",
          id: `folder:${workspacePath}:${displayPath}`,
          label: basename(relPath),
          relPath: displayPath,
          absolutePath: join(workspacePath, relPath),
          workspacePath,
          description: pathDescription(relPath),
        };
      },
    ),
  };
}

type WorkspaceScan = {
  readonly workspacePath: string;
  readonly files: string[];
  readonly folders: string[];
  readonly ignored: string[];
  readonly isGit: boolean;
};

function scanWorkspacePaths(
  requestedPath: string,
  includeIgnored: boolean,
): WorkspaceScan {
  const workspacePath = realpathSync(requestedPath);
  const gitFiles = gitFilePaths(workspacePath, includeIgnored);
  const files = gitFiles?.files ?? walkFilePaths(workspacePath);
  return {
    workspacePath,
    files,
    folders: foldersForFiles(files),
    ignored: gitFiles?.ignored ?? [],
    isGit: gitFiles !== null,
  };
}

type MentionCandidate = {
  readonly workspacePath: string;
  readonly relPath: string;
  readonly rootIndex: number;
  readonly matchRank: number;
  readonly depth: number;
};

function mentionCandidates(
  request: WorkspacePathMentionSuggestionsRequest,
  kind: "file" | "folder",
): MentionCandidate[] {
  const query = request.query.trim().toLocaleLowerCase();
  const candidates: MentionCandidate[] = [];
  const seen = new Set<string>();
  for (const [rootIndex, root] of request.roots.entries()) {
    let scanned: WorkspaceScan;
    try {
      scanned = scanWorkspacePaths(root, false);
    } catch {
      continue;
    }
    const paths = kind === "file" ? scanned.files : scanned.folders;
    for (const relPath of paths) {
      const id = `${scanned.workspacePath}\0${relPath}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const matchRank = pathMatchRank(relPath, query);
      if (matchRank === null) continue;
      candidates.push({
        workspacePath: scanned.workspacePath,
        relPath,
        rootIndex,
        matchRank,
        depth: relPath.split("/").length,
      });
    }
  }
  return candidates.sort(compareMentionCandidates).slice(0, request.limit);
}

function pathMatchRank(relPath: string, query: string): number | null {
  if (query.length === 0) return 0;
  const label = basename(relPath).toLocaleLowerCase();
  const path = relPath.toLocaleLowerCase();
  if (label.startsWith(query)) return 0;
  if (label.includes(query)) return 1;
  if (path.startsWith(query)) return 2;
  if (path.includes(query)) return 3;
  return null;
}

function compareMentionCandidates(
  left: MentionCandidate,
  right: MentionCandidate,
): number {
  return (
    left.matchRank - right.matchRank ||
    left.rootIndex - right.rootIndex ||
    left.depth - right.depth ||
    comparePaths(left.relPath, right.relPath)
  );
}

function pathDescription(relPath: string): string {
  const parent = dirname(relPath);
  return parent === "." ? "" : posixPath(parent);
}

function foldersForFiles(files: readonly string[]): string[] {
  const folders = new Set<string>();
  for (const file of files) {
    const segments = file.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      folders.add(segments.slice(0, index).join("/"));
    }
  }
  return [...folders].sort(comparePaths);
}

function gitFilePaths(
  workspacePath: string,
  includeIgnored: boolean,
): { readonly files: string[]; readonly ignored: string[] } | null {
  const visible = optionalGit(workspacePath, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  if (visible === null) return null;
  const ignored = includeIgnored
    ? (optionalGit(workspacePath, [
        "ls-files",
        "-z",
        "--others",
        "--ignored",
        "--exclude-standard",
      ]) ?? [])
    : [];
  return {
    files: [...new Set([...visible, ...ignored])].sort(comparePaths),
    ignored,
  };
}

function gitStatus(
  workspacePath: string,
  includeIgnored: boolean,
  ignored: readonly string[],
): WorkspaceFileTreeGitStatusEntry[] {
  const byPath = new Map<string, WorkspaceFileTreeGitStatus>();
  for (const file of listGitChangedFiles({
    hostId: "local",
    runningDir: workspacePath,
    ignoreWhitespace: false,
  }).files) {
    const status = workspaceStatus(file);
    const current = byPath.get(file.path);
    if (
      current === undefined ||
      statusPriority(status) < statusPriority(current)
    ) {
      byPath.set(file.path, status);
    }
  }
  if (includeIgnored) {
    for (const path of ignored) byPath.set(path, "ignored");
  }
  return [...byPath]
    .sort(([left], [right]) => comparePaths(left, right))
    .map(([path, status]) => ({ path, status }));
}

function workspaceStatus(file: GitChangedFileV10): WorkspaceFileTreeGitStatus {
  switch (file.status) {
    case "added":
    case "deleted":
    case "modified":
    case "renamed":
    case "untracked":
      return file.status;
    case "copied":
      return "added";
    case "conflicted":
      return "modified";
  }
}

function statusPriority(status: WorkspaceFileTreeGitStatus): number {
  const priority: readonly WorkspaceFileTreeGitStatus[] = [
    "deleted",
    "renamed",
    "added",
    "untracked",
    "modified",
    "ignored",
  ];
  return priority.indexOf(status);
}

function optionalGit(cwd: string, args: readonly string[]): string[] | null {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) return null;
  return result.stdout
    .split("\0")
    .filter((path) => path.length > 0)
    .map(posixPath);
}

function walkFilePaths(workspacePath: string): string[] {
  const paths: string[] = [];
  const pending = [workspacePath];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolutePath);
      } else {
        paths.push(posixPath(relative(workspacePath, absolutePath)));
      }
    }
  }
  return paths.sort(comparePaths);
}

function posixPath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function comparePaths(left: string, right: string): number {
  return left.localeCompare(right);
}
