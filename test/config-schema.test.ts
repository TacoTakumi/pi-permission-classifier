import { describe, expect, it } from "vitest";

import {
  CLASSIFIER_EXTENSION_ID,
  classifierConfigSchema,
  DEFAULT_CONTEXT_BUDGET_BYTES,
  DEFAULT_SYSTEM_ONE_THRESHOLD,
  DEFAULT_TIMEOUT_MS,
} from "#src/config-schema";

describe("classifierConfigSchema", () => {
  it("fills defaults on an empty config", () => {
    const parsed = classifierConfigSchema.parse({});
    expect(parsed.surfaces).toBeUndefined();
    expect(parsed.timeoutMs).toBe(5000);
    expect(parsed.contextBudgetBytes).toBe(8192);
    expect(parsed.provider).toBeUndefined();
    expect(parsed.model).toBeUndefined();
    expect(parsed.instructions).toBeUndefined();
  });

  it("exposes the defaults as constants", () => {
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

  it("accepts an optional surfaces array without applying any default", () => {
    const parsed = classifierConfigSchema.parse({ surfaces: ["bash"] });
    expect(parsed.surfaces).toEqual(["bash"]);
    expect(classifierConfigSchema.parse({}).surfaces).toBeUndefined();
  });

  it("rejects an empty string inside surfaces", () => {
    const result = classifierConfigSchema.safeParse({ surfaces: [""] });
    expect(result.success).toBe(false);
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

describe("classifier link settings", () => {
  it("defaults classifierEnabled, verdicts and onError for a pre-existing config", () => {
    const parsed = classifierConfigSchema.parse({
      provider: "anthropic",
      model: "claude-haiku",
      instructions: "be strict",
      surfaces: ["bash"],
      timeoutMs: 250,
      contextBudgetBytes: 2048,
    });
    expect(parsed.classifierEnabled).toBe(true);
    expect(parsed.verdicts).toBe("allow-deny-defer");
    expect(parsed.onError).toBe("defer");
    expect(parsed.systemOne).toBeUndefined();
    expect(parsed.timeoutMs).toBe(250);
    expect(parsed.contextBudgetBytes).toBe(2048);
  });

  it.each(["allow-deny-defer", "allow-defer", "allow-deny"])(
    "accepts verdicts %p",
    (verdicts) => {
      expect(classifierConfigSchema.parse({ verdicts }).verdicts).toBe(verdicts);
    },
  );

  it.each(["allow", "deny", "defer", "allow-only", ""])(
    "rejects verdicts %p",
    (verdicts) => {
      expect(classifierConfigSchema.safeParse({ verdicts }).success).toBe(false);
    },
  );

  it.each(["defer", "deny"])("accepts onError %p", (onError) => {
    expect(classifierConfigSchema.parse({ onError }).onError).toBe(onError);
  });

  it.each(["allow", "ignore", ""])("rejects onError %p", (onError) => {
    expect(classifierConfigSchema.safeParse({ onError }).success).toBe(false);
  });

  it("accepts classifierEnabled false", () => {
    expect(
      classifierConfigSchema.parse({ classifierEnabled: false }).classifierEnabled,
    ).toBe(false);
  });

  it("rejects a non-boolean classifierEnabled", () => {
    expect(
      classifierConfigSchema.safeParse({ classifierEnabled: "false" }).success,
    ).toBe(false);
  });
});

describe("systemOne settings", () => {
  it("fills every default on an empty systemOne object", () => {
    const parsed = classifierConfigSchema.parse({ systemOne: {} });
    expect(parsed.systemOne).toEqual({
      verdicts: "allow-defer",
      onError: "defer",
      allowThreshold: 0.9,
      denyThreshold: 0.9,
      guidance: true,
      timeoutMs: 5000,
    });
    expect(DEFAULT_SYSTEM_ONE_THRESHOLD).toBe(0.9);
  });

  it("keeps explicit systemOne values", () => {
    const parsed = classifierConfigSchema.parse({
      systemOne: {
        provider: "typesafe",
        model: "jev",
        verdicts: "allow-deny",
        onError: "deny",
        allowThreshold: 0.75,
        denyThreshold: 1,
        guidance: false,
        timeoutMs: 1500,
      },
    });
    expect(parsed.systemOne).toEqual({
      provider: "typesafe",
      model: "jev",
      verdicts: "allow-deny",
      onError: "deny",
      allowThreshold: 0.75,
      denyThreshold: 1,
      guidance: false,
      timeoutMs: 1500,
    });
  });

  it("accepts thresholds at the 0 and 1 bounds", () => {
    const parsed = classifierConfigSchema.parse({
      systemOne: { allowThreshold: 0, denyThreshold: 1 },
    });
    expect(parsed.systemOne?.allowThreshold).toBe(0);
    expect(parsed.systemOne?.denyThreshold).toBe(1);
  });

  it.each([-0.01, 1.01, 2, "0.9"])("rejects allowThreshold %p", (allowThreshold) => {
    expect(
      classifierConfigSchema.safeParse({ systemOne: { allowThreshold } }).success,
    ).toBe(false);
  });

  it.each([-0.01, 1.01, 2, "0.9"])("rejects denyThreshold %p", (denyThreshold) => {
    expect(
      classifierConfigSchema.safeParse({ systemOne: { denyThreshold } }).success,
    ).toBe(false);
  });

  it.each(["allow", "allow-only"])("rejects systemOne verdicts %p", (verdicts) => {
    expect(
      classifierConfigSchema.safeParse({ systemOne: { verdicts } }).success,
    ).toBe(false);
  });

  it.each(["allow", "ignore"])("rejects systemOne onError %p", (onError) => {
    expect(
      classifierConfigSchema.safeParse({ systemOne: { onError } }).success,
    ).toBe(false);
  });

  it.each([0, -1, 1.5])("rejects systemOne timeoutMs %p", (timeoutMs) => {
    expect(
      classifierConfigSchema.safeParse({ systemOne: { timeoutMs } }).success,
    ).toBe(false);
  });

  it("rejects a systemOne provider without a model, and the reverse", () => {
    expect(
      classifierConfigSchema.safeParse({ systemOne: { provider: "typesafe" } })
        .success,
    ).toBe(false);
    expect(
      classifierConfigSchema.safeParse({ systemOne: { model: "jev" } }).success,
    ).toBe(false);
  });

  it("rejects a systemOne value that is not an object", () => {
    expect(classifierConfigSchema.safeParse({ systemOne: true }).success).toBe(
      false,
    );
  });
});

describe("extension id", () => {
  it("names the extensions/<id>/config.json path segment", () => {
    expect(CLASSIFIER_EXTENSION_ID).toBe("pi-permission-classifier");
  });
});
