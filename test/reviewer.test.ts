import type { AuthorizerLog, PermissionQuery } from "@gotgenes/pi-permission-system";
import { describe, expect, it, vi } from "vitest";

import { classifierConfigSchema } from "#src/config-schema";
import type { CompleteFn } from "#src/model-review";
import {
  type ClassifierReviewerDeps,
  createClassifierReviewer,
  type ModelRegistryLike,
} from "#src/reviewer";
import { assistantToolCall } from "#test/fixtures/assistant-message";
import { askDetails } from "#test/fixtures/details";

const CONFIG = classifierConfigSchema.parse({});

const SESSION_MODEL = { provider: "anthropic", id: "claude-opus" } as never;
const OVERRIDE_MODEL = { provider: "anthropic", id: "claude-haiku" } as never;

const QUERY = {} as PermissionQuery;

type LogFn = (event: string, details?: Record<string, unknown>) => void;

function fakeLog(): AuthorizerLog & {
  review: ReturnType<typeof vi.fn<LogFn>>;
  debug: ReturnType<typeof vi.fn<LogFn>>;
} {
  return { review: vi.fn<LogFn>(), debug: vi.fn<LogFn>() };
}

function fakeRegistry(): ModelRegistryLike {
  return {
    find: vi.fn((provider: string, modelId: string) =>
      provider === "anthropic" && modelId === "claude-haiku"
        ? OVERRIDE_MODEL
        : undefined,
    ),
    getApiKeyAndHeaders: vi.fn(async () => ({
      ok: true as const,
      apiKey: "sk-test",
      headers: { "x-h": "1" },
    })),
  };
}

function completeReporting(args: Record<string, unknown>): CompleteFn {
  return vi.fn(async () => assistantToolCall(args));
}

function makeDeps(
  overrides: Partial<ClassifierReviewerDeps> = {},
): ClassifierReviewerDeps {
  return {
    getConfig: () => CONFIG,
    getSessionModel: () => SESSION_MODEL,
    getRegistry: fakeRegistry,
    complete: completeReporting({ verdict: "defer" }),
    ...overrides,
  };
}

/** The single classifier.decision entry a run wrote, or undefined. */
function decisionEntry(log: ReturnType<typeof fakeLog>) {
  const calls = log.review.mock.calls.filter(
    ([event]) => event === "classifier.decision",
  );
  expect(calls.length).toBeLessThanOrEqual(1);
  return calls[0]?.[1] as Record<string, unknown> | undefined;
}

