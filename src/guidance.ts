/**
 * Guidance: which context files (the operator's global AGENTS.md and the
 * trusted project's own) reach the judge prompt, and why the rest do not.
 *
 * This module is the classifier's only reader of context files, and it reads
 * them through pi's own context-file walk (`loadProjectContextFiles`), never
 * node:fs, so the judge sees exactly the file set the main agent sees:
 * override names, the CLAUDE.md fallback, worktree shadowing. Files are read
 * from disk on every judged ask, so an edit takes effect on the next ask;
 * nothing is cached.
 *
 * Selection itself is pure. It receives the loader's file list, decides
 * inclusion, and measures every file for the audit trail. The rules, applied
 * in loader order:
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
import { dirname, resolve } from "node:path";

import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";

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

/** Where to look: the session cwd and the pi agent dir. */
export interface GuidanceLoadOptions {
  readonly cwd: string;
  readonly agentDir: string;
}

/** The disk seam: pi's context-file walk, or a test double. */
export type GuidanceLoader = (
  options: GuidanceLoadOptions,
) => readonly GuidanceSource[];

/**
 * Read the context files from disk through pi's loader: the agent dir file
 * first (when present), then each ancestor of cwd from the root down to cwd.
 */
export const loadGuidanceFromDisk: GuidanceLoader = (options) =>
  loadProjectContextFiles({ cwd: options.cwd, agentDir: options.agentDir });

/**
 * The global file among the loader's entries: the one that lives directly in
 * the agent dir, whatever its name. Undefined when the agent dir holds none.
 */
export function findGlobalGuidancePath(
  files: readonly GuidanceSource[],
  agentDir: string,
): string | undefined {
  const dir = resolve(agentDir);
  return files.find((file) => dirname(resolve(file.path)) === dir)?.path;
}

/**
 * Select the guidance files for one ask.
 *
 * `files` is the loader's list in loader order, `globalPath` identifies the
 * operator's global file within it (undefined when there is none), and
 * `trusted` is the project's trust state for this ask.
 */
export function selectGuidance(
  files: readonly GuidanceSource[],
  globalPath: string | undefined,
  trusted: boolean,
): GuidanceSelection {
  const included: IncludedGuidance[] = [];
  const dropped: DroppedGuidance[] = [];
  let total = 0;

  for (const { path, content } of files) {
    const isGlobal = globalPath !== undefined && path === globalPath;
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
