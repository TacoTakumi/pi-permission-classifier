import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import type { LoadConfigResult } from "#src/config-loader";
import type { ClassifierConfig } from "#src/config-schema";
import {
  type CommandContextLike,
  type CommandDependencies,
  createPermissionModelCommand,
  buildSelectList,
  type PickerComponent,
  type PickerRequest,
  type PickerSeam,
  type PickerTui,
} from "#src/command";
import { type JudgePair, resolveJudge } from "#src/judge";

const SESSION_MODEL = { provider: "anthropic", id: "claude-opus" } as Model<any>;
const PM_MODEL = { provider: "p", id: "m" } as Model<any>;
const QN_MODEL = { provider: "q", id: "n" } as Model<any>;
const JEV = { provider: "typesafe", id: "jev-latest", type: "classifier" } as never;
const KEV = { provider: "local", id: "kev-4b-q8", type: "classifier" } as never;
const CLASSIFIERS = [JEV, KEV];

const EMPTY_CONFIG: ClassifierConfig = {
  surfaces: ["bash"],
  timeoutMs: 5000,
  contextBudgetBytes: 8192,
  mode: "llm",
  verdicts: "allow-deny-defer",
  onError: "defer",
};
const CONFIG_QN: ClassifierConfig = { ...EMPTY_CONFIG, provider: "q", model: "n" };
const QUICK_JUDGE = {
  provider: "typesafe",
  model: "jev",
  verdicts: "allow-defer",
  onError: "defer",
  allowThreshold: 0.9,
  denyThreshold: 0.9,
  guidance: true,
  timeoutMs: 5000,
} as const;
const WITH_QUICK: ClassifierConfig = { ...EMPTY_CONFIG, quickJudge: QUICK_JUDGE };

const GLOBAL_PATH = "/agent/extensions/pi-permission-classifier/config.json";
const PROJECT_PATH = "/project/.pi/extensions/pi-permission-classifier/config.json";

function findKnown(provider: string, id: string): Model<any> | undefined {
  if (provider === "p" && id === "m") return PM_MODEL;
  if (provider === "q" && id === "n") return QN_MODEL;
  return undefined;
}

const AVAILABLE = [
  { provider: "anthropic", id: "a" },
  { provider: "anthropic", id: "b" },
  { provider: "openai", id: "c" },
] as Model<any>[];

const FAKE_TUI = { requestRender: vi.fn() } as unknown as PickerTui;
const FAKE_COMPONENT = {
  render: () => [],
  handleInput: () => {},
} as unknown as PickerComponent;

type CustomFactory<T> = (
  tui: PickerTui,
  theme: unknown,
  keybindings: unknown,
  done: (result: T) => void,
) => PickerComponent;

function findClassifier(type: string, provider: string, id: string) {
  return type === "classifier" && provider === "typesafe" && id === "jev-latest"
    ? JEV
    : undefined;
}

function makeRegistry(options: { runtime?: boolean } = {}) {
  return {
    find: vi.fn(findKnown),
    findOfType: vi.fn(findClassifier),
    getModelsOfType: vi.fn((_type: "classifier") => CLASSIFIERS),
    getAvailableOfType: vi.fn(async (_type: "classifier") => CLASSIFIERS),
    hasConfiguredAuth: vi.fn(() => true),
    getAvailable: vi.fn(() => AVAILABLE),
    ...(options.runtime === false
      ? {}
      : { runtime: { getAvailableSnapshot: vi.fn(() => AVAILABLE) } }),
  };
}

function makeCtx(
  mode: "tui" | "rpc" | "json" | "print" = "tui",
  options: { runtime?: boolean } = {},
) {
  return {
    cwd: "/project",
    mode,
    model: SESSION_MODEL,
    modelRegistry: makeRegistry(options),
    scopedModels: [] as const,
    ui: {
      notify: vi.fn(),
      // Mount synchronously; resolve when the component calls done().
      // vi.fn erases the generic, so cast back to the context's own signature.
      custom: vi.fn(
        (factory: CustomFactory<unknown>) =>
          new Promise<unknown>((resolve) => {
            factory(FAKE_TUI, {}, {}, resolve);
          }),
      ) as unknown as CommandContextLike["ui"]["custom"],
      select: vi.fn(),
    },
  };
}

function makeDeps(initial: ClassifierConfig | undefined = EMPTY_CONFIG) {
  const state: { config: ClassifierConfig | undefined } = { config: initial };
  const reloaded: LoadConfigResult = {
    config: { ...EMPTY_CONFIG, provider: "p", model: "m" },
    issues: [],
  };
  const registry = makeRegistry();
  const deps = {
    getConfig: () => state.config,
    globalQuickJudgeSet: vi.fn<CommandDependencies["globalQuickJudgeSet"]>(
      () => state.config?.quickJudge?.model !== undefined,
    ),
    getRegistry: () => registry,
    buildPicker: vi.fn<PickerSeam>(() => FAKE_COMPONENT),
    globalConfigExists: vi.fn<CommandDependencies["globalConfigExists"]>(
      () => true,
    ),
    globalConfigPath: () => GLOBAL_PATH,
    projectConfigPath: (cwd: string) =>
      `${cwd}/.pi/extensions/pi-permission-classifier/config.json`,
    write: vi.fn<CommandDependencies["write"]>(),
    reload: vi.fn<CommandDependencies["reload"]>(() => reloaded),
    apply: vi.fn<CommandDependencies["apply"]>((config) => {
      state.config = config;
    }),
  } satisfies CommandDependencies;
  return { state, reloaded, deps, registry };
}

function notifyTypes(ctx: ReturnType<typeof makeCtx>): string[] {
  return ctx.ui.notify.mock.calls.map((call) => String(call[1]));
}

function notifyOf(ctx: ReturnType<typeof makeCtx>, type: string): string {
  const call = ctx.ui.notify.mock.calls.find((c) => c[1] === type);
  return String(call?.[0]);
}

describe("/permission-model registration surface", () => {
  it("exposes a non-empty description and a completion hook", () => {
    const command = createPermissionModelCommand(makeDeps().deps);
    expect(typeof command.description).toBe("string");
    expect(command.description.length).toBeGreaterThan(0);
    expect(typeof command.getArgumentCompletions).toBe("function");
    expect(typeof command.handler).toBe("function");
  });
});

describe("typed form /permission-model llm <provider>/<id>", () => {
  it("writes p/m, reloads through the loader, applies the reloaded config, and notifies info", async () => {
    const { state, reloaded, deps } = makeDeps();
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("llm p/m", ctx);
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(deps.write).toHaveBeenCalledWith({ llm: { provider: "p", model: "m" } });
    expect(deps.reload).toHaveBeenCalledTimes(1);
    expect(deps.reload).toHaveBeenCalledWith("/project");
    expect(deps.reload.mock.invocationCallOrder[0]).toBeGreaterThan(
      deps.write.mock.invocationCallOrder[0]!,
    );
    expect(deps.apply).toHaveBeenCalledWith(reloaded.config, {
      llm: { provider: "p", model: "m" },
    });
    expect(state.config).toBe(reloaded.config);
    expect(notifyTypes(ctx)).toEqual(["info"]);
    expect(notifyOf(ctx, "info")).toContain("p/m");
  });

  it("resolves the pair through the registry", async () => {
    const { deps } = makeDeps();
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("llm p/m", ctx);
    expect(ctx.modelRegistry.find).toHaveBeenCalledWith("p", "m");
  });

  it("never changes the mode", async () => {
    const { deps } = makeDeps({ ...EMPTY_CONFIG, mode: "quick-then-llm" });
    await createPermissionModelCommand(deps).handler("llm p/m", makeCtx());
    expect(deps.write.mock.calls[0]![0]).not.toHaveProperty("mode");
  });

  it("refuses a classifier model and names the quick form", async () => {
    const { deps } = makeDeps();
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("llm typesafe/jev-latest", ctx);
    expect(deps.write).not.toHaveBeenCalled();
    expect(notifyTypes(ctx)).toEqual(["error"]);
    expect(notifyOf(ctx, "error")).toContain("/permission-model quick typesafe/jev-latest");
  });

  it("rejects a pair the registry does not know: nothing written, config unchanged, error names the pair", async () => {
    const { state, deps } = makeDeps(CONFIG_QN);
    const before = structuredClone(state.config);
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("llm nope/x", ctx);
    expect(deps.write).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
    expect(deps.apply).not.toHaveBeenCalled();
    expect(state.config).toEqual(before);
    expect(notifyTypes(ctx)).toEqual(["error"]);
    expect(notifyOf(ctx, "error")).toContain("nope/x");
  });

  it("rejects a reference without a slash with an error naming the usage", async () => {
    const { deps } = makeDeps();
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("llm nonsense", ctx);
    expect(deps.write).not.toHaveBeenCalled();
    expect(notifyTypes(ctx)).toEqual(["error"]);
    expect(notifyOf(ctx, "error")).toContain("<provider>/<id>");
  });

  it("accepts a known model without auth: writes it and warns that asks defer", async () => {
    const { deps } = makeDeps();
    const ctx = makeCtx();
    ctx.modelRegistry.hasConfiguredAuth.mockReturnValue(false);
    await createPermissionModelCommand(deps).handler("llm p/m", ctx);
    expect(ctx.modelRegistry.hasConfiguredAuth).toHaveBeenCalledWith(PM_MODEL);
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(deps.write).toHaveBeenCalledWith({ llm: { provider: "p", model: "m" } });
    expect(notifyTypes(ctx)).toContain("warning");
    expect(notifyOf(ctx, "warning")).toMatch(/defer/);
  });
});

