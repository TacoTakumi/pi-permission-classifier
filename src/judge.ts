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
 * The system-one judge resolves only through the registry's classifier
 * lookup and renders as `s1:<provider>/<id>`, with the same suffix.
 *
 * The `--permission-model` launch flag parses into a session override of the
 * mode and both judges' models, merged over the config per ask.
 *
 * This module has no side effects and imports nothing from pi beyond types.
 */

import type { ClassifierApi, ClassifierModel, Model } from "@earendil-works/pi-ai";

import {
  type ClassifierConfig,
  type Mode,
  modeSchema,
  quickJudgeConfigSchema,
  type SystemOneConfig,
} from "./config-schema";

/** A provider/id pair naming a judge model. */
export interface JudgePair {
  provider: string;
  model: string;
}

/** The narrow registry projection the resolver needs. */
export interface JudgeRegistryLike {
  find(provider: string, modelId: string): Model<any> | undefined;
}

/**
 * Parse an operator-typed `<provider>/<id>` reference, splitting at the first
 * slash (as pi's own model resolver does) so ids that contain slashes
 * survive. Returns `undefined` for anything without both halves.
 */
export function parseJudgePair(text: string): JudgePair | undefined {
  const trimmed = text.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return undefined;
  }
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
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

/** The narrow registry projection the system-one resolver needs. */
export interface SystemOneJudgeRegistryLike {
  findOfType(
    type: "classifier",
    provider: string,
    modelId: string,
  ): ClassifierModel<ClassifierApi> | undefined;
}

/** The configured system-one judge and the classifier model it names. */
export interface ResolvedSystemOneJudge {
  /** The configured pair; `undefined` when systemOne names none. */
  pair: JudgePair | undefined;
  /** The classifier model; `undefined` means every ask is model-unresolved. */
  model: ClassifierModel<ClassifierApi> | undefined;
}

/** Resolve the system-one pair through the classifier lookup only. */
export function resolveSystemOneJudge(
  systemOne: Pick<SystemOneConfig, "provider" | "model">,
  registry: SystemOneJudgeRegistryLike | undefined,
): ResolvedSystemOneJudge {
  if (systemOne.provider === undefined || systemOne.model === undefined) {
    return { pair: undefined, model: undefined };
  }
  const pair: JudgePair = { provider: systemOne.provider, model: systemOne.model };
  return { pair, model: registry?.findOfType("classifier", pair.provider, pair.model) };
}

/**
 * The footer text for the system-one judge: `s1:<provider>/<id>`, with
 * ` (unresolved)` when the classifier lookup fails, and
 * `s1:unset (unresolved)` when systemOne names no pair.
 */
export function formatSystemOneStatus(judge: ResolvedSystemOneJudge): string {
  if (judge.pair === undefined) {
    return "s1:unset (unresolved)";
  }
  const text = `s1:${judge.pair.provider}/${judge.pair.model}`;
  return judge.model === undefined ? `${text} (unresolved)` : text;
}

/**
 * Session-only values from the launch flag. An absent field leaves the
 * config's value; `llm: null` makes the LLM judge follow the chat model.
 */
export interface SessionOverride {
  mode?: Mode;
  llm?: JudgePair | null;
  quick?: JudgePair;
}

/** The registry lookups the flag parser checks models with. */
export interface FlagRegistryLike {
  find(provider: string, modelId: string): Model<any> | undefined;
  findOfType(
    type: "classifier",
    provider: string,
    modelId: string,
  ): ClassifierModel<ClassifierApi> | undefined;
}

/** The parsed flag: the values that apply, and one warning per ignored item. */
export interface ParsedFlag {
  override: SessionOverride;
  warnings: string[];
}

/**
 * Parse the comma list `quick:<provider>/<id>`, `llm:<provider>/<id>`,
 * `llm:chat-model` and `mode:<mode>`, in any subset. An LLM pair must be a
 * chat model and a quick pair a classifier model the registry knows. Every
 * other item is ignored with a warning and the rest still applies; a later
 * item for the same field wins.
 */
export function parseFlagOverride(
  raw: string,
  registry: FlagRegistryLike | undefined,
): ParsedFlag {
  const override: SessionOverride = {};
  const warnings: string[] = [];
  for (const item of raw.split(",").map((part) => part.trim())) {
    if (item === "") {
      continue;
    }
    const colon = item.indexOf(":");
    const prefix = colon < 0 ? "" : item.slice(0, colon);
    const value = colon < 0 ? item : item.slice(colon + 1).trim();
    if (prefix === "mode") {
      const mode = modeSchema.safeParse(value);
      if (mode.success) {
        override.mode = mode.data;
      } else {
        warnings.push(`${item}: unknown mode ${value}; use one of ${modeSchema.options.join(", ")}.`);
      }
      continue;
    }
    if (prefix === "llm" && value === "chat-model") {
      override.llm = null;
      continue;
    }
    const pair = parseJudgePair(value);
    if (prefix === "llm" && pair) {
      if (registry?.find(pair.provider, pair.model)) {
        override.llm = pair;
      } else {
        warnings.push(`${item}: ${value} is not a known chat model.`);
      }
      continue;
    }
    if (prefix === "quick" && pair) {
      if (registry?.findOfType("classifier", pair.provider, pair.model)) {
        override.quick = pair;
      } else {
        warnings.push(`${item}: ${value} is not a known classifier model.`);
      }
      continue;
    }
    if (colon < 0 && pair) {
      warnings.push(`${item} has no prefix; write llm:${item} to set the LLM judge.`);
      continue;
    }
    warnings.push(
      `${item} is not one of quick:<provider>/<id>, llm:<provider>/<id>, llm:chat-model, mode:<mode>.`,
    );
  }
  return { override, warnings };
}

/**
 * The config with the session override merged in, read per ask. The judges'
 * own resolution (registry lookup, auth, defer on failure) is unchanged, so
 * an override can never widen a verdict. Returns the config itself when the
 * override sets nothing.
 */
export function applySessionOverride(
  config: ClassifierConfig | undefined,
  override: SessionOverride,
): ClassifierConfig | undefined {
  if (
    !config ||
    (override.mode === undefined && override.llm === undefined && override.quick === undefined)
  ) {
    return config;
  }
  let next: ClassifierConfig = { ...config };
  if (override.mode !== undefined) {
    next.mode = override.mode;
  }
  if (override.llm === null) {
    const { provider: _provider, model: _model, ...rest } = next;
    next = rest;
  } else if (override.llm !== undefined) {
    next.provider = override.llm.provider;
    next.model = override.llm.model;
  }
  if (override.quick !== undefined) {
    next.quickJudge = {
      ...(next.quickJudge ?? quickJudgeConfigSchema.parse({})),
      provider: override.quick.provider,
      model: override.quick.model,
    };
  }
  return next;
}
