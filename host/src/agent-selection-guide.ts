import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AgentSelectionGuideGlobalGetResponse,
  AgentSelectionGuideGlobalOnboardingDraftGetResponse,
  AgentSelectionGuideGlobalResetResponse,
  AgentSelectionGuideGlobalSetResponse,
  AgentSelectionGuideResponse,
} from "@traycer/protocol/host/agent/shared";

const GUIDE_FILE_NAME = "agent-selection-guide.md";
const GUIDE_META_FILE_NAME = ".agent-selection-guide.meta.json";
const GUIDE_META = '{\n  "guideVersion": 1\n}\n';

export const LOCAL_AGENT_SELECTION_GUIDE_DEFAULT = [
  "# Agent Selection Guide",
  "",
  "For implementation tasks, use the `claude` harness with latest Opus model and high reasoning effort. In the handoff, ask the child agent to use the `traycer-implement` skill.",
  "",
  "For review tasks, use the `codex` harness with latest GPT model and high reasoning effort. In the handoff, ask the child agent to use the `traycer-review` skill.",
  "",
].join("\n");

export class AgentSelectionGuideStore {
  private mutationTail = Promise.resolve();
  private readonly homeDir: string;

  constructor(homeDir: string | undefined) {
    this.homeDir = homeDir ?? join(homedir(), ".traycer");
  }

  async getForAgent(): Promise<AgentSelectionGuideResponse> {
    const global = await this.getGlobal();
    return {
      status: "found",
      sources: [
        {
          kind: "global",
          path: this.guidePath(),
          priority: 1,
          content: global.content,
        },
      ],
    };
  }

  async getGlobal(): Promise<AgentSelectionGuideGlobalGetResponse> {
    return await this.withMutation(async () => {
      const [content, meta] = await Promise.all([
        readFileOrNull(this.guidePath()),
        readFileOrNull(this.metaPath()),
      ]);
      if (content === null || (content.trim().length === 0 && meta === null)) {
        await this.writeUnlocked(LOCAL_AGENT_SELECTION_GUIDE_DEFAULT);
        return defaultResponse();
      }
      return {
        content,
        generatedDefaultContent: LOCAL_AGENT_SELECTION_GUIDE_DEFAULT,
      };
    });
  }

  async getOnboardingDraft(): Promise<AgentSelectionGuideGlobalOnboardingDraftGetResponse> {
    return await this.withMutation(async () => {
      const [content, meta] = await Promise.all([
        readFileOrNull(this.guidePath()),
        readFileOrNull(this.metaPath()),
      ]);
      return {
        content:
          content === null || (content.trim().length === 0 && meta === null)
            ? null
            : content,
        generatedDefaultContent: LOCAL_AGENT_SELECTION_GUIDE_DEFAULT,
        providersSettled: true,
      };
    });
  }

  async setGlobal(
    content: string,
  ): Promise<AgentSelectionGuideGlobalSetResponse> {
    return await this.withMutation(async () => ({
      content: await this.writeUnlocked(content),
      generatedDefaultContent: LOCAL_AGENT_SELECTION_GUIDE_DEFAULT,
    }));
  }

  async resetGlobal(): Promise<AgentSelectionGuideGlobalResetResponse> {
    return await this.withMutation(async () => {
      await this.writeUnlocked(LOCAL_AGENT_SELECTION_GUIDE_DEFAULT);
      return defaultResponse();
    });
  }

  private guidePath(): string {
    return join(this.homeDir, GUIDE_FILE_NAME);
  }

  private metaPath(): string {
    return join(this.homeDir, GUIDE_META_FILE_NAME);
  }

  private async writeUnlocked(content: string): Promise<string> {
    await mkdir(this.homeDir, { recursive: true, mode: 0o700 });
    await writeAtomic(this.metaPath(), GUIDE_META);
    await writeAtomic(this.guidePath(), content);
    return content;
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.mutationTail;
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.mutationTail = prior.then(
      () => current,
      () => current,
    );
    await prior.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function defaultResponse(): AgentSelectionGuideGlobalGetResponse {
  return {
    content: LOCAL_AGENT_SELECTION_GUIDE_DEFAULT,
    generatedDefaultContent: LOCAL_AGENT_SELECTION_GUIDE_DEFAULT,
  };
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch((unlinkError: unknown) => {
      if (!isEnoent(unlinkError)) {
        throw unlinkError;
      }
    });
    throw error;
  }
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return null;
    }
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    Reflect.get(error, "code") === "ENOENT"
  );
}
