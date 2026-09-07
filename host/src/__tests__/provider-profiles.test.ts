import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentGetProviderProfileRateLimitsResponseSchema,
  agentListProviderProfilesResponseSchema,
} from "@traycer/protocol/host/agent/profiles";
import {
  providersListModelProvidersResponseSchema,
  providersSetProfileEnabledResponseSchema,
} from "@traycer/protocol/host/provider-schemas";
import {
  providersCancelMcpAuthResponseSchema,
  providersMcpAuthResponseSchema,
  providersModelProviderAuthResponseSchema,
} from "@traycer/protocol/host/provider-schemas";
import { providersRefreshProfileStatusResponseSchema } from "@traycer/protocol/host/rate-limit/schemas";
import { dispatchHostRpc, type DispatchOutcome } from "../rpc/dispatch";
import type { HostRuntime } from "../runtime";
import { startHost, type StartedHost } from "../start-host";

/**
 * The ambient CLI login is the only profile this host has, so every method
 * here is either a real read of it or a refusal - never the analog's
 * fabricated managed profile.
 *
 * Driven through `dispatchHostRpc` rather than the handlers directly, because
 * dispatch is what validates a result against the negotiated contract: a
 * handler that returns a shape its own response schema rejects fails here and
 * nowhere else.
 */
describe("provider profiles", () => {
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

  it("lists one ambient profile, for the harness that was asked about", async () => {
    const host = await boot();

    const result = await call(host.runtime, "agent.listProviderProfiles", 2, {
      epicId: "e-1",
      senderAgentId: "a-1",
      harnessId: "codex",
    });

    expect(result.ok).toBe(true);
    const parsed = agentListProviderProfilesResponseSchema.parse(
      readResult(result),
    );
    // The analog answered `claude-code` whatever it was asked, and no
    // profiles at all.
    expect(parsed.providerId).toBe("codex");
    expect(parsed.profiles).toHaveLength(1);
    expect(parsed.profiles[0].selection).toStrictEqual({ kind: "ambient" });
    expect(parsed.profiles[0].isEffectiveLastUsed).toBe(true);
  });

  it("refuses a managed profile rather than inventing its limits", async () => {
    const host = await boot();

    const managed = await call(
      host.runtime,
      "agent.getProviderProfileRateLimits",
      2,
      {
        epicId: "e-1",
        senderAgentId: "a-1",
        harnessId: "codex",
        profileSelection: { kind: "profile", profileId: "sub-1" },
      },
    );

    expect(managed).toMatchObject({ ok: false, code: "RPC_ERROR" });

    const ambient = await call(
      host.runtime,
      "agent.getProviderProfileRateLimits",
      2,
      {
        epicId: "e-1",
        senderAgentId: "a-1",
        harnessId: "codex",
        profileSelection: { kind: "ambient" },
      },
    );

    const parsed = agentGetProviderProfileRateLimitsResponseSchema.parse(
      readResult(ambient),
    );
    // A real read of the machine, whatever it says - not the analog's
    // `available: true` with every limit null.
    expect(parsed.rateLimits.provider).toBe("codex");
  });

  it("refreshes the ambient profile and refuses any other", async () => {
    const host = await boot();

    const ambient = await call(
      host.runtime,
      "providers.refreshProfileStatus",
      1,
      { providerId: "codex", profileId: "ambient" },
    );
    expect(
      providersRefreshProfileStatusResponseSchema.parse(readResult(ambient))
        .providerRateLimits.provider,
    ).toBe("codex");

    expect(
      await call(host.runtime, "providers.refreshProfileStatus", 1, {
        providerId: "codex",
        profileId: "sub-1",
      }),
    ).toMatchObject({ ok: false });
  });

  it("routes the ambient toggle to the provider's own enabled flag", async () => {
    const host = await boot();

    const off = await call(host.runtime, "providers.setProfileEnabled", 1, {
      providerId: "codex",
      profileId: "ambient",
      enabled: false,
    });

    // The analog echoed a profile called `oss` and ignored the flag.
    expect(
      providersSetProfileEnabledResponseSchema.parse(readResult(off)),
    ).toStrictEqual({ profileId: "ambient", enabled: false });
    // Actually written, not merely reported: one login means the profile and
    // the provider are the same switch.
    expect(
      host.runtime.store
        .snapshot()
        .providers.find((row) => row.providerId === "codex")?.enabled,
    ).toBe(false);

    expect(
      await call(host.runtime, "providers.setProfileEnabled", 1, {
        providerId: "codex",
        profileId: "sub-1",
        enabled: true,
      }),
    ).toMatchObject({ ok: false });
  });

  it("refuses to redeem a reset credit it cannot redeem", async () => {
    const host = await boot();

    // The analog answered `reset`: a limit cleared and a credit spent.
    expect(
      await call(host.runtime, "providers.consumeRateLimitResetCredit", 1, {
        providerId: "codex",
        profileId: "ambient",
        idempotencyKey: "k-1",
        creditId: null,
      }),
    ).toMatchObject({ ok: false, code: "RPC_ERROR" });
  });

  it("says the model-provider capability is unavailable, not empty", async () => {
    const host = await boot();

    const result = await call(host.runtime, "providers.listModelProviders", 1, {
      providerId: "opencode",
    });

    expect(
      providersListModelProvidersResponseSchema.parse(readResult(result))
        .result,
    ).toMatchObject({ ok: false, code: "capability_unavailable" });
  });

  it("answers both auth flows unsupported, not with an OAuth URL", async () => {
    const host = await boot();

    // The analog picked the union's first arm and handed the client
    // `{kind: "authorizationUrl", authorizationUrl: "oss"}` - a flow it would
    // start by opening `oss` in a browser.
    expect(
      providersMcpAuthResponseSchema.parse(
        readResult(
          await call(host.runtime, "providers.mcpAuth", 1, {
            providerId: "opencode",
            action: {
              action: "login",
              scope: "global",
              workspaceRoot: null,
              serverName: "srv",
            },
          }),
        ),
      ).result.kind,
    ).toBe("unsupported");

    expect(
      providersModelProviderAuthResponseSchema.parse(
        readResult(
          await call(host.runtime, "providers.modelProviderAuth", 1, {
            providerId: "opencode",
            action: {
              action: "startOauth",
              modelProviderId: "anthropic",
              methodIndex: 0,
              inputs: {},
            },
          }),
        ),
      ).result.kind,
    ).toBe("unsupported");

    // Nothing can be pending, so nothing was torn down.
    expect(
      providersCancelMcpAuthResponseSchema.parse(
        readResult(
          await call(host.runtime, "providers.cancelMcpAuth", 1, {
            providerId: "opencode",
            context: {
              scope: "global",
              workspaceRoot: null,
              serverName: "srv",
            },
          }),
        ),
      ),
    ).toMatchObject({ cancelled: false, result: { kind: "unsupported" } });
  });

  function call(
    runtime: HostRuntime,
    method: string,
    major: number,
    params: unknown,
  ): Promise<DispatchOutcome> {
    return dispatchHostRpc(method, { major, minor: 0 }, params, runtime);
  }

  function readResult(value: { readonly ok: boolean }): unknown {
    if (!value.ok) {
      throw new Error(`dispatch refused: ${JSON.stringify(value)}`);
    }
    return Reflect.get(value, "result");
  }

  async function boot(): Promise<StartedHost> {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    started = await startHost({
      argv: ["--host-data-dir", tempDir],
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    return started;
  }
});
