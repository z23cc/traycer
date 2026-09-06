import { spawn, type ChildProcess } from "node:child_process";
import type {
  AgentReasoningEffortOption,
  AgentServiceTierOption,
  GuiAgentModelOption,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import type { GuiHarnessId } from "@traycer/protocol/host/agent/shared";
import { providerCliIdentity } from "../providers/service";
import type { HostRuntime } from "../runtime";
import { HOST_VERSION } from "../version";
import { providerIdForHarness } from "./harness-map";

const PROBE_TIMEOUT_MS = 5_000;
const CACHE_MS = 5 * 60 * 1_000;

type CachedModels = {
  readonly at: number;
  readonly models: readonly GuiAgentModelOption[];
};

const CACHE = new Map<string, CachedModels>();

const CLAUDE_EFFORTS: readonly string[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export async function modelsForHarness(
  runtime: HostRuntime,
  harnessId: GuiHarnessId,
): Promise<readonly GuiAgentModelOption[]> {
  if (harnessId === "claude") {
    return claudeCatalog();
  }
  if (harnessId === "codex") {
    return ensureDefaultRow(
      firstNonEmpty(
        await probeCached(runtime, harnessId, probeCodexModels),
        codexFallback(),
      ),
    );
  }
  if (harnessId === "grok") {
    return ensureDefaultRow(
      firstNonEmpty(
        await probeCached(runtime, harnessId, probeGrokModels),
        grokFallback(),
      ),
    );
  }
  if (harnessId === "opencode") {
    return ensureDefaultRow(
      firstNonEmpty(
        await probeCached(runtime, harnessId, probeOpencodeModels),
        [stubModel(harnessId)],
      ),
    );
  }
  return [stubModel(harnessId)];
}

export function summariesForModels(
  harnessId: string,
  models: readonly GuiAgentModelOption[],
): {
  readonly harnessId: string;
  readonly models: readonly {
    readonly id: string;
    readonly reasoningEfforts: readonly string[];
    readonly fastModeAvailable: boolean;
  }[];
} {
  return {
    harnessId,
    models: models.map((model) => ({
      id: model.slug,
      reasoningEfforts: model.supportedReasoningEfforts.map((row) => row.id),
      fastModeAvailable: modelHasFastMode(model),
    })),
  };
}

export function parseCodexModelsResult(result: unknown): GuiAgentModelOption[] {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return [];
  }
  const data = Reflect.get(result, "data");
  if (!Array.isArray(data)) {
    return [];
  }
  const models: GuiAgentModelOption[] = [];
  for (const row of data) {
    const parsed = parseCodexModel(row);
    if (parsed !== null) {
      models.push(parsed);
    }
  }
  return models;
}

export function parseGrokModelsOutput(output: string): GuiAgentModelOption[] {
  const models: GuiAgentModelOption[] = [];
  const seen = new Set<string>();
  for (const line of output.split("\n")) {
    const match = /^\s*[*+-]\s+(\S+)/u.exec(line);
    if (match === null) {
      continue;
    }
    const slug = match[1];
    if (slug === undefined || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    models.push(
      row({
        harnessId: "grok",
        slug,
        label: grokLabel(slug),
        description: null,
        resolvedModel: slug,
        efforts: ["high", "medium", "low"],
        defaultEffort: "high",
        tiers: [],
        image: true,
      }),
    );
  }
  return models;
}

export function parseOpencodeModelsOutput(
  output: string,
): GuiAgentModelOption[] {
  const models: GuiAgentModelOption[] = [];
  const seen = new Set<string>();
  for (const raw of output.split("\n")) {
    const slug = raw.trim();
    if (slug.length === 0 || !slug.includes("/") || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    const slash = slug.lastIndexOf("/");
    const label = slash < 0 ? slug : slug.slice(slash + 1);
    models.push(
      row({
        harnessId: "opencode",
        slug,
        label,
        description: null,
        resolvedModel: slug,
        efforts: [],
        defaultEffort: null,
        tiers: [],
        image: false,
      }),
    );
    if (models.length >= 40) {
      break;
    }
  }
  return models;
}

async function probeCached(
  runtime: HostRuntime,
  harnessId: GuiHarnessId,
  probe: (binaryPath: string) => Promise<GuiAgentModelOption[]>,
): Promise<GuiAgentModelOption[]> {
  const identity = providerCliIdentity(
    runtime.store,
    providerIdForHarness(harnessId),
  );
  const binaryPath = identity.path;
  if (binaryPath === null) {
    return [];
  }
  const key = `${harnessId}:${binaryPath}`;
  const hit = CACHE.get(key);
  if (hit !== undefined && Date.now() - hit.at < CACHE_MS) {
    return [...hit.models];
  }
  const models = await probe(binaryPath);
  if (models.length > 0) {
    CACHE.set(key, { at: Date.now(), models });
  }
  return models;
}

function probeCodexModels(binaryPath: string): Promise<GuiAgentModelOption[]> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(binaryPath, ["app-server", "--listen", "stdio://"], {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      resolve([]);
      return;
    }
    let buffer = "";
    let settled = false;
    const finish = (models: GuiAgentModelOption[]): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve(models);
    };
    const timer: NodeJS.Timeout = setTimeout(() => {
      finish([]);
    }, PROBE_TIMEOUT_MS);
    const send = (payload: unknown): void => {
      child.stdin?.write(`${JSON.stringify(payload)}\n`);
    };
    send({
      jsonrpc: "2.0",
      id: "1",
      method: "initialize",
      params: {
        protocolVersion: "2025-01-01",
        capabilities: { experimentalApi: true },
        clientInfo: { name: "traycer-host", version: HOST_VERSION },
      },
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length === 0) {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed === null || typeof parsed !== "object") {
          continue;
        }
        const id = Reflect.get(parsed, "id");
        if (id === "1") {
          send({
            jsonrpc: "2.0",
            id: "2",
            method: "model/list",
            params: {},
          });
          continue;
        }
        if (id === "2") {
          finish(parseCodexModelsResult(Reflect.get(parsed, "result")));
        }
      }
    });
    child.once("error", () => {
      finish([]);
    });
    child.once("close", () => {
      finish([]);
    });
  });
}

