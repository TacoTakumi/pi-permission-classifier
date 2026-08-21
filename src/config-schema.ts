/**
 * The zod source of truth for the classifier extension config.
 *
 * The config carries the model mechanism (provider/model override,
 * instructions, reviewed surfaces, timeout); the chain policy half
 * (`authorizerChain`, the delegation envelope) lives in
 * `@gotgenes/pi-permission-system`.
 */

import { z } from "zod";

/** Extension id — the `extensions/<id>/config.json` path segment. */
export const CLASSIFIER_EXTENSION_ID = "pi-permission-classifier";

/** Default per-review model-call budget, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Surfaces the classifier reviews when config sets none. `path` and
 * `external_directory` are deliberately absent: the engine caps any link
 * `allow` on those surfaces to `defer`, so the classifier never attempts them.
 */
export const DEFAULT_SURFACES: readonly string[] = [
  "bash",
  "mcp",
  "skill",
  "tool",
  "read",
  "write",
  "edit",
];

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
    surfaces: z.array(z.string().min(1)).default([...DEFAULT_SURFACES]),
    timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
  })
  .refine((config) => (config.provider === undefined) === (config.model === undefined), {
    message: "provider and model must be set together or not at all",
  });

export type ClassifierConfig = z.infer<typeof classifierConfigSchema>;
