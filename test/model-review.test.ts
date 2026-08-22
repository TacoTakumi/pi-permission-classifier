import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { classifierConfigSchema } from "#src/config-schema";
import {
  type CompleteFn,
  GENERIC_TEACHING_REASON,
  reviewAsk,
} from "#src/model-review";
import { DEFAULT_INSTRUCTIONS } from "#src/prompt";
import {
  assistantText,
  assistantToolCall,
} from "#test/fixtures/assistant-message";
import { askDetails } from "#test/fixtures/details";

const CONFIG = classifierConfigSchema.parse({});

// A minimal model stand-in — reviewAsk only forwards it to `complete`.
const MODEL = { provider: "anthropic", id: "claude-haiku" } as never;

/** A `complete` seam that returns a forced tool call carrying `args`. */
function completeReporting(args: Record<string, unknown>): CompleteFn {
  return vi.fn(async () => assistantToolCall(args));
}

function review(complete: CompleteFn, config = CONFIG) {
  return reviewAsk({
    details: askDetails(),
    config,
    model: MODEL,
    complete,
  });
}

describe("reviewAsk", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("allows on an allow verdict", async () => {
    const args = { verdict: "allow", reason: "Read-only git inspection." };
    const outcome = await review(completeReporting(args));
    expect(outcome.verdict).toEqual({ kind: "allow" });
    expect(outcome.deferReason).toBeUndefined();
    expect(outcome.rawReply).toBe(JSON.stringify(args));
    expect(typeof outcome.latencyMs).toBe("number");
  });

  it("denies with the model's reason on a deny verdict", async () => {
    const args = { verdict: "deny", reason: "Reads a credential file." };
    const outcome = await review(completeReporting(args));
    expect(outcome.verdict).toEqual({
      kind: "deny",
      reason: "Reads a credential file.",
    });
    expect(outcome.deferReason).toBeUndefined();
  });

  it("substitutes the generic teaching reason when a deny omits its reason", async () => {
    const outcome = await review(completeReporting({ verdict: "deny" }));
    expect(outcome.verdict).toEqual({
      kind: "deny",
      reason: GENERIC_TEACHING_REASON,
    });
  });

  it("defers with reason model-verdict on the model's own defer", async () => {
    const outcome = await review(completeReporting({ verdict: "defer" }));
    expect(outcome.verdict).toEqual({ kind: "defer" });
    expect(outcome.deferReason).toBe("model-verdict");
  });

  it("defers with reason unrecognized-verdict on an unknown verdict value", async () => {
    const outcome = await review(completeReporting({ verdict: "maybe" }));
    expect(outcome.verdict).toEqual({ kind: "defer" });
    expect(outcome.deferReason).toBe("unrecognized-verdict");
  });

  it("defers with reason no-tool-call when the reply carries no tool call", async () => {
    const text = "Looks fine to me.";
    const complete: CompleteFn = vi.fn(async () => assistantText(text));
    const outcome = await review(complete);
    expect(outcome.verdict).toEqual({ kind: "defer" });
    expect(outcome.deferReason).toBe("no-tool-call");
    expect(outcome.rawReply).toBe(text);
  });

  it("reads the tool call by position, ignoring the (rewritten) tool name", async () => {
    const complete: CompleteFn = vi.fn(async () =>
      assistantToolCall({ verdict: "allow" }, "any_name"),
    );
    const outcome = await review(complete);
    expect(outcome.verdict).toEqual({ kind: "allow" });
  });

  it("defers with reason call-failed when complete rejects", async () => {
    const complete: CompleteFn = vi.fn(async () => {
      throw new Error("model unavailable");
    });
    const outcome = await review(complete);
    expect(outcome.verdict).toEqual({ kind: "defer" });
    expect(outcome.deferReason).toBe("call-failed");
    expect(outcome.rawReply).toBeUndefined();
  });

  it("forces a single three-verdict tool with toolChoice any and the rendered facts", async () => {
    const complete = completeReporting({ verdict: "defer" });
    await review(complete);
    expect(complete).toHaveBeenCalledTimes(1);
    const [model, context, options] = (complete as ReturnType<typeof vi.fn>)
      .mock.calls[0] as [unknown, Context, { toolChoice?: string } | undefined];
    expect(model).toBe(MODEL);
    expect(context.systemPrompt).toBe(DEFAULT_INSTRUCTIONS);
    const firstMessage = context.messages[0] as { content: string };
    expect(firstMessage.content).toContain("git status --porcelain");
    expect(context.tools).toHaveLength(1);
    expect(context.tools?.[0]?.name).toBe("report_verdict");
    const parameters = context.tools?.[0]?.parameters as {
      properties: { verdict: { enum: string[] } };
    };
    expect(parameters.properties.verdict.enum).toEqual([
      "allow",
      "deny",
      "defer",
    ]);
    expect(options?.toolChoice).toBe("any");
  });

  // "Force a tool call" is spelled per API dialect: OpenAI-family endpoints
  // reject Anthropic's "any" with a 400, which would fail-safe every review
  // to defer. The judge model's `api` field picks the spelling.
  it.each([
    ["openai-completions", "required"],
    ["openai-responses", "required"],
    ["azure-openai-responses", "required"],
    ["openai-codex-responses", "required"],
    ["anthropic-messages", "any"],
    ["google-generative-ai", "any"],
    ["bedrock-converse-stream", "any"],
  ])("spells the forced tool choice for %s as %s", async (api, expected) => {
    const complete = completeReporting({ verdict: "defer" });
    await reviewAsk({
      details: askDetails(),
      config: CONFIG,
      model: { provider: "p", id: "m", api } as never,
      complete,
    });
    const [, , options] = (complete as ReturnType<typeof vi.fn>).mock
      .calls[0] as [unknown, Context, { toolChoice?: string } | undefined];
    expect(options?.toolChoice).toBe(expected);
  });

  it("uses a config instructions string verbatim as the system prompt", async () => {
    const config = classifierConfigSchema.parse({
      instructions: "Only ever defer.",
    });
    const complete = completeReporting({ verdict: "defer" });
    await review(complete, config);
    const [, context] = (complete as ReturnType<typeof vi.fn>).mock
      .calls[0] as [unknown, Context];
    expect(context.systemPrompt).toBe("Only ever defer.");
  });

  it("forwards the resolved apiKey, headers, and an abort signal", async () => {
    const complete = completeReporting({ verdict: "defer" });
    await reviewAsk({
      details: askDetails(),
      config: CONFIG,
      model: MODEL,
      complete,
      apiKey: "sk-test-123",
      headers: { "x-custom": "1" },
    });
    const [, , options] = (complete as ReturnType<typeof vi.fn>).mock
      .calls[0] as [
      unknown,
      unknown,
      {
        signal?: AbortSignal;
        apiKey?: string;
        headers?: Record<string, string>;
      },
    ];
    expect(options.apiKey).toBe("sk-test-123");
    expect(options.headers).toEqual({ "x-custom": "1" });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("aborts the model call at the configured deadline and defers with reason timeout", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const complete: CompleteFn = vi.fn(
      (_model, _context, options) =>
        new Promise<AssistantMessage>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    );
    const config = classifierConfigSchema.parse({ timeoutMs: 1000 });
    const promise = reviewAsk({
      details: askDetails(),
      config,
      model: MODEL,
      complete,
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(aborted).toBe(true);
    const outcome = await promise;
    expect(outcome.verdict).toEqual({ kind: "defer" });
    expect(outcome.deferReason).toBe("timeout");
  });
});
