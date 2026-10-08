import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import type { ClassifierConfig } from "#src/config-schema";
import {
  applySessionOverride,
  formatJudgeStatus,
  formatQuickStatus,
  formatTimeoutSeconds,
  type JudgeRegistryLike,
  parseFlagOverride,
  parseJudgePair,
  resolveJudge,
  resolveQuickJudge,
} from "#src/judge";

const SESSION_MODEL = { provider: "anthropic", id: "claude-opus" } as Model<any>;
const CONFIG_MODEL = { provider: "q", id: "n" } as Model<any>;
const OVERRIDE_MODEL = { provider: "p", id: "m" } as Model<any>;

const EMPTY_CONFIG: ClassifierConfig = {
  surfaces: ["bash"],
  timeoutMs: 5000,
  contextBudgetBytes: 8192,
  mode: "llm",
  verdicts: "allow-deny-defer",
  onError: "defer",
};
const CONFIG_QN: ClassifierConfig = {
  ...EMPTY_CONFIG,
  provider: "q",
  model: "n",
};

function registryWith(
  models: Record<string, Model<any>>,
): JudgeRegistryLike & { find: ReturnType<typeof vi.fn> } {
  return {
    find: vi.fn((provider: string, id: string) => models[`${provider}/${id}`]),
  };
}

describe("resolveJudge precedence", () => {
  it("prefers the override over config and session", () => {
    const registry = registryWith({ "p/m": OVERRIDE_MODEL, "q/n": CONFIG_MODEL });
    const judge = resolveJudge(
      { provider: "p", model: "m" },
      CONFIG_QN,
      registry,
      SESSION_MODEL,
    );
    expect(judge).toEqual({
      source: "override",
      pair: { provider: "p", model: "m" },
      model: OVERRIDE_MODEL,
    });
    expect(registry.find).toHaveBeenCalledWith("p", "m");
  });

  it("prefers the config pair over the session model when no override is set", () => {
    const registry = registryWith({ "q/n": CONFIG_MODEL });
    const judge = resolveJudge(undefined, CONFIG_QN, registry, SESSION_MODEL);
    expect(judge).toEqual({
      source: "config",
      pair: { provider: "q", model: "n" },
      model: CONFIG_MODEL,
    });
  });

  it("falls back to the session model when config names no pair", () => {
    const registry = registryWith({});
    const judge = resolveJudge(undefined, EMPTY_CONFIG, registry, SESSION_MODEL);
    expect(judge).toEqual({
      source: "session",
      pair: undefined,
      model: SESSION_MODEL,
    });
    expect(registry.find).not.toHaveBeenCalled();
  });

  it("falls back to the session model when config is undefined", () => {
    const judge = resolveJudge(undefined, undefined, registryWith({}), SESSION_MODEL);
    expect(judge.source).toBe("session");
    expect(judge.model).toBe(SESSION_MODEL);
  });

  it("does not consult the session model for a named pair", () => {
    const judge = resolveJudge(undefined, CONFIG_QN, registryWith({}), SESSION_MODEL);
    expect(judge.source).toBe("config");
    expect(judge.model).toBeUndefined();
  });
});

describe("resolveJudge resolution", () => {
  it("reports an override pair the registry does not know as unresolved", () => {
    const judge = resolveJudge(
      { provider: "p", model: "m" },
      CONFIG_QN,
      registryWith({ "q/n": CONFIG_MODEL }),
      SESSION_MODEL,
    );
    expect(judge.source).toBe("override");
    expect(judge.pair).toEqual({ provider: "p", model: "m" });
    expect(judge.model).toBeUndefined();
  });

  it("reports a config pair the registry does not know as unresolved", () => {
    const judge = resolveJudge(undefined, CONFIG_QN, registryWith({}), SESSION_MODEL);
    expect(judge.model).toBeUndefined();
  });

  it("reports a named pair as unresolved when there is no registry", () => {
    const judge = resolveJudge(undefined, CONFIG_QN, undefined, SESSION_MODEL);
    expect(judge.pair).toEqual({ provider: "q", model: "n" });
    expect(judge.model).toBeUndefined();
  });

  it("carries an undefined session model through as unresolved", () => {
    const judge = resolveJudge(undefined, EMPTY_CONFIG, registryWith({}), undefined);
    expect(judge.source).toBe("session");
    expect(judge.model).toBeUndefined();
  });
});

