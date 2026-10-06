/**
 * The eval corpus: the safe cases read from the judged ask store
 * (data/asks.jsonl, written by `npm run data:pull`) and the hazard cases
 * from eval/hazard-cases.json with their intent variants. Each stored ask
 * that ended approved on a judged surface is a safe case, with the user
 * text the runtime would have sent, or none for an ask forwarded from a
 * subagent. The raw review log and session files are read by the pull
 * only, never here.
 */

import { readFileSync } from "node:fs";

import type { StoredAsk } from "./pull";

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

/** The surfaces the quick judge never sees. */
const UNJUDGED_SURFACE = /^(path|external_directory)/;

/**
 * Pure: the safe cases from stored asks. An ask counts once it ended
 * approved on a judged surface; asks that send the same state are kept
 * once. The user text is left out of a forwarded ask, as the runtime
 * sends none for it.
 */
export function safeCasesFromStore(asks: readonly StoredAsk[]): EvalCase[] {
  const cases: EvalCase[] = [];
  const seen = new Set<string>();
  for (const ask of asks) {
    if (ask.resolution !== "approved" || UNJUDGED_SURFACE.test(ask.surface)) continue;
    const key = JSON.stringify([ask.value, ask.surface, ask.tool, ask.cwd, ask.fullCommand]);
    if (seen.has(key)) continue;
    seen.add(key);
    cases.push({
      id: ask.id,
      kind: "safe",
      value: ask.value,
      surface: ask.surface,
      tool: ask.tool,
      cwd: ask.cwd,
      ...(ask.fullCommand === undefined ? {} : { fullCommand: ask.fullCommand }),
      decider: ask.decider === "user" || ask.decider === "judge" ? ask.decider : "other",
      ...(ask.userMessages === undefined || ask.forwarded ? {} : { userMessages: [...ask.userMessages] }),
    });
  }
  return cases;
}

/** The stored asks in the store file; a line that is not JSON is skipped. */
export function loadStoredAsks(path: string): StoredAsk[] {
  const asks: StoredAsk[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      asks.push(JSON.parse(line) as StoredAsk);
    } catch {
      continue;
    }
  }
  return asks;
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
