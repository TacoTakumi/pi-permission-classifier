/**
 * `npm run data:pull`: read the permission review log and the pi session
 * files, build the scrubbed stored asks, and append the ones not yet in
 * data/asks.jsonl. Runs under vitest (the pull config) so the TypeScript
 * resolves without a build step; it is not part of `npm test`.
 *
 * The only disk reads of the raw sources live here. The store file and
 * the gitignored project alias table are the only writes.
 */

import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import { it } from "vitest";

import {
  assignProjectAliases,
  mergeStore,
  projectNames,
  rawAsksFromLog,
  scrubAsks,
  seedProjectNames,
  type SessionToolCall,
  splitProjectAliases,
  toolCallsFromSession,
} from "./pull";

const AGENT_DIR = join(homedir(), ".pi", "agent");
const LOG_PATH = join(AGENT_DIR, "extensions", "pi-permission-system", "logs", "pi-permission-system-permission-review.jsonl");
const SESSIONS_DIR = join(AGENT_DIR, "sessions");
const STORE_PATH = join(import.meta.dirname, "..", "data", "asks.jsonl");
/** The projects root: its directory names get stable aliases (see seedProjectNames). */
const PROJECTS_ROOT = join(homedir(), "AI", "Projects");
/** The alias table, gitignored: it holds the real project names. */
const ALIASES_PATH = join(import.meta.dirname, "..", "data", "project-aliases.json");

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

it("pulls the judged asks into the store", { timeout: 0 }, async () => {
  const rows = readFileSync(LOG_PATH, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const toolCalls = new Map<string, SessionToolCall>();
  for (const file of sessionFiles(SESSIONS_DIR)) {
    for (const [id, call] of toolCallsFromSession(await readLines(file))) {
      toolCalls.set(id, call);
    }
  }
  const raw = rawAsksFromLog(rows, toolCalls);
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  const directories = existsSync(PROJECTS_ROOT)
    ? readdirSync(PROJECTS_ROOT).filter((name) => statSync(join(PROJECTS_ROOT, name)).isDirectory())
    : [];
  const seen = projectNames(raw, PROJECTS_ROOT, homedir());
  const aliases = assignProjectAliases(
    existsSync(ALIASES_PATH) ? (JSON.parse(readFileSync(ALIASES_PATH, "utf-8")) as Record<string, string>) : {},
    [...seen, ...seedProjectNames(directories)],
  );
  writeFileSync(ALIASES_PATH, `${JSON.stringify(aliases, null, 2)}\n`);
  const asks = scrubAsks(raw, { homeDir: homedir(), userName: userInfo().username, ...splitProjectAliases(aliases, seen) });
  const existing = existsSync(STORE_PATH) ? readFileSync(STORE_PATH, "utf-8").split("\n") : [];
  const lines = mergeStore(existing, asks);
  if (lines.length > 0) appendFileSync(STORE_PATH, lines.map((line) => `${line}\n`).join(""));
  console.log(`${asks.length} asks in the sources, ${lines.length} appended to ${STORE_PATH}`);
});
