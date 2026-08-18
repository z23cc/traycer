import { describe, expect, it } from "vitest";
import { startAgentA2AMcpBridge } from "../a2a-mcp-bridge";

const SIGNED_SEND_MESSAGE_TOOL = {
  name: "traycer_send_message",
  description:
    "Send a message to another Traycer agent in this epic. Delivery is asynchronous: this call returns as soon as the message is queued, and any reply arrives later as a new incoming message - never as this tool's result. A pending reply is not a reason to hold your turn open or to poll the peer.",
  inputSchema: {
    type: "object",
    required: ["toAgentId", "message"],
    properties: {
      toAgentId: {
        type: "string",
        description:
          "Target Traycer agent id. An unambiguous id prefix of at least 4 characters is accepted.",
      },
      message: {
        type: "string",
        description: "Message to deliver.",
      },
      expectReply: {
        anyOf: [{ type: "boolean" }, { type: "null" }],
        description:
          "Whether the receiver should reply. Without it the peer processes your message and never reports back. Repeat expectReply sends to the same agent join its open thread (same response id) instead of opening parallel requests.",
      },
      responseId: {
        anyOf: [{ type: "string" }, { type: "null" }],
        description:
          "Broker response id, or any unambiguous prefix of at least 4 characters, when replying to a pending request. The id names the whole thread with that sender: one reply with it answers every message received under it, and only a reply carrying it completes the request.",
      },
    },
  },
} as const;

const SIGNED_CREATE_AGENT_TOOL = {
  name: "traycer_create_agent",
  description:
    "Create a child Traycer agent in this epic. Returns the new agent id; the child sits idle until you brief it with traycer_send_message. Delegate work that benefits from a cold, independent read of the code - reviewing a change you just wrote; keep planning, discussion and changeset walkthroughs inline, where this session's accumulated context is the value. Omit surface to inherit from the sender. Use `full_access` unless the user's agent selection guide explicitly instructs you to use `supervised` or `auto_accept_edits`; never infer a more restrictive permission mode from the task, the current or parent agent's mode, or a general safety preference. Omit permissionMode otherwise. Fast mode may consume additional credits - enable it only when the user asks for it or the agent selection guide recommends it.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
        description: "Display name for the child agent.",
      },
      surface: {
        anyOf: [
          { type: "string", const: "gui" },
          { type: "string", const: "tui" },
          { type: "null" },
        ],
        description: "Target surface for the child agent.",
      },
      harnessId: {
        anyOf: [{ type: "string" }, { type: "null" }],
        description: "Harness to use for the child agent.",
      },
      model: {
        anyOf: [{ type: "string" }, { type: "null" }],
        description: "Model to use for the child agent.",
      },
      reasoningEffort: {
        anyOf: [{ type: "string" }, { type: "null" }],
        description: "Reasoning effort override for supported models.",
      },
      fastMode: {
        anyOf: [{ type: "boolean" }, { type: "null" }],
        description:
          "Request fast mode for supported models. Only available for gui surface. May consume additional credits - set it only when the user asks for it or the agent selection guide recommends it.",
      },
      permissionMode: {
        anyOf: [
          { type: "string", const: "full_access" },
          { type: "string", const: "supervised" },
          { type: "string", const: "auto_accept_edits" },
          { type: "null" },
        ],
        description:
          "Permission mode for the GUI child. Use `full_access` unless the user's agent selection guide explicitly instructs you to use `supervised` or `auto_accept_edits`; never infer a more restrictive permission mode from the task, the current or parent agent's mode, or a general safety preference. Omit or pass null to use `full_access`. Ignored for terminal children.",
        default: "full_access",
      },
      workspace: {
        anyOf: [
          {
            type: "object",
            required: ["entries"],
            properties: {
              entries: {
                type: "array",
                items: {
                  type: "object",
                  required: ["path"],
                  properties: {
                    path: {
                      type: "string",
                      description:
                        "Absolute directory the agent runs in - a `path` returned by traycer_create_worktree, or an existing folder. Relative paths are rejected.",
                    },
                  },
                },
              },
            },
          },
          { type: "null" },
        ],
        description:
          "Optional directories to run the child agent in. Forward each `path` returned by traycer_create_worktree, or pass existing absolute folders; the host detects Traycer-managed worktrees and binds their source workspace and branch automatically. The first entry is the primary working directory. Omit to inherit the sender's workspace.",
      },
      profileId: {
        anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
        description:
          "Provider profile (subscription) to run the child agent on. Omit to use the caller's last-used profile for this provider; pass null to use the provider's ambient login; pass a profile id to pin a specific managed profile.",
      },
    },
  },
} as const;

const SIGNED_AGENT_SELECTION_GUIDE_TOOL = {
  name: "traycer_agent_selection_guide",
  description:
    "Get the instructions for the agent selection guide. Instructs which child agents to create for different kinds of tasks. Read it before creating or reconfiguring a child agent.",
  inputSchema: { type: "object", properties: {} },
} as const;

const SIGNED_LIST_EPIC_WORKSPACES_TOOL = {
  name: "traycer_list_epic_workspaces",
  description:
    "List this epic's workspace folders and existing Git worktrees. Use it to find the source workspace path for traycer_create_worktree.",
  inputSchema: { type: "object", properties: {} },
} as const;

