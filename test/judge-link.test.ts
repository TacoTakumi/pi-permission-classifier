import type { ClassifierAnswer, ClassifierResult } from "@earendil-works/pi-ai";
import type { AuthorizerLog, PermissionQuery } from "@gotgenes/pi-permission-system";
import { describe, expect, it, vi } from "vitest";

import { CircuitBreaker } from "#src/breaker";
import { type ClassifierConfig, classifierConfigSchema } from "#src/config-schema";
import { createJudgeLink, type JudgeLinkDeps } from "#src/judge-link";
import type { CompleteFn } from "#src/model-review";
import type { QuickJudgeRegistryLike } from "#src/quick-judge";
import { HAZARD_OPTIONS } from "#src/system-one-review";
import { failureDenyReason } from "#src/verdict-policy";
import { assistantToolCall } from "#test/fixtures/assistant-message";
import { askDetails } from "#test/fixtures/details";

const QUERY = {} as PermissionQuery;
const JEV = { provider: "typesafe", id: "jev", type: "classifier" } as never;
const SESSION_MODEL = { provider: "anthropic", id: "claude-opus" } as never;

type LogFn = (event: string, details?: Record<string, unknown>) => void;

function fakeLog(): AuthorizerLog & {
  review: ReturnType<typeof vi.fn<LogFn>>;
  debug: ReturnType<typeof vi.fn<LogFn>>;
} {
  return { review: vi.fn<LogFn>(), debug: vi.fn<LogFn>() };
}

function decisionEntries(log: ReturnType<typeof fakeLog>) {
  return log.review.mock.calls
    .filter(([event]) => event === "classifier.decision")
    .map(([, details]) => details as Record<string, unknown>);
}

function hazardAnswer(probabilities: Record<string, number>): ClassifierAnswer {
  const full: Record<string, number> = Object.fromEntries(
    Object.keys(HAZARD_OPTIONS).map((option) => [option, 0]),
  );
  Object.assign(full, probabilities);
  const choice = Object.entries(full).sort((a, b) => b[1] - a[1])[0]![0];
  return { type: "choice", choice, probabilities: full, confidence: full[choice]! };
}

function answered(
  reversible: number,
  contained: number,
  hazards: Record<string, number>,
): ClassifierResult {
  return {
    api: "typesafe-system-one",
    provider: "typesafe",
    model: "jev",
    answers: {
      reversible: { type: "bool", probability: reversible },
      contained: { type: "bool", probability: contained },
      hazard: hazardAnswer(hazards),
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

const QUICK_ALLOW = answered(0.97, 0.96, { none: 0.98 });
const QUICK_DENY = answered(0.1, 0.9, { force_push: 0.95, none: 0.05 });
const QUICK_UNCERTAIN = answered(0.95, 0.6, { none: 0.9 });
const never = () => new Promise<ClassifierResult>(() => {});

type ClassifyFn = QuickJudgeRegistryLike["classify"];

function config(fields: Record<string, unknown> = {}): ClassifierConfig {
  return classifierConfigSchema.parse(fields);
}

const QUICK_PAIR = { provider: "typesafe", model: "jev" };

interface Harness {
  deps: JudgeLinkDeps;
  classify: ReturnType<typeof vi.fn<ClassifyFn>>;
  complete: ReturnType<typeof vi.fn<CompleteFn>>;
  warn: ReturnType<typeof vi.fn<(message: string) => void>>;
  llmBreaker: CircuitBreaker;
  quickBreaker: CircuitBreaker;
  llmOutcomes: ReturnType<typeof vi.fn>;
  quickOutcomes: ReturnType<typeof vi.fn>;
  setConfig: (next: ClassifierConfig | undefined) => void;
}

function harness(
  initial: ClassifierConfig | undefined,
  options: { classify?: ClassifyFn; llmVerdict?: Record<string, unknown> } = {},
): Harness {
  let current = initial;
  const classify = vi.fn<ClassifyFn>(options.classify ?? (async () => QUICK_ALLOW));
  const complete = vi.fn<CompleteFn>(async () =>
    assistantToolCall(options.llmVerdict ?? { verdict: "allow" }),
  );
  const warn = vi.fn<(message: string) => void>();
  const llmBreaker = new CircuitBreaker();
  const quickBreaker = new CircuitBreaker();
  const llmOutcomes = vi.fn();
  const quickOutcomes = vi.fn();
  const deps: JudgeLinkDeps = {
    getConfig: () => current,
    warn,
    llm: {
      getSessionModel: () => SESSION_MODEL,
      getRegistry: () => ({
        find: vi.fn(() => undefined),
        getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const })),
      }),
      complete,
      breaker: llmBreaker,
      onOutcome: llmOutcomes,
    },
    quick: {
      getRegistry: () => ({
        findOfType: vi.fn((type: string, provider: string, id: string) =>
          type === "classifier" && provider === "typesafe" && id === "jev" ? JEV : undefined,
        ),
        classify,
      }),
      getCwd: () => "/work/repo",
      breaker: quickBreaker,
      onOutcome: quickOutcomes,
    },
  };
  return {
    deps,
    classify,
    complete,
    warn,
    llmBreaker,
    quickBreaker,
    llmOutcomes,
    quickOutcomes,
    setConfig: (next) => {
      current = next;
    },
  };
}

