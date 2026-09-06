import { describe, expect, it } from "vitest";
import { ShutdownCoordinator } from "../lifecycle/shutdown";

describe("shutdown coordinator", () => {
  it("denies a competing transition and regrants the same one", () => {
    const coordinator = new ShutdownCoordinator();
    const first = coordinator.claimFor("cli-stop-a", 60_000, "shutdown", 1_000);
    expect(first?.token.length).toBeGreaterThan(0);
    // A different coordinator racing the same host is what `busy` is for.
    expect(
      coordinator.claimFor("cli-stop-b", 60_000, "restart", 1_100),
    ).toBeNull();
    // A retried dial is one transition, so it gets its own token back.
    expect(
      coordinator.claimFor("cli-stop-a", 60_000, "shutdown", 1_200)?.token,
    ).toBe(first?.token);
  });

  it("expires a claim nobody committed", () => {
    const coordinator = new ShutdownCoordinator();
    const claim = coordinator.claimFor("cli-stop-a", 5_000, "shutdown", 0);
    expect(coordinator.current(4_999)).not.toBeNull();
    expect(coordinator.current(5_000)).toBeNull();
    expect(coordinator.take(claim?.token ?? "", 5_000)).toBeNull();
    expect(
      coordinator.claimFor("cli-stop-b", 5_000, "shutdown", 5_000),
    ).not.toBeNull();
  });

  it("takes a claim exactly once", () => {
    const coordinator = new ShutdownCoordinator();
    const claim = coordinator.claimFor("cli-restart-a", 5_000, "restart", 0);
    expect(coordinator.take("nope", 1)).toBeNull();
    expect(coordinator.take(claim?.token ?? "", 1)?.intent).toBe("restart");
    expect(coordinator.take(claim?.token ?? "", 2)).toBeNull();
  });
});
