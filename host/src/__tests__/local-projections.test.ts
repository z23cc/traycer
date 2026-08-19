import * as Y from "yjs";
import { afterEach, describe, expect, it } from "vitest";
import { getGuiAgentPlanResponseSchema } from "@traycer/protocol/host/agent/gui/unary-schemas";
import {
  createEpicRequestSchema,
  epicMentionEpicsResponseSchema,
  epicMentionReviewsResponseSchema,
  epicMentionSpecsResponseSchema,
  epicMentionStoriesResponseSchema,
  epicMentionTicketsResponseSchema,
} from "@traycer/protocol/host/epic/unary-schemas";
import { messageSchema } from "@traycer/protocol/persistence/epic/schemas";
import {
  resolveAgentGuiGetPlan,
  resolveEpicMentionEpics,
  resolveEpicMentionReviews,
  resolveEpicMentionSpecs,
  resolveEpicMentionStories,
  resolveEpicMentionTickets,
} from "../local-projections";
import { HostState, StoreError } from "../store";

describe("local released projections", () => {
  const states: HostState[] = [];

  afterEach(() => {
    while (states.length > 0) states.pop()?.dispose();
  });

  it("returns schema-valid empty mention results when no local data exists", () => {
    const state = trackedState(states);
    const request = { query: "anything", limit: 25 };

    expect(
      epicMentionEpicsResponseSchema.parse(
        resolveEpicMentionEpics(state, request),
      ),
    ).toEqual({ entries: [] });
    expect(
      epicMentionSpecsResponseSchema.parse(
        resolveEpicMentionSpecs(state, request),
      ),
    ).toEqual({ entries: [] });
    expect(
      epicMentionTicketsResponseSchema.parse(
        resolveEpicMentionTickets(state, request),
      ),
    ).toEqual({ entries: [] });
    expect(
      epicMentionStoriesResponseSchema.parse(
        resolveEpicMentionStories(state, request),
      ),
    ).toEqual({ entries: [] });
    expect(
      epicMentionReviewsResponseSchema.parse(
        resolveEpicMentionReviews(state, request),
      ),
    ).toEqual({ entries: [] });
  });

  it("filters, ranks, limits, and de-duplicates local epic rows deterministically", () => {
    const state = trackedState(states);
    seedEpic(state, "alpha", "Alpha", "", 10);
    seedEpic(state, "alpha-beta", "Alpha Beta", "", 30);
    seedEpic(state, "other", "Other", "", 50);
    const alpha = state.getEpic("alpha");
    if (alpha === null) throw new Error("Missing alpha fixture");
    seedArtifact(alpha.doc, {
      mapKey: "spec-1",
      id: "spec-1",
      kind: "spec",
      title: "Plan",
      updatedAt: 11,
      status: null,
    });
    state.epics.set("duplicate-map-key", alpha);

    const exactFirst = epicMentionEpicsResponseSchema.parse(
      resolveEpicMentionEpics(state, { query: " alpha ", limit: 10 }),
    );
    expect(exactFirst.entries.map((entry) => entry.epicId)).toEqual([
      "alpha",
      "alpha-beta",
    ]);
    expect(exactFirst.entries[0]).toMatchObject({
      id: "epic:alpha",
      token: "epic:alpha",
      description: "1 spec",
    });

    expect(
      resolveEpicMentionEpics(state, { query: "", limit: 2 }).entries.map(
        (entry) => entry.epicId,
      ),
    ).toEqual(["other", "alpha-beta"]);
    state.epics.delete("duplicate-map-key");
  });

  it("projects every local artifact kind with stable filtering, ordering, and de-duplication", () => {
    const state = trackedState(states);
    const first = seedEpic(state, "epic-a", "Payments", "", 10);
    const second = seedEpic(state, "epic-b", "Identity", "", 20);
    seedArtifact(first.doc, {
      mapKey: "spec-auth-old",
      id: "spec-auth",
      kind: "spec",
      title: "Old duplicate",
      updatedAt: 1,
      status: null,
    });
    seedArtifact(first.doc, {
      mapKey: "spec-auth-new",
      id: "spec-auth",
      kind: "spec",
      title: "Auth",
      updatedAt: 5,
      status: null,
    });
    seedArtifact(second.doc, {
      mapKey: "spec-authentication",
      id: "spec-authentication",
      kind: "spec",
      title: "Authentication",
      updatedAt: 100,
      status: null,
    });
    seedArtifact(first.doc, {
      mapKey: "ticket-1",
      id: "ticket-1",
      kind: "ticket",
      title: "Checkout bug",
      updatedAt: 40,
      status: 2,
    });
    seedArtifact(first.doc, {
      mapKey: "story-1",
      id: "story-1",
      kind: "story",
      title: "Buyer journey",
      updatedAt: 30,
      status: 1,
    });
    seedArtifact(first.doc, {
      mapKey: "review-1",
      id: "review-1",
      kind: "review",
      title: "Risk review",
      updatedAt: 20,
      status: null,
    });

    const specs = epicMentionSpecsResponseSchema.parse(
      resolveEpicMentionSpecs(state, { query: "auth", limit: 10 }),
    );
    expect(specs.entries.map((entry) => entry.label)).toEqual([
      "Auth",
      "Authentication",
    ]);
    expect(specs.entries[0]).toEqual({
      kind: "epic-artifact",
      id: "spec:epic-a:spec-auth",
      token: "spec:epic-a/spec-auth",
      epicId: "epic-a",
      epicTitle: "Payments",
      artifactId: "spec-auth",
      artifactType: "spec",
      label: "Auth",
      description: "Payments",
      status: null,
      updatedAt: 5,
    });
    expect(
      epicMentionTicketsResponseSchema.parse(
        resolveEpicMentionTickets(state, { query: "checkout", limit: 1 }),
      ).entries,
    ).toHaveLength(1);
    expect(
      epicMentionStoriesResponseSchema.parse(
        resolveEpicMentionStories(state, { query: "buyer", limit: 1 }),
      ).entries,
    ).toHaveLength(1);
    expect(
      epicMentionReviewsResponseSchema.parse(
        resolveEpicMentionReviews(state, { query: "risk", limit: 1 }),
      ).entries,
    ).toHaveLength(1);
    expect(
      resolveEpicMentionReviews(state, { query: "not-present", limit: 10 }),
    ).toEqual({ entries: [] });
  });

  it("returns the newest durable plan and reports unavailable referenced content honestly", () => {
    const state = trackedState(states);
    seedEpic(state, "epic-1", "Plan task", "", 10);
    state.createChat({
      epicId: "epic-1",
      chatId: "chat-1",
      parentId: null,
      hostId: "host-local",
      title: "Planner",
      settings: null,
      initialMessage: null,
    });
    const chat = state.getChat("epic-1", "chat-1");
    if (chat === null) throw new Error("Missing plan chat fixture");
    chat.messages = [
      planMessage("message-old", "plan-1", "Old plan", null, 1),
      planMessage("message-complete", "plan-complete", "Full plan", null, 2),
      planMessage("message-new", "plan-1", "New preview", "hash-1", 3),
    ];

    expect(
      getGuiAgentPlanResponseSchema.parse(
        resolveAgentGuiGetPlan(state, {
          epicId: "epic-1",
          chatId: "chat-1",
          planId: "plan-1",
        }),
      ),
    ).toEqual({
      planId: "plan-1",
      markdown: "New preview",
      source: {
        harnessId: "codex",
        sessionId: "session-1",
        turnId: "turn-1",
        kind: "provider-plan",
      },
      planStatus: "ready",
      contentHash: "hash-1",
      unavailableReason: "blob_missing",
    });
    expect(
      resolveAgentGuiGetPlan(state, {
        epicId: "epic-1",
        chatId: "chat-1",
        planId: "plan-complete",
      }),
    ).toMatchObject({
      markdown: "Full plan",
      contentHash: null,
      unavailableReason: null,
    });
  });

  it("rejects unknown plan scopes instead of inventing a response row", () => {
    const state = trackedState(states);
    seedEpic(state, "epic-1", "Plan task", "", 10);

    expect(() =>
      resolveAgentGuiGetPlan(state, {
        epicId: "unknown",
        chatId: "chat-1",
        planId: "plan-1",
      }),
    ).toThrowError(StoreError);
    expect(() =>
      resolveAgentGuiGetPlan(state, {
        epicId: "epic-1",
        chatId: "unknown",
        planId: "plan-1",
      }),
    ).toThrow("Unknown chat unknown");
  });
});

