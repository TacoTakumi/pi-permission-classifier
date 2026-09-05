/**
 * Per-session judge health: how often the classifier fell back to the
 * dialog this session, why it last did, and what the footer should say
 * about it. The reviewer reports each recorded decision through an injected
 * seam; the extension owns the record, appends the suffix to the footer
 * status, and resets the record at session shutdown.
 *
 * Only failure-path defers are health events. A model verdict (allow, deny,
 * or the judge's own defer) is the classifier working as designed: allow and
 * a model defer clear the pending reason, deny changes nothing, and neither
 * ever shows in the footer.
 *
 * Pure module: no UI, no filesystem, no node builtins.
 */

/** One recorded decision, as the reviewer reports it. */
export type HealthOutcome =
  | { verdict: "allow" }
  | { verdict: "deny" }
  | { verdict: "defer"; deferReason: string };

/** The judge's own defer: a model verdict, not a failure. */
const MODEL_DEFER_REASON = "model-verdict";

/** The read side of the record, all the formatter needs. */
export interface HealthSnapshot {
  /** Failure-path defers this session. */
  readonly count: number;
  /** Reason of the last failure defer; cleared by a later model verdict. */
  readonly lastFailureReason: string | undefined;
}

export class SessionHealth implements HealthSnapshot {
  private failures = 0;
  private reason: string | undefined;

  get count(): number {
    return this.failures;
  }

  get lastFailureReason(): string | undefined {
    return this.reason;
  }

  /** Fold one decision into the record. */
  record(outcome: HealthOutcome): void {
    switch (outcome.verdict) {
      case "allow":
        this.reason = undefined;
        return;
      case "deny":
        return;
      case "defer":
        if (outcome.deferReason === MODEL_DEFER_REASON) {
          this.reason = undefined;
          return;
        }
        this.failures += 1;
        this.reason = outcome.deferReason;
        return;
    }
  }

  /** Back to a fresh session: count 0, no reason. */
  reset(): void {
    this.failures = 0;
    this.reason = undefined;
  }
}

/**
 * The footer suffix for a health snapshot and the breaker's remaining
 * cooldown. Breaker open wins over everything and shows whole seconds,
 * rounded up. Otherwise the last failure reason with the count, or just the
 * count once a model verdict cleared the reason. Empty when there is nothing
 * to report.
 */
export function formatHealthSuffix(
  health: HealthSnapshot,
  breakerRemainingMs: number,
): string {
  if (breakerRemainingMs > 0) {
    return ` | breaker open ${Math.ceil(breakerRemainingMs / 1000)}s`;
  }
  if (health.count === 0) {
    return "";
  }
  const label = health.lastFailureReason ?? "defers";
  return ` | ${label} x${health.count}`;
}
