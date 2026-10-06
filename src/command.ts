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
 *   - no argument in the TUI: a menu, each list mounted through
 *     `ctx.ui.custom`, with five entries showing their current values: Who
 *     judges (the modes, each with a one-line description), Quick judge
 *     model (the available classifier models), LLM judge model ("Same as the
 *     chat model (follows /model)" and the available chat models), and the
 *     last judge's verdicts and on error. A model entry whose judge the mode
 *     does not run is marked unused. Each entry opens one list with the
 *     current value marked and preselected; a pick writes only that entry's
 *     fields, the same as the typed form, and the menu opens again. A quick
 *     mode picked while the global config has no quick model opens the
 *     quick model list next and writes both together. Esc in a list
 *     returns to the menu without a write; Esc on the menu closes it.
 *   - no argument outside the TUI: print the mode, the model of each judge
 *     the mode runs, the last judge's policy, and the usage line (pi's
 *     `ctx.ui.custom` returns nothing in rpc/json/print modes).
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

/** What a write did: see `persist`. */
type PersistOutcome = "applied" | "not-written" | "reload-invalid";

/** The menu's title. */
const MENU_TITLE = "Permission judge";

/** How the menu and its lists name each judge at the start of a label. */
const JUDGE_TITLES: Record<JudgePolicy["judge"], string> = {
  llm: "LLM judge",
  quick: "Quick judge",
};

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

/** The Who judges list, in its fixed order. */
const MODE_ITEMS: readonly { value: Mode; description: string }[] = [
  {
    value: "quick-then-llm",
    description: "The quick judge settles clear cases; the LLM judge reviews the rest.",
  },
  { value: "llm", description: "A chat model reads each ask and reasons about it." },
  {
    value: "quick",
    description: "A System One decision model answers three fixed questions, fast.",
  },
];

/** The verdicts list, in schema order. */
const VERDICTS_ITEMS: readonly { value: Verdicts; description: string }[] = [
  { value: "allow-deny-defer", description: "Allow, deny, or send the ask to you when unsure." },
  { value: "allow-defer", description: "A model deny or an unsure answer goes to you." },
  { value: "allow-deny", description: "An unsure answer denies instead of asking you." },
];

