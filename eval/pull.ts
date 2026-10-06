/**
 * The judged ask store: the pure builders that turn permission review log
 * rows and pi session files into stored asks, scrubbed of the operator's
 * machine details, and the merge that appends them to the store file. The
 * disk layer lives in pull.run.ts; nothing here reads a file.
 *
 * One stored ask per permission_request.waiting row that reached a final
 * event: the ask itself, every classifier.decision on it in log order, how
 * it ended and who decided, and the user text the runtime would have sent
 * with it (none for an ask forwarded from a subagent).
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { readUserIntent } from "../src/user-intent";
import { scrubDeep } from "./scrub";

/** One judge's decision on an ask, as the log's classifier.decision row has it. */
export interface StoredDecision {
  judge: string;
  verdict: string;
  deferReason: string | null;
  modelId: string | null;
  modelCalled: boolean;
  latencyMs: number | null;
  /** The quick judge's answers; absent for the LLM judge. */
  answers?: Record<string, unknown>;
}

/** How an ask ended, by the last word of its final log event. */
export type Resolution = "approved" | "denied" | "session_approved" | "blocked";

/**
 * Who decided an ask, after following forwarded hops: the user, a judge
 * link, a rule, a session approval, or anything the log does not name.
 */
export type DeciderKind = "user" | "judge" | "rule" | "session" | "other";

/** One ask in the store: one JSON line of data/asks.jsonl. */
export interface StoredAsk {
  /** The permission request id. */
  id: string;
  timestamp: string;
  /** The id of the session whose file holds the tool call. */
  sessionId: string;
  surface: string;
  tool: string;
  /** The gated value: the command, target or path the ask was about. */
  value: string;
  cwd: string;
  /** The full bash command, when the tool is bash. */
  fullCommand?: string;
  /** Whether a subagent forwarded the ask to the parent session. */
  forwarded: boolean;
  decisions: StoredDecision[];
  resolution: Resolution;
  decider: DeciderKind;
  /** The authorizer link that decided, when a judge did. */
  deciderName: string | null;
  /** The user text the runtime would have sent; absent when none. */
  userMessages?: string[];
}

/** A tool call as a session file records it. */
export interface SessionToolCall {
  sessionId: string;
  cwd: string;
  name: string;
  command?: string;
  /** The user text the runtime would send at this call; absent when none. */
  userMessages?: string[];
}

/** A parsed session file line, as far as the reader needs it. */
interface SessionLine {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  cwd?: unknown;
  message?: { role?: unknown; content?: unknown };
}

/**
 * Pure: the tool calls in one session file's lines, by tool call id, each
 * with the session id, the cwd and the user text the runtime would send at
 * that call. Entries form a tree through parentId (an entry without one
 * follows the line before it), so each call reads only the user messages
 * on its own branch.
 */
export function toolCallsFromSession(lines: Iterable<string>): Map<string, SessionToolCall> {
  const calls = new Map<string, SessionToolCall>();
  let sessionId = "";
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
      if (sessionId === "") sessionId = typeof entry.id === "string" ? entry.id : "";
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
        sessionId,
        cwd,
        name: typeof part.name === "string" ? part.name : "",
        command: typeof args?.command === "string" ? args.command : undefined,
        ...(paired === undefined ? {} : { userMessages: paired }),
      });
    }
  }
  return calls;
}

/** The final events of a permission request, by their last word. */
const FINAL_EVENTS: Record<string, Resolution> = {
  "permission_request.approved": "approved",
  "permission_request.denied": "denied",
  "permission_request.session_approved": "session_approved",
  "permission_request.blocked": "blocked",
};

/** Forwarded hops followed before a decider counts as other. */
const MAX_FORWARD_DEPTH = 8;

type DecidedBy = { kind?: unknown; name?: unknown; decision?: unknown } | null | undefined;

/**
 * Who decided a request, from its final log row. A forwarded decision was
 * made in the parent session, so its nested decision is followed through
 * every hop, as pi-permission-system's effectiveDecider does.
 */
function deciderOf(row: Record<string, unknown>): { kind: DeciderKind; name: string | null } {
  let decidedBy = row.decidedBy as DecidedBy;
  for (let hop = 0; hop < MAX_FORWARD_DEPTH && decidedBy?.kind === "forwarded"; hop++) {
    decidedBy = decidedBy.decision as DecidedBy;
  }
  const name = typeof decidedBy?.name === "string" ? decidedBy.name : null;
  switch (decidedBy?.kind) {
    case "user":
      return { kind: "user", name };
    case "authorizer":
      return { kind: "judge", name };
    case "rule":
      return { kind: "rule", name };
    case "session_approval":
      return { kind: "session", name };
    default:
      return { kind: "other", name };
  }
}