function trackedState(states: HostState[]): HostState {
  const state = new HostState("host-local", undefined, undefined);
  states.push(state);
  return state;
}

function seedEpic(
  state: HostState,
  id: string,
  title: string,
  initialUserPrompt: string,
  updatedAt: number,
) {
  state.createEpic(
    createEpicRequestSchema.parse({
      epic: {
        id,
        title,
        initialUserPrompt,
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "active",
        createdAt: 1,
        updatedAt,
        createdBy: "local-user",
        version: "1.0.0",
      },
      repoIdentifiers: [],
      workspaces: [],
      chat: null,
    }),
  );
  const epic = state.getEpic(id);
  if (epic === null) throw new Error(`Missing seeded epic ${id}`);
  epic.doc.getMap<unknown>("epic").set("updatedAt", updatedAt);
  return epic;
}

function seedArtifact(
  doc: Y.Doc,
  args: {
    readonly mapKey: string;
    readonly id: string;
    readonly kind: "spec" | "ticket" | "story" | "review";
    readonly title: string;
    readonly updatedAt: number;
    readonly status: number | null;
  },
): void {
  const artifacts = doc.getMap<unknown>("epic").get("artifacts");
  if (!(artifacts instanceof Y.Map)) {
    throw new Error("Missing artifact collection");
  }
  const entry = new Y.Map<unknown>();
  entry.set("id", args.id);
  entry.set("kind", args.kind);
  entry.set("title", args.title);
  entry.set("updatedAt", args.updatedAt);
  if (args.status !== null) entry.set("status", args.status);
  artifacts.set(args.mapKey, entry);
}

function planMessage(
  messageId: string,
  planId: string,
  markdownPreview: string,
  contentHash: string | null,
  timestamp: number,
) {
  return messageSchema.parse({
    role: "assistant",
    messageId,
    sender: {
      type: "agent",
      harnessId: "codex",
      agentId: "codex",
      displayName: "Codex",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: [
      {
        type: "plan",
        blockId: `block-${messageId}`,
        status: "completed",
        timestamp,
        planStatus: "ready",
        planId,
        harnessId: "codex",
        source: {
          harnessId: "codex",
          sessionId: "session-1",
          turnId: "turn-1",
          kind: "provider-plan",
        },
        title: null,
        summary: null,
        markdownPreview,
        fullContentRef:
          contentHash === null
            ? null
            : { kind: "plan_content", hash: contentHash },
        steps: [],
        actions: [],
        approvalId: null,
        supersededByPlanId: null,
        metadata: null,
      },
    ],
    startedAt: timestamp,
    timestamp,
    turnId: "turn-1",
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    imageResolutions: [],
  });
}
