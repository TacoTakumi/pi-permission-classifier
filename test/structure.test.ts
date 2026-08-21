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

  it("ships a config example that validates against the schema", () => {
    const example = JSON.parse(
      readFileSync(join(ROOT, "config", "config.example.json"), "utf-8"),
    ) as Record<string, unknown>;
    const parsed = classifierConfigSchema.safeParse(example);
    expect(parsed.success).toBe(true);
  });
});
