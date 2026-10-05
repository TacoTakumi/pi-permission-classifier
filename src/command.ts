/**
 * The `/permission-model` command: choose who judges permission asks (the
 * mode) and each judge's model.
 *
 * Forms:
 *   - `mode <llm|quick|quick-then-llm>`: persist the mode. A mode that runs
 *     the quick judge is refused while the global config file sets no quick
 *     judge model; one from the launch flag or a project config does not
 *     count.
 *   - `llm <provider>/<id>`: validate through the chat model registry,
 *     persist the LLM judge pair, reload, and apply live for the next ask.
 *     A classifier model is refused.
 *   - `llm chat-model`: remove the LLM judge pair so the LLM judge follows
 *     the session's chat model.
 *   - `quick <provider>/<id>`: validate through the classifier lookup only
 *     and persist the quick judge pair. A chat model is refused.
 *   - `verdicts <allow-deny-defer|allow-defer|allow-deny>` and
 *     `on-error <defer|deny>`: persist the policy of the last judge in line
 *     for the live mode (launch flag included): the LLM judge's top-level
 *     fields in modes llm and quick-then-llm, the quick judge's `quickJudge`
 *     fields in mode quick. The quick judge in quick-then-llm stays forced,
 *     so its policy is never offered.
 *   - Setting a model never changes the mode.
 *   - no argument in the TUI: a two-step picker, each step a list mounted
 *     through `ctx.ui.custom`. Step 1 picks the mode (quick-then-llm, llm,
 *     quick, each with a one-line description, the current one marked).
 *     Step 2 shows only the lists that mode needs, the current model
 *     preselected: the available classifier models for the quick judge, then
 *     "Same as the chat model (follows /model)" and the available chat
 *     models for the LLM judge. Then a verdicts list and an onError list
 *     for the last judge of the chosen mode, each with a one-line
 *     description per value, the current value marked and preselected.
 *     Nothing is written until the last step; then the mode, the models and
 *     the policy go out in one write. A cancel at any step writes nothing.
 *   - no argument outside the TUI: print the mode, the model of each judge
 *     the mode runs, the last judge's policy, and the usage line (pi's `ctx.ui.custom` returns
 *     nothing in rpc/json/print modes).
 *   - anything else, including the removed forms `<provider>/<id>`,
 *     `session` and `system-one`, gets the usage line and writes nothing.
 *
 * Argument completion offers the forms `mode`, `llm`, `quick`, `verdicts` and
 * `on-error`, then the
 * values each takes (see `getArgumentCompletions`).
 *
 * Every write form refuses when the global config file is absent or there is
 * no valid merged config - no config file found, or the files found failed
 * validation: nothing is written and the operator gets the setup hint naming
 * the global path. The precondition is the config, not registration: with a
 * valid config and a link that never registers a write still succeeds, and the
 * new judge applies once the link does. Every write is one atomic write of
 * the global file; when the project layer sets its own value for a field the
 * write changed, the operator is warned that it shadows the choice.
 *
 * Choosing a judge never touches pi's session model or the operator's default
 * model. This module performs no filesystem or network access of its own:
 * persistence and reload go through the injected dependencies, which the
 * extension wires to the config loader. Every failure path leaves the
 * in-memory config as it was, so a bad pick can never widen a verdict.
 */

