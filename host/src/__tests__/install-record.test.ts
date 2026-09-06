import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  publishedRuntimeVersion,
  readInstallRuntimeVersion,
} from "../install-record";
import { HOST_VERSION } from "../version";

describe("publishedRuntimeVersion", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir !== null) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("falls back to HOST_VERSION when no install record exists", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    expect(await readInstallRuntimeVersion(tempDir)).toBeNull();
    expect(await publishedRuntimeVersion(tempDir)).toBe(HOST_VERSION);
  });

  it("uses the install record runtime stamp so a slot wrapper is not activation debt", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "traycer-host-"));
    await mkdir(join(tempDir, "install"), { recursive: true });
    await writeFile(
      join(tempDir, "install", "install.json"),
      `${JSON.stringify({
        version: "1.2.0",
        runtimeVersion: "1.2.0",
        installedAt: "2026-09-05T17:34:16.635Z",
      })}\n`,
      "utf8",
    );
    expect(await publishedRuntimeVersion(tempDir)).toBe("1.2.0");
  });
});
