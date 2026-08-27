/**
 * The `/permission-model` command: choose the judge model for the permission
 * classifier.
 *
 * Forms:
 *   - `<provider>/<id>`: validate through the model registry, persist the
 *     pair to the global config, reload, and apply live for the next ask.
 *   - `session`: remove the pair from the global config so the session's
 *     active model judges again.
 *   - no argument outside the TUI: print the current judge and the usage
 *     line (pi's `ctx.ui.custom` returns nothing in rpc/json/print modes).
 *
 * Argument completion offers `provider/id` labels from the registry's
 * available models whose label starts with the typed prefix, plus the
 * literal `session` when it matches.
 *
 * Every write form refuses when there is no valid merged config (the link is
 * not registered) or the global config file is absent: nothing is written and
 * the operator gets the setup hint naming the global path. Writes always
 * target the global file; when the project layer sets its own pair the
 * operator is warned that it shadows the choice.
 *
 * Choosing a judge never touches pi's session model or the operator's default
 * model. This module performs no filesystem or network access of its own:
 * persistence and reload go through the injected dependencies, which the
 * extension wires to the config loader. Every failure path leaves the
 * in-memory config as it was, so a bad pick can never widen a verdict.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { LoadConfigResult } from "./config-loader";
import type { ClassifierConfig } from "./config-schema";
import {
  formatJudgeStatus,
  type JudgePair,
  parseJudgePair,
  resolveJudge,
} from "./judge";

/** The slash command name (`/permission-model`). */
export const COMMAND_NAME = "permission-model";

const SESSION_FORM = "session";

const USAGE = `/${COMMAND_NAME} <provider>/<id> | ${SESSION_FORM}`;

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
/** pi's completion result, restricted to the synchronous half this command returns. */
type ArgumentCompletions = Exclude<
  ReturnType<NonNullable<CommandOptions["getArgumentCompletions"]>>,
  Promise<unknown>
>;

/** The narrow registry projection the command needs. */
export interface CommandRegistryLike {
  find(provider: string, modelId: string): Model<any> | undefined;
  hasConfiguredAuth(model: Model<any>): boolean;
  getAvailable(): Model<any>[];
}

/** The slice of pi's command context the handler reads. */
export interface CommandContextLike {
  cwd: string;
  mode: "tui" | "rpc" | "json" | "print";
  model: Model<any> | undefined;
  modelRegistry: CommandRegistryLike;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

/** Seams the extension supplies; none of them are called on a rejected pick. */
export interface CommandDependencies {
  /** The merged config driving the reviewer; `undefined` when not registered. */
  getConfig(): ClassifierConfig | undefined;
  /** The active session-only flag override, if any. */
  getOverride(): JudgePair | undefined;
  /** The session's model registry (captured at `session_start`), for completion. */
  getRegistry(): CommandRegistryLike | undefined;
  /** Whether the global config file exists (the precondition for a write). */
  globalConfigExists(): boolean;
  /** The global config path, for operator hints. */
  globalConfigPath(): string;
  /** The project config path for `cwd`, for the shadow warning. */
  projectConfigPath(cwd: string): string;
  /** Persist the pair to the global config (both `undefined` removes it). */
  writeJudge(provider: string | undefined, model: string | undefined): void;
  /** Reload the merged config from disk after a write. */
  reload(cwd: string): LoadConfigResult;
  /** Replace the live config, drop any flag override, refresh the status. */
  apply(config: ClassifierConfig | undefined): void;
}

/** What `registerCommand` receives, with the handler typed to the slice it reads. */
export interface PermissionModelCommand {
  description: string;
  getArgumentCompletions(prefix: string): ArgumentCompletions;
  handler(args: string, ctx: CommandContextLike): Promise<void>;
}

export function createPermissionModelCommand(
  deps: CommandDependencies,
): PermissionModelCommand {
  /**
   * Whether a write can proceed: the link must be registered (a valid merged
   * config) and the global file must exist. Otherwise notify the setup hint.
   */
  function canWrite(ctx: CommandContextLike): boolean {
    if (deps.getConfig() === undefined || !deps.globalConfigExists()) {
      ctx.ui.notify(
        `The permission classifier is not set up: create ${deps.globalConfigPath()} first, then retry. Nothing changed.`,
        "warning",
      );
      return false;
    }
    return true;
  }

  /** Write the pair (or its removal), reload, apply, and report. */
  function persist(pair: JudgePair | undefined, ctx: CommandContextLike): void {
    try {
      deps.writeJudge(pair?.provider, pair?.model);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `Could not write ${deps.globalConfigPath()}: ${message}. Nothing changed.`,
        "error",
      );
      return;
    }
    const result = deps.reload(ctx.cwd);
    deps.apply(result.config);
    ctx.ui.notify(
      pair
        ? `Permission judge set to ${pair.provider}/${pair.model} (saved to the global config).`
        : "Permission judge follows the session model (provider/model removed from the global config).",
      "info",
    );
    if (result.projectSetsJudge) {
      ctx.ui.notify(
        `${deps.projectConfigPath(ctx.cwd)} sets its own provider/model and shadows this choice in this project.`,
        "warning",
      );
    }
  }

  /** The judge the next ask would use, as the footer shows it. */
  function currentJudgeText(ctx: CommandContextLike): string {
    return formatJudgeStatus(
      resolveJudge(
        deps.getOverride(),
        deps.getConfig(),
        ctx.modelRegistry,
        ctx.model,
      ),
    );
  }

  function printJudge(ctx: CommandContextLike): void {
    ctx.ui.notify(
      `Permission classifier ${currentJudgeText(ctx)}. Usage: ${USAGE}`,
      "info",
    );
  }

  function getArgumentCompletions(prefix: string): ArgumentCompletions {
    const registry = deps.getRegistry();
    if (!registry) {
      return null;
    }
    const wanted = prefix.trim().toLowerCase();
    const labels = [
      ...registry.getAvailable().map((model) => `${model.provider}/${model.id}`),
      SESSION_FORM,
    ];
    const items = labels
      .filter((label) => label.toLowerCase().startsWith(wanted))
      .map((label) => ({ value: label, label }));
    return items.length > 0 ? items : null;
  }

  async function handler(args: string, ctx: CommandContextLike): Promise<void> {
    const text = args.trim();
    if (text === "") {
      printJudge(ctx);
      return;
    }
    if (text === SESSION_FORM) {
      if (canWrite(ctx)) {
        persist(undefined, ctx);
      }
      return;
    }
    const pair = parseJudgePair(text);
    if (!pair) {
      ctx.ui.notify(`Expected a model reference. Usage: ${USAGE}`, "error");
      return;
    }
    if (!canWrite(ctx)) {
      return;
    }
    const model = ctx.modelRegistry.find(pair.provider, pair.model);
    if (!model) {
      ctx.ui.notify(
        `Unknown model ${pair.provider}/${pair.model}: not in the model registry. Nothing changed.`,
        "error",
      );
      return;
    }
    const hasAuth = ctx.modelRegistry.hasConfiguredAuth(model);
    persist(pair, ctx);
    if (!hasAuth) {
      ctx.ui.notify(
        `No auth is configured for ${pair.provider}/${pair.model}; permission asks will defer to the prompt until it is.`,
        "warning",
      );
    }
  }

  return {
    description: "Choose the judge model for the permission classifier",
    getArgumentCompletions,
    handler,
  };
}
