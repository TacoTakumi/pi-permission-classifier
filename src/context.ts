/**
 * The scoped full-command read (REQ-01): the one place in the classifier that
 * touches payload evidence.
 *
 * A bash gate that intercepts one unit of a larger command attaches the whole
 * command as the payload's single "full command" evidence entry
 * (agent-authored ask text, never a tool result). This module extracts exactly
 * that entry — bash kind, designated label, non-empty string text — and
 * measures it for the budget gate and the audit trail. Everything else — other
 * kinds, other labels, malformed shapes — yields null, and nothing here
 * throws: absence degrades to the value-only prompt.
 */

import { createHash } from "node:crypto";

import type { PromptPayload } from "@gotgenes/pi-permission-system";

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
      hash12: createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12),
    };
  } catch {
    return null;
  }
}
