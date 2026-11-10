/**
 * The target read: the one place the classifier works out which file an ask
 * targets.
 *
 * A path-bearing tool gate (read, write, edit, and any third-party tool the
 * engine treats the same way) fixes the file into the ask's access intent:
 * `matchValues` carries the absolute lexical spelling first and the other
 * spellings after it, and `boundaryValue` carries the symlink-resolved
 * spelling. Two kinds of ask are refused. A bash command has no single target:
 * its path gates do emit a canonical form
 * (permission system `handlers/gates/bash-path.ts`,
 * `handlers/gates/bash-external-directory.ts`), but it names the one most
 * restrictive token of a command that may touch many files, so a command is
 * refused by what marks it as one: the `command` field a local bash ask carries,
 * or the bash payload kind, which is what survives when a subagent escalates its
 * ask upward (`authority/forwarded-request-server.ts` builds forwarded details
 * with no command field, and the payload kind rides through
 * `presentation/forwarded-ask-payload.ts`). An MCP target, a skill name and a
 * plain tool have no canonical form at all and leave `boundaryValue` null
 * (`handlers/gates/helpers.ts`). Neither refusal guesses from spelling.
 *
 * This module turns those strings into the facts a judge can use: the target
 * path, where it resolves, whether the file and its directory exist, and
 * whether it sits inside the session's project directory or the temporary
 * directory. The file and its directory are resolved separately because a
 * create has no file to resolve yet, and the directory is what says the ask is
 * a create in a real place rather than a path to nowhere.
 *
 * Nothing here reads file contents, and nothing here throws: the link runs
 * inside the permission system's own call stack, where a raise costs the whole
 * prompt. A filesystem question that fails leaves the fact out, and a target
 * that cannot be recognized leaves no target block behind. The
 * filesystem, the temporary directory and the session directory arrive through
 * {@link TargetContextDeps}, so tests answer them without a disk.
 */

import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, sep } from "node:path";
import { tmpdir } from "node:os";

import type { PromptPermissionDetails } from "@gotgenes/pi-permission-system";

/** What an inspection of the target found. */
export type TargetState =
  /** The target is an existing file. */
  | "file"
  /** The target is an existing directory. */
  | "directory"
  /** The target does not exist and its directory does: an ordinary create. */
  | "missing"
  /** Neither the target nor its directory exists. */
  | "missing-parent"
  /** The filesystem could not say (a failed or unsupported stat). */
  | "unknown";

/** Where the target sits, relative to the places the rubric names. */
export type TargetLocation =
  /** Inside the session's project directory. */
  | "project"
  /** Inside the operating system's temporary directory. */
  | "temp"
  /** Inside neither. */
  | "outside"
  /** Not determinable, because the target could not be inspected. */
  | "unknown";

/** Why the read produced no target. */
export type TargetOmission =
  /** The ask carried no access intent at all. */
  | "no-access-intent"
  /** The ask is a bash command, which targets no single file. */
  | "multi-path-command"
  /**
   * A forwarded ask that arrived with no payload, so nothing says whether the
   * child ran a command or a file action. Its intent can still carry a
   * canonical path, and naming one token as the target would claim more than
   * this side knows.
   */
  | "undetermined-action"
  /** `boundaryValue` is null or empty: an MCP, skill or plain-tool ask. */
  | "no-canonical-path"
  /** The spelling is not absolute, or carries a control character. */
  | "unusable-path"
  /** The block's path text exceeds {@link MAX_TARGET_BYTES}, so all of it is out. */
  | "over-size-cap"
  /** A seam threw; the ask proceeds with no target rather than failing. */
  | "extraction-failed";

/**
 * The path text one target block may render, in UTF-8 bytes: the budget is the
 * sum of the spellings, not a limit on any one of them. A block over it goes
 * out whole, because a path with no state or placement line says nothing, and
 * half a path can read like a different file.
 *
 * This cap is separate from `contextBudgetBytes`, which bounds the extracted
 * full-command context (src/context.ts:42). That text appears only for a bash
 * ask and this one never does, so they cannot both be in one ask. Each text
 * source keeps its own cap, as the guidance files do with theirs.
 */
