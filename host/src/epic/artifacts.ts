import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostRuntime } from "../runtime";
import type { StoredArtifact, StoredEpic } from "../store/host-store";

export async function createArtifact(
  runtime: HostRuntime,
  epicId: string,
  parentId: string | null,
  kind: string,
  title: string,
): Promise<string | null> {
  if (findEpic(runtime, epicId) === null) {
    return null;
  }
  if (parentId !== null && findArtifact(runtime, epicId, parentId) === null) {
    return null;
  }
  const artifactId = randomUUID();
  const now = Date.now();
  const folderName = uniqueFolderName(runtime, epicId, title);
  const status = kind === "ticket" || kind === "story" ? 0 : null;
  const created: StoredArtifact = {
    epicId,
    artifactId,
    kind,
    title,
    parentId,
    folderName,
    artifactRoomId: randomUUID(),
    createdAt: now,
    updatedAt: now,
    status,
    assignee: kind === "ticket" || kind === "story" ? "" : null,
  };
  await runtime.store.mutate((state) => {
    state.artifacts.push(created);
    const epic = state.epics.find((row) => row.id === epicId);
    if (epic !== undefined) {
      bumpEpicCount(epic, kind, 1);
      epic.updatedAt = now;
    }
  });
  await writeArtifactMarkdown(runtime, created);
  return artifactId;
}

export async function deleteArtifact(
  runtime: HostRuntime,
  epicId: string,
  artifactId: string,
): Promise<boolean> {
  const existing = findArtifact(runtime, epicId, artifactId);
  if (existing === null) {
    return false;
  }
  const now = Date.now();
  const removedIds = descendantArtifactIds(runtime, epicId, artifactId);
  removedIds.add(artifactId);
  const removedFolders: string[] = [];
  await runtime.store.mutate((state) => {
    const removed = state.artifacts.filter(
      (row) => row.epicId === epicId && removedIds.has(row.artifactId),
    );
    for (const row of removed) {
      removedFolders.push(row.folderName);
    }
    state.artifacts = state.artifacts.filter(
      (row) => !(row.epicId === epicId && removedIds.has(row.artifactId)),
    );
    state.commentThreads = state.commentThreads.filter(
      (row) => !(row.epicId === epicId && removedIds.has(row.artifactId)),
    );
    const epic = state.epics.find((row) => row.id === epicId);
    if (epic !== undefined) {
      for (const row of removed) {
        bumpEpicCount(epic, row.kind, -1);
      }
      epic.updatedAt = now;
    }
  });
  for (const folderName of removedFolders) {
    await removeArtifactDir(runtime, epicId, folderName);
  }
  return true;
}

export async function renameArtifact(
  runtime: HostRuntime,
  epicId: string,
  artifactId: string,
  title: string,
): Promise<boolean> {
  const existing = findArtifact(runtime, epicId, artifactId);
  if (existing === null) {
    return false;
  }
  const now = Date.now();
  await runtime.store.mutate((state) => {
    const row = state.artifacts.find(
      (entry) => entry.epicId === epicId && entry.artifactId === artifactId,
    );
    if (row === undefined) {
      return;
    }
    row.title = title;
    row.updatedAt = now;
    const epic = state.epics.find((entry) => entry.id === epicId);
    if (epic !== undefined) {
      epic.updatedAt = now;
    }
  });
  const updated = findArtifact(runtime, epicId, artifactId);
  if (updated !== null) {
    await writeArtifactMarkdown(runtime, updated);
  }
  return true;
}

export async function updateArtifactStatus(
  runtime: HostRuntime,
  epicId: string,
  artifactId: string,
  status: number,
): Promise<boolean> {
  const existing = findArtifact(runtime, epicId, artifactId);
  if (existing === null) {
    return false;
  }
  if (existing.kind !== "ticket" && existing.kind !== "story") {
    return false;
  }
  const now = Date.now();
  await runtime.store.mutate((state) => {
    const row = state.artifacts.find(
      (entry) => entry.epicId === epicId && entry.artifactId === artifactId,
    );
    if (row === undefined) {
      return;
    }
    row.status = status;
    row.updatedAt = now;
  });
  return true;
}

export async function reparentArtifact(
  runtime: HostRuntime,
  epicId: string,
  artifactId: string,
  newParentId: string | null,
): Promise<boolean> {
  const existing = findArtifact(runtime, epicId, artifactId);
  if (existing === null) {
    return false;
  }
  if (
    newParentId !== null &&
    findArtifact(runtime, epicId, newParentId) === null
  ) {
    return false;
  }
  if (wouldCycle(runtime, epicId, artifactId, newParentId)) {
    return false;
  }
  const now = Date.now();
  await runtime.store.mutate((state) => {
    const row = state.artifacts.find(
      (entry) => entry.epicId === epicId && entry.artifactId === artifactId,
    );
    if (row === undefined) {
      return;
    }
    row.parentId = newParentId;
    row.updatedAt = now;
  });
  return true;
}

