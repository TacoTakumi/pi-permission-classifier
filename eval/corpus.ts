/**
 * The eval corpus: asks rebuilt from the permission review log and the pi
 * session files. Each permission_request.waiting entry that ended approved
 * is a safe case; its full command and cwd come from the session file that
 * holds the same tool call id. The corpus is the operator's own command
 * history, so it is written only under drafts/ (gitignored) and never
 * committed.
 */

import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** One ask the eval sends to the quick judge. */
export interface EvalCase {
  id: string;
  /** `safe` for a logged ask that was approved; a category for a hazard case. */
  kind: "safe" | "hazard";
  category?: string;
  value: string;
  surface: string;
  tool: string;
  cwd: string;
  /** The full bash command, when there is one. */
  fullCommand?: string;
}

/** One hand-written hazard case, as eval/hazard-cases.json holds it. */
export interface HazardCase {
  id: string;
  category: string;
  command: string;
  cwd?: string;
}

/** A tool call as a session file records it. */
export interface SessionToolCall {
  cwd: string;
  name: string;
  command?: string;
}

/** The surfaces the quick judge never sees. */
const UNJUDGED_SURFACE = /^(path|external_directory)/;

/** The final events of a permission request, by its last word. */
const FINAL_EVENTS = new Set([
  "permission_request.approved",
  "permission_request.denied",
  "permission_request.session_approved",
  "permission_request.blocked",
]);

/**
 * Pure: the safe cases from parsed review log rows and a tool call index.
 * A request counts once it waited for a decision and ended approved, its
 * tool call is in the index, and it is on a judged surface. Cases that send
 * the same state are kept once.
 */
export function safeCasesFromLog(
  rows: readonly Record<string, unknown>[],
  toolCalls: ReadonlyMap<string, SessionToolCall>,
): EvalCase[] {
  const final = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.event === "string" && FINAL_EVENTS.has(row.event) && typeof row.requestId === "string") {
      final.set(row.requestId, row.event);
    }
  }
  const cases: EvalCase[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.event !== "permission_request.waiting") continue;
    const requestId = row.requestId;
    const toolCallId = row.toolCallId;
    if (typeof requestId !== "string" || typeof toolCallId !== "string") continue;
    if (final.get(requestId) !== "permission_request.approved") continue;
    const surface = typeof row.surface === "string" ? row.surface : undefined;
    if (surface === undefined || UNJUDGED_SURFACE.test(surface)) continue;
    const call = toolCalls.get(toolCallId);
    if (call === undefined) continue;
    const value = [row.command, row.target, row.path].find(
      (candidate): candidate is string => typeof candidate === "string" && candidate !== "",
    );
    if (value === undefined) continue;
    const tool = typeof row.toolName === "string" ? row.toolName : call.name;
    const fullCommand = tool === "bash" ? call.command : undefined;
    const key = JSON.stringify([value, surface, tool, call.cwd, fullCommand]);
    if (seen.has(key)) continue;
    seen.add(key);
    cases.push({ id: requestId, kind: "safe", value, surface, tool, cwd: call.cwd, fullCommand });
  }
  return cases;
}

/** Pure: the hazard cases as bash asks, run in `cwd` unless a case names one. */
export function hazardCases(hazards: readonly HazardCase[], cwd: string): EvalCase[] {
  return hazards.map((hazard) => ({
    id: hazard.id,
    kind: "hazard",
    category: hazard.category,
    value: hazard.command,
    surface: "bash",
    tool: "bash",
    cwd: hazard.cwd ?? cwd,
    fullCommand: hazard.command,
  }));
}

/** Pure: the tool calls in one session file's lines, by tool call id. */
export function toolCallsFromSession(lines: Iterable<string>): Map<string, SessionToolCall> {
  const calls = new Map<string, SessionToolCall>();
  let cwd = "";
  for (const line of lines) {
    if (cwd === "" && line.includes('"type":"session"')) {
      const header = JSON.parse(line) as { cwd?: unknown };
      cwd = typeof header.cwd === "string" ? header.cwd : "";
      continue;
    }
    if (!line.includes('"toolCall"')) continue;
    const entry = JSON.parse(line) as { message?: { content?: unknown } };
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content as Record<string, unknown>[]) {
      if (part?.type !== "toolCall" || typeof part.id !== "string") continue;
      const args = part.arguments as Record<string, unknown> | undefined;
      calls.set(part.id, {
        cwd,
        name: typeof part.name === "string" ? part.name : "",
        command: typeof args?.command === "string" ? args.command : undefined,
      });
    }
  }
  return calls;
}

/** Every session file under the sessions dir, recursively. */
function sessionFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      files.push(...sessionFiles(path));
    } else if (name.endsWith(".jsonl")) {
      files.push(path);
    }
  }
  return files;
}

async function readLines(path: string): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    lines.push(line);
  }
  return lines;
}

/** Read the log and the session files and build the safe cases. */
export async function buildSafeCorpus(logPath: string, sessionsDir: string): Promise<EvalCase[]> {
  const rows = readFileSync(logPath, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const toolCalls = new Map<string, SessionToolCall>();
  for (const file of sessionFiles(sessionsDir)) {
    for (const [id, call] of toolCallsFromSession(await readLines(file))) {
      toolCalls.set(id, call);
    }
  }
  return safeCasesFromLog(rows, toolCalls);
}