import type { ClassifierApi, ClassifierModel, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

import {
  formatConfigIssue,
  type JudgePolicy,
  type JudgeSelection,
  type LoadConfigResult,
} from "./config-loader";
import {
  type ClassifierConfig,
  type Mode,
  modeSchema,
  type OnError,
  onErrorSchema,
  quickJudgeConfigSchema,
  type Verdicts,
  verdictsSchema,
} from "./config-schema";
import {
  formatJudgeStatus,
  formatQuickStatus,
  type JudgePair,
  parseJudgePair,
  resolveJudge,
  resolveQuickJudge,
} from "./judge";

/** The slash command name (`/permission-model`). */
export const COMMAND_NAME = "permission-model";

const MODE_FORM = "mode";

const LLM_FORM = "llm";

const QUICK_FORM = "quick";

const VERDICTS_FORM = "verdicts";

const ON_ERROR_FORM = "on-error";

/** The `llm` argument that makes the LLM judge follow the chat model. */
const CHAT_MODEL = "chat-model";

const MODES = modeSchema.options;

const VERDICTS = verdictsSchema.options;

const ON_ERRORS = onErrorSchema.options;

const USAGE =
  `/${COMMAND_NAME} ${MODE_FORM} <${MODES.join("|")}> | ${LLM_FORM} <provider>/<id> | ` +
  `${LLM_FORM} ${CHAT_MODEL} | ${QUICK_FORM} <provider>/<id> | ` +
  `${VERDICTS_FORM} <${VERDICTS.join("|")}> | ${ON_ERROR_FORM} <${ON_ERRORS.join("|")}>`;

/** How a confirmation or the print form names each judge. */
const JUDGE_NAMES: Record<JudgePolicy["judge"], string> = {
  llm: "LLM judge",
  quick: "quick judge",
};

/**
 * The judge whose answer ends an ask in this mode, so the one whose verdicts
 * and onError apply. The quick judge in quick-then-llm is forced and never
 * last.
 */
function lastJudge(mode: Mode): JudgePolicy["judge"] {
  return mode === "quick" ? "quick" : "llm";
}

/**
 * A judge's verdicts and onError in a config, with the schema defaults for a
 * quick judge the config does not set up.
 */
function policyOf(
  config: ClassifierConfig,
  judge: JudgePolicy["judge"],
): { verdicts: Verdicts; onError: OnError } {
  const source =
    judge === "llm" ? config : (config.quickJudge ?? quickJudgeConfigSchema.parse({}));
  return { verdicts: source.verdicts, onError: source.onError };
}

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
/** pi's completion result, in the asynchronous form this command returns. */
type ArgumentCompletions = Promise<
  Awaited<ReturnType<NonNullable<CommandOptions["getArgumentCompletions"]>>>
>;

type PickerFactory = Parameters<ExtensionUIContext["custom"]>[0];
/** pi's TUI handle, as `ctx.ui.custom` hands it to the factory. */
export type PickerTui = Parameters<PickerFactory>[0];
/** pi's theme, as `ctx.ui.custom` hands it to the factory. */
export type PickerTheme = Parameters<PickerFactory>[1];
/** What the factory returns: a component, optionally disposable. */
export type PickerComponent = ReturnType<PickerFactory>;

/** The narrow registry projection the command needs. */
export interface CommandRegistryLike {
  find(provider: string, modelId: string): Model<any> | undefined;
  findOfType(
    type: "classifier",
    provider: string,
    modelId: string,
  ): ClassifierModel<ClassifierApi> | undefined;
  getAvailableOfType(type: "classifier"): Promise<readonly ClassifierModel<ClassifierApi>[]>;
  hasConfiguredAuth(model: Model<any>): boolean;
  getAvailable(): Model<any>[];
}

/**
 * The slice of pi's command context the handler reads. `ui` is pi's own type
 * projected with `Pick`, so a pi signature change to `notify`, `select` or
 * `custom` is a compile error here instead of a runtime failure in the picker
 * (a hand copy would be compared bivariantly and drift silently).
 */
export interface CommandContextLike {
  cwd: string;
  mode: "tui" | "rpc" | "json" | "print";
  model: Model<any> | undefined;
  modelRegistry: CommandRegistryLike;
  ui: Pick<ExtensionUIContext, "notify" | "select" | "custom">;
}

/** One step of the picker: a titled list of values. */
export interface PickerRequest {
  tui: PickerTui;
  theme: PickerTheme;
  title: string;
  items: SelectItem[];
  /** The value preselected in the list, if it is there. */
  selectedValue: string | undefined;
  onSelect(value: string): void;
  onCancel(): void;
}

/** Builds one picker step; injectable so tests never mount a real TUI. */
export type PickerSeam = (request: PickerRequest) => PickerComponent;

/** Rows a list shows before it scrolls. */
const PICKER_ROWS = 12;

/**
 * The production picker step: pi-tui's `SelectList` under a title, with the
 * value, label and one-line description of each item, in the pi theme.
 */
export const buildSelectList: PickerSeam = (request) => {
  const { theme } = request;
  const list = new SelectList(request.items, Math.min(request.items.length, PICKER_ROWS), {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("warning", text),
  });
  const selected = request.items.findIndex((item) => item.value === request.selectedValue);
  if (selected >= 0) {
    list.setSelectedIndex(selected);
  }
  list.onSelect = (item) => request.onSelect(item.value);
  list.onCancel = () => request.onCancel();
  const container = new Container();
  container.addChild(new Text(theme.fg("accent", theme.bold(request.title))));
  container.addChild(list);
  container.addChild(new Text(theme.fg("dim", "up/down move, enter select, esc cancel")));
  return {
    render: (width: number) => container.render(width),
    invalidate: () => container.invalidate(),
    handleInput: (data: string) => {
      list.handleInput(data);
      request.tui.requestRender();
    },
  };
};

/** Step 1 of the picker, in its fixed order. */
const MODE_ITEMS: readonly { mode: Mode; description: string }[] = [
  {
    mode: "quick-then-llm",
    description: "The quick judge settles clear cases; the LLM judge reviews the rest.",
  },
  { mode: "llm", description: "A chat model reads each ask and reasons about it." },
  {
    mode: "quick",
    description: "A System One decision model answers three fixed questions, fast.",
  },
];

/** The picker's verdicts step, in schema order. */
const VERDICTS_ITEMS: readonly { value: Verdicts; description: string }[] = [
  { value: "allow-deny-defer", description: "Allow, deny, or send the ask to you when unsure." },
  { value: "allow-defer", description: "Never denies: a deny or an unsure answer goes to you." },
  { value: "allow-deny", description: "Never asks you: an unsure answer denies." },
];

/** The picker's onError step, in schema order. */
const ON_ERROR_ITEMS: readonly { value: OnError; description: string }[] = [
  { value: "defer", description: "A failure (timeout, no reply) sends the ask to you." },
  { value: "deny", description: "A failure denies with a retry hint. It never allows." },
];

/** The LLM list entry that makes the LLM judge follow the chat model. */
export const CHAT_MODEL_LABEL = "Same as the chat model (follows /model)";

/** Seams the extension supplies; none of them are called on a rejected pick. */
export interface CommandDependencies {
  /**
   * The config the judges read, with any session-only flag values over it;
   * `undefined` when invalid or absent.
   */
  getConfig(): ClassifierConfig | undefined;
  /**
   * Whether the global config file itself sets the quick judge pair. The mode
   * is written there, so a quick mode is saved only beside a quick model in
   * the same file.
   */
  globalQuickJudgeSet(): boolean;
  /** The session's model registry (captured at `session_start`), for completion. */
  getRegistry(): CommandRegistryLike | undefined;
  /** Whether the global config file exists (the precondition for a write). */
  globalConfigExists(): boolean;
  /** The global config path, for operator hints. */
  globalConfigPath(): string;
  /** The project config path for `cwd`, for the shadow warning. */
  projectConfigPath(cwd: string): string;
  /** Persist a selection to the global config in one atomic write. */
  write(selection: JudgeSelection): void;
  /** Reload the merged config from disk after a write. */
  reload(cwd: string): LoadConfigResult;
  /**
   * Replace the live config and refresh the status. `selection` is what the
   * write set, so a session-only flag value for those fields is dropped.
   */
  apply(config: ClassifierConfig, selection: JudgeSelection): void;
  /** Builds one picker step; defaults to {@link buildSelectList}. */
  buildPicker?: PickerSeam;
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
  function setupHint(): string {
    return `The permission classifier is not set up: create ${deps.globalConfigPath()} first.`;
  }

  /**
   * Whether a write can proceed: a valid merged config must be live and the
   * global file must exist. Otherwise notify the setup hint. Neither check is
   * on registration.
   */
  function canWrite(ctx: CommandContextLike): boolean {
    if (deps.getConfig() === undefined || !deps.globalConfigExists()) {
      ctx.ui.notify(`${setupHint()} Nothing changed.`, "warning");
      return false;
    }
    return true;
  }

  function describeIssues(issues: LoadConfigResult["issues"]): string {
    if (issues.length === 0) {
      return "no config file was found";
    }
    return issues.map(formatConfigIssue).join("; ");
  }

  /**
   * Write the selection, reload, apply, and report. Returns whether the new
   * config went live; every failure leaves the live config as it was.
   */
  function persist(selection: JudgeSelection, ctx: CommandContextLike): boolean {
    try {
      deps.write(selection);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `Could not write ${deps.globalConfigPath()}: ${message}. Nothing changed.`,
        "error",
      );
      return false;
    }
    const result = deps.reload(ctx.cwd);
    if (result.config === undefined) {
      // The write landed, but the merged global-plus-project config no
      // longer validates. Applying `undefined` would leave a registered link
      // deferring every ask behind a footer that says otherwise, so keep the
      // previous config live and tell the operator what to fix.
      ctx.ui.notify(
        `Saved to ${deps.globalConfigPath()}, but the merged config is now invalid (${describeIssues(result.issues)}). The previous judge stays active for this session; fix the config and restart.`,
        "error",
      );
      return false;
    }
    deps.apply(result.config, selection);
    ctx.ui.notify(`${describeSelection(selection)} (saved to the global config).`, "info");
    if (result.issues.length > 0) {
      ctx.ui.notify(
        `Config issues after reload: ${withPeriod(describeIssues(result.issues))}`,
        "warning",
      );
    }
    const shadowed = shadowedFields(selection, result.config);
    if (shadowed.length > 0) {
      ctx.ui.notify(
        `${deps.projectConfigPath(ctx.cwd)} sets its own ${shadowed.join(" and ")} and shadows this choice in this project.`,
        "warning",
      );
    }
    return true;
  }

  const buildPicker = deps.buildPicker ?? buildSelectList;

  /** The judge the next ask would use. */
  function currentJudge(ctx: CommandContextLike) {
    return resolveJudge(
      undefined,
      deps.getConfig(),
      ctx.modelRegistry,
      ctx.model,
    );
  }

  function printJudge(ctx: CommandContextLike): void {
    if (deps.getConfig() === undefined) {
      ctx.ui.notify(setupHint(), "warning");
      return;
    }
    const config = deps.getConfig()!;
    const parts: string[] = [];
    if (config.mode !== "llm") {
      parts.push(formatQuickStatus(resolveQuickJudge(config.quickJudge ?? {}, ctx.modelRegistry)));
    }
    if (config.mode !== "quick") {
      parts.push(formatJudgeStatus(currentJudge(ctx)));
    }
    const judge = lastJudge(config.mode);
    const policy = policyOf(config, judge);
    ctx.ui.notify(
      `Permission judge mode ${config.mode}: ${parts.join(", ")}; ` +
        `${JUDGE_NAMES[judge]} verdicts ${policy.verdicts}, onError ${policy.onError}. ` +
        `Usage: ${USAGE}`,
      "info",
    );
  }

  /** Warn after a successful LLM write when the chosen model has no auth. */
  function warnWithoutAuth(model: Model<any>, ctx: CommandContextLike): void {
    if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
      ctx.ui.notify(
        `No auth is configured for ${model.provider}/${model.id}; permission asks will defer to the prompt until it is.`,
        "warning",
      );
    }
  }

  /** Persist a chat model as the LLM judge; warn when it has no auth. */
  function applyModel(model: Model<any>, ctx: CommandContextLike): void {
    if (persist({ llm: { provider: model.provider, model: model.id } }, ctx)) {
      warnWithoutAuth(model, ctx);
    }
  }

  /** Resolve a pair through the chat model registry and set it as the LLM judge. */
  function applyPair(pair: JudgePair, ctx: CommandContextLike): void {
    const label = `${pair.provider}/${pair.model}`;
    const model = ctx.modelRegistry.find(pair.provider, pair.model);
    if (!model) {
      ctx.ui.notify(
        ctx.modelRegistry.findOfType("classifier", pair.provider, pair.model)
          ? `${label} is a classifier model, not a chat model; set it with /${COMMAND_NAME} ${QUICK_FORM} ${label}. Nothing changed.`
          : `Unknown model ${label}: not in the model registry. Nothing changed.`,
        "error",
      );
      return;
    }
    applyModel(model, ctx);
  }

  /**
   * Resolve a pair through the classifier lookup only and set it as the
   * quick judge. The session model and the LLM judge are never touched.
   */
  function applyQuickPair(pair: JudgePair, ctx: CommandContextLike): void {
    const label = `${pair.provider}/${pair.model}`;
    const model = ctx.modelRegistry.findOfType("classifier", pair.provider, pair.model);
    if (!model) {
      ctx.ui.notify(
        ctx.modelRegistry.find(pair.provider, pair.model)
          ? `${label} is a chat model; the quick judge needs a classifier model. Set it with /${COMMAND_NAME} ${LLM_FORM} ${label}. Nothing changed.`
          : `Unknown classifier model ${label}: the model registry has no classifier by that name. Nothing changed.`,
        "error",
      );
      return;
    }
    persist({ quick: { provider: model.provider, model: model.id } }, ctx);
  }

  /**
   * Set the mode; a mode that runs the quick judge needs a quick model in the
   * global config file first. A quick model from the launch flag or a project
   * config does not count: the mode is saved globally and would outlive the
   * flag or apply in other projects.
   */
  function applyMode(mode: Mode, ctx: CommandContextLike): void {
    if (mode !== "llm" && !deps.globalQuickJudgeSet()) {
      ctx.ui.notify(
        `Mode ${mode} needs a quick judge model in the global config: set one first with /${COMMAND_NAME} ${QUICK_FORM} <provider>/<id>. A quick model from the launch flag or a project config does not count. Nothing changed.`,
        "warning",
      );
      return;
    }
    persist({ mode }, ctx);
  }

  /**
   * Persist verdicts or onError for the last judge of the live mode. Called
   * only after `canWrite`, so the config is there.
   */
  function applyPolicy(fields: Omit<JudgePolicy, "judge">, ctx: CommandContextLike): void {
    persist({ policy: { judge: lastJudge(deps.getConfig()!.mode), ...fields } }, ctx);
  }

  /** Mount one picker step; resolves the chosen value, or `undefined` on cancel. */
  async function step(
    ctx: CommandContextLike,
    title: string,
    items: SelectItem[],
    selectedValue: string | undefined,
  ): Promise<string | undefined> {
    return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) =>
      buildPicker({
        tui,
        theme,
        title,
        items,
        selectedValue,
        onSelect: (value) => done(value),
        onCancel: () => done(undefined),
      }),
    );
  }

  /**
   * The no-argument TUI form: pick the mode, then the models it needs, then
   * the last judge's verdicts and onError, then write them all at once. Any
   * cancel returns before the write.
   */
  async function pick(ctx: CommandContextLike): Promise<void> {
    const config = deps.getConfig();
    const currentMode = config?.mode ?? "llm";
    const chosenMode = await step(
      ctx,
      "Permission judge: who judges each ask",
      MODE_ITEMS.map(({ mode, description }) => ({
        value: mode,
        label: mode === currentMode ? `${mode} (current)` : mode,
        description,
      })),
      currentMode,
    );
    const mode = modeSchema.safeParse(chosenMode);
    if (!mode.success) {
      return;
    }
    const selection: JudgeSelection = { mode: mode.data };

    if (mode.data !== "llm") {
      const labels = (await ctx.modelRegistry.getAvailableOfType("classifier")).map(
        (model) => `${model.provider}/${model.id}`,
      );
      if (labels.length === 0) {
        ctx.ui.notify(
          "No classifier models are available for the quick judge. Nothing changed.",
          "warning",
        );
        return;
      }
      const current = config?.quickJudge;
      const chosen = await step(
        ctx,
        "Quick judge model",
        labels.map((label) => ({ value: label, label })),
        current?.provider !== undefined && current.model !== undefined
          ? `${current.provider}/${current.model}`
          : undefined,
      );
      // Labels are built as provider/id above, so the parse cannot fail.
      const pair = chosen === undefined ? undefined : parseJudgePair(chosen);
      if (!pair) {
        return;
      }
      selection.quick = pair;
    }

    let llmModel: Model<any> | undefined;
    if (mode.data !== "quick") {
      const models = ctx.modelRegistry.getAvailable();
      const chosen = await step(
        ctx,
        "LLM judge model",
        [
          { value: CHAT_MODEL, label: CHAT_MODEL_LABEL },
          ...models.map((model) => {
            const label = `${model.provider}/${model.id}`;
            return { value: label, label };
          }),
        ],
        config?.provider !== undefined && config.model !== undefined
          ? `${config.provider}/${config.model}`
          : CHAT_MODEL,
      );
      if (chosen === undefined) {
        return;
      }
      if (chosen === CHAT_MODEL) {
        selection.llm = null;
      } else {
        llmModel = models.find((model) => `${model.provider}/${model.id}` === chosen);
        if (!llmModel) {
          return;
        }
        selection.llm = { provider: llmModel.provider, model: llmModel.id };
      }
    }

    const judge = lastJudge(mode.data);
    const current = config === undefined ? undefined : policyOf(config, judge);
    const title = judge === "llm" ? "LLM judge" : "Quick judge";
    const verdicts = verdictsSchema.safeParse(
      await step(
        ctx,
        `${title} verdicts`,
        markCurrent(VERDICTS_ITEMS, current?.verdicts),
        current?.verdicts,
      ),
    );
    if (!verdicts.success) {
      return;
    }
    const onError = onErrorSchema.safeParse(
      await step(
        ctx,
        `${title} onError`,
        markCurrent(ON_ERROR_ITEMS, current?.onError),
        current?.onError,
      ),
    );
    if (!onError.success) {
      return;
    }
    selection.policy = { judge, verdicts: verdicts.data, onError: onError.data };

    if (persist(selection, ctx) && llmModel) {
      warnWithoutAuth(llmModel, ctx);
    }
  }

  /**
   * Complete the form, then its value: the modes after `mode `, the
   * chat-model option and the available chat model labels after `llm `, and
   * the available classifier model labels after `quick `, each filtered by
   * the prefix.
   */
  async function getArgumentCompletions(prefix: string): ArgumentCompletions {
    const registry = deps.getRegistry();
    if (!registry) {
      return null;
    }
    const text = prefix.trimStart().toLowerCase();
    const space = text.indexOf(" ");
    if (space < 0) {
      const items = [MODE_FORM, LLM_FORM, QUICK_FORM, VERDICTS_FORM, ON_ERROR_FORM]
        .filter((form) => form.startsWith(text))
        .map((form) => ({ value: form, label: form }));
      return items.length > 0 ? items : null;
    }
    const form = text.slice(0, space);
    const wanted = text.slice(space + 1).trim();
    const options =
      form === MODE_FORM
        ? [...MODES]
        : form === LLM_FORM
          ? [CHAT_MODEL, ...registry.getAvailable().map((model) => `${model.provider}/${model.id}`)]
          : form === QUICK_FORM
            ? (await registry.getAvailableOfType("classifier")).map(
                (model) => `${model.provider}/${model.id}`,
              )
            : form === VERDICTS_FORM
              ? [...VERDICTS]
              : form === ON_ERROR_FORM
                ? [...ON_ERRORS]
                : [];
    const items = options
      .filter((option) => option.toLowerCase().startsWith(wanted))
      .map((option) => ({ value: `${form} ${option}`, label: option }));
    return items.length > 0 ? items : null;
  }

  async function handler(args: string, ctx: CommandContextLike): Promise<void> {
    const text = args.trim();
    if (text === "") {
      if (ctx.mode !== "tui") {
        printJudge(ctx);
      } else if (canWrite(ctx)) {
        await pick(ctx);
      }
      return;
    }
    const [head, ...tail] = text.split(/\s+/);
    const value = tail.length === 1 ? tail[0]! : undefined;
    if (head === MODE_FORM && value !== undefined) {
      const mode = modeSchema.safeParse(value);
      if (!mode.success) {
        ctx.ui.notify(`Unknown mode ${value}. Usage: ${USAGE}`, "error");
        return;
      }
      if (canWrite(ctx)) {
        applyMode(mode.data, ctx);
      }
      return;
    }
    if (head === LLM_FORM && value === CHAT_MODEL) {
      if (canWrite(ctx)) {
        persist({ llm: null }, ctx);
      }
      return;
    }
    if (head === VERDICTS_FORM && value !== undefined) {
      const verdicts = verdictsSchema.safeParse(value);
      if (!verdicts.success) {
        ctx.ui.notify(`Unknown verdicts ${value}. Usage: ${USAGE}`, "error");
        return;
      }
      if (canWrite(ctx)) {
        applyPolicy({ verdicts: verdicts.data }, ctx);
      }
      return;
    }
    if (head === ON_ERROR_FORM && value !== undefined) {
      const onError = onErrorSchema.safeParse(value);
      if (!onError.success) {
        ctx.ui.notify(`Unknown onError ${value}. Usage: ${USAGE}`, "error");
        return;
      }
      if (canWrite(ctx)) {
        applyPolicy({ onError: onError.data }, ctx);
      }
      return;
    }
    const pair = value === undefined ? undefined : parseJudgePair(value);
    if (head === LLM_FORM && pair) {
      if (canWrite(ctx)) {
        applyPair(pair, ctx);
      }
      return;
    }
    if (head === QUICK_FORM && pair) {
      if (canWrite(ctx)) {
        applyQuickPair(pair, ctx);
      }
      return;
    }
    ctx.ui.notify(`Unknown form ${text}. Usage: ${USAGE}`, "error");
  }

  return {
    description: "Choose who judges permission asks and each judge's model",
    getArgumentCompletions,
    handler,
  };
}

