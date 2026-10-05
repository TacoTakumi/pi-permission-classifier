import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import type { ClassifierConfig } from "#src/config-schema";
import {
  formatJudgeStatus,
  formatSystemOneStatus,
  type JudgeRegistryLike,
  parseJudgePair,
  resolveJudge,
  resolveSystemOneJudge,
} from "#src/judge";

const SESSION_MODEL = { provider: "anthropic", id: "claude-opus" } as Model<any>;
const CONFIG_MODEL = { provider: "q", id: "n" } as Model<any>;
const OVERRIDE_MODEL = { provider: "p", id: "m" } as Model<any>;

const EMPTY_CONFIG: ClassifierConfig = {
  surfaces: ["bash"],
  timeoutMs: 5000,
  contextBudgetBytes: 8192,
  classifierEnabled: true,
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
    ).toBe("judge:p/m");
  });

  it("names the session model as judge:session", () => {
    expect(
      formatJudgeStatus({
        source: "session",
        pair: undefined,
        model: SESSION_MODEL,
      }),
    ).toBe("judge:session");
  });

  it("appends (unresolved) when a named pair is not in the registry", () => {
    expect(
      formatJudgeStatus({
        source: "override",
        pair: { provider: "p", model: "m" },
        model: undefined,
      }),
    ).toBe("judge:p/m (unresolved)");
  });

  it("formats the configured pair, not the resolved model's own ids", () => {
    expect(
      formatJudgeStatus({
        source: "config",
        pair: { provider: "q", model: "n" },
        model: OVERRIDE_MODEL,
      }),
    ).toBe("judge:q/n");
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

  it("renders s1:<provider>/<id> for a classifier the registry knows", () => {
    const judge = resolveSystemOneJudge({ provider: "typesafe", model: "jev-latest" }, registry);
    expect(judge.model).toBe(JEV);
    expect(formatSystemOneStatus(judge)).toBe("s1:typesafe/jev-latest");
  });

  it("appends (unresolved) when the classifier lookup fails", () => {
    const judge = resolveSystemOneJudge({ provider: "typesafe", model: "nope" }, registry);
    expect(formatSystemOneStatus(judge)).toBe("s1:typesafe/nope (unresolved)");
  });

  it("appends (unresolved) before a registry is captured", () => {
    const judge = resolveSystemOneJudge({ provider: "typesafe", model: "jev-latest" }, undefined);
    expect(formatSystemOneStatus(judge)).toBe("s1:typesafe/jev-latest (unresolved)");
  });

  it("renders s1:unset (unresolved) for a systemOne object with no pair", () => {
    const judge = resolveSystemOneJudge({}, registry);
    expect(judge.pair).toBeUndefined();
    expect(formatSystemOneStatus(judge)).toBe("s1:unset (unresolved)");
  });

  it("never looks the pair up as a chat model", () => {
    const chatRegistry = { findOfType: vi.fn(() => undefined), find: vi.fn(() => JEV) };
    const judge = resolveSystemOneJudge({ provider: "typesafe", model: "jev-latest" }, chatRegistry);
    expect(chatRegistry.find).not.toHaveBeenCalled();
    expect(judge.model).toBeUndefined();
  });
});
