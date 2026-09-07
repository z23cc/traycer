import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchHostRpc, type DispatchOutcome } from "../rpc/dispatch";
import type { HostRuntime } from "../runtime";
import { startHost, type StartedHost } from "../start-host";

/**
 * Every one of these was on the analog fallback, which fills a schema from its
 * FIRST arm - and for a mutation the first arm is success. The assertions are
 * therefore about what the host now refuses to claim.
 *
 * Driven through `dispatchHostRpc`, so each result is validated against the
 * negotiated contract on the way out.
 */
describe("methods whose subject this host does not have", () => {
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

  it("reports a cloud-feed mutation as unavailable, never applied", async () => {
    const host = await boot();

    const marked = await call(
      host.runtime,
      "host.notifications.cloudFeed.markRead",
      { entryId: "n-1" },
    );

    // The analog said `{status: "applied", version: 0}`: read, and the feed
    // moved to version 0.
    expect(readResult(marked)).toStrictEqual({
      status: "unavailable",
      version: null,
    });
    expect(
      readResult(
        await call(host.runtime, "host.notifications.cloudFeed.clearAll", {
          observedVersion: null,
        }),
      ),
    ).toMatchObject({ status: "unavailable" });
  });

  it("never hands back invented bytes for a published chat", async () => {
    const host = await boot();
    const identity = { taskId: "t-1", chatId: "c-1", ownerUserId: "u-1" };

    // The analog answered `{status: "ok", bytesBase64: "oss"}` - four
    // characters for the client to hash against a digest and decode.
    expect(
      readResult(
        await call(host.runtime, "epic.readCloudChatPart", {
          ...identity,
          sha256: "a".repeat(64),
          declaredByteLength: 8,
        }),
      ),
    ).toStrictEqual({ outcome: { status: "not-found" } });
    expect(
      readResult(
        await call(host.runtime, "epic.chatReplicaRead", {
          epicId: "e-1",
          chatId: "c-1",
        }),
      ),
    ).toStrictEqual({ outcome: { status: "absent" } });
    // `not-found`, not an empty ref list: the union exists so "never
    // published" cannot be rendered as "this chat has no attachments".
    expect(
      readResult(
        await call(host.runtime, "epic.listCloudChatPayloads", identity),
      ),
    ).toStrictEqual({ outcome: { status: "not-found" } });
  });

  it("refuses a visibility flip it cannot describe", async () => {
    const host = await boot();

    // The response must carry the updated row; the analog invented one owned
    // by a user called `oss`.
    expect(
      await call(host.runtime, "epic.setCloudChatVisibility", {
        taskId: "t-1",
        chatId: "c-1",
        visibility: "task",
      }),
    ).toMatchObject({ ok: false, code: "RPC_ERROR" });
  });

  it("says GitHub could not be consulted, not that there is nothing there", async () => {
    const host = await boot();

    const result = readResult(
      await call(host.runtime, "mention.githubSearch", {
        epicId: "e-1",
        workspacePaths: ["/tmp/ws"],
        section: "issues",
        query: "",
        filter: {
          state: "open",
          involvement: "everyone",
          repository: {
            kind: "any",
            githubHost: "github.com",
            owner: "o",
            repo: "r",
          },
        },
      }),
    );

    // `ok` with no rows would mean "consulted GitHub, you have nothing".
    expect(result).toMatchObject({
      rows: [],
      sourceStatus: "gh-unavailable",
    });
  });

  it("refuses every pack mutation rather than reporting one done", async () => {
    const host = await boot();

    for (const method of [
      "providers.installPackVersion",
      "providers.removePackVersion",
      "providers.usePackVersion",
      "providers.refreshPackDiscovery",
    ]) {
      expect(
        await call(host.runtime, method, {
          providerId: "codex",
          version: "1.0.0",
        }),
      ).toMatchObject({ ok: false });
    }
    // Its own shape, and the same answer: the response echoes "the policy as
    // it now stands durably", and nothing here stands durably.
    expect(
      await call(host.runtime, "providers.setPackPolicy", {
        packId: "codex",
        autoDownload: true,
      }),
    ).toMatchObject({ ok: false });
  });

  function call(
    runtime: HostRuntime,
    method: string,
    params: unknown,
  ): Promise<DispatchOutcome> {
    return dispatchHostRpc(method, { major: 1, minor: 0 }, params, runtime);
  }

  function readResult(value: DispatchOutcome): unknown {
    if (!value.ok) {
      throw new Error(`dispatch refused: ${JSON.stringify(value)}`);
    }
    return value.result;
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
