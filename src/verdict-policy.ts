/**
 * The verdict policy both authorizer links share: each link reduces what
 * happened on an ask to a `LinkOutcome`, and the policy applies the link's
 * `verdicts` and `onError` settings to turn it into the verdict the chain
 * sees.
 *
 * Pure: no I/O, no clock. A failure never allows. It defers, or denies with
 * a fixed reason when `onError` is `deny`.
 */

import type { AuthorizerVerdict } from "@gotgenes/pi-permission-system";

import type { OnError, Verdicts } from "./config-schema";

/** Every way a link can fail to judge an ask. */
export const FAILURE_KINDS = [
  "timeout",
  "call-failed",
  "breaker-open",
  "model-unresolved",
  "auth-failed",
  "guidance-load-failed",
  "internal-error",
] as const;

export type FailureKind = (typeof FAILURE_KINDS)[number];

/**
 * What a link concluded about an ask. `uncertain` covers both an answer
 * below the thresholds and a model that chose defer; `over-budget` is an ask
 * whose full command was too large to send to any model.
 */
export type LinkOutcome =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "uncertain" }
  | { kind: "over-budget" }
  | { kind: "failure"; failure: FailureKind };

/** The settings the policy applies. */
export interface VerdictPolicy {
  verdicts: Verdicts;
  onError: OnError;
}

/** The deny reason when `allow-deny` turns an uncertain outcome into deny. */
export const COULD_NOT_CONFIRM_REASON =
  "The permission reviewer denied this action because it could not be confirmed safe.";

const FAILURE_DESCRIPTIONS: Record<FailureKind, string> = {
  timeout: "the review model timed out",
  "call-failed": "the review model call failed",
  "breaker-open": "the review model is paused after repeated failures",
  "model-unresolved": "the review model is not configured or was not found",
  "auth-failed": "the credentials for the review model could not be resolved",
  "guidance-load-failed": "the guidance files could not be loaded",
  "internal-error": "the permission reviewer hit an internal error",
};

/**
 * The fixed deny reason for a failure under `onError` deny. It names the
 * failure and a way forward, and never calls the action unsafe: the
 * reviewer did not judge it.
 */
export function failureDenyReason(failure: FailureKind): string {
  return `The permission reviewer could not judge this action: ${FAILURE_DESCRIPTIONS[failure]}. Retry later or take another route.`;
}

/** Apply `verdicts` and `onError` to a link outcome. */
export function applyVerdictPolicy(
  outcome: LinkOutcome,
  policy: VerdictPolicy,
): AuthorizerVerdict {
  switch (outcome.kind) {
    case "allow":
      return { kind: "allow" };
    case "deny":
      return policy.verdicts === "allow-defer"
        ? { kind: "defer" }
        : { kind: "deny", reason: outcome.reason };
    case "uncertain":
    case "over-budget":
      return policy.verdicts === "allow-deny"
        ? { kind: "deny", reason: COULD_NOT_CONFIRM_REASON }
        : { kind: "defer" };
    case "failure":
      return policy.onError === "deny"
        ? { kind: "deny", reason: failureDenyReason(outcome.failure) }
        : { kind: "defer" };
  }
}
