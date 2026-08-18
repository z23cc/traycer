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
  model("claude", "claude-sonnet-4", "Claude Sonnet 4"),
  model("claude", "claude-opus-4", "Claude Opus 4"),
];

const CODEX_MODELS: readonly LocalGuiModel[] = [
  model("codex", "gpt-5.4", "GPT-5.4"),
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
  return harnessId === "claude" ? CLAUDE_MODELS : CODEX_MODELS;
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
