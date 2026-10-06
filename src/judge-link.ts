/**
 * The permission-judge link body: composes the LLM judge and the quick judge
 * by the config's `mode`, read live on every ask.
 *
 *   - `llm` runs the LLM judge alone, under the top-level `verdicts` and
 *     `onError`. It is also the mode when no config is loaded, so the LLM
 *     judge records the no-config defer.
 *   - `quick` runs the quick judge alone, under `quickJudge.verdicts` and
 *     `quickJudge.onError`.
 *   - `quick-then-llm` runs the quick judge with verdicts allow-defer and
 *     onError defer, whatever `quickJudge` says. A quick allow ends the ask;
 *     anything else goes to the LLM judge, which decides.
 *
 * Each judge keeps its own breaker and health seam, and writes its own
 * decision entry. A failure never allows: each judge applies its own
 * policy, and a throw here defers.
 */

import type { Authorizer, AuthorizerVerdict } from "@gotgenes/pi-permission-system";

import { CircuitBreaker } from "./breaker";
import {
  type ClassifierConfig,
  type QuickJudgeConfig,
  quickJudgeConfigSchema,
} from "./config-schema";
import { createQuickJudge, type QuickJudgeDeps, type QuickJudgeSettings } from "./quick-judge";
import { type ClassifierReviewerDeps, createClassifierReviewer } from "./reviewer";
import type { UserIntent } from "./user-intent";

/** The quick judge policy in front of the LLM judge: never deny, never fail closed. */
const CASCADE_QUICK_POLICY = { verdicts: "allow-defer", onError: "defer" } as const;

/** Collaborators for the link, injected so the extension and tests wire them. */
export interface JudgeLinkDeps {
  /** The loaded config, read live per ask (absent until session config loads). */
  getConfig: () => ClassifierConfig | undefined;
  /** The LLM judge's collaborators; its config comes from `getConfig`. */
  llm: Omit<ClassifierReviewerDeps, "getConfig">;
  /** The quick judge's collaborators; its settings come from `getConfig`. */
  quick: Omit<QuickJudgeDeps, "getSettings">;
  /**
   * The user intent for an ask, read live from the session; undefined when
   * intent is not available. `forwarded` is true for an ask a subagent
   * forwarded.
   */
  getUserIntent?: (forwarded: boolean) => UserIntent | undefined;
  /** Operator warning sink, for the cascade's policy override. */
  warn: (message: string) => void;
}

/**
 * Build the link's `authorize` callback. One callback serves a whole
 * session: the once-per-session override warning lives in this closure.
 */
export function createJudgeLink(deps: JudgeLinkDeps): Authorizer["authorize"] {
  let warnedOverride = false;
  const quickBreaker = deps.quick.breaker ?? new CircuitBreaker("quick");

  const llmJudge = createClassifierReviewer({ ...deps.llm, getConfig: deps.getConfig });

  const quickSettings = (forced: boolean): QuickJudgeSettings | undefined => {
    const config = deps.getConfig();
    if (!config) {
      return undefined;
    }
    const quickJudge = quickJudgeOf(config);
    if (!forced) {
      return { quickJudge, contextBudgetBytes: config.contextBudgetBytes };
    }
    if (
      !warnedOverride &&
      (quickJudge.verdicts !== CASCADE_QUICK_POLICY.verdicts ||
        quickJudge.onError !== CASCADE_QUICK_POLICY.onError)
    ) {
      warnedOverride = true;
      deps.warn(
        `quickJudge asks for verdicts ${quickJudge.verdicts} and onError ` +
          `${quickJudge.onError}, but in mode quick-then-llm the quick judge ` +
          "runs with verdicts allow-defer and onError defer. Set mode quick " +
          "to apply them.",
      );
    }
    return {
      quickJudge: { ...quickJudge, ...CASCADE_QUICK_POLICY },
      contextBudgetBytes: config.contextBudgetBytes,
    };
  };

  // Two callbacks over one breaker and one health seam: the quick judge's
  // state is the same whichever mode runs it.
  const quickAlone = createQuickJudge({
    ...deps.quick,
    breaker: quickBreaker,
    getSettings: () => quickSettings(false),
  });
  const quickInFront = createQuickJudge({
    ...deps.quick,
    breaker: quickBreaker,
    getSettings: () => quickSettings(true),
  });

  return async (details, query, log): Promise<AuthorizerVerdict> => {
    let mode: ClassifierConfig["mode"];
    try {
      mode = deps.getConfig()?.mode ?? "llm";
    } catch {
      return { kind: "defer" };
    }
    switch (mode) {
      case "llm":
        return llmJudge(details, query, log);
      case "quick":
        return quickAlone(details, query, log);
      case "quick-then-llm": {
        const quick = await quickInFront(details, query, log);
        return quick.kind === "allow" ? quick : llmJudge(details, query, log);
      }
    }
  };
}

/** The quick judge settings, or the defaults (no pair) when none are set. */
function quickJudgeOf(config: ClassifierConfig): QuickJudgeConfig {
  return config.quickJudge ?? quickJudgeConfigSchema.parse({});
}