export const MAX_TARGET_BYTES = 512;

/** The facts about the file one ask targets. */
export interface TargetContext {
  /** The absolute spelling the gate matched on, symlinks unfollowed. */
  readonly path: string;
  /**
   * The symlink-resolved spelling the outside-project decision uses, when it
   * differs from {@link path}. The gate supplies it, so nothing here resolves
   * a path a second time.
   */
  readonly resolved: string | null;
  /**
   * A spelling relative to the working directory, when the gate carried one.
   * The gate synthesizes such a spelling for every path inside the project, so
   * this is an alternate way to write the same file rather than a report of what
   * the model typed.
   */
  readonly relativeSpelling: string | null;
  /** The containing directory, in the same lexical form as {@link path}. */
  readonly directory: string;
  /** What exists at the target, judged on the resolved spelling. */
  readonly state: TargetState;
  /** Which named place the target falls in. */
  readonly location: TargetLocation;
}

/** The read's outcome: the facts, or the reason there are none. */
export type TargetReading =
  | { readonly included: true; readonly target: TargetContext }
  | { readonly included: false; readonly reason: TargetOmission };

/** What the {@link TargetContextDeps.stat} seam answers; null means cannot tell. */
export type TargetStatAnswer = "file" | "directory" | "missing" | null;

/** The seams this module reads, injected so tests answer them in memory. */
export interface TargetContextDeps {
  /** The session's working directory, the project boundary. */
  readonly getCwd: () => string;
  /** The operating system's temporary directory, never a hardcoded `/tmp`. */
  readonly getTempDirectory: () => string;
  /** Symlink-resolved absolute form, or null when it cannot be resolved. */
  readonly realpath: (path: string) => string | null;
  /** What is at `path`; null when the filesystem cannot say. */
  readonly stat: (path: string) => TargetStatAnswer;
}

/**
 * Read the target of one ask.
 *
 * Recognition is the gate's own work: a path-bearing gate hands over a
 * canonical spelling and every other gate hands over null, so nothing here
 * guesses at whether a value is a path. The canonical form is absolute for
 * every tool ask the engine resolves, including a create whose file does not
 * exist yet and a relative spelling that escapes the project with `..`.
 */
export function extractTargetContext(
  details: PromptPermissionDetails,
  deps: TargetContextDeps,
): TargetReading {
  try {
    return readTarget(details, deps);
  } catch {
    // An injected seam rejected instead of returning null, or a details bag
    // shaped unlike the wire contract. Absence is the only safe answer.
    return { included: false, reason: "extraction-failed" };
  }
}

