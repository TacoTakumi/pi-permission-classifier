/**
 * The designated context reader for full commands and operation evidence.
 *
 * A bash gate that intercepts one unit of a larger command attaches the whole
 * command as the payload's single "full command" evidence entry
 * (agent-authored ask text, never a tool result). Full commands require a
 * bash payload and the designated label. Operation context separately selects
 * complete, validated file-operation evidence. Annotations, unrelated evidence,
 * previews and malformed shapes are ignored. Command and operation measurements
 * remain independent in the audit log and share one byte budget.
 */

import { createHash } from "node:crypto";

import type { PromptPayload } from "@gotgenes/pi-permission-system";
import { z } from "zod";

/** The upstream label on the enclosing-command evidence entry. */
const FULL_COMMAND_LABEL = "full command";

/** The extracted full command with its measured facts. */
export interface FullCommandContext {
  /** The full command exactly as the payload carried it. */
  readonly text: string;
  /** UTF-8 byte length of the text, the budget-gate measure. */
  readonly bytes: number;
  /** First 12 lowercase hex chars of sha256(text), the audit correlator. */
  readonly hash12: string;
}

/**
 * Extract the full-command context from a bash-kind ask payload, or null.
 *
 * Null for any other payload kind, any other label, a non-string or empty
 * text, and an absent or malformed evidence array. Never throws.
 */
export function extractFullCommandContext(
  payload: PromptPayload,
): FullCommandContext | null {
  try {
    if (typeof payload !== "object" || payload === null) return null;
    if (payload.kind !== "bash") return null;

    const { evidence } = payload;
    if (!Array.isArray(evidence)) return null;

    const entry = evidence.find(
      (candidate): boolean =>
        typeof candidate === "object" &&
        candidate !== null &&
        candidate.label === FULL_COMMAND_LABEL,
    );
    if (entry === undefined) return null;

    const { text } = entry;
    if (typeof text !== "string" || text === "") return null;

    return {
      text,
      bytes: Buffer.byteLength(text, "utf8"),
      hash12: createHash("sha256")
        .update(text, "utf8")
        .digest("hex")
        .slice(0, 12),
    };
  } catch {
    return null;
  }
}

const replacementSchema = z.object({
  oldText: z.string(),
  newText: z.string(),
});
const fileOperationSchema = z.union([
  z.object({
    tool: z.literal("read"),
    path: z.string(),
    offset: z.number().optional(),
    limit: z.number().optional(),
  }),
  z.object({ tool: z.literal("write"), path: z.string(), content: z.string() }),
  z
    .object({
      tool: z.literal("edit"),
      path: z.string(),
      oldText: z.string().optional(),
      newText: z.string().optional(),
      edits: z.array(replacementSchema).min(1).optional(),
    })
    .refine(
      (value) =>
        (value.oldText === undefined) === (value.newText === undefined) &&
        (value.edits !== undefined || value.oldText !== undefined),
    ),
]);

export interface OperationContext {
  readonly fileOperation: z.infer<typeof fileOperationSchema>;
}

export type ContextMeasurement = Pick<FullCommandContext, "bytes" | "hash12">;

export function extractOperationContext(
  payload: PromptPayload,
): OperationContext | null {
  try {
    const entry =
      payload.kind === "tool" && Array.isArray(payload.evidence)
        ? payload.evidence.find(
            (candidate) => candidate?.label === "file operation",
          )
        : undefined;
    if (typeof entry?.text === "string") {
      try {
        const parsed = fileOperationSchema.safeParse(JSON.parse(entry.text));
        if (parsed.success && parsed.data.tool === payload.request.toolName) {
          return { fileOperation: parsed.data };
        }
      } catch {
        return null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function measureOperationContext(
  operation: OperationContext | null,
): ContextMeasurement | null {
  if (operation === null) return null;
  const text = JSON.stringify(operation.fileOperation);
  return {
    bytes: Buffer.byteLength(text, "utf8"),
    hash12: createHash("sha256")
      .update(text, "utf8")
      .digest("hex")
      .slice(0, 12),
  };
}