/** Picker items for fixed values, the current one labelled `(current)`. */
function markCurrent(
  items: readonly { value: string; description: string }[],
  current: string | undefined,
): SelectItem[] {
  return items.map(({ value, description }) => ({
    value,
    label: value === current ? `${value} (current)` : value,
    description,
  }));
}

/** `text` ending in exactly one period, whether or not it had one. */
function withPeriod(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}

/** One sentence naming what a selection set. */
function describeSelection(selection: JudgeSelection): string {
  const parts: string[] = [];
  if (selection.mode !== undefined) {
    parts.push(`mode ${selection.mode}`);
  }
  if (selection.quick !== undefined) {
    parts.push(`quick judge ${selection.quick.provider}/${selection.quick.model}`);
  }
  if (selection.llm === null) {
    parts.push(`LLM judge follows the ${CHAT_MODEL.replace("-", " ")}`);
  } else if (selection.llm !== undefined) {
    parts.push(`LLM judge ${selection.llm.provider}/${selection.llm.model}`);
  }
  const policy = selection.policy;
  if (policy?.verdicts !== undefined) {
    parts.push(`${JUDGE_NAMES[policy.judge]} verdicts ${policy.verdicts}`);
  }
  if (policy?.onError !== undefined) {
    parts.push(`${JUDGE_NAMES[policy.judge]} onError ${policy.onError}`);
  }
  return `Permission judge: ${parts.join(", ")}`;
}