/** The read itself, with the seams already trusted to answer or return null. */
function readTarget(
  details: PromptPermissionDetails,
  deps: TargetContextDeps,
): TargetReading {
  const intent = details?.accessIntent;
  if (typeof intent !== "object" || intent === null) {
    return { included: false, reason: "no-access-intent" };
  }

  // A command is refused before its canonical value is read. The bash path
  // gates emit one for the single most restrictive token, but the command is
  // already in the prompt in full, and naming one of its paths as the target
  // would misstate an action that may touch many files. A local bash ask carries
  // the command itself; a forwarded one carries neither the command nor a tool
  // name, only its payload kind, which is the signal src/context.ts:42 reads.
  const kind = details.payload?.kind;
  if (isBashPayload(kind) || (typeof details.command === "string" && details.command !== "")) {
    return { included: false, reason: "multi-path-command" };
  }
  // A forwarded ask that reached this node without its payload says nothing
  // about what the child was doing, even when its intent carries a canonical
  // path, so no target is claimed for it.
  if (kind === "forwarded") {
    return { included: false, reason: "undetermined-action" };
  }

  const canonical = intent.boundaryValue;
  if (typeof canonical !== "string" || canonical === "") {
    return { included: false, reason: "no-canonical-path" };
  }
  if (!isAbsolute(canonical) || hasUnrenderableCharacter(canonical)) {
    return { included: false, reason: "unusable-path" };
  }

  const lexical = firstAbsolute(intent.matchValues) ?? canonical;
  // Every spelling the block renders is screened, not only the one the gate
  // decided with: under a symlink the resolved form can be clean while the
  // lexical form still carries a character that renders as a different path.
  if (lexical !== canonical && hasUnrenderableCharacter(lexical)) {
    return { included: false, reason: "unusable-path" };
  }
  // The block renders the lexical form, the resolved form when a symlink leads
  // somewhere else, and a working-directory spelling when the gate carried one.
  // They are sized
  // together, and before the filesystem is read, so an oversized block costs no
  // stat.
  const relative = relativeSpellingOf(intent.matchValues, lexical);
  const spellings = canonical === lexical ? [lexical] : [lexical, canonical];
  if (relative !== null) spellings.push(relative);
  if (pathTextBytes(spellings) > MAX_TARGET_BYTES) {
    return { included: false, reason: "over-size-cap" };
  }

  const state = stateOf(canonical, dirname(canonical), deps);
  return {
    included: true,
    target: {
      path: lexical,
      resolved: canonical === lexical ? null : canonical,
      relativeSpelling: relative,
      directory: dirname(lexical),
      state,
      location:
        state === "unknown"
          ? "unknown"
          : locationOf(canonical, dirname(canonical), state, deps),
    },
  };
}

/**
 * Whether a payload kind describes a shell command. Both bash gates carry a
 * canonical path for one token: the plain one reports kind `bash`, the
 * outside-project one reports `bash_external_directory`.
 */
function isBashPayload(kind: unknown): boolean {
  return kind === "bash" || kind === "bash_external_directory";
}

/** The UTF-8 size of the path text a block would render. */
function pathTextBytes(spellings: readonly string[]): number {
  return spellings.reduce((total, one) => total + Buffer.byteLength(one, "utf8"), 0);
}

