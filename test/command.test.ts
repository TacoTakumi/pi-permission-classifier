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
    projectSetsJudge: false,
  };
  const registry = makeRegistry();
  const deps = {
    getConfig: () => state.config,
    getSavedConfig: () => state.config,
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
      projectSetsJudge: false,
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
  it.each(["llm p/m", "llm chat-model", "mode llm", "quick typesafe/jev-latest"])(
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

  it.each(["llm p/m", "llm chat-model", "mode llm", "quick typesafe/jev-latest"])(
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
      projectSetsJudge: true,
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
  ])("warns when the project layer shadows %j", async (args, merged, field) => {
    const { deps } = makeDeps(WITH_QUICK);
    deps.reload.mockReturnValue({
      config: { ...WITH_QUICK, ...merged },
      issues: [],
      projectSetsJudge: false,
    });
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler(args, ctx);
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(notifyOf(ctx, "warning")).toContain(PROJECT_PATH);
    expect(notifyOf(ctx, "warning")).toContain(field);
  });

  it("does not warn when the merged config shows the choice", async () => {
    const { deps } = makeDeps(WITH_QUICK);
    deps.reload.mockReturnValue({
      config: { ...WITH_QUICK, mode: "quick" },
      issues: [],
      projectSetsJudge: false,
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
    "/permission-model mode <llm|quick|quick-then-llm> | llm <provider>/<id> | llm chat-model | quick <provider>/<id>";

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
        `Permission judge mode llm: llm:q/n. Usage: ${USAGE_LINE}`,
      );
    },
  );

  it("prints llm:chat-model when the LLM judge follows the chat model", async () => {
    const { deps } = makeDeps(EMPTY_CONFIG);
    const ctx = makeCtx("rpc");
    await createPermissionModelCommand(deps).handler("  ", ctx);
    expect(notifyOf(ctx, "info")).toContain("mode llm: llm:chat-model.");
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
      "mode quick-then-llm: quick:typesafe/jev-latest, llm:chat-model.",
    );
  });

  it("prints only the quick judge in mode quick, marking an unknown pair", async () => {
    const { deps } = makeDeps({ ...WITH_QUICK, mode: "quick" });
    const ctx = makeCtx("print");
    await createPermissionModelCommand(deps).handler("", ctx);
    expect(notifyOf(ctx, "info")).toContain("mode quick: quick:typesafe/jev (unresolved).");
  });

  it("prints the judge of the config it is handed, flag values included", async () => {
    const { deps } = makeDeps({ ...CONFIG_QN, provider: "p", model: "m" });
    const ctx = makeCtx("rpc");
    await createPermissionModelCommand(deps).handler("", ctx);
    expect(notifyOf(ctx, "info")).toContain("llm:p/m");
  });
});

describe("argument completion", () => {
  function values(prefix: string) {
    const { deps } = makeDeps();
    return createPermissionModelCommand(deps)
      .getArgumentCompletions(prefix)
      ?.map((item) => item.value);
  }

  it("offers the three forms for an empty prefix", () => {
    expect(values("")).toEqual(["mode", "llm", "quick"]);
  });

  it("filters the forms by the typed prefix", () => {
    expect(values("q")).toEqual(["quick"]);
    expect(values("l")).toEqual(["llm"]);
  });

  it("offers the matching modes after 'mode q'", () => {
    expect(values("mode q")).toEqual(["mode quick", "mode quick-then-llm"]);
  });

  it("offers every mode after 'mode '", () => {
    expect(values("mode ")).toEqual(["mode llm", "mode quick", "mode quick-then-llm"]);
  });

  it("offers chat-model and the chat model labels after 'llm '", () => {
    expect(values("llm ")).toEqual([
      "llm chat-model",
      "llm anthropic/a",
      "llm anthropic/b",
      "llm openai/c",
    ]);
  });

  it("filters the chat model labels after 'llm an'", () => {
    expect(values("llm an")).toEqual(["llm anthropic/a", "llm anthropic/b"]);
  });

  it("offers the classifier labels after 'quick ty'", () => {
    expect(values("quick ty")).toEqual(["quick typesafe/jev-latest"]);
  });

  it("labels a second-level item with the value alone", () => {
    const { deps } = makeDeps();
    const items = createPermissionModelCommand(deps).getArgumentCompletions("quick ");
    expect(items?.map((item) => item.label)).toEqual(["typesafe/jev-latest", "local/kev-4b-q8"]);
  });

  it("returns null when nothing matches", () => {
    expect(values("zzz")).toBeUndefined();
    expect(values("quick zz")).toBeUndefined();
    expect(values("session ")).toBeUndefined();
  });

  it("returns null before a session captured the registry", () => {
    const { deps } = makeDeps();
    const command = createPermissionModelCommand({
      ...deps,
      getRegistry: () => undefined,
    });
    expect(command.getArgumentCompletions("llm ")).toBeNull();
  });
});