describe("chat-model form /permission-model llm chat-model", () => {
  it("removes both keys, applies the reloaded config, and the session model judges again", async () => {
    const { state, deps } = makeDeps(CONFIG_QN);
    deps.reload.mockReturnValue({
      config: EMPTY_CONFIG,
      issues: [],
    });
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("llm chat-model", ctx);
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(deps.write).toHaveBeenCalledWith({ llm: null });
    expect(deps.reload).toHaveBeenCalledWith("/project");
    expect(state.config?.provider).toBeUndefined();
    expect(state.config?.model).toBeUndefined();
    expect(
      resolveJudge(undefined, state.config, ctx.modelRegistry, SESSION_MODEL)
        .model,
    ).toBe(SESSION_MODEL);
    expect(notifyTypes(ctx)).toEqual(["info"]);
    expect(notifyOf(ctx, "info")).toMatch(/chat model/);
  });

  it("does not consult the registry", async () => {
    const { deps } = makeDeps(CONFIG_QN);
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("llm chat-model", ctx);
    expect(ctx.modelRegistry.find).not.toHaveBeenCalled();
  });
});

describe("refusal when there is no valid config or no global file", () => {
  it.each([
    "llm p/m",
    "llm chat-model",
    "mode llm",
    "quick typesafe/jev-latest",
    "verdicts allow-deny",
    "on-error deny",
    "llm timeout 12",
    "quick timeout 12",
  ])(
    "%j refuses with a warning naming the global path when the link is not registered",
    async (args) => {
      const { state, deps } = makeDeps();
      state.config = undefined;
      const ctx = makeCtx();
      await createPermissionModelCommand(deps).handler(args, ctx);
      expect(deps.write).not.toHaveBeenCalled();
      expect(deps.reload).not.toHaveBeenCalled();
      expect(notifyTypes(ctx)).toEqual(["warning"]);
      expect(notifyOf(ctx, "warning")).toContain(GLOBAL_PATH);
    },
  );

  it.each([
    "llm p/m",
    "llm chat-model",
    "mode llm",
    "quick typesafe/jev-latest",
    "verdicts allow-deny",
    "on-error deny",
    "llm timeout 12",
    "quick timeout 12",
  ])(
    "%j refuses with a warning naming the global path when the global file is absent",
    async (args) => {
      const { state, deps } = makeDeps(CONFIG_QN);
      deps.globalConfigExists.mockReturnValue(false);
      const before = structuredClone(state.config);
      const ctx = makeCtx();
      await createPermissionModelCommand(deps).handler(args, ctx);
      expect(deps.write).not.toHaveBeenCalled();
      expect(state.config).toEqual(before);
      expect(notifyTypes(ctx)).toEqual(["warning"]);
      expect(notifyOf(ctx, "warning")).toContain(GLOBAL_PATH);
    },
  );
});

describe("project layer shadowing the choice", () => {
  it("still writes the global file and warns naming the project config path", async () => {
    const { deps } = makeDeps();
    deps.reload.mockReturnValue({
      config: CONFIG_QN,
      issues: [],
    });
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("llm p/m", ctx);
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(deps.write).toHaveBeenCalledWith({ llm: { provider: "p", model: "m" } });
    expect(deps.apply).toHaveBeenCalledWith(CONFIG_QN, { llm: { provider: "p", model: "m" } });
    expect(notifyTypes(ctx)).toContain("warning");
    expect(notifyOf(ctx, "warning")).toContain(PROJECT_PATH);
    expect(notifyOf(ctx, "warning")).toContain("provider/model");
  });

  it.each([
    ["mode quick-then-llm", { mode: "llm" as const }, "mode"],
    ["quick typesafe/jev-latest", { quickJudge: { ...QUICK_JUDGE, model: "other" } }, "quickJudge"],
    ["llm chat-model", { provider: "q", model: "n" }, "provider/model"],
    ["verdicts allow-deny", { verdicts: "allow-defer" as const }, "verdicts"],
    ["on-error deny", { onError: "defer" as const }, "onError"],
  ])("warns when the project layer shadows %j", async (args, merged, field) => {
    const { deps } = makeDeps(WITH_QUICK);
    deps.reload.mockReturnValue({
      config: { ...WITH_QUICK, ...merged },
      issues: [],
    });
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler(args, ctx);
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(notifyOf(ctx, "warning")).toContain(PROJECT_PATH);
    expect(notifyOf(ctx, "warning")).toContain(field);
  });

  it("warns naming quickJudge.verdicts when the project layer shadows the quick judge's policy", async () => {
    const { deps } = makeDeps({ ...WITH_QUICK, mode: "quick" });
    deps.reload.mockReturnValue({
      config: { ...WITH_QUICK, mode: "quick", quickJudge: { ...QUICK_JUDGE, verdicts: "allow-defer" } },
      issues: [],
    });
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("verdicts allow-deny", ctx);
    expect(notifyOf(ctx, "warning")).toContain(PROJECT_PATH);
    expect(notifyOf(ctx, "warning")).toContain("quickJudge.verdicts");
  });

  it("does not warn when the merged config shows the policy written", async () => {
    const { deps } = makeDeps();
    deps.reload.mockReturnValue({
      config: { ...EMPTY_CONFIG, verdicts: "allow-deny" },
      issues: [],
    });
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("verdicts allow-deny", ctx);
    expect(notifyTypes(ctx)).toEqual(["info"]);
  });

  it("does not warn when the merged config shows the choice", async () => {
    const { deps } = makeDeps(WITH_QUICK);
    deps.reload.mockReturnValue({
      config: { ...WITH_QUICK, mode: "quick" },
      issues: [],
    });
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("mode quick", ctx);
    expect(notifyTypes(ctx)).toEqual(["info"]);
  });
});

describe("write failure", () => {
  it("leaves the config unchanged, skips the reload, and notifies error", async () => {
    const { state, deps } = makeDeps(CONFIG_QN);
    deps.write.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });
    const before = structuredClone(state.config);
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("llm p/m", ctx);
    expect(deps.reload).not.toHaveBeenCalled();
    expect(deps.apply).not.toHaveBeenCalled();
    expect(state.config).toEqual(before);
    expect(notifyTypes(ctx)).toEqual(["error"]);
    expect(notifyOf(ctx, "error")).toContain("EACCES");
  });
});

describe("no-argument form outside the TUI", () => {
  const USAGE_LINE =
    "/permission-model mode <llm|quick|quick-then-llm> | llm <provider>/<id> | llm chat-model | quick <provider>/<id> | " +
    "llm timeout <seconds> | quick timeout <seconds> | " +
    "verdicts <allow-deny-defer|allow-defer|allow-deny> | on-error <defer|deny>";

  it.each(["rpc", "json", "print"] as const)(
    "in %s mode opens no picker and prints the mode, the judge and the usage",
    async (mode) => {
      const { deps } = makeDeps(CONFIG_QN);
      const ctx = makeCtx(mode);
      await createPermissionModelCommand(deps).handler("", ctx);
      expect(ctx.ui.custom).not.toHaveBeenCalled();
      expect(ctx.ui.select).not.toHaveBeenCalled();
      expect(deps.write).not.toHaveBeenCalled();
      expect(notifyTypes(ctx)).toEqual(["info"]);
      expect(notifyOf(ctx, "info")).toBe(
        `Permission judge mode llm: llm:q/n; LLM judge verdicts allow-deny-defer, onError defer. Usage: ${USAGE_LINE}`,
      );
    },
  );

  it("prints llm:chat-model when the LLM judge follows the chat model", async () => {
    const { deps } = makeDeps(EMPTY_CONFIG);
    const ctx = makeCtx("rpc");
    await createPermissionModelCommand(deps).handler("  ", ctx);
    expect(notifyOf(ctx, "info")).toContain("mode llm: llm:chat-model;");
  });

  it("prints both judges, quick first, in mode quick-then-llm", async () => {
    const { deps } = makeDeps({
      ...WITH_QUICK,
      mode: "quick-then-llm",
      quickJudge: { ...QUICK_JUDGE, model: "jev-latest" },
    });
    const ctx = makeCtx("print");
    await createPermissionModelCommand(deps).handler("", ctx);
    expect(notifyOf(ctx, "info")).toContain(
      "mode quick-then-llm: quick:typesafe/jev-latest, llm:chat-model; LLM judge verdicts allow-deny-defer, onError defer.",
    );
  });

  it("prints the quick judge's policy in mode quick", async () => {
    const { deps } = makeDeps({
      ...WITH_QUICK,
      mode: "quick",
      quickJudge: { ...QUICK_JUDGE, verdicts: "allow-deny", onError: "deny" },
    });
    const ctx = makeCtx("print");
    await createPermissionModelCommand(deps).handler("", ctx);
    expect(notifyOf(ctx, "info")).toContain("; quick judge verdicts allow-deny, onError deny.");
  });

  it("prints only the quick judge in mode quick, marking an unknown pair", async () => {
    const { deps } = makeDeps({ ...WITH_QUICK, mode: "quick" });
    const ctx = makeCtx("print");
    await createPermissionModelCommand(deps).handler("", ctx);
    expect(notifyOf(ctx, "info")).toContain("mode quick: quick:typesafe/jev (unresolved);");
  });

  it("prints the judge of the config it is handed, flag values included", async () => {
    const { deps } = makeDeps({ ...CONFIG_QN, provider: "p", model: "m" });
    const ctx = makeCtx("rpc");
    await createPermissionModelCommand(deps).handler("", ctx);
    expect(notifyOf(ctx, "info")).toContain("llm:p/m");
  });
});

