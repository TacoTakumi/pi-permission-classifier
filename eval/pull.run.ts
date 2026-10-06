/**
 * `npm run data:pull`: read the permission review log and the pi session
 * files, build the scrubbed stored asks, and append the ones not yet in
 * data/asks.jsonl. Runs under vitest (the pull config) so the TypeScript
 * resolves without a build step; it is not part of `npm test`.
 *
 * The only disk reads of the raw sources live here. The store file is the
 * only write.
 */

import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import { it } from "vitest";

import { mergeStore, type SessionToolCall, storedAsksFromLog, toolCallsFromSession } from "./pull";

const AGENT_DIR = join(homedir(), ".pi", "agent");
const LOG_PATH = join(AGENT_DIR, "extensions", "pi-permission-system", "logs", "pi-permission-system-permission-review.jsonl");
const SESSIONS_DIR = join(AGENT_DIR, "sessions");
const STORE_PATH = join(import.meta.dirname, "..", "data", "asks.jsonl");

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
  const asks = storedAsksFromLog(rows, toolCalls, { homeDir: homedir(), userName: userInfo().username });
  const existing = existsSync(STORE_PATH) ? readFileSync(STORE_PATH, "utf-8").split("\n") : [];
  const lines = mergeStore(existing, asks);
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  if (lines.length > 0) appendFileSync(STORE_PATH, lines.map((line) => `${line}\n`).join(""));
  console.log(`${asks.length} asks in the sources, ${lines.length} appended to ${STORE_PATH}`);
});
