/**
 * The system-one link: the `Authorizer` chain link this package registers as
 * `"system-one"` when the config has a `systemOne` object. A System One
 * decision model answers a fixed question set about each ask through the
 * registry's `classify`, and the answers map to a verdict.
 *
 * The decision runs top to bottom, so the cheap gates short-circuit before
 * any model call:
 *   1. settings are loaded (else defer, recorded),
 *   2. the gate-authoritative surface is determinable and outside the `path`
 *      and `external_directory` families (else defer, not recorded),
 *   3. the full command fits `contextBudgetBytes` (else over-budget),
 *   4. the link's own circuit breaker is closed (else breaker-open),
 *   5. the classifier model resolves through `findOfType("classifier", ...)`
 *      (else model-unresolved; there is no session-model fallback),
 *   6. with `systemOne.guidance` on, the guidance seam selects this ask's
 *      files, read per ask (a throw is guidance-load-failed),
 *   7. `classify` runs under an abort signal bounded by `systemOne.timeoutMs`.
 *
 * From step 3 on every outcome goes through the verdict policy with the
 * link's `verdicts` and `onError`. A failure never allows. Each recorded
 * decision writes one `classifier.decision` entry tagged
 * `link: "system-one"`, with the per-question answers when the model
 * answered.
 */

import type {
  ClassifierAnswer,
  ClassifierApi,
  ClassifierContext,
  ClassifierModel,
  ClassifierResult,
  JsonValue,
} from "@earendil-works/pi-ai";
import type {
  Authorizer,
  AuthorizerLog,
  AuthorizerVerdict,
  PromptPermissionDetails,
} from "@gotgenes/pi-permission-system";

import { CircuitBreaker } from "./breaker";
import type { SystemOneConfig } from "./config-schema";
import { extractFullCommandContext, type FullCommandContext } from "./context";
import type { GuidanceSelection } from "./guidance";
import type { HealthOutcome } from "./health";
import {
  contextFields,
  DECISION_EVENT,
  DENY_CAPPED_REASON,
  EMPTY_GUIDANCE,
  gateSurfaceOf,
  guidanceFields,
  isExcludedSurface,
  SHORT_CIRCUIT_EVENT,
} from "./reviewer";
import { buildSystemOneContext, mapSystemOneResult } from "./system-one-review";
import {
  applyVerdictPolicy,
  type LinkOutcome,
  type VerdictPolicy,
} from "./verdict-policy";

/** The link name every decision entry of this link carries. */
const LINK_NAME = "system-one";

/**
 * The recorded reason for an answer below the thresholds: the model judged
 * and did not clear the bar, the same reason the classifier link records
 * for its judge's own defer, so health treats both as a verdict.
 */
const UNCERTAIN_REASON = "model-verdict";

/** The policy when no settings can be read: never deny, never allow. */
const DEFAULT_POLICY: VerdictPolicy = { verdicts: "allow-defer", onError: "defer" };

/** The narrow model-registry projection the link needs. */
export interface SystemOneRegistryLike {
  findOfType(
    type: "classifier",
    provider: string,
    modelId: string,
  ): ClassifierModel<ClassifierApi> | undefined;
  classify(
    model: ClassifierModel<ClassifierApi>,
    context: ClassifierContext,
    options?: { signal?: AbortSignal },
  ): Promise<ClassifierResult>;
}

/** What the link reads per ask: its own settings and the shared budget. */
export interface SystemOneLinkSettings {
  systemOne: SystemOneConfig;
  contextBudgetBytes: number;
}

/** Collaborators for the link, injected so the extension and tests wire them. */
export interface SystemOneLinkDeps {
  /** The settings in effect, read live (absent until session config loads). */
  getSettings: () => SystemOneLinkSettings | undefined;
  /** The session model registry, read live. */
  getRegistry: () => SystemOneRegistryLike | undefined;
  /** The session cwd, sent to the model as part of the state. */
  getCwd: () => string;
  /**
   * Guidance seam: called once per judged ask when `systemOne.guidance` is
   * on, right before the model call (production: the same loader, trust
   * check and selection as the classifier link). Absent means no guidance.
   * A throw is a guidance-load-failed failure.
   */
  getGuidance?: () => GuidanceSelection;
  /** This link's own circuit breaker; the link makes one when absent. */
  breaker?: CircuitBreaker;
  /**
   * Outcome seam: called once per decision entry with what the judge did,
   * so a failure counts even when onError turns it into a deny.
   */
  onOutcome?: (outcome: HealthOutcome) => void;
}

/** Report through the health seam; a throwing listener never changes a verdict. */
function report(deps: SystemOneLinkDeps, outcome: HealthOutcome): void {
  try {
    deps.onOutcome?.(outcome);
  } catch {
    // The listener failed; the decision stands as logged.
  }
}