describe("argument completion", () => {
  async function values(prefix: string, made = makeDeps()) {
    return (await createPermissionModelCommand(made.deps).getArgumentCompletions(prefix))?.map(
      (item) => item.value,
    );
  }

  it("offers the five forms for an empty prefix", async () => {
    expect(await values("")).toEqual(["mode", "llm", "quick", "verdicts", "on-error"]);
  });

  it("filters the forms by the typed prefix", async () => {
    expect(await values("q")).toEqual(["quick"]);
    expect(await values("l")).toEqual(["llm"]);
    expect(await values("v")).toEqual(["verdicts"]);
    expect(await values("on")).toEqual(["on-error"]);
  });

  it("offers the verdicts values after 'verdicts allow-d'", async () => {
    expect(await values("verdicts allow-d")).toEqual([
      "verdicts allow-deny-defer",
      "verdicts allow-defer",
      "verdicts allow-deny",
    ]);
    expect(await values("verdicts allow-deny-")).toEqual(["verdicts allow-deny-defer"]);
  });

  it("offers the onError values after 'on-error '", async () => {
    expect(await values("on-error ")).toEqual(["on-error defer", "on-error deny"]);
    expect(await values("on-error den")).toEqual(["on-error deny"]);
  });

  it("offers the timeout form after 'llm ti' and after 'quick ti'", async () => {
    expect(await values("llm ti")).toEqual(["llm timeout"]);
    expect(await values("quick ti")).toEqual(["quick timeout"]);
  });

  it.each(["llm", "quick"] as const)(
    "offers the preset budgets and the clear value after '%s timeout '",
    async (form) => {
      expect(await values(`${form} timeout `)).toEqual([
        `${form} timeout 5`,
        `${form} timeout 10`,
        `${form} timeout 15`,
        `${form} timeout 25`,
        `${form} timeout 30`,
        `${form} timeout 60`,
        `${form} timeout 0`,
      ]);
    },
  );

  it("filters the budgets by the typed digits after 'llm timeout '", async () => {
    expect(await values("llm timeout 1")).toEqual(["llm timeout 10", "llm timeout 15"]);
    expect(await values("quick timeout 6")).toEqual(["quick timeout 60"]);
    expect(await values("quick timeout 0")).toEqual(["quick timeout 0"]);
  });

  it("labels a budget completion with the seconds", async () => {
    const items = await createPermissionModelCommand(makeDeps().deps).getArgumentCompletions(
      "quick timeout ",
    );
    expect(items?.map((item) => item.label)).toEqual([
      "5 s",
      "10 s",
      "15 s",
      "25 s",
      "30 s",
      "60 s",
      "0 s",
    ]);
  });

  it("returns null when no budget matches the typed digits", async () => {
    expect(await values("llm timeout 9")).toBeUndefined();
  });

  it("offers the matching modes after 'mode q'", async () => {
    expect(await values("mode q")).toEqual(["mode quick", "mode quick-then-llm"]);
  });

  it("offers every mode after 'mode '", async () => {
    expect(await values("mode ")).toEqual(["mode llm", "mode quick", "mode quick-then-llm"]);
  });

  it("offers chat-model, timeout and the chat model labels after 'llm '", async () => {
    expect(await values("llm ")).toEqual([
      "llm chat-model",
      "llm timeout",
      "llm anthropic/a",
      "llm anthropic/b",
      "llm openai/c",
    ]);
  });

  it("filters the chat model labels after 'llm an'", async () => {
    expect(await values("llm an")).toEqual(["llm anthropic/a", "llm anthropic/b"]);
  });

  it("offers the classifier labels after 'quick ty'", async () => {
    expect(await values("quick ty")).toEqual(["quick typesafe/jev-latest"]);
  });

  it("offers timeout and only the available classifiers after 'quick '", async () => {
    const made = makeDeps();
    made.registry.getModelsOfType.mockReturnValue([JEV, KEV]);
    made.registry.getAvailableOfType.mockResolvedValue([KEV]);
    expect(await values("quick ", made)).toEqual(["quick timeout", "quick local/kev-4b-q8"]);
  });

  it("labels a second-level item with the value alone", async () => {
    const { deps } = makeDeps();
    const items = await createPermissionModelCommand(deps).getArgumentCompletions("quick ");
    expect(items?.map((item) => item.label)).toEqual([
      "timeout",
      "typesafe/jev-latest",
      "local/kev-4b-q8",
    ]);
  });

  it("returns null when nothing matches", async () => {
    expect(await values("zzz")).toBeUndefined();
    expect(await values("quick zz")).toBeUndefined();
    expect(await values("session ")).toBeUndefined();
  });

  it("returns null before a session captured the registry", async () => {
    const { deps } = makeDeps();
    const command = createPermissionModelCommand({
      ...deps,
      getRegistry: () => undefined,
    });
    expect(await command.getArgumentCompletions("llm ")).toBeNull();
  });
});

