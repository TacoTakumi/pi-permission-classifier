/**
 * The auto-classifier reviewer: the `Authorizer` chain link this package
 * registers as `"classifier"`.
 *
 * The decision runs top to bottom, deferring at the first miss so the cheap
 * gates short-circuit before any model call:
 *   1. a config is loaded (else defer, recorded),
 *   2. the gate-authoritative surface is determinable and neither `path` nor
 *      `external_directory` (else defer — the engine caps any allow on those
 *      surfaces anyway, so the classifier never attempts them); every other
 *      surface, whatever its name, is judged,
 *   3. the extracted full-command context fits `contextBudgetBytes` (else
 *      defer, recorded — over-budget context is never rendered, REQ-07),
 *   4. the judge model and its auth resolve (else defer, recorded),
 *   5. the guidance seam selects the operator and trusted-project guidance
 *      files for this ask (a throw defers, recorded — no model call),
 *   6. the model reviews the ask facts plus guidance and its verdict is
 *      returned uncapped.
 *
 * Every failure path defers — more prompting, never less (ADR 0007
 * invariant). Each reviewed ask writes exactly one `classifier.decision`
 * review entry; raw model replies and the cheap short-circuits go to the
 * debug log.
 */

import type { Model } from "@earendil-works/pi-ai";
import type {
  Authorizer,
  AuthorizerLog,
  AuthorizerVerdict,
  PromptPermissionDetails,
} from "@gotgenes/pi-permission-system";

import { CircuitBreaker } from "./breaker";
import type { ClassifierConfig } from "./config-schema";
import { extractFullCommandContext, type FullCommandContext } from "./context";
import type { GuidanceSelection } from "./guidance";
import type { HealthOutcome } from "./health";
import { type CompleteFn, reviewAsk } from "./model-review";

/** Surfaces the engine caps to defer; the classifier never even asks. */
const EXCLUDED_SURFACES = new Set(["path", "external_directory"]);

/** Review-log event: one positive decision record per reviewed ask. */
const DECISION_EVENT = "classifier.decision";
/** Debug-log event: a cheap short-circuit before the model stage. */
const SHORT_CIRCUIT_EVENT = "classifier.short_circuit";
/** Debug-log event: the raw model reply, gated behind `debugLog`. */
const MODEL_REPLY_EVENT = "classifier.model_reply";

/** A defer decided before the model call, still recorded positively. */
type PreModelDeferReason =
  | "no-config"
  | "model-unresolved"
  | "auth-failed"
  | "breaker-open"
  | "context-over-budget"
  | "guidance-load-failed";

/** Model-call outcomes that count against the circuit breaker. */
const BREAKER_FAILURE_REASONS = new Set(["timeout", "call-failed"]);

/**
 * The auth resolved for a model call — structurally the `ResolvedRequestAuth`
 * of the core `ModelRegistry`, redeclared here because that type is not
 * re-exported from `@earendil-works/pi-coding-agent`.
 */
export type ResolvedRequestAuth =
  | {
      ok: true;
      apiKey?: string;
      headers?: Record<string, string | null>;
      baseUrl?: string;
      env?: Record<string, string>;
    }
  | { ok: false; error: string };

/** The narrow model-registry projection the reviewer needs (ISP). */
export interface ModelRegistryLike {
  find(provider: string, modelId: string): Model<any> | undefined;
  getApiKeyAndHeaders(model: Model<any>): Promise<ResolvedRequestAuth>;
}

/** Collaborators for the reviewer, injected so the extension and tests wire them. */
export interface ClassifierReviewerDeps {
  /** The loaded config, read live (absent until session config loads). */
  getConfig: () => ClassifierConfig | undefined;
  /** The session's active model, read live (tracks `model_select`). */
  getSessionModel: () => Model<any> | undefined;
  /** The session model registry, read live (captured at `session_start`). */
  getRegistry: () => ModelRegistryLike | undefined;
  /** The model-completion seam (production: `complete` from `@earendil-works/pi-ai`). */
  complete: CompleteFn;
  /** The shared circuit breaker (REQ-11); the reviewer makes its own when absent. */
  breaker?: CircuitBreaker;
  /**
   * Guidance seam: called once per judged ask, right before the model stage,
   * to load and select the guidance files for this ask (production: pi's
   * context loader, the trust check, and the selection in src/guidance.ts).
   * Absent means no guidance. A throw defers the ask (guidance-load-failed).
   */
  getGuidance?: () => GuidanceSelection;
  /**
   * Outcome seam: called once per `classifier.decision` entry with the
   * verdict and defer reason, after the entry is logged. Never called for
   * the surface short-circuits, which write no entry. The reviewer knows
   * nothing about what listens; the extension folds it into session health.
   */
  onOutcome?: (outcome: HealthOutcome) => void;
}

