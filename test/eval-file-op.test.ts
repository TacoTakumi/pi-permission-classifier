import { isAbsolute } from "node:path";

import { describe, expect, it } from "vitest";

import { type EvalCase, loadFileOpCases } from "../eval/corpus";

/**
 * The path-only corpus is checked by `npm test`: it loads, every case gives the
 * extractor a target it would really produce, and each case sits where its tier
 * says. No model is called here.
 */
const CASES_PATH = new URL("../eval/file-op-cases.json", import.meta.url).pathname;
const cases: EvalCase[] = loadFileOpCases(CASES_PATH);

const byId = new Map(cases.map((testCase) => [testCase.id, testCase]));

const targetOf = (id: string) => byId.get(id)!.target!;

describe("the path-only file-op corpus", () => {
  it("loads with unique ids and a target on every case", () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    expect(byId.size).toBe(cases.length);
    for (const testCase of cases) {
      expect(testCase.kind).toBe("file-op");
      expect(testCase.target).toBeDefined();
      expect(testCase.value).toBe(testCase.tool);
    }
  });

  it("gives every target an absolute path and a decidable state", () => {
    for (const testCase of cases) {
      const target = testCase.target!;
      expect(isAbsolute(target.path)).toBe(true);
      expect(["file", "directory", "missing", "missing-parent"]).toContain(target.state);
      expect(["project", "temp", "outside"]).toContain(target.location);
    }
  });

  it("places the tiers where their names say", () => {
    const expected: Record<string, string> = {
      safe: "project",
      create: "project",
      temp: "temp",
      outside: "outside",
    };
    for (const testCase of cases) {
      const want = expected[testCase.fileTier!];
      if (want === undefined) continue;
      expect([testCase.id, testCase.target!.location]).toEqual([testCase.id, want]);
    }
  });

  it("keeps a project dotfile in the project, so a secret name is not confused with a path outside", () => {
    expect(targetOf("project-dotenv").location).toBe("project");
    expect(targetOf("project-dotenv").path).toBe("/home/dev/proj/.env");
    expect(targetOf("ssh-private-key").location).toBe("outside");
  });

  it("says a symlink that leaves the project leaves it, even when the typed path is inside", () => {
    const escape = targetOf("project-link-escape");

    expect(escape.path).toBe("/home/dev/proj/notes/link/meeting.md");
    expect(escape.resolved).toBe("/home/dev/notes/meeting.md");
    expect(escape.location).toBe("outside");
  });

  it("says a symlink into the temporary directory is the temporary directory", () => {
    const intoTemp = targetOf("temp-through-symlink");

    expect(intoTemp.location).toBe("temp");
    expect(intoTemp.resolved).toBe("/run/user/1000/tmp/probe.out");
  });

  it("pairs cases whose only difference is the path", () => {
    const groups = new Map<string, EvalCase[]>();
    for (const testCase of cases) {
      if (testCase.pairId === undefined) continue;
      groups.set(testCase.pairId, [...(groups.get(testCase.pairId) ?? []), testCase]);
    }

    expect([...groups.keys()].sort()).toEqual(["dir-or-file", "same-name-two-places", "write-or-create"]);
    for (const [pairId, group] of groups) {
      expect(group.length, pairId).toBeGreaterThan(1);
      const tools = new Set(group.map((testCase) => testCase.tool));
      expect(tools.size, pairId).toBe(1);
      const paths = new Set(group.map((testCase) => testCase.target!.path));
      expect(paths.size, pairId).toBe(group.length);
    }
  });

  it("separates an existing file from a create and from a path whose directory is absent", () => {
    expect(targetOf("pair-overwrite-in-project").state).toBe("file");
    expect(targetOf("pair-create-in-project").state).toBe("missing");
    expect(targetOf("pair-unreachable-dir").state).toBe("missing-parent");
    expect(targetOf("pair-existing-dir").state).toBe("directory");
  });

  it("never names /tmp as the temporary directory, so the rule is tested and not assumed", () => {
    const tempCase = byId.get("temp-scratch")!;

    expect(tempCase.target!.location).toBe("temp");
    expect(tempCase.target!.path.startsWith("/tmp")).toBe(false);
  });
});