describe("menu picker in the TUI", () => {
  /** The request of the n-th mounted list, once the handler has mounted it. */
  async function stepRequest(
    deps: ReturnType<typeof makeDeps>["deps"],
    n: number,
  ): Promise<PickerRequest> {
    await vi.waitFor(() => expect(deps.buildPicker.mock.calls.length).toBeGreaterThan(n));
    return deps.buildPicker.mock.calls[n]![0];
  }

  const JEV_LATEST = { ...QUICK_JUDGE, model: "jev-latest" };

  /** Open the menu on `config`; the reload returns the config as it is. */
  function openMenu(config: ClassifierConfig) {
    const made = makeDeps(config);
    made.deps.reload.mockImplementation(() => ({ config: made.state.config!, issues: [] }));
    const ctx = makeCtx("tui");
    const pending = createPermissionModelCommand(made.deps).handler("", ctx);
    return { ...made, ctx, pending };
  }

  /** Close the menu mounted as the n-th list and wait for the handler. */
  async function closeMenu(
    deps: ReturnType<typeof makeDeps>["deps"],
    n: number,
    pending: Promise<void>,
  ) {
    const menu = await stepRequest(deps, n);
    expect(menu.title).toBe("Permission judge");
    menu.onCancel();
    await pending;
  }

  it("lists the entries in order with their current values", async () => {
    const { deps, pending } = openMenu({ ...CONFIG_QN, quickJudge: JEV_LATEST });
    const menu = await stepRequest(deps, 0);
    expect(menu.tui).toBe(FAKE_TUI);
    expect(menu.title).toBe("Permission judge");
    expect(menu.items).toEqual([
      { value: "mode", label: "Who judges", description: "llm" },
      {
        value: "quick",
        label: "Quick judge model",
        description: "typesafe/jev-latest (not used in llm)",
      },
      { value: "llm", label: "LLM judge model", description: "q/n" },
      { value: "llm timeout", label: "LLM judge model-call timeout", description: "5 seconds" },
      { value: "verdicts", label: "LLM judge verdicts", description: "allow-deny-defer" },
      { value: "on-error", label: "LLM judge on error", description: "defer" },
    ]);
    expect(menu.selectedValue).toBe("mode");
    menu.onCancel();
    await pending;
    expect(deps.buildPicker).toHaveBeenCalledTimes(1);
    expect(deps.write).not.toHaveBeenCalled();
  });

  it("names the quick judge's policy and marks the LLM model unused in mode quick", async () => {
    const { deps, pending } = openMenu({
      ...EMPTY_CONFIG,
      mode: "quick",
      quickJudge: { ...JEV_LATEST, verdicts: "allow-deny", onError: "deny" },
    });
    const menu = await stepRequest(deps, 0);
    expect(menu.items.map((item) => [item.label, item.description])).toEqual([
      ["Who judges", "quick"],
      ["Quick judge model", "typesafe/jev-latest"],
      ["LLM judge model", "Same as the chat model (follows /model) (not used in quick)"],
      ["Quick judge model-call timeout", "5 seconds"],
      ["Quick judge verdicts", "allow-deny"],
      ["Quick judge on error", "deny"],
    ]);
    menu.onCancel();
    await pending;
  });

  it("marks no entry unused in mode quick-then-llm and shows an unset quick model", async () => {
    const { deps, pending } = openMenu({ ...EMPTY_CONFIG, mode: "quick-then-llm" });
    const menu = await stepRequest(deps, 0);
    expect(menu.items.map((item) => item.description)).toEqual([
      "quick-then-llm",
      "not set",
      "Same as the chat model (follows /model)",
      "5 seconds",
      "5 seconds",
      "allow-deny-defer",
      "defer",
    ]);
    menu.onCancel();
    await pending;
  });

  it.each([
    [
      "llm",
      ["mode", "quick", "llm", "llm timeout", "verdicts", "on-error"],
      [["LLM judge model-call timeout", "10 seconds"]],
    ],
    [
      "quick",
      ["mode", "quick", "llm", "quick timeout", "verdicts", "on-error"],
      [["Quick judge model-call timeout", "20 seconds"]],
    ],
    [
      "quick-then-llm",
      ["mode", "quick", "llm", "quick timeout", "llm timeout", "verdicts", "on-error"],
      [
        ["Quick judge model-call timeout", "20 seconds"],
        ["LLM judge model-call timeout", "10 seconds"],
      ],
    ],
  ] as const)(
    "in mode %s the menu lists one timeout entry per judge the mode runs, at its saved budget",
    async (mode, values, budgets) => {
      const { deps, pending } = openMenu({
        ...CONFIG_QN,
        mode,
        timeoutMs: 10000,
        quickJudge: { ...JEV_LATEST, timeoutMs: 20000 },
      });
      const menu = await stepRequest(deps, 0);
      expect(menu.items.map((item) => item.value)).toEqual(values);
      expect(
        menu.items
          .filter((item) => item.value.endsWith("timeout"))
          .map((item) => [item.label, item.description]),
      ).toEqual(budgets);
      menu.onCancel();
      await pending;
    },
  );

  it("Who judges lists the modes with descriptions, writes the pick, and reopens the menu", async () => {
    const { deps, pending } = openMenu({ ...WITH_QUICK, mode: "llm" });
    (await stepRequest(deps, 0)).onSelect("mode");
    const modes = await stepRequest(deps, 1);
    expect(modes.title).toBe("Who judges");
    expect(modes.items.map((item) => item.value)).toEqual(["quick-then-llm", "llm", "quick"]);
    expect(modes.items.map((item) => item.label)).toEqual([
      "quick-then-llm",
      "llm (current)",
      "quick",
    ]);
    for (const item of modes.items) {
      expect(item.description).toMatch(/\S/);
      expect(item.description).not.toContain("\n");
    }
    expect(modes.selectedValue).toBe("llm");
    deps.reload.mockReturnValue({ config: { ...WITH_QUICK, mode: "quick-then-llm" }, issues: [] });
    modes.onSelect("quick-then-llm");
    const menu = await stepRequest(deps, 2);
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(deps.write).toHaveBeenCalledWith({ mode: "quick-then-llm" });
    expect(menu.selectedValue).toBe("mode");
    expect(menu.items[0]!.description).toBe("quick-then-llm");
    await closeMenu(deps, 2, pending);
  });

  it.each(["quick", "quick-then-llm"] as const)(
    "Who judges %s with no global quick model opens the quick list and writes both at once",
    async (mode) => {
      const { deps, pending } = openMenu(CONFIG_QN);
      (await stepRequest(deps, 0)).onSelect("mode");
      (await stepRequest(deps, 1)).onSelect(mode);
      const quick = await stepRequest(deps, 2);
      expect(quick.title).toBe("Quick judge model");
      expect(deps.write).not.toHaveBeenCalled();
      quick.onSelect("typesafe/jev-latest");
      expect((await stepRequest(deps, 3)).selectedValue).toBe("mode");
      expect(deps.write).toHaveBeenCalledTimes(1);
      expect(deps.write).toHaveBeenCalledWith({
        mode,
        quick: { provider: "typesafe", model: "jev-latest" },
      });
      await closeMenu(deps, 3, pending);
    },
  );

  it("a cancel at the chained quick list writes nothing and returns to the menu", async () => {
    const { deps, ctx, pending } = openMenu(CONFIG_QN);
    (await stepRequest(deps, 0)).onSelect("mode");
    (await stepRequest(deps, 1)).onSelect("quick");
    (await stepRequest(deps, 2)).onCancel();
    await closeMenu(deps, 3, pending);
    expect(deps.write).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("a quick mode with no global quick model and no classifiers warns and writes nothing", async () => {
    const { deps, ctx, pending } = openMenu(CONFIG_QN);
    ctx.modelRegistry.getAvailableOfType.mockResolvedValue([]);
    (await stepRequest(deps, 0)).onSelect("mode");
    (await stepRequest(deps, 1)).onSelect("quick-then-llm");
    await closeMenu(deps, 2, pending);
    expect(deps.write).not.toHaveBeenCalled();
    expect(notifyTypes(ctx)).toEqual(["warning"]);
    expect(notifyOf(ctx, "warning")).toMatch(/classifier/);
  });

  it("Quick judge model lists the available classifiers, current preselected, and writes the pair", async () => {
    const { deps, ctx, pending } = openMenu({ ...WITH_QUICK, quickJudge: JEV_LATEST });
    (await stepRequest(deps, 0)).onSelect("quick");
    const quick = await stepRequest(deps, 1);
    expect(quick.title).toBe("Quick judge model");
    expect(ctx.modelRegistry.getAvailableOfType).toHaveBeenCalledWith("classifier");
    expect(quick.items.map((item) => item.value)).toEqual([
      "typesafe/jev-latest",
      "local/kev-4b-q8",
    ]);
    expect(quick.items[0]!.label).toBe("typesafe/jev-latest (current)");
    expect(quick.selectedValue).toBe("typesafe/jev-latest");
    quick.onSelect("local/kev-4b-q8");
    expect((await stepRequest(deps, 2)).selectedValue).toBe("quick");
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(deps.write).toHaveBeenCalledWith({ quick: { provider: "local", model: "kev-4b-q8" } });
    await closeMenu(deps, 2, pending);
  });

  it("LLM judge model lists the chat model option first, current preselected, and writes the pair", async () => {
    const { deps, pending } = openMenu({ ...EMPTY_CONFIG, provider: "anthropic", model: "a" });
    (await stepRequest(deps, 0)).onSelect("llm");
    const llm = await stepRequest(deps, 1);
    expect(llm.title).toBe("LLM judge model");
    expect(llm.items[0]).toEqual({
      value: "chat-model",
      label: "Same as the chat model (follows /model)",
    });
    expect(llm.items.slice(1).map((item) => item.value)).toEqual([
      "anthropic/a",
      "anthropic/b",
      "openai/c",
    ]);
    expect(llm.selectedValue).toBe("anthropic/a");
    expect(llm.items[1]!.label).toBe("anthropic/a (current)");
    llm.onSelect("anthropic/b");
    await stepRequest(deps, 2);
    expect(deps.write).toHaveBeenCalledWith({ llm: { provider: "anthropic", model: "b" } });
    await closeMenu(deps, 2, pending);
  });

  it("LLM judge model writes null for the chat model option and preselects it with no pair", async () => {
    const { deps, pending } = openMenu(EMPTY_CONFIG);
    (await stepRequest(deps, 0)).onSelect("llm");
    const llm = await stepRequest(deps, 1);
    expect(llm.selectedValue).toBe("chat-model");
    expect(llm.items[0]!.label).toBe("Same as the chat model (follows /model) (current)");
    llm.onSelect("chat-model");
    await stepRequest(deps, 2);
    expect(deps.write).toHaveBeenCalledWith({ llm: null });
    await closeMenu(deps, 2, pending);
  });

  it("warns after an LLM pick when the chosen model has no auth", async () => {
    const { deps, ctx, pending } = openMenu(EMPTY_CONFIG);
    deps.reload.mockReturnValue({
      config: { ...EMPTY_CONFIG, provider: "anthropic", model: "b" },
      issues: [],
    });
    ctx.modelRegistry.hasConfiguredAuth.mockReturnValue(false);
    (await stepRequest(deps, 0)).onSelect("llm");
    (await stepRequest(deps, 1)).onSelect("anthropic/b");
    await closeMenu(deps, 2, pending);
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(notifyTypes(ctx)).toEqual(["info", "warning"]);
    expect(notifyOf(ctx, "warning")).toMatch(/defer/);
  });

  it.each([
    ["llm", "LLM", "llm"],
    ["quick-then-llm", "LLM", "llm"],
    ["quick", "Quick", "quick"],
  ] as const)(
    "in mode %s the verdicts entry lists the values for the %s judge and writes its verdicts",
    async (mode, title, judge) => {
      const { deps, pending } = openMenu({
        ...WITH_QUICK,
        mode,
        verdicts: "allow-defer",
        quickJudge: { ...JEV_LATEST, verdicts: "allow-deny" },
      });
      const current = judge === "llm" ? "allow-defer" : "allow-deny";
      (await stepRequest(deps, 0)).onSelect("verdicts");
      const step = await stepRequest(deps, 1);
      expect(step.title).toBe(`${title} judge verdicts`);
      expect(step.items.map((item) => item.value)).toEqual([
        "allow-deny-defer",
        "allow-defer",
        "allow-deny",
      ]);
      expect(step.items.find((item) => item.value === current)?.label).toBe(
        `${current} (current)`,
      );
      expect(step.selectedValue).toBe(current);
      step.onSelect("allow-deny-defer");
      expect((await stepRequest(deps, 2)).selectedValue).toBe("verdicts");
      expect(deps.write).toHaveBeenCalledWith({
        policy: { judge, verdicts: "allow-deny-defer" },
      });
      await closeMenu(deps, 2, pending);
    },
  );

  it("the on-error entry lists defer and deny for the last judge and writes its onError", async () => {
    const { deps, pending } = openMenu({ ...EMPTY_CONFIG, onError: "deny" });
    (await stepRequest(deps, 0)).onSelect("on-error");
    const step = await stepRequest(deps, 1);
    expect(step.title).toBe("LLM judge on error");
    expect(step.items.map((item) => item.label)).toEqual(["defer", "deny (current)"]);
    for (const item of step.items) {
      expect(item.description).toMatch(/\S/);
    }
    expect(step.selectedValue).toBe("deny");
    step.onSelect("defer");
    await stepRequest(deps, 2);
    expect(deps.write).toHaveBeenCalledWith({ policy: { judge: "llm", onError: "defer" } });
    await closeMenu(deps, 2, pending);
  });

  it("the LLM timeout entry lists the preset budgets, writes the pick, and shows it on the next menu", async () => {
    const config: ClassifierConfig = {
      ...CONFIG_QN,
      mode: "quick-then-llm",
      quickJudge: JEV_LATEST,
      timeoutMs: 15000,
    };
    const { deps, pending } = openMenu(config);
    (await stepRequest(deps, 0)).onSelect("llm timeout");
    const list = await stepRequest(deps, 1);
    expect(list.title).toBe("LLM judge model-call timeout");
    expect(list.items.map((item) => item.value)).toEqual(["5", "10", "15", "25", "30", "60", "0"]);
    expect(list.items.map((item) => item.label)).toEqual([
      "5",
      "10",
      "15 (current)",
      "25",
      "30",
      "60",
      "0",
    ]);
    expect(list.selectedValue).toBe("15");
    for (const item of list.items) {
      expect(item.description).toMatch(/\S/);
      expect(item.description).toContain("LLM judge");
    }
    deps.reload.mockReturnValue({ config: { ...config, timeoutMs: 25000 }, issues: [] });
    list.onSelect("25");
    const menu = await stepRequest(deps, 2);
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(deps.write).toHaveBeenCalledWith({ timeout: { judge: "llm", seconds: 25 } });
    expect(menu.items.find((item) => item.value === "llm timeout")?.description).toBe(
      "25 seconds",
    );
    await closeMenu(deps, 2, pending);
  });

  it("the quick timeout entry lists the budgets, the saved non-preset budget, and writes the quick judge's key", async () => {
    const config: ClassifierConfig = {
      ...EMPTY_CONFIG,
      mode: "quick",
      quickJudge: { ...JEV_LATEST, timeoutMs: 7000 },
    };
    const { deps, pending } = openMenu(config);
    (await stepRequest(deps, 0)).onSelect("quick timeout");
    const list = await stepRequest(deps, 1);
    expect(list.title).toBe("Quick judge model-call timeout");
    expect(list.items.map((item) => item.value)).toEqual([
      "5",
      "10",
      "15",
      "25",
      "30",
      "60",
      "7",
      "0",
    ]);
    expect(list.items[6]?.label).toBe("7 (current)");
    expect(list.items[6]?.description).toBe(
      "The budget the config holds for the quick judge now.",
    );
    expect(list.selectedValue).toBe("7");
    deps.reload.mockReturnValue({
      config: { ...config, quickJudge: { ...JEV_LATEST, timeoutMs: 10000 } },
      issues: [],
    });
    list.onSelect("10");
    const menu = await stepRequest(deps, 2);
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(deps.write).toHaveBeenCalledWith({ timeout: { judge: "quick", seconds: 10 } });
    expect(menu.items.find((item) => item.value === "quick timeout")?.description).toBe(
      "10 seconds",
    );
    await closeMenu(deps, 2, pending);
  });

  it.each([
    [2500, "2.5"],
    [300, "0.3"],
  ])(
    "a saved budget of %i ms shows as %s (current) beside one clear row, and its pick writes nothing",
    async (timeoutMs, shown) => {
      const config: ClassifierConfig = { ...CONFIG_QN, timeoutMs };
      const { deps, pending } = openMenu(config);
      (await stepRequest(deps, 0)).onSelect("llm timeout");
      const list = await stepRequest(deps, 1);
      expect(list.items.map((item) => item.value)).toEqual([
        "5",
        "10",
        "15",
        "25",
        "30",
        "60",
        shown,
        "0",
      ]);
      expect(list.items[6]?.label).toBe(`${shown} (current)`);
      expect(list.selectedValue).toBe(shown);
      list.onSelect(shown);
      const menu = await stepRequest(deps, 2);
      expect(deps.write).not.toHaveBeenCalled();
      expect(menu.items.find((item) => item.value === "llm timeout")?.description).toBe(
        `${shown} seconds`,
      );
      await closeMenu(deps, 2, pending);
    },
  );

  it("a pick of the current preset row writes nothing", async () => {
    const { deps, pending } = openMenu({ ...CONFIG_QN, timeoutMs: 10000 });
    (await stepRequest(deps, 0)).onSelect("llm timeout");
    const list = await stepRequest(deps, 1);
    expect(list.items.find((item) => item.value === "10")?.label).toBe("10 (current)");
    list.onSelect("10");
    await stepRequest(deps, 2);
    expect(deps.write).not.toHaveBeenCalled();
    await closeMenu(deps, 2, pending);
  });

  it("the timeout list clear row writes 0 and the menu shows the built-in budget again", async () => {
    const { deps, ctx, pending } = openMenu({ ...CONFIG_QN, timeoutMs: 30000 });
    (await stepRequest(deps, 0)).onSelect("llm timeout");
    const list = await stepRequest(deps, 1);
    expect(list.items.at(-1)?.description).toBe(
      "Clear the saved budget: the LLM judge uses its built-in 5 seconds.",
    );
    deps.reload.mockReturnValue({ config: { ...CONFIG_QN, timeoutMs: 5000 }, issues: [] });
    list.onSelect("0");
    const menu = await stepRequest(deps, 2);
    expect(deps.write).toHaveBeenCalledWith({ timeout: { judge: "llm", seconds: 0 } });
    expect(notifyTypes(ctx)).toEqual(["info"]);
    expect(notifyOf(ctx, "info")).toContain(
      "LLM judge model-call timeout cleared (built-in 5 s)",
    );
    expect(menu.items.find((item) => item.value === "llm timeout")?.description).toBe("5 seconds");
    await closeMenu(deps, 2, pending);
  });

  it("verdicts descriptions claim no more than the verdicts do, whatever onError is", async () => {
    const { deps, pending } = openMenu(EMPTY_CONFIG);
    (await stepRequest(deps, 0)).onSelect("verdicts");
    const step = await stepRequest(deps, 1);
    const description = (value: string) =>
      step.items.find((item) => item.value === value)?.description;
    expect(description("allow-deny")).toBe("An unsure answer denies instead of asking you.");
    expect(description("allow-defer")).toBe("A model deny or an unsure answer goes to you.");
    step.onCancel();
    await closeMenu(deps, 2, pending);
  });

  it.each(["mode", "quick", "llm", "llm timeout", "quick timeout", "verdicts", "on-error"])(
    "a cancel in the %s list returns to the menu and writes nothing",
    async (entry) => {
      const { state, deps, ctx, pending } = openMenu({
        ...CONFIG_QN,
        mode: "quick-then-llm",
        quickJudge: JEV_LATEST,
      });
      const before = structuredClone(state.config);
      (await stepRequest(deps, 0)).onSelect(entry);
      (await stepRequest(deps, 1)).onCancel();
      expect((await stepRequest(deps, 2)).selectedValue).toBe(entry);
      await closeMenu(deps, 2, pending);
      expect(deps.write).not.toHaveBeenCalled();
      expect(deps.reload).not.toHaveBeenCalled();
      expect(deps.apply).not.toHaveBeenCalled();
      expect(state.config).toEqual(before);
      expect(ctx.ui.notify).not.toHaveBeenCalled();
    },
  );

  it("a failed write notifies the error and returns to the menu with the config unchanged", async () => {
    const { state, deps, ctx, pending } = openMenu(CONFIG_QN);
    deps.write.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });
    const before = structuredClone(state.config);
    (await stepRequest(deps, 0)).onSelect("on-error");
    (await stepRequest(deps, 1)).onSelect("deny");
    await closeMenu(deps, 2, pending);
    expect(deps.apply).not.toHaveBeenCalled();
    expect(state.config).toEqual(before);
    expect(notifyTypes(ctx)).toEqual(["error"]);
    expect(notifyOf(ctx, "error")).toContain("EACCES");
  });

  it.each([
    ["mode", ["quick-then-llm"]],
    ["mode", ["quick", "typesafe/jev-latest"]],
    ["quick", ["local/kev-4b-q8"]],
    ["llm", ["anthropic/b"]],
    ["llm", ["chat-model"]],
    ["verdicts", ["allow-deny"]],
    ["on-error", ["deny"]],
    ["llm timeout", ["15"]],
    ["quick timeout", ["10"]],
  ] as const)(
    "a %s pick %j whose reload is invalid closes the menu after the error",
    async (entry, picks) => {
      const config =
        entry === "mode" && picks.length === 1
          ? WITH_QUICK
          : entry === "quick timeout"
            ? { ...CONFIG_QN, mode: "quick-then-llm" as const, quickJudge: JEV_LATEST }
            : CONFIG_QN;
      const { deps, ctx, pending } = openMenu(config);
      deps.reload.mockReturnValue({ config: undefined, issues: [] });
      (await stepRequest(deps, 0)).onSelect(entry);
      for (const [index, value] of picks.entries()) {
        (await stepRequest(deps, index + 1)).onSelect(value);
      }
      await pending;
      expect(deps.write).toHaveBeenCalledTimes(1);
      expect(deps.apply).not.toHaveBeenCalled();
      expect(deps.buildPicker).toHaveBeenCalledTimes(picks.length + 1);
      expect(notifyTypes(ctx)).toEqual(["error"]);
      expect(notifyOf(ctx, "error")).toContain("merged config is now invalid");
    },
  );

  it("the LLM list keeps an unavailable current model first and preselected (not available)", async () => {
    const { deps, ctx, pending } = openMenu({ ...EMPTY_CONFIG, provider: "nope", model: "x" });
    (await stepRequest(deps, 0)).onSelect("llm");
    const llm = await stepRequest(deps, 1);
    expect(llm.items[0]).toEqual({ value: "nope/x", label: "nope/x (current, not available)" });
    expect(llm.items[1]!.value).toBe("chat-model");
    expect(llm.selectedValue).toBe("nope/x");
    llm.onSelect("nope/x");
    expect((await stepRequest(deps, 2)).selectedValue).toBe("llm");
    await closeMenu(deps, 2, pending);
    expect(deps.write).not.toHaveBeenCalled();
    expect(notifyTypes(ctx)).toEqual(["info"]);
    expect(notifyOf(ctx, "info")).toBe("nope/x is not available. Nothing changed.");
  });

  it("the quick list keeps an unavailable current model first and preselected (not available)", async () => {
    const { deps, ctx, pending } = openMenu(WITH_QUICK);
    (await stepRequest(deps, 0)).onSelect("quick");
    const quick = await stepRequest(deps, 1);
    expect(quick.items[0]).toEqual({
      value: "typesafe/jev",
      label: "typesafe/jev (current, not available)",
    });
    expect(quick.items.slice(1).map((item) => item.value)).toEqual([
      "typesafe/jev-latest",
      "local/kev-4b-q8",
    ]);
    expect(quick.selectedValue).toBe("typesafe/jev");
    quick.onSelect("typesafe/jev");
    await closeMenu(deps, 2, pending);
    expect(deps.write).not.toHaveBeenCalled();
    expect(notifyTypes(ctx)).toEqual(["info"]);
    expect(notifyOf(ctx, "info")).toBe("typesafe/jev is not available. Nothing changed.");
  });

  it("the chained quick list keeps an unavailable current model too (not available)", async () => {
    const { deps, ctx, pending } = openMenu(WITH_QUICK);
    deps.globalQuickJudgeSet.mockReturnValue(false);
    (await stepRequest(deps, 0)).onSelect("mode");
    (await stepRequest(deps, 1)).onSelect("quick");
    const quick = await stepRequest(deps, 2);
    expect(quick.selectedValue).toBe("typesafe/jev");
    expect(quick.items[0]!.label).toBe("typesafe/jev (current, not available)");
    quick.onSelect("typesafe/jev");
    await closeMenu(deps, 3, pending);
    expect(deps.write).not.toHaveBeenCalled();
    expect(notifyTypes(ctx)).toEqual(["info"]);
    expect(notifyOf(ctx, "info")).toBe("typesafe/jev is not available. Nothing changed.");
  });

  it("warns, writes nothing and returns to the menu when no classifier model is available", async () => {
    const { deps, ctx, pending } = openMenu(CONFIG_QN);
    ctx.modelRegistry.getAvailableOfType.mockResolvedValue([]);
    (await stepRequest(deps, 0)).onSelect("quick");
    await closeMenu(deps, 1, pending);
    expect(deps.write).not.toHaveBeenCalled();
    expect(notifyOf(ctx, "warning")).toMatch(/classifier/);
  });

  it("refuses before opening the menu when the global file is absent", async () => {
    const { deps } = makeDeps(CONFIG_QN);
    deps.globalConfigExists.mockReturnValue(false);
    const ctx = makeCtx("tui");
    await createPermissionModelCommand(deps).handler("", ctx);
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(deps.buildPicker).not.toHaveBeenCalled();
    expect(notifyTypes(ctx)).toEqual(["warning"]);
    expect(notifyOf(ctx, "warning")).toContain(GLOBAL_PATH);
  });
});

