/**
 * Pure judge resolution and status text.
 *
 * The effective judge is picked by one rule, in precedence order: a
 * session-only override (the `--permission-model` flag), then the merged
 * config's `provider`/`model` pair, then the session's active model. A named
 * pair is looked up in the model registry; when the registry does not know
 * it the judge is unresolved and every ask defers (fail-safe), which the
 * status text surfaces with an ` (unresolved)` suffix. The LLM judge renders
 * as `llm:<provider>/<id>`, or `llm:chat-model` when it follows the session's
 * chat model.
 *
 * The quick judge resolves only through the registry's classifier lookup
 * and renders as `quick:<provider>/<id>`, with the same suffix.
 *
 * The `--permission-model` launch flag parses into a session override of the
 * mode and both judges' models, merged over the config per ask.
 *
 * This module has no side effects and imports nothing from pi beyond types.
 */

import type { ClassifierApi, ClassifierModel, Model } from "@earendil-works/pi-ai";

import {
  DEFAULT_TIMEOUT_MS,
  type ClassifierConfig,
  type Mode,
  modeSchema,
  quickJudgeConfigSchema,
  type QuickJudgeConfig,
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
 * The footer text for the LLM judge: `llm:<provider>/<id>` for a named pair,
 * with ` (unresolved)` appended when the registry does not know it, and
 * `llm:chat-model` when the session's chat model judges.
 */
export function formatJudgeStatus(judge: ResolvedJudge): string {
  if (judge.pair === undefined) {
    return "llm:chat-model";
  }
  const text = `llm:${judge.pair.provider}/${judge.pair.model}`;
  return judge.model === undefined ? `${text} (unresolved)` : text;
}

/** The narrow registry projection the quick judge resolver needs. */
export interface QuickJudgeLookupLike {
  findOfType(
    type: "classifier",
    provider: string,
    modelId: string,
  ): ClassifierModel<ClassifierApi> | undefined;
}

/** The configured quick judge and the classifier model it names. */
export interface ResolvedQuickJudge {
  /** The configured pair; `undefined` when quickJudge names none. */
  pair: JudgePair | undefined;
  /** The classifier model; `undefined` means every ask is model-unresolved. */
  model: ClassifierModel<ClassifierApi> | undefined;
}

/** Resolve the quick judge pair through the classifier lookup only. */
export function resolveQuickJudge(
  quickJudge: Pick<QuickJudgeConfig, "provider" | "model">,
  registry: QuickJudgeLookupLike | undefined,
): ResolvedQuickJudge {
  if (quickJudge.provider === undefined || quickJudge.model === undefined) {
    return { pair: undefined, model: undefined };
  }
  const pair: JudgePair = { provider: quickJudge.provider, model: quickJudge.model };
  return { pair, model: registry?.findOfType("classifier", pair.provider, pair.model) };
}

/**
 * The footer text for the quick judge: `quick:<provider>/<id>`, with
 * ` (unresolved)` when the classifier lookup fails, and
 * `quick:unset (unresolved)` when quickJudge names no pair.
 */
export function formatQuickStatus(judge: ResolvedQuickJudge): string {
  if (judge.pair === undefined) {
    return "quick:unset (unresolved)";
  }
  const text = `quick:${judge.pair.provider}/${judge.pair.model}`;
  return judge.model === undefined ? `${text} (unresolved)` : text;
}

/**
 * A judge's model-call budget as whole seconds, for display. An absent
 * `timeoutMs` (the key was cleared, or never set) reads as the built-in
 * default. The command's timeout forms take and show seconds and never
 * milliseconds, so a budget cannot be misread across the two units.
 */
export function formatTimeoutSeconds(timeoutMs: number | undefined): string {
  return String(Math.round((timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000));
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