describe("mode llm", () => {
  it("runs only the LLM judge, even with a quickJudge object set", async () => {
    const h = harness(config({ quickJudge: QUICK_PAIR }), { llmVerdict: { verdict: "allow" } });
    const log = fakeLog();
    expect(await createJudgeLink(h.deps)(askDetails(), QUERY, log)).toEqual({ kind: "allow" });
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(decisionEntries(log).map((entry) => entry.judge)).toEqual(["llm"]);
  });

  it("applies the top-level verdicts and onError", async () => {
    const h = harness(config({ verdicts: "allow-defer", quickJudge: QUICK_PAIR }), {
      llmVerdict: { verdict: "deny", reason: "nope" },
    });
    expect(await createJudgeLink(h.deps)(askDetails(), QUERY, fakeLog())).toEqual({
      kind: "defer",
    });

    const strict = harness(config({ onError: "deny" }));
    strict.complete.mockRejectedValue(new Error("down"));
    expect(await createJudgeLink(strict.deps)(askDetails(), QUERY, fakeLog())).toEqual({
      kind: "deny",
      reason: failureDenyReason("call-failed"),
    });
  });

  it("is the mode when no config is loaded", async () => {
    const h = harness(undefined);
    const log = fakeLog();
    expect(await createJudgeLink(h.deps)(askDetails(), QUERY, log)).toEqual({ kind: "defer" });
    expect(h.classify).not.toHaveBeenCalled();
    expect(decisionEntries(log)).toMatchObject([{ judge: "llm", deferReason: "no-config" }]);
  });
});

