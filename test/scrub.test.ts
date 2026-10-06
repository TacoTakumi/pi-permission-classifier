import { describe, expect, it } from "vitest";

import { findUnscrubbed, scrubDeep, scrubString } from "../eval/scrub";

const MACHINE = { homeDir: "/home/you", userName: "you" };

describe("scrubString: each rule", () => {
  it.each([
    ["the machine home dir", "cd /home/you/AI/Projects/game && ls", "cd ~/AI/Projects/game && ls"],
    ["another home dir", "cat /home/user/notes.txt", "cat ~/notes.txt"],
    ["the login name as a word", "chown you:you /srv/x; ls --home-you-AI--", "chown <user>:<user> /srv/x; ls --home-<user>-AI--"],
    ["a macOS home dir", "ls /Users/you/src", "ls ~/src"],
    ["an email address", "echo mail to you@example.com now", "echo mail to <email> now"],
    [
      "git identity flags",
      'git -c user.name="you" -c user.email=you@example.com commit -q',
      "git -c user.name=<user> -c user.email=<email> commit -q",
    ],
    [
      "a git name from a variable default",
      'git -c user.name="${GIT_AUTHOR_NAME:-you}" commit',
      "git -c user.name=<user> commit",
    ],
    ["a LAN address", "curl http://192.168.1.20:8080/api", "curl http://<ip>:8080/api"],
    ["a /volN mount", "ls /vol2/Archive/x", "ls <mount>/Archive/x"],
    ["a /hosts mount", "touch /hosts/one/media/.probe", "touch <mount>/media/.probe"],
    ["a key value", "export TAVILY_API_KEY=abc123def456 && run", "export TAVILY_API_KEY=<redacted> && run"],
    ["a quoted token value", 'TOKEN="sk-live-0123456789" node x.js', "TOKEN=<redacted> node x.js"],
    ["a password value", "mysql --password=hunter2 db", "mysql --password=<redacted> db"],
    ["a query parameter token", "curl 'https://x.io/s?q=1&security_token=abcd1234' -o y", "curl 'https://x.io/s?q=1&security_token=<redacted>' -o y"],
    ["a bearer token", 'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc" u', 'curl -H "Authorization: Bearer <redacted>" u'],
  ])("scrubs %s", (_name, input, expected) => {
    expect(scrubString(input, MACHINE)).toBe(expected);
  });
});

describe("scrubString: kept forms", () => {
  it.each([
    ["a variable reference", 'curl -H "x-csrf-token: $TOKEN" u'],
    ["a quoted variable reference", 'TOKEN="$TOKEN" node x.js'],
    ["an already redacted value", "API_KEY=<redacted> node x.js"],
    ["loopback", "curl http://127.0.0.1:8188/prompt"],
    ["the unspecified address", "serve --bind 0.0.0.0"],
    ["a variable name alone", 'echo "TAVILY_API_KEY set: ${TAVILY_API_KEY:+yes}"'],
    ["a package version with an at sign", "node_modules/.pnpm/zod@4.4.3/node_modules"],
    ["a scoped package with an at sign", "@earendil-works+pi-ai@0.79.1_ws"],
    ["a tilde path", "ls ~/AI/Projects"],
    ["a git sha", "git checkout 9ccd445 -- game/scripts/audio/music.gd"],
    ["the login name inside a longer word", "yount myou you_x"],
    ["a lowercase sort key", "sorted(xs, key=lambda d: d['num'])"],
  ])("keeps %s", (_name, input) => {
    expect(scrubString(input, MACHINE)).toBe(input);
  });
});

describe("scrubDeep", () => {
  it("scrubs every string in nested arrays and objects and leaves other values", () => {
    const record = {
      cwd: "/home/you/AI/Projects/game",
      value: 'git -c user.email=you@example.com commit -m "x"',
      answers: { reversible: 0.9, hazard: [["none", 0.97]] },
      userMessages: ["ping 192.168.1.20 from /vol2/data", "plain text"],
      forwarded: false,
      modelId: null,
    };
    expect(scrubDeep(record, MACHINE)).toEqual({
      cwd: "~/AI/Projects/game",
      value: 'git -c user.email=<email> commit -m "x"',
      answers: { reversible: 0.9, hazard: [["none", 0.97]] },
      userMessages: ["ping <ip> from <mount>/data", "plain text"],
      forwarded: false,
      modelId: null,
    });
  });
});

describe("findUnscrubbed", () => {
  it("reports each rule still matching a raw line and nothing on a scrubbed one", () => {
    const raw = 'cd /home/you && git -c user.name="you" push; ssh 10.0.0.5; KEY=abcdefgh; mail bob@example.org';
    const rules = findUnscrubbed(raw).map((hit) => hit.rule);
    expect(rules).toEqual(["git-user-name", "home-dir", "secret-value", "email", "ipv4"]);
    expect(findUnscrubbed(scrubString(raw, MACHINE))).toEqual([]);
  });
});