/** The on error list, in schema order. */
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
   * Write the selection, reload, apply, and report. Returns `applied` when
   * the new config went live, `not-written` when nothing was written, and
   * `reload-invalid` when the write landed but the merged config no longer
   * validates. Every failure leaves the live config as it was.
   */
  function persist(selection: JudgeSelection, ctx: CommandContextLike): PersistOutcome {
    try {
      deps.write(selection);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `Could not write ${deps.globalConfigPath()}: ${message}. Nothing changed.`,
        "error",
      );
      return "not-written";
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
      return "reload-invalid";
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
    return "applied";
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
  function applyModel(model: Model<any>, ctx: CommandContextLike): PersistOutcome {
    const outcome = persist({ llm: { provider: model.provider, model: model.id } }, ctx);
    if (outcome === "applied") {
      warnWithoutAuth(model, ctx);
    }
    return outcome;
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
  function applyMode(mode: Mode, ctx: CommandContextLike): PersistOutcome {
    if (mode !== "llm" && !deps.globalQuickJudgeSet()) {
      ctx.ui.notify(
        `Mode ${mode} needs a quick judge model in the global config: set one first with /${COMMAND_NAME} ${QUICK_FORM} <provider>/<id>. A quick model from the launch flag or a project config does not count. Nothing changed.`,
        "warning",
      );
      return "not-written";
    }
    return persist({ mode }, ctx);
  }

  /**
   * Persist verdicts or onError for the last judge of the live mode. Called
   * only after `canWrite`, so the config is there.
   */
  function applyPolicy(
    fields: Omit<JudgePolicy, "judge">,
    ctx: CommandContextLike,
  ): PersistOutcome {
    return persist({ policy: { judge: lastJudge(deps.getConfig()!.mode), ...fields } }, ctx);
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
   * The no-argument TUI form: a menu of five entries, each showing its
   * current value. An entry opens one list; a pick there writes only that
   * entry's fields and the menu opens again with the new values. Esc in a
   * list returns to the menu without a write; Esc on the menu closes it.
   */
  async function pick(ctx: CommandContextLike): Promise<void> {
    let selected: string = MODE_FORM;
    for (;;) {
      const config = deps.getConfig();
      if (config === undefined) {
        return;
      }
      const entry = await step(ctx, MENU_TITLE, menuItems(config), selected);
      if (entry === undefined) {
        return;
      }
      selected = entry;
      if ((await pickEntry(entry, config, ctx)) === "reload-invalid") {
        // The file now holds a config that does not validate; more picks
        // would only write to it. The error already says what to fix.
        return;
      }
    }
  }

  /** The menu entries, each with the live config's current value. */
  function menuItems(config: ClassifierConfig): SelectItem[] {
    const judge = lastJudge(config.mode);
    const policy = policyOf(config, judge);
    const unused = ` (not used in ${config.mode})`;
    const quick = config.quickJudge;
    const quickValue =
      quick?.provider !== undefined && quick.model !== undefined
        ? `${quick.provider}/${quick.model}`
        : "not set";
    const llmValue =
      config.provider !== undefined && config.model !== undefined
        ? `${config.provider}/${config.model}`
        : CHAT_MODEL_LABEL;
    return [
      { value: MODE_FORM, label: "Who judges", description: config.mode },
      {
        value: QUICK_FORM,
        label: "Quick judge model",
        description: config.mode === "llm" ? quickValue + unused : quickValue,
      },
      {
        value: LLM_FORM,
        label: "LLM judge model",
        description: config.mode === "quick" ? llmValue + unused : llmValue,
      },
      {
        value: VERDICTS_FORM,
        label: `${JUDGE_TITLES[judge]} verdicts`,
        description: policy.verdicts,
      },
      {
        value: ON_ERROR_FORM,
        label: `${JUDGE_TITLES[judge]} on error`,
        description: policy.onError,
      },
    ];
  }

  /** Open the list for one menu entry and write the pick, if any. */
  async function pickEntry(
    entry: string,
    config: ClassifierConfig,
    ctx: CommandContextLike,
  ): Promise<PersistOutcome> {
    if (entry === MODE_FORM) {
      const mode = modeSchema.safeParse(
        await step(ctx, "Who judges", markCurrent(MODE_ITEMS, config.mode), config.mode),
      );
      if (!mode.success) {
        return "not-written";
      }
      if (mode.data !== "llm" && !deps.globalQuickJudgeSet()) {
        // The mode is saved globally, so it needs a quick model beside it:
        // ask for one now and write both together.
        const pair = await pickQuickModel(config, ctx);
        return pair ? persist({ mode: mode.data, quick: pair }, ctx) : "not-written";
      }
      return applyMode(mode.data, ctx);
    }
    if (entry === QUICK_FORM) {
      const pair = await pickQuickModel(config, ctx);
      return pair ? persist({ quick: pair }, ctx) : "not-written";
    }
    if (entry === LLM_FORM) {
      return pickLlmModel(config, ctx);
    }
    const judge = lastJudge(config.mode);
    const policy = policyOf(config, judge);
    if (entry === VERDICTS_FORM) {
      const verdicts = verdictsSchema.safeParse(
        await step(
          ctx,
          `${JUDGE_TITLES[judge]} verdicts`,
          markCurrent(VERDICTS_ITEMS, policy.verdicts),
          policy.verdicts,
        ),
      );
      return verdicts.success ? applyPolicy({ verdicts: verdicts.data }, ctx) : "not-written";
    }
    if (entry === ON_ERROR_FORM) {
      const onError = onErrorSchema.safeParse(
        await step(
          ctx,
          `${JUDGE_TITLES[judge]} on error`,
          markCurrent(ON_ERROR_ITEMS, policy.onError),
          policy.onError,
        ),
      );
      return onError.success ? applyPolicy({ onError: onError.data }, ctx) : "not-written";
    }
    return "not-written";
  }


  /**
   * The quick model list: the available classifier models, the current one
   * marked and preselected. Resolves the pick, or `undefined` on a cancel or
   * when none is available (with a warning).
   */
  async function pickQuickModel(
    config: ClassifierConfig,
    ctx: CommandContextLike,
  ): Promise<JudgePair | undefined> {
    const labels = (await ctx.modelRegistry.getAvailableOfType("classifier")).map(
      (model) => `${model.provider}/${model.id}`,
    );
    if (labels.length === 0) {
      ctx.ui.notify(
        "No classifier models are available for the quick judge. Nothing changed.",
        "warning",
      );
      return undefined;
    }
    const current = config.quickJudge;
    const currentLabel =
      current?.provider !== undefined && current.model !== undefined
        ? `${current.provider}/${current.model}`
        : undefined;
    const chosen = await step(
      ctx,
      "Quick judge model",
      withCurrent(
        labels.map((label) => ({ value: label, label })),
        currentLabel,
      ),
      currentLabel,
    );
    if (chosen === undefined || !labels.includes(chosen)) {
      // A cancel, or the unavailable current row: nothing to change.
      return undefined;
    }
    // Labels are built as provider/id above, so the parse cannot fail.
    return parseJudgePair(chosen);
  }

  /**
   * The LLM model list: the chat model option, then the available chat
   * models, the current one marked and preselected. A pick is written at
   * once, with the auth warning for a model that has none.
   */
  async function pickLlmModel(
    config: ClassifierConfig,
    ctx: CommandContextLike,
  ): Promise<PersistOutcome> {
    const models = ctx.modelRegistry.getAvailable();
    const current =
      config.provider !== undefined && config.model !== undefined
        ? `${config.provider}/${config.model}`
        : CHAT_MODEL;
    const items = withCurrent(
      [
        { value: CHAT_MODEL, label: CHAT_MODEL_LABEL },
        ...models.map((model) => {
          const label = `${model.provider}/${model.id}`;
          return { value: label, label };
        }),
      ],
      current,
    );
    const chosen = await step(ctx, "LLM judge model", items, current);
    if (chosen === undefined) {
      return "not-written";
    }
    if (chosen === CHAT_MODEL) {
      return persist({ llm: null }, ctx);
    }
    // The unavailable current row matches no model and changes nothing.
    const model = models.find((candidate) => `${candidate.provider}/${candidate.id}` === chosen);
    return model ? applyModel(model, ctx) : "not-written";
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

/**
 * Model list items with the current value labelled `(current)`. A current
 * value the list does not hold (the configured model is not available) goes
 * first as `(current, not available)`, so the preselected row is never one
 * that changes the judge.
 */
function withCurrent(items: SelectItem[], current: string | undefined): SelectItem[] {
  if (current === undefined) {
    return items;
  }
  if (!items.some((item) => item.value === current)) {
    return [{ value: current, label: `${current} (current, not available)` }, ...items];
  }
  return items.map((item) =>
    item.value === current ? { ...item, label: `${item.label} (current)` } : item,
  );
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