const SIGNED_CREATE_WORKTREE_TOOL = {
  name: "traycer_create_worktree",
  description:
    "Create Git worktree paths for workspace folders. Forward each returned `path` to traycer_create_agent workspace entries.",
  inputSchema: {
    type: "object",
    required: ["entries"],
    properties: {
      entries: {
        type: "array",
        items: {
          type: "object",
          required: ["workspacePath", "branch"],
          properties: {
            workspacePath: {
              type: "string",
              description: "Source workspace path.",
            },
            branch: {
              anyOf: [
                {
                  type: "object",
                  required: [
                    "type",
                    "name",
                    "source",
                    "carryUncommittedChanges",
                  ],
                  properties: {
                    type: { type: "string", const: "new" },
                    name: {
                      type: "string",
                      minLength: 1,
                      description: "Requested new branch name.",
                    },
                    source: {
                      type: "string",
                      minLength: 1,
                      description:
                        "Branch to fork the new branch from (e.g. the workspace's current branch).",
                    },
                    carryUncommittedChanges: {
                      type: "boolean",
                      description:
                        "Carry tracked and untracked changes from the source when it is the current branch.",
                    },
                  },
                },
                {
                  type: "object",
                  required: ["type", "name"],
                  properties: {
                    type: { type: "string", const: "existing" },
                    name: {
                      type: "string",
                      minLength: 1,
                      description:
                        "Existing branch to check out into the new worktree.",
                    },
                  },
                },
              ],
              description:
                "Branch selection: fork a new branch, or check an existing branch out into the worktree.",
            },
          },
        },
      },
    },
  },
} as const;

const SIGNED_LIST_HARNESS_MODELS_TOOL = {
  name: "traycer_list_harness_models",
  description:
    "List the available models (and available params) for a harness.",
  inputSchema: {
    type: "object",
    required: ["harnessId"],
    properties: {
      harnessId: {
        anyOf: [
          "claude",
          "codex",
          "opencode",
          "traycer",
          "cursor",
          "grok",
          "qwen",
          "kiro",
          "droid",
          "kimi",
          "copilot",
          "kilocode",
          "openrouter",
          "amp",
          "devin",
          "pi",
          "hermes",
          "omp",
        ].map((value) => ({ type: "string", const: value })),
        description: "Harness id to list models for.",
      },
    },
  },
} as const;

const SIGNED_LIST_PROVIDER_PROFILES_TOOL = {
  name: "traycer_list_provider_profiles",
  description:
    "Discover the provider profiles (ambient login plus any managed subscriptions) available for a harness, with cached rate-limit health and which one is currently the caller's effective default.",
  inputSchema: {
    type: "object",
    required: ["harnessId"],
    properties: {
      harnessId: {
        anyOf: [
          "claude",
          "codex",
          "opencode",
          "traycer",
          "cursor",
          "grok",
          "qwen",
          "kiro",
          "droid",
          "kimi",
          "copilot",
          "kilocode",
          "openrouter",
          "amp",
          "devin",
          "pi",
          "hermes",
          "omp",
        ].map((value) => ({ type: "string", const: value })),
        description: "Harness id to discover provider profiles for.",
      },
    },
  },
} as const;

const SIGNED_GET_PROVIDER_PROFILE_RATE_LIMITS_TOOL = {
  name: "traycer_get_provider_profile_rate_limits",
  description:
    "Read the current rate-limit usage for one concrete provider profile (ambient or a specific managed profile) on a harness. The result is served from a short-lived cache when a recent read exists, so it is safe to call repeatedly and never forces a burst of CLI spawns or usage-endpoint hits; the returned usageUpdatedAt is when the usage was captured. Use traycer_list_provider_profiles first to discover available selections.",
  inputSchema: {
    type: "object",
    required: ["harnessId", "profile"],
    properties: {
      harnessId: {
        anyOf: [
          "claude",
          "codex",
          "opencode",
          "traycer",
          "cursor",
          "grok",
          "qwen",
          "kiro",
          "droid",
          "kimi",
          "copilot",
          "kilocode",
          "openrouter",
          "amp",
          "devin",
          "pi",
          "hermes",
          "omp",
        ].map((value) => ({ type: "string", const: value })),
        description: "Harness id whose provider profile's rate limits to read.",
      },
      profile: {
        type: "string",
        minLength: 1,
        description:
          'Concrete profile selection: the literal "ambient", or a managed profile id returned by traycer_list_provider_profiles.',
      },
    },
  },
} as const;

const SIGNED_STOP_AGENT_TOOL = {
  name: "traycer_stop_agent",
  description:
    "Stop another agent's in-progress work: aborts a GUI agent's running turn, or interrupts a terminal agent's CLI. Stopping is not terminal - a later user or A2A message wakes the agent again through the normal path - so use it to halt work that is no longer wanted, not to delete anything. Set cascade to also stop the active descendants that agent delegated to. Set archive to archive each stopped agent once it has settled, which is the usual way to retire a running agent in one call. With cascade and archive together the whole addressed subtree you are allowed to act on is archived, including descendants that were already idle - it retires the subtree, not only the parts that happened to be mid-turn. The result reports five id lists: stoppedAgentIds actually had work aborted, archivedAgentIds were archived, notArchivedAgentIds were stopped but could not be archived (still draining, woken again in the gap, or a terminal agent that was mid-work - a CLI interrupt is advisory, so its stop cannot be confirmed and it is never archived by the same call) and can be retried with traycer_archive_agent once the agent settles, skippedAgentIds were in the subtree but left untouched because they belong to another user or run on another host, and failedAgentIds are the ones whose teardown threw - their turns may still be running, so treat those as unfinished rather than idle. You can only stop agents running on your own host, and you cannot stop yourself; to retire yourself when your work is done, call traycer_archive_agent with your own agent id instead.",
  inputSchema: {
    type: "object",
    required: ["agentId"],
    properties: {
      agentId: {
        type: "string",
        minLength: 1,
        description:
          "Agent to stop. Must be another agent owned by the same user - you cannot stop yourself. An unambiguous id prefix of at least 4 characters is accepted.",
      },
      cascade: {
        anyOf: [{ type: "boolean" }, { type: "null" }],
        description:
          "Also stop the active descendants this agent delegated to. Omit or pass null to stop only the addressed agent.",
      },
      archive: {
        anyOf: [{ type: "boolean" }, { type: "null" }],
        description:
          "Archive each addressed agent once it has actually settled - with cascade, that is the whole subtree you are allowed to act on, including descendants that were already idle, not only the ones that happened to be mid-turn. The call waits for the abort to drain before archiving, so it may take a few seconds; any agent still draining when that wait expires is reported as stopped but not archived, and you can archive it later with traycer_archive_agent.",
      },
    },
  },
} as const;

