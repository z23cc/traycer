import type { HarnessCommand } from "./cli-resolve";

export type LaunchSpec = {
  readonly command: string;
  readonly args: string[];
};

export function buildLaunchArgs(
  harness: HarnessCommand,
  request: {
    readonly model: string;
    readonly permissionMode: string;
    readonly prompt: string;
    readonly sessionId: string | null;
  },
): string[] {
  if (harness === "claude") {
    return claudeArgs(request);
  }
  return codexArgs(request);
}

function claudeArgs(request: {
  readonly model: string;
  readonly permissionMode: string;
  readonly sessionId: string | null;
}): string[] {
  // Recovered SDK argv builder (host-bundle.strings.cjs ~36132502).
  // `-p` is not in that builder; we keep it so a one-shot CLI still exits.
  const args = [
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
    request.model,
  ];
  if (request.sessionId !== null) {
    args.push(`--resume=${request.sessionId}`);
  }
  if (request.permissionMode === "full_access") {
    args.push(
      "--allow-dangerously-skip-permissions",
      "--dangerously-skip-permissions",
    );
  } else if (request.permissionMode === "auto_accept_edits") {
    args.push("--permission-mode", "acceptEdits");
  } else {
    args.push("--permission-mode", "default");
  }
  return args;
}

function codexArgs(request: {
  readonly model: string;
  readonly permissionMode: string;
  readonly prompt: string;
}): string[] {
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--json",
    "--model",
    request.model,
  ];
  if (request.permissionMode === "full_access") {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (request.permissionMode === "auto_accept_edits") {
    args.push("--full-auto");
  }
  args.push(request.prompt);
  return args;
}

export function launchSpec(
  command: string,
  harness: HarnessCommand,
  request: {
    readonly model: string;
    readonly permissionMode: string;
    readonly prompt: string;
    readonly sessionId: string | null;
  },
): LaunchSpec {
  return {
    command,
    args: buildLaunchArgs(harness, request),
  };
}
