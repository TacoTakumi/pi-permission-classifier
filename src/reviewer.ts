/**
 * The LLM judge: a chat model reads each ask and reports allow, deny, or
 * defer. It runs inside the permission-judge link when the mode includes it.
 *
 * The decision runs top to bottom, deferring at the first miss so the cheap
 * gates short-circuit before any model call:
 *   1. a config is loaded (else defer, recorded),
 *   2. the gate-authoritative surface is determinable and outside the `path`
 *      and `external_directory` families — the bare name or any directional
 *      member such as `path_read` or `external_directory_write` (else defer —
 *      the engine caps any allow on those families anyway, so the classifier
 *      never attempts them); every other surface, whatever its name, is
 *      judged,
 *   3. combined full-command and operation context fits `contextBudgetBytes` (else
 *      defer, recorded — over-budget context is never rendered),
 *   4. the judge model and its auth resolve (else defer, recorded),
 *   5. the guidance seam selects the operator and trusted-project guidance
 *      files for this ask (a throw defers, recorded — no model call),
 *   6. the user intent seam gives the user's own messages, or none,
 *   7. the model reviews the ask facts plus guidance and, with intent, the
 *      user's messages.
 *
 * Once a config is loaded, every outcome from step 3 on goes through the
 * verdict policy, which applies the link's `verdicts` and `onError`
 * settings. A failure never allows: it defers, or denies with a fixed reason
 * under `onError` deny. Each reviewed ask writes exactly one
 * `classifier.decision` review entry tagged `judge: "llm"`; raw model
 * replies and the cheap short-circuits go to the debug log.
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
import {
  type ContextMeasurement,
  extractFullCommandContext,
  extractOperationContext,
  measureOperationContext,
} from "./context";
import type { GuidanceSelection } from "./guidance";
import type { HealthOutcome } from "./health";
import { type CompleteFn, type ReviewOutcome, reviewAsk } from "./model-review";
import type { UserIntent } from "./user-intent";
import {
  applyVerdictPolicy,
  type FailureKind,
  type LinkOutcome,
  type VerdictPolicy,
} from "./verdict-policy";

/**
 * Surface families the engine caps to defer; the classifier never even asks.
 * A family covers its bare name and every `<name>_*` member, the shape the
 * engine's delegation envelope uses (`path_read`, `path_write`,
 * `external_directory_read`, `external_directory_write`); an unknown
 * member is excluded too, which only ever defers.
 */
const EXCLUDED_SURFACE_FAMILIES = ["path", "external_directory"] as const;

/** Whether `surface` is the bare name or a directional member of an excluded family. */
export function isExcludedSurface(surface: string): boolean {
  return EXCLUDED_SURFACE_FAMILIES.some(
    (family) => surface === family || surface.startsWith(`${family}_`),
  );
}

/** Review-log event: one positive decision record per reviewed ask. */
export const DECISION_EVENT = "classifier.decision";
/** The judge tag every decision entry of this reviewer carries. */
const JUDGE_TAG = "llm";
/**
 * The recorded reason when `allow-defer` turns a model deny into defer: the
 * judge worked, the setting withheld the deny.
 */
export const DENY_CAPPED_REASON = "deny-capped";
/** Debug-log event: a cheap short-circuit before the model stage. */
export const SHORT_CIRCUIT_EVENT = "classifier.short_circuit";
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

/** The policy when no config can be read: the schema defaults. */
const DEFAULT_POLICY: VerdictPolicy = { verdicts: "allow-deny-defer", onError: "defer" };

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
  /** The shared circuit breaker; the reviewer makes its own when absent. */
  breaker?: CircuitBreaker;
  /**
   * Guidance seam: called once per judged ask, right before the model stage,
   * to load and select the guidance files for this ask (production: pi's
   * context loader, the trust check, and the selection in src/guidance.ts).
   * Absent means no guidance. A throw defers the ask (guidance-load-failed).
   */
  getGuidance?: () => GuidanceSelection;
  /**
   * User intent seam: called once per judged ask right before the model
   * call, with whether the ask was forwarded. Absent, undefined or a throw
   * means no user block.
   */
  getUserIntent?: (forwarded: boolean) => UserIntent | undefined;
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
  const breaker = deps.breaker ?? new CircuitBreaker("llm");

  return async (details, _query, log) => {
    // What the guidance stage selected, so the backstop entry below can say
    // what the judge actually saw even when a later stage threw.
    const trail = { guidance: EMPTY_GUIDANCE };
    try {
      return await decide(deps, breaker, details, log, trail);
    } catch {
      // The unconditional backstop: whatever threw — an injected seam
      // rejecting instead of returning ok:false, a malformed details bag,
      // even the log itself — is an internal-error failure under the
      // link's onError, and never an allow.
      const verdict = backstopVerdict(deps);
      try {
        const context = extractFullCommandContext(details.payload);
        const operation = measureOperationContext(
          extractOperationContext(details.payload),
        );
        log.review(DECISION_EVENT, {
          judge: JUDGE_TAG,
          requestId: details.requestId,
          surface: gateSurfaceOf(details) ?? null,
          value: details.payload?.request?.value ?? null,
          modelCalled: false,
          modelId: null,
          latencyMs: null,
          verdict: verdict.kind,
          deferReason: "internal-error",
          ...contextFields(false, context),
          ...operationContextFields(false, operation),
          ...guidanceFields(trail.guidance),
        });
      } catch {
        // The log failed too; there is nothing left to record on.
      }
      report(deps, { verdict: "defer", deferReason: "internal-error" });
      return verdict;
    }
  };
}

