import type { PromptPermissionDetails } from "@gotgenes/pi-permission-system";

import type { TargetContextDeps, TargetStatAnswer } from "#src/target-context";
import { askDetails } from "#test/fixtures/details";

/**
 * Ask fixtures and an in-memory filesystem for the target tests, shared by the
 * extractor's own suite and the judges' suites so a target looks the same in
 * all of them.
 */

/**
 * An ask whose gate resolved a path: `matchValues` and `boundaryValue` arrive
 * on the wire exactly as the permission system emits them, and the gated value
 * is only the tool name.
 */
export function pathAsk(
  matchValues: unknown,
  boundaryValue: unknown,
  surface = "edit",
): PromptPermissionDetails {
  const ask = askDetails(
    { surface, toolName: surface, invokedToolName: surface, value: surface },
    {
      surface,
      value: surface,
      accessIntent: {
        surface,
        matchValues: matchValues as string[],
        boundaryValue: boundaryValue as string | null,
      },
    },
  );

  // The shared fixture's payload kind defaults to `bash`; a path fixture names
  // the kind its gate would report, since that kind is what marks a command.
  return { ...ask, payload: { ...ask.payload, kind: surface === "bash" ? "bash" : "tool" } };
}

/**
 * A bash ask from the plain command gate: the command is its only match value
 * and it has no canonical form (`accessFactsFromValue`,
 * `handlers/gates/helpers.ts:97-102`), so the surface is the bare `bash` this
 * gate reports. This is the bash shape that reaches a judge.
 */
export function bashAsk(command: string): PromptPermissionDetails {
  return askDetails(
    { surface: "bash", toolName: "bash", invokedToolName: null, value: command },
    {
      surface: "bash",
      value: command,
      command,
      accessIntent: { surface: "bash", matchValues: [command], boundaryValue: null },
    },
  );
}

/** Which bash gate reported a path-bearing command, and what it attributed. */
export interface BashPathShape {
  /** `bash` for the path gate, `bash_external_directory` for the other. */
  kind?: "bash" | "bash_external_directory";
  /**
   * The capability surface the gate emits for the attributed effect
   * (`capabilitySurfaceForEffect`, `access-intent/path-surfaces.ts:126-135`).
   */
  effect?: "path_read" | "path_write";
}

/**
 * A bash ask whose path gate picked `worstPath` out of the command. Both path
 * gates build their facts from an `AccessPath`, so the ask carries a canonical
 * form naming that one token (`handlers/gates/bash-path.ts:158`,
 * `handlers/gates/bash-external-directory.ts:144`), and both report the
 * capability surface rather than `bash`.
 *
 * That surface belongs to a family the classifier never judges
 * (`isExcludedSurface`, `src/reviewer.ts:69-76`), so this shape short-circuits
 * before any model call. It is exercised at the extractor, which is where the
 * refusal lives; a judge-level test with it would assert a prompt that can never
 * be rendered.
 */
export function bashPathAsk(
  command: string,
  worstPath: string,
  given: BashPathShape = {},
): PromptPermissionDetails {
  const ask = askDetails(
    { surface: "bash", toolName: "bash", invokedToolName: null, value: command },
    {
      surface: "bash",
      value: command,
      command,
      accessIntent: {
        surface: given.effect ?? "path_write",
        matchValues: [worstPath],
        boundaryValue: worstPath,
      },
    },
  );
  return { ...ask, payload: { ...ask.payload, kind: given.kind ?? "bash" } };
}

/**
 * A path-bearing bash ask escalated from a subagent. The serving node rebuilds
 * the details bag with no command and no tool name
 * (`authority/forwarded-request-server.ts:116-137`), while the child's payload
 * kind, capability surface and canonical token still arrive, so the kind is all
 * that says this is a command.
 */
export function forwardedBashAsk(command: string, worstPath: string): PromptPermissionDetails {
  return {
    ...bashPathAsk(command, worstPath),
    command: undefined,
    toolName: undefined,
    forwarding: { requesterAgentName: "worker", requesterSessionId: "child-session" },
  };
}

/**
 * A forwarded ask that arrived without its payload. The child's canonical path
 * is still in the intent, but nothing on this side says whether the child ran a
 * command or a file action.
 */
export function forwardedAskWithoutPayload(canonical: string): PromptPermissionDetails {
  const ask = pathAsk([canonical], canonical, "edit");
  return {
    ...ask,
    command: undefined,
    toolName: undefined,
    payload: { ...ask.payload, kind: "forwarded" },
    forwarding: { requesterAgentName: "worker", requesterSessionId: "child-session" },
  };
}

/** An `edit` of one file, spelled absolutely and relatively. */
export function editAsk(absolute: string, relative?: string): PromptPermissionDetails {
  return pathAsk(
    relative === undefined ? [absolute] : [absolute, relative],
    absolute,
    "edit",
  );
}

/**
 * The target block's opening line in the LLM prompt, shared so the ordering
 * tests cannot drift from the render without failing.
 */
export const TARGET_BLOCK_HEADER =
  "File the action targets, as the filesystem looked when the gate asked:";

/** What the fake filesystem holds; `throwsFor` answers "cannot tell". */
export interface MemoryWorld {
  files?: string[];
  directories?: string[];
  links?: Record<string, string>;
  cwd?: string;
  temp?: string;
  throwsFor?: string[];
}

/**
 * Target seams answered from memory. Anything absent is `missing`; a path in
 * `throwsFor` answers null, which is how the seam says the filesystem could not
 * say. Defaults name a project and a temporary directory that are not `/tmp`,
 * so a hardcoded `/tmp` anywhere in the code under test fails a test.
 */
export function memoryTargetDeps(given: MemoryWorld = {}): TargetContextDeps {
  const files = new Set(given.files ?? []);
  const directories = new Set(given.directories ?? []);
  const links = given.links ?? {};
  const throwsFor = new Set(given.throwsFor ?? []);
  return {
    getCwd: () => given.cwd ?? "/home/dev/proj",
    getTempDirectory: () => given.temp ?? "/run/user/1000/tmp",
    realpath: (path) => {
      if (throwsFor.has(path)) return null;
      const linked = links[path];
      if (linked !== undefined) return linked;
      return files.has(path) || directories.has(path) ? path : null;
    },
    stat: (path): TargetStatAnswer => {
      if (throwsFor.has(path)) return null;
      if (files.has(path)) return "file";
      if (directories.has(path)) return "directory";
      return "missing";
    },
  };
}
