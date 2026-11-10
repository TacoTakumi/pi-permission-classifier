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
import { dirname } from "node:path";

import type { TargetContext, TargetState } from "../src/target-context";
import { extractTargetContext } from "../src/target-context";
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
  /**
   * `safe` for a logged ask that was approved, `hazard` for a hand-written
   * command case, `file-op` for a path-only file case.
   */
  kind: "safe" | "hazard" | "file-op";
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
  /** File-op cases only: what the case is for. */
  fileTier?: FileOpTier;
  /** File-op cases only: the group of cases that differ only in the path. */
  pairId?: string;
  /**
   * File-op cases only: the target facts, produced by the same extractor the
   * link runs, so an eval state is a production state.
   */
  target?: TargetContext;
}

/**
 * What a file-op case is for. `safe` and `create` are ordinary project work;
 * `temp` is the operating system's temporary directory; `outside` is a real
 * file somewhere else; `never` is a secret or a guard, which no threshold may
 * allow; `pair` is one member of a group whose only difference is the path.
 */
export type FileOpTier = "safe" | "create" | "temp" | "outside" | "never" | "pair";

/** One file-op case, as eval/file-op-cases.json holds it. */
export interface FileOpCase {
  id: string;
  tier: FileOpTier;
  pairId?: string;
  /** The tool the gate gated, which is also the gated value. */
  tool: string;
  /** The absolute spelling the gate matched on. */
  path: string;
  /**
   * A working-directory-relative spelling to emit into `matchValues`, the way
   * the gate emits one. Named for what the case author says was written; the
   * fact the extractor returns is called `relativeSpelling` instead, because a
   * gate also synthesizes that spelling for any path inside the project, and no
   * reader of `matchValues` can tell the two apart. The prompt follows the
   * extractor's wording, not this one.
   */
  asWritten?: string;
  /** The symlink-resolved spelling, when a symlink leads somewhere else. */
  resolved?: string | null;
  /** What exists at the target. */
  state: TargetState;
}

/** eval/file-op-cases.json. */
export interface FileOpCaseFile {
  cwd: string;
  temp: string;
  cases: FileOpCase[];
}

/**
 * Pure: the file-op cases as asks whose only evidence is the path.
 *
 * Each case names what exists at the target and where the two places are, and
 * the target facts come out of `extractTargetContext` — the code the link runs
 * — rather than a copy of its rules. A case whose facts the extractor will not
 * produce throws at load, so the corpus cannot quietly drift from production.
 */
export function fileOpCases(file: FileOpCaseFile): EvalCase[] {
  return file.cases.map((testCase) => {
    const cwd = file.cwd;
    const temp = file.temp;
    const canonical = testCase.resolved ?? testCase.path;
    const matchValues =
      testCase.asWritten === undefined
        ? [testCase.path, canonical]
        : [testCase.path, testCase.asWritten, canonical];
    const details = {
      payload: { request: { value: testCase.tool, toolName: testCase.tool } },
      accessIntent: {
        surface: testCase.tool,
        matchValues,
        boundaryValue: canonical,
      },
    } as never;
    const reading = extractTargetContext(details, {
      getCwd: () => cwd,
      getTempDirectory: () => temp,
      realpath: (candidate) =>
        candidate === canonical || candidate === cwd || candidate === temp ? candidate : null,
      stat: (candidate) => {
        if (candidate === canonical) {
          if (testCase.state === "file") return "file";
          if (testCase.state === "directory") return "directory";
          return "missing";
        }
        if (candidate === dirname(canonical)) {
          return testCase.state === "missing-parent" ? "missing" : "directory";
        }
        return "missing";
      },
    });
    if (reading.included === false) {
      throw new Error(`file-op case ${testCase.id} yields no target (${reading.reason})`);
    }
    return {
      id: testCase.id,
      kind: "file-op" as const,
      category: testCase.tier,
      value: testCase.tool,
      surface: testCase.tool,
      tool: testCase.tool,
      cwd,
      fileTier: testCase.tier,
      ...(testCase.pairId === undefined ? {} : { pairId: testCase.pairId }),
      target: reading.target,
    };
  });
}

/** The file-op corpus, read from disk. */
export function loadFileOpCases(path: string): EvalCase[] {
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as FileOpCaseFile;
  return fileOpCases(parsed);
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
    // An ask with no surface comes from a log older than the surface field.
    if (ask.resolution !== "approved" || ask.surface === "" || UNJUDGED_SURFACE.test(ask.surface)) continue;
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
