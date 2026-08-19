import { randomUUID } from "node:crypto";
import { statSync, type Stats } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { isAbsolute } from "node:path";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  type AgentSelectionGuideResponse,
  type ListAgentsRequest,
  type ListAgentsResponse,
  type GetAgentTranscriptResponse,
  type ForkAgentRequest,
  type ForkAgentResponse,
  agentFacingHarnessIdSchema,
  type CreateAgentRequestV30,
  type CreateAgentResponse,
  type CreateAgentWorkspace,
  sendAgentMessageResponseSchema,
  type SendAgentMessageRequest,
  guiHarnessIdSchemaV60,
} from "@traycer/protocol/host/agent/shared";
import {
  worktreeCreatePathsRequestSchemaV10,
  type WorktreeCreatePathsRequest,
  type WorktreeCreatePathsResponse,
} from "@traycer/protocol/host/worktree-schemas";
import { permissionModeSchema } from "@traycer/protocol/persistence/epic/foundation";
import { formatAgentSelectionGuideResponse } from "@traycer/protocol/agent/agent-selection-guide-format";
import { formatListHarnessModelsResponse } from "@traycer/protocol/agent/agent-harness-models";
import {
  formatAgentProviderProfileRateLimitsResponse,
  formatAgentConfigureResponse,
  formatAgentProviderProfilesResponse,
} from "@traycer/protocol/agent/agent-profile-format";
import type {
  AgentConfigureRequestV20,
  AgentConfigureResponse,
} from "@traycer/protocol/host/agent/profiles";
import {
  formatAgentListResponse,
  formatAgentSelf,
} from "@traycer/protocol/agent/agent-list-format";
import {
  commentThreadStatusFilterSchema,
  commentThreadStatusSchema,
  type CommentsListThreadsRequest,
  type CommentsListThreadsResponse,
  type CommentsSetThreadStatusRequest,
  type CommentsSetThreadStatusResponse,
} from "@traycer/protocol/host/comments";
import {
  formatCommentsListThreadsXml,
  formatCommentsSetThreadStatusResponse,
} from "@traycer/protocol/comments/comments-xml-formatting";
import type {
  AgentA2AMcpLaunchContext,
  TurnRequest,
  TurnRunner,
} from "./cli-runner";
import type { HandlerResult } from "./handlers";
import { localHarnessModelSummariesFor } from "./gui-model-catalog";
import {
  localProviderProfilesFor,
  localProviderRateLimitsFor,
} from "./local-provider-profiles";

type AgentA2AMcpIdentity = {
  readonly agentId: string;
  readonly epicId: string;
};

type AgentA2AMcpSession = AgentA2AMcpLaunchContext & {
  readonly dispose: () => void;
};

export type AgentA2AMcpBridge = {
  readonly openSession: (identity: AgentA2AMcpIdentity) => AgentA2AMcpSession;
  readonly releaseSession: (identity: AgentA2AMcpIdentity) => void;
  readonly releaseEpic: (epicId: string) => void;
  readonly close: () => Promise<void>;
};

export type AgentA2AMcpSend = (
  request: SendAgentMessageRequest,
) => HandlerResult | Promise<HandlerResult>;

export type AgentA2AMcpStopRequest = {
  readonly senderAgentId: string;
  readonly epicId: string;
  readonly agentId: string;
  readonly cascade: boolean;
  readonly archive: boolean;
};

export type AgentA2AMcpStop = (
  request: AgentA2AMcpStopRequest,
) => HandlerResult | Promise<HandlerResult>;

export type AgentA2AMcpArchiveRequest = {
  readonly senderAgentId: string;
  readonly epicId: string;
  readonly agentId: string;
};

export type AgentA2AMcpArchive = (
  request: AgentA2AMcpArchiveRequest,
) => HandlerResult | Promise<HandlerResult>;

export type AgentA2AMcpList = (
  request: ListAgentsRequest,
) => ListAgentsResponse | Promise<ListAgentsResponse>;

export type AgentA2AMcpGetTranscriptRequest = {
  readonly senderAgentId: string;
  readonly epicId: string;
  readonly agentId: string;
};

export type AgentA2AMcpGetTranscript = (
  request: AgentA2AMcpGetTranscriptRequest,
) => GetAgentTranscriptResponse | Promise<GetAgentTranscriptResponse>;

export type AgentA2AMcpCreate = (
  request: CreateAgentRequestV30,
) => CreateAgentResponse | Promise<CreateAgentResponse>;

export type AgentA2AMcpSelectionGuide = (
  request: AgentA2AMcpIdentity,
) => AgentSelectionGuideResponse | Promise<AgentSelectionGuideResponse>;

export type AgentA2AMcpWorkspaceTools = {
  readonly list: (request: AgentA2AMcpIdentity) => unknown | Promise<unknown>;
  readonly create: (
    request: WorktreeCreatePathsRequest,
  ) => WorktreeCreatePathsResponse | Promise<WorktreeCreatePathsResponse>;
};

export type AgentA2AMcpConfigure = (
  request: AgentConfigureRequestV20 & {
    readonly workspace: CreateAgentWorkspace | null;
  },
) => AgentConfigureResponse | Promise<AgentConfigureResponse>;

export type AgentA2AMcpManagementTools = {
  readonly configure: AgentA2AMcpConfigure | undefined;
  readonly fork:
    | ((
        request: ForkAgentRequest,
      ) => ForkAgentResponse | Promise<ForkAgentResponse>)
    | undefined;
  readonly comments:
    | {
        readonly list: (
          request: CommentsListThreadsRequest,
        ) => CommentsListThreadsResponse | Promise<CommentsListThreadsResponse>;
        readonly setStatus: (
          request: CommentsSetThreadStatusRequest,
        ) =>
          | CommentsSetThreadStatusResponse
          | Promise<CommentsSetThreadStatusResponse>;
      }
    | undefined;
};

const SEND_MESSAGE_DESCRIPTION =
  "Send a message to another Traycer agent in this epic. Delivery is asynchronous: this call returns as soon as the message is queued, and any reply arrives later as a new incoming message - never as this tool's result. A pending reply is not a reason to hold your turn open or to poll the peer.";

const SEND_MESSAGE_TOOL = {
  name: "traycer_send_message",
  description: SEND_MESSAGE_DESCRIPTION,
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
} satisfies Tool;

const CREATE_AGENT_TOOL = {
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
} satisfies Tool;

const AGENT_SELECTION_GUIDE_TOOL = {
  name: "traycer_agent_selection_guide",
  description:
    "Get the instructions for the agent selection guide. Instructs which child agents to create for different kinds of tasks. Read it before creating or reconfiguring a child agent.",
  inputSchema: { type: "object", properties: {} },
} satisfies Tool;

const LIST_EPIC_WORKSPACES_TOOL = {
  name: "traycer_list_epic_workspaces",
  description:
    "List this epic's workspace folders and existing Git worktrees. Use it to find the source workspace path for traycer_create_worktree.",
  inputSchema: { type: "object", properties: {} },
} satisfies Tool;

const CREATE_WORKTREE_TOOL = {
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
} satisfies Tool;