describe("reload after a write (review round 1, F1)", () => {
  it("does not apply an invalid merged config: previous config stays live, error names the issue and the global path", async () => {
    const { state, deps } = makeDeps(CONFIG_QN);
    const before = structuredClone(state.config);
    deps.reload.mockReturnValue({
      config: undefined,
      issues: [
        {
          path: "$",
          message: "provider and model must be set together or not at all",
          sourcePath: `${GLOBAL_PATH}, ${PROJECT_PATH}`,
        },
      ],
    });
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("llm chat-model", ctx);
    expect(deps.write).toHaveBeenCalledWith({ llm: null });
    expect(deps.apply).not.toHaveBeenCalled();
    expect(state.config).toEqual(before);
    expect(notifyTypes(ctx)).toEqual(["error"]);
    expect(notifyOf(ctx, "error")).toContain("must be set together");
    expect(notifyOf(ctx, "error")).toContain(GLOBAL_PATH);
  });

  it("ends a reload issue that is already a sentence with one period", async () => {
    const { reloaded, deps } = makeDeps(CONFIG_QN);
    deps.reload.mockReturnValue({
      ...reloaded,
      issues: [
        {
          path: "systemOne",
          message: "This field is ignored: it was renamed to quickJudge.",
          sourcePath: GLOBAL_PATH,
        },
      ],
    });
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("llm p/m", ctx);
    expect(notifyOf(ctx, "warning")).toBe(
      `Config issues after reload: ${GLOBAL_PATH} systemOne: This field is ignored: it was renamed to quickJudge.`,
    );
  });

  it("applies a valid reload but surfaces loader issues as a warning", async () => {
    const { state, reloaded, deps } = makeDeps(CONFIG_QN);
    deps.reload.mockReturnValue({
      ...reloaded,
      issues: [
        { path: "$", message: "Failed to read config: bad json", sourcePath: PROJECT_PATH },
      ],
    });
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("llm p/m", ctx);
    expect(deps.apply).toHaveBeenCalledWith(reloaded.config, {
      llm: { provider: "p", model: "m" },
    });
    expect(state.config).toBe(reloaded.config);
    expect(notifyTypes(ctx)).toEqual(["info", "warning"]);
    expect(notifyOf(ctx, "warning")).toContain("bad json");
    expect(notifyOf(ctx, "warning")).not.toContain("..");
    expect(notifyOf(ctx, "warning")).toContain(PROJECT_PATH);
  });
});