describe("formatJudgeStatus", () => {
  it("names a resolved pair as judge:<provider>/<id>", () => {
    expect(
      formatJudgeStatus({
        source: "config",
        pair: { provider: "p", model: "m" },
        model: OVERRIDE_MODEL,
      }),
    ).toBe("llm:p/m");
  });

  it("names the session model as llm:chat-model", () => {
    expect(
      formatJudgeStatus({
        source: "session",
        pair: undefined,
        model: SESSION_MODEL,
      }),
    ).toBe("llm:chat-model");
  });

  it("appends (unresolved) when a named pair is not in the registry", () => {
    expect(
      formatJudgeStatus({
        source: "override",
        pair: { provider: "p", model: "m" },
        model: undefined,
      }),
    ).toBe("llm:p/m (unresolved)");
  });

  it("formats the configured pair, not the resolved model's own ids", () => {
    expect(
      formatJudgeStatus({
        source: "config",
        pair: { provider: "q", model: "n" },
        model: OVERRIDE_MODEL,
      }),
    ).toBe("llm:q/n");
  });
});

describe("parseJudgePair", () => {
  it("splits provider and id at the first slash", () => {
    expect(parseJudgePair("p/m")).toEqual({ provider: "p", model: "m" });
  });

  it("keeps later slashes in the id", () => {
    expect(parseJudgePair("openrouter/anthropic/claude-sonnet-5")).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-5",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseJudgePair("  p/m ")).toEqual({ provider: "p", model: "m" });
  });

  it.each(["", "p", "/m", "p/", "/"])("rejects %j", (text) => {
    expect(parseJudgePair(text)).toBeUndefined();
  });
});

describe("system-one judge status", () => {
  const JEV = { provider: "typesafe", id: "jev-latest", type: "classifier" } as never;
  const registry = {
    findOfType: vi.fn((type: string, provider: string, id: string) =>
      type === "classifier" && provider === "typesafe" && id === "jev-latest" ? JEV : undefined,
    ),
  };

  it("renders quick:<provider>/<id> for a classifier the registry knows", () => {
    const judge = resolveQuickJudge({ provider: "typesafe", model: "jev-latest" }, registry);
    expect(judge.model).toBe(JEV);
    expect(formatQuickStatus(judge)).toBe("quick:typesafe/jev-latest");
  });

  it("appends (unresolved) when the classifier lookup fails", () => {
    const judge = resolveQuickJudge({ provider: "typesafe", model: "nope" }, registry);
    expect(formatQuickStatus(judge)).toBe("quick:typesafe/nope (unresolved)");
  });

  it("appends (unresolved) before a registry is captured", () => {
    const judge = resolveQuickJudge({ provider: "typesafe", model: "jev-latest" }, undefined);
    expect(formatQuickStatus(judge)).toBe("quick:typesafe/jev-latest (unresolved)");
  });

  it("renders quick:unset (unresolved) for a quickJudge object with no pair", () => {
    const judge = resolveQuickJudge({}, registry);
    expect(judge.pair).toBeUndefined();
    expect(formatQuickStatus(judge)).toBe("quick:unset (unresolved)");
  });

  it("never looks the pair up as a chat model", () => {
    const chatRegistry = { findOfType: vi.fn(() => undefined), find: vi.fn(() => JEV) };
    const judge = resolveQuickJudge({ provider: "typesafe", model: "jev-latest" }, chatRegistry);
    expect(chatRegistry.find).not.toHaveBeenCalled();
    expect(judge.model).toBeUndefined();
  });
});