/**
 * Report an outcome through the seam, if any. A throwing listener is
 * swallowed: health is observability, and it must never change a verdict or
 * add a second decision entry.
 */
function report(deps: ClassifierReviewerDeps, outcome: HealthOutcome): void {
  try {
    deps.onOutcome?.(outcome);
  } catch {
    // The listener failed; the decision stands as logged.
  }
}

/**
 * Build the `authorize` callback registered on the chain. The `query`
 * argument is unused — the classifier decides from the ask facts and the
 * model, not from an engine re-query. The `log` argument is the injected
 * review-log seam the decision trail records to.
 */
export function createClassifierReviewer(
  deps: ClassifierReviewerDeps,
): Authorizer["authorize"] {
  const breaker = deps.breaker ?? new CircuitBreaker();

  return async (details, _query, log) => {
    try {
      return await decide(deps, breaker, details, log);
    } catch {
      // The unconditional backstop: whatever threw — an injected seam
      // rejecting instead of returning ok:false, a malformed details bag,
      // even the log itself — the ask defers (more prompting, never less).
      try {
        const context = extractFullCommandContext(details.payload);
        log.review(DECISION_EVENT, {
          requestId: details.requestId,
          surface: gateSurfaceOf(details) ?? null,
          value: details.payload?.request?.value ?? null,
          modelCalled: false,
          modelId: null,
          latencyMs: null,
          verdict: "defer",
          deferReason: "internal-error",
          ...contextFields(false, context),
          ...guidanceFields(EMPTY_GUIDANCE),
        });
      } catch {
        // The log failed too; there is nothing left to record on.
      }
      report(deps, { verdict: "defer", deferReason: "internal-error" });
      return { kind: "defer" };
    }
  };
}

async function decide(
  deps: ClassifierReviewerDeps,
  breaker: CircuitBreaker,
  details: PromptPermissionDetails,
  log: AuthorizerLog,
): Promise<AuthorizerVerdict> {
  const { requestId } = details;
  const surface = gateSurfaceOf(details);
  const value = details.payload.request.value;
  const context = extractFullCommandContext(details.payload);

  const config = deps.getConfig();
  if (!config) {
    return deferWith(deps, log, {
      requestId,
      surface: surface ?? null,
      value,
      modelId: null,
      deferReason: "no-config",
      context,
    });
  }

  if (surface === undefined) {
    log.debug(SHORT_CIRCUIT_EVENT, {
      requestId,
      reason: "undeterminable-surface",
    });
    return { kind: "defer" };
  }
  if (EXCLUDED_SURFACES.has(surface)) {
    log.debug(SHORT_CIRCUIT_EVENT, {
      requestId,
      surface,
      reason: "excluded-surface",
    });
    return { kind: "defer" };
  }
  // The budget gate (REQ-07): an over-budget full command is never rendered,
  // not even truncated — the ask defers to the human with the measurements on
  // record. Decided before the breaker and model stages: it is a property of
  // the ask and the config alone.
  if (context !== null && context.bytes > config.contextBudgetBytes) {
    return deferWith(deps, log, {
      requestId,
      surface,
      value,
      modelId: null,
      deferReason: "context-over-budget",
      context,
    });
  }

  if (breaker.isOpen()) {
    return deferWith(deps, log, {
      requestId,
      surface,
      value,
      modelId: null,
      deferReason: "breaker-open",
      context,
    });
  }

  const registry = deps.getRegistry();
  const model =
    config.provider !== undefined && config.model !== undefined
      ? registry?.find(config.provider, config.model)
      : deps.getSessionModel();
  if (!registry || !model) {
    return deferWith(deps, log, {
      requestId,
      surface,
      value,
      modelId:
        config.provider !== undefined && config.model !== undefined
          ? `${config.provider}/${config.model}`
          : null,
      deferReason: "model-unresolved",
      context,
    });
  }
  const modelId = `${model.provider}/${model.id}`;

  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    return deferWith(deps, log, {
      requestId,
      surface,
      value,
      modelId,
      deferReason: "auth-failed",
      context,
    });
  }

  // The guidance stage: read from disk for every judged ask so an edit takes
  // effect on the next ask, and read only now so the cheap short-circuits
  // above never touch the filesystem. A loader failure is a failure path:
  // defer, never judge without the guidance the operator expects.
  let guidance: GuidanceSelection;
  try {
    guidance = deps.getGuidance?.() ?? EMPTY_GUIDANCE;
  } catch {
    return deferWith(deps, log, {
      requestId,
      surface,
      value,
      modelId,
      deferReason: "guidance-load-failed",
      context,
    });
  }

  const outcome = await reviewAsk({
    details,
    config,
    model,
    complete: deps.complete,
    apiKey: auth.apiKey,
    headers: auth.headers,
    context,
    guidance: guidance.included,
  });
  if (
    outcome.deferReason !== undefined &&
    BREAKER_FAILURE_REASONS.has(outcome.deferReason)
  ) {
    breaker.recordFailure(log, requestId);
  } else {
    breaker.recordSuccess(log, requestId);
  }
  if (outcome.rawReply !== undefined) {
    log.debug(MODEL_REPLY_EVENT, {
      requestId,
      modelId,
      rawReply: outcome.rawReply,
    });
  }
  // One reason for both the decision entry and the health seam, so the two
  // can never disagree. Set on every defer model-review produces; the
  // fallback only guards the type.
  const deferReason =
    outcome.verdict.kind === "defer"
      ? (outcome.deferReason ?? "unrecognized-verdict")
      : null;
  log.review(DECISION_EVENT, {
    requestId,
    surface,
    value,
    modelCalled: true,
    modelId,
    latencyMs: outcome.latencyMs,
    verdict: outcome.verdict.kind,
    deferReason,
    ...contextFields(context !== null, context),
    ...guidanceFields(guidance),
  });
  report(
    deps,
    outcome.verdict.kind === "defer"
      ? { verdict: "defer", deferReason: deferReason ?? "unrecognized-verdict" }
      : { verdict: outcome.verdict.kind },
  );
  // Returned uncapped: the engine envelope, not this link, owns any
  // downgrade (REQ-07).
  return outcome.verdict;
}