describe("no-argument form without a valid config (review round 1, F3)", () => {
  it("outside the TUI says the judge is not set up instead of naming a judge", async () => {
    const { state, deps } = makeDeps();
    state.config = undefined;
    const ctx = makeCtx("rpc");
    await createPermissionModelCommand(deps).handler("", ctx);
    expect(notifyTypes(ctx)).toEqual(["warning"]);
    expect(notifyOf(ctx, "warning")).toContain(GLOBAL_PATH);
    expect(notifyOf(ctx, "warning")).not.toContain("llm:chat-model");
  });
});

describe("auth warning only after a successful write (review round 2)", () => {
  it("does not warn about auth when the write failed", async () => {
    const { deps } = makeDeps(CONFIG_QN);
    deps.write.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });
    const ctx = makeCtx();
    ctx.modelRegistry.hasConfiguredAuth.mockReturnValue(false);
    await createPermissionModelCommand(deps).handler("llm p/m", ctx);
    expect(notifyTypes(ctx)).toEqual(["error"]);
  });
});

/** Exact type identity, the usual conditional-type trick. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? true
    : false;

/**
 * The handler's `ui` slice must be derived from pi's own `ExtensionUIContext`,
 * never hand-copied (T-21). A copy that happens to be accurate today is still
 * compared bivariantly, because a method signature allows it, so a pi signature
 * change would surface as a runtime failure in the picker rather than as a
 * compile error here. `npm run check` is what runs this assertion: the value is
 * a type, so vitest alone cannot see it.
 */
