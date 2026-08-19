import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  generateTuiAgentTitleRequestSchema,
  recordTuiAgentActivityRequestSchemaV11,
  tuiAgentTurnEndedRequestSchema,
} from "@traycer/protocol/host/agent/tui/unary-schemas";
import {
  createTuiAgentRequestSchema,
  type CreateTuiAgentRequest,
} from "@traycer/protocol/host/epic/unary-schemas";
import { tuiAgentSchema } from "@traycer/protocol/persistence/epic/tui-agents";
import {
  TuiAgentService,
  TuiAgentServiceError,
  ensureTuiAgentsMap,
} from "../tui-agent-service";

const EPIC_ID = "epic-1";
const HOST_ID = "host-local";
const USER_ID = "user-local";

describe("TuiAgentService", () => {
  it("creates a schema-valid Y.Map record and preserves launch identity on reload", () => {
    const doc = epicDoc();
    const service = testService({});
    const response = service.create(
      doc,
      createRequest({
        tuiAgentId: "agent-1",
        harnessId: "claude",
        harnessSessionId: "session-1",
        workspaceFolders: ["/repo/a", "/repo/b"],
        workspaceMode: "folderless",
        terminalAgentArgs: "--verbose",
        terminalShellCommand: "/bin/claude",
        terminalShellArgs: ["--resume", "session-1"],
        model: "claude-sonnet",
        reasoningEffort: "high",
        profileId: "profile-1",
        forkSourceHarnessSessionId: "source-session",
      }),
    );

    expect(response).toEqual({ tuiAgentId: "agent-1" });
    const reloaded = cloneDoc(doc);
    const record = tuiAgentSchema.parse(recordJson(reloaded, "agent-1"));
    expect(record).toMatchObject({
      id: "agent-1",
      parentId: "parent-1",
      title: "",
      isTitleEditedByUser: false,
      hostId: HOST_ID,
      userId: USER_ID,
      harnessId: "claude",
      harnessSessionId: "session-1",
      workspaceFolders: ["/repo/a", "/repo/b"],
      workspaceMode: "folderless",
      terminalAgentArgs: "--verbose",
      terminalShellCommand: "/bin/claude",
      terminalShellArgs: ["--resume", "session-1"],
      model: "claude-sonnet",
      reasoningEffort: "high",
      profileId: "profile-1",
      pendingForkSourceHarnessSessionId: "source-session",
      archivedAt: null,
    });
  });

  it("self-heals a missing or legacy tuiAgents root and rejects duplicate ids", () => {
    const doc = epicDoc();
    doc.getMap<unknown>("epic").set("tuiAgents", "legacy-value");
    const service = testService({});
    service.create(doc, createRequest({ tuiAgentId: "agent-1" }));
    expect(ensureTuiAgentsMap(doc)).toBeInstanceOf(Y.Map);

    expectServiceError(
      () => service.create(doc, createRequest({ tuiAgentId: "agent-1" })),
      "E_INVALID_ARGUMENT",
    );

    const chats = new Y.Map<unknown>();
    chats.set("chat-collision", new Y.Map());
    doc.getMap<unknown>("epic").set("chats", chats);
    expectServiceError(
      () =>
        service.create(doc, createRequest({ tuiAgentId: "chat-collision" })),
      "E_INVALID_ARGUMENT",
    );
  });

  it("renames and deletes a reloaded record", () => {
    const initial = epicDoc();
    testService({}).create(initial, createRequest({ tuiAgentId: "agent-1" }));
    const doc = cloneDoc(initial);
    const service = testService({ now: () => 200 });

    expect(
      service.rename(doc, {
        epicId: EPIC_ID,
        tuiAgentId: "agent-1",
        title: "User title",
      }),
    ).toEqual({ updated: true });
    expect(recordJson(doc, "agent-1")).toMatchObject({
      title: "User title",
      isTitleEditedByUser: true,
      updatedAt: 200,
    });
    expect(
      service.delete(doc, { epicId: EPIC_ID, tuiAgentId: "agent-1" }),
    ).toEqual({ deleted: true });
    expect(
      service.delete(doc, { epicId: EPIC_ID, tuiAgentId: "agent-1" }),
    ).toEqual({ deleted: false });
  });

  it("generates a title only while the record is untitled and not user-edited", async () => {
    const doc = epicDoc();
    const generateTitle = vi.fn(async () => "  Generated\n title  ");
    const service = testService({ generateTitle });
    service.create(doc, createRequest({ tuiAgentId: "agent-1" }));
    const request = generateTuiAgentTitleRequestSchema.parse({
      epicId: EPIC_ID,
      tuiAgentId: "agent-1",
      harnessSessionId: null,
      harnessId: "claude",
      promptText: "Explain the repository",
    });

    await expect(service.generateTitle(doc, request)).resolves.toEqual({
      accepted: true,
    });
    expect(recordJson(doc, "agent-1")).toMatchObject({
      title: "Generated title",
      isTitleEditedByUser: false,
    });
    await expect(service.generateTitle(doc, request)).resolves.toEqual({
      accepted: false,
    });
    expect(generateTitle).toHaveBeenCalledTimes(1);

    service.create(
      doc,
      createRequest({ tuiAgentId: "named", title: "Chosen by user" }),
    );
    await expect(
      service.generateTitle(doc, { ...request, tuiAgentId: "named" }),
    ).resolves.toEqual({ accepted: false });
  });

  it("does not overwrite a manual rename that lands during title generation", async () => {
    let resolveGenerated: ((value: string) => void) | undefined;
    const generated = new Promise<string>((resolve) => {
      resolveGenerated = resolve;
    });
    const doc = epicDoc();
    const service = testService({ generateTitle: () => generated });
    service.create(doc, createRequest({ tuiAgentId: "agent-1" }));
    const pending = service.generateTitle(
      doc,
      generateTuiAgentTitleRequestSchema.parse({
        epicId: EPIC_ID,
        tuiAgentId: "agent-1",
        harnessId: "claude",
        promptText: "First prompt",
      }),
    );
    service.rename(doc, {
      epicId: EPIC_ID,
      tuiAgentId: "agent-1",
      title: "Manual title",
    });
    resolveGenerated?.("Late generated title");

    await expect(pending).resolves.toEqual({ accepted: false });
    expect(recordJson(doc, "agent-1")).toMatchObject({
      title: "Manual title",
      isTitleEditedByUser: true,
    });
  });

  it("tracks activity, resyncs Claude sessions, and emits a turn-ended edge", () => {
    const activityChanges = vi.fn();
    const turnEnded = vi.fn();
    const doc = epicDoc();
    const service = testService({
      onActivityChanged: activityChanges,
      onTurnEnded: turnEnded,
    });
    service.create(
      doc,
      createRequest({
        tuiAgentId: "agent-1",
        harnessSessionId: "session-old",
      }),
    );

    expect(
      service.recordActivity(
        doc,
        recordTuiAgentActivityRequestSchemaV11.parse({
          epicId: EPIC_ID,
          tuiAgentId: "agent-1",
          harnessSessionId: null,
          harnessId: "claude",
          event: "start",
          observedHarnessSessionId: "session-new",
        }),
      ),
    ).toEqual({ accepted: true });
    expect(service.isActive(doc, "agent-1")).toBe(true);
    expect(recordJson(doc, "agent-1")).toMatchObject({
      harnessSessionId: "session-new",
    });

    expect(
      service.recordActivity(
        doc,
        recordTuiAgentActivityRequestSchemaV11.parse({
          epicId: EPIC_ID,
          tuiAgentId: "agent-1",
          harnessSessionId: null,
          harnessId: "claude",
          event: "resync",
          observedHarnessSessionId: "session-newer",
        }),
      ),
    ).toEqual({ accepted: true });
    expect(service.isActive(doc, "agent-1")).toBe(true);

    expect(
      service.turnEnded(
        doc,
        tuiAgentTurnEndedRequestSchema.parse({
          epicId: EPIC_ID,
          tuiAgentId: "agent-1",
          harnessId: "claude",
        }),
      ),
    ).toEqual({ accepted: true });
    expect(service.isActive(doc, "agent-1")).toBe(false);
    expect(activityChanges.mock.calls).toEqual([
      [EPIC_ID, "agent-1", true],
      [EPIC_ID, "agent-1", false],
    ]);
    expect(turnEnded).toHaveBeenCalledWith(EPIC_ID, "agent-1");
  });

  it("resolves OpenCode hook activity by session without applying Claude resync", () => {
    const doc = epicDoc();
    const service = testService({});
    service.create(
      doc,
      createRequest({
        tuiAgentId: "opencode-agent",
        harnessId: "opencode",
        harnessSessionId: "ses_1",
      }),
    );

    const response = service.recordActivity(
      doc,
      recordTuiAgentActivityRequestSchemaV11.parse({
        epicId: null,
        tuiAgentId: null,
        harnessSessionId: "ses_1",
        harnessId: "opencode",
        event: "start",
        observedHarnessSessionId: "must-not-replace-session",
      }),
    );
    expect(response).toEqual({ accepted: true });
    expect(service.isActive(doc, "opencode-agent")).toBe(true);
    expect(recordJson(doc, "opencode-agent")).toMatchObject({
      harnessSessionId: "ses_1",
    });
  });

  it("rejects invalid harness sessions and foreign-host ownership", () => {
    const doc = epicDoc();
    const service = testService({});
    expectServiceError(
      () =>
        service.create(
          doc,
          createRequest({
            tuiAgentId: "cursor-agent",
            harnessId: "cursor",
            harnessSessionId: null,
          }),
        ),
      "E_HOST_UNSUPPORTED",
    );
    expectServiceError(
      () =>
        service.create(
          doc,
          createRequest({
            tuiAgentId: "claude-without-session",
            harnessId: "claude",
            harnessSessionId: null,
          }),
        ),
      "E_INVALID_ARGUMENT",
    );
    expectServiceError(
      () =>
        service.create(
          doc,
          createRequest({
            tuiAgentId: "foreign-create",
            hostId: "host-other",
          }),
        ),
      "TARGET_NOT_LOCAL",
    );

    service.create(doc, createRequest({ tuiAgentId: "agent-1" }));
    recordEntry(doc, "agent-1").set("hostId", "host-other");
    expectServiceError(
      () =>
        service.rename(doc, {
          epicId: EPIC_ID,
          tuiAgentId: "agent-1",
          title: "No",
        }),
      "TARGET_NOT_LOCAL",
    );
    expect(
      service.recordActivity(
        doc,
        recordTuiAgentActivityRequestSchemaV11.parse({
          epicId: EPIC_ID,
          tuiAgentId: "agent-1",
          harnessSessionId: null,
          harnessId: "claude",
          event: "start",
          observedHarnessSessionId: null,
        }),
      ),
    ).toEqual({ accepted: false });
  });
});