describe("two-step picker in the TUI", () => {
  /** The request of the n-th mounted step, once the handler has mounted it. */
  async function stepRequest(
    deps: ReturnType<typeof makeDeps>["deps"],
    n: number,
  ): Promise<PickerRequest> {
    await vi.waitFor(() => expect(deps.buildPicker.mock.calls.length).toBeGreaterThan(n));
    return deps.buildPicker.mock.calls[n]![0];
  }

  const JEV_LATEST = { ...QUICK_JUDGE, model: "jev-latest" };

  it("step 1 lists the modes in order with descriptions and the current mode marked", async () => {
    const { deps } = makeDeps({ ...WITH_QUICK, mode: "llm" });
    const ctx = makeCtx("tui");
    const pending = createPermissionModelCommand(deps).handler("", ctx);
    const request = await stepRequest(deps, 0);
    expect(request.tui).toBe(FAKE_TUI);
    expect(request.items.map((item) => item.value)).toEqual(["quick-then-llm", "llm", "quick"]);
    expect(request.items.map((item) => item.label)).toEqual([
      "quick-then-llm",
      "llm (current)",
      "quick",
    ]);
    for (const item of request.items) {
      expect(item.description).toMatch(/\S/);
      expect(item.description).not.toContain("\n");
    }
    expect(request.selectedValue).toBe("llm");
    request.onCancel();
    await pending;
  });

  it("mode llm shows only the LLM list, chat model option first, current pair preselected", async () => {
    const { deps } = makeDeps(CONFIG_QN);
    const ctx = makeCtx("tui");
    const pending = createPermissionModelCommand(deps).handler("", ctx);
    (await stepRequest(deps, 0)).onSelect("llm");
    const llm = await stepRequest(deps, 1);
    expect(llm.title).toMatch(/LLM judge/);
    expect(llm.items[0]).toEqual({
      value: "chat-model",
      label: "Same as the chat model (follows /model)",
    });
    expect(llm.items.slice(1).map((item) => item.value)).toEqual([
      "anthropic/a",
      "anthropic/b",
      "openai/c",
    ]);
    expect(llm.selectedValue).toBe("q/n");
    expect(ctx.modelRegistry.getAvailableOfType).not.toHaveBeenCalled();
    llm.onCancel();
    await pending;
    expect(deps.buildPicker).toHaveBeenCalledTimes(2);
  });

  it("preselects the chat model option when the LLM judge has no pair", async () => {
    const { deps } = makeDeps(EMPTY_CONFIG);
    const pending = createPermissionModelCommand(deps).handler("", makeCtx("tui"));
    (await stepRequest(deps, 0)).onSelect("llm");
    const llm = await stepRequest(deps, 1);
    expect(llm.selectedValue).toBe("chat-model");
    llm.onCancel();
    await pending;
  });

  it("mode quick shows only the quick list of available classifiers, current preselected", async () => {
    const { deps } = makeDeps({ ...WITH_QUICK, quickJudge: JEV_LATEST });
    const ctx = makeCtx("tui");
    const pending = createPermissionModelCommand(deps).handler("", ctx);
    (await stepRequest(deps, 0)).onSelect("quick");
    const quick = await stepRequest(deps, 1);
    expect(quick.title).toMatch(/Quick judge/);
    expect(ctx.modelRegistry.getAvailableOfType).toHaveBeenCalledWith("classifier");
    expect(quick.items.map((item) => item.value)).toEqual([
      "typesafe/jev-latest",
      "local/kev-4b-q8",
    ]);
    expect(quick.selectedValue).toBe("typesafe/jev-latest");
    quick.onSelect("local/kev-4b-q8");
    await pending;
    expect(deps.buildPicker).toHaveBeenCalledTimes(2);
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(deps.write).toHaveBeenCalledWith({
      mode: "quick",
      quick: { provider: "local", model: "kev-4b-q8" },
    });
  });

  it("mode quick-then-llm shows the quick list, then the LLM list, and writes once", async () => {
    const { deps, state, reloaded } = makeDeps(CONFIG_QN);
    const ctx = makeCtx("tui");
    const pending = createPermissionModelCommand(deps).handler("", ctx);
    (await stepRequest(deps, 0)).onSelect("quick-then-llm");
    const quick = await stepRequest(deps, 1);
    expect(quick.title).toMatch(/Quick judge/);
    expect(deps.write).not.toHaveBeenCalled();
    quick.onSelect("typesafe/jev-latest");
    const llm = await stepRequest(deps, 2);
    expect(llm.title).toMatch(/LLM judge/);
    expect(deps.write).not.toHaveBeenCalled();
    llm.onSelect("chat-model");
    await pending;
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(deps.write).toHaveBeenCalledWith({
      mode: "quick-then-llm",
      quick: { provider: "typesafe", model: "jev-latest" },
      llm: null,
    });
    expect(deps.reload).toHaveBeenCalledTimes(1);
    expect(state.config).toBe(reloaded.config);
    expect(notifyOf(ctx, "info")).toContain("mode quick-then-llm");
  });

  it("an LLM model choice writes its pair", async () => {
    const { deps } = makeDeps(EMPTY_CONFIG);
    const pending = createPermissionModelCommand(deps).handler("", makeCtx("tui"));
    (await stepRequest(deps, 0)).onSelect("llm");
    (await stepRequest(deps, 1)).onSelect("anthropic/b");
    await pending;
    expect(deps.write).toHaveBeenCalledWith({
      mode: "llm",
      llm: { provider: "anthropic", model: "b" },
    });
  });

  it("warns after the write when the chosen LLM model has no auth", async () => {
    const { deps } = makeDeps(EMPTY_CONFIG);
    deps.reload.mockReturnValue({
      config: { ...EMPTY_CONFIG, provider: "anthropic", model: "b" },
      issues: [],
      projectSetsJudge: false,
    });
    const ctx = makeCtx("tui");
    ctx.modelRegistry.hasConfiguredAuth.mockReturnValue(false);
    const pending = createPermissionModelCommand(deps).handler("", ctx);
    (await stepRequest(deps, 0)).onSelect("llm");
    (await stepRequest(deps, 1)).onSelect("anthropic/b");
    await pending;
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(notifyTypes(ctx)).toEqual(["info", "warning"]);
    expect(notifyOf(ctx, "warning")).toMatch(/defer/);
  });

  it.each([
    ["step 1", 0, []],
    ["the quick list", 1, ["quick-then-llm"]],
    ["the LLM list", 2, ["quick-then-llm", "typesafe/jev-latest"]],
  ] as const)("a cancel at %s writes nothing", async (_label, cancelAt, choices) => {
    const { state, deps } = makeDeps(CONFIG_QN);
    const before = structuredClone(state.config);
    const ctx = makeCtx("tui");
    const pending = createPermissionModelCommand(deps).handler("", ctx);
    for (const [index, value] of choices.entries()) {
      (await stepRequest(deps, index)).onSelect(value);
    }
    (await stepRequest(deps, cancelAt)).onCancel();
    await pending;
    expect(deps.write).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
    expect(deps.apply).not.toHaveBeenCalled();
    expect(state.config).toEqual(before);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("warns and writes nothing when no classifier model is available", async () => {
    const { deps } = makeDeps(CONFIG_QN);
    const ctx = makeCtx("tui");
    ctx.modelRegistry.getAvailableOfType.mockResolvedValue([]);
    const pending = createPermissionModelCommand(deps).handler("", ctx);
    (await stepRequest(deps, 0)).onSelect("quick");
    await pending;
    expect(deps.buildPicker).toHaveBeenCalledTimes(1);
    expect(deps.write).not.toHaveBeenCalled();
    expect(notifyOf(ctx, "warning")).toMatch(/classifier/);
  });

  it("refuses before opening the picker when the global file is absent", async () => {
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
      projectSetsJudge: true,
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
    projectSetsJudge: false,
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
        projectSetsJudge: false,
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
    "refuses mode %s when only the launch flag sets a quick judge model",
    async (mode) => {
      const { deps } = makeDeps(WITH_QUICK);
      const command = createPermissionModelCommand({
        ...deps,
        getSavedConfig: () => EMPTY_CONFIG,
      });
      const ctx = makeCtx();
      await command.handler(`mode ${mode}`, ctx);
      expect(deps.write).not.toHaveBeenCalled();
      expect(notifyTypes(ctx)).toEqual(["warning"]);
      expect(notifyOf(ctx, "warning")).toContain("/permission-model quick <provider>/<id>");
    },
  );

  it("writes mode llm with no quick judge model", async () => {
    const { deps } = makeDeps(EMPTY_CONFIG);
    deps.reload.mockReturnValue({ config: EMPTY_CONFIG, issues: [], projectSetsJudge: false });
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
