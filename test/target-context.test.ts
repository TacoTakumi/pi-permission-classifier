import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAX_TARGET_BYTES,
  type TargetContextDeps,
  defaultTargetContextDeps,
  extractTargetContext,
  resolveTargetDeps,
  sessionCwdOf,
  tempDirectoryOf,
} from "#src/target-context";
import { askDetails } from "#test/fixtures/details";
import {
  bashAsk,
  bashPathAsk,
  forwardedAskWithoutPayload,
  forwardedBashAsk,
  memoryTargetDeps as memoryWorld,
  pathAsk,
} from "#test/fixtures/target";

const CWD = "/home/dev/proj";
const TEMP = "/run/user/1000/tmp";

describe("extractTargetContext", () => {
  it("reads an existing project file, its directory and a relative spelling", () => {
    const reading = extractTargetContext(
      pathAsk([`${CWD}/src/client.py`, "src/client.py"], `${CWD}/src/client.py`),
      memoryWorld({ files: [`${CWD}/src/client.py`], directories: [`${CWD}/src`] }),
    );

    expect(reading).toEqual({
      included: true,
      target: {
        path: "/home/dev/proj/src/client.py",
        resolved: null,
        relativeSpelling: "src/client.py",
        directory: "/home/dev/proj/src",
        state: "file",
        location: "project",
      },
    });
  });

  it("places an absolute target outside the project as outside", () => {
    const reading = extractTargetContext(
      pathAsk(["/etc/hosts"], "/etc/hosts"),
      memoryWorld({ files: ["/etc/hosts"] }),
    );

    expect(reading.included === true && reading.target.location).toBe("outside");
    expect(reading.included === true && reading.target.state).toBe("file");
  });

  it("uses the injected temporary directory, not a hardcoded /tmp", () => {
    const reading = extractTargetContext(
      pathAsk([`${TEMP}/scratch.txt`], `${TEMP}/scratch.txt`),
      memoryWorld({ files: [`${TEMP}/scratch.txt`], temp: "/run/user/1000/tmp" }),
    );

    expect(reading.included === true && reading.target.location).toBe("temp");
  });

  it("places a target through a symlink by what it resolves to", () => {
    const reading = extractTargetContext(
      pathAsk(
        ["/home/dev/proj/link/notes.md", "link/notes.md"],
        "/srv/elsewhere/notes.md",
      ),
      memoryWorld({
        files: ["/srv/elsewhere/notes.md"],
        directories: ["/srv/elsewhere", "/home/dev/proj"],
        links: { "/home/dev/proj/link/notes.md": "/srv/elsewhere/notes.md" },
      }),
    );

    expect(reading).toEqual({
      included: true,
      target: {
        path: "/home/dev/proj/link/notes.md",
        resolved: "/srv/elsewhere/notes.md",
        relativeSpelling: "link/notes.md",
        directory: "/home/dev/proj/link",
        state: "file",
        location: "outside",
      },
    });
  });

  it("calls an absent file in an existing directory a create, inside the project", () => {
    const reading = extractTargetContext(
      pathAsk([`${CWD}/newfile.md`, "newfile.md"], `${CWD}/newfile.md`),
      memoryWorld({ directories: [CWD] }),
    );

    expect(reading.included === true && reading.target.state).toBe("missing");
    expect(reading.included === true && reading.target.location).toBe("project");
  });

  it("separates a create whose directory is missing from one whose directory exists", () => {
    const reading = extractTargetContext(
      pathAsk([`${CWD}/nodir/new.md`, "nodir/new.md"], `${CWD}/nodir/new.md`),
      memoryWorld({ directories: [CWD] }),
    );

    expect(reading.included === true && reading.target.state).toBe("missing-parent");
    expect(reading.included === true && reading.target.location).toBe("project");
  });

  it("reports a relative spelling that escapes the project as outside", () => {
    const reading = extractTargetContext(
      pathAsk(["/home/dev/outside.cfg", "../outside.cfg"], "/home/dev/outside.cfg"),
      memoryWorld({ files: ["/home/dev/outside.cfg"] }),
    );

    expect(reading.included === true && reading.target.relativeSpelling).toBe("../outside.cfg");
    expect(reading.included === true && reading.target.location).toBe("outside");
  });

  it("keeps the last relative spelling when the gate carried several", () => {
    // The gate emits `[absolute, cwd-relative?, as-typed]`, so the last
    // non-absolute entry is the one the caller wrote when there was one.
    const reading = extractTargetContext(
      pathAsk(
        [`${CWD}/src/client.py`, "src/client.py", "./src/client.py"],
        `${CWD}/src/client.py`,
      ),
      memoryWorld({ files: [`${CWD}/src/client.py`], directories: [`${CWD}/src`] }),
    );

    expect(reading.included === true && reading.target.relativeSpelling).toBe(
      "./src/client.py",
    );
  });

  it("prefers the project when the session directory sits inside the temporary one", () => {
    const reading = extractTargetContext(
      pathAsk([`${TEMP}/job/a.txt`], `${TEMP}/job/a.txt`),
      memoryWorld({ files: [`${TEMP}/job/a.txt`], cwd: TEMP }),
    );

    expect(reading.included === true && reading.target.location).toBe("project");
  });

  it("leaves the location unknown when the host gives no session directory", () => {
    const reading = extractTargetContext(
      pathAsk(["/etc/hosts"], "/etc/hosts"),
      memoryWorld({ files: ["/etc/hosts"], cwd: "" }),
    );

    expect(reading.included === true && reading.target.path).toBe("/etc/hosts");
    expect(reading.included === true && reading.target.location).toBe("unknown");
  });

  it("leaves the location unknown when the filesystem cannot say", () => {
    const reading = extractTargetContext(
      pathAsk([`${CWD}/src/client.py`], `${CWD}/src/client.py`),
      memoryWorld({ throwsFor: [`${CWD}/src/client.py`] }),
    );

    expect(reading.included === true && reading.target.state).toBe("unknown");
    expect(reading.included === true && reading.target.location).toBe("unknown");
  });

  it("keeps the target when realpath fails, with no resolved line", () => {
    const reading = extractTargetContext(
      pathAsk([`${CWD}/src/client.py`], `${CWD}/src/client.py`),
      memoryWorld({ files: [`${CWD}/src/client.py`], throwsFor: [`${CWD}/src/client.py`] }),
    );

    // The stat threw, so state is unknown; the path itself is still reported.
    expect(reading.included === true && reading.target.path).toBe(
      "/home/dev/proj/src/client.py",
    );
    expect(reading.included === true && reading.target.resolved).toBeNull();
  });

  it("refuses a bash command, whether or not its path gate named one token", () => {
    expect(extractTargetContext(bashAsk("rm -rf build"), memoryWorld())).toEqual({
      included: false,
      reason: "multi-path-command",
    });

    // `cp ./notes.txt /home/dev/.ssh/authorized_keys` reaches the classifier
    // with a canonical path for whichever token the gate judged most
    // restrictive. Reported as the target, it would describe a different action
    // than the one asked for, so the command field refuses the ask instead.
    expect(
      extractTargetContext(
        bashPathAsk("cp ./notes.txt /home/dev/.ssh/authorized_keys", `${CWD}/notes.txt`),
        memoryWorld({ files: [`${CWD}/notes.txt`] }),
      ),
    ).toEqual({ included: false, reason: "multi-path-command" });
  });

  it("refuses an escalated bash ask, which carries no command field", () => {
    // The serving node rebuilds the details bag without the command, so only
    // the payload kind says this is a shell command rather than a file action.
    expect(
      extractTargetContext(
        forwardedBashAsk(
          "cp ./notes.txt /home/dev/.ssh/authorized_keys",
          `${CWD}/notes.txt`,
        ),
        memoryWorld({ files: [`${CWD}/notes.txt`] }),
      ),
    ).toEqual({ included: false, reason: "multi-path-command" });
  });

  it("refuses a bash ask whose outside-project gate reported its own kind", () => {
    expect(
      extractTargetContext(
        bashPathAsk("cat /home/dev/.ssh/id_rsa", "/home/dev/.ssh/id_rsa", {
          kind: "bash_external_directory",
          effect: "path_read",
        }),
        memoryWorld(),
      ),
    ).toEqual({ included: false, reason: "multi-path-command" });
  });

  it("claims no target for a forwarded ask with no payload", () => {
    // Its intent still carries the child's canonical path, but a payload-less
    // forwarded ask does not say whether the child ran a command that touched
    // many files or one file action, and this side cannot tell them apart.
    expect(
      extractTargetContext(
        forwardedAskWithoutPayload("/home/dev/.ssh/authorized_keys"),
        memoryWorld({ files: ["/home/dev/.ssh/authorized_keys"] }),
      ),
    ).toEqual({ included: false, reason: "undetermined-action" });
  });

  it("answers no-canonical-path for an MCP, skill or plain-tool ask", () => {
    expect(extractTargetContext(pathAsk(["server:tool"], "", "mcp"), memoryWorld())).toEqual({
      included: false,
      reason: "no-canonical-path",
    });
  });

  it("answers no-access-intent when the ask carries none", () => {
    expect(extractTargetContext(askDetails(), memoryWorld())).toEqual({
      included: false,
      reason: "no-access-intent",
    });
  });

  it("answers unusable-path for a relative or unrenderable canonical value", () => {
    expect(extractTargetContext(pathAsk(["src/a.py"], "src/a.py"), memoryWorld())).toEqual({
      included: false,
      reason: "unusable-path",
    });
    expect(
      extractTargetContext(pathAsk(["/tmp/a\nb"], "/tmp/a\nb"), memoryWorld()),
    ).toEqual({ included: false, reason: "unusable-path" });

    // A component of the lexical spelling can carry a bidi override while the
    // form the gate decided on is clean, and it is the lexical form the block
    // renders and the log records.
    expect(
      extractTargetContext(
        pathAsk(
          ["/home/dev/proj/build\u202ecache/notes.md", "/srv/cache/notes.md"],
          "/srv/cache/notes.md",
        ),
        memoryWorld({ files: ["/srv/cache/notes.md"] }),
      ),
    ).toEqual({ included: false, reason: "unusable-path" });

    // Invisible and direction-changing characters would make the prompt and the
    // log show a path that is not the one being judged.
    for (const spelling of [
      "/home/dev/proj/a\u202eb.py",
      "/home/dev/proj/confi\u200bg.json",
      "/home/dev/proj/\ufeffa.py",
      "/home/dev/proj/a\u2066b.py",
    ]) {
      expect(extractTargetContext(pathAsk([spelling], spelling), memoryWorld())).toEqual({
        included: false,
        reason: "unusable-path",
      });
    }
  });

  it("answers over-size-cap for a path past the byte cap, with no rendering", () => {
    const long = `/${"dossier".repeat(Math.ceil(MAX_TARGET_BYTES / 7) + 1)}.py`;
    expect(Buffer.byteLength(long, "utf8")).toBeGreaterThan(MAX_TARGET_BYTES);
    expect(extractTargetContext(pathAsk([long], long), memoryWorld())).toEqual({
      included: false,
      reason: "over-size-cap",
    });
  });

  it("counts the resolved and relative spellings against the same cap", () => {
    // Each spelling would fit on its own, and the block is one unit: over the
    // cap it goes out whole, since a path with no state or placement line says
    // nothing.
    const lexical = `/${"l".repeat(300)}`;
    const resolved = `/${"r".repeat(300)}`;
    expect(
      extractTargetContext(pathAsk([lexical], resolved), memoryWorld()),
    ).toEqual({ included: false, reason: "over-size-cap" });

    const absolute = `/${"a".repeat(300)}`;
    expect(
      extractTargetContext(pathAsk([absolute, "b".repeat(300)], absolute), memoryWorld()),
    ).toEqual({ included: false, reason: "over-size-cap" });
  });

  it("keeps a block whose spellings together sit under the cap", () => {
    const absolute = `/${"c".repeat(MAX_TARGET_BYTES - 40)}`;
    const reading = extractTargetContext(
      pathAsk([absolute, "client.py"], absolute),
      memoryWorld({ files: [absolute] }),
    );

    expect(Buffer.byteLength(absolute, "utf8") + Buffer.byteLength("client.py", "utf8")).toBeLessThanOrEqual(
      MAX_TARGET_BYTES,
    );
    expect(reading.included === true && reading.target.path).toBe(absolute);
    expect(reading.included === true && reading.target.relativeSpelling).toBe("client.py");
  });

  it("gives no relative spelling when matchValues is malformed", () => {
    for (const matchValues of [undefined, "src/a.py", [null, 42], []]) {
      const reading = extractTargetContext(
        pathAsk(matchValues, `${CWD}/src/a.py`),
        memoryWorld({ files: [`${CWD}/src/a.py`] }),
      );
      expect(reading.included === true && reading.target.relativeSpelling).toBeNull();
    }
  });

  it("keeps the path and leaves placement unknown when the session directory throws", () => {
    // The session directory is a fact the block states, not one the read depends
    // on: the path is already resolved, so placement goes unanswered and the
    // target stays.
    const noSession: TargetContextDeps = {
      ...memoryWorld({ files: ["/etc/hosts"] }),
      getCwd: () => {
        throw new Error("no session");
      },
    };

    const reading = extractTargetContext(pathAsk(["/etc/hosts"], "/etc/hosts"), noSession);

    expect(reading.included === true && reading.target.path).toBe("/etc/hosts");
    expect(reading.included === true && reading.target.location).toBe("unknown");
  });

  it("answers extraction-failed when a seam rejects instead of returning null", () => {
    const exploding: TargetContextDeps = {
      ...memoryWorld({ files: ["/etc/hosts"] }),
      realpath: () => {
        throw new Error("lstat exploded");
      },
    };

    expect(extractTargetContext(pathAsk(["/etc/hosts"], "/etc/hosts"), exploding)).toEqual({
      included: false,
      reason: "extraction-failed",
    });
  });
});

