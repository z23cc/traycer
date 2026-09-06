import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  CURRENT_CLIENT_COMPATIBILITY_EPOCH,
  SERVES_EVERY_INSTALLED_MAJOR,
  splitConnectionManifest,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { providerIdSchema } from "@traycer/protocol/host/provider-ids";
import { spawnEnvForProvider } from "../providers/service";
import { startHost, type StartedHost } from "../start-host";

describe("providers and terminal", () => {
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

  it("lists every provider and probes a PATH binary", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    const listed = await call(
      started.rpcUrl,
      "providers.list",
      {
        major: 8,
        minor: 0,
      },
      {
        forceAuthRefresh: false,
        native: null,
      },
    );
    const record = listed as {
      providers: readonly {
        providerId: string;
        candidates: readonly unknown[];
      }[];
    };
    expect(record.providers.map((row) => row.providerId).sort()).toEqual(
      [...providerIdSchema.options].sort(),
    );
    const probed = await call(
      started.rpcUrl,
      "providers.detectVersion",
      {
        major: 1,
        minor: 0,
      },
      {
        candidatePath: "/usr/bin/git",
      },
    );
    expect(probed).toMatchObject({ executable: true });

    const disabled = await call(
      started.rpcUrl,
      "providers.setEnabled",
      {
        major: 2,
        minor: 1,
      },
      {
        providerId: "claude-code",
        enabled: false,
        profileAction: null,
      },
    );
    expect(disabled).toMatchObject({
      state: { providerId: "claude-code", enabled: false },
    });

    const keyed = await call(
      started.rpcUrl,
      "providers.setApiKey",
      {
        major: 2,
        minor: 1,
      },
      {
        providerId: "openrouter",
        apiKey: "sk-or-test",
      },
    );
    expect(keyed).toMatchObject({
      state: {
        providerId: "openrouter",
        apiKey: { supported: true, configured: true, source: "stored" },
        auth: { status: "authenticated" },
      },
    });
    const cleared = await call(
      started.rpcUrl,
      "providers.clearApiKey",
      {
        major: 2,
        minor: 1,
      },
      {
        providerId: "openrouter",
      },
    );
    expect(cleared).toMatchObject({
      state: {
        providerId: "openrouter",
        apiKey: { supported: true, configured: false, source: null },
      },
    });

    const args = await call(
      started.rpcUrl,
      "providers.setTerminalAgentArgs",
      { major: 2, minor: 1 },
      {
        providerId: "claude-code",
        terminalAgentArgs: "--permission-mode acceptEdits",
      },
    );
    expect(args).toMatchObject({
      state: {
        providerId: "claude-code",
        terminalAgentArgs: "--permission-mode acceptEdits",
      },
    });
    const envSet = await call(
      started.rpcUrl,
      "providers.setEnvOverride",
      { major: 2, minor: 1 },
      {
        providerId: "claude-code",
        key: "ANTHROPIC_API_KEY",
        value: "sk-ant-test",
      },
    );
    expect(envSet).toMatchObject({
      state: {
        providerId: "claude-code",
        envOverrides: [{ key: "ANTHROPIC_API_KEY", value: "sk-ant-test" }],
      },
    });
    expect(
      spawnEnvForProvider(started.runtime.store, "claude-code")
        .ANTHROPIC_API_KEY,
    ).toBe("sk-ant-test");
    const unset = await call(
      started.rpcUrl,
      "providers.setEnvOverride",
      { major: 2, minor: 1 },
      {
        providerId: "claude-code",
        key: "ANTHROPIC_API_KEY",
        value: null,
      },
    );
    expect(unset).toMatchObject({
      state: {
        providerId: "claude-code",
        envOverrides: [{ key: "ANTHROPIC_API_KEY", value: null }],
      },
    });
    expect(
      spawnEnvForProvider(started.runtime.store, "claude-code")
        .ANTHROPIC_API_KEY,
    ).toBeUndefined();
    const deletedEnv = await call(
      started.rpcUrl,
      "providers.deleteEnvOverride",
      { major: 2, minor: 1 },
      {
        providerId: "claude-code",
        key: "ANTHROPIC_API_KEY",
      },
    );
    expect(deletedEnv).toMatchObject({
      state: { providerId: "claude-code", envOverrides: [] },
    });
    const withCapability = await call(
      started.rpcUrl,
      "providers.list",
      { major: 8, minor: 0 },
      { forceAuthRefresh: false, native: null },
    );
    const capabilityRecord = withCapability as {
      providers: readonly {
        providerId: string;
        loginCapability: { oauthArgs: readonly string[] | null } | null;
      }[];
    };
    expect(
      capabilityRecord.providers.find((row) => row.providerId === "claude-code")
        ?.loginCapability,
    ).toMatchObject({
      oauthArgs: ["auth", "login"],
      token: {
        vars: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
      },
      codePaste: {},
      terminalLogin: null,
    });
    const login = await call(
      started.rpcUrl,
      "providers.startLogin",
      { major: 1, minor: 1 },
      { providerId: "cursor" },
    );
    expect(login).toEqual({
      url: null,
      started: false,
      profileId: null,
    });
    const terminalLogin = await call(
      started.rpcUrl,
      "providers.startLogin",
      { major: 1, minor: 1 },
      { providerId: "copilot" },
    );
    expect(terminalLogin).toEqual({
      url: null,
      started: false,
      profileId: null,
    });
  });

  it("pastes a login code onto a codePaste-capable child's stdin", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    const idle = await call(
      started.rpcUrl,
      "providers.submitLoginCode",
      { major: 1, minor: 0 },
      { providerId: "claude-code", profileId: null, code: "idle" },
    );
    expect(idle).toEqual({ outcome: "noActiveLogin" });
    const untouched = await call(
      started.rpcUrl,
      "providers.touchLogin",
      { major: 1, minor: 0 },
      { providerId: "claude-code", profileId: null },
    );
    expect(untouched).toEqual({ extended: false });
    const script = join(tempDir, "fake-claude");
    const codeFile = join(tempDir, "code.txt");
    await writeFile(
      script,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1-}" = "auth" ] && [ "\${2-}" = "login" ]; then
  IFS= read -r line || true
  printf '%s\\n' "$line" > "${codeFile}"
  exit 0
fi
exit 1
`,
    );
    await chmod(script, 0o755);
    await call(
      started.rpcUrl,
      "providers.addCustomPath",
      { major: 2, minor: 1 },
      { providerId: "claude-code", path: script },
    );
    const startedLogin = await call(
      started.rpcUrl,
      "providers.startLogin",
      { major: 1, minor: 1 },
      { providerId: "claude-code" },
    );
    expect(startedLogin).toEqual({
      url: null,
      started: true,
      profileId: null,
    });
    const touched = await call(
      started.rpcUrl,
      "providers.touchLogin",
      { major: 1, minor: 0 },
      { providerId: "claude-code", profileId: null },
    );
    expect(touched).toEqual({ extended: true });
    const submitted = await call(
      started.rpcUrl,
      "providers.submitLoginCode",
      { major: 1, minor: 0 },
      {
        providerId: "claude-code",
        profileId: null,
        code: "paste-code-1",
      },
    );
    expect(submitted).toEqual({ outcome: "accepted" });
    const awaited = await call(
      started.rpcUrl,
      "providers.awaitLogin",
      { major: 2, minor: 1 },
      { providerId: "claude-code" },
    );
    expect(awaited).toMatchObject({ codeRejected: false });
    expect(await readFile(codeFile, "utf8")).toBe("paste-code-1\n");
  });

  it("spawns a PTY and answers terminal.subscribe with a snapshot", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    const created = await call(
      started.rpcUrl,
      "terminal.create",
      {
        major: 2,
        minor: 1,
      },
      {
        scope: { kind: "independent" },
        sessionKind: "terminal",
        tuiHarnessId: null,
        cwd: tempDir,
        shellCommand: "/bin/zsh",
        shellArgs: [],
        cols: 80,
        rows: 24,
        desiredSessionId: "term-1",
        worktreeBusyPaths: [],
        themeHint: null,
      },
    );
    expect(created).toMatchObject({
      session: { sessionId: "term-1", status: "running" },
    });
    const streamUrl = started.rpcUrl.replace(/\/rpc$/u, "/stream");
    const snapshot = await subscribeTerminal(streamUrl, "term-1");
    expect(snapshot).toMatchObject({
      kind: "snapshot",
      sessionId: "term-1",
      session: { sessionId: "term-1" },
    });
    const killed = await call(
      started.rpcUrl,
      "terminal.kill",
      {
        major: 1,
        minor: 0,
      },
      {
        sessionId: "term-1",
      },
    );
    expect(killed).toMatchObject({ killed: true });
  });

  it("refuses startTerminalLogin for providers without terminalLogin", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    const error = await callExpectingError(
      started.rpcUrl,
      "providers.startTerminalLogin",
      { major: 2, minor: 0 },
      {
        providerId: "claude-code",
        scope: { kind: "independent" },
        cols: 80,
        rows: 24,
      },
    );
    expect(error.code).toBe("RPC_ERROR");
    expect(error.message).toBe(
      "Claude Code does not support signing in from a terminal.",
    );
  });

  it("opens a host-owned copilot login PTY and replaces it on retry", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    const script = join(tempDir, "fake-copilot");
    await writeFile(
      script,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1-}" = "login" ]; then
  printf 'COPILOT_AUTO_UPDATE=%s\\n' "\${COPILOT_AUTO_UPDATE-}"
  printf 'GH_TOKEN=%s\\n' "\${GH_TOKEN-}"
  printf 'Visit https://github.com/login/device and enter code ABCD-1234\\n'
  while true; do sleep 30; done
fi
exit 1
`,
    );
    await chmod(script, 0o755);
    await call(
      started.rpcUrl,
      "providers.addCustomPath",
      { major: 2, minor: 1 },
      { providerId: "copilot", path: script },
    );
    await call(
      started.rpcUrl,
      "providers.setEnvOverride",
      { major: 2, minor: 1 },
      { providerId: "copilot", key: "GH_TOKEN", value: "gho-test-token" },
    );
    const first = (await call(
      started.rpcUrl,
      "providers.startTerminalLogin",
      { major: 2, minor: 0 },
      {
        providerId: "copilot",
        scope: { kind: "independent" },
        cols: 80,
        rows: 24,
      },
    )) as { sessionId: string; replacedSessionId: string | null };
    expect(first.replacedSessionId).toBeNull();
    expect(first.sessionId.length).toBeGreaterThan(0);
    await waitForScrollback(started, first.sessionId, "ABCD-1234");
    const scrollback = started.runtime.pty.scrollback(first.sessionId);
    expect(scrollback).toContain("COPILOT_AUTO_UPDATE=false");
    expect(scrollback).toContain("GH_TOKEN=gho-test-token");
    const listed = (await call(
      started.rpcUrl,
      "terminal.list",
      { major: 2, minor: 3 },
      { scope: { kind: "independent" } },
    )) as {
      sessions: readonly {
        sessionId: string;
        title: string | null;
        sessionKind: string;
        lifecycleOwner: string;
        shellCommand: string;
        shellArgs: readonly string[];
      }[];
    };
    const row = listed.sessions.find(
      (session) => session.sessionId === first.sessionId,
    );
    expect(row).toMatchObject({
      title: "Copilot sign-in",
      sessionKind: "terminal",
      lifecycleOwner: "manager",
      shellCommand: script,
      shellArgs: ["login"],
    });
    const snapshot = (await subscribeTerminal(
      started.rpcUrl.replace(/\/rpc$/u, "/stream"),
      first.sessionId,
    )) as { kind: string; sessionId: string; scrollback: string };
    expect(snapshot.kind).toBe("snapshot");
    expect(snapshot.scrollback).toContain("ABCD-1234");
    const second = (await call(
      started.rpcUrl,
      "providers.startTerminalLogin",
      { major: 1, minor: 0 },
      {
        providerId: "copilot",
        epicId: "epic-login-1",
        cols: 80,
        rows: 24,
      },
    )) as { sessionId: string; replacedSessionId: string | null };
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.replacedSessionId).toBe(first.sessionId);
    const replaced = started.runtime.terminals.get(first.sessionId);
    expect(replaced).toMatchObject({
      status: "exited",
      exitReason: "killed",
    });
    const epicListed = (await call(
      started.rpcUrl,
      "terminal.list",
      { major: 2, minor: 3 },
      { scope: { kind: "epic", epicId: "epic-login-1" } },
    )) as { sessions: readonly { sessionId: string }[] };
    expect(
      epicListed.sessions.some(
        (session) => session.sessionId === second.sessionId,
      ),
    ).toBe(true);
  }, 15_000);
});

