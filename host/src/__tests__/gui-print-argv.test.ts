import { describe, expect, it } from "vitest";
import { guiPrintArgv, visibleDeltaText } from "../gui/deliver";

describe("guiPrintArgv", () => {
  it("runs Codex full_access without approval prompts", () => {
    expect(
      guiPrintArgv(
        "codex",
        "分析当前的项目",
        "gpt-5.6-sol",
        "full_access",
        null,
        null,
      ),
    ).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.6-sol",
      "--dangerously-bypass-approvals-and-sandbox",
      "分析当前的项目",
    ]);
  });

  it("keeps Codex supervised turns in the read-only sandbox", () => {
    expect(
      guiPrintArgv("codex", "ping", null, "supervised", null, null),
    ).toEqual(["exec", "--json", "--sandbox", "read-only", "ping"]);
  });

  it("resumes a Codex thread instead of stuffing history into the prompt", () => {
    expect(
      guiPrintArgv(
        "codex",
        "follow up",
        "gpt-5.6-sol",
        "full_access",
        "thread-1",
        null,
      ),
    ).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.6-sol",
      "--dangerously-bypass-approvals-and-sandbox",
      "resume",
      "thread-1",
      "follow up",
    ]);
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
