/**
 * The auto-classifier reviewer: the `Authorizer` chain link this package
 * registers as `"classifier"`.
 *
 * The decision runs top to bottom, deferring at the first miss so the cheap
 * gates short-circuit before any model call:
 *   1. a config is loaded (else defer, recorded),
 *   2. the gate-authoritative surface is determinable and neither `path` nor
 *      `external_directory` (else defer — the engine caps any allow on those
 *      surfaces anyway, so the classifier never attempts them),
 *   3. the surface is in the effective reviewed set (else defer, silently —
 *      not our surface),
 *   4. the judge model and its auth resolve (else defer, recorded),
 *   5. the model reviews the ask facts and its verdict is returned uncapped.
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

import type { ClassifierConfig } from "./config-schema";
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
type PreModelDeferReason = "no-config" | "model-unresolved" | "auth-failed";

/**
 * The auth resolved for a model call — structurally the `ResolvedRequestAuth`
 * of the core `ModelRegistry`, redeclared here because that type is not
 * re-exported from `@earendil-works/pi-coding-agent`.
 */
export type ResolvedRequestAuth =
  | { ok: true; apiKey?: string; headers?: Record<string, string> }
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
  return async (details, _query, log) => {
    const { requestId } = details;
    const surface = gateSurfaceOf(details);
    const value = details.payload.request.value;

    const config = deps.getConfig();
    if (!config) {
      return deferWith(log, {
        requestId,
        surface: surface ?? null,
        value,
        modelId: null,
        deferReason: "no-config",
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
    if (!config.surfaces.includes(surface)) {
      log.debug(SHORT_CIRCUIT_EVENT, {
        requestId,
        surface,
        reason: "off-list-surface",
      });
      return { kind: "defer" };
    }

    const registry = deps.getRegistry();
    const model =
      config.provider !== undefined && config.model !== undefined
        ? registry?.find(config.provider, config.model)
        : deps.getSessionModel();
    if (!registry || !model) {
      return deferWith(log, {
        requestId,
        surface,
        value,
        modelId:
          config.provider !== undefined && config.model !== undefined
            ? `${config.provider}/${config.model}`
            : null,
        deferReason: "model-unresolved",
      });
    }
    const modelId = `${model.provider}/${model.id}`;

    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      return deferWith(log, {
        requestId,
        surface,
        value,
        modelId,
        deferReason: "auth-failed",
      });
    }

    const outcome = await reviewAsk({
      details,
      config,
      model,
      complete: deps.complete,
      apiKey: auth.apiKey,
      headers: auth.headers,
    });
    if (outcome.rawReply !== undefined) {
      log.debug(MODEL_REPLY_EVENT, {
        requestId,
        modelId,
        rawReply: outcome.rawReply,
      });
    }
    log.review(DECISION_EVENT, {
      requestId,
      surface,
      value,
      modelCalled: true,
      modelId,
      latencyMs: outcome.latencyMs,
      verdict: outcome.verdict.kind,
      deferReason: outcome.deferReason ?? null,
    });
    // Returned uncapped: the engine envelope, not this link, owns any
    // downgrade (REQ-07).
    return outcome.verdict;
  };
}

/**
 * Record a pre-model defer as a positive `classifier.decision` entry and
 * return the defer verdict — so a resolution failure leaves evidence on
 * record, not a silent absence.
 */
function deferWith(
  log: AuthorizerLog,
  entry: {
    requestId: string;
    surface: string | null;
    value: string;
    modelId: string | null;
    deferReason: PreModelDeferReason;
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
  });
  return { kind: "defer" };
}

/**
 * The gate-authoritative surface: the raising gate's access-intent surface
 * when present, else the display surface; `undefined` when neither is set
 * (undeterminable — defer without a model call).
 */
function gateSurfaceOf(details: PromptPermissionDetails): string | undefined {
  return details.accessIntent?.surface ?? details.surface ?? undefined;
}
