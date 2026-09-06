import type { ProviderId } from "@traycer/protocol/host/provider-ids";
import type { ProviderLoginCapability } from "@traycer/protocol/host/provider-schemas";

export const PROVIDER_LOGIN_CAPABILITY: {
  readonly [id in ProviderId]: ProviderLoginCapability | null;
} = {
  "claude-code": capability(
    ["auth", "login"],
    ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  ),
  codex: capability(["login"], null),
  opencode: null,
  cursor: null,
  traycer: null,
  grok: capability(["login"], ["XAI_API_KEY"]),
  qwen: capability(null, [
    "OPENROUTER_API_KEY",
    "OPENAI_API_KEY",
    "BAILIAN_CODING_PLAN_API_KEY",
    "BAILIAN_TOKEN_PLAN_API_KEY",
    "DASHSCOPE_API_KEY",
  ]),
  kiro: capability(["login"], ["KIRO_API_KEY"]),
  droid: capability(null, ["FACTORY_API_KEY"]),
  kimi: capability(["login"], null),
  copilot: {
    oauthArgs: ["login"],
    token: {
      vars: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
    },
    codePaste: null,
    terminalLogin: {},
  },
  kilocode: capability(["auth", "login"], ["KILO_API_KEY"]),
  openrouter: null,
  amp: capability(null, ["AMP_API_KEY"]),
  devin: capability(["acp"], ["WINDSURF_API_KEY"]),
  pi: capability(null, [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "GEMINI_API_KEY",
  ]),
  hermes: capability(["acp", "--setup"], null),
  omp: capability(null, [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "GEMINI_API_KEY",
    "XAI_API_KEY",
    "ZAI_API_KEY",
    "COPILOT_GITHUB_TOKEN",
  ]),
  huggingface: null,
  reasonix: null,
};

function capability(
  oauthArgs: readonly string[] | null,
  tokenVars: readonly string[] | null,
): ProviderLoginCapability {
  return {
    oauthArgs: oauthArgs === null ? null : [...oauthArgs],
    token: tokenVars === null ? null : { vars: [...tokenVars] },
    codePaste: null,
    terminalLogin: null,
  };
}