function probeGrokModels(binaryPath: string): Promise<GuiAgentModelOption[]> {
  return collectCommandOutput(binaryPath, ["models"]).then(parseGrokModelsOutput);
}

function probeOpencodeModels(
  binaryPath: string,
): Promise<GuiAgentModelOption[]> {
  return collectCommandOutput(binaryPath, ["models"]).then(
    parseOpencodeModelsOutput,
  );
}

function collectCommandOutput(
  binaryPath: string,
  args: readonly string[],
): Promise<string> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(binaryPath, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve("");
      return;
    }
    let output = "";
    const onData = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.length > 64_000) {
        child.kill("SIGTERM");
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const timer: NodeJS.Timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, PROBE_TIMEOUT_MS);
    child.once("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    child.once("close", () => {
      clearTimeout(timer);
      resolve(output);
    });
  });
}

function parseCodexModel(row: unknown): GuiAgentModelOption | null {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    return null;
  }
  if (Reflect.get(row, "hidden") === true) {
    return null;
  }
  const slug = readString(row, "id") ?? readString(row, "model");
  if (slug === null) {
    return null;
  }
  const label = readString(row, "displayName") ?? slug;
  const description = readString(row, "description");
  const defaultEffort = readString(row, "defaultReasoningEffort");
  const modalities = stringList(Reflect.get(row, "inputModalities"));
  return guiModel({
    harnessId: "codex",
    slug,
    label,
    description,
    resolvedModel: slug,
    efforts: parseCodexEfforts(Reflect.get(row, "supportedReasoningEfforts")).map(
      (rowEffort) => rowEffort.id,
    ),
    defaultEffort,
    tiers: parseCodexTiers(row),
    image: modalities.includes("image"),
    extraMeta: undefined,
    effortRows: parseCodexEfforts(Reflect.get(row, "supportedReasoningEfforts")),
  });
}

function parseCodexEfforts(value: unknown): AgentReasoningEffortOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rows: AgentReasoningEffortOption[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const id = readString(entry, "reasoningEffort") ?? readString(entry, "id");
    if (id === null) {
      continue;
    }
    rows.push({
      id,
      label: effortLabel(id),
      description: readString(entry, "description"),
    });
  }
  return rows;
}

function parseCodexTiers(row: object): AgentServiceTierOption[] {
  const listed = Reflect.get(row, "serviceTiers");
  if (Array.isArray(listed) && listed.length > 0) {
    const rows: AgentServiceTierOption[] = [];
    for (const entry of listed) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const id = readString(entry, "id");
      if (id === null) {
        continue;
      }
      rows.push({
        id,
        label: readString(entry, "name") ?? readString(entry, "label") ?? id,
        description: readString(entry, "description"),
      });
    }
    return rows;
  }
  const extra = stringList(Reflect.get(row, "additionalSpeedTiers"));
  return extra.map((id) => ({
    id,
    label: effortLabel(id),
    description: null,
  }));
}

