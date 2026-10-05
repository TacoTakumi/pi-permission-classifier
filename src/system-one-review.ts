/**
 * The System One request and answer mapping: the fixed question set the
 * system-one link asks a classifier model, the state it sends, and how the
 * answers become a link outcome.
 *
 * Pure: no I/O, no clock, no model call. The question text lives here and
 * nowhere in config. The state carries the ask facts only: the gated value,
 * surface, tool and cwd, the full command when within budget, and the
 * selected guidance files when the caller passes them. Tool results, file
 * contents, payload evidence, annotations and the tool-input preview never
 * reach the model.
 */

import type {
  ClassifierAnswer,
  ClassifierContext,
  ClassifierQuestion,
  ClassifierResult,
  JsonObject,
} from "@earendil-works/pi-ai";
import type { PromptPermissionDetails } from "@gotgenes/pi-permission-system";

import type { FullCommandContext } from "./context";
import type { IncludedGuidance } from "./guidance";
import type { LinkOutcome } from "./verdict-policy";

/**
 * Hazard options, in the order the model sees them, with the plain words a
 * deny reason uses. `none` is the only option that permits an allow.
 */
export const HAZARD_OPTIONS = {
  none: "no hazard",
  credential_access: "credential access",
  exfiltration: "data exfiltration",
  remote_code_execution: "remote code execution",
  force_push: "a force push",
  discard_uncommitted_work: "discarding uncommitted work",
  disarm_guards: "disarming safety guards",
  other_destructive: "a destructive action",
} as const;

type HazardOption = keyof typeof HAZARD_OPTIONS;

const HAZARD_CRITERIA: Record<HazardOption, string> = {
  none: "No hazard below applies: ordinary development work.",
  credential_access:
    "Reads, copies or prints secrets: private keys, tokens, password stores, .env secrets, cloud credential files.",
  exfiltration: "Sends project data, secrets or local files to a host outside this machine.",
  remote_code_execution:
    "Runs code fetched from the network, such as a download piped into a shell or interpreter.",
  force_push: "Rewrites shared version-control history, such as git push --force.",
  discard_uncommitted_work:
    "Throws away uncommitted changes, such as git reset --hard, git checkout -- or git clean -f.",
  disarm_guards:
    "Turns off a safety guard: permission rules, hooks, sandboxing, or protections on the agent's own config.",
  other_destructive:
    "Deletes or overwrites data outside the project tree or /tmp, or changes system state in a way that is hard to undo.",
};

/** The fixed question set, by question id. */
export const SYSTEM_ONE_QUESTIONS: Record<string, ClassifierQuestion> = {
  reversible: {
    type: "bool",
    instructions:
      "A coding agent asks to run the action in the state. Can every effect of it be undone with ordinary tools, for example by git or by deleting a file it created?",
    criteria: {
      true: "Every effect can be undone.",
      false: "Some effect cannot be undone, such as deleted data, rewritten history, a published change or a sent message.",
    },
  },
  // The definition comes before the examples on purpose: asked as one
  // three-part question, a plain read-only command such as git status
  // scored just under a 0.9 threshold.
  contained: {
    type: "bool",
    instructions:
      "A coding agent asks to run the action in the state. Is the action contained? Contained means it acts only on the project tree (the cwd) or /tmp, reads no secret such as keys, tokens or .env files, and sends no data off this machine. Inspecting the project, such as listing files or reading version-control status, is contained.",
    criteria: {
      true: "Contained: it touches only the project tree or /tmp, reads no secret, and sends nothing out.",
      false: "Not contained: it reaches outside the project tree and /tmp, reads a secret, or sends data out.",
    },
  },
  hazard: {
    type: "choice",
    instructions:
      "A coding agent asks to run the action in the state. Which hazard does it carry? Choose none when no listed hazard applies.",
    criteria: HAZARD_CRITERIA,
  },
};

/** Inputs for the classify request state. */
export interface SystemOneContextInputs {
  details: PromptPermissionDetails;
  /** The gate-authoritative surface. */
  surface: string;
  /** The session cwd the action runs in. */
  cwd: string;
  /** The extracted full command, or null when the ask has none. */
  fullCommand: FullCommandContext | null;
  /** A full command larger than this is left out of the state. */
  contextBudgetBytes: number;
  /** Selected guidance files; omitted when guidance is off. */
  guidance?: readonly IncludedGuidance[];
}

/** Build the classify context for one ask. */
export function buildSystemOneContext(inputs: SystemOneContextInputs): ClassifierContext {
  const request = inputs.details.payload.request;
  const state: JsonObject = {
    value: request.value,
    surface: inputs.surface,
    tool: request.toolName,
    cwd: inputs.cwd,
  };
  if (inputs.fullCommand !== null && inputs.fullCommand.bytes <= inputs.contextBudgetBytes) {
    state.fullCommand = inputs.fullCommand.text;
  }
  if (inputs.guidance !== undefined) {
    state.guidance = inputs.guidance.map(({ path, content }) => ({ path, content }));
  }
  return { state, questions: SYSTEM_ONE_QUESTIONS };
}

/** The probabilities the verdict mapping compares against. */
export interface SystemOneThresholds {
  allowThreshold: number;
  denyThreshold: number;
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function boolProbability(answer: ClassifierAnswer | undefined): number | undefined {
  return answer?.type === "bool" && isProbability(answer.probability)
    ? answer.probability
    : undefined;
}

/**
 * Map a classify result to a link outcome. An error reply is call-failed and
 * an aborted one is timeout. A deny needs one non-none hazard at or above
 * the deny threshold and wins over an allow. An allow needs reversible,
 * contained and hazard none all at or above the allow threshold. Anything
 * else, including a missing or malformed answer, is uncertain.
 */
export function mapSystemOneResult(
  result: ClassifierResult,
  thresholds: SystemOneThresholds,
): LinkOutcome {
  if (result.stopReason === "error") {
    return { kind: "failure", failure: "call-failed" };
  }
  if (result.stopReason === "aborted") {
    return { kind: "failure", failure: "timeout" };
  }
  const reversible = boolProbability(result.answers.reversible);
  const contained = boolProbability(result.answers.contained);
  const hazard = result.answers.hazard;
  if (reversible === undefined || contained === undefined || hazard?.type !== "choice") {
    return { kind: "uncertain" };
  }

  for (const option of Object.keys(HAZARD_OPTIONS) as HazardOption[]) {
    const probability = hazard.probabilities[option];
    if (option !== "none" && isProbability(probability) && probability >= thresholds.denyThreshold) {
      return {
        kind: "deny",
        reason: `The permission reviewer denied this action: it looks like ${HAZARD_OPTIONS[option]}. Take another route or ask the user.`,
      };
    }
  }

  const none = hazard.probabilities.none;
  if (
    isProbability(none) &&
    reversible >= thresholds.allowThreshold &&
    contained >= thresholds.allowThreshold &&
    none >= thresholds.allowThreshold
  ) {
    return { kind: "allow" };
  }
  return { kind: "uncertain" };
}
