import type { AssistantMessage } from "@earendil-works/pi-ai";

/**
 * Wrap reply content in the common `AssistantMessage` envelope the tests
 * share — the metadata fields (`api`, `provider`, `usage`, …) are irrelevant
 * to `reviewAsk`, which reads only `content`.
 */
export function assistantReply(
  content: AssistantMessage["content"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-haiku",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/** An assistant reply carrying a single text content part. */
export function assistantText(text: string): AssistantMessage {
  return assistantReply([{ type: "text", text }]);
}

/**
 * An assistant reply carrying a single `toolCall` content part. The default
 * name mirrors an OAuth-rewritten registration, so a test cannot rely on the
 * reviewer reading the tool call by name.
 */
export function assistantToolCall(
  args: Record<string, unknown>,
  name = "claude_code_report_verdict",
): AssistantMessage {
  return assistantReply([
    { type: "toolCall", id: "call-1", name, arguments: args },
  ]);
}
