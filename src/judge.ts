/**
 * Pure judge resolution and status text.
 *
 * The effective judge is picked by one rule, in precedence order: a
 * session-only override (the `--permission-model` flag), then the merged
 * config's `provider`/`model` pair, then the session's active model. A named
 * pair is looked up in the model registry; when the registry does not know
 * it the judge is unresolved and every ask defers (fail-safe), which the
 * status text surfaces with an ` (unresolved)` suffix.
 *
 * This module has no side effects and imports nothing from pi beyond types.
 */

import type { Model } from "@earendil-works/pi-ai";

import type { ClassifierConfig } from "./config-schema";

/** A provider/id pair naming a judge model. */
export interface JudgePair {
  provider: string;
  model: string;
}

/** The narrow registry projection the resolver needs. */
export interface JudgeRegistryLike {
  find(provider: string, modelId: string): Model<any> | undefined;
}

/** The effective judge and how it was chosen. */
export interface ResolvedJudge {
  /** Which rule chose the judge. */
  source: "override" | "config" | "session";
  /** The named pair for `override` and `config`; `undefined` for `session`. */
  pair: JudgePair | undefined;
  /** The model that will judge; `undefined` means every ask defers. */
  model: Model<any> | undefined;
}

/**
 * Resolve the effective judge with precedence override > config > session.
 *
 * A named pair resolves only through the registry: the session model is never
 * substituted for a pair the registry does not know.
 */
export function resolveJudge(
  override: JudgePair | undefined,
  config: Pick<ClassifierConfig, "provider" | "model"> | undefined,
  registry: JudgeRegistryLike | undefined,
  sessionModel: Model<any> | undefined,
): ResolvedJudge {
  if (override !== undefined) {
    return {
      source: "override",
      pair: override,
      model: registry?.find(override.provider, override.model),
    };
  }
  if (config?.provider !== undefined && config.model !== undefined) {
    const pair: JudgePair = { provider: config.provider, model: config.model };
    return {
      source: "config",
      pair,
      model: registry?.find(pair.provider, pair.model),
    };
  }
  return { source: "session", pair: undefined, model: sessionModel };
}

/**
 * The footer status text: `judge:<provider>/<id>` for a named pair, with
 * ` (unresolved)` appended when the registry does not know it, and
 * `judge:session` when the session model judges.
 */
export function formatJudgeStatus(judge: ResolvedJudge): string {
  if (judge.pair === undefined) {
    return "judge:session";
  }
  const text = `judge:${judge.pair.provider}/${judge.pair.model}`;
  return judge.model === undefined ? `${text} (unresolved)` : text;
}
