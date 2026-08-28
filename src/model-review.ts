/**
 * The model call: ask the judge model for an allow / deny / defer verdict on
 * one permission ask, bounded by `timeoutMs`, and map its reply to an
 * `AuthorizerVerdict`.
 *
 * Fail-safe throughout — an unparseable reply, an unrecognized verdict, a
 * thrown or timed-out `complete`, all resolve to `defer` (more prompting,
 * never less) with a distinguishing reason for the decision trail.
 */

import type {
  AssistantMessage,
  Context,
  Model,
  TextContent,
  Tool,
  ToolCall,
} from "@earendil-works/pi-ai";
import type { AuthorizerVerdict, PromptPermissionDetails } from "@gotgenes/pi-permission-system";

import type { ClassifierConfig } from "./config-schema";
import { DEFAULT_INSTRUCTIONS, renderReviewPrompt } from "./prompt";

/** The reason used for a deny when the model omits its own. */
export const GENERIC_TEACHING_REASON =
  "The classifier judged this action unsafe to run unattended. Explain the intent and ask the human, or take a safer route.";

/**
 * The single tool the model is forced to call. Forcing it removes free-text
 * JSON parsing by construction — the verdict arrives as structured
 * `arguments`, so a Markdown fence or a prose preamble can no longer cost a
 * verdict.
 *
 * The Anthropic provider reads only `parameters.properties` /
 * `parameters.required`, so a plain JSON-Schema object is correct at runtime;
 * the `as unknown as Tool` bridge satisfies the `TSchema`-typed `parameters`
 * field without a `typebox` dependency.
 */
const VERDICT_TOOL = {
  name: "report_verdict",
  description:
    "Report whether the ask should be auto-approved (allow), auto-rejected (deny), or sent to the human (defer).",
  parameters: {
    type: "object",
    properties: {
      verdict: {
        type: "string",
        enum: ["allow", "deny", "defer"],
        description:
          "allow a clearly benign ask; deny a never-allow ask; defer anything uncertain",
      },
      reason: {
        type: "string",
        description:
          "Why the ask is denied and what to do instead (required when denying)",
      },
    },
    required: ["verdict"],
  },
} as unknown as Tool;

/**
 * The injected model-completion seam — structurally the `complete` export of
 * `@earendil-works/pi-ai`. Injected so tests substitute a fake.
 */
export type CompleteFn = (
  model: Model<any>,
  context: Context,
  options?: {
    signal?: AbortSignal;
    apiKey?: string;
    headers?: Record<string, string | null>;
    toolChoice?: string;
  },
) => Promise<AssistantMessage>;

/**
 * pi-ai passes `toolChoice` to the provider verbatim, and "force a tool call"
 * is spelled per API dialect: OpenAI-family endpoints take "required" and
 * reject Anthropic's "any" with a 400 — which would fail-safe every review to
 * defer. Everything else pi-ai supports accepts "any" (Anthropic natively;
 * Google, Bedrock, and Mistral translate it; pi-messages forwards it), so
 * "any" is also the fallback for an unknown api.
 */
const REQUIRED_TOOL_CHOICE_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
]);

function forcedToolChoice(api: string | undefined): "any" | "required" {
  return api !== undefined && REQUIRED_TOOL_CHOICE_APIS.has(api)
    ? "required"
    : "any";
}

/** Inputs for a single ask review. */
export interface ReviewAskInputs {
  details: PromptPermissionDetails;
  config: ClassifierConfig;
  model: Model<any>;
  complete: CompleteFn;
  apiKey?: string;
  headers?: Record<string, string | null>;
}

/**
 * Why a review defers, distinct enough to diagnose from the decision trail:
 * the model itself chose defer (`model-verdict`), the reply carried no tool
 * call to read (`no-tool-call`), the tool call named an unknown verdict
 * (`unrecognized-verdict`), the call was aborted at `timeoutMs` (`timeout`),
 * or `complete` threw for any other reason (`call-failed` — the honest
 * superset that catches, e.g., a 401 slipping past pre-call auth resolution).
 */
