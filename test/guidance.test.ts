import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  findGlobalGuidancePath,
  GUIDANCE_FILE_CAP_BYTES,
  GUIDANCE_TOTAL_CAP_BYTES,
  loadGuidanceFromDisk,
  selectGuidance,
} from "#src/guidance";

const GLOBAL_PATH = "/home/op/.pi/agent/AGENTS.md";
const PROJECT_PATH = "/work/repo/AGENTS.md";

const KIB = 1024;

it("caps are 16 KiB per file and 32 KiB in total", () => {
  expect(GUIDANCE_FILE_CAP_BYTES).toBe(16 * KIB);
  expect(GUIDANCE_TOTAL_CAP_BYTES).toBe(32 * KIB);
});

function text(bytes: number): string {
  return "a".repeat(bytes);
}

describe("selectGuidance", () => {
  it("keeps the global file and drops project files when untrusted", () => {
    const result = selectGuidance(
      [
        { path: GLOBAL_PATH, content: "global rules" },
        { path: PROJECT_PATH, content: "project rules" },
      ],
      GLOBAL_PATH,
      false,
    );

    expect(result.included).toEqual([
      {
        path: GLOBAL_PATH,
        content: "global rules",
        bytes: 12,
        hash12: expect.any(String),
        isGlobal: true,
      },
    ]);
    expect(result.dropped).toEqual([
      { path: PROJECT_PATH, bytes: 13, reason: "untrusted" },
    ]);
  });

  it("includes project files in loader order when trusted", () => {
    const result = selectGuidance(
      [
        { path: GLOBAL_PATH, content: "global rules" },
        { path: "/work/AGENTS.md", content: "parent rules" },
        { path: PROJECT_PATH, content: "project rules" },
      ],
      GLOBAL_PATH,
      true,
    );

    expect(result.included.map((entry) => entry.path)).toEqual([
      GLOBAL_PATH,
      "/work/AGENTS.md",
      PROJECT_PATH,
    ]);
    expect(result.included.map((entry) => entry.isGlobal)).toEqual([
      true,
      false,
      false,
    ]);
    expect(result.dropped).toEqual([]);
  });

  it("drops a file over 16 KiB whole and keeps one at exactly 16 KiB", () => {
    const result = selectGuidance(
      [
        { path: "/work/big/AGENTS.md", content: text(16 * KIB + 1) },
        { path: "/work/fits/AGENTS.md", content: text(16 * KIB) },
      ],
      GLOBAL_PATH,
      true,
    );

    expect(result.included.map((entry) => entry.path)).toEqual([
      "/work/fits/AGENTS.md",
    ]);
    expect(result.included[0]?.bytes).toBe(16 * KIB);
    expect(result.dropped).toEqual([
      { path: "/work/big/AGENTS.md", bytes: 16 * KIB + 1, reason: "over-file-cap" },
    ]);
  });

  it("drops the file that would push the running total over 32 KiB", () => {
    const result = selectGuidance(
      [
        { path: "/a/AGENTS.md", content: text(12 * KIB) },
        { path: "/a/b/AGENTS.md", content: text(12 * KIB) },
        { path: "/a/b/c/AGENTS.md", content: text(12 * KIB) },
      ],
      GLOBAL_PATH,
      true,
    );

    expect(result.included.map((entry) => entry.path)).toEqual([
      "/a/AGENTS.md",
      "/a/b/AGENTS.md",
    ]);
    expect(result.dropped).toEqual([
      { path: "/a/b/c/AGENTS.md", bytes: 12 * KIB, reason: "over-total-cap" },
    ]);
  });

  it("drops every later file once the total cap is hit, even one that would fit", () => {
    const result = selectGuidance(
      [
        { path: "/a/AGENTS.md", content: text(12 * KIB) },
        { path: "/a/b/AGENTS.md", content: text(12 * KIB) },
        { path: "/a/b/c/AGENTS.md", content: text(12 * KIB) },
        { path: "/a/b/c/d/AGENTS.md", content: "tiny" },
      ],
      GLOBAL_PATH,
      true,
    );

    expect(result.included.map((entry) => entry.path)).toEqual([
      "/a/AGENTS.md",
      "/a/b/AGENTS.md",
    ]);
    expect(result.dropped).toEqual([
      { path: "/a/b/c/AGENTS.md", bytes: 12 * KIB, reason: "over-total-cap" },
      { path: "/a/b/c/d/AGENTS.md", bytes: 4, reason: "over-total-cap" },
    ]);
  });

  it("fills the total cap exactly and drops the next byte", () => {
    const result = selectGuidance(
      [
        { path: "/a/AGENTS.md", content: text(GUIDANCE_FILE_CAP_BYTES) },
        { path: "/a/b/AGENTS.md", content: text(GUIDANCE_FILE_CAP_BYTES) },
        { path: "/a/b/c/AGENTS.md", content: "x" },
      ],
      GLOBAL_PATH,
      true,
    );

    expect(result.included).toHaveLength(2);
    expect(result.dropped).toEqual([
      { path: "/a/b/c/AGENTS.md", bytes: 1, reason: "over-total-cap" },
    ]);
  });

  it("applies the caps to the global file too", () => {
    const result = selectGuidance(
      [{ path: GLOBAL_PATH, content: text(16 * KIB + 1) }],
      GLOBAL_PATH,
      false,
    );

    expect(result.included).toEqual([]);
    expect(result.dropped).toEqual([
      { path: GLOBAL_PATH, bytes: 16 * KIB + 1, reason: "over-file-cap" },
    ]);
  });

  it("measures UTF-8 bytes and hashes with the sha256 12-char prefix", () => {
    const content = "echo déjà";
    const result = selectGuidance(
      [{ path: GLOBAL_PATH, content }],
      GLOBAL_PATH,
      false,
    );

    expect(result.included[0]?.bytes).toBe(Buffer.byteLength(content, "utf8"));
    expect(result.included[0]?.bytes).not.toBe(content.length);
    expect(result.included[0]?.hash12).toBe(
      createHash("sha256").update(content, "utf8").digest("hex").slice(0, 12),
    );
  });

  it("returns two empty lists for no files", () => {
    expect(selectGuidance([], GLOBAL_PATH, true)).toEqual({
      included: [],
      dropped: [],
    });
  });

  it("treats an undefined global path as no global file", () => {
    const result = selectGuidance(
      [{ path: PROJECT_PATH, content: "project rules" }],
      undefined,
      false,
    );

    expect(result.included).toEqual([]);
    expect(result.dropped[0]?.reason).toBe("untrusted");
  });

  it("imports no node:fs: disk reads go through pi's loader only", () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "src", "guidance.ts"),
      "utf-8",
    );
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);

    expect(imports).not.toContain("node:fs");
    expect(imports).toContain("@earendil-works/pi-coding-agent");
  });
});