function epicDoc(): Y.Doc {
  const doc = new Y.Doc();
  const root = doc.getMap<unknown>("epic");
  root.set("id", EPIC_ID);
  root.set("chats", new Y.Map());
  return doc;
}

function cloneDoc(source: Y.Doc): Y.Doc {
  const clone = new Y.Doc();
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(source));
  return clone;
}

function createRequest(
  overrides: Partial<CreateTuiAgentRequest>,
): CreateTuiAgentRequest {
  return createTuiAgentRequestSchema.parse({
    epicId: EPIC_ID,
    parentId: "parent-1",
    title: "",
    harnessId: "claude",
    harnessSessionId: "session-1",
    terminalAgentArgs: null,
    terminalShellCommand: null,
    terminalShellArgs: null,
    hostId: HOST_ID,
    workspaceFolders: ["/repo"],
    workspaceMode: "inherit",
    model: null,
    reasoningEffort: null,
    agentMode: "regular",
    tuiAgentId: "agent-1",
    profileId: null,
    forkSourceHarnessSessionId: null,
    ...overrides,
  });
}

function testService(
  overrides: Partial<ConstructorParameters<typeof TuiAgentService>[0]>,
): TuiAgentService {
  return new TuiAgentService({
    hostId: HOST_ID,
    userId: USER_ID,
    now: () => 100,
    createId: () => "generated-agent",
    ...overrides,
  });
}

function recordEntry(doc: Y.Doc, tuiAgentId: string): Y.Map<unknown> {
  const value = ensureTuiAgentsMap(doc).get(tuiAgentId);
  if (!(value instanceof Y.Map)) {
    throw new Error(`Missing terminal-agent '${tuiAgentId}'.`);
  }
  return value;
}

function recordJson(doc: Y.Doc, tuiAgentId: string): Record<string, unknown> {
  return recordEntry(doc, tuiAgentId).toJSON();
}

function expectServiceError(action: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(TuiAgentServiceError);
  if (!(thrown instanceof TuiAgentServiceError)) {
    throw new Error(`Expected TuiAgentServiceError with code '${code}'.`);
  }
  expect(thrown.code).toBe(code);
}
