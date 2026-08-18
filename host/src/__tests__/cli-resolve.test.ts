import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveHarnessExecutable } from "../cli-resolve";

const dirs: string[] = [];

afterEach(async () => {
  dirs.length = 0;
});

describe("resolveHarnessExecutable", () => {
  it("prefers TRAYCER_CLAUDE_PATH when the file is executable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "traycer-claude-"));
    dirs.push(dir);
    const path = join(dir, "claude");
    await writeFile(path, "#!/bin/sh\necho ok\n", { mode: 0o755 });
    await chmod(path, 0o755);
    expect(
      resolveHarnessExecutable("claude", {
        TRAYCER_CLAUDE_PATH: path,
        PATH: "",
        HOME: dir,
      }),
    ).toBe(path);
  });

  it("returns null when nothing is installed", () => {
    expect(
      resolveHarnessExecutable("codex", {
        PATH: "/nonexistent",
        HOME: "/nonexistent-home",
      }),
    ).toBeNull();
  });
});
