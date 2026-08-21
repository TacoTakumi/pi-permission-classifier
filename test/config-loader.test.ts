import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getGlobalConfigPath,
  getProjectConfigPath,
  loadClassifierConfig,
} from "#src/config-loader";

describe("loadClassifierConfig", () => {
  let root: string;
  let agentDir: string;
  let cwd: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-permission-classifier-test-"));
    agentDir = join(root, "agent");
    cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeConfig(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  it("returns no config and no issues when neither scope exists", () => {
    const result = loadClassifierConfig({ cwd, agentDir });
    expect(result.config).toBeUndefined();
    expect(result.issues).toEqual([]);
  });

  it("loads a valid global config", () => {
    writeConfig(
      getGlobalConfigPath(agentDir),
      JSON.stringify({ surfaces: ["bash"], timeoutMs: 250 }),
    );
    const result = loadClassifierConfig({ cwd, agentDir });
    expect(result.issues).toEqual([]);
    expect(result.config?.surfaces).toEqual(["bash"]);
    expect(result.config?.timeoutMs).toBe(250);
  });

  it("fills schema defaults for an empty global config object", () => {
    writeConfig(getGlobalConfigPath(agentDir), "{}");
    const result = loadClassifierConfig({ cwd, agentDir });
    expect(result.issues).toEqual([]);
    expect(result.config?.surfaces).toContain("bash");
    expect(result.config?.timeoutMs).toBe(5000);
  });

  it("lets project config override global config", () => {
    writeConfig(
      getGlobalConfigPath(agentDir),
      JSON.stringify({ surfaces: ["bash"], timeoutMs: 250 }),
    );
    writeConfig(
      getProjectConfigPath(cwd),
      JSON.stringify({ surfaces: ["mcp", "skill"] }),
    );
    const result = loadClassifierConfig({ cwd, agentDir });
    expect(result.issues).toEqual([]);
    expect(result.config?.surfaces).toEqual(["mcp", "skill"]);
    expect(result.config?.timeoutMs).toBe(250);
  });

  it("skips malformed JSON with an issue naming the file and never throws", () => {
    const globalPath = getGlobalConfigPath(agentDir);
    writeConfig(globalPath, "{ not json");
    const result = loadClassifierConfig({ cwd, agentDir });
    expect(result.config).toBeUndefined();
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.sourcePath).toBe(globalPath);
  });

  it("rejects a non-object config file with a sourced issue", () => {
    const globalPath = getGlobalConfigPath(agentDir);
    writeConfig(globalPath, JSON.stringify(["not", "an", "object"]));
    const result = loadClassifierConfig({ cwd, agentDir });
    expect(result.config).toBeUndefined();
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.sourcePath).toBe(globalPath);
  });

  it("yields no config plus a sourced issue for a schema-invalid config", () => {
    const globalPath = getGlobalConfigPath(agentDir);
    writeConfig(globalPath, JSON.stringify({ provider: "anthropic" }));
    const result = loadClassifierConfig({ cwd, agentDir });
    expect(result.config).toBeUndefined();
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]?.sourcePath).toContain(globalPath);
  });

  it("still validates the surviving layer when the other is malformed", () => {
    writeConfig(getGlobalConfigPath(agentDir), "{ not json");
    writeConfig(getProjectConfigPath(cwd), JSON.stringify({ timeoutMs: 100 }));
    const result = loadClassifierConfig({ cwd, agentDir });
    expect(result.config?.timeoutMs).toBe(100);
    expect(result.issues).toHaveLength(1);
  });
});

describe("config paths", () => {
  it("global scope lives under <agentDir>/extensions/<id>/config.json", () => {
    expect(getGlobalConfigPath("/agent")).toBe(
      "/agent/extensions/pi-permission-classifier/config.json",
    );
  });

  it("project scope lives under <cwd>/.pi/extensions/<id>/config.json", () => {
    expect(getProjectConfigPath("/repo")).toBe(
      "/repo/.pi/extensions/pi-permission-classifier/config.json",
    );
  });
});
