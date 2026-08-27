import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import type { LoadConfigResult } from "#src/config-loader";
import type { ClassifierConfig } from "#src/config-schema";
import {
  type CommandContextLike,
  type CommandDependencies,
  createPermissionModelCommand,
  type PickerComponent,
  type PickerRequest,
  type PickerSeam,
  type PickerTui,
} from "#src/command";
import { type JudgePair, resolveJudge } from "#src/judge";

const SESSION_MODEL = { provider: "anthropic", id: "claude-opus" } as Model<any>;
const PM_MODEL = { provider: "p", id: "m" } as Model<any>;
const QN_MODEL = { provider: "q", id: "n" } as Model<any>;

const EMPTY_CONFIG: ClassifierConfig = { surfaces: ["bash"], timeoutMs: 5000 };
const CONFIG_QN: ClassifierConfig = { ...EMPTY_CONFIG, provider: "q", model: "n" };

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

function makeRegistry(options: { runtime?: boolean } = {}) {
  return {
    find: vi.fn(findKnown),
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
  const state: {
    config: ClassifierConfig | undefined;
    override: JudgePair | undefined;
  } = { config: initial, override: undefined };
  const reloaded: LoadConfigResult = {
    config: { ...EMPTY_CONFIG, provider: "p", model: "m" },
    issues: [],
    projectSetsJudge: false,
  };
  const registry = makeRegistry();
  const deps = {
    getConfig: () => state.config,
    getOverride: () => state.override,
    getRegistry: () => registry,
    buildPicker: vi.fn<PickerSeam>(() => FAKE_COMPONENT),
    globalConfigExists: vi.fn<CommandDependencies["globalConfigExists"]>(
      () => true,
    ),
    globalConfigPath: () => GLOBAL_PATH,
    projectConfigPath: (cwd: string) =>
      `${cwd}/.pi/extensions/pi-permission-classifier/config.json`,
    writeJudge: vi.fn<CommandDependencies["writeJudge"]>(),
    reload: vi.fn<CommandDependencies["reload"]>(() => reloaded),
    apply: vi.fn<CommandDependencies["apply"]>((config) => {
      state.config = config;
      state.override = undefined;
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

describe("/permission-model registration surface (REQ-01)", () => {
  it("exposes a non-empty description and a completion hook", () => {
    const command = createPermissionModelCommand(makeDeps().deps);
    expect(typeof command.description).toBe("string");
    expect(command.description.length).toBeGreaterThan(0);
    expect(typeof command.getArgumentCompletions).toBe("function");
    expect(typeof command.handler).toBe("function");
  });
});

describe("typed form /permission-model <provider>/<id>", () => {
  it("writes p/m, reloads through the loader, applies the reloaded config, and notifies info (REQ-02, REQ-13)", async () => {
    const { state, reloaded, deps } = makeDeps();
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("p/m", ctx);
    expect(deps.writeJudge).toHaveBeenCalledTimes(1);
    expect(deps.writeJudge).toHaveBeenCalledWith("p", "m");
    expect(deps.reload).toHaveBeenCalledTimes(1);
    expect(deps.reload).toHaveBeenCalledWith("/project");
    expect(deps.reload.mock.invocationCallOrder[0]).toBeGreaterThan(
      deps.writeJudge.mock.invocationCallOrder[0]!,
    );
    expect(deps.apply).toHaveBeenCalledWith(reloaded.config);
    expect(state.config).toBe(reloaded.config);
    expect(notifyTypes(ctx)).toEqual(["info"]);
    expect(notifyOf(ctx, "info")).toContain("p/m");
  });

  it("resolves the pair through the registry", async () => {
    const { deps } = makeDeps();
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("p/m", ctx);
    expect(ctx.modelRegistry.find).toHaveBeenCalledWith("p", "m");
  });

  it("rejects a pair the registry does not know: nothing written, config unchanged, error names the pair (REQ-03, REQ-22)", async () => {
    const { state, deps } = makeDeps(CONFIG_QN);
    const before = structuredClone(state.config);
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("nope/x", ctx);
    expect(deps.writeJudge).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
    expect(deps.apply).not.toHaveBeenCalled();
    expect(state.config).toEqual(before);
    expect(notifyTypes(ctx)).toEqual(["error"]);
    expect(notifyOf(ctx, "error")).toContain("nope/x");
  });

  it("rejects a reference without a slash with an error naming the usage", async () => {
    const { deps } = makeDeps();
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("nonsense", ctx);
    expect(deps.writeJudge).not.toHaveBeenCalled();
    expect(notifyTypes(ctx)).toEqual(["error"]);
    expect(notifyOf(ctx, "error")).toContain("<provider>/<id>");
  });

  it("accepts a known model without auth: writes it and warns that asks defer (REQ-04)", async () => {
    const { deps } = makeDeps();
    const ctx = makeCtx();
    ctx.modelRegistry.hasConfiguredAuth.mockReturnValue(false);
    await createPermissionModelCommand(deps).handler("p/m", ctx);
    expect(ctx.modelRegistry.hasConfiguredAuth).toHaveBeenCalledWith(PM_MODEL);
    expect(deps.writeJudge).toHaveBeenCalledTimes(1);
    expect(deps.writeJudge).toHaveBeenCalledWith("p", "m");
    expect(notifyTypes(ctx)).toContain("warning");
    expect(notifyOf(ctx, "warning")).toMatch(/defer/);
  });
});

describe("session form /permission-model session (REQ-05)", () => {
  it("removes both keys, applies the reloaded config, and the session model judges again", async () => {
    const { state, deps } = makeDeps(CONFIG_QN);
    deps.reload.mockReturnValue({
      config: EMPTY_CONFIG,
      issues: [],
      projectSetsJudge: false,
    });
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("session", ctx);
    expect(deps.writeJudge).toHaveBeenCalledTimes(1);
    expect(deps.writeJudge).toHaveBeenCalledWith(undefined, undefined);
    expect(deps.reload).toHaveBeenCalledWith("/project");
    expect(state.config?.provider).toBeUndefined();
    expect(state.config?.model).toBeUndefined();
    expect(
      resolveJudge(undefined, state.config, ctx.modelRegistry, SESSION_MODEL)
        .model,
    ).toBe(SESSION_MODEL);
    expect(notifyTypes(ctx)).toEqual(["info"]);
    expect(notifyOf(ctx, "info")).toMatch(/session/);
  });

  it("does not consult the registry", async () => {
    const { deps } = makeDeps(CONFIG_QN);
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("session", ctx);
    expect(ctx.modelRegistry.find).not.toHaveBeenCalled();
  });
});

describe("refusal when there is no valid config or no global file (REQ-08)", () => {
  it.each(["p/m", "session"])(
    "%j refuses with a warning naming the global path when the link is not registered",
    async (args) => {
      const { state, deps } = makeDeps();
      state.config = undefined;
      const ctx = makeCtx();
      await createPermissionModelCommand(deps).handler(args, ctx);
      expect(deps.writeJudge).not.toHaveBeenCalled();
      expect(deps.reload).not.toHaveBeenCalled();
      expect(notifyTypes(ctx)).toEqual(["warning"]);
      expect(notifyOf(ctx, "warning")).toContain(GLOBAL_PATH);
    },
  );

  it.each(["p/m", "session"])(
    "%j refuses with a warning naming the global path when the global file is absent",
    async (args) => {
      const { state, deps } = makeDeps(CONFIG_QN);
      deps.globalConfigExists.mockReturnValue(false);
      const before = structuredClone(state.config);
      const ctx = makeCtx();
      await createPermissionModelCommand(deps).handler(args, ctx);
      expect(deps.writeJudge).not.toHaveBeenCalled();
      expect(state.config).toEqual(before);
      expect(notifyTypes(ctx)).toEqual(["warning"]);
      expect(notifyOf(ctx, "warning")).toContain(GLOBAL_PATH);
    },
  );
});

describe("project layer shadowing the choice (REQ-14)", () => {
  it("still writes the global file and warns naming the project config path", async () => {
    const { deps } = makeDeps();
    deps.reload.mockReturnValue({
      config: CONFIG_QN,
      issues: [],
      projectSetsJudge: true,
    });
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("p/m", ctx);
    expect(deps.writeJudge).toHaveBeenCalledTimes(1);
    expect(deps.writeJudge).toHaveBeenCalledWith("p", "m");
    expect(deps.apply).toHaveBeenCalledWith(CONFIG_QN);
    expect(notifyTypes(ctx)).toContain("warning");
    expect(notifyOf(ctx, "warning")).toContain(PROJECT_PATH);
  });
});

describe("write failure (REQ-22)", () => {
  it("leaves the config unchanged, skips the reload, and notifies error", async () => {
    const { state, deps } = makeDeps(CONFIG_QN);
    deps.writeJudge.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });
    const before = structuredClone(state.config);
    const ctx = makeCtx();
    await createPermissionModelCommand(deps).handler("p/m", ctx);
    expect(deps.reload).not.toHaveBeenCalled();
    expect(deps.apply).not.toHaveBeenCalled();
    expect(state.config).toEqual(before);
    expect(notifyTypes(ctx)).toEqual(["error"]);
    expect(notifyOf(ctx, "error")).toContain("EACCES");
  });
});

describe("no-argument form outside the TUI (REQ-06)", () => {
  it.each(["rpc", "json", "print"] as const)(
    "in %s mode opens no picker and prints the current judge and usage",
    async (mode) => {
      const { deps } = makeDeps(CONFIG_QN);
      const ctx = makeCtx(mode);
      await createPermissionModelCommand(deps).handler("", ctx);
      expect(ctx.ui.custom).not.toHaveBeenCalled();
      expect(ctx.ui.select).not.toHaveBeenCalled();
      expect(deps.writeJudge).not.toHaveBeenCalled();
      expect(notifyTypes(ctx)).toEqual(["info"]);
      expect(notifyOf(ctx, "info")).toContain("judge:q/n");
      expect(notifyOf(ctx, "info")).toContain("/permission-model");
    },
  );

  it("prints judge:session when the session model judges", async () => {
    const { deps } = makeDeps(EMPTY_CONFIG);
    const ctx = makeCtx("rpc");
    await createPermissionModelCommand(deps).handler("  ", ctx);
    expect(notifyOf(ctx, "info")).toContain("judge:session");
  });

  it("prints the active flag override ahead of the config judge", async () => {
    const { state, deps } = makeDeps(CONFIG_QN);
    state.override = { provider: "p", model: "m" };
    const ctx = makeCtx("rpc");
    await createPermissionModelCommand(deps).handler("", ctx);
    expect(notifyOf(ctx, "info")).toContain("judge:p/m");
  });
});

describe("argument completion (REQ-07)", () => {
  it("offers provider/id labels whose label starts with the prefix", () => {
    const { deps } = makeDeps();
    const items = createPermissionModelCommand(deps).getArgumentCompletions(
      "anth",
    );
    expect(items?.map((item) => item.value)).toEqual([
      "anthropic/a",
      "anthropic/b",
    ]);
    expect(items?.map((item) => item.label)).toEqual([
      "anthropic/a",
      "anthropic/b",
    ]);
  });

  it("offers the literal session when it matches", () => {
    const { deps } = makeDeps();
    const items = createPermissionModelCommand(deps).getArgumentCompletions(
      "ses",
    );
    expect(items?.map((item) => item.value)).toEqual(["session"]);
  });

  it("offers everything for an empty prefix", () => {
    const { deps } = makeDeps();
    const items = createPermissionModelCommand(deps).getArgumentCompletions("");
    expect(items?.map((item) => item.value)).toEqual([
      "anthropic/a",
      "anthropic/b",
      "openai/c",
      "session",
    ]);
  });

  it("returns null when nothing matches", () => {
    const { deps } = makeDeps();
    expect(
      createPermissionModelCommand(deps).getArgumentCompletions("zzz"),
    ).toBeNull();
  });

  it("returns null before a session captured the registry", () => {
    const { deps } = makeDeps();
    const command = createPermissionModelCommand({
      ...deps,
      getRegistry: () => undefined,
    });
    expect(command.getArgumentCompletions("anth")).toBeNull();
  });
});

describe("picker in the TUI (REQ-09, REQ-11)", () => {
  function pickerRequest(deps: ReturnType<typeof makeDeps>["deps"]): PickerRequest {
    return deps.buildPicker.mock.calls[0]![0];
  }

  it("mounts the picker once through ui.custom with the runtime, scoped models, and current judge preselected", async () => {
    const { deps } = makeDeps(CONFIG_QN);
    const ctx = makeCtx("tui");
    const pending = createPermissionModelCommand(deps).handler("", ctx);
    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
    expect(deps.buildPicker).toHaveBeenCalledTimes(1);
    const request = pickerRequest(deps);
    expect(request.tui).toBe(FAKE_TUI);
    expect(request.runtime).toBe(ctx.modelRegistry.runtime);
    expect(request.scopedModels).toBe(ctx.scopedModels);
    expect(request.currentModel).toBe(QN_MODEL);
    request.onCancel();
    await pending;
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("preselects the session model when the session model judges", async () => {
    const { deps } = makeDeps(EMPTY_CONFIG);
    const ctx = makeCtx("tui");
    const pending = createPermissionModelCommand(deps).handler("", ctx);
    expect(pickerRequest(deps).currentModel).toBe(SESSION_MODEL);
    pickerRequest(deps).onCancel();
    await pending;
  });

  it("a selection applies like the typed form", async () => {
    const { state, reloaded, deps } = makeDeps(CONFIG_QN);
    const ctx = makeCtx("tui");
    const pending = createPermissionModelCommand(deps).handler("", ctx);
    pickerRequest(deps).onSelect(PM_MODEL);
    await pending;
    expect(deps.writeJudge).toHaveBeenCalledTimes(1);
    expect(deps.writeJudge).toHaveBeenCalledWith("p", "m");
    expect(deps.reload).toHaveBeenCalledWith("/project");
    expect(state.config).toBe(reloaded.config);
    expect(notifyTypes(ctx)).toEqual(["info"]);
    expect(notifyOf(ctx, "info")).toContain("p/m");
  });

  it("a selection without configured auth is persisted with a warning", async () => {
    const { deps } = makeDeps(CONFIG_QN);
    const ctx = makeCtx("tui");
    ctx.modelRegistry.hasConfiguredAuth.mockReturnValue(false);
    const pending = createPermissionModelCommand(deps).handler("", ctx);
    pickerRequest(deps).onSelect(PM_MODEL);
    await pending;
    expect(deps.writeJudge).toHaveBeenCalledTimes(1);
    expect(notifyTypes(ctx)).toContain("warning");
  });

  it("a cancel changes nothing", async () => {
    const { state, deps } = makeDeps(CONFIG_QN);
    const before = structuredClone(state.config);
    const ctx = makeCtx("tui");
    const pending = createPermissionModelCommand(deps).handler("", ctx);
    pickerRequest(deps).onCancel();
    await pending;
    expect(deps.writeJudge).not.toHaveBeenCalled();
    expect(deps.apply).not.toHaveBeenCalled();
    expect(state.config).toEqual(before);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
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

describe("degraded picker without a runtime shape (REQ-10, REQ-22)", () => {
  const LABELS = ["anthropic/a", "anthropic/b", "openai/c"];

  it("falls back to ui.select over provider/id labels and warns that the picker degraded", async () => {
    const { deps } = makeDeps(CONFIG_QN);
    const ctx = makeCtx("tui", { runtime: false });
    ctx.ui.select.mockResolvedValue(undefined);
    await createPermissionModelCommand(deps).handler("", ctx);
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(deps.buildPicker).not.toHaveBeenCalled();
    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
    expect(ctx.ui.select).toHaveBeenCalledWith(expect.any(String), LABELS);
    expect(notifyTypes(ctx)).toContain("warning");
    expect(notifyOf(ctx, "warning")).toMatch(/degraded/);
  });

  it("a chosen label applies like the typed form", async () => {
    const { state, reloaded, deps } = makeDeps(CONFIG_QN);
    const ctx = makeCtx("tui", { runtime: false });
    ctx.ui.select.mockResolvedValue("p/m");
    await createPermissionModelCommand(deps).handler("", ctx);
    expect(ctx.modelRegistry.find).toHaveBeenCalledWith("p", "m");
    expect(deps.writeJudge).toHaveBeenCalledTimes(1);
    expect(deps.writeJudge).toHaveBeenCalledWith("p", "m");
    expect(state.config).toBe(reloaded.config);
    expect(notifyTypes(ctx)).toContain("info");
  });

  it("a cancel changes nothing", async () => {
    const { state, deps } = makeDeps(CONFIG_QN);
    const before = structuredClone(state.config);
    const ctx = makeCtx("tui", { runtime: false });
    ctx.ui.select.mockResolvedValue(undefined);
    await createPermissionModelCommand(deps).handler("", ctx);
    expect(deps.writeJudge).not.toHaveBeenCalled();
    expect(deps.apply).not.toHaveBeenCalled();
    expect(state.config).toEqual(before);
  });

  it("a runtime without getAvailableSnapshot counts as no runtime", async () => {
    const { deps } = makeDeps(CONFIG_QN);
    const ctx = makeCtx("tui", { runtime: false });
    (ctx.modelRegistry as { runtime?: unknown }).runtime = { other: () => [] };
    ctx.ui.select.mockResolvedValue(undefined);
    await createPermissionModelCommand(deps).handler("", ctx);
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
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
    await createPermissionModelCommand(deps).handler("session", ctx);
    expect(deps.writeJudge).toHaveBeenCalledWith(undefined, undefined);
    expect(deps.apply).not.toHaveBeenCalled();
    expect(state.config).toEqual(before);
    expect(notifyTypes(ctx)).toEqual(["error"]);
    expect(notifyOf(ctx, "error")).toContain("must be set together");
    expect(notifyOf(ctx, "error")).toContain(GLOBAL_PATH);
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
    await createPermissionModelCommand(deps).handler("p/m", ctx);
    expect(deps.apply).toHaveBeenCalledWith(reloaded.config);
    expect(state.config).toBe(reloaded.config);
    expect(notifyTypes(ctx)).toEqual(["info", "warning"]);
    expect(notifyOf(ctx, "warning")).toContain("bad json");
    expect(notifyOf(ctx, "warning")).toContain(PROJECT_PATH);
  });
});

describe("no-argument form without a valid config (review round 1, F3)", () => {
  it("outside the TUI says the classifier is not set up instead of naming a judge", async () => {
    const { state, deps } = makeDeps();
    state.config = undefined;
    const ctx = makeCtx("rpc");
    await createPermissionModelCommand(deps).handler("", ctx);
    expect(notifyTypes(ctx)).toEqual(["warning"]);
    expect(notifyOf(ctx, "warning")).toContain(GLOBAL_PATH);
    expect(notifyOf(ctx, "warning")).not.toContain("judge:session");
  });
});

describe("auth warning only after a successful write (review round 2)", () => {
  it("does not warn about auth when the write failed", async () => {
    const { deps } = makeDeps(CONFIG_QN);
    deps.writeJudge.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });
    const ctx = makeCtx();
    ctx.modelRegistry.hasConfiguredAuth.mockReturnValue(false);
    await createPermissionModelCommand(deps).handler("p/m", ctx);
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
