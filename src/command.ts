/**
 * The `/permission-model` command: choose the judge model for the permission
 * classifier.
 *
 * Forms:
 *   - `<provider>/<id>`: validate through the model registry, persist the
 *     pair to the global config, reload, and apply live for the next ask.
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
import { type JudgePair, parseJudgePair } from "./judge";

/** The slash command name (`/permission-model`). */
export const COMMAND_NAME = "permission-model";

const USAGE = `/${COMMAND_NAME} <provider>/<id>`;

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
type ArgumentCompletions = ReturnType<
  NonNullable<CommandOptions["getArgumentCompletions"]>
>;

/** The narrow registry projection the command needs. */
export interface CommandRegistryLike {
  find(provider: string, modelId: string): Model<any> | undefined;
  hasConfiguredAuth(model: Model<any>): boolean;
}

/** The slice of pi's command context the handler reads. */
export interface CommandContextLike {
  cwd: string;
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
  function persist(pair: JudgePair, ctx: CommandContextLike): void {
    deps.writeJudge(pair.provider, pair.model);
    const result = deps.reload(ctx.cwd);
    deps.apply(result.config);
    ctx.ui.notify(
      `Permission judge set to ${pair.provider}/${pair.model} (saved to the global config).`,
      "info",
    );
  }

  async function handler(args: string, ctx: CommandContextLike): Promise<void> {
    const text = args.trim();
    const pair = parseJudgePair(text);
    if (!pair) {
      ctx.ui.notify(`Expected a model reference. Usage: ${USAGE}`, "error");
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
    getArgumentCompletions: () => null,
    handler,
  };
}