describe("the ui slice is pi's own ExtensionUIContext (T-21)", () => {
  it("is exactly Pick<ExtensionUIContext, notify | select | custom>", () => {
    const derived: Equals<
      CommandContextLike["ui"],
      Pick<ExtensionUIContext, "notify" | "select" | "custom">
    > = true;
    expect(derived).toBe(true);
  });
});

describe("typed form /permission-model quick <provider>/<id>", () => {
  const QUICK_RELOADED: LoadConfigResult = {
    config: { ...WITH_QUICK, quickJudge: { ...QUICK_JUDGE, model: "jev-latest" } },
    issues: [],
  };

  function quickDeps(initial: ClassifierConfig = EMPTY_CONFIG) {
    const made = makeDeps(initial);
    made.deps.reload.mockImplementation(() => QUICK_RELOADED);
    return made;
  }

  it("writes a known classifier pair, reloads and applies it", async () => {
    const { deps, state } = quickDeps();
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("quick typesafe/jev-latest", ctx);
    expect(ctx.modelRegistry.findOfType).toHaveBeenCalledWith(
      "classifier",
      "typesafe",
      "jev-latest",
    );
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(deps.write).toHaveBeenCalledWith({
      quick: { provider: "typesafe", model: "jev-latest" },
    });
    expect(deps.reload).toHaveBeenCalledWith("/project");
    expect(deps.apply).toHaveBeenCalledWith(QUICK_RELOADED.config, {
      quick: { provider: "typesafe", model: "jev-latest" },
    });
    expect(state.config?.quickJudge?.model).toBe("jev-latest");
    expect(notifyOf(ctx, "info")).toMatch(/quick judge typesafe\/jev-latest/);
    expect(notifyTypes(ctx)).toEqual(["info"]);
  });

  it("never changes the mode", async () => {
    const { deps } = quickDeps();
    await createPermissionModelCommand(deps).handler("quick typesafe/jev-latest", makeCtx());
    expect(deps.write.mock.calls[0]![0]).not.toHaveProperty("mode");
  });

  it("refuses an unknown pair and writes nothing", async () => {
    const { deps } = quickDeps();
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("quick typesafe/nope", ctx);
    expect(deps.write).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
    expect(deps.apply).not.toHaveBeenCalled();
    expect(notifyOf(ctx, "error")).toMatch(/typesafe\/nope/);
    expect(notifyOf(ctx, "error")).toMatch(/classifier/);
  });

  it("refuses a chat model and names the llm form", async () => {
    const { deps } = quickDeps();
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("quick p/m", ctx);
    expect(deps.write).not.toHaveBeenCalled();
    expect(notifyTypes(ctx)).toEqual(["error"]);
    expect(notifyOf(ctx, "error")).toContain("/permission-model llm p/m");
  });

  it("reports a failed write and changes nothing", async () => {
    const { deps } = quickDeps();
    deps.write.mockImplementation(() => {
      throw new Error("disk full");
    });
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("quick typesafe/jev-latest", ctx);
    expect(deps.apply).not.toHaveBeenCalled();
    expect(notifyOf(ctx, "error")).toMatch(/disk full/);
  });

  it("never touches the LLM judge or the session model", async () => {
    const { deps, state } = quickDeps();
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("quick typesafe/jev-latest", ctx);
    expect(ctx.modelRegistry.find).not.toHaveBeenCalled();
    expect(state.config?.provider).toBeUndefined();
    expect(ctx.model).toBe(SESSION_MODEL);
  });
});

describe("typed form /permission-model mode <mode>", () => {
  it.each(["llm", "quick", "quick-then-llm"] as const)(
    "writes mode %s alone with a quick judge model set",
    async (mode) => {
      const { deps } = makeDeps(WITH_QUICK);
      deps.reload.mockReturnValue({
        config: { ...WITH_QUICK, mode },
        issues: [],
      });
      const ctx = makeCtx();
      await createPermissionModelCommand(deps).handler(`mode ${mode}`, ctx);
      expect(deps.write).toHaveBeenCalledTimes(1);
      expect(deps.write).toHaveBeenCalledWith({ mode });
      expect(deps.apply).toHaveBeenCalledWith({ ...WITH_QUICK, mode }, { mode });
      expect(notifyOf(ctx, "info")).toContain(`mode ${mode}`);
    },
  );

  it.each(["quick", "quick-then-llm"])(
    "refuses mode %s with no quick judge model and says to set one",
    async (mode) => {
      const { deps } = makeDeps(EMPTY_CONFIG);
      const ctx = makeCtx();
      await createPermissionModelCommand(deps).handler(`mode ${mode}`, ctx);
      expect(deps.write).not.toHaveBeenCalled();
      expect(notifyTypes(ctx)).toEqual(["warning"]);
      expect(notifyOf(ctx, "warning")).toContain("/permission-model quick <provider>/<id>");
    },
  );

  it.each(["quick", "quick-then-llm"])(
    "refuses mode %s when the global file has no quick judge model",
    async (mode) => {
      const { deps } = makeDeps(WITH_QUICK);
      deps.globalQuickJudgeSet.mockReturnValue(false);
      const command = createPermissionModelCommand(deps);
      const ctx = makeCtx();
      await command.handler(`mode ${mode}`, ctx);
      expect(deps.write).not.toHaveBeenCalled();
      expect(notifyTypes(ctx)).toEqual(["warning"]);
      expect(notifyOf(ctx, "warning")).toContain("/permission-model quick <provider>/<id>");
      expect(notifyOf(ctx, "warning")).toContain("global config");
      expect(notifyOf(ctx, "warning")).toContain("launch flag or a project config does not count");
    },
  );

  it("writes mode llm with no quick judge model", async () => {
    const { deps } = makeDeps(EMPTY_CONFIG);
    deps.reload.mockReturnValue({ config: EMPTY_CONFIG, issues: [] });
    await createPermissionModelCommand(deps).handler("mode llm", makeCtx());
    expect(deps.write).toHaveBeenCalledWith({ mode: "llm" });
  });

  it("refuses an unknown mode with the usage line", async () => {
    const { deps } = makeDeps(WITH_QUICK);
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("mode system-one", ctx);
    expect(deps.write).not.toHaveBeenCalled();
    expect(notifyTypes(ctx)).toEqual(["error"]);
    expect(notifyOf(ctx, "error")).toContain("mode <llm|quick|quick-then-llm>");
  });
});

describe("typed forms /permission-model verdicts and on-error", () => {
  it.each(["llm", "quick-then-llm"] as const)(
    "in mode %s 'verdicts allow-deny' writes the LLM judge's verdicts and names it",
    async (mode) => {
      const { deps } = makeDeps({ ...WITH_QUICK, mode });
      const ctx = makeCtx();
      await createPermissionModelCommand(deps).handler("verdicts allow-deny", ctx);
      expect(deps.write).toHaveBeenCalledTimes(1);
      expect(deps.write).toHaveBeenCalledWith({
        policy: { judge: "llm", verdicts: "allow-deny" },
      });
      expect(notifyOf(ctx, "info")).toContain("LLM judge verdicts allow-deny");
    },
  );

  it("in mode quick 'verdicts allow-deny' writes the quick judge's verdicts and names it", async () => {
    const { deps } = makeDeps({ ...WITH_QUICK, mode: "quick" });
    deps.reload.mockReturnValue({ config: { ...WITH_QUICK, mode: "quick" }, issues: [] });
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("verdicts allow-deny", ctx);
    expect(deps.write).toHaveBeenCalledWith({
      policy: { judge: "quick", verdicts: "allow-deny" },
    });
    expect(notifyOf(ctx, "info")).toContain("quick judge verdicts allow-deny");
  });

  it.each([
    ["llm", "llm", "LLM judge"],
    ["quick-then-llm", "llm", "LLM judge"],
    ["quick", "quick", "quick judge"],
  ] as const)(
    "in mode %s 'on-error deny' writes the %s judge's onError",
    async (mode, judge, name) => {
      const { deps } = makeDeps({ ...WITH_QUICK, mode });
      const ctx = makeCtx();
      await createPermissionModelCommand(deps).handler("on-error deny", ctx);
      expect(deps.write).toHaveBeenCalledWith({ policy: { judge, onError: "deny" } });
      expect(notifyOf(ctx, "info")).toContain(`${name} onError deny`);
    },
  );

  it.each(["verdicts maybe", "on-error later", "verdicts", "on-error deny defer"])(
    "%j notifies an error with the usage and writes nothing",
    async (args) => {
      const { deps } = makeDeps();
      const ctx = makeCtx();
      await createPermissionModelCommand(deps).handler(args, ctx);
      expect(deps.write).not.toHaveBeenCalled();
      expect(notifyTypes(ctx)).toEqual(["error"]);
      expect(notifyOf(ctx, "error")).toContain("verdicts <allow-deny-defer|allow-defer|allow-deny>");
    },
  );
});