describe("surface gating", () => {
  it("defers an off-list surface with no model call", async () => {
    const complete = completeReporting({ verdict: "allow" });
    const authorize = createClassifierReviewer(makeDeps({ complete }));
    const log = fakeLog();
    const verdict = await authorize(
      askDetails({ surface: "fetch" }),
      QUERY,
      log,
    );
    expect(verdict).toEqual({ kind: "defer" });
    expect(complete).not.toHaveBeenCalled();
    expect(decisionEntry(log)).toBeUndefined();
  });

  it("lets a config surfaces array replace the default set", async () => {
    const complete = completeReporting({ verdict: "allow" });
    const config = classifierConfigSchema.parse({ surfaces: ["mcp"] });
    const authorize = createClassifierReviewer(
      makeDeps({ complete, getConfig: () => config }),
    );
    const offList = await authorize(
      askDetails({ surface: "bash" }),
      QUERY,
      fakeLog(),
    );
    expect(offList).toEqual({ kind: "defer" });
    expect(complete).not.toHaveBeenCalled();
    const onList = await authorize(
      askDetails({ surface: "mcp" }),
      QUERY,
      fakeLog(),
    );
    expect(onList).toEqual({ kind: "allow" });
  });

  it.each(["path", "external_directory"])(
    "defers when the gate-authoritative surface is %s, over any display surface",
    async (gateSurface) => {
      const complete = completeReporting({ verdict: "allow" });
      const authorize = createClassifierReviewer(makeDeps({ complete }));
      const verdict = await authorize(
        askDetails(
          { surface: "read" },
          {
            accessIntent: {
              surface: gateSurface,
              matchValues: ["/tmp/x"],
              boundaryValue: "/tmp/x",
            },
          },
        ),
        QUERY,
        fakeLog(),
      );
      expect(verdict).toEqual({ kind: "defer" });
      expect(complete).not.toHaveBeenCalled();
    },
  );

  it("defers when the surface is undeterminable", async () => {
    const complete = completeReporting({ verdict: "allow" });
    const authorize = createClassifierReviewer(makeDeps({ complete }));
    const details = askDetails({}, { surface: null });
    const verdict = await authorize(details, QUERY, fakeLog());
    expect(verdict).toEqual({ kind: "defer" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("gates on accessIntent.surface even when it differs from the reviewed display surface", async () => {
    const complete = completeReporting({ verdict: "allow" });
    const authorize = createClassifierReviewer(makeDeps({ complete }));
    const verdict = await authorize(
      askDetails(
        { surface: "bash" },
        {
          accessIntent: {
            surface: "read",
            matchValues: ["a.txt"],
            boundaryValue: null,
          },
        },
      ),
      QUERY,
      fakeLog(),
    );
    expect(verdict).toEqual({ kind: "allow" });
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe("verdicts", () => {
  it("returns a model allow on a read-surface ask uncapped", async () => {
    const complete = completeReporting({ verdict: "allow" });
    const authorize = createClassifierReviewer(makeDeps({ complete }));
    const verdict = await authorize(
      askDetails({ surface: "read", toolName: "read", value: "src/index.ts" }),
      QUERY,
      fakeLog(),
    );
    expect(verdict).toEqual({ kind: "allow" });
  });

  it("returns a model deny with its reason", async () => {
    const complete = completeReporting({
      verdict: "deny",
      reason: "Reads a credential file.",
    });
    const authorize = createClassifierReviewer(makeDeps({ complete }));
    const verdict = await authorize(askDetails(), QUERY, fakeLog());
    expect(verdict).toEqual({
      kind: "deny",
      reason: "Reads a credential file.",
    });
  });

  it("returns a model defer", async () => {
    const authorize = createClassifierReviewer(makeDeps());
    const verdict = await authorize(askDetails(), QUERY, fakeLog());
    expect(verdict).toEqual({ kind: "defer" });
  });
});

describe("model resolution", () => {
  it("uses the session's active model when config has no override", async () => {
    const complete = completeReporting({ verdict: "defer" });
    const registry = fakeRegistry();
    const authorize = createClassifierReviewer(
      makeDeps({ complete, getRegistry: () => registry }),
    );
    await authorize(askDetails(), QUERY, fakeLog());
    expect(registry.find).not.toHaveBeenCalled();
    const [model] = (complete as ReturnType<typeof vi.fn>).mock
      .calls[0] as unknown[];
    expect(model).toBe(SESSION_MODEL);
  });

  it("resolves a config provider/model override through the registry", async () => {
    const complete = completeReporting({ verdict: "defer" });
    const registry = fakeRegistry();
    const config = classifierConfigSchema.parse({
      provider: "anthropic",
      model: "claude-haiku",
    });
    const authorize = createClassifierReviewer(
      makeDeps({
        complete,
        getRegistry: () => registry,
        getConfig: () => config,
      }),
    );
    await authorize(askDetails(), QUERY, fakeLog());
    expect(registry.find).toHaveBeenCalledWith("anthropic", "claude-haiku");
    const [model] = (complete as ReturnType<typeof vi.fn>).mock
      .calls[0] as unknown[];
    expect(model).toBe(OVERRIDE_MODEL);
  });

  it("forwards the resolved auth into the completion", async () => {
    const complete = completeReporting({ verdict: "defer" });
    const authorize = createClassifierReviewer(makeDeps({ complete }));
    await authorize(askDetails(), QUERY, fakeLog());
    const [, , options] = (complete as ReturnType<typeof vi.fn>).mock
      .calls[0] as [
      unknown,
      unknown,
      { apiKey?: string; headers?: Record<string, string> },
    ];
    expect(options.apiKey).toBe("sk-test");
    expect(options.headers).toEqual({ "x-h": "1" });
  });
});

describe("failure paths", () => {
  it("defers with reason no-config when no config loaded", async () => {
    const complete = completeReporting({ verdict: "allow" });
    const authorize = createClassifierReviewer(
      makeDeps({ complete, getConfig: () => undefined }),
    );
    const log = fakeLog();
    const verdict = await authorize(askDetails(), QUERY, log);
    expect(verdict).toEqual({ kind: "defer" });
    expect(complete).not.toHaveBeenCalled();
    expect(decisionEntry(log)?.deferReason).toBe("no-config");
  });

  it("defers with reason model-unresolved when the session model is absent", async () => {
    const complete = completeReporting({ verdict: "allow" });
    const authorize = createClassifierReviewer(
      makeDeps({ complete, getSessionModel: () => undefined }),
    );
    const log = fakeLog();
    const verdict = await authorize(askDetails(), QUERY, log);
    expect(verdict).toEqual({ kind: "defer" });
    expect(complete).not.toHaveBeenCalled();
    expect(decisionEntry(log)?.deferReason).toBe("model-unresolved");
  });

  it("defers with reason model-unresolved when the override is not in the registry", async () => {
    const complete = completeReporting({ verdict: "allow" });
    const config = classifierConfigSchema.parse({
      provider: "nowhere",
      model: "missing",
    });
    const authorize = createClassifierReviewer(
      makeDeps({ complete, getConfig: () => config }),
    );
    const log = fakeLog();
    const verdict = await authorize(askDetails(), QUERY, log);
    expect(verdict).toEqual({ kind: "defer" });
    expect(complete).not.toHaveBeenCalled();
    expect(decisionEntry(log)?.deferReason).toBe("model-unresolved");
  });

  it("defers with reason auth-failed when auth resolution fails", async () => {
    const complete = completeReporting({ verdict: "allow" });
    const registry: ModelRegistryLike = {
      find: vi.fn(),
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: false as const,
        error: "no key",
      })),
    };
    const authorize = createClassifierReviewer(
      makeDeps({ complete, getRegistry: () => registry }),
    );
    const log = fakeLog();
    const verdict = await authorize(askDetails(), QUERY, log);
    expect(verdict).toEqual({ kind: "defer" });
    expect(complete).not.toHaveBeenCalled();
    expect(decisionEntry(log)?.deferReason).toBe("auth-failed");
  });

  it("records the model-call defer reason from the review outcome", async () => {
    const complete: CompleteFn = vi.fn(async () => {
      throw new Error("boom");
    });
    const authorize = createClassifierReviewer(makeDeps({ complete }));
    const log = fakeLog();
    const verdict = await authorize(askDetails(), QUERY, log);
    expect(verdict).toEqual({ kind: "defer" });
    expect(decisionEntry(log)?.deferReason).toBe("call-failed");
  });
});

describe("decision trail", () => {
  it.each([
    ["allow", { verdict: "allow" }, null],
    ["deny", { verdict: "deny", reason: "no" }, null],
    ["defer", { verdict: "defer" }, "model-verdict"],
  ])(
    "writes exactly one full decision entry on a %s outcome",
    async (kind, args, deferReason) => {
      const complete = completeReporting(args);
      const authorize = createClassifierReviewer(makeDeps({ complete }));
      const log = fakeLog();
      await authorize(askDetails(), QUERY, log);
      const entry = decisionEntry(log);
      expect(entry).toMatchObject({
        requestId: "req-1",
        surface: "bash",
        value: "git status --porcelain",
        modelId: "anthropic/claude-opus",
        verdict: kind,
        deferReason,
      });
      expect(typeof entry?.latencyMs).toBe("number");
    },
  );

  it("sends raw replies only to the debug log", async () => {
    const args = { verdict: "deny", reason: "raw-reply-marker" };
    const complete = completeReporting(args);
    const authorize = createClassifierReviewer(makeDeps({ complete }));
    const log = fakeLog();
    await authorize(askDetails(), QUERY, log);
    const reviewPayloads = JSON.stringify(log.review.mock.calls);
    expect(reviewPayloads).not.toContain("rawReply");
    const debugReply = log.debug.mock.calls.find(
      ([event]) => event === "classifier.model_reply",
    );
    expect(debugReply?.[1]).toMatchObject({
      requestId: "req-1",
      rawReply: JSON.stringify(args),
    });
  });
});
