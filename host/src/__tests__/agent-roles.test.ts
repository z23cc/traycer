import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  handleAgentRolesClaim,
  handleAgentRolesList,
  handleAgentRolesRelinquish,
} from "../rpc/handlers/role-handlers";
import { TRAYCER_SYSTEM_SENDER_AGENT_ID } from "@traycer/protocol/host/agent/roles";
import { handleEpicCreate } from "../rpc/handlers/epic-handlers";
import { InboxMonitor } from "../stream/inbox";
import { startHost, type StartedHost } from "../start-host";
import type { StoredChat, StoredTuiAgent } from "../store/host-store";

describe("agent role claims", () => {
  let started: StartedHost | null = null;
  let tempDir: string | null = null;

  afterEach(async () => {
    if (started !== null) {
      await started.close();
      started = null;
    }
    if (tempDir !== null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("mints a claim once and hands the same one back on retry", async () => {
    const host = await boot();
    await seed(host);
    const first = await claim(host, "chat-1", "Planner", "protocol");
    expect(first).toMatchObject({ created: true, overlapping: [] });
    expect(first.claim).toMatchObject({
      agentId: "chat-1",
      role: "Planner",
      scope: "protocol",
    });
    // Identity is case- and whitespace-insensitive, so this is the same claim.
    const again = await claim(host, "chat-1", " planner", "PROTOCOL ");
    expect(again).toMatchObject({ created: false });
    expect(again.claim.claimId).toBe(first.claim.claimId);
    const listed = await handleAgentRolesList(
      { epicId: "epic-1" },
      host.runtime,
    );
    if (!listed.ok) {
      throw new Error(listed.message);
    }
    expect((listed.result as { claims: unknown[] }).claims).toHaveLength(1);
  });

  it("reports overlap instead of blocking it", async () => {
    const host = await boot();
    await seed(host);
    await claim(host, "chat-1", "Planner", "protocol");
    const second = await claim(host, "chat-2", "planner", "protocol");
    expect(second.created).toBe(true);
    expect(second.overlapping).toHaveLength(1);
    expect(second.overlapping[0]).toMatchObject({ agentId: "chat-1" });
  });

  it("classifies every peer with no attached monitor unreachable", async () => {
    const host = await boot();
    await seed(host);
    const claimed = await claim(host, "chat-1", "Reviewer", "host");
    // Awareness is NEVER queued: nothing was attempted for a peer with no
    // monitor connected right now, and it reads current roles from its next
    // prompt instead.
    expect(claimed.awareness).toEqual({
      deliveredTo: [],
      deferredToPrompt: [],
      unreachable: ["tui-1", "chat-2"],
      failed: [],
    });
    expect(host.runtime.inbox.read("tui-1", null).messages).toHaveLength(0);
  });

  it("delivers awareness to an attached monitor that negotiated it", async () => {
    const host = await boot();
    await seed(host);
    const sent: unknown[] = [];
    const socket = {
      OPEN: 1,
      readyState: 1,
      send: (payload: string) => sent.push(JSON.parse(payload)),
    };
    host.runtime.inboxMonitors.add(
      socket as never,
      new InboxMonitor(socket as never, host.runtime, "tui-1", "epic-1", 2),
    );
    const claimed = await claim(host, "chat-1", "Reviewer", "host");
    expect(claimed.awareness).toMatchObject({
      deliveredTo: ["tui-1"],
      unreachable: ["chat-2"],
    });
    expect(sent).toEqual([
      {
        kind: "role-awareness",
        hasBinaryPayload: false,
        event: {
          kind: "role-claimed",
          epicId: "epic-1",
          claim: expect.objectContaining({
            agentId: "chat-1",
            role: "Reviewer",
          }),
          at: expect.any(Number),
        },
      },
    ]);
  });

  it("never sends the awareness frame a @1.0 monitor did not negotiate", async () => {
    const host = await boot();
    await seed(host);
    const sent: unknown[] = [];
    const socket = {
      OPEN: 1,
      readyState: 1,
      send: (payload: string) => sent.push(JSON.parse(payload)),
    };
    host.runtime.inboxMonitors.add(
      socket as never,
      new InboxMonitor(socket as never, host.runtime, "tui-1", "epic-1", 0),
    );
    const claimed = await claim(host, "chat-1", "Reviewer", "host");
    expect(sent).toEqual([]);
    expect(claimed.awareness).toMatchObject({
      deliveredTo: [],
      unreachable: ["tui-1", "chat-2"],
    });
  });

  it("refuses a claimant that is not an agent of the epic", async () => {
    const host = await boot();
    await seed(host);
    const answer = await handleAgentRolesClaim(
      {
        epicId: "epic-1",
        claimantAgentId: "stranger",
        role: "Planner",
        scope: "protocol",
      },
      host.runtime,
    );
    expect(answer.ok).toBe(false);
  });

  it("releases once, and calls a second release a no-op", async () => {
    const host = await boot();
    await seed(host);
    const claimed = await claim(host, "chat-1", "Planner", "protocol");
    const request = {
      epicId: "epic-1",
      claimantAgentId: "chat-1",
      claimId: claimed.claim.claimId,
    };
    const first = await handleAgentRolesRelinquish(request, host.runtime);
    expect(first).toMatchObject({ result: { released: true } });
    const second = await handleAgentRolesRelinquish(request, host.runtime);
    expect(second).toMatchObject({ result: { released: false } });
  });

  it("hides a claim whose agent is gone without deleting it", async () => {
    const host = await boot();
    await seed(host);
    await claim(host, "chat-1", "Planner", "protocol");
    await host.runtime.store.mutate((state) => {
      state.chats = state.chats.filter((row) => row.chatId !== "chat-1");
    });
    const listed = await handleAgentRolesList(
      { epicId: "epic-1" },
      host.runtime,
    );
    if (!listed.ok) {
      throw new Error(listed.message);
    }
    expect((listed.result as { claims: unknown[] }).claims).toEqual([]);
    // Liveness is resolved on READ; the row itself survives.
    expect(host.runtime.store.snapshot().roleClaims).toHaveLength(1);
  });

  async function boot(): Promise<StartedHost> {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    return started;
  }
});

async function claim(
  host: StartedHost,
  agentId: string,
  role: string,
  scope: string,
): Promise<{
  readonly created: boolean;
  readonly claim: { readonly claimId: string };
  readonly overlapping: readonly unknown[];
  readonly awareness: unknown;
}> {
  const answer = await handleAgentRolesClaim(
    { epicId: "epic-1", claimantAgentId: agentId, role, scope },
    host.runtime,
  );
  if (!answer.ok) {
    throw new Error(answer.message);
  }
  return answer.result as {
    created: boolean;
    claim: { claimId: string };
    overlapping: readonly unknown[];
    awareness: unknown;
  };
}

async function seed(host: StartedHost): Promise<void> {
  await host.runtime.store.mutate((state) => {
    state.chats.push(chat(host, "chat-1"), chat(host, "chat-2"));
    state.tuiAgents.push(tuiAgent(host));
  });
}

function chat(host: StartedHost, chatId: string): StoredChat {
  return {
    epicId: "epic-1",
    chatId,
    parentId: null,
    hostId: host.runtime.hostId,
    title: chatId,
    createdAt: 1,
    runSettings: null,
    providerSession: null,
    turns: [],
    events: [],
    transcriptEpoch: 0,
    indexRevision: 0,
    fileChangeCount: 0,
    lastUsage: null,
    archivedAt: null,
    lastAuthFailureTurnId: null,
    fastMode: false,
  };
}

function tuiAgent(host: StartedHost): StoredTuiAgent {
  return {
    tuiAgentId: "tui-1",
    epicId: "epic-1",
    parentId: null,
    title: "TUI",
    harnessId: "claude",
    harnessSessionId: null,
    terminalAgentArgs: null,
    terminalShellCommand: null,
    terminalShellArgs: null,
    hostId: host.runtime.hostId,
    workspaceFolders: [],
    workspaceMode: null,
    model: null,
    reasoningEffort: null,
    agentMode: "regular",
    profileId: null,
    forkSourceHarnessSessionId: null,
    titleEditedByUser: false,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
  };
}

describe("reserved agent id", () => {
  let started: StartedHost | null = null;
  let tempDir: string | null = null;

  afterEach(async () => {
    if (started !== null) {
      await started.close();
      started = null;
    }
    if (tempDir !== null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("refuses to persist an agent named traycer:system", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    const host = started;
    const seedEpic = {
      id: "epic-1",
      title: "Reserved",
      initialUserPrompt: "go",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "active",
      createdAt: 1,
      updatedAt: 1,
      createdBy: "local",
      version: "2.0.0",
    };
    const created = await handleEpicCreate(
      {
        epic: seedEpic,
        repoIdentifiers: [],
        workspaces: [],
        chat: {
          chatId: TRAYCER_SYSTEM_SENDER_AGENT_ID,
          parentId: null,
          hostId: host.runtime.hostId,
          title: "Root",
          worktreeIntent: null,
          initialMessage: null,
        },
      },
      host.runtime,
    );
    expect(created.ok).toBe(false);
    // The refusal happens BEFORE persistence: nothing landed, not even the epic.
    expect(host.runtime.store.snapshot().epics).toEqual([]);
  });
});