async function call(
  url: string,
  method: string,
  schemaVersion: { major: number; minor: number },
  params: unknown,
): Promise<unknown> {
  const exchange = await rpcExchange(url, method, schemaVersion, params);
  if (exchange.error !== null) {
    throw new Error(`RPC error: ${JSON.stringify(exchange.error)}`);
  }
  return exchange.result;
}

async function callExpectingError(
  url: string,
  method: string,
  schemaVersion: { major: number; minor: number },
  params: unknown,
): Promise<{ readonly code: string; readonly message: string }> {
  const exchange = await rpcExchange(url, method, schemaVersion, params);
  if (exchange.error === null) {
    throw new Error(
      `expected RPC error, got ${JSON.stringify(exchange.result)}`,
    );
  }
  return exchange.error;
}

async function rpcExchange(
  url: string,
  method: string,
  schemaVersion: { major: number; minor: number },
  params: unknown,
): Promise<{
  readonly result: unknown;
  readonly error: { readonly code: string; readonly message: string } | null;
}> {
  const clientManifests = splitConnectionManifest(
    hostRpcRegistry,
    RELEASED_FLOOR_METHOD_NAMES,
    SERVES_EVERY_INSTALLED_MAJOR,
  );
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const frames: unknown[] = [];
  const done = new Promise<void>((resolve, reject) => {
    socket.on("message", (data) => {
      frames.push(JSON.parse(String(data)));
      if (frames.length === 1) {
        socket.send(
          JSON.stringify({
            kind: "request",
            requestId: "1",
            method,
            schemaVersion,
            params,
          }),
        );
      }
    });
    socket.once("close", () => resolve());
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      kind: "open",
      token: "test-token",
      manifest: clientManifests.manifest,
      optionalManifest: clientManifests.optionalManifest,
      clientIdentity: {
        kind: "cli",
        compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
        appVersion: "0.1.0",
      },
    }),
  );
  await done;
  const response = frames[1];
  if (
    response === null ||
    typeof response !== "object" ||
    !("kind" in response) ||
    response.kind !== "response"
  ) {
    throw new Error(`expected response, got ${JSON.stringify(response)}`);
  }
  const record = response as Record<string, unknown>;
  if (record.error === null) {
    return { result: record.result, error: null };
  }
  if (record.error === undefined || typeof record.error !== "object") {
    throw new Error(
      `expected error object, got ${JSON.stringify(record.error)}`,
    );
  }
  const errorRecord = record.error as Record<string, unknown>;
  const code =
    typeof errorRecord.code === "string" ? errorRecord.code : "UNKNOWN";
  const message =
    typeof errorRecord.message === "string" ? errorRecord.message : "";
  return { result: record.result, error: { code, message } };
}

