import { describe, expect, it } from "vitest";

import {
  CLASSIFIER_EXTENSION_ID,
  classifierConfigSchema,
  DEFAULT_CONTEXT_BUDGET_BYTES,
  DEFAULT_SURFACES,
  DEFAULT_TIMEOUT_MS,
} from "#src/config-schema";

describe("classifierConfigSchema", () => {
  it("fills defaults on an empty config", () => {
    const parsed = classifierConfigSchema.parse({});
    expect(parsed.surfaces).toEqual([
      "bash",
      "mcp",
      "skill",
      "tool",
      "read",
      "write",
      "edit",
    ]);
    expect(parsed.timeoutMs).toBe(5000);
    expect(parsed.contextBudgetBytes).toBe(8192);
    expect(parsed.provider).toBeUndefined();
    expect(parsed.model).toBeUndefined();
    expect(parsed.instructions).toBeUndefined();
  });

  it("exposes the defaults as constants", () => {
    expect(DEFAULT_SURFACES).toEqual([
      "bash",
      "mcp",
      "skill",
      "tool",
      "read",
      "write",
      "edit",
    ]);
    expect(DEFAULT_TIMEOUT_MS).toBe(5000);
    expect(DEFAULT_CONTEXT_BUDGET_BYTES).toBe(8192);
  });

  it("rejects a provider without a model", () => {
    const result = classifierConfigSchema.safeParse({ provider: "anthropic" });
    expect(result.success).toBe(false);
  });

  it("rejects a model without a provider", () => {
    const result = classifierConfigSchema.safeParse({ model: "claude-haiku" });
    expect(result.success).toBe(false);
  });

  it("accepts provider and model together", () => {
    const parsed = classifierConfigSchema.parse({
      provider: "anthropic",
      model: "claude-haiku",
    });
    expect(parsed.provider).toBe("anthropic");
    expect(parsed.model).toBe("claude-haiku");
  });

  it("replaces the default surfaces with a configured array", () => {
    const parsed = classifierConfigSchema.parse({ surfaces: ["bash", "mcp"] });
    expect(parsed.surfaces).toEqual(["bash", "mcp"]);
  });

  it("accepts an optional instructions string", () => {
    const parsed = classifierConfigSchema.parse({
      instructions: "Prefer defer when uncertain.",
    });
    expect(parsed.instructions).toBe("Prefer defer when uncertain.");
  });

  it("accepts a positive integer timeoutMs override", () => {
    const parsed = classifierConfigSchema.parse({ timeoutMs: 250 });
    expect(parsed.timeoutMs).toBe(250);
  });

  it.each([0, -1, 1.5])("rejects timeoutMs %p", (timeoutMs) => {
    const result = classifierConfigSchema.safeParse({ timeoutMs });
    expect(result.success).toBe(false);
  });

  it("accepts a positive integer contextBudgetBytes override", () => {
    const parsed = classifierConfigSchema.parse({ contextBudgetBytes: 2048 });
    expect(parsed.contextBudgetBytes).toBe(2048);
  });

  it.each([0, -1, 1.5, "8192"])(
    "rejects contextBudgetBytes %p",
    (contextBudgetBytes) => {
      const result = classifierConfigSchema.safeParse({ contextBudgetBytes });
      expect(result.success).toBe(false);
    },
  );
});

describe("extension id", () => {
  it("names the extensions/<id>/config.json path segment", () => {
    expect(CLASSIFIER_EXTENSION_ID).toBe("pi-permission-classifier");
  });
});
