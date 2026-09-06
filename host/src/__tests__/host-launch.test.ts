import { describe, expect, it } from "vitest";
import { launchHostStatusOnce } from "./launch-status-once";

describe("traycer-host CLI entry", () => {
  it("answers host.status with ready hostId on two fresh launches", async () => {
    const first = await launchHostStatusOnce();
    const second = await launchHostStatusOnce();
    expect(first.ready).toBe(true);
    expect(second.ready).toBe(true);
    expect(first.hostId.length).toBeGreaterThan(0);
    expect(second.hostId.length).toBeGreaterThan(0);
  }, 30_000);
});
