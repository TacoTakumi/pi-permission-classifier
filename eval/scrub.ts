/**
 * Scrubbing for the judged ask store: the operator's machine details and
 * secret values are replaced by placeholders before a record is written,
 * and the same rules scan the committed file so nothing raw lands in git.
 * Pure: strings in, strings out.
 *
 * Rules, in order: git identity flags, home directories, secret values,
 * email addresses, IPv4 addresses other than loopback and unspecified,
 * and the machine's mount prefixes. Shell variable references ($VAR, "$VAR")
 * and values already redacted are left as they are.
 */

/** One scrub rule: what it finds and what it writes instead. */
export interface ScrubRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

/** A quoted or bare shell word, as the value of a flag or an assignment. */
const WORD = String.raw`"[^"]*"|'[^']*'|[^\s;&|"']+`;

/** A value that is a variable reference or already a placeholder. */
const KEPT_VALUE = String.raw`(?!\$|"\$|'\$|<redacted>)`;

/**
 * A git identity value already replaced. A variable reference is not kept
 * here: a default such as ${GIT_AUTHOR_NAME:-name} carries the name.
 */
const KEPT_IDENTITY = String.raw`(?!<user>|<email>)`;

/** The rules on text that holds no home directory; see `scrubString`. */
export const SCRUB_RULES: readonly ScrubRule[] = [
  { name: "git-user-name", pattern: new RegExp(String.raw`user\.name=${KEPT_IDENTITY}(?:${WORD})`, "g"), replacement: "user.name=<user>" },
  {
    name: "git-user-email",
    pattern: new RegExp(String.raw`user\.email=${KEPT_IDENTITY}(?:${WORD})`, "g"),
    replacement: "user.email=<email>",
  },
  { name: "home-dir", pattern: /\/(?:home|Users)\/[A-Za-z0-9._-]+/g, replacement: "~" },
  {
    name: "secret-value",
    pattern: new RegExp(String.raw`\b([A-Za-z0-9_]*(?:key|token|secret|password|passwd))=${KEPT_VALUE}(?:${WORD})`, "gi"),
    replacement: "$1=<redacted>",
  },
  { name: "bearer-token", pattern: /\b(Bearer)\s+(?!\$|<redacted>)[A-Za-z0-9._~+/=-]{8,}/g, replacement: "$1 <redacted>" },
  { name: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, replacement: "<email>" },
  {
    name: "ipv4",
    pattern: /(?<![\d.])(?!127\.|0\.0\.0\.0)(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g,
    replacement: "<ip>",
  },
  { name: "mount", pattern: /\/(?:vol\d+|hosts\/[A-Za-z0-9._-]+)(?=\/|\s|$|["'])/g, replacement: "<mount>" },
];

/** Escape `text` for use inside a RegExp source. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pure: `text` with the machine's home directory (`homeDir`, when given)
 * and every rule's matches replaced by their placeholders.
 */
export function scrubString(text: string, homeDir?: string): string {
  let out = text;
  if (homeDir !== undefined && homeDir !== "" && homeDir !== "/") {
    out = out.replace(new RegExp(escapeRegExp(homeDir.replace(/\/+$/, "")) + "(?![A-Za-z0-9._-])", "g"), "~");
  }
  for (const rule of SCRUB_RULES) {
    out = out.replace(rule.pattern, rule.replacement);
  }
  return out;
}

/**
 * Pure: `value` with every string inside it scrubbed, through arrays and
 * plain objects; other values pass through unchanged.
 */
export function scrubDeep<T>(value: T, homeDir?: string): T {
  if (typeof value === "string") return scrubString(value, homeDir) as T;
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, homeDir)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubDeep(item, homeDir);
    }
    return out as T;
  }
  return value;
}

/** One place in a text where a rule still matches. */
export interface ScrubHit {
  rule: string;
  match: string;
}

/**
 * Pure: every rule match left in `text`, so a scan can report what a scrub
 * would still change. An empty list means the text is clean.
 */
export function findUnscrubbed(text: string): ScrubHit[] {
  const hits: ScrubHit[] = [];
  for (const rule of SCRUB_RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      hits.push({ rule: rule.name, match: match[0] });
    }
  }
  return hits;
}
