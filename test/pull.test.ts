import { describe, expect, it } from "vitest";

import { mergeStore, type StoredAsk, storedAsksFromLog, storedIds, toolCallsFromSession } from "../eval/pull";

const HOME = "/home/you";

const SESSION_LINES = [
  JSON.stringify({ type: "session", id: "sess-1", cwd: "/home/you/AI/Projects/game" }),
  JSON.stringify({
    type: "message",
    id: "u1",
    message: { role: "user", content: [{ type: "text", text: "run the tests, mail you@example.com when done" }] },
  }),
  JSON.stringify({
    type: "message",
    id: "a1",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc1",
          name: "bash",
          arguments: { command: "cd /home/you/AI/Projects/game && tools/test.sh 2>&1 | tail -5" },
        },
        { type: "toolCall", id: "tc2", name: "bash", arguments: { command: "git push" } },
        { type: "toolCall", id: "tc3", name: "bash", arguments: { command: 'TOKEN="sk-secret-0001" node send.js' } },
        { type: "toolCall", id: "tc4", name: "bash", arguments: { command: "ls" } },
      ],
    },
  }),
];

const QUICK_ANSWERS = { reversible: 0.9, contained: 0.88, hazard: [["none", 0.97], ["push_or_publish", 0.03]] };

const LOG_ROWS = [
  {
    timestamp: "2026-10-06T16:00:00.000Z",
    event: "permission_request.waiting",
    requestId: "r1",
    toolCallId: "tc1",
    surface: "bash",
    toolName: "bash",
    command: "tools/test.sh",
  },
  {
    timestamp: "2026-10-06T16:00:00.200Z",
    event: "classifier.decision",
    requestId: "r1",
    judge: "quick",
    verdict: "defer",
    deferReason: "model-verdict",
    modelId: "typesafe/jev-latest",
    modelCalled: true,
    latencyMs: 250,
    answers: QUICK_ANSWERS,
  },
  {
    timestamp: "2026-10-06T16:00:05.000Z",
    event: "classifier.decision",
    requestId: "r1",
    judge: "llm",
    verdict: "allow",
    deferReason: null,
    modelId: "google/gemini",
    modelCalled: true,
    latencyMs: 4800,
  },
  {
    timestamp: "2026-10-06T16:00:05.100Z",
    event: "permission_request.approved",
    requestId: "r1",
    decidedBy: { kind: "authorizer", name: "permission-judge", verdict: "allow" },
  },
  {
    timestamp: "2026-10-06T16:01:00.000Z",
    event: "permission_request.waiting",
    requestId: "r2",
    toolCallId: "tc2",
    surface: "bash",
    toolName: "bash",
    command: "git push",
  },
];

describe("toolCallsFromSession", () => {
  it("reports the session id and cwd with each call", () => {
    const call = toolCallsFromSession(SESSION_LINES).get("tc1");
    expect(call?.sessionId).toBe("sess-1");
    expect(call?.cwd).toBe("/home/you/AI/Projects/game");
    expect(call?.command).toBe("cd /home/you/AI/Projects/game && tools/test.sh 2>&1 | tail -5");
    expect(call?.userMessages).toEqual(["run the tests, mail you@example.com when done"]);
  });
});

