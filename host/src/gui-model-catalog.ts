import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GuiAgentModelOption } from "@traycer/protocol/host/agent/gui/unary-schemas";
import type {
  AgentFacingHarnessId,
  HarnessModelSummary,
} from "@traycer/protocol/host/agent/shared";

export type LocalGuiHarnessId = "claude" | "codex";

export type LocalGuiModel = Omit<GuiAgentModelOption, "harnessId"> & {
  readonly harnessId: LocalGuiHarnessId;
};

const CLAUDE_MODELS: readonly LocalGuiModel[] = [
  model("claude", "sonnet", "Claude Sonnet 5"),
  model("claude", "opus", "Claude Opus 5"),
  model("claude", "fable", "Claude Fable 5"),
];

const CODEX_MODELS: readonly LocalGuiModel[] = [
  model("codex", "gpt-5.4", "GPT-5.4"),
  model("codex", "gpt-5-codex", "GPT-5 Codex"),
];

const LEGACY_GUI_MODELS: readonly LocalGuiModel[] = [
  model("claude", "claude-sonnet-4", "Claude Sonnet 4"),
  model("claude", "claude-opus-4", "Claude Opus 4"),
  model("codex", "gpt-5-codex", "GPT-5 Codex"),
];

export function isLocalGuiHarnessId(
  harnessId: string,
): harnessId is LocalGuiHarnessId {
  return harnessId === "claude" || harnessId === "codex";
}

export function localGuiModelsFor(
  harnessId: LocalGuiHarnessId,
): readonly LocalGuiModel[] {
  if (harnessId === "claude") {
    return CLAUDE_MODELS;
  }
  return readInstalledCodexModels() ?? CODEX_MODELS;
}

export function localGuiModelFor(
  harnessId: LocalGuiHarnessId,
  slug: string,
): LocalGuiModel | undefined {
  return (
    localGuiModelsFor(harnessId).find((candidate) => candidate.slug === slug) ??
    LEGACY_GUI_MODELS.find(
      (candidate) =>
        candidate.harnessId === harnessId && candidate.slug === slug,
    )
  );
}

export function localHarnessModelSummariesFor(
  harnessId: AgentFacingHarnessId,
): HarnessModelSummary[] {
  if (!isLocalGuiHarnessId(harnessId)) {
    return [];
  }
  return localGuiModelsFor(harnessId).map((model) => ({
    id: model.slug,
    reasoningEfforts: model.supportedReasoningEfforts.map(
      (effort) => effort.id,
    ),
    fastModeAvailable: model.supportedServiceTiers.some(
      (tier) => tier.id === "fast" || tier.id === "priority",
    ),
  }));
}

function model(
  harnessId: LocalGuiHarnessId,
  slug: string,
  label: string,
): LocalGuiModel {
  return {
    harnessId,
    slug,
    label,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    metadata: {},
  };
}

function readInstalledCodexModels(): readonly LocalGuiModel[] | null {
  const configuredHome = process.env.CODEX_HOME?.trim();
  if (
    process.env.NODE_ENV === "test" &&
    (configuredHome === undefined || configuredHome.length === 0)
  ) {
    return null;
  }
  const codexHome =
    configuredHome === undefined || configuredHome.length === 0
      ? join(homedir(), ".codex")
      : configuredHome;
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(codexHome, "models_cache.json"), "utf8"),
    );
    if (!isRecord(parsed) || !Array.isArray(parsed.models)) {
      return null;
    }
    const models = parsed.models.flatMap((candidate) => {
      const parsedModel = parseCodexModel(candidate);
      return parsedModel === null ? [] : [parsedModel];
    });
    return models.length === 0 ? null : models;
  } catch {
    return null;
  }
}

function parseCodexModel(value: unknown): LocalGuiModel | null {
  if (!isRecord(value) || value.visibility !== "list") {
    return null;
  }
  const slug = nonEmptyString(value.slug);
  const label = nonEmptyString(value.display_name);
  if (slug === null || label === null) {
    return null;
  }
  return {
    harnessId: "codex",
    slug,
    label,
    description: nullableString(value.description),
    contextWindow: nullableNumber(value.context_window),
    maxOutputTokens: nullableNumber(value.max_output_tokens),
    defaultReasoningEffort: nullableString(value.default_reasoning_level),
    supportedReasoningEfforts: parseReasoningEfforts(
      value.supported_reasoning_levels,
    ),
    defaultServiceTier: nullableString(value.default_service_tier),
    supportedServiceTiers: parseServiceTiers(value.service_tiers),
    metadata: {},
  };
}

function parseReasoningEfforts(
  value: unknown,
): LocalGuiModel["supportedReasoningEfforts"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) {
      return [];
    }
    const id = nonEmptyString(candidate.effort);
    if (id === null) {
      return [];
    }
    return [
      {
        id,
        label: reasoningEffortLabel(id),
        description: nullableString(candidate.description),
      },
    ];
  });
}

function parseServiceTiers(
  value: unknown,
): LocalGuiModel["supportedServiceTiers"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) {
      return [];
    }
    const id = nonEmptyString(candidate.id);
    const label = nonEmptyString(candidate.name);
    if (id === null || label === null) {
      return [];
    }
    return [
      {
        id,
        label,
        description: nullableString(candidate.description),
      },
    ];
  });
}

function reasoningEffortLabel(effort: string): string {
  switch (effort) {
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra high";
    case "max":
      return "Max";
    case "ultra":
      return "Ultra";
    default:
      return effort;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