describe("target seams", () => {
  it("reads the session and temporary directories, and answers null on a throw", () => {
    const seams = memoryWorld({ cwd: CWD, temp: TEMP });
    expect(sessionCwdOf(seams)).toBe(CWD);
    expect(tempDirectoryOf(seams)).toBe(TEMP);
    expect(
      sessionCwdOf({
        ...seams,
        getCwd: () => {
          throw new Error("gone");
        },
      }),
    ).toBeNull();
    expect(tempDirectoryOf({ ...seams, getTempDirectory: () => "" })).toBeNull();
  });

  it("keeps the caller's seams and falls back to no session directory", () => {
    const seams = memoryWorld({ cwd: "/somewhere" });
    expect(resolveTargetDeps(seams, () => "/other")).toBe(seams);
    expect(resolveTargetDeps(undefined, undefined).getCwd()).toBe("");
  });
});

describe("defaultTargetContextDeps against a real filesystem", () => {
  // The injected seams above prove the logic; these prove the production seams
  // answer the same way, including a symlinked directory and $TMPDIR itself.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "target-context-")));
  mkdirSync(join(root, "proj/src"), { recursive: true });
  writeFileSync(join(root, "proj/src/client.py"), "print(1)\n");
  mkdirSync(join(root, "elsewhere"), { recursive: true });
  symlinkSync(join(root, "elsewhere"), join(root, "proj/link"));
  writeFileSync(join(root, "elsewhere/notes.md"), "n\n");

  // The fixture tree lives under $TMPDIR, so the temp boundary is pinned to a
  // directory of its own; otherwise every case here would read as `temp`.
  const seams: TargetContextDeps = {
    ...defaultTargetContextDeps(() => join(root, "proj")),
    getTempDirectory: () => join(root, "not-a-temp-dir"),
  };

  it("stats a real file and resolves a real symlink through it", () => {
    const client = join(root, "proj/src/client.py");
    const reading = extractTargetContext(pathAsk([client], client), seams);

    expect(reading.included === true && reading.target.state).toBe("file");
    expect(reading.included === true && reading.target.location).toBe("project");
    expect(reading.included === true && reading.target.resolved).toBeNull();
  });

  it("follows a symlink out of the project and says so", () => {
    const linked = join(root, "proj/link/notes.md");
    const real = join(root, "elsewhere/notes.md");
    const reading = extractTargetContext(pathAsk([linked, real], real), seams);

    expect(reading.included === true && reading.target.state).toBe("file");
    expect(reading.included === true && reading.target.resolved).toBe(
      join(root, "elsewhere/notes.md"),
    );
    expect(reading.included === true && reading.target.location).toBe("outside");
  });

  it("separates a create from a path into a directory that does not exist", () => {
    const create = extractTargetContext(
      pathAsk([join(root, "proj/new.md")], join(root, "proj/new.md")),
      seams,
    );
    const noDir = extractTargetContext(
      pathAsk([join(root, "proj/nodir/new.md")], join(root, "proj/nodir/new.md")),
      seams,
    );

    expect(create.included === true && create.target.state).toBe("missing");
    expect(noDir.included === true && noDir.target.state).toBe("missing-parent");
  });

  it("answers missing and null for the two kinds of stat failure", () => {
    expect(seams.stat(join(root, "proj/nope"))).toBe("missing");
    expect(seams.stat("/proc/definitely-not-here")).not.toBe("file");
    expect(seams.realpath(join(root, "proj/nope"))).toBeNull();
  });

  it("names the operating system's temporary directory", () => {
    const withTemp = defaultTargetContextDeps(() => join(root, "proj"));
    const inside = join(withTemp.getTempDirectory(), "scratch-thing.txt");

    expect(resolve(withTemp.getTempDirectory())).toBe(resolve(tmpdir()));
    expect(withTemp.stat(inside)).toBe("missing");
  });
});
