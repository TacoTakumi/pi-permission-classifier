import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  MAX_MESSAGE_CHARS,
  MAX_TOTAL_CHARS,
  readUserIntent,
  selectUserText,
} from "#src/user-intent";

let nextId = 0;

function base(): { id: string; parentId: null; timestamp: string } {
  nextId += 1;
  return { id: `e${nextId}`, parentId: null, timestamp: "2026-10-06T00:00:00Z" };
}

function user(content: string | { type: "text"; text: string }[]): SessionEntry {
  return {
    ...base(),
    type: "message",
    message: { role: "user", content, timestamp: 0 },
  } as SessionEntry;
}

function assistant(text: string): SessionEntry {
  return {
    ...base(),
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-completions",
      provider: "test",
      model: "test",
      usage: {},
      stopReason: "stop",
      timestamp: 0,
    },
  } as unknown as SessionEntry;
}

function toolResult(text: string): SessionEntry {
  return {
    ...base(),
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 0,
    },
  } as unknown as SessionEntry;
}

function bashExecution(output: string): SessionEntry {
  return {
    ...base(),
    type: "message",
    message: {
      role: "bashExecution",
      command: "ls",
      output,
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 0,
    },
  } as unknown as SessionEntry;
}

function customMessage(text: string): SessionEntry {
  return {
    ...base(),
    type: "custom_message",
    customType: "note",
    content: text,
    display: true,
  } as SessionEntry;
}

function compaction(summary: string): SessionEntry {
  return {
    ...base(),
    type: "compaction",
    summary,
    firstKeptEntryId: "e0",
    tokensBefore: 0,
  } as SessionEntry;
}

function branchSummary(summary: string): SessionEntry {
  return {
    ...base(),
    type: "branch_summary",
    fromId: "e0",
    summary,
  } as SessionEntry;
}

describe("selectUserText", () => {
  it("keeps only user-role message text", () => {
    const selection = selectUserText([
      user("fix the build"),
      assistant("ASSISTANT-SECRET"),
      toolResult("TOOL-SECRET"),
      bashExecution("BASH-SECRET"),
      customMessage("CUSTOM-SECRET"),
      compaction("COMPACTION-SECRET"),
      branchSummary("BRANCH-SECRET"),
      user([{ type: "text", text: "then push it" }]),
    ]);

    expect(selection).toEqual({
      messages: ["fix the build", "then push it"],
      cut: false,
    });
    const joined = selection.messages.join("\n");
    for (const secret of ["ASSISTANT", "TOOL", "BASH", "CUSTOM", "COMPACTION", "BRANCH"]) {
      expect(joined).not.toContain(`${secret}-SECRET`);
    }
  });

  it("joins the text parts of one message and skips image parts", () => {
    const entry = {
      ...base(),
      type: "message",
      message: {
        role: "user",
        content: [
          { type: "text", text: "look at" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
          { type: "text", text: "this screenshot" },
        ],
        timestamp: 0,
      },
    } as SessionEntry;

    expect(selectUserText([entry]).messages).toEqual(["look at\nthis screenshot"]);
  });

  it("drops a user message with no text", () => {
    const entry = {
      ...base(),
      type: "message",
      message: {
        role: "user",
        content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
        timestamp: 0,
      },
    } as SessionEntry;

    expect(selectUserText([entry])).toEqual({ messages: [], cut: false });
  });

  it("reduces a skill expansion to its name and args", () => {
    const body = "SKILL-BODY ".repeat(50);
    const selection = selectUserText([
      user(`<skill name="deploy" location="/skills/deploy/SKILL.md">\n${body}\n</skill>\n\nship to staging`),
      user(`<skill name="lint" location="/skills/lint/SKILL.md">\n${body}\n</skill>`),
    ]);

    expect(selection).toEqual({
      messages: ["[skill deploy] ship to staging", "[skill lint]"],
      cut: false,
    });
  });

  it("caps a long message keeping its head and tail and sets cut", () => {
    const long = `HEAD${"x".repeat(10_000)}TAIL`;
    const selection = selectUserText([user(long)]);

    expect(selection.cut).toBe(true);
    const [kept] = selection.messages;
    expect(kept.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(kept.startsWith("HEAD")).toBe(true);
    expect(kept.endsWith("TAIL")).toBe(true);
  });

  it("keeps a message of exactly the cap whole", () => {
    const exact = "y".repeat(MAX_MESSAGE_CHARS);

    expect(selectUserText([user(exact)])).toEqual({ messages: [exact], cut: false });
  });

  it("keeps the first message and the newest back to the total cap and sets cut", () => {
    const first = `FIRST${"a".repeat(3_000)}`;
    const middle = Array.from({ length: 20 }, (_, index) =>
      `M${String(index).padStart(2, "0")}${"b".repeat(2_997)}`,
    );
    const selection = selectUserText([user(first), ...middle.map((text) => user(text))]);

    expect(selection.cut).toBe(true);
    expect(selection.messages[0]).toBe(first);
    const total = selection.messages.reduce((sum, text) => sum + text.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_CHARS);
    // The kept tail is the newest messages, contiguous and in order.
    const rest = selection.messages.slice(1);
    expect(rest).toEqual(middle.slice(middle.length - rest.length));
    expect(rest.length).toBe(6);
  });

  it("sets no cut for a short session", () => {
    const selection = selectUserText([user("one"), assistant("ok"), user("two"), user("three")]);

    expect(selection).toEqual({ messages: ["one", "two", "three"], cut: false });
  });

  it("returns no messages and no cut for a session without user text", () => {
    expect(selectUserText([])).toEqual({ messages: [], cut: false });
    expect(selectUserText([assistant("hello")])).toEqual({ messages: [], cut: false });
  });
});

describe("readUserIntent", () => {
  function source(entries: SessionEntry[], pending = false) {
    return {
      sessionManager: { getBranch: () => entries },
      hasPendingMessages: () => pending,
    };
  }

  it("returns the selected messages when nothing was cut, queued or forwarded", () => {
    expect(readUserIntent(source([user("deploy it"), assistant("ok")]), false)).toEqual({
      messages: ["deploy it"],
    });
  });

  it("returns none when the selection was cut", () => {
    expect(readUserIntent(source([user("z".repeat(MAX_MESSAGE_CHARS + 1))]), false)).toBeUndefined();
  });

  it("returns none when a user message is queued", () => {
    expect(readUserIntent(source([user("deploy it")], true), false)).toBeUndefined();
  });

  it("returns none for an ask forwarded from a subagent", () => {
    expect(readUserIntent(source([user("deploy it")]), true)).toBeUndefined();
  });

  it("returns none with no session or no user text", () => {
    expect(readUserIntent(undefined, false)).toBeUndefined();
    expect(readUserIntent(source([assistant("hi")]), false)).toBeUndefined();
  });

  it("returns none when reading the session throws", () => {
    const broken = {
      sessionManager: {
        getBranch: (): SessionEntry[] => {
          throw new Error("gone");
        },
      },
      hasPendingMessages: () => false,
    };
    expect(readUserIntent(broken, false)).toBeUndefined();
  });

  it("returns none when the context has no pending-message query", () => {
    expect(
      readUserIntent({ sessionManager: { getBranch: () => [user("deploy it")] } }, false),
    ).toBeUndefined();
  });
});