describe("typed form /permission-model <judge> timeout <seconds>", () => {
  const QTL: ClassifierConfig = {
    ...WITH_QUICK,
    mode: "quick-then-llm",
    quickJudge: { ...QUICK_JUDGE, model: "jev-latest" },
  };

  it("writes 'llm timeout 12' as the LLM judge's budget and names the judge", async () => {
    const { state, deps } = makeDeps(QTL);
    deps.reload.mockReturnValue({ config: { ...QTL, timeoutMs: 12000 }, issues: [] });
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("llm timeout 12", ctx);
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(deps.write).toHaveBeenCalledWith({ timeout: { judge: "llm", seconds: 12 } });
    expect(deps.reload).toHaveBeenCalledWith("/project");
    expect(deps.apply).toHaveBeenCalledWith(
      { ...QTL, timeoutMs: 12000 },
      { timeout: { judge: "llm", seconds: 12 } },
    );
    expect(state.config?.timeoutMs).toBe(12000);
    expect(notifyTypes(ctx)).toEqual(["info"]);
    expect(notifyOf(ctx, "info")).toContain("LLM judge model-call timeout 12 s");
  });

  it("writes 'quick timeout 25' as the quick judge's budget, merged with its other keys", async () => {
    const merged: ClassifierConfig = {
      ...QTL,
      quickJudge: { ...QUICK_JUDGE, model: "jev-latest", timeoutMs: 25000 },
    };
    const { state, deps } = makeDeps(QTL);
    deps.reload.mockReturnValue({ config: merged, issues: [] });
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("quick timeout 25", ctx);
    // The selection carries the timeout alone, so the writer merges it into the
    // quick judge block that already holds provider, model and guidance.
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(deps.write.mock.calls[0]![0]).toEqual({ timeout: { judge: "quick", seconds: 25 } });
    expect(deps.apply).toHaveBeenCalledWith(merged, { timeout: { judge: "quick", seconds: 25 } });
    expect(state.config?.quickJudge?.timeoutMs).toBe(25000);
    expect(state.config?.quickJudge?.provider).toBe("typesafe");
    expect(state.config?.quickJudge?.guidance).toBe(true);
    expect(notifyTypes(ctx)).toEqual(["info"]);
    expect(notifyOf(ctx, "info")).toContain("quick judge model-call timeout 25 s");
  });

  it("writes 0 to clear the key and says the judge is back on its built-in budget", async () => {
    const { deps } = makeDeps({ ...QTL, timeoutMs: 12000 });
    deps.reload.mockReturnValue({ config: { ...QTL, timeoutMs: 5000 }, issues: [] });
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("llm timeout 0", ctx);
    expect(deps.write).toHaveBeenCalledWith({ timeout: { judge: "llm", seconds: 0 } });
    expect(notifyTypes(ctx)).toEqual(["info"]);
    expect(notifyOf(ctx, "info")).toContain(
      "LLM judge model-call timeout cleared (built-in 5 s)",
    );
  });

  it.each([
    "llm timeout 12.5",
    "quick timeout -5",
    "llm timeout 3601",
    "quick timeout ten",
    "llm timeout 1e3",
    "quick timeout 12s",
  ])("%j is refused with the range message and writes nothing", async (args) => {
    const { state, deps } = makeDeps(QTL);
    const before = structuredClone(state.config);
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler(args, ctx);
    expect(deps.write).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
    expect(deps.apply).not.toHaveBeenCalled();
    expect(state.config).toEqual(before);
    expect(notifyTypes(ctx)).toEqual(["error"]);
    expect(notifyOf(ctx, "error")).toContain("whole number of seconds from 0 to 3600");
    expect(notifyOf(ctx, "error")).toContain("llm timeout <seconds> | quick timeout <seconds>");
  });

  it("refuses a timeout form with no value with the usage line", async () => {
    const { deps } = makeDeps(QTL);
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("quick timeout", ctx);
    expect(deps.write).not.toHaveBeenCalled();
    expect(notifyTypes(ctx)).toEqual(["error"]);
    expect(notifyOf(ctx, "error")).toContain("llm timeout <seconds> | quick timeout <seconds>");
  });

  it.each(["llm", "quick", "quick-then-llm"] as const)(
    "sets a judge's budget in mode %s and never changes the mode",
    async (mode) => {
      const { deps } = makeDeps({ ...QTL, mode });
      const command = createPermissionModelCommand(deps);
      await command.handler("llm timeout 10", makeCtx());
      expect(deps.write).toHaveBeenLastCalledWith({ timeout: { judge: "llm", seconds: 10 } });
      await command.handler("quick timeout 10", makeCtx());
      expect(deps.write).toHaveBeenLastCalledWith({ timeout: { judge: "quick", seconds: 10 } });
      for (const call of deps.write.mock.calls) {
        expect(call[0]).not.toHaveProperty("mode");
      }
    },
  );

  it("warns naming timeoutMs when the project layer shadows the LLM judge's budget", async () => {
    const { deps } = makeDeps(QTL);
    deps.reload.mockReturnValue({ config: { ...QTL, timeoutMs: 5000 }, issues: [] });
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("llm timeout 12", ctx);
    expect(notifyTypes(ctx)).toContain("warning");
    expect(notifyOf(ctx, "warning")).toContain(PROJECT_PATH);
    expect(notifyOf(ctx, "warning")).toContain("timeoutMs");
  });

  it("warns naming quickJudge.timeoutMs when the project layer shadows the quick judge's budget", async () => {
    const { deps } = makeDeps(QTL);
    deps.reload.mockReturnValue({ config: QTL, issues: [] });
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("quick timeout 25", ctx);
    expect(notifyOf(ctx, "warning")).toContain(PROJECT_PATH);
    expect(notifyOf(ctx, "warning")).toContain("quickJudge.timeoutMs");
  });

  it("does not warn about shadowing when a clear lands on the built-in default", async () => {
    const { deps } = makeDeps({
      ...QTL,
      quickJudge: { ...QUICK_JUDGE, model: "jev-latest", timeoutMs: 25000 },
    });
    deps.reload.mockReturnValue({ config: QTL, issues: [] });
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("quick timeout 0", ctx);
    expect(notifyTypes(ctx)).toEqual(["info"]);
  });
});

describe("removed and malformed forms", () => {
  it.each([
    "p/m",
    "session",
    "system-one",
    "system-one typesafe/jev-latest",
    "mode",
    "llm",
    "quick",
    "llm p/m extra",
    "quick chat-model",
    "llm timeout 12 34",
  ])("%j writes nothing and reports the usage line", async (args) => {
    const { deps } = makeDeps(WITH_QUICK);
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler(args, ctx);
    expect(deps.write).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(notifyTypes(ctx)).toEqual(["error"]);
    expect(notifyOf(ctx, "error")).toContain(
      "/permission-model mode <llm|quick|quick-then-llm> | llm <provider>/<id> | llm chat-model | quick <provider>/<id>",
    );
  });
});

describe("buildSelectList", () => {
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as PickerRequest["theme"];

  function build(selectedValue: string | undefined) {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const component = buildSelectList({
      tui: FAKE_TUI,
      theme,
      title: "Pick one",
      items: [
        { value: "a", label: "first", description: "the first item" },
        { value: "b", label: "second", description: "the second item" },
      ],
      selectedValue,
      onSelect,
      onCancel,
    }) as Component;
    return { component, onSelect, onCancel };
  }

  it("renders the title, the labels and the descriptions", () => {
    const text = build(undefined).component.render(80).join("\n");
    expect(text).toContain("Pick one");
    expect(text).toContain("second");
    expect(text).toContain("the second item");
  });

  it("preselects the given value, so enter selects it", () => {
    const { component, onSelect } = build("b");
    component.handleInput?.("\r");
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("cancels on escape", () => {
    const { component, onCancel, onSelect } = build("a");
    component.handleInput?.("\u001b");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
