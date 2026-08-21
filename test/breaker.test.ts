import type { AuthorizerLog, PermissionQuery } from "@gotgenes/pi-permission-system";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const MODEL = { provider: "anthropic", id: "claude-haiku" } as never;
const QUERY = {} as PermissionQuery;

type LogFn = (event: string, details?: Record<string, unknown>) => void;

function fakeLog(): AuthorizerLog & {
  review: ReturnType<typeof vi.fn<LogFn>>;
  debug: ReturnType<typeof vi.fn<LogFn>>;
} {
  return { review: vi.fn<LogFn>(), debug: vi.fn<LogFn>() };
}

const registry: ModelRegistryLike = {
  find: () => undefined,
  getApiKeyAndHeaders: async () => ({ ok: true as const }),
};

function makeDeps(complete: CompleteFn): ClassifierReviewerDeps {
  return {
    getConfig: () => CONFIG,
    getSessionModel: () => MODEL,
    getRegistry: () => registry,
    complete,
  };
}

function reviewEvents(log: ReturnType<typeof fakeLog>): string[] {
  return log.review.mock.calls.map(([event]) => event);
}

function lastDecision(log: ReturnType<typeof fakeLog>) {
  const calls = log.review.mock.calls.filter(
    ([event]) => event === "classifier.decision",
  );
  return calls.at(-1)?.[1] as Record<string, unknown> | undefined;
}

describe("circuit breaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const failing: CompleteFn = vi.fn(async () => {
    throw new Error("model unavailable");
  });

  const succeeding = () =>
    vi.fn(async () => assistantToolCall({ verdict: "defer" }));

  it("opens after the third consecutive failure and logs the open event", async () => {
    const authorize = createClassifierReviewer(makeDeps(failing));
    const logs = [fakeLog(), fakeLog(), fakeLog()];
    for (const log of logs) {
      await authorize(askDetails(), QUERY, log);
    }
    expect(reviewEvents(logs[0]!)).not.toContain("classifier.breaker_open");
    expect(reviewEvents(logs[1]!)).not.toContain("classifier.breaker_open");
    expect(reviewEvents(logs[2]!)).toContain("classifier.breaker_open");
  });

  it("short-circuits asks while open: no completion call, breaker defer reason", async () => {
    const complete = vi.fn<CompleteFn>(async () => {
      throw new Error("down");
    });
    const authorize = createClassifierReviewer(makeDeps(complete));
    for (let i = 0; i < 3; i += 1) {
      await authorize(askDetails(), QUERY, fakeLog());
    }
    expect(complete).toHaveBeenCalledTimes(3);
    const log = fakeLog();
    const verdict = await authorize(askDetails(), QUERY, log);
    expect(verdict).toEqual({ kind: "defer" });
    expect(complete).toHaveBeenCalledTimes(3);
    expect(lastDecision(log)?.deferReason).toBe("breaker-open");
  });

  it("resumes calls after the 60s cooldown; a success closes and logs", async () => {
    let fail = true;
    const complete = vi.fn<CompleteFn>(async () => {
      if (fail) {
        throw new Error("down");
      }
      return assistantToolCall({ verdict: "defer" });
    });
    const authorize = createClassifierReviewer(makeDeps(complete));
    for (let i = 0; i < 3; i += 1) {
      await authorize(askDetails(), QUERY, fakeLog());
    }
    await vi.advanceTimersByTimeAsync(59_999);
    await authorize(askDetails(), QUERY, fakeLog());
    expect(complete).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    fail = false;
    const log = fakeLog();
    const verdict = await authorize(askDetails(), QUERY, log);
    expect(complete).toHaveBeenCalledTimes(4);
    expect(verdict).toEqual({ kind: "defer" });
    expect(reviewEvents(log)).toContain("classifier.breaker_close");
  });

  it("resets the counter on a success before the third failure", async () => {
    let fail = true;
    const complete = vi.fn<CompleteFn>(async () => {
      if (fail) {
        throw new Error("down");
      }
      return assistantToolCall({ verdict: "defer" });
    });
    const authorize = createClassifierReviewer(makeDeps(complete));
    await authorize(askDetails(), QUERY, fakeLog());
    await authorize(askDetails(), QUERY, fakeLog());
    fail = false;
    await authorize(askDetails(), QUERY, fakeLog());
    fail = true;
    const logs = [fakeLog(), fakeLog()];
    for (const log of logs) {
      await authorize(askDetails(), QUERY, log);
    }
    // Two failures after the reset: still closed, still calling the model.
    expect(reviewEvents(logs[1]!)).not.toContain("classifier.breaker_open");
    expect(complete).toHaveBeenCalledTimes(5);
    const log = fakeLog();
    await authorize(askDetails(), QUERY, log);
    expect(reviewEvents(log)).toContain("classifier.breaker_open");
  });

  it("counts a timeout as a failure", async () => {
    const complete = vi.fn<CompleteFn>(
      (_model, _context, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    const authorize = createClassifierReviewer(makeDeps(complete));
    for (let i = 0; i < 3; i += 1) {
      const log = fakeLog();
      const pending = authorize(askDetails(), QUERY, log);
      await vi.advanceTimersByTimeAsync(CONFIG.timeoutMs);
      await pending;
      if (i === 2) {
        expect(reviewEvents(log)).toContain("classifier.breaker_open");
      }
    }
    const log = fakeLog();
    await authorize(askDetails(), QUERY, log);
    expect(complete).toHaveBeenCalledTimes(3);
    expect(lastDecision(log)?.deferReason).toBe("breaker-open");
  });
});