export type ModelCallDeferReason =
  | "model-verdict"
  | "no-tool-call"
  | "unrecognized-verdict"
  | "timeout"
  | "call-failed";

/**
 * The full result of a model review: the verdict plus the observability the
 * decision trail records. `deferReason` is set iff the verdict is `defer`;
 * `rawReply` carries the tool-call arguments as JSON when a tool call arrived,
 * or the assistant text on a `no-tool-call` defer (absent on a timeout/throw
 * before any reply).
 */
export interface ReviewOutcome {
  verdict: AuthorizerVerdict;
  deferReason?: ModelCallDeferReason;
  latencyMs: number;
  rawReply?: string;
}

/**
 * Review one ask with the model and return the structured outcome.
 *
 * The call is aborted after `config.timeoutMs`; an abort, a rejection, or an
 * unreadable reply yields `defer` (more prompting, never less) with the
 * reason annotated so the caller can record why.
 */
export async function reviewAsk(inputs: ReviewAskInputs): Promise<ReviewOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, inputs.config.timeoutMs);
  const startedAt = Date.now();
  try {
    const context: Context = {
      systemPrompt: inputs.config.instructions ?? DEFAULT_INSTRUCTIONS,
      tools: [VERDICT_TOOL],
      messages: [
        {
          role: "user",
          content: renderReviewPrompt(inputs.details),
          timestamp: Date.now(),
        },
      ],
    };
    const reply = await inputs.complete(inputs.model, context, {
      signal: controller.signal,
      apiKey: inputs.apiKey,
      headers: inputs.headers,
      toolChoice: forcedToolChoice(inputs.model.api),
    });
    // pi-ai resolves (not rejects) with the partial message on abort, so a
    // deadline hit surfaces here as a reply with no tool call. Read the
    // signal first so the trail says `timeout`, and the breaker counts it.
    if (controller.signal.aborted) {
      return {
        verdict: { kind: "defer" },
        deferReason: "timeout",
        latencyMs: Date.now() - startedAt,
      };
    }
    return readToolCallOutcome(reply, Date.now() - startedAt);
  } catch {
    return {
      verdict: { kind: "defer" },
      deferReason: controller.signal.aborted ? "timeout" : "call-failed",
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Map the forced tool call to an outcome; anything unreadable defers with the
 * reason that distinguishes it. The tool call is read by position (the first
 * one), not by name — under OAuth the provider rewrites the registered name,
 * so the reply's tool-call name cannot be relied on.
 */
function readToolCallOutcome(
  reply: AssistantMessage,
  latencyMs: number,
): ReviewOutcome {
  const call = reply.content.find(
    (part): part is ToolCall => part.type === "toolCall",
  );
  if (!call) {
    return {
      verdict: { kind: "defer" },
      deferReason: "no-tool-call",
      latencyMs,
      rawReply: extractText(reply),
    };
  }
  const args = call.arguments;
  const rawReply = JSON.stringify(args);
  switch (args.verdict) {
    case "allow":
      return { verdict: { kind: "allow" }, latencyMs, rawReply };
    case "deny": {
      const reason =
        typeof args.reason === "string" && args.reason.length > 0
          ? args.reason
          : GENERIC_TEACHING_REASON;
      return { verdict: { kind: "deny", reason }, latencyMs, rawReply };
    }
    case "defer":
      return {
        verdict: { kind: "defer" },
        deferReason: "model-verdict",
        latencyMs,
        rawReply,
      };
    default:
      return {
        verdict: { kind: "defer" },
        deferReason: "unrecognized-verdict",
        latencyMs,
        rawReply,
      };
  }
}

/** Concatenate the text parts of an assistant reply. */
function extractText(reply: AssistantMessage): string {
  return reply.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");
}
