import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getGlobalConfigPath,
  getProjectConfigPath,
  globalConfigExists,
  loadClassifierConfig,
  writeGlobalJudge,
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

  describe("projectSetsJudge (REQ-14)", () => {
    it("is false when no project layer exists", () => {
      writeConfig(getGlobalConfigPath(agentDir), "{}");
      const result = loadClassifierConfig({ cwd, agentDir });
      expect(result.projectSetsJudge).toBe(false);
    });

    it("is false when the project layer sets neither provider nor model", () => {
      writeConfig(
        getGlobalConfigPath(agentDir),
        JSON.stringify({ provider: "anthropic", model: "claude-sonnet-5" }),
      );
      writeConfig(getProjectConfigPath(cwd), JSON.stringify({ timeoutMs: 100 }));
      const result = loadClassifierConfig({ cwd, agentDir });
      expect(result.config?.provider).toBe("anthropic");
      expect(result.projectSetsJudge).toBe(false);
    });

    it("is true when the project layer sets provider and model", () => {
      writeConfig(getGlobalConfigPath(agentDir), "{}");
      writeConfig(
        getProjectConfigPath(cwd),
        JSON.stringify({ provider: "openai", model: "gpt-5" }),
      );
      const result = loadClassifierConfig({ cwd, agentDir });
      expect(result.projectSetsJudge).toBe(true);
    });

    it("is true when the project layer sets only one of the pair, even if the merge is invalid", () => {
      writeConfig(getGlobalConfigPath(agentDir), "{}");
      writeConfig(getProjectConfigPath(cwd), JSON.stringify({ model: "gpt-5" }));
      const result = loadClassifierConfig({ cwd, agentDir });
      expect(result.config).toBeUndefined();
      expect(result.projectSetsJudge).toBe(true);
    });
  });
});

describe("globalConfigExists (REQ-08)", () => {
  let root: string;
  let agentDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-permission-classifier-test-"));
    agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("is false when the global file is absent", () => {
    expect(globalConfigExists(agentDir)).toBe(false);
  });

  it("is true when the global file is present", () => {
    const path = getGlobalConfigPath(agentDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{}");
    expect(globalConfigExists(agentDir)).toBe(true);
  });
});

describe("writeGlobalJudge (REQ-12)", () => {
  let root: string;
  let agentDir: string;
  let globalPath: string;

  const existing = {
    instructions: "Be strict.",
    surfaces: ["bash", "mcp"],
    timeoutMs: 750,
    provider: "anthropic",
    model: "claude-sonnet-5",
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-permission-classifier-test-"));
    agentDir = join(root, "agent");
    globalPath = getGlobalConfigPath(agentDir);
    mkdirSync(dirname(globalPath), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function readGlobal(): Record<string, unknown> {
    return JSON.parse(readFileSync(globalPath, "utf-8")) as Record<
      string,
      unknown
    >;
  }

  it("replaces provider and model and preserves every other field", () => {
    writeFileSync(globalPath, JSON.stringify(existing));
    writeGlobalJudge(agentDir, "openai", "gpt-5");
    expect(readGlobal()).toEqual({
      instructions: "Be strict.",
      surfaces: ["bash", "mcp"],
      timeoutMs: 750,
      provider: "openai",
      model: "gpt-5",
    });
  });

  it("removes both keys when provider and model are undefined", () => {
    writeFileSync(globalPath, JSON.stringify(existing));
    writeGlobalJudge(agentDir, undefined, undefined);
    expect(readGlobal()).toEqual({
      instructions: "Be strict.",
      surfaces: ["bash", "mcp"],
      timeoutMs: 750,
    });
  });

  it("leaves only config.json in the directory after writing", () => {
    writeFileSync(globalPath, JSON.stringify(existing));
    writeGlobalJudge(agentDir, "openai", "gpt-5");
    expect(readdirSync(dirname(globalPath))).toEqual(["config.json"]);
  });

  it("writes a file the loader accepts", () => {
    writeFileSync(globalPath, JSON.stringify(existing));
    writeGlobalJudge(agentDir, "openai", "gpt-5");
    const result = loadClassifierConfig({ cwd: join(root, "project"), agentDir });
    expect(result.issues).toEqual([]);
    expect(result.config?.provider).toBe("openai");
    expect(result.config?.model).toBe("gpt-5");
    expect(result.config?.timeoutMs).toBe(750);
  });

  it("throws and writes nothing when the global file is absent", () => {
    expect(() => writeGlobalJudge(agentDir, "openai", "gpt-5")).toThrow(
      globalPath,
    );
    expect(readdirSync(dirname(globalPath))).toEqual([]);
  });

  it("throws and leaves the file untouched when it is not a JSON object", () => {
    writeFileSync(globalPath, "{ not json");
    expect(() => writeGlobalJudge(agentDir, "openai", "gpt-5")).toThrow();
    expect(readFileSync(globalPath, "utf-8")).toBe("{ not json");
    expect(readdirSync(dirname(globalPath))).toEqual(["config.json"]);
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
