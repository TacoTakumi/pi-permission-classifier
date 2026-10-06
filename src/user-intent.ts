/**
 * The user-text selection: what the operator asked for, as both judges see it.
 *
 * Pure over a session branch (root first, as getBranch returns it). Only the
 * text parts of user-role message entries count. Assistant text, tool results,
 * bash executions, custom messages and compaction or branch summaries never
 * appear. A skill expansion is reduced to "[skill name] args", so the skill
 * body (file content the user did not write) never reaches a model.
 *
 * The selection keeps the first user message (the opening task) plus the
 * newest ones back to MAX_TOTAL_CHARS. Each message is capped at
 * MAX_MESSAGE_CHARS keeping its head and tail, because a long paste or skill
 * body pushes the user's own words to the end. `cut` reports any clip or drop:
 * a cut selection is not the whole picture, so intent cannot clear anything.
 */

import { parseSkillBlock, type SessionEntry } from "@earendil-works/pi-coding-agent";

/** Per-message cap in characters, the cut marker included. */
export const MAX_MESSAGE_CHARS = 4_000;

/** Total cap in characters over all kept messages. */
export const MAX_TOTAL_CHARS = 24_000;

const CUT_MARKER = "\n[...]\n";

/** The selected user text, oldest first. */
export interface UserTextSelection {
  readonly messages: readonly string[];
  /** True when any message was clipped or dropped. */
  readonly cut: boolean;
}

/** The text of a user-role message entry, or null for anything else. */
function userMessageText(entry: SessionEntry): string | null {
  if (entry.type !== "message") return null;
  const { message } = entry;
  if (message.role !== "user") return null;

  const text =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
  if (text === "") return null;

  const skill = parseSkillBlock(text);
  if (skill === null) return text;
  return skill.userMessage === undefined
    ? `[skill ${skill.name}]`
    : `[skill ${skill.name}] ${skill.userMessage}`;
}

/** Clip a message to MAX_MESSAGE_CHARS keeping head and tail. */
function clip(text: string): { text: string; cut: boolean } {
  if (text.length <= MAX_MESSAGE_CHARS) return { text, cut: false };
  const room = MAX_MESSAGE_CHARS - CUT_MARKER.length;
  const head = Math.ceil(room / 2);
  const tail = room - head;
  return {
    text: text.slice(0, head) + CUT_MARKER + text.slice(text.length - tail),
    cut: true,
  };
}

/** Select the user text the judges see from a session branch. */
export function selectUserText(entries: readonly SessionEntry[]): UserTextSelection {
  const all: string[] = [];
  for (const entry of entries) {
    const text = userMessageText(entry);
    if (text !== null) all.push(text);
  }
  if (all.length === 0) return { messages: [], cut: false };

  const first = clip(all[0]);
  let cut = first.cut;
  let total = first.text.length;

  const newest: string[] = [];
  for (let index = all.length - 1; index >= 1; index -= 1) {
    const kept = clip(all[index]);
    if (total + kept.text.length > MAX_TOTAL_CHARS) {
      cut = true;
      break;
    }
    total += kept.text.length;
    cut ||= kept.cut;
    newest.push(kept.text);
  }

  return { messages: [first.text, ...newest.reverse()], cut };
}

/** The user text an ask is judged against, when intent is available. */
export interface UserIntent {
  readonly messages: readonly string[];
}

/** The slice of the session context the intent read needs. */
export interface UserIntentSource {
  readonly sessionManager: { getBranch(): SessionEntry[] };
  readonly hasPendingMessages?: () => boolean;
}

/**
 * The user intent for one ask, or undefined when intent is not available:
 * no session, an ask forwarded from a subagent (the parent's user did not
 * write to the child), a user message still queued (the newest word is not
 * in the branch yet), a selection that cut anything, or no user text. A pi
 * without the pending-message query, or any throw, also gives none, so the
 * judges fall back to their rules without intent.
 */
export function readUserIntent(
  source: UserIntentSource | undefined,
  forwarded: boolean,
): UserIntent | undefined {
  if (source === undefined || forwarded) return undefined;
  try {
    if (typeof source.hasPendingMessages !== "function") return undefined;
    if (source.hasPendingMessages()) return undefined;
    const selection = selectUserText(source.sessionManager.getBranch());
    if (selection.cut || selection.messages.length === 0) return undefined;
    return { messages: selection.messages };
  } catch {
    return undefined;
  }
}