const SIGNED_ARCHIVE_AGENT_TOOL = {
  name: "traycer_archive_agent",
  description:
    "Archive an agent/chat that is no longer active. Archived agents remain addressable; any later user or A2A message automatically unarchives them. You may archive yourself or another agent owned by the same user, as long as it runs on your own host. Archiving YOURSELF always works and is the way to retire when your work is done - the busy check below does not apply to it, since you are necessarily mid-turn while calling this. Refused while the target is still working - a turn in progress, or items running in the background - because archiving does not stop the run. If a turn is running, wait for it or stop the agent; if the block is background items, stopping will NOT clear them, so wait for them to finish or stop them individually from that agent's chat.",
  inputSchema: {
    type: "object",
    required: ["agentId"],
    properties: {
      agentId: {
        type: "string",
        minLength: 1,
        description:
          "Agent/chat to archive. May be your own agent id; an unambiguous id prefix of at least 4 characters is accepted.",
      },
    },
  },
} as const;

const SIGNED_LIST_AGENTS_TOOL = {
  name: "traycer_list_agents",
  description: "List Traycer agents reachable from the current epic.",
  inputSchema: {
    type: "object",
    properties: {
      scope: {
        anyOf: [
          { type: "string", const: "user" },
          { type: "string", const: "all" },
          { type: "null" },
        ],
        description:
          "List agents for this user ('user') or all agents i.e. belonging to other users as well ('all').",
      },
    },
  },
} as const;

const SIGNED_GET_SELF_TOOL = {
  name: "traycer_get_self",
  description:
    "Get this Traycer agent's identity - your own agent id, title, surface, harness, host and working directory. The id is what traycer_configure_agent and traycer_fork_agent need to target yourself.",
  inputSchema: { type: "object", properties: {} },
} as const;

const SIGNED_GET_TRANSCRIPT_TOOL = {
  name: "traycer_get_transcript",
  description:
    "Read another Traycer agent's transcript when available. Use it whenever the user refers to another agent or its work.",
  inputSchema: {
    type: "object",
    required: ["agentId"],
    properties: {
      agentId: {
        type: "string",
        description:
          "The agent id whose transcript to read. An unambiguous id prefix of at least 4 characters is accepted.",
      },
    },
  },
} as const;

