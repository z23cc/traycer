import { describe, expect, it } from "vitest";
import { buildLaunchArgs } from "../cli-args";

describe("buildLaunchArgs", () => {
  it("builds the official Claude stdin stream-json invocation", () => {
    expect(
      buildLaunchArgs("claude", {
        model: "claude-sonnet-4",
        permissionMode: "supervised",
        prompt: "hello",
        sessionId: null,
      }),
    ).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--input-format",
      "stream-json",
      "--include-partial-messages",
      "--permission-prompt-tool",
      "stdio",
      "--model",
      "claude-sonnet-4",
      "--permission-mode",
      "default",
    ]);
  });

  it("skips Claude permissions for full_access", () => {
    const args = buildLaunchArgs("claude", {
      model: "opus",
      permissionMode: "full_access",
      prompt: "go",
      sessionId: null,
    });
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("go");
  });

  it("resumes a Claude session when a session id is present", () => {
    const args = buildLaunchArgs("claude", {
      model: "opus",
      permissionMode: "supervised",
      prompt: "again",
      sessionId: "sess-1",
    });
    expect(args).toContain("--resume=sess-1");
  });

  it("builds a Codex exec invocation", () => {
    expect(
      buildLaunchArgs("codex", {
        model: "gpt-5-codex",
        permissionMode: "auto_accept_edits",
        prompt: "hi",
        sessionId: null,
      }),
    ).toEqual([
      "exec",
      "--skip-git-repo-check",
      "--json",
      "--model",
      "gpt-5-codex",
      "--full-auto",
      "hi",
    ]);
  });
});
