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
 * whose context exceeds the budget defers before any model call (REQ-07);
 * context is never truncated to fit.
 */
export const DEFAULT_CONTEXT_BUDGET_BYTES = 8192;

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
  })
  .refine((config) => (config.provider === undefined) === (config.model === undefined), {
    message: "provider and model must be set together or not at all",
  });

export type ClassifierConfig = z.infer<typeof classifierConfigSchema>;
