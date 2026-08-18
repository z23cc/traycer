import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentSendCommand } from "../agent-send";
import { callHostRpc } from "../../internal/host-rpc";
import { noopLogger } from "../../logger";
import type { CommandContext } from "../../runner/runner";

vi.mock("../../internal/host-rpc", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../internal/host-rpc")>();
  return {
    ...actual,
    callHostRpc: vi.fn(),
  };
});

const rpcMock = vi.mocked(callHostRpc);
const previousEpicId = process.env.TRAYCER_EPIC_ID;
const previousAgentId = process.env.TRAYCER_AGENT_ID;

function makeCtx(): CommandContext {
  return {
    runtime: {
      json: false,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: false,
      environment: "production",
      logger: noopLogger,
    },
    output: {
      progress: vi.fn(),
      human: vi.fn(),
      humanRequired: vi.fn(),
      emitResult: vi.fn(),
      emitError: vi.fn(),
    },
    progress: vi.fn(),
  };
}

beforeEach(() => {
  rpcMock.mockReset();
  process.env.TRAYCER_EPIC_ID = "epic-from-context";
  process.env.TRAYCER_AGENT_ID = "sender-from-context";
});

afterEach(() => {
  if (previousEpicId === undefined) delete process.env.TRAYCER_EPIC_ID;
  else process.env.TRAYCER_EPIC_ID = previousEpicId;

  if (previousAgentId === undefined) delete process.env.TRAYCER_AGENT_ID;
  else process.env.TRAYCER_AGENT_ID = previousAgentId;
});

describe("buildAgentSendCommand", () => {
  it("sends a one-shot message from agent context and reports a null response id", async () => {
    rpcMock.mockResolvedValue({ responseId: null });

    const result = await buildAgentSendCommand({
      epicId: null,
      senderAgentId: null,
      to: "receiver-agent",
      message: "Inspect the failing request",
      expectReply: false,
      responseId: null,
    })(makeCtx());

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("agent.sendMessage", {
      epicId: "epic-from-context",
      senderAgentId: "sender-from-context",
      receiverAgentId: "receiver-agent",
      prompt: "Inspect the failing request",
      expectReply: false,
      responseId: null,
    });
    expect(result).toEqual({
      data: { responseId: null },
      human: "sent to receiver-agent",
      exitCode: 0,
    });
  });

  it("reports the host response id for a message that expects a reply", async () => {
    rpcMock.mockResolvedValue({ responseId: "response-thread-1" });

    const result = await buildAgentSendCommand({
      epicId: null,
      senderAgentId: null,
      to: "review-agent",
      message: "Review the proposed fix",
      expectReply: true,
      responseId: null,
    })(makeCtx());

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("agent.sendMessage", {
      epicId: "epic-from-context",
      senderAgentId: "sender-from-context",
      receiverAgentId: "review-agent",
      prompt: "Review the proposed fix",
      expectReply: true,
      responseId: null,
    });
    expect(result).toEqual({
      data: { responseId: "response-thread-1" },
      human: "sent to review-agent (responseId: response-thread-1)",
      exitCode: 0,
    });
  });

  it("forwards a response id when sending a final reply", async () => {
    rpcMock.mockResolvedValue({ responseId: null });

    await buildAgentSendCommand({
      epicId: null,
      senderAgentId: null,
      to: "requesting-agent",
      message: "The review is complete",
      expectReply: false,
      responseId: "response-thread-1",
    })(makeCtx());

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("agent.sendMessage", {
      epicId: "epic-from-context",
      senderAgentId: "sender-from-context",
      receiverAgentId: "requesting-agent",
      prompt: "The review is complete",
      expectReply: false,
      responseId: "response-thread-1",
    });
  });
});