describe("mode quick", () => {
  it("runs only the quick judge", async () => {
    const h = harness(config({ mode: "quick", quickJudge: QUICK_PAIR }));
    const log = fakeLog();
    expect(await createJudgeLink(h.deps)(askDetails(), QUERY, log)).toEqual({ kind: "allow" });
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(decisionEntries(log).map((entry) => entry.judge)).toEqual(["quick"]);
  });

  it("can deny under quickJudge verdicts allow-deny", async () => {
    const h = harness(
      config({ mode: "quick", quickJudge: { ...QUICK_PAIR, verdicts: "allow-deny" } }),
      { classify: async () => QUICK_DENY },
    );
    const verdict = await createJudgeLink(h.deps)(askDetails(), QUERY, fakeLog());
    expect(verdict.kind).toBe("deny");
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("turns a failure into a deny with the failure reason under onError deny", async () => {
    const h = harness(
      config({ mode: "quick", quickJudge: { provider: "typesafe", model: "nope", onError: "deny" } }),
    );
    expect(await createJudgeLink(h.deps)(askDetails(), QUERY, fakeLog())).toEqual({
      kind: "deny",
      reason: failureDenyReason("model-unresolved"),
    });
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("defers as model-unresolved when no quickJudge object is set", async () => {
    const h = harness(config({ mode: "quick" }));
    const log = fakeLog();
    expect(await createJudgeLink(h.deps)(askDetails(), QUERY, log)).toEqual({ kind: "defer" });
    expect(decisionEntries(log)).toMatchObject([
      { judge: "quick", deferReason: "model-unresolved" },
    ]);
    expect(h.complete).not.toHaveBeenCalled();
  });
});

describe("mode quick-then-llm", () => {
  const cascade = (quickJudge: Record<string, unknown> = {}) =>
    config({ mode: "quick-then-llm", quickJudge: { ...QUICK_PAIR, ...quickJudge } });

  it("ends on a quick allow with no complete call and one entry", async () => {
    const h = harness(cascade());
    const log = fakeLog();
    expect(await createJudgeLink(h.deps)(askDetails(), QUERY, log)).toEqual({ kind: "allow" });
    expect(h.complete).not.toHaveBeenCalled();
    expect(decisionEntries(log).map((entry) => entry.judge)).toEqual(["quick"]);
  });

  it.each([
    ["a quick deny", { classify: async () => QUICK_DENY }, cascade()],
    ["an uncertain answer", { classify: async () => QUICK_UNCERTAIN }, cascade()],
    ["a timeout", { classify: never }, cascade({ timeoutMs: 5 })],
    ["an unresolved model", {}, cascade({ model: "nope" })],
    ["no quickJudge object", {}, config({ mode: "quick-then-llm" })],
  ])("passes %s to the LLM judge, which decides", async (_label, options, given) => {
    const h = harness(given, { ...options, llmVerdict: { verdict: "deny", reason: "risky" } });
    const log = fakeLog();
    expect(await createJudgeLink(h.deps)(askDetails(), QUERY, log)).toEqual({
      kind: "deny",
      reason: "risky",
    });
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(decisionEntries(log).map((entry) => entry.judge)).toEqual(["quick", "llm"]);
  });

  it("forces allow-defer and onError defer on the quick judge and warns once", async () => {
    const h = harness(cascade({ verdicts: "allow-deny", onError: "deny", model: "nope" }), {
      classify: async () => QUICK_DENY,
      llmVerdict: { verdict: "defer" },
    });
    const authorize = createJudgeLink(h.deps);
    for (let i = 0; i < 2; i += 1) {
      const log = fakeLog();
      expect(await authorize(askDetails(), QUERY, log)).toEqual({ kind: "defer" });
      expect(decisionEntries(log)[0]).toMatchObject({ judge: "quick", verdict: "defer" });
    }
    h.setConfig(cascade({ verdicts: "allow-deny" }));
    const log = fakeLog();
    await authorize(askDetails(), QUERY, log);
    expect(decisionEntries(log)[0]).toMatchObject({ judge: "quick", verdict: "defer" });
    expect(h.complete).toHaveBeenCalledTimes(3);
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn.mock.calls[0]![0]).toMatch(/allow-deny/);
    expect(h.warn.mock.calls[0]![0]).toMatch(/quick-then-llm/);
  });

  it("does not warn when quickJudge already asks for allow-defer and onError defer", async () => {
    const h = harness(cascade());
    await createJudgeLink(h.deps)(askDetails(), QUERY, fakeLog());
    expect(h.warn).not.toHaveBeenCalled();
  });

  it("keeps the breakers apart: quick timeouts never open the LLM breaker", async () => {
    const h = harness(cascade({ timeoutMs: 5 }), { classify: never });
    const authorize = createJudgeLink(h.deps);
    for (let i = 0; i < 3; i += 1) {
      await authorize(askDetails(), QUERY, fakeLog());
    }
    expect(h.quickBreaker.isOpen()).toBe(true);
    expect(h.llmBreaker.isOpen()).toBe(false);
    const log = fakeLog();
    expect(await authorize(askDetails(), QUERY, log)).toEqual({ kind: "allow" });
    expect(h.complete).toHaveBeenCalledTimes(4);
    expect(decisionEntries(log)).toMatchObject([
      { judge: "quick", deferReason: "breaker-open" },
      { judge: "llm", verdict: "allow" },
    ]);
    expect(h.llmOutcomes).not.toHaveBeenCalledWith(
      expect.objectContaining({ verdict: "defer" }),
    );
    expect(h.quickOutcomes).toHaveBeenCalledWith({ verdict: "defer", deferReason: "timeout" });
  });
});

describe("live mode", () => {
  it("reads the mode per ask", async () => {
    const h = harness(config({ quickJudge: QUICK_PAIR }));
    const authorize = createJudgeLink(h.deps);
    await authorize(askDetails(), QUERY, fakeLog());
    expect(h.classify).not.toHaveBeenCalled();
    h.setConfig(config({ mode: "quick-then-llm", quickJudge: QUICK_PAIR }));
    await authorize(askDetails(), QUERY, fakeLog());
    expect(h.classify).toHaveBeenCalledTimes(1);
    h.setConfig(config({ mode: "quick", quickJudge: QUICK_PAIR }));
    await authorize(askDetails(), QUERY, fakeLog());
    expect(h.classify).toHaveBeenCalledTimes(2);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it("defers and never throws when reading the config throws", async () => {
    const h = harness(config());
    const authorize = createJudgeLink({
      ...h.deps,
      getConfig: () => {
        throw new Error("config down");
      },
    });
    expect(await authorize(askDetails(), QUERY, fakeLog())).toEqual({ kind: "defer" });
  });
});

describe("failures never allow", () => {
  const throwing = () => {
    throw new Error("down");
  };
  type Failure = [string, "llm" | "quick", (h: Harness) => void, Record<string, unknown>];
  const failures: Failure[] = [
    ["llm call failed", "llm", (h) => h.complete.mockRejectedValue(new Error("down")), {}],
    [
      "llm registry throws",
      "llm",
      (h) => {
        h.deps.llm.getRegistry = throwing;
      },
      {},
    ],
    [
      "no session model",
      "llm",
      (h) => {
        h.deps.llm.getSessionModel = () => undefined;
      },
      {},
    ],
    ["quick call failed", "quick", (h) => h.classify.mockRejectedValue(new Error("down")), {}],
    ["quick timeout", "quick", (h) => h.classify.mockImplementation(never), { timeoutMs: 5 }],
    [
      "quick registry throws",
      "quick",
      (h) => {
        h.deps.quick.getRegistry = throwing;
      },
      {},
    ],
    ["quick model unresolved", "quick", () => {}, { model: "nope" }],
  ];

  it.each(failures)(
    "%s never yields allow in any mode or policy",
    async (_label, judge, breakIt, quick) => {
      for (const mode of ["llm", "quick", "quick-then-llm"] as const) {
        if (mode !== "quick-then-llm" && mode !== judge) {
          continue;
        }
        for (const verdicts of ["allow-deny-defer", "allow-defer", "allow-deny"] as const) {
          for (const onError of ["defer", "deny"] as const) {
            const given = config({
              mode,
              verdicts,
              onError,
              quickJudge: { ...QUICK_PAIR, verdicts, onError, ...quick },
            });
            const h = harness(given, { llmVerdict: { verdict: "allow" } });
            breakIt(h);
            // In the cascade the other judge must not allow either, so the
            // failure is what decides.
            if (mode === "quick-then-llm" && judge === "llm") {
              h.classify.mockImplementation(async () => QUICK_UNCERTAIN);
            }
            if (mode === "quick-then-llm" && judge === "quick") {
              h.complete.mockRejectedValue(new Error("down"));
            }
            const verdict = await createJudgeLink(h.deps)(askDetails(), QUERY, fakeLog());
            expect(verdict.kind, `${mode} ${verdicts} ${onError}`).not.toBe("allow");
          }
        }
      }
    },
  );
});

describe("user intent", () => {
  it("hands the link's intent reader to the quick judge", async () => {
    const h = harness(config({ mode: "quick", quickJudge: QUICK_PAIR }));
    const getUserIntent = vi.fn(() => ({ messages: ["push it"] }));
    const authorize = createJudgeLink({ ...h.deps, getUserIntent });
    await authorize(askDetails(), QUERY, fakeLog());
    expect(getUserIntent).toHaveBeenCalledWith(false);
    expect(h.classify.mock.calls[0]![1].state.user_messages).toEqual(["push it"]);
  });

  it("hands the link's intent reader to the LLM judge", async () => {
    const h = harness(config({ mode: "llm" }));
    const authorize = createJudgeLink({ ...h.deps, getUserIntent: () => ({ messages: ["push it"] }) });
    await authorize(askDetails(), QUERY, fakeLog());
    const prompt = (h.complete.mock.calls[0]![1] as { messages: { content: string }[] }).messages[0]!
      .content;
    expect(prompt).toContain("<user-message>\npush it\n</user-message>");
  });

  it("gives both judges the intent in mode quick-then-llm", async () => {
    const h = harness(config({ mode: "quick-then-llm", quickJudge: QUICK_PAIR }), {
      classify: async () => QUICK_UNCERTAIN,
    });
    const getUserIntent = vi.fn(() => ({ messages: ["push it"] }));
    await createJudgeLink({ ...h.deps, getUserIntent })(askDetails(), QUERY, fakeLog());
    expect(h.classify.mock.calls[0]![1].state.user_messages).toEqual(["push it"]);
    const prompt = (h.complete.mock.calls[0]![1] as { messages: { content: string }[] }).messages[0]!
      .content;
    expect(prompt).toContain("<user-messages>");
  });

  it("sends today's quick request with no intent reader", async () => {
    const h = harness(config({ mode: "quick", quickJudge: QUICK_PAIR }));
    await createJudgeLink(h.deps)(askDetails(), QUERY, fakeLog());
    expect(h.classify.mock.calls[0]![1].state).not.toHaveProperty("user_messages");
  });
});