async function waitForScrollback(
  host: StartedHost,
  sessionId: string,
  needle: string,
): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (host.runtime.pty.scrollback(sessionId).includes(needle)) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error(
    `timed out waiting for ${needle} in ${host.runtime.pty.scrollback(sessionId)}`,
  );
}

async function subscribeTerminal(
  url: string,
  sessionId: string,
): Promise<unknown> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const frames: unknown[] = [];
  const done = new Promise<void>((resolve, reject) => {
    socket.on("message", (data) => {
      const parsed: unknown = JSON.parse(String(data));
      frames.push(parsed);
      if (frames.length === 1) {
        socket.send(
          JSON.stringify({
            kind: "subscribe",
            method: "terminal.subscribe",
            schemaVersion: { major: 1, minor: 6 },
            params: { sessionId, cols: 80, rows: 24, viewer: "presentation" },
          }),
        );
        return;
      }
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "kind" in parsed &&
        parsed.kind === "snapshot"
      ) {
        socket.close();
      }
    });
    socket.once("close", () => resolve());
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      kind: "open",
      token: "test-token",
      manifest: {},
      clientIdentity: {
        kind: "cli",
        compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
        appVersion: "0.1.0",
      },
    }),
  );
  await done;
  const snapshot = frames.find(
    (frame) =>
      frame !== null &&
      typeof frame === "object" &&
      "kind" in frame &&
      frame.kind === "snapshot",
  );
  if (snapshot === undefined) {
    throw new Error(`expected snapshot, got ${JSON.stringify(frames)}`);
  }
  return snapshot;
}
