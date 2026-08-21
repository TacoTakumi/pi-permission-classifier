import type { PromptPermissionDetails } from "@gotgenes/pi-permission-system";

/**
 * A representative bash-surface ask. `request` overrides the payload's fact
 * core; `top` overrides the details bag itself (display surface/value,
 * accessIntent, …). The display surface and value mirror the request facts
 * unless `top` says otherwise, matching how the engine populates a local ask.
 */
export function askDetails(
  request: Partial<PromptPermissionDetails["payload"]["request"]> = {},
  top: Partial<PromptPermissionDetails> = {},
): PromptPermissionDetails {
  const requestFacts = {
    requester: { agentName: null, forwarded: false, sessionId: null },
    surface: "bash",
    toolName: "bash",
    invokedToolName: null,
    value: "git status --porcelain",
    matchedPattern: null,
    commandContext: null,
    executedUnit: null,
    ...request,
  };
  return {
    requestId: "req-1",
    source: "tool_call",
    agentName: null,
    payload: {
      kind: "bash",
      request: requestFacts,
      evidence: [],
      annotations: [],
    },
    surface: requestFacts.surface,
    value: requestFacts.value,
    ...top,
  };
}
