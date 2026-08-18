import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type {
  PreparedWorkspaceFolder,
  TaskRepoIdentifier,
} from "@traycer/protocol/host/epic/unary-schemas";
import { parseGitHubRepoIdentifier } from "./workspace-prepare";

const persistedMappingSchema = z.object({
  id: z.string().min(1),
  repoUrl: z.string().min(1),
  workspacePath: z.string().min(1),
  lastUpdated: z.number(),
  version: z.literal(1),
});

const persistedMappingsSchema = z.object({
  version: z.literal(1),
  mappings: z.array(persistedMappingSchema),
});

type PersistedMapping = z.infer<typeof persistedMappingSchema>;

export type RepoWorkspaceMapping = {
  readonly repoIdentifier: TaskRepoIdentifier;
  readonly repoUrl: string;
  readonly workspacePath: string;
};

export class RepoWorkspacePersistence {
  private readonly rows = new Map<string, PersistedMapping>();

  private constructor(
    private readonly path: string,
    rows: readonly PersistedMapping[],
  ) {
    for (const row of rows) {
      this.rows.set(row.workspacePath, row);
    }
  }

  static async open(hostHome: string): Promise<RepoWorkspacePersistence> {
    const path = join(hostHome, "config", "repo-workspace-mappings.json");
    try {
      const raw = await readFile(path, "utf8");
      const parsed = persistedMappingsSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        throw new Error(
          `Invalid repo workspace mapping store: ${parsed.error.message}`,
        );
      }
      return new RepoWorkspacePersistence(path, parsed.data.mappings);
    } catch (error) {
      if (isEnoent(error)) {
        return new RepoWorkspacePersistence(path, []);
      }
      throw error;
    }
  }

  listMappings(): RepoWorkspaceMapping[] {
    return [...this.rows.values()].flatMap((row) => {
      const repoIdentifier = parseGitHubRepoIdentifier(row.repoUrl);
      return repoIdentifier === null
        ? []
        : [
            {
              repoIdentifier,
              repoUrl: row.repoUrl,
              workspacePath: row.workspacePath,
            },
          ];
    });
  }

  async upsertPreparedFolders(
    folders: readonly PreparedWorkspaceFolder[],
  ): Promise<RepoWorkspaceMapping[]> {
    const next = new Map(this.rows);
    const now = Date.now();
    for (const folder of folders) {
      if (folder.repoIdentifier === null || folder.repoUrl === null) {
        continue;
      }
      next.set(folder.workspacePath, {
        id: `path:${folder.workspacePath}`,
        repoUrl: folder.repoUrl,
        workspacePath: folder.workspacePath,
        lastUpdated: now,
        version: 1,
      });
    }
    await writeMappings(this.path, [...next.values()]);
    this.rows.clear();
    for (const [workspacePath, row] of next) {
      this.rows.set(workspacePath, row);
    }
    return this.listMappings();
  }
}

async function writeMappings(
  path: string,
  mappings: readonly PersistedMapping[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      tempPath,
      `${JSON.stringify({ version: 1, mappings }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch((unlinkError: unknown) => {
      if (!isEnoent(unlinkError)) {
        throw unlinkError;
      }
    });
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
