/**
 * Scrubbing for the judged ask store: the operator's machine details and
 * secret values are replaced by placeholders before a record is written,
 * and the same rules scan the committed file so nothing raw lands in git.
 * Pure: strings in, strings out.
 *
 * Rules, in order: the machine's home directory, git identity flags, other
 * home directories, secret values, email addresses, IPv4 addresses other
 * than loopback and unspecified, the machine's mount prefixes, and last
 * the login name as a whole word. Shell variable references ($VAR, "$VAR") and values
 * already redacted are left as they are.
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
  // Only where a path starts: a segment named home inside a project stays.
  { name: "home-dir", pattern: /(?<![A-Za-z0-9._~\/-])\/(?:home|Users)\/[A-Za-z0-9._-]+/g, replacement: "~" },
  {
    // An environment-style name (TAVILY_API_KEY=), a long flag (--password=)
    // or a query parameter (&security_token=); a bare lowercase key=, as in
    // a Python sort, is left alone.
    name: "secret-value",
    pattern: new RegExp(
      String.raw`(\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)|--[A-Za-z0-9-]*(?:key|token|secret|password|passwd)|[?&][A-Za-z0-9_]*(?:key|token|secret|password|passwd))=${KEPT_VALUE}(?:${WORD})`,
      "g",
    ),
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

/** The machine details a scrub replaces beyond the fixed rules. */
export interface Machine {
  /** The home directory, replaced by `~`. */
  homeDir?: string;
  /** The login name, replaced by `<user>` wherever it stands as a whole word. */
  userName?: string;
  /**
   * Project directory names and their stable aliases (p1, p2, ...). A name
   * is replaced wherever it stands as a whole word: in a path, in a session
   * directory name, in prose. The match ignores case when the name has
   * mixed case, a digit, a dot or a hyphen (OpenHeart, U4R, pi-env), and is
   * exact for a plain word (Fun), so prose keeps its common words.
   */
  projects?: Readonly<Record<string, string>>;
}

/**
 * Whether a project name is matched without regard to case: it has a digit,
 * a dot or a hyphen, or a capital after its first letter (OpenHeart, not Fun).
 */
function looseCase(name: string): boolean {
  return /[0-9.-]/.test(name) || (/[a-z]/.test(name) && /[A-Z]/.test(name.slice(1)));
}

/** The whole-word pattern of a name; longer names are applied first by the caller. */
function wordPattern(name: string, ignoreCase: boolean): RegExp {
  return new RegExp(String.raw`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`, ignoreCase ? "gi" : "g");
}

/**
 * Pure: `text` with the machine's home directory and login name (when
 * given) and every rule's matches replaced by their placeholders.
 */
export function scrubString(text: string, machine: Machine = {}): string {
  let out = text;
  const { homeDir, userName, projects } = machine;
  if (homeDir !== undefined && homeDir !== "" && homeDir !== "/") {
    out = out.replace(new RegExp(escapeRegExp(homeDir.replace(/\/+$/, "")) + "(?![A-Za-z0-9._-])", "g"), "~");
  }
  for (const rule of SCRUB_RULES) {
    out = out.replace(rule.pattern, rule.replacement);
  }
  // Last, so an email or a git flag holding the name is already a placeholder.
  if (userName !== undefined && userName !== "") {
    out = out.replace(wordPattern(userName, false), "<user>");
  }
  if (projects !== undefined) {
    for (const name of Object.keys(projects).sort((a, b) => b.length - a.length)) {
      out = out.replace(wordPattern(name, looseCase(name)), projects[name]!);
    }
  }
  return out;
}

/**
 * Pure: `value` with every string inside it scrubbed, through arrays and
 * plain objects; other values pass through unchanged.
 */
export function scrubDeep<T>(value: T, machine: Machine = {}): T {
  if (typeof value === "string") return scrubString(value, machine) as T;
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, machine)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubDeep(item, machine);
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