/** The classifier.decision row's fields the store keeps. */
function decisionOf(row: Record<string, unknown>): StoredDecision {
  const decision: StoredDecision = {
    judge: typeof row.judge === "string" ? row.judge : "llm",
    verdict: typeof row.verdict === "string" ? row.verdict : "defer",
    deferReason: typeof row.deferReason === "string" ? row.deferReason : null,
    modelId: typeof row.modelId === "string" ? row.modelId : null,
    modelCalled: row.modelCalled === true,
    latencyMs: typeof row.latencyMs === "number" ? row.latencyMs : null,
  };
  if (row.answers !== null && typeof row.answers === "object") {
    decision.answers = row.answers as Record<string, unknown>;
  }
  return decision;
}

/**
 * Pure: the stored asks from parsed review log rows and a tool call index,
 * in log order. A waiting row becomes a stored ask once its request has a
 * final event and its tool call is in the index; a request still waiting
 * is left for a later pull. Every string is scrubbed with `homeDir` as the
 * machine's home directory.
 */
export function storedAsksFromLog(
  rows: readonly Record<string, unknown>[],
  toolCalls: ReadonlyMap<string, SessionToolCall>,
  homeDir: string,
): StoredAsk[] {
  const final = new Map<string, Record<string, unknown>>();
  const decisions = new Map<string, StoredDecision[]>();
  for (const row of rows) {
    const requestId = row.requestId;
    if (typeof requestId !== "string" || typeof row.event !== "string") continue;
    if (row.event in FINAL_EVENTS) {
      final.set(requestId, row);
    } else if (row.event === "classifier.decision") {
      const list = decisions.get(requestId) ?? [];
      list.push(decisionOf(row));
      decisions.set(requestId, list);
    }
  }
  const asks: StoredAsk[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.event !== "permission_request.waiting") continue;
    const requestId = row.requestId;
    const toolCallId = row.toolCallId;
    if (typeof requestId !== "string" || typeof toolCallId !== "string" || seen.has(requestId)) continue;
    const outcome = final.get(requestId);
    if (outcome === undefined) continue;
    const call = toolCalls.get(toolCallId);
    if (call === undefined) continue;
    const value = [row.command, row.target, row.path].find(
      (candidate): candidate is string => typeof candidate === "string" && candidate !== "",
    );
    if (value === undefined) continue;
    seen.add(requestId);
    const tool = typeof row.toolName === "string" ? row.toolName : call.name;
    const forwarded = row.forwarded === true;
    const decider = deciderOf(outcome);
    const ask: StoredAsk = {
      id: requestId,
      timestamp: typeof row.timestamp === "string" ? row.timestamp : "",
      sessionId: call.sessionId,
      surface: typeof row.surface === "string" ? row.surface : "",
      tool,
      value,
      cwd: call.cwd,
      ...(tool === "bash" && call.command !== undefined ? { fullCommand: call.command } : {}),
      forwarded,
      decisions: decisions.get(requestId) ?? [],
      resolution: FINAL_EVENTS[outcome.event as string]!,
      decider: decider.kind,
      deciderName: decider.name,
      ...(call.userMessages === undefined || forwarded ? {} : { userMessages: call.userMessages }),
    };
    asks.push(scrubDeep(ask, homeDir));
  }
  return asks;
}

/** The ids already in the store, from its lines; a line that is not JSON is skipped. */
export function storedIds(lines: Iterable<string>): Set<string> {
  const ids = new Set<string>();
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      const id = (JSON.parse(line) as { id?: unknown }).id;
      if (typeof id === "string") ids.add(id);
    } catch {
      continue;
    }
  }
  return ids;
}

/**
 * Pure: the lines to append to the store, one JSON line per ask whose id
 * is not yet in `existingLines`, in the asks' order. Existing lines are
 * never rewritten: the caller appends what this returns.
 */
export function mergeStore(existingLines: readonly string[], asks: readonly StoredAsk[]): string[] {
  const ids = storedIds(existingLines);
  const lines: string[] = [];
  for (const ask of asks) {
    if (ids.has(ask.id)) continue;
    ids.add(ask.id);
    lines.push(JSON.stringify(ask));
  }
  return lines;
}