function claudeCatalog(): GuiAgentModelOption[] {
  const imageMeta = {
    supportsImageAttachments: true,
    supportsEffort: true,
    supportedEffortLevels: [...CLAUDE_EFFORTS],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
  };
  return [
    guiModel({
      harnessId: "claude",
      slug: "default",
      label: "Default (Sonnet 5)",
      description: "Sonnet 5 · Efficient for routine tasks",
      resolvedModel: "claude-sonnet-5",
      efforts: CLAUDE_EFFORTS,
      defaultEffort: null,
      tiers: [],
      image: true,
      extraMeta: imageMeta,
      effortRows: undefined,
    }),
    guiModel({
      harnessId: "claude",
      slug: "sonnet",
      label: "Sonnet 5",
      description: "Sonnet 5 · Efficient for routine tasks",
      resolvedModel: "claude-sonnet-5",
      efforts: CLAUDE_EFFORTS,
      defaultEffort: null,
      tiers: [],
      image: true,
      extraMeta: imageMeta,
      effortRows: undefined,
    }),
    guiModel({
      harnessId: "claude",
      slug: "claude-fable-5[1m]",
      label: "Fable",
      description: "Fable · Long-context reasoning",
      resolvedModel: "claude-fable-5",
      efforts: CLAUDE_EFFORTS,
      defaultEffort: null,
      tiers: [],
      image: true,
      extraMeta: imageMeta,
      effortRows: undefined,
    }),
    guiModel({
      harnessId: "claude",
      slug: "opus",
      label: "Opus 5",
      description: "Opus 5 · Best for everyday, complex tasks",
      resolvedModel: "claude-opus-5",
      efforts: CLAUDE_EFFORTS,
      defaultEffort: null,
      tiers: [
        {
          id: "fast",
          label: "Fast",
          description: "Priority compute - faster responses.",
        },
      ],
      image: true,
      extraMeta: { ...imageMeta, supportsFastMode: true },
      effortRows: undefined,
    }),
    guiModel({
      harnessId: "claude",
      slug: "haiku",
      label: "Haiku 4.5",
      description: "Haiku 4.5 · Fastest for quick answers",
      resolvedModel: "claude-haiku-4-5-20251001",
      efforts: [],
      defaultEffort: null,
      tiers: [],
      image: true,
      extraMeta: undefined,
      effortRows: undefined,
    }),
  ];
}

function codexFallback(): GuiAgentModelOption[] {
  return [
    row({
      harnessId: "codex",
      slug: "gpt-6-astra",
      label: "GPT-6-Astra",
      description: "Our most capable model for complex, demanding work.",
      resolvedModel: "gpt-6-astra",
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultEffort: "medium",
      tiers: [
        { id: "priority", label: "Fast", description: "2x speed, increased usage" },
      ],
      image: true,
    }),
    row({
      harnessId: "codex",
      slug: "gpt-5.6-sol",
      label: "GPT-5.6-Sol",
      description: "Reliable agentic workhorse for everyday tasks.",
      resolvedModel: "gpt-5.6-sol",
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultEffort: "low",
      tiers: [
        { id: "priority", label: "Fast", description: "1.5x speed, increased usage" },
      ],
      image: true,
    }),
    row({
      harnessId: "codex",
      slug: "gpt-5.6-terra",
      label: "GPT-5.6-Terra",
      description: "Balanced agentic coding model for everyday work.",
      resolvedModel: "gpt-5.6-terra",
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultEffort: "medium",
      tiers: [
        { id: "priority", label: "Fast", description: "1.5x speed, increased usage" },
      ],
      image: true,
    }),
    row({
      harnessId: "codex",
      slug: "gpt-5.6-luna",
      label: "GPT-5.6-Luna",
      description: "Fast and affordable agentic coding model.",
      resolvedModel: "gpt-5.6-luna",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
      tiers: [
        { id: "priority", label: "Fast", description: "1.5x speed, increased usage" },
      ],
      image: true,
    }),
    row({
      harnessId: "codex",
      slug: "gpt-5.5",
      label: "GPT-5.5",
      description: "Proven previous-generation model for coding and general work.",
      resolvedModel: "gpt-5.5",
      efforts: ["low", "medium", "high", "xhigh"],
      defaultEffort: "medium",
      tiers: [
        { id: "priority", label: "Fast", description: "1.5x speed, increased usage" },
      ],
      image: true,
    }),
    row({
      harnessId: "codex",
      slug: "gpt-5.4-mini",
      label: "GPT-5.4-Mini",
      description: "Small, fast, and cost-efficient model for simpler coding tasks.",
      resolvedModel: "gpt-5.4-mini",
      efforts: ["low", "medium", "high", "xhigh"],
      defaultEffort: "medium",
      tiers: [],
      image: true,
    }),
    row({
      harnessId: "codex",
      slug: "gpt-5.3-codex-spark",
      label: "GPT-5.3-Codex-Spark",
      description: "Ultra-fast coding model.",
      resolvedModel: "gpt-5.3-codex-spark",
      efforts: ["low", "medium", "high", "xhigh"],
      defaultEffort: "high",
      tiers: [],
      image: false,
    }),
  ];
}

