import { describe, expect, it } from "vitest";

import { formatHealthSuffix, SessionHealth } from "#src/health";

describe("SessionHealth", () => {
  it("starts at count 0 with no reason", () => {
    const health = new SessionHealth();
    expect(health.count).toBe(0);
    expect(health.lastFailureReason).toBeUndefined();
  });

  it("counts failure defers and keeps the last reason", () => {
    const health = new SessionHealth();
    health.record({ verdict: "defer", deferReason: "timeout" });
    health.record({ verdict: "defer", deferReason: "timeout" });
    expect(health.count).toBe(2);
    expect(health.lastFailureReason).toBe("timeout");
    health.record({ verdict: "defer", deferReason: "context-over-budget" });
    expect(health.count).toBe(3);
    expect(health.lastFailureReason).toBe("context-over-budget");
  });

  it("clears the reason on an allow and keeps the count", () => {
    const health = new SessionHealth();
    health.record({ verdict: "defer", deferReason: "timeout" });
    health.record({ verdict: "defer", deferReason: "timeout" });
    health.record({ verdict: "allow" });
    expect(health.count).toBe(2);
    expect(health.lastFailureReason).toBeUndefined();
  });

  it("leaves everything unchanged on a deny", () => {
    const health = new SessionHealth();
    health.record({ verdict: "deny" });
    expect(health.count).toBe(0);
    expect(health.lastFailureReason).toBeUndefined();
    health.record({ verdict: "defer", deferReason: "timeout" });
    health.record({ verdict: "deny" });
    expect(health.count).toBe(1);
    expect(health.lastFailureReason).toBe("timeout");
  });

  it("treats a model defer verdict as a model verdict, not a failure", () => {
    const health = new SessionHealth();
    health.record({ verdict: "defer", deferReason: "timeout" });
    health.record({ verdict: "defer", deferReason: "model-verdict" });
    expect(health.count).toBe(1);
    expect(health.lastFailureReason).toBeUndefined();
  });

  it("resets to the initial state", () => {
    const health = new SessionHealth();
    health.record({ verdict: "defer", deferReason: "call-failed" });
    health.reset();
    expect(health.count).toBe(0);
    expect(health.lastFailureReason).toBeUndefined();
  });
});

describe("formatHealthSuffix", () => {
  it.each([
    [{ count: 0, lastFailureReason: undefined }, 0, ""],
    [{ count: 1, lastFailureReason: "timeout" }, 0, " | timeout x1"],
    [{ count: 3, lastFailureReason: "call-failed" }, 0, " | call-failed x3"],
    [
      { count: 1, lastFailureReason: "guidance-load-failed" },
      0,
      " | guidance-load-failed x1",
    ],
    [{ count: 2, lastFailureReason: undefined }, 0, " | defers x2"],
    [{ count: 0, lastFailureReason: undefined }, 60_000, " | breaker open 60s"],
    [{ count: 3, lastFailureReason: "timeout" }, 59_001, " | breaker open 60s"],
    [{ count: 3, lastFailureReason: "timeout" }, 1, " | breaker open 1s"],
    [{ count: 3, lastFailureReason: undefined }, 12_500, " | breaker open 13s"],
  ])("renders %j with remainingMs %d as %j", (health, remainingMs, suffix) => {
    expect(formatHealthSuffix(health, remainingMs)).toBe(suffix);
  });

  it("follows the record through a timeout, deny, allow sequence", () => {
    const health = new SessionHealth();
    health.record({ verdict: "defer", deferReason: "timeout" });
    expect(formatHealthSuffix(health, 0)).toBe(" | timeout x1");
    health.record({ verdict: "deny" });
    expect(formatHealthSuffix(health, 0)).toBe(" | timeout x1");
    health.record({ verdict: "allow" });
    expect(formatHealthSuffix(health, 0)).toBe(" | defers x1");
  });

  it("shows no suffix for a deny at count 0", () => {
    const health = new SessionHealth();
    health.record({ verdict: "deny" });
    expect(formatHealthSuffix(health, 0)).toBe("");
  });
});
