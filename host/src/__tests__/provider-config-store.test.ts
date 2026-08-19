import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  providerCliStateSchema,
  providerIdSchema,
  type ProviderDisabledBy,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import {
  buildProviderCatalog,
  buildProviderState,
  emptyProviderRuntimeFacts,
  LOCAL_PROVIDER_IDS,
  type ProviderRuntimeFacts,
} from "../provider-catalog";
import {
  ProviderConfigError,
  ProviderConfigStore,
} from "../provider-config-store";

const temporaryDirectories: string[] = [];
const LOCAL_USER: ProviderDisabledBy = {
  userId: "local-user",
  handle: null,
  at: 1_700_000_000_000,
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ProviderConfigStore", () => {
  it("uses complete non-secret defaults for an empty host home", async () => {
    const hostHome = await temporaryHostHome();
    const store = await ProviderConfigStore.open(hostHome);

    expect(store.list()).toHaveLength(providerIdSchema.options.length);
    expect(store.get("codex")).toEqual({
      providerId: "codex",
      selection: { kind: "path" },
      enabled: true,
      disabledBy: null,
      customPaths: [],
      terminalAgentArgs: "",
      envOverrides: [],
    });
    await expect(readFile(store.path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("atomically persists updates and reloads them after restart", async () => {
    const hostHome = await temporaryHostHome();
    const executable = join(hostHome, "bin", "codex");
    const store = await ProviderConfigStore.open(hostHome);

    await store.addCustomPath("codex", executable);
    await Promise.all([
      store.setTerminalAgentArgs("codex", "--full-auto"),
      store.setEnvOverride("codex", "OPENAI_BASE_URL", "https://local.test"),
      store.setEnvOverride("codex", "UNSET_ME", null),
      store.setEnvOverride("codex", "REMOVE_ME", "temporary"),
    ]);
    await store.deleteEnvOverride("codex", "REMOVE_ME");
    await store.setSelection("codex", { kind: "custom", path: executable });
    await store.setEnabled("codex", false, LOCAL_USER);

    const restarted = await ProviderConfigStore.open(hostHome);
    expect(restarted.get("codex")).toEqual({
      providerId: "codex",
      selection: { kind: "custom", path: executable },
      enabled: false,
      disabledBy: LOCAL_USER,
      customPaths: [executable],
      terminalAgentArgs: "--full-auto",
      envOverrides: [
        { key: "OPENAI_BASE_URL", value: "https://local.test" },
        { key: "UNSET_ME", value: null },
      ],
    });

    const configDirectory = join(hostHome, "config");
    expect(await readdir(configDirectory)).toEqual(["provider-overrides.json"]);
    expect(JSON.parse(await readFile(restarted.path, "utf8"))).toMatchObject({
      version: 1,
      providers: { codex: { terminalAgentArgs: "--full-auto" } },
    });
  });

  it("rejects invalid and duplicate paths and invalid environment keys", async () => {
    const hostHome = await temporaryHostHome();
    const store = await ProviderConfigStore.open(hostHome);
    const executable = join(hostHome, "bin", "claude");

    await expect(
      store.addCustomPath("claude-code", "relative/claude"),
    ).rejects.toMatchObject({
      code: "INVALID_PROVIDER_PATH",
    });
    await store.addCustomPath("claude-code", executable);
    await expect(
      store.addCustomPath(
        "claude-code",
        join(hostHome, "bin", "nested", "..", "claude"),
      ),
    ).rejects.toMatchObject({ code: "CUSTOM_PATH_DUPLICATE" });
    await expect(
      store.setSelection("claude-code", {
        kind: "custom",
        path: join(hostHome, "missing", "claude"),
      }),
    ).rejects.toMatchObject({ code: "CUSTOM_PATH_NOT_FOUND" });
    await expect(
      store.setEnvOverride("claude-code", "NOT-AN-ENV-KEY", "value"),
    ).rejects.toMatchObject({ code: "INVALID_ENVIRONMENT_KEY" });
  });

  it("rejects corrupt persisted state instead of silently resetting it", async () => {
    const hostHome = await temporaryHostHome();
    const first = await ProviderConfigStore.open(hostHome);
    await first.setTerminalAgentArgs("codex", "--search");
    await writeFile(first.path, "{ definitely-not-json", "utf8");

    await expect(ProviderConfigStore.open(hostHome)).rejects.toBeInstanceOf(
      ProviderConfigError,
    );
  });
});

describe("provider catalog", () => {
  it("returns every released provider id and marks unprobed binaries unavailable", async () => {
    const store = await ProviderConfigStore.open(await temporaryHostHome());
    const catalog = buildProviderCatalog(store, emptyProviderRuntimeFacts());

    expect(LOCAL_PROVIDER_IDS).toEqual(providerIdSchema.options);
    expect(catalog.map((provider) => provider.providerId)).toEqual(
      providerIdSchema.options,
    );
    expect(providerCliStateSchema.array().parse(catalog)).toEqual(catalog);
    expect(
      catalog.every(
        (provider) =>
          provider.cliBinaryResolved === false &&
          provider.auth.status === "unavailable" &&
          provider.apiKey.supported === false &&
          provider.candidates.every((candidate) => !candidate.available),
      ),
    ).toBe(true);
  });

  it("uses redacted API-key metadata without admitting secret contents", async () => {
    const store = await ProviderConfigStore.open(await temporaryHostHome());
    const runtimeFacts = new Map<ProviderId, ProviderRuntimeFacts>();
    runtimeFacts.set("cursor", {
      bundled: null,
      path: {
        path: "/usr/local/bin/cursor-agent",
        version: "1.0.0",
        available: true,
        versionPending: false,
      },
      custom: new Map(),
      auth: {
        status: "configured",
        badgeText: "API key",
        label: null,
        detail: null,
      },
      authPending: false,
      checkedAt: 1_700_000_000_000,
      availabilityPending: false,
      apiKey: { supported: true, configured: true, source: "stored" },
    });

    const state = buildProviderState(
      store.get("cursor"),
      runtimeFacts.get("cursor"),
    );
    expect(state.apiKey).toEqual({
      supported: true,
      configured: true,
      source: "stored",
    });
    expect(Object.keys(state.apiKey).sort()).toEqual([
      "configured",
      "source",
      "supported",
    ]);
    expect(JSON.stringify(state)).not.toContain("sk-secret-value");
  });
});

async function temporaryHostHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "traycer-provider-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
