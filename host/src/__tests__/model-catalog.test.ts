import { describe, expect, it } from "vitest";
import {
  parseCodexModelsResult,
  parseGrokModelsOutput,
  parseOpencodeModelsOutput,
} from "../gui/model-catalog";

describe("model catalog parsers", () => {
  it("maps a Codex model/list row into a GUI option", () => {
    const models = parseCodexModelsResult({
      data: [
        {
          id: "gpt-6-astra",
          model: "gpt-6-astra",
          displayName: "GPT-6-Astra",
          description: "Our most capable model for complex, demanding work.",
          hidden: false,
          defaultReasoningEffort: "medium",
          inputModalities: ["text", "image"],
          additionalSpeedTiers: ["fast"],
          serviceTiers: [
            {
              id: "priority",
              name: "Fast",
              description: "2x speed, increased usage",
            },
          ],
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Fast" },
            { reasoningEffort: "medium", description: "Balanced" },
          ],
        },
        { id: "hidden-model", hidden: true },
      ],
      nextCursor: null,
    });
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      harnessId: "codex",
      slug: "gpt-6-astra",
      label: "GPT-6-Astra",
      defaultReasoningEffort: "medium",
      metadata: { resolvedModel: "gpt-6-astra" },
      supportedServiceTiers: [
        {
          id: "priority",
          label: "Fast",
          description: "2x speed, increased usage",
        },
      ],
    });
    expect(models[0]?.supportedReasoningEfforts.map((row) => row.id)).toEqual([
      "low",
      "medium",
    ]);
  });

  it("parses grok models CLI output with the default first", () => {
    const models = parseGrokModelsOutput(
      [
        "You are logged in with grok.com.",
        "",
        "Default model: grok-4.6",
        "",
        "Available models:",
        "  * grok-4.6 (default)",
        "  - grok-4.5",
        "",
      ].join("\n"),
    );
    expect(models.map((row) => row.slug)).toEqual(["grok-4.6", "grok-4.5"]);
    expect(models[0]?.label).toBe("Grok 4.6");
  });

  it("parses opencode models lines", () => {
    const models = parseOpencodeModelsOutput(
      "opencode/big-pickle\nopencode/nemotron-3-ultra-free\n\n",
    );
    expect(models.map((row) => row.slug)).toEqual([
      "opencode/big-pickle",
      "opencode/nemotron-3-ultra-free",
    ]);
    expect(models[0]?.label).toBe("big-pickle");
  });
});
