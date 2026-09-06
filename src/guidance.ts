/**
 * Guidance selection: which context files (the operator's global AGENTS.md
 * and the trusted project's own) reach the judge prompt, and why the rest do
 * not.
 *
 * This module is pure. It receives the loader's file list already read from
 * disk, decides inclusion, and measures every file for the audit trail. The
 * rules, applied in loader order:
 *
 * - The global file is always a candidate; every other file is a candidate
 *   only when the project is trusted (dropped as `untrusted` otherwise).
 * - A file over 16 KiB of UTF-8 is dropped whole, never truncated
 *   (`over-file-cap`).
 * - Included bytes accumulate; the first file that would push the total past
 *   32 KiB and every later file are dropped whole (`over-total-cap`).
 *
 * Bytes and hash12 follow the same conventions as the full-command evidence
 * read: UTF-8 byte length, first 12 hex chars of sha256.
 */

import { createHash } from "node:crypto";

/** Maximum UTF-8 bytes for a single included file. */
export const GUIDANCE_FILE_CAP_BYTES = 16 * 1024;

/** Maximum UTF-8 bytes across every included file. */
export const GUIDANCE_TOTAL_CAP_BYTES = 32 * 1024;

/** One context file as the loader reports it. */
export interface GuidanceSource {
  readonly path: string;
  readonly content: string;
}

/** A file that reaches the judge prompt. */
export interface IncludedGuidance {
  readonly path: string;
  /** The file text exactly as loaded; rendered verbatim. */
  readonly content: string;
  /** UTF-8 byte length of the content. */
  readonly bytes: number;
  /** First 12 lowercase hex chars of sha256(content). */
  readonly hash12: string;
  /** True for the operator's global file, false for a project file. */
  readonly isGlobal: boolean;
}

/** Why a file was excluded from the judge prompt. */
export type GuidanceDropReason = "untrusted" | "over-file-cap" | "over-total-cap";

/** A file that was excluded, with the first rule that excluded it. */
export interface DroppedGuidance {
  readonly path: string;
  readonly bytes: number;
  readonly reason: GuidanceDropReason;
}

/** The selection outcome, both lists in loader order. */
export interface GuidanceSelection {
  readonly included: readonly IncludedGuidance[];
  readonly dropped: readonly DroppedGuidance[];
}

/**
 * Select the guidance files for one ask.
 *
 * `files` is the loader's list in loader order, `globalPath` identifies the
 * operator's global file within it, and `trusted` is the project's trust
 * state for this ask.
 */
export function selectGuidance(
  files: readonly GuidanceSource[],
  globalPath: string,
  trusted: boolean,
): GuidanceSelection {
  const included: IncludedGuidance[] = [];
  const dropped: DroppedGuidance[] = [];
  let total = 0;

  for (const { path, content } of files) {
    const isGlobal = path === globalPath;
    const bytes = Buffer.byteLength(content, "utf8");

    if (!isGlobal && !trusted) {
      dropped.push({ path, bytes, reason: "untrusted" });
      continue;
    }
    if (bytes > GUIDANCE_FILE_CAP_BYTES) {
      dropped.push({ path, bytes, reason: "over-file-cap" });
      continue;
    }
    if (total + bytes > GUIDANCE_TOTAL_CAP_BYTES) {
      dropped.push({ path, bytes, reason: "over-total-cap" });
      continue;
    }

    total += bytes;
    included.push({
      path,
      content,
      bytes,
      hash12: createHash("sha256").update(content, "utf8").digest("hex").slice(0, 12),
      isGlobal,
    });
  }

  return { included, dropped };
}
