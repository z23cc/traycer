import { describe, expect, it } from "vitest";
import { guiPrintArgv, visibleDeltaText } from "../gui/deliver";

describe("guiPrintArgv", () => {
  /**
   * Codex is the app-server, whatever the mode or the thread: model, prompt,
   * sandbox, approval policy and the thread to resume all ride JSON-RPC on
   * stdin, and the approvals come back the same way for this host to decide.
   */
  it("runs Codex as the app-server under every mode", () => {
    for (const mode of ["full_access", "auto_accept_edits", "supervised"]) {
      expect(
        guiPrintArgv(
          "codex",
          "分析当前的项目",
          "gpt-5.6-sol",
          mode,
          null,
          null,
        ),
      ).toEqual(["app-server", "--listen", "stdio://"]);
    }
    expect(
      guiPrintArgv(
        "codex",
        "follow up",
        "gpt-5.6-sol",
        "full_access",
        "thread-1",
        null,
      ),
    ).toEqual(["app-server", "--listen", "stdio://"]);
  });

  it("runs a /plan turn in the CLI's plan mode", () => {
    expect(guiPrintArgv("claude", "x", null, "plan", null, null)).toContain(
      "plan",
    );
    expect(
      guiPrintArgv("claude", "x", null, "plan", null, null).join(" "),
    ).toContain("--permission-mode plan");
    expect(
      guiPrintArgv("claude", "x", null, "supervised", null, null).join(" "),
    ).toContain("--permission-mode default");
  });

  it("skips Claude permission prompts in full_access", () => {
    // The edit hooks ride in as settings, ahead of the model. No prompt in
    // argv: it goes down stdin as a user record, on the same pipe the
    // permission answers come back on - and the CLI always runs in `default`,
    // because this host is the one deciding.
    expect(
      guiPrintArgv("claude", "hi", null, null, null, '{"hooks":{}}'),
    ).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--settings",
      '{"hooks":{}}',
      "--permission-mode",
      "default",
      "--permission-prompt-tool",
      "stdio",
      "--input-format",
      "stream-json",
    ]);
    expect(
      guiPrintArgv("claude", "hi", "sonnet", "full_access", null, null),
    ).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--model",
      "sonnet",
      "--permission-mode",
      "default",
      "--permission-prompt-tool",
      "stdio",
      "--input-format",
      "stream-json",
    ]);
  });

  it("does not append a full assistant replay after stream-json partials", () => {
    const reply = "你好!有什么我可以帮你的吗?";
    expect(visibleDeltaText("", "你好!", false)).toBe("你好!");
    expect(visibleDeltaText("你好!", "有什么我可以帮你的吗?", false)).toBe(
      "有什么我可以帮你的吗?",
    );
    expect(visibleDeltaText(reply, reply, true)).toBeNull();
  });

  it("emits only the unseen suffix of a cumulative Codex agent_message", () => {
    expect(visibleDeltaText("", "你好", true)).toBe("你好");
    expect(visibleDeltaText("你好", "你好!有什么我可以帮你的吗?", true)).toBe(
      "!有什么我可以帮你的吗?",
    );
    expect(
      visibleDeltaText(
        "你好!有什么我可以帮你的吗?",
        "你好!有什么我可以帮你的吗?",
        true,
      ),
    ).toBeNull();
  });

  it("resumes a Claude session by id", () => {
    expect(
      guiPrintArgv("claude", "next", "sonnet", "full_access", "sess-9", null),
    ).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--model",
      "sonnet",
      "--permission-mode",
      "default",
      "--permission-prompt-tool",
      "stdio",
      "--input-format",
      "stream-json",
      "--resume",
      "sess-9",
    ]);
  });
});