function grokFallback(): GuiAgentModelOption[] {
  return [
    row({
      harnessId: "grok",
      slug: "grok-4.6",
      label: "Grok 4.6",
      description: null,
      resolvedModel: "grok-4.6",
      efforts: ["high", "medium", "low"],
      defaultEffort: "high",
      tiers: [],
      image: true,
    }),
    row({
      harnessId: "grok",
      slug: "grok-4.5",
      label: "Grok 4.5",
      description: null,
      resolvedModel: "grok-4.5",
      efforts: ["high", "medium", "low"],
      defaultEffort: "high",
      tiers: [],
      image: true,
    }),
  ];
}

function stubModel(harnessId: GuiHarnessId): GuiAgentModelOption {
  return row({
    harnessId,
    slug: "default",
    label: "Default",
    description: null,
    resolvedModel: null,
    efforts: [],
    defaultEffort: null,
    tiers: [],
    image: false,
  });
}

function row(input: {
  readonly harnessId: GuiHarnessId;
  readonly slug: string;
  readonly label: string;
  readonly description: string | null;
  readonly resolvedModel: string | null;
  readonly efforts: readonly string[];
  readonly defaultEffort: string | null;
  readonly tiers: readonly AgentServiceTierOption[];
  readonly image: boolean;
}): GuiAgentModelOption {
  return guiModel({
    ...input,
    extraMeta: undefined,
    effortRows: undefined,
  });
}

function guiModel(input: {
  readonly harnessId: GuiHarnessId;
  readonly slug: string;
  readonly label: string;
  readonly description: string | null;
  readonly resolvedModel: string | null;
  readonly efforts: readonly string[];
  readonly defaultEffort: string | null;
  readonly tiers: readonly AgentServiceTierOption[];
  readonly image: boolean;
  readonly extraMeta: { readonly [key: string]: unknown } | undefined;
  readonly effortRows: readonly AgentReasoningEffortOption[] | undefined;
}): GuiAgentModelOption {
  const extraMeta = input.extraMeta;
  const effortRows = input.effortRows;
  const metadata: { [key: string]: unknown } = {
    inputModalities: input.image ? ["text", "image"] : ["text"],
  };
  if (input.image) {
    metadata.supportsImageAttachments = true;
  }
  if (input.resolvedModel !== null) {
    metadata.resolvedModel = input.resolvedModel;
  }
  if (extraMeta !== undefined) {
    for (const key of Object.keys(extraMeta)) {
      metadata[key] = extraMeta[key];
    }
  }
  const efforts =
    effortRows === undefined
      ? input.efforts.map((id) => ({
          id,
          label: effortLabel(id),
          description: null,
        }))
      : [...effortRows];
  return {
    harnessId: input.harnessId,
    slug: input.slug,
    label: input.label,
    description: input.description,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: input.defaultEffort,
    supportedReasoningEfforts: efforts,
    defaultServiceTier: null,
    supportedServiceTiers: [...input.tiers],
    metadata,
  };
}

function effortLabel(id: string): string {
  if (id === "low") {
    return "Low";
  }
  if (id === "medium") {
    return "Medium";
  }
  if (id === "high") {
    return "High";
  }
  if (id === "xhigh") {
    return "Extra High";
  }
  if (id === "max") {
    return "Max";
  }
  if (id === "ultra") {
    return "Ultra";
  }
  if (id === "fast") {
    return "Fast";
  }
  return id;
}

function grokLabel(slug: string): string {
  return slug
    .split("-")
    .map((part) => (part.length === 0 ? part : part[0]?.toUpperCase() + part.slice(1)))
    .join(" ");
}

function modelHasFastMode(model: GuiAgentModelOption): boolean {
  if (model.metadata.supportsFastMode === true) {
    return true;
  }
  return model.supportedServiceTiers.some(
    (tier) => tier.id === "fast" || tier.id === "priority",
  );
}

function ensureDefaultRow(
  models: readonly GuiAgentModelOption[],
): GuiAgentModelOption[] {
  if (models.length === 0) {
    return [];
  }
  const first = models[0];
  if (first === undefined || first.slug === "default") {
    return [...models];
  }
  if (models.some((model) => model.slug === "default")) {
    return [...models];
  }
  return [
    {
      ...first,
      slug: "default",
      label: `Default (${first.label})`,
    },
    ...models,
  ];
}

function firstNonEmpty(
  live: readonly GuiAgentModelOption[],
  fallback: readonly GuiAgentModelOption[],
): readonly GuiAgentModelOption[] {
  return live.length > 0 ? live : fallback;
}

function readString(record: object, key: string): string | null {
  const value = Reflect.get(record, key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}
