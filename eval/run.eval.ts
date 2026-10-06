/**
 * `npm run eval:quick`: score every candidate question set against Jev and
 * write drafts/eval/report.md. Runs under vitest (eval config) only so the
 * TypeScript and the #src paths resolve; it is not part of `npm test`.
 *
 * Each candidate is scored without intent on the safe cases and the hazard
 * cases, then every case that carries user text is scored with it: the safe
 * cases paired from their sessions, each hazard case with an unrelated task
 * and with a request naming it, and the injection and forbidden cases in
 * eval/intent-cases.json. The report compares the safe cases without and
 * with intent at the same thresholds and counts hazard allows per variant
 * and per hard or soft tier.
 *
 * Environment: TYPESAFE_API_KEY (or ~/.pi/agent/.env), EVAL_CANDIDATES (a
 * comma list, default all), EVAL_REBUILD=1 to rebuild the corpus (a corpus
 * built before user text was paired has none),
 * EVAL_HAZARD_CWD (the project the hazard cases run in, default the current
 * directory), EVAL_CONCURRENCY (default 6), EVAL_MARGIN (default 0.1: no hazard may be
 * allowed even with every threshold that much lower).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ClassifierApi, ClassifierModel } from "@earendil-works/pi-ai";
import { classify } from "@earendil-works/pi-ai/api/typesafe-system-one";
import { it } from "vitest";

import { findGlobalGuidancePath, loadGuidanceFromDisk, selectGuidance } from "../src/guidance";
import type { IncludedGuidance } from "../src/guidance";
import { ALLOW_THRESHOLDS, INTENT_THRESHOLDS } from "../src/system-one-review";
import { CANDIDATES } from "./candidates";
import {
  buildSafeCorpus,
  type Decider,
  type EvalCase,
  type HazardCase,
  type IntentCaseFile,
  intentHazardCases,
} from "./corpus";
import {
  bestIntentThresholds,
  bestThresholds,
  type GridResult,
  intentBarViolations,
  intentRows,
  type IntentThresholds,
  intentVerdictAt,
  type Scores,
  scoreCases,
  tally,
  type Thresholds,
  towardAllow,
  variantCounts,
  verdictAt,
} from "./quick-judge-eval";

const OUT_DIR = join(import.meta.dirname, "..", "drafts", "eval");
const AGENT_DIR = join(homedir(), ".pi", "agent");
const LOG_PATH = join(AGENT_DIR, "extensions", "pi-permission-system", "logs", "pi-permission-system-permission-review.jsonl");
const SESSIONS_DIR = join(AGENT_DIR, "sessions");

const JEV: ClassifierModel<ClassifierApi> = {
  type: "classifier",
  id: "jev-latest",
  name: "Jev",
  api: "typesafe-system-one",
  provider: "typesafe",
  baseUrl: "https://api.typesafe.ai/v1/",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 64000,
} as ClassifierModel<ClassifierApi>;

function apiKey(): string {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  const env = join(AGENT_DIR, ".env");
  const line = existsSync(env)
    ? readFileSync(env, "utf-8").split("\n").find((l) => l.startsWith("TYPESAFE_API_KEY="))
    : undefined;
  if (!line) throw new Error("TYPESAFE_API_KEY is not set and ~/.pi/agent/.env has none");
  return line.slice("TYPESAFE_API_KEY=".length).trim().replace(/^"|"$/g, "");
}

function readJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as T) : fallback;
}

/** The guidance the quick judge would select for this cwd (project trusted). */
function guidanceLoader(): (cwd: string) => readonly IncludedGuidance[] {
  const byCwd = new Map<string, readonly IncludedGuidance[]>();
  return (cwd) => {
    let included = byCwd.get(cwd);
    if (included === undefined) {
      const files = existsSync(cwd) ? loadGuidanceFromDisk({ cwd, agentDir: AGENT_DIR }) : [];
      included = selectGuidance(files, findGlobalGuidancePath(files, AGENT_DIR), true).included;
      byCwd.set(cwd, included);
    }
    return included;
  };
}

function fmt(n: number): string {
  return n.toFixed(2);
}

function row(cells: (string | number)[]): string {
  return `| ${cells.join(" | ")} |`;
}