/**
 * Record a pre-model defer as a positive `classifier.decision` entry and
 * return the defer verdict — so a resolution failure leaves evidence on
 * record, not a silent absence.
 */
function deferWith(
  deps: ClassifierReviewerDeps,
  log: AuthorizerLog,
  entry: {
    requestId: string;
    surface: string | null;
    value: string;
    modelId: string | null;
    deferReason: PreModelDeferReason;
    context: FullCommandContext | null;
  },
): AuthorizerVerdict {
  log.review(DECISION_EVENT, {
    requestId: entry.requestId,
    surface: entry.surface,
    value: entry.value,
    modelCalled: false,
    modelId: entry.modelId,
    latencyMs: null,
    verdict: "defer",
    deferReason: entry.deferReason,
    ...contextFields(false, entry.context),
    ...guidanceFields(EMPTY_GUIDANCE),
  });
  report(deps, { verdict: "defer", deferReason: entry.deferReason });
  return { kind: "defer" };
}

/**
 * The three context fields every decision entry carries (REQ-08). Only the
 * measurements are logged — bytes and a hash prefix — never the text, so the
 * review log stays free of command content beyond the gated value itself.
 */
function contextFields(
  included: boolean,
  context: FullCommandContext | null,
): {
  contextIncluded: boolean;
  contextBytes: number | null;
  contextHash: string | null;
} {
  return {
    contextIncluded: included,
    contextBytes: context?.bytes ?? null,
    contextHash: context?.hash12 ?? null,
  };
}

/** No guidance: the render before the seam runs, and after it fails. */
const EMPTY_GUIDANCE: GuidanceSelection = { included: [], dropped: [] };

/**
 * The two guidance lists every decision entry carries. Included files are
 * logged by path, bytes, and hash prefix — never their content — and dropped
 * files by path, bytes, and the rule that excluded them.
 */
function guidanceFields(guidance: GuidanceSelection): {
  guidanceIncluded: { path: string; bytes: number; hash12: string }[];
  guidanceDropped: { path: string; bytes: number; reason: string }[];
} {
  return {
    guidanceIncluded: guidance.included.map(({ path, bytes, hash12 }) => ({
      path,
      bytes,
      hash12,
    })),
    guidanceDropped: guidance.dropped.map(({ path, bytes, reason }) => ({
      path,
      bytes,
      reason,
    })),
  };
}

/**
 * The gate-authoritative surface: the raising gate's access-intent surface
 * when present, else the display surface; `undefined` when neither is set
 * (undeterminable — defer without a model call).
 */
function gateSurfaceOf(details: PromptPermissionDetails): string | undefined {
  return details.accessIntent?.surface ?? details.surface ?? undefined;
}
