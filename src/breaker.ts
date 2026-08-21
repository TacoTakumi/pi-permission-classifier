/**
 * Circuit breaker for the judge model call (REQ-11): 3 consecutive failures
 * or timeouts open it for a 60-second cooldown, during which asks defer
 * instantly with no model call. After the cooldown the next ask tries the
 * model again (half-open); a success closes the breaker and resets the
 * counter. Open and close are recorded to the review log, on the log of the
 * ask that crossed the transition.
 *
 * Failing open (deferring) matches the package invariant: a broken judge
 * means more prompting, never less — and no per-ask timeout pile-up while
 * the model is down.
 */

import type { AuthorizerLog } from "@gotgenes/pi-permission-system";

/** Consecutive failures that open the breaker. */
export const BREAKER_FAILURE_THRESHOLD = 3;

/** How long an open breaker short-circuits asks, in milliseconds. */
export const BREAKER_COOLDOWN_MS = 60_000;

/** Review-log event: the breaker opened (threshold reached). */
const BREAKER_OPEN_EVENT = "classifier.breaker_open";
/** Review-log event: the breaker closed (post-cooldown success). */
const BREAKER_CLOSE_EVENT = "classifier.breaker_close";

export class CircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt: number | undefined;

  /** Whether asks should short-circuit right now (open and cooling down). */
  isOpen(): boolean {
    return (
      this.openedAt !== undefined &&
      Date.now() - this.openedAt < BREAKER_COOLDOWN_MS
    );
  }

  /**
   * Record a model-call failure or timeout. Opens (and logs) when the
   * consecutive count reaches the threshold; a failure on the post-cooldown
   * retry restarts the cooldown window.
   */
  recordFailure(log: AuthorizerLog, requestId: string): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < BREAKER_FAILURE_THRESHOLD) {
      return;
    }
    const reopening = this.openedAt !== undefined;
    this.openedAt = Date.now();
    if (!reopening) {
      log.review(BREAKER_OPEN_EVENT, {
        requestId,
        consecutiveFailures: this.consecutiveFailures,
        cooldownMs: BREAKER_COOLDOWN_MS,
      });
    }
  }

  /** Record a completed model call; closes (and logs) an open breaker. */
  recordSuccess(log: AuthorizerLog, requestId: string): void {
    const wasOpen = this.openedAt !== undefined;
    this.consecutiveFailures = 0;
    this.openedAt = undefined;
    if (wasOpen) {
      log.review(BREAKER_CLOSE_EVENT, { requestId });
    }
  }
}