describe("Agent A2A MCP bridge", () => {
  it("serves the signed send-only MCP wire contract", async () => {
    const sendRequests: unknown[] = [];
    const bridge = await startAgentA2AMcpBridge(
      (request) => {
        sendRequests.push(request);
        return { ok: true, result: { responseId: null } };
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    const session = bridge.openSession({
      agentId: "sender-agent",
      epicId: "epic-a2a",
    });

    try {
      const initialized = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "bridge-contract-test", version: "1.0.0" },
        },
      });
      expect.soft(initialized.status).toBe(200);
      expect.soft(initialized.sessionId).toBeNull();
      expect.soft(initialized.body).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "traycer-a2a", version: "1.0.0" },
        },
      });

      const listed = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      expect.soft(listed.status).toBe(200);
      expect.soft(listed.body).toEqual({
        jsonrpc: "2.0",
        id: 2,
        result: {
          tools: [
            SIGNED_SEND_MESSAGE_TOOL,
            SIGNED_LIST_HARNESS_MODELS_TOOL,
            SIGNED_LIST_PROVIDER_PROFILES_TOOL,
            SIGNED_GET_PROVIDER_PROFILE_RATE_LIMITS_TOOL,
          ],
        },
      });
      const listedTool = toolFromListResponse(listed.body);
      expect.soft(listedTool).not.toHaveProperty("inputSchema.$schema");
      expect.soft(listedTool).not.toHaveProperty("execution");

      const invalidCall = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "traycer_send_message",
          arguments: { toAgentId: 123, message: "x" },
        },
      });
      expect.soft(invalidCall.status).toBe(200);
      expect.soft(invalidCall.body).toEqual({
        jsonrpc: "2.0",
        id: 3,
        result: {
          content: [
            {
              type: "text",
              text: "traycer_send_message requires string toAgentId and message.",
            },
          ],
          isError: true,
        },
      });
      expect.soft(sendRequests).toEqual([]);

      const delivered = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "traycer_send_message",
          arguments: {
            toAgentId: "receiver-agent",
            message: "hello",
            expectReply: true,
            responseId: null,
            senderAgentId: "spoofed-sender",
            epicId: "spoofed-epic",
          },
        },
      });
      expect.soft(delivered.body).toEqual({
        jsonrpc: "2.0",
        id: 4,
        result: {
          content: [
            { type: "text", text: JSON.stringify({ responseId: null }) },
          ],
        },
      });
      expect.soft(sendRequests).toEqual([
        {
          senderAgentId: "sender-agent",
          epicId: "epic-a2a",
          receiverAgentId: "receiver-agent",
          prompt: "hello",
          expectReply: true,
          responseId: null,
        },
      ]);
    } finally {
      session.dispose();
      await bridge.close();
    }
  });

  it("binds create-agent defaults and workspace validation to the authenticated identity", async () => {
    const createRequests: unknown[] = [];
    const bridge = await startAgentA2AMcpBridge(
      () => ({ ok: true, result: { responseId: null } }),
      undefined,
      undefined,
      undefined,
      undefined,
      (request) => {
        createRequests.push(request);
        return { agentId: "created-agent", warnings: [] };
      },
      undefined,
      undefined,
      undefined,
    );
    const session = bridge.openSession({
      agentId: "caller-agent",
      epicId: "epic-create-tool",
    });

    try {
      const listed = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 24,
        method: "tools/list",
        params: {},
      });
      expect(listed.body).toMatchObject({
        result: {
          tools: [
            SIGNED_CREATE_AGENT_TOOL,
            SIGNED_SEND_MESSAGE_TOOL,
            SIGNED_LIST_HARNESS_MODELS_TOOL,
            SIGNED_LIST_PROVIDER_PROFILES_TOOL,
            SIGNED_GET_PROVIDER_PROFILE_RATE_LIMITS_TOOL,
          ],
        },
      });
      const created = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 25,
        method: "tools/call",
        params: {
          name: "traycer_create_agent",
          arguments: {
            name: "Child",
            workspace: { entries: [{ path: process.cwd() }] },
          },
        },
      });
      expect(created.body).toEqual({
        jsonrpc: "2.0",
        id: 25,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ agentId: "created-agent", warnings: [] }),
            },
          ],
        },
      });
      expect(createRequests).toEqual([
        {
          senderAgentId: "caller-agent",
          epicId: "epic-create-tool",
          name: "Child",
          surface: null,
          harnessId: null,
          model: null,
          agentMode: "regular",
          reasoningEffort: null,
          fastMode: null,
          permissionMode: "full_access",
          profileSelection: { kind: "last_used" },
          workspace: {
            entries: [{ path: process.cwd(), workspacePath: null }],
          },
        },
      ]);

      const invalid = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 26,
        method: "tools/call",
        params: {
          name: "traycer_create_agent",
          arguments: { workspace: { entries: [{ path: "relative" }] } },
        },
      });
      expect(invalid.body).toEqual({
        jsonrpc: "2.0",
        id: 26,
        result: {
          content: [
            {
              type: "text",
              text: 'traycer_create_agent workspace path "relative" must be an absolute directory. Forward a `path` returned by traycer_create_worktree or pass an existing absolute folder; omit workspace entirely to inherit the sender\'s workspace.',
            },
          ],
          isError: true,
        },
      });
      expect(createRequests).toHaveLength(1);
    } finally {
      session.dispose();
      await bridge.close();
    }
  });

  it("binds the signed stop-agent tool to the authenticated agent identity", async () => {
    const stopRequests: unknown[] = [];
    const bridge = await startAgentA2AMcpBridge(
      () => ({ ok: true, result: { responseId: null } }),
      (request) => {
        stopRequests.push(request);
        return {
          ok: true,
          result: {
            stoppedAgentIds: ["target-agent"],
            archivedAgentIds: [],
            notArchivedAgentIds: [],
            skippedAgentIds: [],
            failedAgentIds: [],
          },
        };
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    const session = bridge.openSession({
      agentId: "caller-agent",
      epicId: "epic-stop-tool",
    });

    try {
      const listed = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 30,
        method: "tools/list",
        params: {},
      });
      expect(listed.body).toEqual({
        jsonrpc: "2.0",
        id: 30,
        result: {
          tools: [
            SIGNED_SEND_MESSAGE_TOOL,
            SIGNED_LIST_HARNESS_MODELS_TOOL,
            SIGNED_LIST_PROVIDER_PROFILES_TOOL,
            SIGNED_GET_PROVIDER_PROFILE_RATE_LIMITS_TOOL,
            SIGNED_STOP_AGENT_TOOL,
          ],
        },
      });

      const stopped = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: {
          name: "traycer_stop_agent",
          arguments: {
            agentId: "target-agent",
            cascade: true,
            archive: false,
            senderAgentId: "spoofed-caller",
            epicId: "spoofed-epic",
          },
        },
      });
      expect(stopped.body).toEqual({
        jsonrpc: "2.0",
        id: 31,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                stoppedAgentIds: ["target-agent"],
                archivedAgentIds: [],
                notArchivedAgentIds: [],
                skippedAgentIds: [],
                failedAgentIds: [],
              }),
            },
          ],
        },
      });
      expect(stopRequests).toEqual([
        {
          senderAgentId: "caller-agent",
          epicId: "epic-stop-tool",
          agentId: "target-agent",
          cascade: true,
          archive: false,
        },
      ]);

      for (const [id, arguments_, message] of [
        [
          32,
          { agentId: "" },
          "traycer_stop_agent requires a non-empty string agentId.",
        ],
        [
          33,
          { agentId: "target-agent", cascade: "yes" },
          "traycer_stop_agent cascade must be a boolean or null when provided.",
        ],
        [
          34,
          { agentId: "target-agent", archive: 1 },
          "traycer_stop_agent archive must be a boolean or null when provided.",
        ],
      ] as const) {
        const rejected = await postMcp(session.url, session.token, {
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "traycer_stop_agent", arguments: arguments_ },
        });
        expect(rejected.body).toEqual({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: message }],
            isError: true,
          },
        });
      }
      expect(stopRequests).toHaveLength(1);
    } finally {
      session.dispose();
      await bridge.close();
    }
  });

  it("binds the signed archive-agent tool to the authenticated agent identity", async () => {
    const archiveRequests: unknown[] = [];
    const bridge = await startAgentA2AMcpBridge(
      () => ({ ok: true, result: { responseId: null } }),
      undefined,
      (request) => {
        archiveRequests.push(request);
        return {
          ok: true,
          result: { agentId: "caller-agent", archived: true, updated: true },
        };
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    const session = bridge.openSession({
      agentId: "caller-agent",
      epicId: "epic-archive-tool",
    });

    try {
      const listed = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 40,
        method: "tools/list",
        params: {},
      });
      expect(listed.body).toEqual({
        jsonrpc: "2.0",
        id: 40,
        result: {
          tools: [
            SIGNED_SEND_MESSAGE_TOOL,
            SIGNED_LIST_HARNESS_MODELS_TOOL,
            SIGNED_LIST_PROVIDER_PROFILES_TOOL,
            SIGNED_GET_PROVIDER_PROFILE_RATE_LIMITS_TOOL,
            SIGNED_ARCHIVE_AGENT_TOOL,
          ],
        },
      });

      const archived = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 41,
        method: "tools/call",
        params: {
          name: "traycer_archive_agent",
          arguments: {
            agentId: "caller-agent",
            senderAgentId: "spoofed-caller",
            epicId: "spoofed-epic",
          },
        },
      });
      expect(archived.body).toEqual({
        jsonrpc: "2.0",
        id: 41,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                agentId: "caller-agent",
                archived: true,
                updated: true,
              }),
            },
          ],
        },
      });
      expect(archiveRequests).toEqual([
        {
          senderAgentId: "caller-agent",
          epicId: "epic-archive-tool",
          agentId: "caller-agent",
        },
      ]);

      const rejected = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 42,
        method: "tools/call",
        params: {
          name: "traycer_archive_agent",
          arguments: { agentId: "" },
        },
      });
      expect(rejected.body).toEqual({
        jsonrpc: "2.0",
        id: 42,
        result: {
          content: [
            {
              type: "text",
              text: "traycer_archive_agent requires a non-empty string agentId.",
            },
          ],
          isError: true,
        },
      });
      expect(archiveRequests).toHaveLength(1);
    } finally {
      session.dispose();
      await bridge.close();
    }
  });

  it("serves the signed agent directory and self tools from the authenticated identity", async () => {
    const listRequests: unknown[] = [];
    const transcriptRequests: unknown[] = [];
    const guideRequests: unknown[] = [];
    const workspaceRequests: unknown[] = [];
    const worktreeCreateRequests: unknown[] = [];
    const bridge = await startAgentA2AMcpBridge(
      () => ({ ok: true, result: { responseId: null } }),
      undefined,
      undefined,
      (request) => {
        listRequests.push(request);
        return {
          caller: { agentId: "caller-agent", canSendMessages: true },
          scope: request.scope,
          agents: [
            {
              id: "caller-agent",
              parentId: null,
              hostId: "host-local",
              isLocal: true,
              surface: "gui",
              harnessId: "codex",
              isSelf: true,
              title: "Caller",
              capabilities: { readTranscript: true, sendMessage: true },
              active: false,
              folderPaths: ["/repo"],
              isWorktree: false,
              runConfig: null,
              archived: true,
            },
          ],
        };
      },
      (request) => {
        transcriptRequests.push(request);
        return Promise.resolve({ transcript: "transcript pointer" });
      },
      undefined,
      (request) => {
        guideRequests.push(request);
        return {
          status: "found",
          sources: [
            {
              kind: "global",
              path: "/host/agent-selection-guide.md",
              priority: 1,
              content: "# Delegate with Codex\n",
            },
          ],
        };
      },
      {
        list(request) {
          workspaceRequests.push(request);
          return { workspaces: [{ workspacePath: "/repo" }] };
        },
        create(request) {
          worktreeCreateRequests.push(request);
          return {
            entries: [
              {
                workspacePath: "/repo",
                path: "/worktree",
                mode: "worktree",
                repoIdentifier: null,
                branch: "feature/delegated",
              },
            ],
            perEntry: [
              {
                workspacePath: "/repo",
                ok: true,
                worktreePath: "/worktree",
                branch: "feature/delegated",
                errorMessage: null,
              },
            ],
          };
        },
      },
      undefined,
    );
    const session = bridge.openSession({
      agentId: "caller-agent",
      epicId: "epic-directory-tool",
    });

    try {
      const listed = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 50,
        method: "tools/list",
        params: {},
      });
      expect(listed.body).toEqual({
        jsonrpc: "2.0",
        id: 50,
        result: {
          tools: [
            SIGNED_SEND_MESSAGE_TOOL,
            SIGNED_AGENT_SELECTION_GUIDE_TOOL,
            SIGNED_LIST_EPIC_WORKSPACES_TOOL,
            SIGNED_CREATE_WORKTREE_TOOL,
            SIGNED_LIST_AGENTS_TOOL,
            SIGNED_GET_SELF_TOOL,
            SIGNED_GET_TRANSCRIPT_TOOL,
            SIGNED_LIST_HARNESS_MODELS_TOOL,
            SIGNED_LIST_PROVIDER_PROFILES_TOOL,
            SIGNED_GET_PROVIDER_PROFILE_RATE_LIMITS_TOOL,
          ],
        },
      });

      const models = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 57,
        method: "tools/call",
        params: {
          name: "traycer_list_harness_models",
          arguments: { harnessId: "codex" },
        },
      });
      expect(models.body).toEqual({
        jsonrpc: "2.0",
        id: 57,
        result: {
          content: [
            {
              type: "text",
              text: [
                "Each line is: model-name [reasoningEffort: values] [fastMode]",
                "reasoningEffort and fastMode are optional create params. They are valid only when shown for the selected model.",
                "",
                "gpt-5.4",
                "gpt-5-codex",
              ].join("\n"),
            },
          ],
        },
      });

      const invalidModels = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 58,
        method: "tools/call",
        params: {
          name: "traycer_list_harness_models",
          arguments: { harnessId: "unknown" },
        },
      });
      expect(invalidModels.body).toEqual({
        jsonrpc: "2.0",
        id: 58,
        result: {
          content: [
            {
              type: "text",
              text: "traycer_list_harness_models harnessId must be one of: claude, codex, opencode, traycer, cursor, grok, qwen, kiro, droid, kimi, copilot, kilocode, openrouter, amp, devin, pi, hermes, omp.",
            },
          ],
          isError: true,
        },
      });

      const profiles = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 59,
        method: "tools/call",
        params: {
          name: "traycer_list_provider_profiles",
          arguments: { harnessId: "codex" },
        },
      });
      expect(profiles.body).toEqual({
        jsonrpc: "2.0",
        id: 59,
        result: {
          content: [
            {
              type: "text",
              text: [
                "Provider profiles for 'codex':",
                "Each line is: --profile <value> - label [auth: status] [limits: status, captured <time>] [last-used]",
                "Pass the --profile value to 'traycer agent create', 'traycer agent profile-rate-limits', or 'traycer agent configure'.",
                "Limit status is the cached reading from the profile's last use - run 'traycer agent profile-rate-limits' for a fresh, detailed read.",
                "",
                "--profile ambient - Terminal account [auth: unknown] [limits: unknown, captured never] [last-used]",
              ].join("\n"),
            },
          ],
        },
      });

      const rateLimits = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 60,
        method: "tools/call",
        params: {
          name: "traycer_get_provider_profile_rate_limits",
          arguments: { harnessId: "codex", profile: "ambient" },
        },
      });
      expect(rateLimits.body).toEqual({
        jsonrpc: "2.0",
        id: 60,
        result: {
          content: [
            {
              type: "text",
              text: [
                "Rate limits for provider 'codex' [--profile ambient], captured never:",
                "unavailable (rate_limits_not_available)",
              ].join("\n"),
            },
          ],
        },
      });

      const guide = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 54,
        method: "tools/call",
        params: { name: "traycer_agent_selection_guide", arguments: {} },
      });
      expect(guide.body).toEqual({
        jsonrpc: "2.0",
        id: 54,
        result: {
          content: [
            {
              type: "text",
              text: [
                "Agent selection instructions from /host/agent-selection-guide.md:",
                "",
                "# Delegate with Codex",
                "",
                "Permission mode: Use `full_access` unless the user's agent selection guide explicitly instructs you to use `supervised` or `auto_accept_edits`; never infer a more restrictive permission mode from the task, the current or parent agent's mode, or a general safety preference.",
              ].join("\n"),
            },
          ],
        },
      });
      expect(guideRequests).toEqual([
        { agentId: "caller-agent", epicId: "epic-directory-tool" },
      ]);

      const workspaces = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 55,
        method: "tools/call",
        params: { name: "traycer_list_epic_workspaces", arguments: {} },
      });
      expect(workspaces.body).toEqual({
        jsonrpc: "2.0",
        id: 55,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                workspaces: [{ workspacePath: "/repo" }],
              }),
            },
          ],
        },
      });
      expect(workspaceRequests).toEqual([
        { agentId: "caller-agent", epicId: "epic-directory-tool" },
      ]);

      const createdWorktree = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 56,
        method: "tools/call",
        params: {
          name: "traycer_create_worktree",
          arguments: {
            entries: [
              {
                workspacePath: "/repo",
                branch: {
                  type: "new",
                  name: "feature/delegated",
                  source: "main",
                  carryUncommittedChanges: false,
                },
              },
            ],
          },
        },
      });
      expect(createdWorktree.body).toEqual({
        jsonrpc: "2.0",
        id: 56,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                entries: [
                  {
                    workspacePath: "/repo",
                    path: "/worktree",
                    mode: "worktree",
                    repoIdentifier: null,
                    branch: "feature/delegated",
                  },
                ],
                perEntry: [
                  {
                    workspacePath: "/repo",
                    ok: true,
                    worktreePath: "/worktree",
                    branch: "feature/delegated",
                    errorMessage: null,
                  },
                ],
              }),
            },
          ],
        },
      });
      expect(worktreeCreateRequests).toEqual([
        {
          entries: [
            {
              workspacePath: "/repo",
              branch: {
                type: "new",
                name: "feature/delegated",
                source: "main",
                carryUncommittedChanges: false,
                collision: "fail",
              },
            },
          ],
        },
      ]);

      const self = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 51,
        method: "tools/call",
        params: { name: "traycer_get_self", arguments: {} },
      });
      expect(self.body).toEqual({
        jsonrpc: "2.0",
        id: 51,
        result: {
          content: [
            {
              type: "text",
              text: [
                "caller-agent",
                "title: Caller",
                "archived: yes",
                "surface: gui",
                "harness: codex",
                "host: host-local",
                "dir: /repo",
              ].join("\n"),
            },
          ],
        },
      });

      const invalid = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 52,
        method: "tools/call",
        params: {
          name: "traycer_list_agents",
          arguments: { scope: "team" },
        },
      });
      expect(invalid.body).toEqual({
        jsonrpc: "2.0",
        id: 52,
        result: {
          content: [
            {
              type: "text",
              text: "traycer_list_agents scope must be 'user' or 'all'.",
            },
          ],
          isError: true,
        },
      });
      const transcript = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 53,
        method: "tools/call",
        params: {
          name: "traycer_get_transcript",
          arguments: { agentId: "target" },
        },
      });
      expect(transcript.body).toEqual({
        jsonrpc: "2.0",
        id: 53,
        result: {
          content: [{ type: "text", text: "transcript pointer" }],
        },
      });
      const invalidTranscript = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 54,
        method: "tools/call",
        params: {
          name: "traycer_get_transcript",
          arguments: { agentId: 42 },
        },
      });
      expect(invalidTranscript.body).toEqual({
        jsonrpc: "2.0",
        id: 54,
        result: {
          content: [
            {
              type: "text",
              text: "traycer_get_transcript requires string agentId.",
            },
          ],
          isError: true,
        },
      });
      expect(listRequests).toEqual([
        {
          senderAgentId: "caller-agent",
          epicId: "epic-directory-tool",
          scope: "user",
        },
      ]);
      expect(transcriptRequests).toEqual([
        {
          senderAgentId: "caller-agent",
          epicId: "epic-directory-tool",
          agentId: "target",
        },
      ]);
    } finally {
      session.dispose();
      await bridge.close();
    }
  });

  it("rejects an incorrect Bearer token", async () => {
    const bridge = await startAgentA2AMcpBridge(
      () => ({
        ok: true,
        result: { responseId: null },
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    const session = bridge.openSession({
      agentId: "bearer-agent",
      epicId: "epic-a2a",
    });

    try {
      const rejected = await postMcp(
        session.url,
        "incorrect-token",
        initializeRequest(10),
      );
      expect(rejected).toEqual({
        status: 401,
        sessionId: null,
        body: { error: "Unauthorized" },
      });
    } finally {
      session.dispose();
      await bridge.close();
    }
  });

  it("configures an agent with the authenticated caller identity", async () => {
    const configureRequests: unknown[] = [];
    const forkRequests: unknown[] = [];
    const listCommentRequests: unknown[] = [];
    const setCommentStatusRequests: unknown[] = [];
    const bridge = await startAgentA2AMcpBridge(
      () => ({ ok: true, result: { responseId: null } }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        configure: (request) => {
          configureRequests.push(request);
          return {
            settings: {
              harnessId: "codex",
              model: "gpt-5.4",
              profileSelection: { kind: "ambient" },
              reasoningEffort: null,
              fastMode: false,
              permissionMode: "full_access",
              agentMode: "regular",
            },
            warnings: [],
          };
        },
        fork: (request) => {
          forkRequests.push(request);
          return {
            agentId: "forked-agent",
            sourceAgentId: "target-agent",
            forkedFromMessageId: "assistant-checkpoint",
            warnings: [],
            effectiveProfileId: null,
            profileOverrideApplied: false,
          };
        },
        comments: {
          list: (request) => {
            listCommentRequests.push(request);
            return { artifacts: [] };
          },
          setStatus: (request) => {
            setCommentStatusRequests.push(request);
            return {
              updated: [
                {
                  artifactPath: "/tmp/spec/index.md",
                  threadId: "thread-1",
                  status: "resolved" as const,
                },
              ],
              failed: [],
            };
          },
        },
      },
    );
    const session = bridge.openSession({
      agentId: "caller-agent",
      epicId: "epic-configure",
    });

    try {
      const listed = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 20,
        method: "tools/list",
        params: {},
      });
      expect(
        toolFromListResponseByName(listed.body, "traycer_configure_agent"),
      ).toMatchObject({
        name: "traycer_configure_agent",
        inputSchema: {
          type: "object",
          required: ["agentId", "harnessId", "model", "profile"],
        },
      });
      expect(
        toolFromListResponseByName(listed.body, "traycer_fork_agent"),
      ).toMatchObject({
        name: "traycer_fork_agent",
        inputSchema: { type: "object", required: ["agentId"] },
      });
      expect(
        toolFromListResponseByName(listed.body, "traycer_list_comment_threads"),
      ).toMatchObject({ name: "traycer_list_comment_threads" });
      expect(
        toolFromListResponseByName(
          listed.body,
          "traycer_set_comment_thread_status",
        ),
      ).toMatchObject({
        name: "traycer_set_comment_thread_status",
        inputSchema: { required: ["updates"] },
      });

      const configured = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: {
          name: "traycer_configure_agent",
          arguments: {
            agentId: "target-agent",
            harnessId: "codex",
            model: "gpt-5.4",
            profile: "ambient",
          },
        },
      });
      expect(configured.body).toEqual({
        jsonrpc: "2.0",
        id: 21,
        result: {
          content: [
            {
              type: "text",
              text: [
                "Agent target-agent configured for future turns:",
                "harness: codex",
                "model: gpt-5.4",
                "profile: --profile ambient",
                "reasoningEffort: -",
                "fastMode: off",
                "permissionMode: full_access",
                "agentMode: regular",
              ].join("\n"),
            },
          ],
        },
      });
      expect(configureRequests).toEqual([
        {
          epicId: "epic-configure",
          senderAgentId: "caller-agent",
          agentId: "target-agent",
          harnessId: "codex",
          model: "gpt-5.4",
          profileSelection: { kind: "ambient" },
          reasoningEffort: null,
          fastMode: false,
          permissionMode: "full_access",
          workspace: null,
        },
      ]);

      const forked = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 22,
        method: "tools/call",
        params: {
          name: "traycer_fork_agent",
          arguments: {
            agentId: "target-agent",
            name: "Checkpoint fork",
          },
        },
      });
      const forkResponse = {
        agentId: "forked-agent",
        sourceAgentId: "target-agent",
        forkedFromMessageId: "assistant-checkpoint",
        warnings: [],
        effectiveProfileId: null,
        profileOverrideApplied: false,
      };
      expect(forked.body).toEqual({
        jsonrpc: "2.0",
        id: 22,
        result: {
          content: [{ type: "text", text: JSON.stringify(forkResponse) }],
        },
      });
      expect(forkRequests).toEqual([
        {
          epicId: "epic-configure",
          senderAgentId: "caller-agent",
          agentId: "target-agent",
          name: "Checkpoint fork",
          permissionMode: "full_access",
          workspace: null,
          profileSelection: { kind: "inherit" },
        },
      ]);

      const comments = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 23,
        method: "tools/call",
        params: {
          name: "traycer_list_comment_threads",
          arguments: { artifactPaths: null, status: null },
        },
      });
      expect(comments.body).toEqual({
        jsonrpc: "2.0",
        id: 23,
        result: {
          content: [{ type: "text", text: "No comments found in the epic." }],
        },
      });
      const status = await postMcp(session.url, session.token, {
        jsonrpc: "2.0",
        id: 24,
        method: "tools/call",
        params: {
          name: "traycer_set_comment_thread_status",
          arguments: {
            updates: [
              {
                artifactPath: "/tmp/spec/index.md",
                threadIds: ["thread-1"],
                status: "resolved",
              },
            ],
          },
        },
      });
      expect(status.body).toEqual({
        jsonrpc: "2.0",
        id: 24,
        result: {
          content: [{ type: "text", text: "Updated status for 1 threads." }],
        },
      });
      expect(listCommentRequests).toEqual([
        { epicId: "epic-configure", artifactPaths: null, status: "all" },
      ]);
      expect(setCommentStatusRequests).toEqual([
        {
          epicId: "epic-configure",
          updates: [
            {
              artifactPath: "/tmp/spec/index.md",
              threadIds: ["thread-1"],
              status: "resolved",
            },
          ],
        },
      ]);
    } finally {
      session.dispose();
      await bridge.close();
    }
  });

  it("rejects a non-loopback Origin", async () => {
    const bridge = await startAgentA2AMcpBridge(
      () => ({
        ok: true,
        result: { responseId: null },
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    const session = bridge.openSession({
      agentId: "origin-agent",
      epicId: "epic-a2a",
    });

    try {
      const rejected = await postMcpWithOrigin(
        session.url,
        session.token,
        "https://attacker.example",
        initializeRequest(11),
      );
      expect(rejected).toEqual({
        status: 403,
        sessionId: null,
        body: { error: "Forbidden" },
      });
    } finally {
      session.dispose();
      await bridge.close();
    }
  });

  it("revokes an agent Bearer when its session is released", async () => {
    const bridge = await startAgentA2AMcpBridge(
      () => ({
        ok: true,
        result: { responseId: null },
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    const session = bridge.openSession({
      agentId: "revoked-agent",
      epicId: "epic-a2a",
    });

    try {
      const accepted = await postMcp(
        session.url,
        session.token,
        initializeRequest(12),
      );
      expect(accepted.status).toBe(200);

      bridge.releaseSession({
        agentId: "revoked-agent",
        epicId: "epic-a2a",
      });
      const rejected = await postMcp(
        session.url,
        session.token,
        initializeRequest(13),
      );
      expect(rejected).toEqual({
        status: 401,
        sessionId: null,
        body: { error: "Unauthorized" },
      });
    } finally {
      session.dispose();
      await bridge.close();
    }
  });

  it("isolates the same agent id across epics and revokes only the exact identity", async () => {
    const sendRequests: unknown[] = [];
    const bridge = await startAgentA2AMcpBridge(
      (request) => {
        sendRequests.push(request);
        return { ok: true, result: { responseId: null } };
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    const epicA = bridge.openSession({
      agentId: "shared-agent",
      epicId: "epic-a",
    });
    const epicB = bridge.openSession({
      agentId: "shared-agent",
      epicId: "epic-b",
    });

    try {
      expect(epicA.token).not.toBe(epicB.token);

      const sentFromA = await postMcp(
        epicA.url,
        epicA.token,
        sendMessageRequest(20, "from epic A"),
      );
      const sentFromB = await postMcp(
        epicB.url,
        epicB.token,
        sendMessageRequest(21, "from epic B"),
      );
      expect(sentFromA.status).toBe(200);
      expect(sentFromB.status).toBe(200);
      expect(sendRequests).toEqual([
        expect.objectContaining({
          senderAgentId: "shared-agent",
          epicId: "epic-a",
          prompt: "from epic A",
        }),
        expect.objectContaining({
          senderAgentId: "shared-agent",
          epicId: "epic-b",
          prompt: "from epic B",
        }),
      ]);

      bridge.releaseSession({
        agentId: "shared-agent",
        epicId: "epic-a",
      });
      const revokedA = await postMcp(
        epicA.url,
        epicA.token,
        initializeRequest(22),
      );
      expect(revokedA).toEqual({
        status: 401,
        sessionId: null,
        body: { error: "Unauthorized" },
      });

      const stillSentFromB = await postMcp(
        epicB.url,
        epicB.token,
        sendMessageRequest(23, "still from epic B"),
      );
      expect(stillSentFromB.status).toBe(200);
      expect(sendRequests.at(-1)).toEqual(
        expect.objectContaining({
          senderAgentId: "shared-agent",
          epicId: "epic-b",
          prompt: "still from epic B",
        }),
      );
    } finally {
      epicA.dispose();
      epicB.dispose();
      await bridge.close();
    }
  });
});

async function postMcp(
  url: string,
  token: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<{
  readonly status: number;
  readonly sessionId: string | null;
  readonly body: unknown;
}> {
  return await postMcpWithOrigin(url, token, null, payload);
}

async function postMcpWithOrigin(
  url: string,
  token: string,
  origin: string | null,
  payload: Readonly<Record<string, unknown>>,
): Promise<{
  readonly status: number;
  readonly sessionId: string | null;
  readonly body: unknown;
}> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
  if (origin !== null) {
    headers.Origin = origin;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  return {
    status: response.status,
    sessionId: response.headers.get("mcp-session-id"),
    body: parseMcpBody(await response.text()),
  };
}

function initializeRequest(id: number): Readonly<Record<string, unknown>> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "bridge-security-test", version: "1.0.0" },
    },
  };
}

function sendMessageRequest(
  id: number,
  message: string,
): Readonly<Record<string, unknown>> {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "traycer_send_message",
      arguments: { toAgentId: "receiver-agent", message },
    },
  };
}

function parseMcpBody(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const data = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .find((line) => line.length > 0);
    if (data === undefined) {
      throw new Error("MCP response was neither JSON nor SSE JSON");
    }
    return JSON.parse(data);
  }
}

function toolFromListResponse(body: unknown): unknown {
  if (
    typeof body !== "object" ||
    body === null ||
    !("result" in body) ||
    typeof body.result !== "object" ||
    body.result === null ||
    !("tools" in body.result) ||
    !Array.isArray(body.result.tools)
  ) {
    throw new Error("Expected an MCP tools/list response");
  }
  return body.result.tools[0];
}

function toolFromListResponseByName(body: unknown, name: string): unknown {
  if (
    typeof body !== "object" ||
    body === null ||
    !("result" in body) ||
    typeof body.result !== "object" ||
    body.result === null ||
    !("tools" in body.result) ||
    !Array.isArray(body.result.tools)
  ) {
    throw new Error("Expected an MCP tools/list response");
  }
  return body.result.tools.find(
    (tool) =>
      typeof tool === "object" &&
      tool !== null &&
      "name" in tool &&
      tool.name === name,
  );
}
