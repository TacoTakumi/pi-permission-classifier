import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { classifierConfigSchema } from "#src/config-schema";

const ROOT = join(import.meta.dirname, "..");

function src(name: string): string {
  return readFileSync(join(ROOT, "src", name), "utf-8");
}

const LINK_FILES = [
  "index.ts",
  "extension.ts",
  "config-schema.ts",
  "config-loader.ts",
  "prompt.ts",
  "model-review.ts",
  "reviewer.ts",
  "breaker.ts",
  "judge.ts",
  "command.ts",
];

function importsOf(source: string): string[] {
  return [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]!);
}

describe("no path-based allow capping in link code (REQ-07)", () => {
  it.each(["reviewer.ts", "model-review.ts", "breaker.ts", "prompt.ts"])(
    "%s decides without filesystem or cwd inspection",
    (name) => {
      const source = src(name);
      expect(source).not.toMatch(/node:path|node:fs|process\.cwd|isAbsolute/);
    },
  );

  it("returns the model verdict object unmodified", () => {
    expect(src("reviewer.ts")).toContain("return outcome.verdict");
  });
});

describe("no output channels beyond the seams (REQ-15)", () => {
  it("only config-loader touches the filesystem, and nothing opens the network", () => {
    for (const name of LINK_FILES) {
      const imports = importsOf(src(name));
      const nodeBuiltins = imports.filter((imported) =>
        imported.startsWith("node:"),
      );
      if (name === "config-loader.ts") {
        expect(nodeBuiltins.sort()).toEqual(["node:fs", "node:path"]);
      } else {
        expect(nodeBuiltins).toEqual([]);
      }
      expect(imports).not.toContain("node:http");
      expect(imports).not.toContain("node:https");
      expect(imports).not.toContain("node:net");
      expect(imports).not.toContain("node:child_process");
    }
  });

  it("the only completion seam is pi-ai's complete, imported in extension.ts", () => {
    for (const name of LINK_FILES) {
      const valueImportsPiAi = src(name).match(
        /import \{[^}]*complete[^}]*\} from "@earendil-works\/pi-ai\/compat"/,
      );
      if (name === "extension.ts") {
        expect(valueImportsPiAi).not.toBeNull();
      } else {
        expect(valueImportsPiAi).toBeNull();
      }
    }
  });
});

describe("manifest (REQ-16)", () => {
  it("declares the pi extension entry pointing at TypeScript source", () => {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf-8"),
    ) as { pi?: { extensions?: string[] } };
    expect(manifest.pi?.extensions).toEqual(["./src/index.ts"]);
  });
});

describe("operator docs", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf-8");

  it("names every config field with its default", () => {
    for (const field of [
      "provider",
      "model",
      "instructions",
      "surfaces",
      "timeoutMs",
    ]) {
      expect(readme).toContain(field);
    }
    expect(readme).toContain("5000");
    expect(readme).toMatch(/bash, mcp, skill, tool, read, write, edit/);
  });

  it("documents the two install steps as operator actions", () => {
    expect(readme).toContain("settings.json");
    expect(readme).toContain("authorizerChain");
    expect(readme).toMatch(/operator|you run|run yourself|steps the user runs/i);
  });

  it("documents the judge picker, the launch flag, and the status states (REQ-24)", () => {
    for (const claim of [
      "/permission-model",
      "--permission-model",
      "judge:session",
      "(unresolved)",
      "shadow",
    ]) {
      expect(readme).toContain(claim);
    }
  });

  it("tells the operator to list the classifier before pi-permission-system (REQ-18)", () => {
    const flat = readme.replace(/\s+/g, " ");
    expect(flat).toContain(
      "List `pi-permission-classifier` before `pi-permission-system` in `packages`",
    );
    expect(flat).toContain("first agent turn");
  });

  it("the project guide lists the command and judge modules in Layout (REQ-24)", () => {
    const guide = readFileSync(join(ROOT, "CLAUDE.md"), "utf-8");
    expect(guide).toContain("src/command.ts");
    expect(guide).toContain("src/judge.ts");
  });

  it("README.md and CLAUDE.md are ASCII only", () => {
    const guide = readFileSync(join(ROOT, "CLAUDE.md"), "utf-8");
    // eslint-disable-next-line no-control-regex
    expect(readme).not.toMatch(/[^\x00-\x7F]/);
    // eslint-disable-next-line no-control-regex
    expect(guide).not.toMatch(/[^\x00-\x7F]/);
  });

  it("ships a config example that validates against the schema", () => {
    const example = JSON.parse(
      readFileSync(join(ROOT, "config", "config.example.json"), "utf-8"),
    ) as Record<string, unknown>;
    const parsed = classifierConfigSchema.safeParse(example);
    expect(parsed.success).toBe(true);
  });
});

describe("judge model picker guards (REQ-09, REQ-11, REQ-12, REQ-23)", () => {
  it("lists the command and judge modules among the link files", () => {
    expect(LINK_FILES).toContain("command.ts");
    expect(LINK_FILES).toContain("judge.ts");
  });

  it("the command and judge modules import no node: builtins", () => {
    for (const name of ["command.ts", "judge.ts"]) {
      const nodeBuiltins = importsOf(src(name)).filter((imported) =>
        imported.startsWith("node:"),
      );
      expect(nodeBuiltins).toEqual([]);
    }
  });

  it("no link file changes the session model or the operator default model", () => {
    for (const name of LINK_FILES) {
      const source = src(name);
      expect(source).not.toMatch(/\bsetModel\(/);
      expect(source).not.toMatch(/setDefaultModelAndProvider\(/);
    }
  });

  it("the judge write goes through a temp file and renameSync", () => {
    const source = src("config-loader.ts");
    expect(source).toContain("renameSync");
    expect(source).toContain("export function writeGlobalJudge");
  });

  it("the picker is pi's own selector, built with the 0.84.3 six-argument form (REQ-25)", () => {
    const source = src("command.ts");
    expect(source).toMatch(
      /import \{[^}]*ModelSelectorComponent[^}]*\} from "@earendil-works\/pi-coding-agent"/,
    );
    expect(source).toMatch(
      /new ModelSelectorComponent\(\s*request\.tui,\s*request\.currentModel,\s*request\.runtime,\s*request\.scopedModels,\s*request\.onSelect,\s*request\.onCancel,?\s*\)/,
    );
    expect(source).not.toContain("SettingsManager");
    expect(source).not.toContain("onSelectAsDefault");
  });
});
