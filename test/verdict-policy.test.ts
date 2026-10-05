import { describe, expect, it } from "vitest";

import type { OnError, Verdicts } from "#src/config-schema";
import {
  applyVerdictPolicy,
  COULD_NOT_CONFIRM_REASON,
  FAILURE_KINDS,
  failureDenyReason,
  type FailureKind,
  type LinkOutcome,
} from "#src/verdict-policy";

const VERDICTS: Verdicts[] = ["allow-deny-defer", "allow-defer", "allow-deny"];
const ON_ERROR: OnError[] = ["defer", "deny"];

describe("applyVerdictPolicy: answers", () => {
  it.each(VERDICTS.flatMap((verdicts) => ON_ERROR.map((onError) => [verdicts, onError] as const)))(
    "an allow passes through under %s / onError %s",
    (verdicts, onError) => {
      expect(applyVerdictPolicy({ kind: "allow" }, { verdicts, onError })).toEqual({
        kind: "allow",
      });
    },
  );

  it.each([
    ["allow-deny-defer", { kind: "deny", reason: "force push" }],
    ["allow-defer", { kind: "defer" }],
    ["allow-deny", { kind: "deny", reason: "force push" }],
  ] as const)("a deny under %s yields %j", (verdicts, expected) => {
    for (const onError of ON_ERROR) {
      expect(
        applyVerdictPolicy({ kind: "deny", reason: "force push" }, { verdicts, onError }),
      ).toEqual(expected);
    }
  });

  it.each([
    ["allow-deny-defer", { kind: "defer" }],
    ["allow-defer", { kind: "defer" }],
    ["allow-deny", { kind: "deny", reason: COULD_NOT_CONFIRM_REASON }],
  ] as const)("an uncertain answer under %s yields %j", (verdicts, expected) => {
    for (const onError of ON_ERROR) {
      expect(applyVerdictPolicy({ kind: "uncertain" }, { verdicts, onError })).toEqual(
        expected,
      );
    }
  });

  it.each([
    ["allow-deny-defer", { kind: "defer" }],
    ["allow-defer", { kind: "defer" }],
    ["allow-deny", { kind: "deny", reason: COULD_NOT_CONFIRM_REASON }],
  ] as const)("an over-budget ask under %s yields %j", (verdicts, expected) => {
    for (const onError of ON_ERROR) {
      expect(applyVerdictPolicy({ kind: "over-budget" }, { verdicts, onError })).toEqual(
        expected,
      );
    }
  });

  it("the could-not-confirm reason says the action could not be confirmed safe", () => {
    expect(COULD_NOT_CONFIRM_REASON).toMatch(/could not be confirmed safe/);
  });
});

describe("applyVerdictPolicy: failures", () => {
  it("covers every failure kind the links report", () => {
    expect([...FAILURE_KINDS].sort()).toEqual(
      [
        "auth-failed",
        "breaker-open",
        "call-failed",
        "guidance-load-failed",
        "internal-error",
        "model-unresolved",
        "timeout",
      ].sort(),
    );
  });

  it.each(FAILURE_KINDS.flatMap((failure) => VERDICTS.map((verdicts) => [failure, verdicts] as const)))(
    "failure %s under %s defers with onError defer",
    (failure, verdicts) => {
      expect(
        applyVerdictPolicy({ kind: "failure", failure }, { verdicts, onError: "defer" }),
      ).toEqual({ kind: "defer" });
    },
  );

  it.each(FAILURE_KINDS.flatMap((failure) => VERDICTS.map((verdicts) => [failure, verdicts] as const)))(
    "failure %s under %s denies with its fixed reason with onError deny",
    (failure, verdicts) => {
      expect(
        applyVerdictPolicy({ kind: "failure", failure }, { verdicts, onError: "deny" }),
      ).toEqual({ kind: "deny", reason: failureDenyReason(failure) });
    },
  );

  it.each(FAILURE_KINDS)("the %s deny reason names the failure and a way forward", (failure) => {
    const reason = failureDenyReason(failure);
    expect(reason).toMatch(/retry later or take another route/i);
    expect(reason).not.toMatch(/unsafe|dangerous|harmful|not safe/i);
    expect(reason).toMatch(/^[\x20-\x7e]+$/);
  });

  it("gives each failure kind a distinct reason", () => {
    const reasons = new Set(FAILURE_KINDS.map(failureDenyReason));
    expect(reasons.size).toBe(FAILURE_KINDS.length);
  });

  it("never allows any failure under any setting", () => {
    const outcomes: LinkOutcome[] = FAILURE_KINDS.map((failure: FailureKind) => ({
      kind: "failure",
      failure,
    }));
    for (const outcome of outcomes) {
      for (const verdicts of VERDICTS) {
        for (const onError of ON_ERROR) {
          expect(applyVerdictPolicy(outcome, { verdicts, onError }).kind).not.toBe("allow");
        }
      }
    }
  });
});
