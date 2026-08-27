import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { classifierConfigSchema } from "#src/config-schema";

const ROOT = join(import.meta.dirname, "..");

function src(name: string): string {
  return readFileSync(join(ROOT, "src", name), "utf-8");
}

/**
 * Every module under `src/`, read from disk rather than listed by hand: a new
 * link file cannot escape the guards below by omission (REQ-23).
 */
const LINK_FILES = readdirSync(join(ROOT, "src"))
  .filter((name) => name.endsWith(".ts"))
  .sort();

function importsOf(source: string): string[] {
  return [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]!);
}

/**
 * Whether `source` touches the member `name` in any form that could reach the
 * runtime: a direct or optional call, a bare property read (aliased or passed
 * around), or bracket/string access.
 */
function referencesMember(source: string, name: string): boolean {
  const forms = [
    `\\.${name}(?![\\w$])`, // pi.setModel, pi.setModel?.()
    `(?<![$\\w.])${name}\\s*[?(]`, // setModel(), setModel?.()
    `["'\`]${name}["'\`]`, // pi["setModel"], const key = "setModel"
  ];
  return forms.some((form) => new RegExp(form).test(source));
}

/**
 * The text of `export function <name>` through the next top-level export, so a
 * guard can be scoped to one function body instead of the whole file.
 */
function functionSource(source: string, name: string): string {
  const start = source.search(new RegExp(`^export function ${name}\\b`, "m"));
  expect(start, `no export function ${name}`).toBeGreaterThan(-1);
  const rest = source.slice(start);
  const next = rest.slice(1).search(/^export\b/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** Numeric `major.minor.patch >= floor`, without a semver dependency. */
function atLeast(version: string, floor: [number, number, number]): boolean {
  const parts = version.split(".").map((part) => Number(part) || 0);
  for (let index = 0; index < floor.length; index++) {
    const got = parts[index] ?? 0;
    const want = floor[index]!;
    if (got !== want) return got > want;
  }
  return true;
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

describe("manifest (REQ-16, REQ-25)", () => {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf-8"),
  ) as {
    pi?: { extensions?: string[] };
    peerDependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it("declares the pi extension entry pointing at TypeScript source", () => {
    expect(manifest.pi?.extensions).toEqual(["./src/index.ts"]);
  });

  it("declares the pi floor the searchable picker's constructor needs (REQ-25)", () => {
    expect(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"]).toBe(
      ">=0.84.3",
    );
    // The dev pin the typings were checked against must satisfy that floor.
    const pinned = (
      manifest.devDependencies?.["@earendil-works/pi-coding-agent"] ?? ""
    ).replace(/^[~^v>=]*/, "");
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(atLeast(pinned, [0, 84, 3])).toBe(true);
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

  it("states the pi 0.84.3 picker floor in Requirements and the picker paragraph (REQ-25)", () => {
    const flat = readme.replace(/\s+/g, " ");
    const requirements = readme.slice(
      readme.indexOf("## Requirements"),
      readme.indexOf("## Setup"),
    );
    const picker = readme
      .slice(readme.indexOf("with no argument opens"))
      .split("\n- ")[0]!;

    const flatRequirements = requirements.replace(/\s+/g, " ");
    const flatPicker = picker.replace(/\s+/g, " ");
    for (const section of [flatRequirements, flatPicker]) {
      expect(section).toContain("0.84.3 or newer");
      // Stated as loud and safe: the command fails before the picker mounts.
      expect(section).toContain("before the picker mounts");
    }
    expect(flat).toContain("@earendil-works/pi-coding-agent >=0.84.3");
    // Degradation is reserved for the runtime-shape case, not the version floor.
    expect(flat).toMatch(/does not expose\s+the registry runtime/);
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

  it("describes a refused write as bad or missing config, never as an unregistered link (REQ-08)", () => {
    const flat = readme.replace(/\s+/g, " ");
    expect(flat).toContain("no valid merged config");
    expect(flat).toContain("global config file is absent");
    expect(flat).not.toMatch(/link (?:is|was|has been) not registered/);
    // The refusal sentence itself is about the config, not about registration.
    const refusal = flat.match(/[^.]*\brefus\w*\b[^.]*\./i)?.[0] ?? "";
    expect(refusal).toContain("refuses");
    expect(refusal).not.toMatch(/link/i);
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
  it("covers every module under src/, command and judge included", () => {
    // LINK_FILES is read from src/, so both assertions fail when a module is
    // renamed away or the directory is not found (an empty list would make
    // every loop below pass vacuously).
    expect(LINK_FILES.length).toBeGreaterThan(0);
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
      for (const setter of ["setModel", "setDefaultModelAndProvider"]) {
        expect(
          referencesMember(source, setter),
          `${name} references ${setter}`,
        ).toBe(false);
      }
    }
  });

  it("the judge write renames over the target inside writeGlobalJudge", () => {
    // Scoped to the writer body: a renameSync elsewhere in the file, or in a
    // comment, proves nothing about how config.json is replaced.
    const body = functionSource(src("config-loader.ts"), "writeGlobalJudge");
    expect(body).toMatch(/\brenameSync\s*\(/);
    expect(body).not.toMatch(/\bwriteFileSync\s*\(/);
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
