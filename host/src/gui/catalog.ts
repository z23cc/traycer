import {
  guiHarnessIdSchema,
  tuiHarnessIdSchema,
  type GuiHarnessId,
} from "@traycer/protocol/host/agent/shared";
import type {
  GuiAgentCommandOption,
  GuiAgentModelOption,
  GuiHarnessOption,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import { ALL_PERMISSION_MODES } from "@traycer/protocol/persistence/epic/foundation";
import { PROVIDER_DISPLAY_NAMES } from "@traycer/protocol/host/provider-schemas";
import { providerCliIdentity } from "../providers/service";
import type { HostRuntime } from "../runtime";
import { providerIdForHarness } from "./harness-map";
import { modelsForHarness, summariesForModels } from "./model-catalog";

const TUI_IDS = new Set<string>(tuiHarnessIdSchema.options);

export function listGuiHarnesses(runtime: HostRuntime): GuiHarnessOption[] {
  const harnesses: GuiHarnessOption[] = [];
  for (const harnessId of guiHarnessIdSchema.options) {
    const providerId = providerIdForHarness(harnessId);
    const identity = providerCliIdentity(runtime.store, providerId);
    const tui = TUI_IDS.has(harnessId) && harnessId !== "cursor";
    const available = identity.path !== null;
    harnesses.push({
      id: harnessId,
      label: PROVIDER_DISPLAY_NAMES[providerId],
      enabled: identity.enabled,
      available,
      error: available ? null : "CLI not found on PATH",
      modes: tui ? ["gui", "tui"] : ["gui"],
      requiresApiKey: false,
      supportedPermissionModes:
        harnessId === "cursor" ? ["full_access"] : [...ALL_PERMISSION_MODES],
      availabilityPending: false,
      authStatus: "unknown",
    });
  }
  return harnesses;
}

export async function listGuiModels(
  runtime: HostRuntime,
  harnessId: GuiHarnessId,
): Promise<{
  readonly harnessId: GuiHarnessId;
  readonly models: readonly GuiAgentModelOption[];
}> {
  return {
    harnessId,
    models: await modelsForHarness(runtime, harnessId),
  };
}

export function listGuiCommands(harnessId: GuiHarnessId): {
  readonly harnessId: GuiHarnessId;
  readonly commands: GuiAgentCommandOption[];
} {
  return {
    harnessId,
    commands: [
      {
        harnessId,
        name: "compact",
        description: "Compact the conversation to free up context",
        argumentHint: null,
        kind: "slash-command",
        metadata: { providerKind: "compaction" },
      },
      // The released host's catalog entry, verbatim: `/plan <prompt>` runs
      // the turn in Claude's plan mode, and the plan comes back as a card.
      ...(harnessId === "claude"
        ? [
            {
              harnessId,
              name: "plan",
              description: "Run the prompt in Claude Code plan mode",
              argumentHint: "<prompt>",
              kind: "slash-command" as const,
              metadata: {
                catalogSource: "providerMode",
                providerKind: "permission-mode",
                permissionMode: "plan",
              },
            },
          ]
        : []),
    ],
  };
}

export async function listHarnessModels(
  runtime: HostRuntime,
  harnessId: string,
): Promise<{
  readonly harnessId: string;
  readonly models: readonly {
    readonly id: string;
    readonly reasoningEfforts: readonly string[];
    readonly fastModeAvailable: boolean;
  }[];
}> {
  const parsed = guiHarnessIdSchema.safeParse(harnessId);
  if (!parsed.success) {
    return { harnessId, models: [] };
  }
  const models = await modelsForHarness(runtime, parsed.data);
  return summariesForModels(harnessId, models);
}
