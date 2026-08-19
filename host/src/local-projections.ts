import * as Y from "yjs";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import type {
  GetGuiAgentPlanRequest,
  GetGuiAgentPlanResponse,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import {
  epicArtifactMentionId,
  epicArtifactMentionToken,
  type EpicMentionArtifactSuggestion,
  type EpicMentionArtifactsRequest,
  type EpicMentionEpicsRequest,
  type EpicMentionEpicsResponse,
  type EpicMentionReviewsResponse,
  type EpicMentionSpecsResponse,
  type EpicMentionStoriesResponse,
  type EpicMentionTicketsResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import { isSubsequence } from "@traycer/protocol/utils/text/fuzzy";
import { type HostState, projectStoredEpicLight, StoreError } from "./store";

type Ranked<T> = {
  readonly value: T;
  readonly score: number;
  readonly updatedAt: number;
  readonly stableKey: string;
};

type ArtifactCandidate = {
  readonly suggestion: EpicMentionArtifactSuggestion;
  readonly updatedAt: number;
};

const UNTITLED_TASK = "Untitled task";
const UNTITLED_ARTIFACT: Readonly<Record<EpicArtifactKind, string>> = {
  spec: "Untitled spec",
  ticket: "Untitled ticket",
  story: "Untitled story",
  review: "Untitled review",
};

/**
 * Resolves the newest durable occurrence of a plan in one local chat.
 *
 * The local host currently has no plan-blob repository. A plan without a
 * content reference is therefore complete in `markdownPreview`; a referenced
 * plan returns that preview with the protocol's honest `blob_missing` marker.
 */
export function resolveAgentGuiGetPlan(
  state: HostState,
  request: GetGuiAgentPlanRequest,
): GetGuiAgentPlanResponse {
  const epic = state.getEpic(request.epicId);
  if (epic === null) {
    throw new StoreError(
      "E_INVALID_ARGUMENT",
      `Unknown epic ${request.epicId}`,
    );
  }
  const chat = epic.chats.get(request.chatId);
  if (chat === undefined) {
    throw new StoreError(
      "E_INVALID_ARGUMENT",
      `Unknown chat ${request.chatId} in epic ${request.epicId}`,
    );
  }
  for (const message of chat.messages.toReversed()) {
    if (message.role !== "assistant") continue;
    for (const block of message.blocks.toReversed()) {
      if (block.type !== "plan" || block.planId !== request.planId) continue;
      return {
        planId: block.planId,
        markdown: block.markdownPreview,
        source: block.source,
        planStatus: block.planStatus,
        contentHash: block.fullContentRef?.hash ?? null,
        unavailableReason:
          block.fullContentRef === null ? null : "blob_missing",
      };
    }
  }
  throw new StoreError(
    "E_INVALID_ARGUMENT",
    `Unknown plan ${request.planId} in chat ${request.chatId}`,
  );
}

export function resolveEpicMentionEpics(
  state: HostState,
  request: EpicMentionEpicsRequest,
): EpicMentionEpicsResponse {
  const query = normalizeQuery(request.query);
  const byId = new Map<string, EpicMentionEpicsResponse["entries"][number]>();
  for (const stored of state.epics.values()) {
    const epic = projectStoredEpicLight(stored);
    const label = taskLabel(epic.title, epic.initialUserPrompt);
    const suggestion: EpicMentionEpicsResponse["entries"][number] = {
      kind: "epic",
      id: `epic:${epic.id}`,
      token: `epic:${epic.id}`,
      epicId: epic.id,
      label,
      description: artifactCountDescription(epic),
      status: epic.status,
      updatedAt: finiteNumber(epic.updatedAt, 0),
    };
    const existing = byId.get(suggestion.id);
    if (
      existing === undefined ||
      compareMentionFreshness(suggestion, existing) < 0
    ) {
      byId.set(suggestion.id, suggestion);
    }
  }
  const ranked = [...byId.values()].flatMap((entry) => {
    const score = mentionScore(query, [entry.label], [entry.id]);
    return score === null
      ? []
      : [
          {
            value: entry,
            score,
            updatedAt: entry.updatedAt,
            stableKey: entry.id,
          },
        ];
  });
  return { entries: rankAndLimit(ranked, request.limit) };
}

export function resolveEpicMentionSpecs(
  state: HostState,
  request: EpicMentionArtifactsRequest,
): EpicMentionSpecsResponse {
  return {
    entries: resolveEpicArtifactMentions(state, request, "spec").flatMap(
      (entry) => (entry.artifactType === "spec" ? [entry] : []),
    ),
  };
}

export function resolveEpicMentionTickets(
  state: HostState,
  request: EpicMentionArtifactsRequest,
): EpicMentionTicketsResponse {
  return {
    entries: resolveEpicArtifactMentions(state, request, "ticket").flatMap(
      (entry) => (entry.artifactType === "ticket" ? [entry] : []),
    ),
  };
}

export function resolveEpicMentionStories(
  state: HostState,
  request: EpicMentionArtifactsRequest,
): EpicMentionStoriesResponse {
  return {
    entries: resolveEpicArtifactMentions(state, request, "story").flatMap(
      (entry) => (entry.artifactType === "story" ? [entry] : []),
    ),
  };
}

export function resolveEpicMentionReviews(
  state: HostState,
  request: EpicMentionArtifactsRequest,
): EpicMentionReviewsResponse {
  return {
    entries: resolveEpicArtifactMentions(state, request, "review").flatMap(
      (entry) => (entry.artifactType === "review" ? [entry] : []),
    ),
  };
}

function resolveEpicArtifactMentions(
  state: HostState,
  request: EpicMentionArtifactsRequest,
  kind: EpicArtifactKind,
): EpicMentionArtifactSuggestion[] {
  const query = normalizeQuery(request.query);
  const byId = new Map<string, ArtifactCandidate>();
  for (const stored of state.epics.values()) {
    const epic = projectStoredEpicLight(stored);
    const epicTitle = taskLabel(epic.title, epic.initialUserPrompt);
    const artifacts = stored.doc.getMap<unknown>("epic").get("artifacts");
    if (!(artifacts instanceof Y.Map)) continue;
    for (const [mapKey, value] of artifacts) {
      if (!(value instanceof Y.Map) || artifactKind(value) !== kind) continue;
      const storedId = value.get("id");
      const artifactId =
        typeof storedId === "string" && storedId.length > 0 ? storedId : mapKey;
      const title = value.get("title");
      const label =
        typeof title === "string" && title.length > 0
          ? title
          : UNTITLED_ARTIFACT[kind];
      const updatedAtValue = value.get("updatedAt");
      const updatedAt =
        typeof updatedAtValue === "number" && Number.isFinite(updatedAtValue)
          ? updatedAtValue
          : 0;
      const suggestion = artifactSuggestion({
        kind,
        epicId: epic.id,
        epicTitle,
        artifactId,
        label,
        status: artifactStatus(value),
        updatedAt:
          typeof updatedAtValue === "number" && Number.isFinite(updatedAtValue)
            ? updatedAt
            : undefined,
      });
      const existing = byId.get(suggestion.id);
      const candidate = { suggestion, updatedAt };
      if (
        existing === undefined ||
        compareArtifactCandidate(candidate, existing) < 0
      ) {
        byId.set(suggestion.id, candidate);
      }
    }
  }
  const ranked = [...byId.values()].flatMap((candidate) => {
    const entry = candidate.suggestion;
    const score = mentionScore(
      query,
      [entry.label, entry.epicTitle],
      [entry.id, entry.token],
    );
    return score === null
      ? []
      : [
          {
            value: entry,
            score,
            updatedAt: candidate.updatedAt,
            stableKey: entry.id,
          },
        ];
  });
  return rankAndLimit(ranked, request.limit);
}

function artifactSuggestion(args: {
  readonly kind: EpicArtifactKind;
  readonly epicId: string;
  readonly epicTitle: string;
  readonly artifactId: string;
  readonly label: string;
  readonly status: number | null;
  readonly updatedAt: number | undefined;
}): EpicMentionArtifactSuggestion {
  const common = {
    kind: "epic-artifact" as const,
    id: epicArtifactMentionId(args.kind, args.epicId, args.artifactId),
    token: epicArtifactMentionToken(args.kind, args.epicId, args.artifactId),
    epicId: args.epicId,
    epicTitle: args.epicTitle,
    artifactId: args.artifactId,
    label: args.label,
    description: args.epicTitle,
    status: args.status,
    updatedAt: args.updatedAt,
  };
  switch (args.kind) {
    case "spec":
      return { ...common, artifactType: "spec" };
    case "ticket":
      return { ...common, artifactType: "ticket" };
    case "story":
      return { ...common, artifactType: "story" };
    case "review":
      return { ...common, artifactType: "review" };
  }
}

function artifactKind(entry: Y.Map<unknown>): EpicArtifactKind | null {
  const value = entry.get("kind") ?? entry.get("type");
  return value === "spec" ||
    value === "ticket" ||
    value === "story" ||
    value === "review"
    ? value
    : null;
}

function artifactStatus(entry: Y.Map<unknown>): number | null {
  const value = entry.get("status");
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

function mentionScore(
  query: string,
  labels: readonly string[],
  identities: readonly string[],
): number | null {
  if (query.length === 0) return 0;
  const normalizedLabels = labels.map((value) => value.toLowerCase());
  const normalizedIdentities = identities.map((value) => value.toLowerCase());
  if (
    normalizedLabels.some((value) => value === query) ||
    normalizedIdentities.some((value) => value === query)
  ) {
    return 0;
  }
  if (normalizedLabels.some((value) => value.startsWith(query))) return 100;
  if (normalizedLabels.some((value) => value.includes(query))) return 200;
  if (normalizedIdentities.some((value) => value.includes(query))) return 300;
  const subsequenceLabel = normalizedLabels.find((value) =>
    isSubsequence(query, value),
  );
  if (subsequenceLabel !== undefined) return 400 + subsequenceLabel.length;
  const subsequenceIdentity = normalizedIdentities.find((value) =>
    isSubsequence(query, value),
  );
  return subsequenceIdentity === undefined
    ? null
    : 500 + subsequenceIdentity.length;
}

function rankAndLimit<T>(ranked: Ranked<T>[], limit: number): T[] {
  return ranked
    .toSorted((left, right) => {
      if (left.score !== right.score) return left.score - right.score;
      if (left.updatedAt !== right.updatedAt) {
        return right.updatedAt - left.updatedAt;
      }
      return compareText(left.stableKey, right.stableKey);
    })
    .slice(0, limit)
    .map((entry) => entry.value);
}

function compareMentionFreshness(
  left: EpicMentionEpicsResponse["entries"][number],
  right: EpicMentionEpicsResponse["entries"][number],
): number {
  if (left.updatedAt !== right.updatedAt)
    return right.updatedAt - left.updatedAt;
  return compareText(left.label, right.label);
}

function compareArtifactCandidate(
  left: ArtifactCandidate,
  right: ArtifactCandidate,
): number {
  if (left.updatedAt !== right.updatedAt)
    return right.updatedAt - left.updatedAt;
  return compareText(left.suggestion.label, right.suggestion.label);
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function taskLabel(title: string, initialUserPrompt: string): string {
  if (title.length > 0) return title;
  const prompt = initialUserPrompt.replaceAll(/\s+/g, " ").trim();
  if (prompt.length === 0) return UNTITLED_TASK;
  return prompt.length <= 72 ? prompt : `${prompt.slice(0, 69)}...`;
}

function artifactCountDescription(args: {
  readonly specCount: number;
  readonly ticketCount: number;
  readonly storyCount: number;
  readonly reviewCount: number;
}): string {
  return [
    countLabel(args.specCount, "spec", "specs"),
    countLabel(args.ticketCount, "ticket", "tickets"),
    countLabel(args.storyCount, "story", "stories"),
    countLabel(args.reviewCount, "review", "reviews"),
  ]
    .filter((value) => value.length > 0)
    .join(", ");
}

function countLabel(count: number, singular: string, plural: string): string {
  if (!Number.isFinite(count) || count <= 0) return "";
  return `${count} ${count === 1 ? singular : plural}`;
}

function finiteNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}