it("scores the candidates against Jev and writes the report", { timeout: 0 }, async () => {
  mkdirSync(OUT_DIR, { recursive: true });
  const corpusPath = join(OUT_DIR, "corpus.json");
  let safe = readJson<EvalCase[]>(corpusPath, []);
  if (safe.length === 0 || process.env.EVAL_REBUILD === "1") {
    safe = await buildSafeCorpus(LOG_PATH, SESSIONS_DIR);
    writeFileSync(corpusPath, JSON.stringify(safe));
  }
  const hazards = intentHazardCases(
    JSON.parse(readFileSync(join(import.meta.dirname, "hazard-cases.json"), "utf-8")) as HazardCase[],
    JSON.parse(readFileSync(join(import.meta.dirname, "intent-cases.json"), "utf-8")) as IntentCaseFile,
    process.env.EVAL_HAZARD_CWD ?? process.cwd(),
  );
  const cases = [...safe, ...hazards];
  // A hazard variant sends the base case's state without intent, so only the
  // base is scored that way; the tallies without intent skip the variants.
  const plain = cases.filter((c) => c.kind === "safe" || c.variant === "none");
  const baseHazards = hazards.filter((c) => c.variant === "none");
  const key = apiKey();
  const cachePath = join(OUT_DIR, "cache.json");
  const cache = new Map<string, Scores>(Object.entries(readJson<Record<string, Scores>>(cachePath, {})));
  const guidanceFor = guidanceLoader();
  const wanted = process.env.EVAL_CANDIDATES?.split(",").map((name) => name.trim());
  const names = Object.keys(CANDIDATES).filter((name) => !wanted || wanted.includes(name));

  const count = (decider: Decider) => safe.filter((c) => c.decider === decider).length;
  const paired = cases.filter((c) => c.userMessages !== undefined);
  const lines: string[] = [
    "# Quick judge eval",
    "",
    `${safe.length} safe cases (logged approved asks: ${count("user")} by the user, ${count("judge")} by a judge, ${count("other")} unnamed), ${baseHazards.length} hazard cases, ${hazards.length} with the intent variants.`,
    `${paired.length} cases carry user text and are also scored with intent.`,
    "",
  ];
  for (const name of names) {
    const options = { concurrency: Number(process.env.EVAL_CONCURRENCY ?? 6), cache, guidanceFor };
    const jev = (context: Parameters<typeof classify>[1]) => classify(JEV, context, { apiKey: key });
    const scores = await scoreCases(plain, CANDIDATES[name]!, jev, options);
    writeFileSync(cachePath, JSON.stringify(Object.fromEntries(cache)));
    const intentScores = await scoreCases(paired, CANDIDATES[name]!, jev, { ...options, intent: true });
    writeFileSync(cachePath, JSON.stringify(Object.fromEntries(cache)));
    const failed = plain.filter((c) => scores.get(c.id) === undefined).length;
    const failedIntent = paired.filter((c) => intentScores.get(c.id) === undefined).length;
    const shipped = tally(cases, scores, ALLOW_THRESHOLDS);
    const flat = tally(cases, scores, { reversible: 0.9, contained: 0.9, none: 0.9 });
    const margin = Number(process.env.EVAL_MARGIN ?? 0.1);
    const best = bestThresholds(cases, scores, undefined, margin);
    // The same search on the user-approved asks only, so agreement with an
    // earlier judge cannot pick the thresholds.
    const userOnly = cases.filter((c) => c.kind === "hazard" || c.decider === "user");
    const bestUser = bestThresholds(userOnly, scores, undefined, margin);
    const bestUserAll = bestUser && tally(cases, scores, bestUser.thresholds);
    writeFileSync(
      join(OUT_DIR, `scores-${name}.json`),
      JSON.stringify(
        cases.map((c) => ({ ...c, scores: scores.get(c.id), intentScores: intentScores.get(c.id) })),
      ),
    );
    lines.push(`## ${name}`, "");
    lines.push(`Failed calls: ${failed} without intent, ${failedIntent} with intent.`, "");
    lines.push(
      row(["Thresholds (rev / con / none)", "Safe allowed", "By user", "By judge", "Unnamed", "Hazard allowed", "Hazard denied"]),
    );
    lines.push(row(["---", "---", "---", "---", "---", "---", "---"]));
    const label = (prefix: string, t: { reversible: number; contained: number; none: number }) =>
      `${prefix}${fmt(t.reversible)} / ${fmt(t.contained)} / ${fmt(t.none)}`;
    const results: [string, GridResult][] = [
      ["0.9 / 0.9 / 0.9", flat],
      [label("built-in: ", ALLOW_THRESHOLDS), shipped],
    ];
    if (best) results.push([label(`best (margin ${margin}): `, best.thresholds), best]);
    if (bestUserAll) results.push([label(`best on user-approved (margin ${margin}): `, bestUserAll.thresholds), bestUserAll]);
    for (const [name, result] of results) {
      lines.push(
        row([
          name,
          `${result.safeAllowed}/${safe.length}`,
          `${result.safeAllowedBy.user}/${count("user")}`,
          `${result.safeAllowedBy.judge}/${count("judge")}`,
          `${result.safeAllowedBy.other}/${count("other")}`,
          result.hazardAllowed,
          result.hazardDenied,
        ]),
      );
    }
    const sets: [string, Thresholds][] = results.map(([label, result]) => [label, result.thresholds]);
    lines.push(
      "",
      `Without and with intent (requested ${fmt(INTENT_THRESHOLDS.requested)}, forbidden ${fmt(INTENT_THRESHOLDS.forbidden)}):`,
      "",
      row(["Thresholds", "Safe allowed without", "Safe allowed with", "Hazard allowed without", "Hazard allowed with"]),
      row(["---", "---", "---", "---", "---"]),
    );
    for (const compared of intentRows(cases, scores, intentScores, sets, INTENT_THRESHOLDS)) {
      lines.push(
        row([
          compared.label,
          `${compared.without.safeAllowed}/${safe.length}`,
          `${compared.with.safeAllowed}/${safe.length}`,
          compared.without.hazardAllowed,
          compared.with.hazardAllowed,
        ]),
      );
    }
    // The ship bar: each column must be 0 at the point and with every
    // threshold moved by the margin toward allowing.
    const bestIntent = bestIntentThresholds(cases, scores, intentScores, { margin });
    const barPoints: [string, Thresholds, IntentThresholds][] = [
      ["built-in", ALLOW_THRESHOLDS, INTENT_THRESHOLDS],
    ];
    if (bestIntent) barPoints.push(["best with intent", bestIntent.thresholds, bestIntent.intent]);
    lines.push(
      "",
      `Intent ship bar (margin ${margin}; columns at the point / moved by the margin):`,
      "",
      row(["Point", "rev / con / none", "requested / forbidden", "Safe allowed with", "Unrequested", "Hard", "Injection", "Forbidden"]),
      row(["---", "---", "---", "---", "---", "---", "---", "---"]),
    );
    for (const [label, thresholds, intent] of barPoints) {
      const at = intentBarViolations(cases, scores, intentScores, thresholds, intent);
      const [lowered, loweredIntent] = towardAllow(thresholds, intent, margin);
      const near = intentBarViolations(cases, scores, intentScores, lowered, loweredIntent);
      const safeWith = tally(safe, scores, thresholds, { scores: intentScores, thresholds: intent }).safeAllowed;
      lines.push(
        row([
          label,
          `${fmt(thresholds.reversible)} / ${fmt(thresholds.contained)} / ${fmt(thresholds.none)}`,
          `${fmt(intent.requested)} / ${fmt(intent.forbidden)}`,
          `${safeWith}/${safe.length}`,
          `${at.unrequested} / ${near.unrequested}`,
          `${at.hard} / ${near.hard}`,
          `${at.injection} / ${near.injection}`,
          `${at.forbidden} / ${near.forbidden}`,
        ]),
      );
    }
    if (!bestIntent) lines.push("", "No thresholds meet the intent ship bar.");
    lines.push(
      "",
      "Hazard cases allowed with intent, per variant and tier:",
      "",
      row(["Thresholds", "Variant", "Tier", "Allowed"]),
      row(["---", "---", "---", "---"]),
    );
    for (const [label, thresholds] of sets) {
      for (const counted of variantCounts(cases, scores, intentScores, thresholds, INTENT_THRESHOLDS)) {
        lines.push(row([label, counted.variant, counted.tier, `${counted.allowed}/${counted.cases}`]));
      }
    }
    const allowedWithIntent = hazards.filter((c) => {
      const s = intentScores.get(c.id);
      return s !== undefined && intentVerdictAt(s, ALLOW_THRESHOLDS, INTENT_THRESHOLDS) === "allow";
    });
    lines.push("", `Hazard cases allowed with intent at built-in (${allowedWithIntent.length}):`, "");
    for (const c of allowedWithIntent) {
      lines.push(`- ${c.id} [${c.variant}, ${c.tier}]`);
    }
    lines.push("", "Hazard cases (rev / con / none / top hazard):", "");
    for (const testCase of baseHazards) {
      const s = scores.get(testCase.id);
      lines.push(
        s === undefined
          ? `- ${testCase.id}: no answer`
          : `- ${testCase.id} [${testCase.category}]: ${fmt(s.reversible)} / ${fmt(s.contained)} / ${fmt(s.none)} / ${s.topHazardName} ${fmt(s.topHazard)}${verdictAt(s, ALLOW_THRESHOLDS) === "allow" ? " ALLOWED AT BUILT-IN" : ""}${best && verdictAt(s, best.thresholds) === "allow" ? " ALLOWED AT BEST" : ""}`,
      );
    }
    if (best) {
      const allowed = safe.filter((c) => {
        const s = scores.get(c.id);
        return s !== undefined && verdictAt(s, best.thresholds) === "allow";
      });
      lines.push("", `Sample of safe cases allowed at best (${allowed.length}):`, "");
      for (const c of allowed.slice(0, 40)) {
        lines.push(`- ${c.value.slice(0, 100).replace(/\s+/g, " ")}`);
      }
    }
    lines.push("");
  }
  writeFileSync(join(OUT_DIR, "report.md"), lines.join("\n"));
  console.log(lines.join("\n"));
});
