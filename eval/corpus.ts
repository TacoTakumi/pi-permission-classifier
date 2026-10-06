/**
 * The eval corpus: asks rebuilt from the permission review log and the pi
 * session files. Each permission_request.waiting entry that ended approved
 * is a safe case; its full command and cwd come from the session file that
 * holds the same tool call id, and so does the user text: the runtime
 * selection of the user messages on the call's branch up to the call, or
 * none when the runtime would send none. The corpus is the operator's own
 * command history, so it is written only under drafts/ (gitignored) and
 * never committed.
 */

import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { readUserIntent } from "../src/user-intent";

/**
 * Who approved a logged ask: the user, a judge link, or anything else (a
 * rule, or a path the log does not name). A forwarded approval counts as
 * whoever decided it in the parent session.
 */
export type Decider = "user" | "judge" | "other";

/**
 * How a hazard case is paired with user text: none, an unrelated task, a
 * request naming the action, pasted text claiming approval, or a
 * prohibition before the action.
 */
export type Variant = "none" | "unrelated" | "requested" | "injection" | "forbidden";

/** Whether a user request may clear a hazard (soft) or never (hard). */
export type Tier = "hard" | "soft";

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
  /** Who approved it; safe cases only. */
  decider?: Decider;
  /** The user text the runtime would send with this ask; absent when none. */
  userMessages?: string[];
  /** Hazard cases only: how the case is paired with user text. */
  variant?: Variant;
  /** Hazard cases only: whether a user request may clear it. */
  tier?: Tier;
}

/** One hand-written hazard case, as eval/hazard-cases.json holds it. */
export interface HazardCase {
  id: string;
  category: string;
  command: string;
  cwd?: string;
}

/** A hazard case that comes with its own user text. */
export interface PairedHazardCase extends HazardCase {
  tier: Tier;
  userMessages: string[];
}

/** eval/intent-cases.json: how the hazard cases are paired with user text. */
export interface IntentCaseFile {
  /** The user text of the unrelated-task variant. */
  unrelatedTask: string;
  /** The user text of the requested variant; `{command}` is the command. */
  requestTemplate: string;
  /** The tier of each hazard category. */
  tiers: Record<string, Tier>;
  /** Tiers for single cases that differ from their category's. */
  caseTiers: Record<string, Tier>;
  injection: PairedHazardCase[];
  forbidden: PairedHazardCase[];
}

/** A tool call as a session file records it. */
export interface SessionToolCall {
  cwd: string;
  name: string;
  command?: string;
  /** The user text the runtime would send at this call; absent when none. */
  userMessages?: string[];
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
  const final = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (typeof row.event === "string" && FINAL_EVENTS.has(row.event) && typeof row.requestId === "string") {
      final.set(row.requestId, row);
    }
  }
  const cases: EvalCase[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.event !== "permission_request.waiting") continue;
    const requestId = row.requestId;
    const toolCallId = row.toolCallId;
    if (typeof requestId !== "string" || typeof toolCallId !== "string") continue;
    const outcome = final.get(requestId);
    if (outcome?.event !== "permission_request.approved") continue;
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
    cases.push({
      id: requestId,
      kind: "safe",
      value,
      surface,
      tool,
      cwd: call.cwd,
      fullCommand,
      decider: deciderOf(outcome),
      ...(call.userMessages === undefined ? {} : { userMessages: call.userMessages }),
    });
  }
  return cases;
}

/** Forwarded hops followed before a decider counts as unknown. */
const MAX_FORWARD_DEPTH = 8;

/**
 * Who approved a request, from its final log entry. A forwarded approval was
 * decided in the parent session, so its nested decision is followed through
 * every hop, as pi-permission-system's effectiveDecider does.
 */
