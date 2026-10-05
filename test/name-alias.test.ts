import type {
  Authorizer,
  AuthorizerLog,
  AuthorizerVerdict,
  PermissionQuery,
} from "@gotgenes/pi-permission-system";
import { describe, expect, it, vi } from "vitest";

import { ALIAS_NAME, createNamedAuthorizers, JUDGE_NAME } from "#src/name-alias";
import { askDetails } from "#test/fixtures/details";

const QUERY = {} as PermissionQuery;

function fakeLog(): AuthorizerLog {
  return { review: vi.fn(), debug: vi.fn() };
}

function harness(verdict: AuthorizerVerdict = { kind: "allow" }) {
  const judge = vi.fn<Authorizer["authorize"]>(async () => verdict);
  const warn = vi.fn<(message: string) => void>();
  const named = createNamedAuthorizers(judge, { warn });
  const byName = Object.fromEntries(named.map(({ name, authorize }) => [name, authorize]));
  return {
    judge,
    warn,
    named,
    primary: byName[JUDGE_NAME]!,
    alias: byName[ALIAS_NAME]!,
  };
}

function ask(requestId: string) {
  return { ...askDetails(), requestId };
}

const deprecations = (warn: ReturnType<typeof vi.fn>) =>
  warn.mock.calls.filter(([message]) => /deprecated/.test(String(message)));
const bothNames = (warn: ReturnType<typeof vi.fn>) =>
  warn.mock.calls.filter(([message]) => /both/.test(String(message)));

describe("createNamedAuthorizers", () => {
  it("gives permission-judge and the classifier alias one callback each", () => {
    const { named } = harness();
    expect(named.map(({ name }) => name)).toEqual(["permission-judge", "classifier"]);
  });

  it("judges an ask under the alias exactly as under permission-judge", async () => {
    const { judge, primary, alias } = harness({ kind: "deny", reason: "risky" });
    const details = ask("r1");
    const log = fakeLog();
    expect(await primary(details, QUERY, log)).toEqual({ kind: "deny", reason: "risky" });
    expect(await alias(ask("r2"), QUERY, log)).toEqual({ kind: "deny", reason: "risky" });
    expect(judge).toHaveBeenNthCalledWith(1, details, QUERY, log);
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it("warns once that the alias is deprecated, naming permission-judge", async () => {
    const { warn, alias, primary } = harness();
    await primary(ask("r0"), QUERY, fakeLog());
    expect(warn).not.toHaveBeenCalled();
    await alias(ask("r1"), QUERY, fakeLog());
    await alias(ask("r2"), QUERY, fakeLog());
    expect(deprecations(warn)).toHaveLength(1);
    expect(deprecations(warn)[0]![0]).toMatch(/classifier/);
    expect(deprecations(warn)[0]![0]).toMatch(/permission-judge/);
    expect(deprecations(warn)[0]![0]).toMatch(/authorizerChain/);
  });

  it("warns again for a new set of callbacks (the next session)", async () => {
    const first = harness();
    await first.alias(ask("r1"), QUERY, fakeLog());
    const second = harness();
    await second.alias(ask("r1"), QUERY, fakeLog());
    expect(deprecations(first.warn)).toHaveLength(1);
    expect(deprecations(second.warn)).toHaveLength(1);
  });

  it.each([
    ["permission-judge then classifier", "primary", "alias"],
    ["classifier then permission-judge", "alias", "primary"],
  ] as const)(
    "defers the second name for a request already judged (%s), with no judge call",
    async (_label, first, second) => {
      const h = harness({ kind: "defer" });
      const log = fakeLog();
      await h[first](ask("r1"), QUERY, fakeLog());
      expect(await h[second](ask("r1"), QUERY, log)).toEqual({ kind: "defer" });
      expect(h.judge).toHaveBeenCalledTimes(1);
      expect(log.review).not.toHaveBeenCalled();
    },
  );

  it("warns once that both names are listed and classifier should be removed", async () => {
    const { warn, primary, alias } = harness({ kind: "defer" });
    for (const id of ["r1", "r2"]) {
      await primary(ask(id), QUERY, fakeLog());
      await alias(ask(id), QUERY, fakeLog());
    }
    expect(bothNames(warn)).toHaveLength(1);
    expect(bothNames(warn)[0]![0]).toMatch(/remove/i);
    expect(bothNames(warn)[0]![0]).toMatch(/classifier/);
  });

  it("judges a request id again once it falls out of the 8-entry ring", async () => {
    const { judge, primary, alias } = harness({ kind: "defer" });
    await primary(ask("r0"), QUERY, fakeLog());
    for (let i = 1; i <= 7; i += 1) {
      await primary(ask(`r${i}`), QUERY, fakeLog());
    }
    // r0 is still one of the last 8.
    await alias(ask("r0"), QUERY, fakeLog());
    expect(judge).toHaveBeenCalledTimes(8);
    await primary(ask("r8"), QUERY, fakeLog());
    // r0 is evicted now: judged again.
    await alias(ask("r0"), QUERY, fakeLog());
    expect(judge).toHaveBeenCalledTimes(10);
  });

  it("judges the same request id again under the same name", async () => {
    const { judge, primary } = harness({ kind: "defer" });
    await primary(ask("r1"), QUERY, fakeLog());
    await primary(ask("r1"), QUERY, fakeLog());
    expect(judge).toHaveBeenCalledTimes(2);
  });
});