export function resolveArtifactByPath(
  runtime: HostRuntime,
  epicId: string,
  filePath: string,
): StoredArtifact | null {
  const needle = `/artifacts/`;
  const index = filePath.lastIndexOf(needle);
  if (index < 0) {
    return (
      runtime.store
        .snapshot()
        .artifacts.find(
          (row) =>
            row.epicId === epicId &&
            (filePath.endsWith(`/${row.folderName}/index.md`) ||
              filePath.endsWith(`/${row.artifactId}/index.md`)),
        ) ?? null
    );
  }
  const rest = filePath.slice(index + needle.length);
  const folder = rest.split("/")[0];
  if (folder === undefined || folder.length === 0) {
    return null;
  }
  return (
    runtime.store
      .snapshot()
      .artifacts.find(
        (row) =>
          row.epicId === epicId &&
          (row.folderName === folder || row.artifactId === folder),
      ) ?? null
  );
}

export function listArtifacts(
  runtime: HostRuntime,
  query: string,
  limit: number,
): readonly StoredArtifact[] {
  const needle = query.toLowerCase();
  return runtime.store
    .snapshot()
    .artifacts.filter(
      (row) => needle.length === 0 || row.title.toLowerCase().includes(needle),
    )
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, limit);
}

export function artifactRelativePath(artifact: StoredArtifact): string {
  return `artifacts/${artifact.folderName}/index.md`;
}

export function findArtifact(
  runtime: HostRuntime,
  epicId: string,
  artifactId: string,
): StoredArtifact | null {
  return (
    runtime.store
      .snapshot()
      .artifacts.find(
        (row) => row.epicId === epicId && row.artifactId === artifactId,
      ) ?? null
  );
}

function findEpic(runtime: HostRuntime, epicId: string): StoredEpic | null {
  return (
    runtime.store.snapshot().epics.find((row) => row.id === epicId) ?? null
  );
}

function uniqueFolderName(
  runtime: HostRuntime,
  epicId: string,
  title: string,
): string {
  const base = slugify(title);
  const taken = new Set(
    runtime.store
      .snapshot()
      .artifacts.filter((row) => row.epicId === epicId)
      .map((row) => row.folderName),
  );
  if (!taken.has(base)) {
    return base;
  }
  let index = 2;
  while (taken.has(`${base}-${String(index)}`)) {
    index += 1;
  }
  return `${base}-${String(index)}`;
}

function slugify(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug.length > 0 ? slug : "artifact";
}

function bumpEpicCount(epic: StoredEpic, kind: string, delta: number): void {
  if (kind === "ticket") {
    epic.ticketCount = Math.max(0, epic.ticketCount + delta);
  } else if (kind === "spec") {
    epic.specCount = Math.max(0, epic.specCount + delta);
  } else if (kind === "story") {
    epic.storyCount = Math.max(0, epic.storyCount + delta);
  } else if (kind === "review") {
    epic.reviewCount = Math.max(0, epic.reviewCount + delta);
  }
}

function descendantArtifactIds(
  runtime: HostRuntime,
  epicId: string,
  rootId: string,
): Set<string> {
  const rows = runtime.store
    .snapshot()
    .artifacts.filter((row) => row.epicId === epicId);
  const ids = new Set<string>();
  const visit = (parentId: string): void => {
    for (const row of rows) {
      if (row.parentId === parentId && !ids.has(row.artifactId)) {
        ids.add(row.artifactId);
        visit(row.artifactId);
      }
    }
  };
  visit(rootId);
  return ids;
}

function wouldCycle(
  runtime: HostRuntime,
  epicId: string,
  artifactId: string,
  newParentId: string | null,
): boolean {
  let cursor = newParentId;
  while (cursor !== null) {
    if (cursor === artifactId) {
      return true;
    }
    const parent = findArtifact(runtime, epicId, cursor);
    if (parent === null) {
      return true;
    }
    cursor = parent.parentId;
  }
  return false;
}

function artifactDir(
  runtime: HostRuntime,
  epicId: string,
  folderName: string,
): string {
  return join(runtime.dataDir, "epics", epicId, "artifacts", folderName);
}

async function writeArtifactMarkdown(
  runtime: HostRuntime,
  artifact: StoredArtifact,
): Promise<void> {
  const dir = artifactDir(runtime, artifact.epicId, artifact.folderName);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.md"), renderFrontMatter(artifact), "utf8");
}

async function removeArtifactDir(
  runtime: HostRuntime,
  epicId: string,
  folderName: string,
): Promise<void> {
  await rm(artifactDir(runtime, epicId, folderName), {
    recursive: true,
    force: true,
  });
}

function renderFrontMatter(artifact: StoredArtifact): string {
  const title = artifact.title.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `---\ntitle: "${title}"\nkind: ${artifact.kind}\n---\n`;
}
