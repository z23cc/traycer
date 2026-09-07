import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_SNAPSHOT_BYTES,
  SNAPSHOT_HOOK_FLAG,
  captureFile,
  hasBlob,
  lineCounts,
  readBlob,
  runSnapshotHook,
  settleEdit,
  snapshotHookSettings,
  storageBytes,
  takeCompactSummary,
} from "../snapshots/snapshots";

describe("edit snapshots", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir !== null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  /**
   * The hook's stdin is what Claude wrote to it, recorded live: a pre event
   * before the write and a post event after, both naming the same call.
   */
  it("captures the file the hooks bracket and pairs both sides by call", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-snap-"));
    const file = join(tempDir, "h.txt");
    const dir = join(tempDir, "snapshots");
    await writeFile(file, "one\n");
    await runSnapshotHook(hookStdin("PreToolUse", "toolu_1", file), dir);
    await writeFile(file, "two\n");
    await runSnapshotHook(hookStdin("PostToolUse", "toolu_1", file), dir);

    const settled = await settleEdit(dir, "toolu_1");
    const before = sha256("one\n");
    const after = sha256("two\n");
    expect(settled).toEqual({
      before: { hash: before, reason: "snapshot" },
      after: { hash: after, reason: "snapshot" },
    });
    // Sharded like the released store: a directory per two-hex prefix.
    expect(
      await readFile(
        join(dir, "blobs", before.slice(0, 2), before.slice(2)),
        "utf8",
      ),
    ).toBe("one\n");
    expect(
      await readFile(
        join(dir, "blobs", after.slice(0, 2), after.slice(2)),
        "utf8",
      ),
    ).toBe("two\n");
    // Consumed: a second settle finds nothing, so a later call with the same
    // id cannot inherit this one's sides.
    expect(await settleEdit(dir, "toolu_1")).toEqual({
      before: null,
      after: null,
    });
    expect(lineCounts("one\n", "two\n")).toEqual({
      additions: 1,
      deletions: 1,
    });
  });

  it("still reads a blob this host wrote flat, before it sharded", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-snap-"));
    const dir = join(tempDir, "snapshots");
    const hash = sha256("old\n");
    await mkdir(join(dir, "blobs"), { recursive: true });
    await writeFile(join(dir, "blobs", hash), "old\n");
    expect(hasBlob(dir, hash)).toBe(true);
    expect(await readBlob(dir, hash)).toBe("old\n");
    expect(await storageBytes(dir)).toBe(4);
  });

  it("reads absence as a side that does not exist, not as a failure", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-snap-"));
    const dir = join(tempDir, "snapshots");
    expect(
      await captureFile(dir, join(tempDir, "never.txt"), MAX_SNAPSHOT_BYTES),
    ).toEqual({ hash: null, reason: "snapshot" });
    expect(lineCounts(null, "a\nb\n")).toEqual({ additions: 2, deletions: 0 });
  });

  it("refuses what it cannot serve as a diff, by the contract's words", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-snap-"));
    const dir = join(tempDir, "snapshots");
    const binary = join(tempDir, "b.bin");
    await writeFile(binary, Buffer.from([0x89, 0x50, 0x00, 0x47]));
    expect(await captureFile(dir, binary, MAX_SNAPSHOT_BYTES)).toEqual({
      hash: null,
      reason: "binary",
    });
    const big = join(tempDir, "big.txt");
    await writeFile(big, "x".repeat(64));
    expect(await captureFile(dir, big, 16)).toEqual({
      hash: null,
      reason: "too_large",
    });
  });

  /** The PostCompact hook's stdin, recorded live around `/compact`. */
  it("keeps the compaction summary the PostCompact hook was handed, once", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-snap-"));
    const dir = join(tempDir, "snapshots");
    await runSnapshotHook(
      '{"session_id":"87e99722-eb10-4c7d-8b77-3db9e9917b98","transcript_path":"/x.jsonl","cwd":"/w","prompt_id":"b686585b-a28e-4f22-8d81-ebe58e270c6a","hook_event_name":"PostCompact","trigger":"manual","compact_summary":"three."}',
      dir,
    );
    expect(
      await takeCompactSummary(dir, "87e99722-eb10-4c7d-8b77-3db9e9917b98"),
    ).toBe("three.");
    expect(
      await takeCompactSummary(dir, "87e99722-eb10-4c7d-8b77-3db9e9917b98"),
    ).toBeNull();
    // An empty summary is no summary.
    await runSnapshotHook(
      '{"session_id":"s2","hook_event_name":"PostCompact","trigger":"auto","compact_summary":""}',
      dir,
    );
    expect(await takeCompactSummary(dir, "s2")).toBeNull();
  });

  it("names this host's own binary as the hook", () => {
    const settings: unknown = JSON.parse(snapshotHookSettings("/data"));
    const pre = Reflect.get(
      Reflect.get(settings ?? {}, "hooks") ?? {},
      "PreToolUse",
    );
    const post = Reflect.get(
      Reflect.get(settings ?? {}, "hooks") ?? {},
      "PostToolUse",
    );
    expect(pre).toEqual(post);
    // And the compaction hook, unmatched: every compaction reports.
    expect(
      Reflect.get(Reflect.get(settings ?? {}, "hooks") ?? {}, "PostCompact"),
    ).toEqual([{ hooks: pre[0].hooks }]);
    const command = String(
      Reflect.get(
        (Reflect.get(pre[0], "hooks") as unknown[])[0] ?? {},
        "command",
      ),
    );
    expect(Reflect.get(pre[0], "matcher")).toBe(
      "Edit|Write|MultiEdit|NotebookEdit",
    );
    expect(command).toContain(`"${process.execPath}"`);
    // Every part is quoted, the flag included - harmless to a shell, and one
    // rule for all of them.
    expect(command).toContain(
      `"${SNAPSHOT_HOOK_FLAG}" "${join("/data", "snapshots")}"`,
    );
  });
});

function hookStdin(event: string, toolUseId: string, filePath: string): string {
  return JSON.stringify({
    session_id: "sess",
    hook_event_name: event,
    tool_name: "Edit",
    tool_input: { file_path: filePath, old_string: "one", new_string: "two" },
    tool_use_id: toolUseId,
  });
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