describe("storedAsksFromLog", () => {
  const calls = toolCallsFromSession(SESSION_LINES);

  it("stores one ask per waiting request with a final event, and leaves a waiting one", () => {
    const asks = storedAsksFromLog(LOG_ROWS, calls, HOME);
    expect(asks.map((ask) => ask.id)).toEqual(["r1"]);
    const expected: StoredAsk = {
      id: "r1",
      timestamp: "2026-10-06T16:00:00.000Z",
      sessionId: "sess-1",
      surface: "bash",
      tool: "bash",
      value: "tools/test.sh",
      cwd: "~/AI/Projects/game",
      fullCommand: "cd ~/AI/Projects/game && tools/test.sh 2>&1 | tail -5",
      forwarded: false,
      decisions: [
        {
          judge: "quick",
          verdict: "defer",
          deferReason: "model-verdict",
          modelId: "typesafe/jev-latest",
          modelCalled: true,
          latencyMs: 250,
          answers: QUICK_ANSWERS,
        },
        { judge: "llm", verdict: "allow", deferReason: null, modelId: "google/gemini", modelCalled: true, latencyMs: 4800 },
      ],
      resolution: "approved",
      decider: "judge",
      deciderName: "permission-judge",
      userMessages: ["run the tests, mail <email> when done"],
    };
    expect(asks[0]).toEqual(expected);
  });

  it("nests the decisions in log order, answers on the quick one only", () => {
    const [ask] = storedAsksFromLog(LOG_ROWS, calls, HOME);
    expect(ask?.decisions.map((decision) => decision.judge)).toEqual(["quick", "llm"]);
    expect(ask?.decisions[0]).toHaveProperty("answers");
    expect(ask?.decisions[1]).not.toHaveProperty("answers");
  });

  it("scrubs every string: cwd, value, full command and user text", () => {
    const rows = [
      {
        timestamp: "t",
        event: "permission_request.waiting",
        requestId: "r3",
        toolCallId: "tc3",
        surface: "bash",
        toolName: "bash",
        command: "node send.js to you@example.com",
      },
      { event: "permission_request.approved", requestId: "r3", decidedBy: { kind: "user", via: "dialog" } },
    ];
    const session = [
      JSON.stringify({ type: "session", id: "sess-2", cwd: "/home/you/work" }),
      JSON.stringify({
        type: "message",
        id: "u1",
        message: { role: "user", content: [{ type: "text", text: "send it to 192.168.1.20 under /vol2/out" }] },
      }),
      JSON.stringify({
        type: "message",
        id: "a1",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc3", name: "bash", arguments: { command: 'TOKEN="sk-secret-0001" node send.js' } }],
        },
      }),
    ];
    const [ask] = storedAsksFromLog(rows, toolCallsFromSession(session), HOME);
    const line = JSON.stringify(ask);
    for (const raw of ["/home/you", "you@example.com", "192.168.1.20", "/vol2", "sk-secret-0001"]) {
      expect(line).not.toContain(raw);
    }
    expect(ask?.cwd).toBe("~/work");
    expect(ask?.value).toBe("node send.js to <email>");
    expect(ask?.fullCommand).toBe("TOKEN=<redacted> node send.js");
    expect(ask?.userMessages).toEqual(["send it to <ip> under <mount>/out"]);
    expect(ask?.decider).toBe("user");
  });

  it("follows forwarded hops to the decider and drops user text on a forwarded ask", () => {
    const rows = [
      {
        timestamp: "t",
        event: "permission_request.waiting",
        requestId: "r4",
        toolCallId: "tc4",
        surface: "bash",
        toolName: "bash",
        command: "ls",
        forwarded: true,
      },
      {
        event: "permission_request.approved",
        requestId: "r4",
        decidedBy: { kind: "forwarded", decision: { kind: "rule" } },
      },
      { timestamp: "t", event: "permission_request.waiting", requestId: "r5", toolCallId: "tc4", surface: "bash", toolName: "bash", command: "ls" },
      { event: "permission_request.session_approved", requestId: "r5", decidedBy: { kind: "session_approval" } },
      { timestamp: "t", event: "permission_request.waiting", requestId: "r6", toolCallId: "tc4", surface: "bash", toolName: "bash", command: "ls" },
      { event: "permission_request.denied", requestId: "r6" },
    ];
    const asks = storedAsksFromLog(rows, calls, HOME);
    expect(asks.map((ask) => [ask.id, ask.forwarded, ask.resolution, ask.decider, ask.userMessages])).toEqual([
      ["r4", true, "approved", "rule", undefined],
      ["r5", false, "session_approved", "session", ["run the tests, mail <email> when done"]],
      ["r6", false, "denied", "other", ["run the tests, mail <email> when done"]],
    ]);
    expect(asks[0]?.decisions).toEqual([]);
  });

  it("skips a waiting row whose tool call is not in the index", () => {
    const rows = [
      { timestamp: "t", event: "permission_request.waiting", requestId: "r7", toolCallId: "missing", surface: "bash", toolName: "bash", command: "ls" },
      { event: "permission_request.approved", requestId: "r7" },
    ];
    expect(storedAsksFromLog(rows, calls, HOME)).toEqual([]);
  });
});

describe("mergeStore", () => {
  const calls = toolCallsFromSession(SESSION_LINES);
  const asks = storedAsksFromLog(LOG_ROWS, calls, HOME);

  it("appends every ask to an empty store and nothing on a second merge", () => {
    const first = mergeStore([], asks);
    expect(first.map((line) => (JSON.parse(line) as StoredAsk).id)).toEqual(["r1"]);
    expect(mergeStore(first, asks)).toEqual([]);
  });

  it("leaves existing lines as they are and adds a new ask as the last line", () => {
    const existing = [JSON.stringify({ id: "r0", value: "old" }), ""];
    const added = mergeStore(existing, asks);
    const store = [...existing.filter((line) => line !== ""), ...added];
    expect(store[0]).toBe(existing[0]);
    expect(store.length).toBe(2);
    expect((JSON.parse(store[1]!) as StoredAsk).id).toBe("r1");
  });

  it("reads ids from the store lines and skips a line that is not JSON", () => {
    expect(storedIds(['{"id":"a"}', "not json", "", '{"id":"b"}'])).toEqual(new Set(["a", "b"]));
  });
});