describe("parseFlagOverride", () => {
  const JEV = { provider: "typesafe", id: "jev-latest", type: "classifier" } as never;
  const flagRegistry = {
    find: (provider: string, id: string) =>
      provider === "p" && id === "m" ? OVERRIDE_MODEL : undefined,
    findOfType: (_type: "classifier", provider: string, id: string) =>
      provider === "typesafe" && id === "jev-latest" ? JEV : undefined,
  };

  it("reads a full list into mode and both judges", () => {
    expect(
      parseFlagOverride("quick:typesafe/jev-latest,llm:p/m,mode:quick-then-llm", flagRegistry),
    ).toEqual({
      override: {
        quick: { provider: "typesafe", model: "jev-latest" },
        llm: { provider: "p", model: "m" },
        mode: "quick-then-llm",
      },
      warnings: [],
    });
  });

  it("reads llm:chat-model as following the chat model", () => {
    expect(parseFlagOverride("llm:chat-model", flagRegistry)).toEqual({
      override: { llm: null },
      warnings: [],
    });
  });

  it("tolerates spaces and empty items", () => {
    expect(parseFlagOverride(" mode:quick , ,llm:p/m ", flagRegistry).override).toEqual({
      mode: "quick",
      llm: { provider: "p", model: "m" },
    });
  });

  it.each([
    ["llm:nope/x", /nope\/x/],
    ["quick:p/m", /p\/m/],
    ["llm:typesafe/jev-latest", /typesafe\/jev-latest/],
    ["mode:system-one", /system-one/],
    ["judge:p/m", /judge:p\/m/],
    ["nonsense", /nonsense/],
  ])("ignores %j with a warning and keeps the rest", (bad, pattern) => {
    const parsed = parseFlagOverride(`${bad},mode:llm`, flagRegistry);
    expect(parsed.override).toEqual({ mode: "llm" });
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toMatch(pattern);
  });

  it("warns on an unprefixed pair, naming the llm: form, and changes nothing", () => {
    const parsed = parseFlagOverride("p/m", flagRegistry);
    expect(parsed.override).toEqual({});
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain("llm:p/m");
  });

  it("checks no model without a registry", () => {
    const parsed = parseFlagOverride("llm:p/m,quick:typesafe/jev-latest,mode:quick", undefined);
    expect(parsed.override).toEqual({ mode: "quick" });
    expect(parsed.warnings).toHaveLength(2);
  });
});

describe("applySessionOverride", () => {
  it("returns the config itself with no override values", () => {
    expect(applySessionOverride(CONFIG_QN, {})).toBe(CONFIG_QN);
    expect(applySessionOverride(undefined, { mode: "quick" })).toBeUndefined();
  });

  it("replaces mode and the LLM pair", () => {
    const next = applySessionOverride(CONFIG_QN, {
      mode: "quick-then-llm",
      llm: { provider: "p", model: "m" },
    });
    expect(next).toMatchObject({ mode: "quick-then-llm", provider: "p", model: "m" });
  });

  it("removes the LLM pair for the chat model", () => {
    const next = applySessionOverride(CONFIG_QN, { llm: null });
    expect(next?.provider).toBeUndefined();
    expect(next?.model).toBeUndefined();
    expect(next).not.toHaveProperty("provider");
  });

  it("sets the quick pair over the configured quick settings, or the defaults", () => {
    const withQuick: ClassifierConfig = {
      ...EMPTY_CONFIG,
      quickJudge: {
        provider: "local",
        model: "kev",
        verdicts: "allow-deny",
        onError: "deny",
        allowThreshold: 0.8,
        denyThreshold: 0.9,
        guidance: false,
        timeoutMs: 900,
      },
    };
    const quick = { provider: "typesafe", model: "jev-latest" };
    expect(applySessionOverride(withQuick, { quick })?.quickJudge).toEqual({
      ...withQuick.quickJudge,
      ...quick,
    });
    expect(applySessionOverride(EMPTY_CONFIG, { quick })?.quickJudge).toEqual({
      ...quick,
      verdicts: "allow-defer",
      onError: "defer",
      denyThreshold: 0.9,
      guidance: true,
      timeoutMs: 5000,
    });
  });
});

describe("formatTimeoutSeconds", () => {
  it("renders a stored budget in seconds", () => {
    expect(formatTimeoutSeconds(12000)).toBe("12");
    expect(formatTimeoutSeconds(25000)).toBe("25");
  });

  it("keeps the decimals of a budget that is not whole seconds, never rounding", () => {
    expect(formatTimeoutSeconds(2500)).toBe("2.5");
    expect(formatTimeoutSeconds(7500)).toBe("7.5");
    expect(formatTimeoutSeconds(750)).toBe("0.75");
    expect(formatTimeoutSeconds(300)).toBe("0.3");
  });

  it("reads the built-in 5000 ms default when the key is absent", () => {
    expect(formatTimeoutSeconds(undefined)).toBe("5");
  });
});
