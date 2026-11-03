/**
 * The designated context reader for full commands and operation evidence.
 *
 * A bash gate that intercepts one unit of a larger command attaches the whole
 * command as the payload's single "full command" evidence entry
 * (agent-authored ask text, never a tool result). Full commands require a
 * bash payload and the designated label. Operation context separately selects
 * operation-purpose annotations and complete, validated file-operation
 * evidence. Unrelated evidence, previews and malformed shapes are ignored.
 * Combined measurements gate the LLM request and supply the audit hash.
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
  readonly purpose?: string;
  readonly fileOperation?: z.infer<typeof fileOperationSchema>;
}

export type ContextMeasurement = Pick<FullCommandContext, "bytes" | "hash12">;

export function extractOperationContext(
  payload: PromptPayload,
): OperationContext | null {
  try {
    const purpose = Array.isArray(payload.annotations)
      ? payload.annotations.find(
          (entry) => entry?.source === "operation-purpose",
        )?.text
      : undefined;
    const context: {
      purpose?: string;
      fileOperation?: OperationContext["fileOperation"];
    } = {};
    if (typeof purpose === "string" && purpose.trim() !== "")
      context.purpose = purpose;
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
          context.fileOperation = parsed.data;
        }
      } catch {
        // 无效的文件证据不作为操作内容提供给模型。
      }
    }
    return Object.keys(context).length === 0 ? null : context;
  } catch {
    return null;
  }
}

export function measureReviewContext(
  fullCommand: FullCommandContext | null,
  operation: OperationContext | null,
): ContextMeasurement | null {
  if (operation === null) return fullCommand;
  const text = JSON.stringify({
    ...(fullCommand === null ? {} : { fullCommand: fullCommand.text }),
    ...operation,
  });
  return {
    bytes: Buffer.byteLength(text, "utf8"),
    hash12: createHash("sha256")
      .update(text, "utf8")
      .digest("hex")
      .slice(0, 12),
  };
}
