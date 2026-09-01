import type { PromptPayload } from "@gotgenes/pi-permission-system";
import { describe, expect, it } from "vitest";

import { extractFullCommandContext } from "#src/context";

/**
 * Fixture command with a multibyte character so the byte count is only right
 * when measured as UTF-8 bytes, not string length. Expected values computed
 * with node:crypto: sha256("cd /tmp && rm -f x && echo déjà").
 */
const FULL_COMMAND = "cd /tmp && rm -f x && echo déjà";
const FULL_COMMAND_BYTES = 33;
const FULL_COMMAND_HASH12 = "048c90cfe381";

function bashPayload(
  evidence: PromptPayload["evidence"],
  kind: PromptPayload["kind"] = "bash",
): PromptPayload {
  return {
    kind,
    request: {
      requester: { agentName: null, forwarded: false, sessionId: null },
      surface: "bash",
      toolName: "bash",
      invokedToolName: null,
      value: "rm -f x",
      matchedPattern: null,
      commandContext: null,
      executedUnit: null,
    },
    evidence,
    annotations: [],
  };
}

describe("extractFullCommandContext", () => {
  it("extracts text, UTF-8 bytes, and the 12-char sha256 prefix", () => {
    const extracted = extractFullCommandContext(
      bashPayload([{ label: "full command", text: FULL_COMMAND, detail: null }]),
    );

    expect(extracted).toEqual({
      text: FULL_COMMAND,
      bytes: FULL_COMMAND_BYTES,
      hash12: FULL_COMMAND_HASH12,
    });
  });

  it("measures a plain ASCII command too", () => {
    const extracted = extractFullCommandContext(
      bashPayload([{ label: "full command", text: "echo hi", detail: null }]),
    );

    expect(extracted).toEqual({
      text: "echo hi",
      bytes: 7,
      hash12: "56a79f3b1154",
    });
  });

  it("finds the designated entry among other entries", () => {
    const extracted = extractFullCommandContext(
      bashPayload([
        { label: "input", text: "unrelated preview", detail: null },
        { label: "full command", text: "echo hi", detail: null },
      ]),
    );

    expect(extracted?.text).toBe("echo hi");
  });

  it("returns null for a non-bash kind carrying the same label", () => {
    const extracted = extractFullCommandContext(
      bashPayload(
        [{ label: "full command", text: FULL_COMMAND, detail: null }],
        "tool",
      ),
    );

    expect(extracted).toBeNull();
  });

  it("returns null when only other labels are present", () => {
    const extracted = extractFullCommandContext(
      bashPayload([{ label: "input", text: FULL_COMMAND, detail: null }]),
    );

    expect(extracted).toBeNull();
  });

  it("returns null for a non-string text", () => {
    const evidence = [
      { label: "full command", text: 42, detail: null },
    ] as unknown as PromptPayload["evidence"];

    expect(extractFullCommandContext(bashPayload(evidence))).toBeNull();
  });

  it("returns null for an empty-string text", () => {
    const extracted = extractFullCommandContext(
      bashPayload([{ label: "full command", text: "", detail: null }]),
    );

    expect(extracted).toBeNull();
  });

  it("returns null for an absent evidence array", () => {
    const payload = {
      ...bashPayload([]),
      evidence: undefined,
    } as unknown as PromptPayload;

    expect(extractFullCommandContext(payload)).toBeNull();
  });

  it("returns null, without throwing, for malformed evidence shapes", () => {
    const malformed: unknown[] = [
      "not an array",
      { length: 1 },
      [null],
      [42],
      ["full command"],
      [{ text: FULL_COMMAND }],
      [{ label: 7, text: FULL_COMMAND }],
    ];

    for (const evidence of malformed) {
      const payload = {
        ...bashPayload([]),
        evidence,
      } as unknown as PromptPayload;

      expect(() => extractFullCommandContext(payload)).not.toThrow();
      expect(extractFullCommandContext(payload)).toBeNull();
    }
  });

  it("returns null, without throwing, for a missing or malformed payload", () => {
    for (const payload of [null, undefined, 42, "bash", {}] as unknown[]) {
      expect(() =>
        extractFullCommandContext(payload as PromptPayload),
      ).not.toThrow();
      expect(extractFullCommandContext(payload as PromptPayload)).toBeNull();
    }
  });
});