function deciderOf(outcome: Record<string, unknown>): Decider {
  let decidedBy = outcome.decidedBy as { kind?: unknown; decision?: unknown } | null | undefined;
  for (let hop = 0; hop < MAX_FORWARD_DEPTH && decidedBy?.kind === "forwarded"; hop++) {
    decidedBy = decidedBy.decision as typeof decidedBy;
  }
  if (decidedBy?.kind === "user") return "user";
  if (decidedBy?.kind === "authorizer") return "judge";
  return "other";
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

/** A parsed session file line, as far as the corpus reads it. */
interface SessionLine {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  cwd?: unknown;
  message?: { role?: unknown; content?: unknown };
}

/**
 * Pure: the hazard cases in every intent variant. Each hazard case runs with
 * no user text, with an unrelated task, and with a request naming its
 * command (ids `<id>`, `<id>#unrelated`, `<id>#requested`); the injection and
 * forbidden cases follow with their own user text. A hazard category with
 * no tier throws, so a new category is never judged untiered.
 */
export function intentHazardCases(
  hazards: readonly HazardCase[],
  file: IntentCaseFile,
  cwd: string,
): EvalCase[] {
  const cases: EvalCase[] = [];
  for (const base of hazardCases(hazards, cwd)) {
    const tier = file.caseTiers[base.id] ?? file.tiers[base.category!];
    if (tier !== "hard" && tier !== "soft") {
      throw new Error(`hazard category ${base.category} of ${base.id} has no tier in intent-cases.json`);
    }
    const request = file.requestTemplate.replace("{command}", base.value);
    cases.push(
      { ...base, variant: "none", tier },
      { ...base, id: `${base.id}#unrelated`, variant: "unrelated", tier, userMessages: [file.unrelatedTask] },
      { ...base, id: `${base.id}#requested`, variant: "requested", tier, userMessages: [request] },
    );
  }
  for (const [variant, paired] of [
    ["injection", file.injection],
    ["forbidden", file.forbidden],
  ] as const) {
    for (const testCase of paired) {
      const [base] = hazardCases([testCase], cwd);
      cases.push({ ...base!, variant, tier: testCase.tier, userMessages: [...testCase.userMessages] });
    }
  }
  return cases;
}

/**
 * Pure: the tool calls in one session file's lines, by tool call id, each
 * with the user text the runtime would send at that call. Entries form a
 * tree through parentId (an entry without one follows the line before it),
 * so each call reads only the user messages on its own branch.
 */
export function toolCallsFromSession(lines: Iterable<string>): Map<string, SessionToolCall> {
  const calls = new Map<string, SessionToolCall>();
  let cwd = "";
  // Per entry: the nearest user message on its branch, itself included.
  const nearestUser = new Map<string, string | null>();
  // Per user message: the entry and the user message before it on the branch.
  const users = new Map<string, { entry: SessionEntry; previous: string | null }>();
  // Per nearest user message: the user text, shared by every call below it.
  const userText = new Map<string | null, string[] | undefined>();
  let previousId: string | null = null;

  const userTextAt = (nearest: string | null): string[] | undefined => {
    if (!userText.has(nearest)) {
      const branch: SessionEntry[] = [];
      for (let at = nearest; at !== null; at = users.get(at)?.previous ?? null) {
        const user = users.get(at);
        if (user === undefined) break;
        branch.push(user.entry);
      }
      branch.reverse();
      const intent = readUserIntent(
        { sessionManager: { getBranch: () => branch }, hasPendingMessages: () => false },
        false,
      );
      userText.set(nearest, intent === undefined ? undefined : [...intent.messages]);
    }
    return userText.get(nearest);
  };

  for (const line of lines) {
    if (line.trim() === "") continue;
    let entry: SessionLine;
    try {
      entry = JSON.parse(line) as SessionLine;
    } catch {
      continue;
    }
    if (entry.type === "session") {
      if (cwd === "") cwd = typeof entry.cwd === "string" ? entry.cwd : "";
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id : undefined;
    const parentId =
      entry.parentId === undefined ? previousId : typeof entry.parentId === "string" ? entry.parentId : null;
    let nearest = parentId === null ? null : (nearestUser.get(parentId) ?? null);
    const role = entry.type === "message" ? entry.message?.role : undefined;
    if (role === "user" && id !== undefined) {
      users.set(id, { entry: entry as SessionEntry, previous: nearest });
      nearest = id;
    }
    if (id !== undefined) {
      nearestUser.set(id, nearest);
      previousId = id;
    }

    const content = entry.message?.content;
    if (role !== "assistant" || !Array.isArray(content)) continue;
    for (const part of content as Record<string, unknown>[]) {
      if (part?.type !== "toolCall" || typeof part.id !== "string") continue;
      const args = part.arguments as Record<string, unknown> | undefined;
      const paired = userTextAt(nearest);
      calls.set(part.id, {
        cwd,
        name: typeof part.name === "string" ? part.name : "",
        command: typeof args?.command === "string" ? args.command : undefined,
        ...(paired === undefined ? {} : { userMessages: paired }),
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
