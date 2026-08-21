import type { PromptPermissionDetails } from "@gotgenes/pi-permission-system";

/** A representative bash-surface ask; override request facts per test. */
export function askDetails(
  overrides: Partial<PromptPermissionDetails["payload"]["request"]> = {},
): PromptPermissionDetails {
  return {
    requestId: "req-1",
    source: "tool_call",
    agentName: null,
    payload: {
      kind: "bash",
      request: {
        requester: { agentName: null, forwarded: false, sessionId: null },
        surface: "bash",
        toolName: "bash",
        invokedToolName: null,
        value: "git status --porcelain",
        matchedPattern: null,
        commandContext: null,
        executedUnit: null,
        ...overrides,
      },
      evidence: [],
      annotations: [],
    },
  };
}