describe("findGlobalGuidancePath", () => {
  it("names the loader entry that lives in the agent dir", () => {
    const files = [
      { path: "/home/op/.pi/agent/CLAUDE.md", content: "g" },
      { path: "/work/repo/AGENTS.md", content: "p" },
    ];

    expect(findGlobalGuidancePath(files, "/home/op/.pi/agent")).toBe(
      "/home/op/.pi/agent/CLAUDE.md",
    );
    expect(findGlobalGuidancePath(files, "/home/op/.pi/agent/")).toBe(
      "/home/op/.pi/agent/CLAUDE.md",
    );
  });

  it("returns undefined when no entry lives in the agent dir", () => {
    expect(
      findGlobalGuidancePath(
        [{ path: "/work/repo/AGENTS.md", content: "p" }],
        "/home/op/.pi/agent",
      ),
    ).toBeUndefined();
  });

  it("does not mistake a nested directory for the agent dir", () => {
    expect(
      findGlobalGuidancePath(
        [{ path: "/home/op/.pi/agent/sub/AGENTS.md", content: "x" }],
        "/home/op/.pi/agent",
      ),
    ).toBeUndefined();
  });
});

describe("loadGuidanceFromDisk", () => {
  const dirs: string[] = [];

  function scratch(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), `pi-permission-classifier-${name}-`));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the agent dir file first, then ancestors down to cwd", () => {
    const agentDir = scratch("agent");
    const root = scratch("root");
    const cwd = join(root, "nested", "leaf");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(agentDir, "AGENTS.md"), "global\n");
    writeFileSync(join(root, "AGENTS.md"), "root\n");
    writeFileSync(join(cwd, "AGENTS.md"), "leaf\n");

    const files = loadGuidanceFromDisk({ cwd, agentDir });

    expect(files.map((file) => file.content)).toEqual([
      "global\n",
      "root\n",
      "leaf\n",
    ]);
    expect(findGlobalGuidancePath(files, agentDir)).toBe(files[0]?.path);
  });

  it("returns an empty list when no context file exists anywhere near", () => {
    const agentDir = scratch("agent");
    const cwd = scratch("cwd");

    const files = loadGuidanceFromDisk({ cwd, agentDir }).filter(
      (file) => file.path.startsWith(agentDir) || file.path.startsWith(cwd),
    );

    expect(files).toEqual([]);
  });
});
