import { describe, expect, it } from "vitest";
import { dispatchRequest } from "../dispatch";

describe("version-aware RPC dispatch", () => {
  it("responds to host.status at the caller's requested minor version", () => {
    const outcome = dispatchRequest({
      method: "host.status",
      schemaVersion: { major: 1, minor: 0 },
      params: {},
      handleMethod: () => ({
        ok: true,
        result: {
          ready: true,
          hostVersion: "1.1.11",
          protocolVersion: { major: 1, minor: 0 },
          busy: false,
          busySessionCount: 0,
          updateProgress: null,
        },
      }),
    });

    expect(outcome).toEqual({
      schemaVersion: { major: 1, minor: 0 },
      result: {
        ready: true,
        hostVersion: "1.1.11",
        protocolVersion: { major: 1, minor: 0 },
      },
      error: null,
    });
  });

  it("upgrades an old request for the latest handler and projects its response back", () => {
    let handledParams: unknown = null;
    const outcome = dispatchRequest({
      method: "worktree.listAllForHost",
      schemaVersion: { major: 1, minor: 0 },
      params: {},
      handleMethod: (_method, params) => {
        handledParams = params;
        return {
          ok: true,
          result: { worktrees: [], nextCursor: null },
        };
      },
    });

    expect(handledParams).toEqual({
      includeActivity: false,
      activityPaths: null,
      cursor: null,
      limit: null,
      forceRefresh: false,
    });
    expect(outcome).toEqual({
      schemaVersion: { major: 1, minor: 0 },
      result: { worktrees: [] },
      error: null,
    });
  });

  it("returns caller-version RPC errors before invoking a handler", () => {
    let handlerCalls = 0;
    const invalidParams = dispatchRequest({
      method: "agent.gui.listModels",
      schemaVersion: { major: 1, minor: 0 },
      params: {},
      handleMethod: () => {
        handlerCalls += 1;
        return { ok: true, result: {} };
      },
    });
    const missingContract = dispatchRequest({
      method: "host.status",
      schemaVersion: { major: 9, minor: 0 },
      params: {},
      handleMethod: () => {
        handlerCalls += 1;
        return { ok: true, result: {} };
      },
    });

    expect(handlerCalls).toBe(0);
    expect(invalidParams).toMatchObject({
      schemaVersion: { major: 1, minor: 0 },
      result: null,
      error: {
        code: "RPC_ERROR",
        message: expect.stringContaining("Request params failed validation"),
      },
    });
    expect(missingContract).toEqual({
      schemaVersion: { major: 9, minor: 0 },
      result: null,
      error: {
        code: "RPC_ERROR",
        message: "No contract installed for method 'host.status' 9.0",
      },
    });
  });
});
