import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { selectGuidance } from "#src/guidance";

const GLOBAL_PATH = "/home/op/.pi/agent/AGENTS.md";
const PROJECT_PATH = "/work/repo/AGENTS.md";

const KIB = 1024;

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

  it("drops every later file once the total cap is hit, even a small one", () => {
    const result = selectGuidance(
      [
        { path: "/a/AGENTS.md", content: text(16 * KIB) },
        { path: "/a/b/AGENTS.md", content: text(16 * KIB) },
        { path: "/a/b/c/AGENTS.md", content: "tiny" },
      ],
      GLOBAL_PATH,
      true,
    );

    expect(result.included.map((entry) => entry.path)).toEqual([
      "/a/AGENTS.md",
      "/a/b/AGENTS.md",
    ]);
    expect(result.dropped).toEqual([
      { path: "/a/b/c/AGENTS.md", bytes: 4, reason: "over-total-cap" },
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

  it("imports no node:fs and no pi context loader", () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "src", "guidance.ts"),
      "utf-8",
    );
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);

    expect(imports).not.toContain("node:fs");
    expect(imports.some((spec) => spec!.includes("coding-agent"))).toBe(false);
  });
});