/** The health outcome for a link outcome and its recorded reason. */
function healthOf(outcome: LinkOutcome, reason: string | null): HealthOutcome {
  if (outcome.kind === "allow" || outcome.kind === "deny") {
    return { verdict: outcome.kind };
  }
  return { verdict: "defer", deferReason: reason ?? UNCERTAIN_REASON };
}

/** Build the `authorize` callback registered as `"system-one"`. */
export function createSystemOneLink(deps: SystemOneLinkDeps): Authorizer["authorize"] {
  const breaker = deps.breaker ?? new CircuitBreaker();

  return async (details, _query, log) => {
    // What the guidance stage selected, so the backstop entry can say what
    // the model saw even when a later stage threw.
    const trail = { guidance: EMPTY_GUIDANCE };
    try {
      return await decide(deps, breaker, details, log, trail);
    } catch {
      // The backstop: whatever threw is an internal-error failure under the
      // link's onError, and never an allow.
      const verdict = applyVerdictPolicy(
        { kind: "failure", failure: "internal-error" },
        backstopPolicy(deps),
      );
      try {
        log.review(DECISION_EVENT, {
          ...baseEntry(details, gateSurfaceOf(details) ?? null, null),
          modelCalled: false,
          latencyMs: null,
          verdict: verdict.kind,
          deferReason: "internal-error",
          ...contextFields(false, extractFullCommandContext(details.payload)),
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

function backstopPolicy(deps: SystemOneLinkDeps): VerdictPolicy {
  try {
    const settings = deps.getSettings();
    return settings ? policyOf(settings) : DEFAULT_POLICY;
  } catch {
    return DEFAULT_POLICY;
  }
}

function policyOf(settings: SystemOneLinkSettings): VerdictPolicy {
  return { verdicts: settings.systemOne.verdicts, onError: settings.systemOne.onError };
}

async function decide(
  deps: SystemOneLinkDeps,
  breaker: CircuitBreaker,
  details: PromptPermissionDetails,
  log: AuthorizerLog,
  trail: { guidance: GuidanceSelection },
): Promise<AuthorizerVerdict> {
  const surface = gateSurfaceOf(details);
  const fullCommand = extractFullCommandContext(details.payload);

  const settings = deps.getSettings();
  if (!settings) {
    log.review(DECISION_EVENT, {
      ...baseEntry(details, surface ?? null, null),
      modelCalled: false,
      latencyMs: null,
      verdict: "defer",
      deferReason: "no-config",
      ...contextFields(false, fullCommand),
      ...guidanceFields(EMPTY_GUIDANCE),
    });
    report(deps, { verdict: "defer", deferReason: "no-config" });
    return { kind: "defer" };
  }

  if (surface === undefined || isExcludedSurface(surface)) {
    log.debug(SHORT_CIRCUIT_EVENT, {
      link: LINK_NAME,
      requestId: details.requestId,
      surface: surface ?? null,
      reason: surface === undefined ? "undeterminable-surface" : "excluded-surface",
    });
    return { kind: "defer" };
  }

  const policy = policyOf(settings);
  const { systemOne } = settings;
  const pairId =
    systemOne.provider !== undefined && systemOne.model !== undefined
      ? `${systemOne.provider}/${systemOne.model}`
      : null;
  const preModel = (outcome: LinkOutcome, deferReason: string): AuthorizerVerdict =>
    record(deps, log, details, surface, policy, outcome, {
      modelId: pairId,
      modelCalled: false,
      latencyMs: null,
      deferReason,
      fullCommand,
      contextIncluded: false,
      guidance: EMPTY_GUIDANCE,
    });

  if (fullCommand !== null && fullCommand.bytes > settings.contextBudgetBytes) {
    return preModel({ kind: "over-budget" }, "context-over-budget");
  }

  if (breaker.isOpen()) {
    return preModel({ kind: "failure", failure: "breaker-open" }, "breaker-open");
  }

  const registry = deps.getRegistry();
  const model =
    systemOne.provider !== undefined && systemOne.model !== undefined
      ? registry?.findOfType("classifier", systemOne.provider, systemOne.model)
      : undefined;
  if (!registry || !model) {
    return preModel({ kind: "failure", failure: "model-unresolved" }, "model-unresolved");
  }

  // Read from disk for every judged ask so an edit takes effect on the next
  // one, and only now so the short-circuits above never touch the disk.
  let guidance: GuidanceSelection | undefined;
  if (systemOne.guidance) {
    try {
      guidance = deps.getGuidance?.() ?? EMPTY_GUIDANCE;
      trail.guidance = guidance;
    } catch {
      return preModel(
        { kind: "failure", failure: "guidance-load-failed" },
        "guidance-load-failed",
      );
    }
  }

  const context = buildSystemOneContext({
    details,
    surface,
    cwd: deps.getCwd(),
    fullCommand,
    contextBudgetBytes: settings.contextBudgetBytes,
    ...(guidance === undefined ? {} : { guidance: guidance.included }),
  });
  const startedAt = Date.now();
  const result = await classifyWithin(registry, model, context, systemOne.timeoutMs);
  const latencyMs = Date.now() - startedAt;
  if (result === "timeout" || result === "threw" || result.stopReason !== "stop") {
    breaker.recordFailure(log, details.requestId);
  } else {
    breaker.recordSuccess(log, details.requestId);
  }

  const outcome: LinkOutcome =
    result === "timeout"
      ? { kind: "failure", failure: "timeout" }
      : result === "threw"
        ? { kind: "failure", failure: "call-failed" }
        : mapSystemOneResult(result, systemOne);
  const answers =
    typeof result === "object" && result.stopReason === "stop"
      ? summarizeAnswers(result.answers)
      : undefined;
  return record(deps, log, details, surface, policy, outcome, {
    modelId: `${model.provider}/${model.id}`,
    modelCalled: true,
    latencyMs,
    deferReason: undefined,
    fullCommand,
    contextIncluded: fullCommand !== null,
    guidance: guidance ?? EMPTY_GUIDANCE,
    answers,
  });
}

/**
 * Run `classify` under an abort signal that fires at `timeoutMs`. Resolves
 * `"timeout"` at the deadline even when the call never settles, and
 * `"threw"` when the call rejects.
 */
async function classifyWithin(
  registry: SystemOneRegistryLike,
  model: ClassifierModel<ClassifierApi>,
  context: ClassifierContext,
  timeoutMs: number,
): Promise<ClassifierResult | "timeout" | "threw"> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, timeoutMs);
  });
  const call = registry
    .classify(model, context, { signal: controller.signal })
    .then(
      (result) => (controller.signal.aborted ? ("timeout" as const) : result),
      () => (controller.signal.aborted ? ("timeout" as const) : ("threw" as const)),
    );
  try {
    return await Promise.race([call, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Per-question answers for the log: bool probability, choice probabilities. */
function summarizeAnswers(
  answers: Record<string, ClassifierAnswer>,
): Record<string, JsonValue> | undefined {
  const entries = Object.entries(answers);
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(
    entries.map(([id, answer]) => {
      switch (answer.type) {
        case "bool":
          return [id, answer.probability];
        case "choice":
          return [id, answer.probabilities];
        case "score":
          return [id, answer.score];
      }
    }),
  );
}

/**
 * Apply the policy to an outcome, write the decision entry, report health,
 * and return the verdict. The recorded reason is the given one, else the
 * reason the outcome implies.
 */
function record(
  deps: SystemOneLinkDeps,
  log: AuthorizerLog,
  details: PromptPermissionDetails,
  surface: string,
  policy: VerdictPolicy,
  outcome: LinkOutcome,
  facts: {
    modelId: string | null;
    modelCalled: boolean;
    latencyMs: number | null;
    deferReason: string | undefined;
    fullCommand: FullCommandContext | null;
    contextIncluded: boolean;
    guidance: GuidanceSelection;
    answers?: Record<string, JsonValue>;
  },
): AuthorizerVerdict {
  const verdict = applyVerdictPolicy(outcome, policy);
  const reason = facts.deferReason ?? recordedReason(outcome, verdict);
  log.review(DECISION_EVENT, {
    ...baseEntry(details, surface, facts.modelId),
    modelCalled: facts.modelCalled,
    latencyMs: facts.latencyMs,
    verdict: verdict.kind,
    deferReason: reason,
    ...contextFields(facts.contextIncluded, facts.fullCommand),
    ...guidanceFields(facts.guidance),
    ...(facts.answers === undefined ? {} : { answers: facts.answers }),
  });
  report(deps, healthOf(outcome, reason));
  return verdict;
}

function recordedReason(outcome: LinkOutcome, verdict: AuthorizerVerdict): string | null {
  switch (outcome.kind) {
    case "allow":
      return null;
    case "deny":
      return verdict.kind === "defer" ? DENY_CAPPED_REASON : null;
    case "uncertain":
      return UNCERTAIN_REASON;
    case "over-budget":
      return "context-over-budget";
    case "failure":
      return outcome.failure;
  }
}

function baseEntry(
  details: PromptPermissionDetails,
  surface: string | null,
  modelId: string | null,
) {
  return {
    link: LINK_NAME,
    requestId: details.requestId,
    surface,
    value: details.payload?.request?.value ?? null,
    modelId,
  };
}