const LIST_HARNESS_MODELS_TOOL = {
  name: "traycer_list_harness_models",
  description:
    "List the available models (and available params) for a harness.",
  inputSchema: {
    type: "object",
    required: ["harnessId"],
    properties: {
      harnessId: {
        anyOf: guiHarnessIdSchemaV60.options.map((harnessId) => ({
          type: "string" as const,
          const: harnessId,
        })),
        description: "Harness id to list models for.",
      },
    },
  },
} satisfies Tool;

const LIST_PROVIDER_PROFILES_TOOL = {
  name: "traycer_list_provider_profiles",
  description:
    "Discover the provider profiles (ambient login plus any managed subscriptions) available for a harness, with cached rate-limit health and which one is currently the caller's effective default.",
  inputSchema: {
    type: "object",
    required: ["harnessId"],
    properties: {
      harnessId: {
        anyOf: guiHarnessIdSchemaV60.options.map((harnessId) => ({
          type: "string" as const,
          const: harnessId,
        })),
        description: "Harness id to discover provider profiles for.",
      },
    },
  },
} satisfies Tool;

const GET_PROVIDER_PROFILE_RATE_LIMITS_TOOL = {
  name: "traycer_get_provider_profile_rate_limits",
  description:
    "Read the current rate-limit usage for one concrete provider profile (ambient or a specific managed profile) on a harness. The result is served from a short-lived cache when a recent read exists, so it is safe to call repeatedly and never forces a burst of CLI spawns or usage-endpoint hits; the returned usageUpdatedAt is when the usage was captured. Use traycer_list_provider_profiles first to discover available selections.",
  inputSchema: {
    type: "object",
    required: ["harnessId", "profile"],
    properties: {
      harnessId: {
        anyOf: guiHarnessIdSchemaV60.options.map((harnessId) => ({
          type: "string" as const,
          const: harnessId,
        })),
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
} satisfies Tool;

const CONFIGURE_AGENT_TOOL = {
  name: "traycer_configure_agent",
  description:
    "Atomically switch the harness, model, provider profile, reasoning effort, fast mode, and permission mode an existing GUI agent (including yourself) uses from its NEXT turn onward, and optionally rebind its workspace/worktree. The agent's in-progress turn and anything already queued keep the settings they started with; nothing is interrupted, restarted, or re-run. A workspace rebind is refused while the agent is running a turn - use traycer_fork_agent to fork it from its latest checkpoint into the new worktree instead. Terminal agents cannot be reconfigured in place. Use `full_access` unless the user's agent selection guide explicitly instructs you to use `supervised` or `auto_accept_edits`; never infer a more restrictive permission mode from the task, the current or parent agent's mode, or a general safety preference. Omit permissionMode otherwise. Fast mode may consume additional credits - enable it only when the user asks for it or the agent selection guide recommends it.",
  inputSchema: {
    type: "object",
    required: ["agentId", "harnessId", "model", "profile"],
    properties: {
      agentId: {
        type: "string",
        minLength: 1,
        description:
          "Existing GUI agent to reconfigure. May be your own agent id; an unambiguous id prefix of at least 4 characters is accepted.",
      },
      harnessId: {
        anyOf: guiHarnessIdSchemaV60.options.map((harnessId) => ({
          type: "string" as const,
          const: harnessId,
        })),
        description: "Harness the agent should run on from its next turn.",
      },
      model: {
        type: "string",
        minLength: 1,
        description:
          "Model the agent should run from its next turn. Must be available for harnessId (see traycer_list_harness_models).",
      },
      profile: {
        type: "string",
        minLength: 1,
        description:
          'Concrete profile selection: the literal "ambient", or a managed profile id returned by traycer_list_provider_profiles.',
      },
      reasoningEffort: {
        anyOf: [{ type: "string" }, { type: "null" }],
        description:
          "Reasoning effort for supported models. Omit or pass null for the model's default; an unsupported value is dropped with a warning.",
      },
      fastMode: {
        anyOf: [{ type: "boolean" }, { type: "null" }],
        description:
          "Run supported models in fast mode. Omit or pass null to turn it off; an unsupported value is dropped with a warning. May consume additional credits - turn it on only when the user asks for it or the agent selection guide recommends it.",
      },
      permissionMode: {
        anyOf: [
          { type: "string", const: "full_access" },
          { type: "string", const: "supervised" },
          { type: "string", const: "auto_accept_edits" },
          { type: "null" },
        ],
        description:
          "Permission mode for future turns. Use `full_access` unless the user's agent selection guide explicitly instructs you to use `supervised` or `auto_accept_edits`; never infer a more restrictive permission mode from the task, the current or parent agent's mode, or a general safety preference. Omit or pass null to use `full_access`.",
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
          "Optional directories to rebind the agent to from its next turn. Forward each `path` returned by traycer_create_worktree, or pass existing absolute folders; the first entry is the primary working directory. Refused while the agent is running a turn - use traycer_fork_agent then. Omit or pass null to leave the workspace unchanged.",
      },
    },
  },
} satisfies Tool;

const FORK_AGENT_TOOL = {
  name: "traycer_fork_agent",
  description:
    "Fork an existing agent (including yourself) into a NEW agent seeded from the source's latest available checkpoint. A GUI fork inherits the source's run configuration except for permission mode. Use `full_access` unless the user's agent selection guide explicitly instructs you to use `supervised` or `auto_accept_edits`; never infer a more restrictive permission mode from the task, the current or parent agent's mode, or a general safety preference. Omit permissionMode otherwise; it is ignored for terminal forks. A GUI agent forks its transcript through the last persisted assistant message; a Claude Code terminal agent forks its provider session (other terminal harnesses have no native session fork and are refused). The source keeps running untouched; forking a mid-turn agent is supported. Optionally bind the fork to a different workspace/worktree; omit workspace to inherit the source's directories. Use this when traycer_configure_agent refuses a workspace change because a turn is running, or to branch work. Returns the new agent id - send it a message with traycer_send_message to start it.",
  inputSchema: {
    type: "object",
    required: ["agentId"],
    properties: {
      agentId: {
        type: "string",
        minLength: 1,
        description:
          "Existing GUI agent, or Claude Code terminal agent, to fork. May be your own agent id; an unambiguous id prefix of at least 4 characters is accepted. A mid-turn source is fine - the fork takes its latest persisted checkpoint.",
      },
      name: {
        anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
        description: "Display name for the forked agent.",
      },
      permissionMode:
        CONFIGURE_AGENT_TOOL.inputSchema.properties.permissionMode,
      workspace: {
        ...CONFIGURE_AGENT_TOOL.inputSchema.properties.workspace,
        description:
          "Optional directories to bind the fork to. Forward each `path` returned by traycer_create_worktree, or pass existing absolute folders; the first entry is the primary working directory. Omit to inherit the source agent's directories.",
      },
    },
  },
} satisfies Tool;

const LIST_COMMENT_THREADS_TOOL = {
  name: "traycer_list_comment_threads",
  description:
    "List Traycer artifact comment threads for this epic. Use this after reading artifacts so human-authored feedback is visible before editing or responding. A thread may quote the artifact text it refers to: anchor=present means that quote is still located in the current artifact, while anchor=missing or anchor=unavailable means the quote is context only - verify it against the artifact before acting on it.",
  inputSchema: {
    type: "object",
    properties: {
      artifactPaths: {
        anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
        description:
          "Absolute artifact paths. Pass null or omit to list comments for all artifacts in this epic.",
      },
      status: {
        anyOf: [
          { type: "string", const: "all" },
          { type: "string", const: "open" },
          { type: "string", const: "resolved" },
          { type: "null" },
        ],
        description: "Thread status filter. Defaults to all.",
      },
    },
  },
} satisfies Tool;

const SET_COMMENT_THREAD_STATUS_TOOL = {
  name: "traycer_set_comment_thread_status",
  description:
    "Set Traycer artifact comment threads to open or resolved after addressing or reopening feedback. Prefer telling the user which threads look addressed and letting them decide, unless they have already asked you to resolve threads yourself.",
  inputSchema: {
    type: "object",
    required: ["updates"],
    properties: {
      updates: {
        type: "array",
        items: {
          type: "object",
          required: ["artifactPath", "threadIds", "status"],
          properties: {
            artifactPath: {
              type: "string",
              description: "Absolute artifact path.",
            },
            threadIds: {
              type: "array",
              items: { type: "string" },
              description: "Comment thread ids scoped to this artifact.",
            },
            status: {
              anyOf: [
                { type: "string", const: "open" },
                { type: "string", const: "resolved" },
              ],
              description: "Status to set for the listed threads.",
            },
          },
        },
        description: "Batch of artifact-scoped thread status updates.",
      },
    },
  },
} satisfies Tool;

const STOP_AGENT_TOOL = {
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
} satisfies Tool;

const ARCHIVE_AGENT_TOOL = {
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
} satisfies Tool;

const LIST_AGENTS_TOOL = {
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
} satisfies Tool;

const GET_SELF_TOOL = {
  name: "traycer_get_self",
  description:
    "Get this Traycer agent's identity - your own agent id, title, surface, harness, host and working directory. The id is what traycer_configure_agent and traycer_fork_agent need to target yourself.",
  inputSchema: { type: "object", properties: {} },
} satisfies Tool;

const GET_TRANSCRIPT_TOOL = {
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
} satisfies Tool;

export async function startAgentA2AMcpBridge(
  sendMessage: AgentA2AMcpSend,
  stopAgent: AgentA2AMcpStop | undefined,
  archiveAgent: AgentA2AMcpArchive | undefined,
  listAgents: AgentA2AMcpList | undefined,
  getTranscript: AgentA2AMcpGetTranscript | undefined,
  createAgent: AgentA2AMcpCreate | undefined,
  selectionGuide: AgentA2AMcpSelectionGuide | undefined,
  workspaceTools: AgentA2AMcpWorkspaceTools | undefined,
  managementTools: AgentA2AMcpManagementTools | undefined,
): Promise<AgentA2AMcpBridge> {
  const identities = new Map<string, AgentA2AMcpIdentity>();
  const tokensBySessionKey = new Map<string, string>();
  const activeRequestClosers = new Set<() => void>();
  let closed = false;
  const httpServer = createServer((request, response) => {
    void handleMcpRequest({
      request,
      response,
      identities,
      sendMessage,
      stopAgent,
      archiveAgent,
      listAgents,
      getTranscript,
      createAgent,
      selectionGuide,
      workspaceTools,
      managementTools,
      activeRequestClosers,
    }).catch(() => {
      if (!response.headersSent) {
        writeJson(response, 500, {
          jsonrpc: "2.0",
          error: { code: -32_603, message: "Internal server error" },
          id: null,
        });
        return;
      }
      response.destroy();
    });
  });
  const port = await listen(httpServer);
  const url = `http://127.0.0.1:${String(port)}/mcp`;

  return {
    openSession(identity): AgentA2AMcpSession {
      if (closed) {
        throw new Error("Traycer A2A MCP bridge is closed");
      }
      const sessionKey = agentSessionKey(identity);
      const token = tokensBySessionKey.get(sessionKey) ?? randomUUID();
      tokensBySessionKey.set(sessionKey, token);
      identities.set(token, identity);
      return {
        url,
        token,
        dispose(): void {
          // The provider session may issue a final MCP call while its turn is
          // settling. Keep the agent-scoped lease alive across resumed turns;
          // chat deletion or host shutdown owns revocation.
        },
      };
    },
    releaseSession(identity): void {
      const sessionKey = agentSessionKey(identity);
      const token = tokensBySessionKey.get(sessionKey);
      if (token === undefined) {
        return;
      }
      tokensBySessionKey.delete(sessionKey);
      identities.delete(token);
    },
    releaseEpic(epicId): void {
      for (const [sessionKey, token] of tokensBySessionKey) {
        if (identities.get(token)?.epicId !== epicId) {
          continue;
        }
        tokensBySessionKey.delete(sessionKey);
        identities.delete(token);
      }
    },
    close(): Promise<void> {
      if (closed) {
        return Promise.resolve();
      }
      closed = true;
      identities.clear();
      tokensBySessionKey.clear();
      for (const closeRequest of activeRequestClosers) {
        closeRequest();
      }
      activeRequestClosers.clear();
      return closeServer(httpServer);
    },
  };
}

function agentSessionKey(identity: AgentA2AMcpIdentity): string {
  return JSON.stringify([identity.epicId, identity.agentId]);
}

export function wrapTurnRunnerWithAgentA2A(
  runner: TurnRunner,
  bridge: AgentA2AMcpBridge,
): TurnRunner {
  return {
    async run(request, emit) {
      const identity = request.traycerAgentEnv;
      if (identity === undefined) {
        return await runner.run(request, emit);
      }
      const session = bridge.openSession({
        agentId: identity.agentId,
        epicId: identity.epicId,
      });
      try {
        const wrappedRequest: TurnRequest = {
          ...request,
          traycerA2AMcp: { url: session.url, token: session.token },
        };
        return await runner.run(wrappedRequest, emit);
      } finally {
        session.dispose();
      }
    },
  };
}

async function handleMcpRequest(args: {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly identities: ReadonlyMap<string, AgentA2AMcpIdentity>;
  readonly sendMessage: AgentA2AMcpSend;
  readonly stopAgent: AgentA2AMcpStop | undefined;
  readonly archiveAgent: AgentA2AMcpArchive | undefined;
  readonly listAgents: AgentA2AMcpList | undefined;
  readonly getTranscript: AgentA2AMcpGetTranscript | undefined;
  readonly createAgent: AgentA2AMcpCreate | undefined;
  readonly selectionGuide: AgentA2AMcpSelectionGuide | undefined;
  readonly workspaceTools: AgentA2AMcpWorkspaceTools | undefined;
  readonly managementTools: AgentA2AMcpManagementTools | undefined;
  readonly activeRequestClosers: Set<() => void>;
}): Promise<void> {
  if (pathnameOf(args.request.url) !== "/mcp") {
    writeJson(args.response, 404, { error: "Not found" });
    return;
  }
  if (!hasExpectedLoopbackHost(args.request)) {
    writeJson(args.response, 403, { error: "Forbidden" });
    return;
  }
  if (!hasAllowedOrigin(args.request)) {
    writeJson(args.response, 403, { error: "Forbidden" });
    return;
  }
  const token = bearerToken(args.request.headers.authorization);
  const identity = token === null ? undefined : args.identities.get(token);
  if (identity === undefined) {
    writeJson(args.response, 401, { error: "Unauthorized" });
    return;
  }

  const mcpServer = createAgentMcpServer(
    identity,
    args.sendMessage,
    args.stopAgent,
    args.archiveAgent,
    args.listAgents,
    args.getTranscript,
    args.createAgent,
    args.selectionGuide,
    args.workspaceTools,
    args.managementTools,
  );
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  let closed = false;
  const closeRequest = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    args.activeRequestClosers.delete(closeRequest);
    void Promise.all([transport.close(), mcpServer.close()]).catch(() => {
      return;
    });
  };
  args.activeRequestClosers.add(closeRequest);
  args.response.once("finish", closeRequest);
  args.response.once("close", closeRequest);

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(args.request, args.response);
  } catch {
    closeRequest();
    if (!args.response.headersSent) {
      writeJson(args.response, 500, {
        jsonrpc: "2.0",
        error: { code: -32_603, message: "Internal server error" },
        id: null,
      });
      return;
    }
    args.response.destroy();
  }
}

function createAgentMcpServer(
  identity: AgentA2AMcpIdentity,
  sendMessage: AgentA2AMcpSend,
  stopAgent: AgentA2AMcpStop | undefined,
  archiveAgent: AgentA2AMcpArchive | undefined,
  listAgents: AgentA2AMcpList | undefined,
  getTranscript: AgentA2AMcpGetTranscript | undefined,
  createAgent: AgentA2AMcpCreate | undefined,
  selectionGuide: AgentA2AMcpSelectionGuide | undefined,
  workspaceTools: AgentA2AMcpWorkspaceTools | undefined,
  managementTools: AgentA2AMcpManagementTools | undefined,
): McpServer {
  const server = new McpServer(
    { name: "traycer-a2a", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      ...(createAgent === undefined ? [] : [CREATE_AGENT_TOOL]),
      SEND_MESSAGE_TOOL,
      ...(selectionGuide === undefined ? [] : [AGENT_SELECTION_GUIDE_TOOL]),
      ...(workspaceTools === undefined
        ? []
        : [LIST_EPIC_WORKSPACES_TOOL, CREATE_WORKTREE_TOOL]),
      ...(listAgents === undefined ? [] : [LIST_AGENTS_TOOL, GET_SELF_TOOL]),
      ...(getTranscript === undefined ? [] : [GET_TRANSCRIPT_TOOL]),
      LIST_HARNESS_MODELS_TOOL,
      LIST_PROVIDER_PROFILES_TOOL,
      GET_PROVIDER_PROFILE_RATE_LIMITS_TOOL,
      ...(managementTools?.configure === undefined
        ? []
        : [CONFIGURE_AGENT_TOOL]),
      ...(managementTools?.fork === undefined ? [] : [FORK_AGENT_TOOL]),
      ...(managementTools?.comments === undefined
        ? []
        : [LIST_COMMENT_THREADS_TOOL, SET_COMMENT_THREAD_STATUS_TOOL]),
      ...(archiveAgent === undefined ? [] : [ARCHIVE_AGENT_TOOL]),
      ...(stopAgent === undefined ? [] : [STOP_AGENT_TOOL]),
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return await callAgentTool(
      identity,
      sendMessage,
      stopAgent,
      archiveAgent,
      listAgents,
      getTranscript,
      createAgent,
      selectionGuide,
      workspaceTools,
      managementTools,
      request.params.name,
      request.params.arguments,
    );
  });
  return server;
}

async function callAgentTool(
  identity: AgentA2AMcpIdentity,
  sendMessage: AgentA2AMcpSend,
  stopAgent: AgentA2AMcpStop | undefined,
  archiveAgent: AgentA2AMcpArchive | undefined,
  listAgents: AgentA2AMcpList | undefined,
  getTranscript: AgentA2AMcpGetTranscript | undefined,
  createAgent: AgentA2AMcpCreate | undefined,
  selectionGuide: AgentA2AMcpSelectionGuide | undefined,
  workspaceTools: AgentA2AMcpWorkspaceTools | undefined,
  managementTools: AgentA2AMcpManagementTools | undefined,
  name: string,
  rawArguments: Readonly<Record<string, unknown>> | undefined,
): Promise<CallToolResult> {
  if (name === "traycer_create_agent" && createAgent !== undefined) {
    return await callCreateAgentTool(identity, createAgent, rawArguments);
  }
  if (
    name === "traycer_agent_selection_guide" &&
    selectionGuide !== undefined
  ) {
    return await callAgentSelectionGuideTool(identity, selectionGuide);
  }
  if (name === "traycer_list_epic_workspaces" && workspaceTools !== undefined) {
    return await callListEpicWorkspacesTool(identity, workspaceTools.list);
  }
  if (name === "traycer_create_worktree" && workspaceTools !== undefined) {
    return await callCreateWorktreeTool(workspaceTools.create, rawArguments);
  }
  if (name === "traycer_stop_agent" && stopAgent !== undefined) {
    return await callStopAgentTool(identity, stopAgent, rawArguments);
  }
  if (name === "traycer_archive_agent" && archiveAgent !== undefined) {
    return await callArchiveAgentTool(identity, archiveAgent, rawArguments);
  }
  if (name === "traycer_list_agents" && listAgents !== undefined) {
    return await callListAgentsTool(identity, listAgents, rawArguments);
  }
  if (name === "traycer_get_self" && listAgents !== undefined) {
    return await callGetSelfTool(identity, listAgents);
  }
  if (name === "traycer_get_transcript" && getTranscript !== undefined) {
    return await callGetTranscriptTool(identity, getTranscript, rawArguments);
  }
  if (name === "traycer_list_harness_models") {
    return callListHarnessModelsTool(rawArguments);
  }
  if (name === "traycer_list_provider_profiles") {
    return callListProviderProfilesTool(rawArguments);
  }
  if (name === "traycer_get_provider_profile_rate_limits") {
    return callGetProviderProfileRateLimitsTool(rawArguments);
  }
  if (
    name === "traycer_configure_agent" &&
    managementTools?.configure !== undefined
  ) {
    return await callConfigureAgentTool(
      identity,
      managementTools.configure,
      rawArguments,
    );
  }
  if (name === "traycer_fork_agent" && managementTools?.fork !== undefined) {
    return await callForkAgentTool(
      identity,
      managementTools.fork,
      rawArguments,
    );
  }
  if (
    name === "traycer_list_comment_threads" &&
    managementTools?.comments !== undefined
  ) {
    return await callListCommentThreadsTool(
      identity,
      managementTools.comments.list,
      rawArguments,
    );
  }
  if (
    name === "traycer_set_comment_thread_status" &&
    managementTools?.comments !== undefined
  ) {
    return await callSetCommentThreadStatusTool(
      identity,
      managementTools.comments.setStatus,
      rawArguments,
    );
  }
  if (name !== "traycer_send_message") {
    return toolError(`Unknown Traycer tool: ${name}`);
  }
  if (
    rawArguments === undefined ||
    typeof rawArguments.toAgentId !== "string" ||
    typeof rawArguments.message !== "string"
  ) {
    return toolError(
      "traycer_send_message requires string toAgentId and message.",
    );
  }
  const expectReply = rawArguments.expectReply;
  if (
    expectReply !== undefined &&
    expectReply !== null &&
    typeof expectReply !== "boolean"
  ) {
    return toolError(
      "traycer_send_message expectReply must be a boolean when provided.",
    );
  }
  const responseId = rawArguments.responseId;
  if (
    responseId !== undefined &&
    responseId !== null &&
    typeof responseId !== "string"
  ) {
    return toolError(
      "traycer_send_message responseId must be a string or null when provided.",
    );
  }

  try {
    const handled = await sendMessage({
      senderAgentId: identity.agentId,
      epicId: identity.epicId,
      receiverAgentId: rawArguments.toAgentId,
      prompt: rawArguments.message,
      responseId: responseId ?? null,
      expectReply: expectReply ?? false,
    });
    if (!handled.ok) {
      return sendMessageToolFailure(handled.message);
    }
    const parsed = sendAgentMessageResponseSchema.safeParse(handled.result);
    if (!parsed.success) {
      return sendMessageToolFailure(
        "agent.sendMessage returned an invalid response.",
      );
    }
    return {
      content: [{ type: "text", text: JSON.stringify(parsed.data) }],
    };
  } catch (error) {
    return sendMessageToolFailure(
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function callConfigureAgentTool(
  identity: AgentA2AMcpIdentity,
  configureAgent: AgentA2AMcpConfigure,
  rawArguments: Readonly<Record<string, unknown>> | undefined,
): Promise<CallToolResult> {
  const agentId = rawArguments?.agentId;
  if (typeof agentId !== "string" || agentId.length === 0) {
    return toolError(
      "traycer_configure_agent requires a non-empty string agentId.",
    );
  }
  const harness = guiHarnessIdSchemaV60.safeParse(rawArguments?.harnessId);
  if (!harness.success) {
    return toolError(
      `traycer_configure_agent harnessId must be one of: ${guiHarnessIdSchemaV60.options.join(", ")}.`,
    );
  }
  const model = rawArguments?.model;
  if (typeof model !== "string" || model.length === 0) {
    return toolError(
      "traycer_configure_agent model must be a non-empty string.",
    );
  }
  const profile = rawArguments?.profile;
  if (typeof profile !== "string" || profile.length === 0) {
    return toolError(
      "traycer_configure_agent profile must be a non-empty string.",
    );
  }
  const reasoningEffort = rawArguments?.reasoningEffort;
  if (
    reasoningEffort !== undefined &&
    reasoningEffort !== null &&
    typeof reasoningEffort !== "string"
  ) {
    return toolError(
      "traycer_configure_agent reasoningEffort must be a string or null when provided.",
    );
  }
  const fastMode = rawArguments?.fastMode;
  if (
    fastMode !== undefined &&
    fastMode !== null &&
    typeof fastMode !== "boolean"
  ) {
    return toolError(
      "traycer_configure_agent fastMode must be a boolean or null when provided.",
    );
  }
  const requestedPermissionMode = rawArguments?.permissionMode;
  const permissionMode =
    requestedPermissionMode === undefined || requestedPermissionMode === null
      ? "full_access"
      : permissionModeSchema.safeParse(requestedPermissionMode).data;
  if (permissionMode === undefined) {
    return toolError(
      "traycer_configure_agent permissionMode must be full_access, supervised, auto_accept_edits, or null when provided.",
    );
  }
  const workspace = agentToolWorkspace(
    rawArguments?.workspace,
    "traycer_configure_agent",
  );
  if ("error" in workspace) {
    return toolError(workspace.error);
  }
  const profileSelection =
    profile === "ambient"
      ? ({ kind: "ambient" } as const)
      : ({ kind: "profile", profileId: profile } as const);
  try {
    const response = await configureAgent({
      epicId: identity.epicId,
      senderAgentId: identity.agentId,
      agentId,
      harnessId: harness.data,
      model,
      profileSelection,
      reasoningEffort: reasoningEffort ?? null,
      fastMode: fastMode ?? false,
      permissionMode,
      workspace: workspace.value,
    });
    return {
      content: [
        {
          type: "text",
          text: formatAgentConfigureResponse(agentId, response),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolError(`traycer_configure_agent failed: ${message}`);
  }
}

function agentToolWorkspace(
  value: unknown,
  toolName: "traycer_configure_agent" | "traycer_fork_agent",
):
  { readonly value: CreateAgentWorkspace | null } | { readonly error: string } {
  if (value === undefined || value === null) {
    return { value: null };
  }
  if (!isObjectRecord(value)) {
    return {
      error: `${toolName} workspace must be an object or null when provided.`,
    };
  }
  const entries = Reflect.get(value, "entries");
  if (!Array.isArray(entries)) {
    return {
      error: `${toolName} workspace.entries must be objects carrying a \`path\` string.`,
    };
  }
  const paths: string[] = [];
  for (const entry of entries) {
    if (!isObjectRecord(entry)) {
      return {
        error: `${toolName} workspace.entries must be objects carrying a \`path\` string.`,
      };
    }
    const path = Reflect.get(entry, "path");
    if (typeof path !== "string") {
      return {
        error: `${toolName} workspace.entries must be objects carrying a \`path\` string.`,
      };
    }
    const pathError = agentWorkspacePathError(path, toolName);
    if (pathError !== null) {
      return { error: pathError };
    }
    paths.push(path);
  }
  return {
    value: { entries: paths.map((path) => ({ path, workspacePath: null })) },
  };
}

function agentWorkspacePathError(
  path: string,
  toolName: "traycer_configure_agent" | "traycer_fork_agent",
): string | null {
  if (!isAbsolute(path)) {
    return `${toolName} workspace path "${path}" must be an absolute directory. Forward a \`path\` returned by traycer_create_worktree or pass an existing absolute folder.`;
  }
  let stat: Stats | undefined;
  try {
    stat = statSync(path, { throwIfNoEntry: false });
  } catch {
    return `${toolName} workspace path "${path}" is inaccessible or unusable on this host (e.g. a broken symlink, a symlink cycle, or a permission error).`;
  }
  if (stat === undefined) {
    return `${toolName} workspace path "${path}" is not an existing directory on this host.`;
  }
  return stat.isDirectory()
    ? null
    : `${toolName} workspace path "${path}" is not a directory on this host.`;
}

async function callForkAgentTool(
  identity: AgentA2AMcpIdentity,
  forkAgent: NonNullable<AgentA2AMcpManagementTools["fork"]>,
  rawArguments: Readonly<Record<string, unknown>> | undefined,
): Promise<CallToolResult> {
  const agentId = rawArguments?.agentId;
  if (typeof agentId !== "string" || agentId.length === 0) {
    return toolError("traycer_fork_agent requires a non-empty string agentId.");
  }
  const name = rawArguments?.name;
  if (
    name !== undefined &&
    name !== null &&
    (typeof name !== "string" || name.length === 0)
  ) {
    return toolError(
      "traycer_fork_agent name must be a non-empty string or null when provided.",
    );
  }
  const requestedPermission = rawArguments?.permissionMode;
  const permissionMode =
    requestedPermission === undefined || requestedPermission === null
      ? "full_access"
      : permissionModeSchema.safeParse(requestedPermission).data;
  if (permissionMode === undefined) {
    return toolError(
      "traycer_fork_agent permissionMode must be full_access, supervised, auto_accept_edits, or null when provided.",
    );
  }
  const workspace = agentToolWorkspace(
    rawArguments?.workspace,
    "traycer_fork_agent",
  );
  if ("error" in workspace) {
    return toolError(workspace.error);
  }
  try {
    const response = await forkAgent({
      epicId: identity.epicId,
      senderAgentId: identity.agentId,
      agentId,
      name: typeof name === "string" ? name : null,
      permissionMode,
      workspace: workspace.value,
      profileSelection: { kind: "inherit" },
    });
    return { content: [{ type: "text", text: JSON.stringify(response) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolError(`traycer_fork_agent failed: ${message}`);
  }
}

async function callListCommentThreadsTool(
  identity: AgentA2AMcpIdentity,
  listThreads: NonNullable<
    NonNullable<AgentA2AMcpManagementTools["comments"]>["list"]
  >,
  rawArguments: Readonly<Record<string, unknown>> | undefined,
): Promise<CallToolResult> {
  const rawPaths = rawArguments?.artifactPaths;
  if (
    rawPaths !== undefined &&
    rawPaths !== null &&
    (!Array.isArray(rawPaths) ||
      rawPaths.some((path) => typeof path !== "string"))
  ) {
    return toolError(
      "traycer_list_comment_threads artifactPaths must be an array of strings or null when provided.",
    );
  }
  const parsedStatus = commentThreadStatusFilterSchema.safeParse(
    rawArguments?.status ?? "all",
  );
  if (!parsedStatus.success) {
    return toolError(
      "traycer_list_comment_threads status must be all, open, resolved, or null when provided.",
    );
  }
  const artifactPaths = Array.isArray(rawPaths) ? rawPaths : null;
  try {
    const response = await listThreads({
      epicId: identity.epicId,
      artifactPaths,
      status: parsedStatus.data,
    });
    return {
      content: [
        {
          type: "text",
          text: formatCommentsListThreadsXml({
            response,
            platform: process.platform === "win32" ? "WINDOWS" : "POSIX",
            query: { artifactPaths, status: parsedStatus.data },
          }),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolError(`traycer_list_comment_threads failed: ${message}`);
  }
}

async function callSetCommentThreadStatusTool(
  identity: AgentA2AMcpIdentity,
  setStatus: NonNullable<
    NonNullable<AgentA2AMcpManagementTools["comments"]>["setStatus"]
  >,
  rawArguments: Readonly<Record<string, unknown>> | undefined,
): Promise<CallToolResult> {
  const rawUpdates = rawArguments?.updates;
  if (!Array.isArray(rawUpdates)) {
    return toolError(
      "traycer_set_comment_thread_status requires an updates array.",
    );
  }
  const updates: CommentsSetThreadStatusRequest["updates"] = [];
  for (const rawUpdate of rawUpdates) {
    if (!isObjectRecord(rawUpdate)) {
      return toolError(
        "traycer_set_comment_thread_status updates must carry artifactPath, threadIds, and status.",
      );
    }
    const artifactPath = Reflect.get(rawUpdate, "artifactPath");
    const threadIds = Reflect.get(rawUpdate, "threadIds");
    const status = commentThreadStatusSchema.safeParse(
      Reflect.get(rawUpdate, "status"),
    );
    if (
      typeof artifactPath !== "string" ||
      !Array.isArray(threadIds) ||
      threadIds.some((threadId) => typeof threadId !== "string") ||
      !status.success
    ) {
      return toolError(
        "traycer_set_comment_thread_status updates must carry artifactPath, threadIds, and status.",
      );
    }
    updates.push({
      artifactPath,
      threadIds,
      status: status.data,
    });
  }
  try {
    const response = await setStatus({ epicId: identity.epicId, updates });
    return {
      content: [
        {
          type: "text",
          text: formatCommentsSetThreadStatusResponse(response),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolError(`traycer_set_comment_thread_status failed: ${message}`);
  }
}

function callListHarnessModelsTool(
  rawArguments: Readonly<Record<string, unknown>> | undefined,
): CallToolResult {
  const parsed = guiHarnessIdSchemaV60.safeParse(rawArguments?.harnessId);
  if (!parsed.success) {
    return toolError(
      `traycer_list_harness_models harnessId must be one of: ${guiHarnessIdSchemaV60.options.join(", ")}.`,
    );
  }
  return {
    content: [
      {
        type: "text",
        text: formatListHarnessModelsResponse({
          harnessId: parsed.data,
          models: localHarnessModelSummariesFor(parsed.data),
        }),
      },
    ],
  };
}

function callListProviderProfilesTool(
  rawArguments: Readonly<Record<string, unknown>> | undefined,
): CallToolResult {
  const parsed = guiHarnessIdSchemaV60.safeParse(rawArguments?.harnessId);
  if (!parsed.success) {
    return toolError(
      `traycer_list_provider_profiles harnessId must be one of: ${guiHarnessIdSchemaV60.options.join(", ")}.`,
    );
  }
  return {
    content: [
      {
        type: "text",
        text: formatAgentProviderProfilesResponse(
          localProviderProfilesFor(parsed.data),
        ),
      },
    ],
  };
}

function callGetProviderProfileRateLimitsTool(
  rawArguments: Readonly<Record<string, unknown>> | undefined,
): CallToolResult {
  const harness = guiHarnessIdSchemaV60.safeParse(rawArguments?.harnessId);
  if (!harness.success) {
    return toolError(
      `traycer_get_provider_profile_rate_limits harnessId must be one of: ${guiHarnessIdSchemaV60.options.join(", ")}.`,
    );
  }
  const profile = rawArguments?.profile;
  if (typeof profile !== "string" || profile.length === 0) {
    return toolError(
      "traycer_get_provider_profile_rate_limits profile must be a non-empty string.",
    );
  }
  const selection =
    profile === "ambient"
      ? ({ kind: "ambient" } as const)
      : ({ kind: "profile", profileId: profile } as const);
  try {
    const response = localProviderRateLimitsFor(harness.data, selection);
    return {
      content: [
        {
          type: "text",
          text: formatAgentProviderProfileRateLimitsResponse(
            selection,
            response,
          ),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolError(
      `traycer_get_provider_profile_rate_limits failed: ${message}`,
    );
  }
}

async function callListEpicWorkspacesTool(
  identity: AgentA2AMcpIdentity,
  listEpicWorkspaces: AgentA2AMcpWorkspaceTools["list"],
): Promise<CallToolResult> {
  try {
    const result = await listEpicWorkspaces(identity);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolError(`traycer_list_epic_workspaces failed: ${message}`);
  }
}

async function callCreateWorktreeTool(
  createWorktree: AgentA2AMcpWorkspaceTools["create"],
  rawArguments: Readonly<Record<string, unknown>> | undefined,
): Promise<CallToolResult> {
  const parsed = worktreeCreatePathsRequestSchemaV10.safeParse({
    entries: rawArguments?.entries,
  });
  if (!parsed.success) {
    return toolError(
      "traycer_create_worktree entries must be valid worktree create entries.",
    );
  }
  const request: WorktreeCreatePathsRequest = {
    entries: parsed.data.entries.map((entry) => ({
      workspacePath: entry.workspacePath,
      branch:
        entry.branch.type === "new"
          ? { ...entry.branch, collision: "fail" as const }
          : entry.branch,
    })),
  };
  try {
    const response = await createWorktree(request);
    return { content: [{ type: "text", text: JSON.stringify(response) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolError(`traycer_create_worktree failed: ${message}`);
  }
}

async function callAgentSelectionGuideTool(
  identity: AgentA2AMcpIdentity,
  selectionGuide: AgentA2AMcpSelectionGuide,
): Promise<CallToolResult> {
  try {
    const response = await selectionGuide(identity);
    return {
      content: [
        { type: "text", text: formatAgentSelectionGuideResponse(response) },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolError(`traycer_agent_selection_guide failed: ${message}`);
  }
}

async function callStopAgentTool(
  identity: AgentA2AMcpIdentity,
  stopAgent: AgentA2AMcpStop,
  rawArguments: Readonly<Record<string, unknown>> | undefined,
): Promise<CallToolResult> {
  if (
    rawArguments === undefined ||
    typeof rawArguments.agentId !== "string" ||
    rawArguments.agentId.length === 0
  ) {
    return toolError("traycer_stop_agent requires a non-empty string agentId.");
  }
  const cascade = rawArguments.cascade;
  if (
    cascade !== undefined &&
    cascade !== null &&
    typeof cascade !== "boolean"
  ) {
    return toolError(
      "traycer_stop_agent cascade must be a boolean or null when provided.",
    );
  }
  const archive = rawArguments.archive;
  if (
    archive !== undefined &&
    archive !== null &&
    typeof archive !== "boolean"
  ) {
    return toolError(
      "traycer_stop_agent archive must be a boolean or null when provided.",
    );
  }
  try {
    const handled = await stopAgent({
      senderAgentId: identity.agentId,
      epicId: identity.epicId,
      agentId: rawArguments.agentId,
      cascade: cascade ?? false,
      archive: archive ?? false,
    });
    if (!handled.ok) {
      return toolError(`traycer_stop_agent failed: ${handled.message}`);
    }
    if (!isStopAgentToolResult(handled.result)) {
      return toolError(
        "traycer_stop_agent failed: agent stop returned an invalid response.",
      );
    }
    return {
      content: [{ type: "text", text: JSON.stringify(handled.result) }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolError(`traycer_stop_agent failed: ${message}`);
  }
}

async function callCreateAgentTool(
  identity: AgentA2AMcpIdentity,
  createAgent: AgentA2AMcpCreate,
  rawArguments: Readonly<Record<string, unknown>> | undefined,
): Promise<CallToolResult> {
  const parsed = createAgentToolRequest(rawArguments ?? {});
  if ("error" in parsed) {
    return toolError(parsed.error);
  }
  try {
    const result = await createAgent({
      senderAgentId: identity.agentId,
      epicId: identity.epicId,
      ...parsed.request,
    });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolError(`traycer_create_agent failed: ${message}`);
  }
}

function createAgentToolRequest(input: Readonly<Record<string, unknown>>):
  | {
      readonly request: Omit<CreateAgentRequestV30, "senderAgentId" | "epicId">;
    }
  | { readonly error: string } {
  const permission = permissionModeSchema.safeParse(
    input.permissionMode ?? "full_access",
  );
  if (!permission.success) {
    return {
      error:
        "traycer_create_agent permissionMode must be supervised, auto_accept_edits, full_access, or null when provided.",
    };
  }
  const workspace = createAgentToolWorkspace(input.workspace);
  if ("error" in workspace) {
    return workspace;
  }
  const profile = createAgentToolProfile(input);
  if ("error" in profile) {
    return profile;
  }
  if (
    input.name !== undefined &&
    input.name !== null &&
    (typeof input.name !== "string" || input.name.length === 0)
  ) {
    return {
      error:
        "traycer_create_agent name must be a non-empty string or null when provided.",
    };
  }
  if (
    input.reasoningEffort !== undefined &&
    input.reasoningEffort !== null &&
    typeof input.reasoningEffort !== "string"
  ) {
    return {
      error:
        "traycer_create_agent reasoningEffort must be a string or null when provided.",
    };
  }
  if (
    input.fastMode !== undefined &&
    input.fastMode !== null &&
    typeof input.fastMode !== "boolean"
  ) {
    return {
      error:
        "traycer_create_agent fastMode must be a boolean or null when provided.",
    };
  }
  if (
    input.surface !== undefined &&
    input.surface !== null &&
    input.surface !== "gui" &&
    input.surface !== "tui"
  ) {
    return { error: "traycer_create_agent surface must be gui, tui, or null." };
  }
  if (
    input.model !== undefined &&
    input.model !== null &&
    typeof input.model !== "string"
  ) {
    return { error: "traycer_create_agent model must be a string or null." };
  }
  const surface = input.surface ?? null;
  const harness = agentFacingHarnessIdSchema.safeParse(input.harnessId);
  if (surface !== null && !harness.success) {
    return {
      error: `traycer_create_agent harnessId must be one of: ${agentFacingHarnessIdSchema.options.join(", ")} when surface is set.`,
    };
  }
  if (
    surface === null &&
    input.harnessId !== undefined &&
    input.harnessId !== null &&
    !harness.success
  ) {
    return {
      error: `traycer_create_agent harnessId must be one of: ${agentFacingHarnessIdSchema.options.join(", ")}.`,
    };
  }
  return {
    request: {
      name: typeof input.name === "string" ? input.name : null,
      surface,
      harnessId: harness.success ? harness.data : null,
      model: typeof input.model === "string" ? input.model : null,
      agentMode: "regular",
      reasoningEffort:
        typeof input.reasoningEffort === "string"
          ? input.reasoningEffort
          : null,
      fastMode: typeof input.fastMode === "boolean" ? input.fastMode : null,
      workspace: workspace.value,
      profileSelection: profile.value,
      permissionMode: permission.data,
    },
  };
}

function createAgentToolProfile(
  input: Readonly<Record<string, unknown>>,
):
  | { readonly value: CreateAgentRequestV30["profileSelection"] }
  | { readonly error: string } {
  if (!("profileId" in input)) {
    return { value: { kind: "last_used" } };
  }
  if (input.profileId === null) {
    return { value: { kind: "ambient" } };
  }
  if (typeof input.profileId !== "string" || input.profileId.length === 0) {
    return {
      error:
        "traycer_create_agent profileId must be a non-empty string, null, or omitted.",
    };
  }
  return { value: { kind: "profile", profileId: input.profileId } };
}

function createAgentToolWorkspace(
  value: unknown,
):
  | { readonly value: CreateAgentRequestV30["workspace"] }
  | { readonly error: string } {
  if (value === undefined || value === null) {
    return { value: null };
  }
  if (!isObjectRecord(value)) {
    return {
      error:
        "traycer_create_agent workspace must be an object or null when provided.",
    };
  }
  const entries = Reflect.get(value, "entries");
  if (!Array.isArray(entries)) {
    return {
      error:
        "traycer_create_agent workspace.entries must be objects carrying a `path` string.",
    };
  }
  const paths: string[] = [];
  for (const entry of entries) {
    if (!isObjectRecord(entry)) {
      return {
        error:
          "traycer_create_agent workspace.entries must be objects carrying a `path` string.",
      };
    }
    const path = Reflect.get(entry, "path");
    if (typeof path !== "string") {
      return {
        error:
          "traycer_create_agent workspace.entries must be objects carrying a `path` string.",
      };
    }
    const pathError = createAgentWorkspacePathError(path);
    if (pathError !== null) {
      return { error: pathError };
    }
    paths.push(path);
  }
  return {
    value: {
      entries: paths.map((path) => ({ path, workspacePath: null })),
    },
  };
}

function createAgentWorkspacePathError(path: string): string | null {
  if (!isAbsolute(path)) {
    return `traycer_create_agent workspace path "${path}" must be an absolute directory. Forward a \`path\` returned by traycer_create_worktree or pass an existing absolute folder; omit workspace entirely to inherit the sender's workspace.`;
  }
  let stat: Stats | undefined;
  try {
    stat = statSync(path, { throwIfNoEntry: false });
  } catch {
    return `traycer_create_agent workspace path "${path}" is inaccessible or unusable on this host (e.g. a broken symlink, a symlink cycle, or a permission error).`;
  }
  if (stat === undefined) {
    return `traycer_create_agent workspace path "${path}" is not an existing directory on this host.`;
  }
  return stat.isDirectory()
    ? null
    : `traycer_create_agent workspace path "${path}" is not a directory on this host.`;
}

function isObjectRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStopAgentToolResult(value: unknown): value is {
  readonly stoppedAgentIds: string[];
  readonly archivedAgentIds: string[];
  readonly notArchivedAgentIds: string[];
  readonly skippedAgentIds: string[];
  readonly failedAgentIds: string[];
} {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return [
    "stoppedAgentIds",
    "archivedAgentIds",
    "notArchivedAgentIds",
    "skippedAgentIds",
    "failedAgentIds",
  ].every((key) => {
    const entry = Reflect.get(value, key);
    return (
      Array.isArray(entry) &&
      entry.every((agentId) => typeof agentId === "string")
    );
  });
}

async function callArchiveAgentTool(
  identity: AgentA2AMcpIdentity,
  archiveAgent: AgentA2AMcpArchive,
  rawArguments: Readonly<Record<string, unknown>> | undefined,
): Promise<CallToolResult> {
  if (
    rawArguments === undefined ||
    typeof rawArguments.agentId !== "string" ||
    rawArguments.agentId.length === 0
  ) {
    return toolError(
      "traycer_archive_agent requires a non-empty string agentId.",
    );
  }
  try {
    const handled = await archiveAgent({
      senderAgentId: identity.agentId,
      epicId: identity.epicId,
      agentId: rawArguments.agentId,
    });
    if (!handled.ok) {
      return toolError(`traycer_archive_agent failed: ${handled.message}`);
    }
    if (!isArchiveAgentToolResult(handled.result)) {
      return toolError(
        "traycer_archive_agent failed: agent archive returned an invalid response.",
      );
    }
    return {
      content: [{ type: "text", text: JSON.stringify(handled.result) }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolError(`traycer_archive_agent failed: ${message}`);
  }
}

function isArchiveAgentToolResult(value: unknown): value is {
  readonly agentId: string;
  readonly archived: true;
  readonly updated: boolean;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "agentId") === "string" &&
    Reflect.get(value, "archived") === true &&
    typeof Reflect.get(value, "updated") === "boolean"
  );
}

async function callListAgentsTool(
  identity: AgentA2AMcpIdentity,
  listAgents: AgentA2AMcpList,
  rawArguments: Readonly<Record<string, unknown>> | undefined,
): Promise<CallToolResult> {
  const scope = rawArguments?.scope;
  if (
    scope !== undefined &&
    scope !== null &&
    scope !== "user" &&
    scope !== "all"
  ) {
    return toolError("traycer_list_agents scope must be 'user' or 'all'.");
  }
  try {
    const response = await listAgents({
      epicId: identity.epicId,
      senderAgentId: identity.agentId,
      scope: scope ?? "user",
    });
    return {
      content: [{ type: "text", text: formatAgentListResponse(response) }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolError(`traycer_list_agents failed: ${message}`);
  }
}

async function callGetSelfTool(
  identity: AgentA2AMcpIdentity,
  listAgents: AgentA2AMcpList,
): Promise<CallToolResult> {
  try {
    const response = await listAgents({
      epicId: identity.epicId,
      senderAgentId: identity.agentId,
      scope: "user",
    });
    return {
      content: [
        {
          type: "text",
          text: formatAgentSelf(
            response.agents.find((agent) => agent.isSelf) ?? null,
          ),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolError(`traycer_get_self failed: ${message}`);
  }
}

async function callGetTranscriptTool(
  identity: AgentA2AMcpIdentity,
  getTranscript: AgentA2AMcpGetTranscript,
  rawArguments: Readonly<Record<string, unknown>> | undefined,
): Promise<CallToolResult> {
  if (rawArguments === undefined || typeof rawArguments.agentId !== "string") {
    return toolError("traycer_get_transcript requires string agentId.");
  }
  try {
    const response = await getTranscript({
      senderAgentId: identity.agentId,
      epicId: identity.epicId,
      agentId: rawArguments.agentId,
    });
    return { content: [{ type: "text", text: response.transcript }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolError(`traycer_get_transcript failed: ${message}`);
  }
}

function sendMessageToolFailure(message: string): CallToolResult {
  return toolError(`traycer_send_message failed: ${message}`);
}

function toolError(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function pathnameOf(url: string | undefined): string {
  if (url === undefined) {
    return "/";
  }
  const query = url.indexOf("?");
  return query === -1 ? url : url.slice(0, query);
}

function hasExpectedLoopbackHost(request: IncomingMessage): boolean {
  const host = request.headers.host;
  if (host === undefined) {
    return false;
  }
  try {
    return isLoopbackHostname(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

function hasAllowedOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) {
    return true;
  }
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function bearerToken(authorization: string | undefined): string | null {
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    return null;
  }
  const token = authorization.slice("Bearer ".length);
  return token.length === 0 || token.includes(" ") ? null : token;
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("A2A MCP server bound without a port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeAllConnections();
  });
}
