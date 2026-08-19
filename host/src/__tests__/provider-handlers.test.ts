import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  providersAddCustomPathResponseSchema,
  providersDeleteEnvOverrideResponseSchema,
  providersDetectVersionResponseSchema,
  providersListResponseSchema,
  providersRemoveCustomPathResponseSchema,
  providersSetEnabledResponseSchema,
  providersSetEnvOverrideResponseSchema,
  providersSetSelectionResponseSchema,
  providersSetTerminalAgentArgsResponseSchema,
  type ProviderCliState,
  type ProviderId,
  providerIdSchema,
} from "@traycer/protocol/host/provider-schemas";
import {
  createProviderHandlers,
  probeProviderVersion,
  type ProviderHandlerResult,
  type ProviderMethodHandler,
} from "../provider-handlers";
import {
  emptyProviderRuntimeFacts,
  type ProviderRuntimeFacts,
} from "../provider-catalog";
import { ProviderConfigStore } from "../provider-config-store";

const temporaryDirectories: string[] = [];
const NOW = 1_700_000_000_000;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("provider handlers", () => {
  it("returns the canonical provider catalog from injected runtime facts", async () => {
    const config = await ProviderConfigStore.open(await temporaryHostHome());
    const runtimeFacts = emptyProviderRuntimeFacts();
    const codexFacts: ProviderRuntimeFacts = {
      bundled: null,
      path: {
        path: "/usr/local/bin/codex",
        version: "1.2.3",
        available: true,
        versionPending: false,
      },
      custom: new Map(),
      auth: null,
      authPending: false,
      checkedAt: NOW,
      availabilityPending: false,
      apiKey: null,
    };
    const populatedRuntimeFacts = new Map(runtimeFacts);
    populatedRuntimeFacts.set("codex", codexFacts);
    const handlers = createProviderHandlers({
      config,
      runtimeFacts: () => populatedRuntimeFacts,
    });

    const response = await invoke(handlers["providers.list"], {});
    const parsed = providersListResponseSchema.parse(okResult(response));
    expect(parsed.providers).toHaveLength(providerIdSchema.options.length);
    expect(provider(parsed.providers, "codex")).toMatchObject({
      cliBinaryResolved: true,
      checkedAt: NOW,
      selected: { kind: "path" },
    });
    expect(parsed.native).toBeNull();
  });

  it("returns canonical updated state for every locally supported mutation", async () => {
    const hostHome = await temporaryHostHome();
    const config = await ProviderConfigStore.open(hostHome);
    const customPath = join(hostHome, "bin", "codex");
    const handlers = createProviderHandlers({ config, now: () => NOW });

    const added = await invoke(handlers["providers.addCustomPath"], {
      providerId: "codex",
      path: customPath,
    });
    expect(
      providersAddCustomPathResponseSchema.parse(okResult(added)).state
        .candidates,
    ).toContainEqual(
      expect.objectContaining({ kind: "custom", path: customPath }),
    );

    const selected = await invoke(handlers["providers.setSelection"], {
      providerId: "codex",
      selection: { kind: "custom", path: customPath },
    });
    expect(
      providersSetSelectionResponseSchema.parse(okResult(selected)).state
        .selected,
    ).toEqual({ kind: "custom", path: customPath });

    const args = await invoke(handlers["providers.setTerminalAgentArgs"], {
      providerId: "codex",
      terminalAgentArgs: "--full-auto",
    });
    expect(
      providersSetTerminalAgentArgsResponseSchema.parse(okResult(args)).state
        .terminalAgentArgs,
    ).toBe("--full-auto");

    const environment = await invoke(handlers["providers.setEnvOverride"], {
      providerId: "codex",
      key: "OPENAI_BASE_URL",
      value: "https://local.test",
    });
    expect(
      providersSetEnvOverrideResponseSchema.parse(okResult(environment)).state
        .envOverrides,
    ).toEqual([{ key: "OPENAI_BASE_URL", value: "https://local.test" }]);

    const deletedEnvironment = await invoke(
      handlers["providers.deleteEnvOverride"],
      { providerId: "codex", key: "OPENAI_BASE_URL" },
    );
    expect(
      providersDeleteEnvOverrideResponseSchema.parse(
        okResult(deletedEnvironment),
      ).state.envOverrides,
    ).toEqual([]);

    const disabled = await invoke(handlers["providers.setEnabled"], {
      providerId: "codex",
      enabled: false,
    });
    expect(
      providersSetEnabledResponseSchema.parse(okResult(disabled)).state,
    ).toMatchObject({
      enabled: false,
      disabledBy: { userId: "local-user", handle: null, at: NOW },
    });

    const enabled = await invoke(handlers["providers.setEnabled"], {
      providerId: "codex",
      enabled: true,
    });
    expect(
      providersSetEnabledResponseSchema.parse(okResult(enabled)).state,
    ).toMatchObject({ enabled: true, disabledBy: null });

    const removed = await invoke(handlers["providers.removeCustomPath"], {
      providerId: "codex",
      path: customPath,
    });
    const removedState = providersRemoveCustomPathResponseSchema.parse(
      okResult(removed),
    ).state;
    expect(removedState.selected).toEqual({ kind: "path" });
    expect(removedState.candidates).not.toContainEqual(
      expect.objectContaining({ kind: "custom", path: customPath }),
    );
  });

  it("persists handler mutations across store reloads", async () => {
    const hostHome = await temporaryHostHome();
    const handlers = createProviderHandlers({
      config: await ProviderConfigStore.open(hostHome),
    });

    expect(
      await invoke(handlers["providers.setTerminalAgentArgs"], {
        providerId: "claude-code",
        terminalAgentArgs: "--dangerously-skip-permissions",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await invoke(handlers["providers.setEnvOverride"], {
        providerId: "claude-code",
        key: "ANTHROPIC_BASE_URL",
        value: "https://local.test",
      }),
    ).toMatchObject({ ok: true });

    const reloaded = await ProviderConfigStore.open(hostHome);
    expect(reloaded.get("claude-code")).toMatchObject({
      terminalAgentArgs: "--dangerously-skip-permissions",
      envOverrides: [
        { key: "ANTHROPIC_BASE_URL", value: "https://local.test" },
      ],
    });
  });

  it("uses an injected version probe and parses its canonical response", async () => {
    const config = await ProviderConfigStore.open(await temporaryHostHome());
    const handlers = createProviderHandlers({
      config,
      probeVersion: async (candidatePath) => ({
        executable: candidatePath === "/opt/bin/codex",
        version: "codex-cli 4.5.6",
      }),
    });

    const response = await invoke(handlers["providers.detectVersion"], {
      candidatePath: "/opt/bin/codex",
    });
    expect(
      providersDetectVersionResponseSchema.parse(okResult(response)),
    ).toEqual({
      executable: true,
      version: "codex-cli 4.5.6",
    });
  });

  it("bounds real version probes and reports execution failures honestly", async () => {
    const directory = await temporaryHostHome();
    const successPath = await executableScript(
      directory,
      "success",
      "printf 'provider 1.2.3\\n'",
    );
    const failurePath = await executableScript(directory, "failure", "exit 1");
    const timeoutPath = await executableScript(directory, "timeout", "sleep 1");

    await expect(probeProviderVersion(successPath, 2_000)).resolves.toEqual({
      executable: true,
      version: "provider 1.2.3",
    });
    await expect(probeProviderVersion(failurePath, 2_000)).resolves.toEqual({
      executable: true,
      version: null,
    });
    await expect(probeProviderVersion(timeoutPath, 20)).resolves.toEqual({
      executable: true,
      version: null,
    });
    await expect(
      probeProviderVersion(join(directory, "missing"), 20),
    ).resolves.toEqual({ executable: false, version: null });
  });

  it("rejects invalid and unsupported requests without mutating state", async () => {
    const config = await ProviderConfigStore.open(await temporaryHostHome());
    const handlers = createProviderHandlers({ config });

    await expect(
      invoke(handlers["providers.setEnvOverride"], {
        providerId: "codex",
        key: "INVALID-KEY",
        value: "secret",
      }),
    ).resolves.toMatchObject({ ok: false, code: "E_INVALID_ARGUMENT" });
    await expect(
      invoke(handlers["providers.list"], {
        native: {
          kind: "mcp",
          providerId: "codex",
          scope: "global",
          workspaceRoot: null,
        },
      }),
    ).resolves.toMatchObject({ ok: false, code: "E_HOST_UNSUPPORTED" });
    await expect(
      invoke(handlers["providers.setEnabled"], {
        providerId: "codex",
        enabled: true,
        profileAction: { type: "acknowledgeAmbientDrift" },
      }),
    ).resolves.toMatchObject({ ok: false, code: "E_HOST_UNSUPPORTED" });
    expect(config.get("codex")).toMatchObject({
      enabled: true,
      envOverrides: [],
    });
  });
});

async function temporaryHostHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "traycer-provider-handler-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function executableScript(
  directory: string,
  name: string,
  body: string,
): Promise<string> {
  const binDirectory = join(directory, "bin");
  await mkdir(binDirectory, { recursive: true });
  const path = join(binDirectory, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(path, 0o700);
  return path;
}

async function invoke(
  handler: ProviderMethodHandler,
  params: unknown,
): Promise<ProviderHandlerResult> {
  return handler(params);
}

function okResult(result: ProviderHandlerResult): unknown {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.result;
}

function provider(
  providers: readonly ProviderCliState[],
  providerId: ProviderId,
): ProviderCliState {
  const state = providers.find(
    (candidate) => candidate.providerId === providerId,
  );
  if (state === undefined) throw new Error(`Missing provider ${providerId}`);
  return state;
}