/**
 * The backstop verdict: internal-error under the configured policy, or the
 * defaults when even reading the config throws. Never an allow.
 */
function backstopVerdict(deps: ClassifierReviewerDeps): AuthorizerVerdict {
  let policy = DEFAULT_POLICY;
  try {
    const config = deps.getConfig();
    if (config) {
      policy = policyOf(config);
    }
  } catch {
    // Keep the defaults.
  }
  return applyVerdictPolicy({ kind: "failure", failure: "internal-error" }, policy);
}

/** The classifier link's verdict policy from its config. */
function policyOf(config: ClassifierConfig): VerdictPolicy {
  return { verdicts: config.verdicts, onError: config.onError };
}

async function decide(
  deps: ClassifierReviewerDeps,
  breaker: CircuitBreaker,
  details: PromptPermissionDetails,
  log: AuthorizerLog,
  trail: { guidance: GuidanceSelection },
): Promise<AuthorizerVerdict> {
  const { requestId } = details;
  const surface = gateSurfaceOf(details);
  const value = details.payload.request.value;
  const fullCommand = extractFullCommandContext(details.payload);
  const operationContext = extractOperationContext(details.payload);
  const context = fullCommand;
  const operation = measureOperationContext(operationContext);

  const config = deps.getConfig();
  if (!config) {
    return recordPreModel(deps, log, undefined, {
      requestId,
      surface: surface ?? null,
      value,
      modelId: null,
      deferReason: "no-config",
      context,
      operation,
    });
  }

  const policy = policyOf(config);

  if (surface === undefined) {
    log.debug(SHORT_CIRCUIT_EVENT, {
      judge: JUDGE_TAG,
      requestId,
      reason: "undeterminable-surface",
    });
    return { kind: "defer" };
  }
  if (isExcludedSurface(surface)) {
    log.debug(SHORT_CIRCUIT_EVENT, {
      judge: JUDGE_TAG,
      requestId,
      surface,
      reason: "excluded-surface",
    });
    return { kind: "defer" };
  }
  // The budget gate: over-budget operation context is never rendered,
  // not even truncated. The ask is uncertain under the policy, with the
  // measurements on record. Decided before the breaker and model stages: it
  // is a property of the ask and the config alone.
  if ((context?.bytes ?? 0) + (operation?.bytes ?? 0) > config.contextBudgetBytes) {
    return recordPreModel(deps, log, policy, {
      requestId,
      surface,
      value,
      modelId: null,
      deferReason: "context-over-budget",
      context,
      operation,
    });
  }

  if (breaker.isOpen()) {
    return recordPreModel(deps, log, policy, {
      requestId,
      surface,
      value,
      modelId: null,
      deferReason: "breaker-open",
      context,
      operation,
    });
  }

  const registry = deps.getRegistry();
  const model =
    config.provider !== undefined && config.model !== undefined
      ? registry?.find(config.provider, config.model)
      : deps.getSessionModel();
  if (!registry || !model) {
    return recordPreModel(deps, log, policy, {
      requestId,
      surface,
      value,
      modelId:
        config.provider !== undefined && config.model !== undefined
          ? `${config.provider}/${config.model}`
          : null,
      deferReason: "model-unresolved",
      context,
      operation,
    });
  }
  const modelId = `${model.provider}/${model.id}`;

  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    return recordPreModel(deps, log, policy, {
      requestId,
      surface,
      value,
      modelId,
      deferReason: "auth-failed",
      context,
      operation,
    });
  }

  // The guidance stage: read from disk for every judged ask so an edit takes
  // effect on the next ask, and read only now so the cheap short-circuits
  // above never touch the filesystem. A loader failure is a failure path:
  // defer, never judge without the guidance the operator expects.
  let guidance: GuidanceSelection;
  try {
    guidance = deps.getGuidance?.() ?? EMPTY_GUIDANCE;
    trail.guidance = guidance;
  } catch {
    return recordPreModel(deps, log, policy, {
      requestId,
      surface,
      value,
      modelId,
      deferReason: "guidance-load-failed",
      context,
      operation,
    });
  }

  const userIntent = userIntentFor(deps.getUserIntent, details);
  const outcome = await reviewAsk({
    details,
    config,
    model,
    complete: deps.complete,
    apiKey: auth.apiKey,
    headers: auth.headers,
    context: fullCommand,
    operationContext,
    guidance: guidance.included,
    ...(userIntent === undefined ? {} : { userIntent }),
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
  const modelDeferReason =
    outcome.verdict.kind === "defer"
      ? (outcome.deferReason ?? "unrecognized-verdict")
      : null;
  const verdict = applyVerdictPolicy(linkOutcomeOf(outcome), policy);
  const deferReason =
    modelDeferReason ??
    (outcome.verdict.kind === "deny" && verdict.kind === "defer"
      ? DENY_CAPPED_REASON
      : null);
  log.review(DECISION_EVENT, {
    judge: JUDGE_TAG,
    requestId,
    surface,
    value,
    modelCalled: true,
    modelId,
    latencyMs: outcome.latencyMs,
    verdict: verdict.kind,
    deferReason,
    ...contextFields(context !== null, context),
    ...operationContextFields(operation !== null, operation),
    ...guidanceFields(guidance),
  });
  // Health folds in what the judge did, not what the policy made of it, so
  // a failure counts under onError deny too.
  report(
    deps,
    modelDeferReason !== null
      ? { verdict: "defer", deferReason: modelDeferReason }
      : { verdict: outcome.verdict.kind as "allow" | "deny" },
  );
  return verdict;
}

/**
 * The user intent for an ask through a judge's seam, or undefined. An ask
 * whose requester facts are missing counts as forwarded, and a throwing seam
 * gives no intent.
 */
export function userIntentFor(
  getUserIntent: ((forwarded: boolean) => UserIntent | undefined) | undefined,
  details: PromptPermissionDetails,
): UserIntent | undefined {
  try {
    return getUserIntent?.(details.payload?.request?.requester?.forwarded !== false);
  } catch {
    return undefined;
  }
}

/**
 * Reduce a model review to a link outcome. A timeout or failed call is a
 * failure; every other defer (the model's own, a reply with no tool call,
 * an unknown verdict) is uncertain.
 */
function linkOutcomeOf(outcome: ReviewOutcome): LinkOutcome {
  switch (outcome.verdict.kind) {
    case "allow":
      return { kind: "allow" };
    case "deny":
      return { kind: "deny", reason: outcome.verdict.reason ?? "" };
    case "defer":
      return outcome.deferReason === "timeout" || outcome.deferReason === "call-failed"
        ? { kind: "failure", failure: outcome.deferReason }
        : { kind: "uncertain" };
  }
}

/**
 * Record a pre-model outcome as a positive `classifier.decision` entry and
 * return its verdict under the policy, so a resolution failure leaves
 * evidence on record, not a silent absence. With no policy (no config) the
 * ask defers.
 */
function recordPreModel(
  deps: ClassifierReviewerDeps,
  log: AuthorizerLog,
  policy: VerdictPolicy | undefined,
  entry: {
    requestId: string;
    surface: string | null;
    value: string;
    modelId: string | null;
    deferReason: PreModelDeferReason;
    context: ContextMeasurement | null;
    operation: ContextMeasurement | null;
  },
): AuthorizerVerdict {
  const verdict: AuthorizerVerdict =
    policy === undefined || entry.deferReason === "no-config"
      ? { kind: "defer" }
      : applyVerdictPolicy(preModelOutcome(entry.deferReason), policy);
  log.review(DECISION_EVENT, {
    judge: JUDGE_TAG,
    requestId: entry.requestId,
    surface: entry.surface,
    value: entry.value,
    modelCalled: false,
    modelId: entry.modelId,
    latencyMs: null,
    verdict: verdict.kind,
    deferReason: entry.deferReason,
    ...contextFields(false, entry.context),
    ...operationContextFields(false, entry.operation),
    ...guidanceFields(EMPTY_GUIDANCE),
  });
  report(deps, { verdict: "defer", deferReason: entry.deferReason });
  return verdict;
}

/** A pre-model reason as a link outcome: over-budget, or a failure. */
function preModelOutcome(
  reason: Exclude<PreModelDeferReason, "no-config">,
): LinkOutcome {
  return reason === "context-over-budget"
    ? { kind: "over-budget" }
    : { kind: "failure", failure: reason satisfies FailureKind };
}

/**
 * The three context fields every decision entry carries. Only the
 * measurements are logged — bytes and a hash prefix — never the text, so the
 * review log stays free of operation content beyond the gated value itself.
 */
export function contextFields(
  included: boolean,
  context: ContextMeasurement | null,
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

function operationContextFields(
  included: boolean,
  operation: ContextMeasurement | null,
): {
  operationContextIncluded: boolean;
  operationContextBytes: number | null;
  operationContextHash: string | null;
} {
  return {
    operationContextIncluded: included,
    operationContextBytes: operation?.bytes ?? null,
    operationContextHash: operation?.hash12 ?? null,
  };
}

/** No guidance: the render before the seam runs, and after it fails. */
export const EMPTY_GUIDANCE: GuidanceSelection = { included: [], dropped: [] };

/**
 * The two guidance lists every decision entry carries. Included files are
 * logged by path, bytes, and hash prefix — never their content — and dropped
 * files by path, bytes, and the rule that excluded them.
 */
export function guidanceFields(guidance: GuidanceSelection): {
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
export function gateSurfaceOf(details: PromptPermissionDetails): string | undefined {
  return details.accessIntent?.surface ?? details.surface ?? undefined;
}