/**
 * The fields a write set that the merged config does not show: the project
 * layer sets its own value and shadows the global one.
 */
function shadowedFields(selection: JudgeSelection, config: ClassifierConfig): string[] {
  const shadowed: string[] = [];
  if (selection.mode !== undefined && config.mode !== selection.mode) {
    shadowed.push("mode");
  }
  const llmShadowed =
    selection.llm === null
      ? config.provider !== undefined || config.model !== undefined
      : selection.llm !== undefined &&
        (config.provider !== selection.llm.provider || config.model !== selection.llm.model);
  if (llmShadowed) {
    shadowed.push("provider/model");
  }
  if (
    selection.quick !== undefined &&
    (config.quickJudge?.provider !== selection.quick.provider ||
      config.quickJudge?.model !== selection.quick.model)
  ) {
    shadowed.push("quickJudge");
  }
  const policy = selection.policy;
  if (policy !== undefined) {
    const merged = policyOf(config, policy.judge);
    const prefix = policy.judge === "quick" ? "quickJudge." : "";
    if (policy.verdicts !== undefined && merged.verdicts !== policy.verdicts) {
      shadowed.push(`${prefix}verdicts`);
    }
    if (policy.onError !== undefined && merged.onError !== policy.onError) {
      shadowed.push(`${prefix}onError`);
    }
  }
  return shadowed;
}
