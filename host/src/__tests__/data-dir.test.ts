import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  defaultHostDataDir,
  parseHostDataDirArg,
  resolveHostDataDir,
} from "../data-dir";

describe("parseHostDataDirArg", () => {
  it("reads a two-token flag", () => {
    expect(parseHostDataDirArg(["--host-data-dir", "/tmp/traycer-host"])).toBe(
      "/tmp/traycer-host",
    );
  });

  it("reads an equals form", () => {
    expect(parseHostDataDirArg(["--host-data-dir=/tmp/slot"])).toBe(
      "/tmp/slot",
    );
  });

  it("returns null when the flag is absent", () => {
    expect(parseHostDataDirArg(["--listen", "0"])).toBeNull();
  });
});

describe("resolveHostDataDir", () => {
  it("defaults to the oss slot under ~/.traycer/host", () => {
    expect(resolveHostDataDir([])).toBe(defaultHostDataDir());
    expect(defaultHostDataDir()).toBe(
      join(homedir(), ".traycer", "host", "oss"),
    );
  });

  it("rejects a relative path", () => {
    expect(() => resolveHostDataDir(["--host-data-dir", "relative"])).toThrow(
      /absolute path/,
    );
  });
});
