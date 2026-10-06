/**
 * The zod source of truth for the classifier extension config.
 *
 * The config carries the model mechanism (provider/model override,
 * instructions, timeout, context budget); the chain policy half
 * (`authorizerChain`, the delegation envelope) lives in
 * `@gotgenes/pi-permission-system`.
 */

import { z } from "zod";

/** Extension id — the `extensions/<id>/config.json` path segment. */
export const CLASSIFIER_EXTENSION_ID = "pi-permission-classifier";

/** Default per-review model-call budget, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Default cap on the extracted full-command context, in UTF-8 bytes. An ask
 * whose context exceeds the budget defers before any model call;
 * context is never truncated to fit.
 */
export const DEFAULT_CONTEXT_BUDGET_BYTES = 8192;

/** Default quick judge allow and deny probability threshold. */
export const DEFAULT_SYSTEM_ONE_THRESHOLD = 0.9;

/**
 * Which verdicts a link may return. `allow-deny-defer` passes all three;
 * `allow-defer` never denies; `allow-deny` never defers.
 */
export const verdictsSchema = z.enum(["allow-deny-defer", "allow-defer", "allow-deny"]);

export type Verdicts = z.infer<typeof verdictsSchema>;

/** What a link returns on any failure. Never allow. */
export const onErrorSchema = z.enum(["defer", "deny"]);

export type OnError = z.infer<typeof onErrorSchema>;

const thresholdSchema = z
  .number()
  .min(0)
  .max(1)
  .default(DEFAULT_SYSTEM_ONE_THRESHOLD);

/**
 * Who judges an ask: `llm` (the LLM judge alone, the default), `quick` (the
 * quick judge alone), or `quick-then-llm` (the quick judge first, the LLM
 * judge for anything it does not allow).
 */
export const modeSchema = z.enum(["llm", "quick", "quick-then-llm"]);

export type Mode = z.infer<typeof modeSchema>;

/**
 * Settings for the quick judge, a System One decision model.
 * `provider`/`model` name a classifier model and come together or not at all.
 */
export const quickJudgeConfigSchema = z
  .object({
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    verdicts: verdictsSchema.default("allow-defer"),
    onError: onErrorSchema.default("defer"),
    // Absent by default: the quick judge then uses its built-in threshold per
    // question. A value set here applies to all three questions.
    allowThreshold: z.number().min(0).max(1).optional(),
    denyThreshold: thresholdSchema,
    guidance: z.boolean().default(true),
    timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
  })
  .refine((config) => (config.provider === undefined) === (config.model === undefined), {
    message: "provider and model must be set together or not at all",
  });

export type QuickJudgeConfig = z.infer<typeof quickJudgeConfigSchema>;

/**
 * Operator-owned config for the auto-classifier reviewer. An absent config
 * file means no registration (fail-safe); an empty object means the defaults
 * below. `provider`/`model` come together or not at all — with neither, the
 * session's active model judges.
 */
export const classifierConfigSchema = z
  .object({
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    instructions: z.string().min(1).optional(),
    // Accepted for backward compatibility and never read: the reviewer
    // judges every surface outside the path and external_directory
    // families. Kept so an
    // older config file still parses.
    surfaces: z.array(z.string().min(1)).optional(),
    timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
    contextBudgetBytes: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_CONTEXT_BUDGET_BYTES),
    // The top-level fields above and below are the LLM judge's settings.
    // Unknown keys, such as the renamed systemOne and classifierEnabled, are
    // dropped; the loader reports those two.
    mode: modeSchema.default("llm"),
    quickJudge: quickJudgeConfigSchema.optional(),
    verdicts: verdictsSchema.default("allow-deny-defer"),
    onError: onErrorSchema.default("defer"),
  })
  .refine((config) => (config.provider === undefined) === (config.model === undefined), {
    message: "provider and model must be set together or not at all",
  });

export type ClassifierConfig = z.infer<typeof classifierConfigSchema>;
