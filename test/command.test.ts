import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import type { LoadConfigResult } from "#src/config-loader";
import type { ClassifierConfig } from "#src/config-schema";
import {
  type CommandDependencies,
  createPermissionModelCommand,
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

function makeCtx() {
  return {
    cwd: "/project",
    mode: "tui" as const,
    model: SESSION_MODEL,
    modelRegistry: {
      find: vi.fn(findKnown),
      hasConfiguredAuth: vi.fn(() => true),
    },
    ui: { notify: vi.fn() },
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
  const deps = {
    getConfig: () => state.config,
    getOverride: () => state.override,
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
  return { state, reloaded, deps };
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
