import type { ClassifierAnswer, ClassifierResult } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import type { FullCommandContext } from "#src/context";
import type { IncludedGuidance } from "#src/guidance";
import {
  ALLOW_THRESHOLDS,
  buildSystemOneContext,
  HAZARD_OPTIONS,
  mapSystemOneResult,
  SYSTEM_ONE_QUESTIONS,
} from "#src/system-one-review";
import { askDetails } from "#test/fixtures/details";

const FULL: FullCommandContext = {
  text: "git status && git push --force",
  bytes: 30,
  hash12: "abcdefabcdef",
};

const GUIDANCE: IncludedGuidance[] = [
  {
    path: "/home/you/.pi/agent/AGENTS.md",
    content: "Force pushes to main are never fine.",
    bytes: 36,
    hash12: "0123456789ab",
    isGlobal: true,
  },
];

describe("SYSTEM_ONE_QUESTIONS", () => {
  it("asks exactly reversible, contained and hazard with the right types", () => {
    expect(Object.keys(SYSTEM_ONE_QUESTIONS).sort()).toEqual([
      "contained",
      "hazard",
      "reversible",
    ]);
    expect(SYSTEM_ONE_QUESTIONS.reversible?.type).toBe("bool");
    expect(SYSTEM_ONE_QUESTIONS.contained?.type).toBe("bool");
    expect(SYSTEM_ONE_QUESTIONS.hazard?.type).toBe("choice");
  });

  it("offers the nine hazard options, none first", () => {
    const hazard = SYSTEM_ONE_QUESTIONS.hazard;
    if (hazard?.type !== "choice") {
      throw new Error("hazard is not a choice question");
    }
    expect(Object.keys(hazard.criteria)).toEqual([
      "none",
      "credential_access",
      "secret_exfiltration",
      "push_or_publish",
      "remote_code_execution",
      "force_push",
      "discard_uncommitted_work",
      "disarm_guards",
      "other_destructive",
    ]);
    expect(Object.keys(HAZARD_OPTIONS)).toEqual(Object.keys(hazard.criteria));
  });

  it("splits sending secrets out from pushing or publishing project work", () => {
    const hazard = SYSTEM_ONE_QUESTIONS.hazard;
    if (hazard?.type !== "choice") {
      throw new Error("hazard is not a choice question");
    }
    expect(Object.keys(hazard.criteria)).not.toContain("exfiltration");
    expect(hazard.criteria.secret_exfiltration).toMatch(/secrets or credentials/);
    expect(hazard.criteria.secret_exfiltration).toMatch(/outside this machine/);
    expect(hazard.criteria.push_or_publish).toMatch(/git push/);
    expect(hazard.criteria.push_or_publish).toMatch(/publish/);
    expect(HAZARD_OPTIONS.secret_exfiltration).toBe("secret exfiltration");
    expect(HAZARD_OPTIONS.push_or_publish).toBe("a push or publish");
  });

  it("counts the project's own toolchain and its caches as contained", () => {
    const contained = SYSTEM_ONE_QUESTIONS.contained;
    if (contained?.type !== "bool") {
      throw new Error("contained is not a bool question");
    }
    expect(contained.instructions).toMatch(/Contained means/);
    expect(contained.instructions).toMatch(/project's own build, run and test tools/);
    expect(contained.instructions).toMatch(/caches, build output, temp files and display/);
    expect(contained.criteria.true).toMatch(/^Contained:/);
    expect(contained.criteria.false).toMatch(/^Not contained:/);
  });

  it("keeps secrets, data sent out and changes elsewhere outside contained", () => {
    const text = JSON.stringify(SYSTEM_ONE_QUESTIONS.contained);
    expect(text).toMatch(/\/tmp/);
    expect(text).toMatch(/reads a secret/);
    expect(text).toMatch(/\.env files or the environment/);
    expect(text).toMatch(/sends data off this machine/);
    expect(text).toMatch(/changes files outside the project/);
  });

  it("counts regenerable output as reversible and keeps the guard cases irreversible", () => {
    const text = JSON.stringify(SYSTEM_ONE_QUESTIONS.reversible);
    expect(text).toMatch(/caches, build output, test output/);
    expect(text).toMatch(/files that git does not hold/);
    expect(text).toMatch(/discards uncommitted work/);
    expect(text).toMatch(/rewrites git history/);
    expect(text).toMatch(/publishes or pushes a change/);
    expect(text).toMatch(/sends a message/);
  });

  it("ships the per-question allow thresholds the eval chose", () => {
    expect(ALLOW_THRESHOLDS).toEqual({ reversible: 0.8, contained: 0.8, none: 0.8 });
  });
});

describe("buildSystemOneContext", () => {
  it("carries value, surface, tool, cwd and the in-budget full command", () => {
    const context = buildSystemOneContext({
      details: askDetails({ value: "git push --force" }),
      surface: "bash",
      cwd: "/work/repo",
      fullCommand: FULL,
      contextBudgetBytes: 8192,
    });
    expect(context.questions).toBe(SYSTEM_ONE_QUESTIONS);
    expect(context.state).toEqual({
      value: "git push --force",
      surface: "bash",
      tool: "bash",
      cwd: "/work/repo",
      fullCommand: FULL.text,
    });
  });

  it("omits a full command over the budget", () => {
    const context = buildSystemOneContext({
      details: askDetails(),
      surface: "bash",
      cwd: "/work/repo",
      fullCommand: FULL,
      contextBudgetBytes: 10,
    });
    expect(context.state).not.toHaveProperty("fullCommand");
  });

  it("omits the full command when there is none", () => {
    const context = buildSystemOneContext({
      details: askDetails(),
      surface: "bash",
      cwd: "/work/repo",
      fullCommand: null,
      contextBudgetBytes: 8192,
    });
    expect(context.state).not.toHaveProperty("fullCommand");
  });

  it("adds guidance files by path and content when given", () => {
    const context = buildSystemOneContext({
      details: askDetails(),
      surface: "bash",
      cwd: "/work/repo",
      fullCommand: null,
      contextBudgetBytes: 8192,
      guidance: GUIDANCE,
    });
    expect(context.state.guidance).toEqual([
      { path: GUIDANCE[0]!.path, content: GUIDANCE[0]!.content },
    ]);
  });

  it("omits guidance when none is passed", () => {
    const context = buildSystemOneContext({
      details: askDetails(),
      surface: "bash",
      cwd: "/work/repo",
      fullCommand: null,
      contextBudgetBytes: 8192,
    });
    expect(context.state).not.toHaveProperty("guidance");
  });

  it("never carries evidence, annotations or the tool input preview", () => {
    const base = askDetails(
      { value: "cat notes.txt" },
      { toolInputPreview: "PREVIEW-SECRET-TEXT" },
    );
    const details = {
      ...base,
      payload: {
        ...base.payload,
        evidence: [{ label: "file contents", text: "EVIDENCE-SECRET-TEXT" }],
        annotations: [{ text: "ANNOTATION-SECRET-TEXT" }],
      },
    } as never;
    const context = buildSystemOneContext({
      details,
      surface: "bash",
      cwd: "/work/repo",
      fullCommand: null,
      contextBudgetBytes: 8192,
    });
    const text = JSON.stringify(context.state);
    expect(text).not.toContain("PREVIEW-SECRET-TEXT");
    expect(text).not.toContain("EVIDENCE-SECRET-TEXT");
    expect(text).not.toContain("ANNOTATION-SECRET-TEXT");
    expect(Object.keys(context.state).sort()).toEqual(["cwd", "surface", "tool", "value"]);
  });
});

const THRESHOLDS = { allowThreshold: 0.9, denyThreshold: 0.9 };

function hazard(probabilities: Record<string, number>): ClassifierAnswer {
  const full: Record<string, number> = Object.fromEntries(
    Object.keys(HAZARD_OPTIONS).map((option) => [option, 0]),
  );
  Object.assign(full, probabilities);
  const choice = Object.entries(full).sort((a, b) => b[1] - a[1])[0]![0];
  return { type: "choice", choice, probabilities: full, confidence: full[choice]! };
}

function result(
  answers: Record<string, ClassifierAnswer>,
  overrides: Partial<ClassifierResult> = {},
): ClassifierResult {
  return {
    api: "typesafe-system-one",
    provider: "typesafe",
    model: "jev",
    answers,
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

function answers(
  reversible: number,
  contained: number,
  hazards: Record<string, number>,
): Record<string, ClassifierAnswer> {
  return {
    reversible: { type: "bool", probability: reversible },
    contained: { type: "bool", probability: contained },
    hazard: hazard(hazards),
  };
}

describe("per-question allow thresholds", () => {
  const BUILT_IN = { denyThreshold: 0.9 };
  const { reversible, contained, none } = ALLOW_THRESHOLDS;

  it("allows with no allowThreshold when each answer reaches its built-in threshold", () => {
    expect(
      mapSystemOneResult(result(answers(reversible, contained, { none })), BUILT_IN),
    ).toEqual({ kind: "allow" });
  });

  it.each([
    ["reversible", [reversible - 0.01, contained, none]],
    ["contained", [reversible, contained - 0.01, none]],
    ["none", [reversible, contained, none - 0.01]],
  ] as const)("defers with no allowThreshold when %s is just below its threshold", (_q, [r, c, n]) => {
    expect(mapSystemOneResult(result(answers(r, c, { none: n })), BUILT_IN)).toEqual({
      kind: "uncertain",
    });
  });

  it.each([
    [0.89, 0.95, 0.95],
    [0.95, 0.89, 0.95],
    [0.95, 0.95, 0.89],
  ])("an explicit allowThreshold of 0.9 applies to all three (%p, %p, %p)", (r, c, n) => {
    expect(
      mapSystemOneResult(result(answers(r, c, { none: n })), {
        allowThreshold: 0.9,
        denyThreshold: 0.9,
      }),
    ).toEqual({ kind: "uncertain" });
  });

  it("keeps every built-in threshold a probability", () => {
    for (const value of Object.values(ALLOW_THRESHOLDS)) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe("mapSystemOneResult", () => {
  it("allows when all three clear the allow threshold", () => {
    expect(mapSystemOneResult(result(answers(0.95, 0.97, { none: 0.96 })), THRESHOLDS)).toEqual({
      kind: "allow",
    });
  });

  it("allows exactly at the threshold", () => {
    expect(mapSystemOneResult(result(answers(0.9, 0.9, { none: 0.9 })), THRESHOLDS)).toEqual({
      kind: "allow",
    });
  });

  it("denies a force push at 0.95 with a reason naming force push", () => {
    const outcome = mapSystemOneResult(
      result(answers(0.2, 0.9, { force_push: 0.95, none: 0.05 })),
      THRESHOLDS,
    );
    expect(outcome.kind).toBe("deny");
    expect(outcome.kind === "deny" && outcome.reason).toMatch(/force push/);
  });

  it.each(Object.entries(HAZARD_OPTIONS).filter(([option]) => option !== "none"))(
    "denies %s with its plain-word label in the reason",
    (option, label) => {
      const outcome = mapSystemOneResult(
        result(answers(0.5, 0.5, { [option]: 0.92 })),
        THRESHOLDS,
      );
      expect(outcome).toEqual({ kind: "deny", reason: expect.stringContaining(label) });
      expect(outcome.kind === "deny" && outcome.reason).toMatch(/^[\x20-\x7e]+$/);
    },
  );

  it("is uncertain on mixed values", () => {
    expect(
      mapSystemOneResult(result(answers(0.95, 0.6, { none: 0.95 })), THRESHOLDS),
    ).toEqual({ kind: "uncertain" });
  });

  it("is uncertain when a hazard is likely but below the deny threshold", () => {
    expect(
      mapSystemOneResult(result(answers(0.95, 0.95, { force_push: 0.6, none: 0.4 })), THRESHOLDS),
    ).toEqual({ kind: "uncertain" });
  });

  it("denies rather than allows when both rules match at low thresholds", () => {
    const outcome = mapSystemOneResult(
      result(answers(0.95, 0.95, { none: 0.5, secret_exfiltration: 0.5 })),
      { allowThreshold: 0.5, denyThreshold: 0.5 },
    );
    expect(outcome.kind).toBe("deny");
  });

  it("uses the configured thresholds", () => {
    const relaxed = { allowThreshold: 0.6, denyThreshold: 0.99 };
    expect(mapSystemOneResult(result(answers(0.7, 0.7, { none: 0.7 })), relaxed)).toEqual({
      kind: "allow",
    });
    expect(
      mapSystemOneResult(result(answers(0.1, 0.1, { force_push: 0.95 })), relaxed),
    ).toEqual({ kind: "uncertain" });
  });

  it.each([
    ["a missing question", { reversible: { type: "bool", probability: 1 } }],
    [
      "a wrong answer type",
      {
        reversible: { type: "score", score: 1, confidence: 1 },
        contained: { type: "bool", probability: 1 },
        hazard: hazard({ none: 1 }),
      },
    ],
    [
      "a non-finite probability",
      {
        reversible: { type: "bool", probability: Number.NaN },
        contained: { type: "bool", probability: 1 },
        hazard: hazard({ none: 1 }),
      },
    ],
  ] as const)("is uncertain on %s", (_label, given) => {
    expect(
      mapSystemOneResult(result(given as Record<string, ClassifierAnswer>), THRESHOLDS),
    ).toEqual({ kind: "uncertain" });
  });

  it("maps stopReason error to call-failed", () => {
    expect(
      mapSystemOneResult(
        result(answers(1, 1, { none: 1 }), { stopReason: "error", errorMessage: "503" }),
        THRESHOLDS,
      ),
    ).toEqual({ kind: "failure", failure: "call-failed" });
  });

  it("maps stopReason aborted to timeout", () => {
    expect(
      mapSystemOneResult(result({}, { stopReason: "aborted" }), THRESHOLDS),
    ).toEqual({ kind: "failure", failure: "timeout" });
  });
});