/** The first absolute spelling the gate carried, or null. */
function firstAbsolute(matchValues: unknown): string | null {
  if (!Array.isArray(matchValues)) return null;
  for (const candidate of matchValues) {
    if (typeof candidate === "string" && candidate !== "" && isAbsolute(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** What exists at the target, with the directory consulted only for an absent file. */
function stateOf(path: string, directory: string, deps: TargetContextDeps): TargetState {
  const found = deps.stat(path);
  if (found === "file" || found === "directory") return found;
  if (found === null) return "unknown";
  const parent = deps.stat(directory);
  if (parent === "directory") return "missing";
  if (parent === "missing") return "missing-parent";
  return "unknown";
}

/**
 * A spelling relative to the working directory, when the gate carried one. The
 * gate emits `[absolute, cwd-relative?, as-typed]`, and it synthesizes the
 * cwd-relative form for any path inside the project, so the last non-absolute
 * entry is the as-typed spelling when there was one and the synthesized alias
 * otherwise. Both are true alternate spellings of the same file, which is all
 * that is worth saying about it.
 */
function relativeSpellingOf(matchValues: unknown, lexical: string): string | null {
  if (!Array.isArray(matchValues)) return null;
  let found: string | null = null;
  for (const candidate of matchValues) {
    if (typeof candidate !== "string" || candidate === "") continue;
    if (candidate === lexical || isAbsolute(candidate)) continue;
    if (hasUnrenderableCharacter(candidate)) continue;
    found = candidate;
  }
  return found;
}

/**
 * Which named place the target falls in. An existing file is placed by its own
 * resolved path; an absent one by the nearest directory above it, which is the
 * place the write would land in.
 */
function locationOf(
  path: string,
  directory: string,
  state: TargetState,
  deps: TargetContextDeps,
): TargetLocation {
  const probe =
    state === "file" || state === "directory"
      ? (deps.realpath(path) ?? path)
      : (deps.realpath(directory) ?? directory);
  // Both directories are read through the guarded helper: a host that cannot
  // say where its session is loses the placement line, not the path.
  const cwd = readDirectory(deps.getCwd);
  if (cwd === null) return "unknown";
  if (contains(deps.realpath(cwd) ?? cwd, probe)) return "project";
  const temp = readDirectory(deps.getTempDirectory);
  if (temp !== null && contains(deps.realpath(temp) ?? temp, probe)) return "temp";
  return "outside";
}

/** Whether `inner` is `outer` or sits below it. */
function contains(outer: string, inner: string): boolean {
  const base = outer === "/" ? "/" : trimTrailingSeparator(outer);
  const [a, b] = caseFold(base, inner);
  if (b === a) return true;
  return b.startsWith(a.endsWith(sep) ? a : a + sep);
}

/** Compare case-insensitively where the platform does. */
function caseFold(left: string, right: string): [string, string] {
  return process.platform === "win32" ? [left.toLowerCase(), right.toLowerCase()] : [left, right];
}

/** Drop trailing separators, leaving the filesystem root itself intact. */
function trimTrailingSeparator(path: string): string {
  let end = path.length;
  while (end > 1 && (path[end - 1] === sep || path[end - 1] === "/")) end -= 1;
  return path.slice(0, end);
}

/**
 * Whether a path carries a character that cannot be shown as the plain line it
 * will be rendered into. Besides the control characters and DEL, that means the
 * bidi overrides and isolates, the zero-width characters and word joiners, and
 * the byte-order mark: each can make a path display as a different path from the
 * one being judged, in the prompt and in the log alike.
 */
function hasUnrenderableCharacter(path: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/.test(
    path,
  );
}

/**
 * The seams to read with: the caller's when it brought its own (tests), the
 * real ones otherwise. A host that gives no session directory leaves
 * {@link TargetContext.location} unknown; the process working directory is not
 * a substitute, because the session directory can move out from under it.
 */
export function resolveTargetDeps(
  seams: TargetContextDeps | undefined,
  getCwd: (() => string) | undefined,
): TargetContextDeps {
  return seams ?? defaultTargetContextDeps(getCwd ?? (() => ""));
}

/**
 * The session directory to name in a prompt, or null. A seam that throws or
 * answers empty gives null: the prompt loses a line rather than the ask.
 */
export function sessionCwdOf(deps: TargetContextDeps): string | null {
  return readDirectory(deps.getCwd);
}

/** The temporary directory to name in a prompt, or null. */
export function tempDirectoryOf(deps: TargetContextDeps): string | null {
  return readDirectory(deps.getTempDirectory);
}

/** Read one directory seam, answering null for a throw or an empty string. */
function readDirectory(read: () => string): string | null {
  try {
    const value = read();
    return typeof value === "string" && value !== "" ? value : null;
  } catch {
    return null;
  }
}

/**
 * The production seams: the real filesystem, the real temporary directory, and
 * a failure answered by null instead of a throw.
 */
export function defaultTargetContextDeps(getCwd: () => string): TargetContextDeps {
  // Every placement check resolves the session directory and the temporary
  // directory, and neither moves within a session in a way the rubric cares
  // about, so each is resolved once. A target path is still resolved per ask:
  // a file or a link can be replaced between two asks.
  let realCwd: string | null | undefined;
  let realTemp: string | null | undefined;
  const tempDirectory = () => tmpdir();

  return {
    getCwd,
    getTempDirectory: tempDirectory,
    realpath: (path) => {
      if (path === readDirectory(getCwd)) {
        realCwd ??= tryRealpath(path);
        return realCwd;
      }
      if (path === tempDirectory()) {
        realTemp ??= tryRealpath(path);
        return realTemp;
      }
      return tryRealpath(path);
    },
    stat: (path) => {
      try {
        const info = statSync(path);
        return info.isFile() ? "file" : info.isDirectory() ? "directory" : null;
      } catch (error) {
        return isMissing(error) ? "missing" : null;
      }
    },
  };
}

/** Resolve a path's symlinks, answering null when the filesystem cannot. */
function tryRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** A stat failure that means "nothing is here" rather than "cannot tell". */
function isMissing(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}


