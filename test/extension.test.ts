import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Model } from "@earendil-works/pi-ai";
import type {
  PermissionsService,
  PromptPermissionDetails,
} from "@gotgenes/pi-permission-system";
import {
  publishPermissionsService,
  unpublishPermissionsService,
} from "@gotgenes/pi-permission-system";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getGlobalConfigPath, type LoadConfigResult } from "#src/config-loader";
import {
  type ClassifierDependencies,
  createClassifierExtension,
} from "#src/extension";
import piPermissionClassifier from "#src/index";
import type { CompleteFn } from "#src/model-review";
import { assistantToolCall } from "#test/fixtures/assistant-message";
import { askDetails } from "#test/fixtures/details";

const READY_CHANNEL = "permissions:ready";

const CONFIG_RESULT: LoadConfigResult = {
  config: {
    surfaces: ["bash", "mcp", "skill", "tool", "read", "write", "edit"],
    timeoutMs: 5000,
    contextBudgetBytes: 8192,
  },
  issues: [],
  projectSetsJudge: false,
};

const SESSION_MODEL = { provider: "anthropic", id: "claude-opus" } as Model<any>;
const NEXT_MODEL = { provider: "anthropic", id: "claude-haiku" } as Model<any>;

interface FakePi {
  lifecycle: Map<string, (event: unknown, ctx: unknown) => void>;
  events: Map<string, (data: unknown) => void>;
  api: {
    on: ReturnType<typeof vi.fn>;
    events: { on: ReturnType<typeof vi.fn>; emit: ReturnType<typeof vi.fn> };
    registerFlag: ReturnType<typeof vi.fn>;
    getFlag: ReturnType<typeof vi.fn>;
    registerCommand: ReturnType<typeof vi.fn>;
    setModel: ReturnType<typeof vi.fn>;
  };
  commands: Map<string, RegisteredCommandOptions>;
}

interface RegisteredCommandOptions {
  description?: string;
  getArgumentCompletions?: (prefix: string) => unknown;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

function makeFakePi(): FakePi {
  const lifecycle = new Map<string, (event: unknown, ctx: unknown) => void>();
  const events = new Map<string, (data: unknown) => void>();
  const commands = new Map<string, RegisteredCommandOptions>();
  return {
    lifecycle,
    events,
    commands,
    api: {
      on: vi.fn(
        (name: string, handler: (event: unknown, ctx: unknown) => void) => {
          lifecycle.set(name, handler);
        },
      ),
      events: {
        on: vi.fn((channel: string, handler: (data: unknown) => void) => {
          events.set(channel, handler);
          return () => events.delete(channel);
        }),
        emit: vi.fn(),
      },
      registerFlag: vi.fn(),
      getFlag: vi.fn(() => undefined),
      registerCommand: vi.fn(
        (name: string, options: RegisteredCommandOptions) => {
          commands.set(name, options);
        },
      ),
      setModel: vi.fn(),
    },
  };
}

function makeService(): PermissionsService & {
  registerAuthorizer: ReturnType<typeof vi.fn>;
  disposer: ReturnType<typeof vi.fn>;
} {
  const disposer = vi.fn();
  return {
    checkPermission: vi.fn(),
    getToolPermission: vi.fn(),
    registerToolInputFormatter: vi.fn(() => () => {}),
    registerToolAccessExtractor: vi.fn(() => () => {}),
    registerAuthorizer: vi.fn(() => disposer),
    disposer,
  };
}

/** The authorize callback shape `registerAuthorizer` receives. */
type RegisteredAuthorizer = (
  details: PromptPermissionDetails,
  query: unknown,
  log: { review: () => void; debug: () => void },
) => Promise<unknown>;

const SESSION_ID = "session-1";

/**
 * The extension takes the session id solely from the ready payload, so the
 * fake ctx deliberately carries no session manager.
 */
function ctxWithModel() {
  return {
    cwd: "/project",
    mode: "tui" as const,
    model: SESSION_MODEL,
    isProjectTrusted: vi.fn(() => true),
    modelRegistry: {
      find: vi.fn(),
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true as const,
        apiKey: "sk-test",
      })),
      hasConfiguredAuth: vi.fn(() => true),
      getAvailable: vi.fn(() => []),
      runtime: { getAvailableSnapshot: vi.fn(() => []) },
    },
    scopedModels: [] as const,
    ui: {
      setStatus: vi.fn(),
      notify: vi.fn(),
      custom: vi.fn(
        (
          factory: (
            tui: unknown,
            theme: unknown,
            keybindings: unknown,
            done: (result: unknown) => void,
          ) => unknown,
        ) =>
          new Promise<unknown>((resolve) => {
            factory({}, {}, {}, resolve);
          }),
      ),
      select: vi.fn(),
    },
  };
}

const STATUS_KEY = "zz-permission-classifier";

const CONFIG_PM_RESULT: LoadConfigResult = {
  config: { ...CONFIG_RESULT.config!, provider: "p", model: "m" },
  issues: [],
  projectSetsJudge: false,
};
const PM_MODEL = { provider: "p", id: "m" } as Model<any>;

const CONFIG_QN_RESULT: LoadConfigResult = {
  config: { ...CONFIG_RESULT.config!, provider: "q", model: "n" },
  issues: [],
  projectSetsJudge: false,
};
const QN_MODEL = { provider: "q", id: "n" } as Model<any>;

/** A registry that knows exactly p/m and q/n. */
function findKnown(provider: string, id: string): Model<any> | undefined {
  if (provider === "p" && id === "m") return PM_MODEL;
  if (provider === "q" && id === "n") return QN_MODEL;
  return undefined;
}

const allowingComplete = () =>
  vi.fn<CompleteFn>(async () => assistantToolCall({ verdict: "allow" }));

function lastAuthorizer(): RegisteredAuthorizer {
  return service.registerAuthorizer.mock.calls.at(-1)?.[1] as RegisteredAuthorizer;
}

let service: ReturnType<typeof makeService>;
/** Scratch agent dirs created by `start()`; removed after each test. */
const agentDirs: string[] = [];

beforeEach(() => {
  service = makeService();
});

afterEach(() => {
  unpublishPermissionsService(SESSION_ID, service);
  vi.restoreAllMocks();
  for (const dir of agentDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A throwaway agent dir holding an empty global config, so writes are allowed. */
function makeAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-permission-classifier-agent-"));
  const globalPath = getGlobalConfigPath(dir);
  mkdirSync(dirname(globalPath), { recursive: true });
  writeFileSync(globalPath, "{}");
  agentDirs.push(dir);
  return dir;
}

/** Publish `service` under {@link SESSION_ID} in the keyed locator. */
function publishForSession(): void {
  publishPermissionsService(SESSION_ID, service);
}

const READY_EVENT = { sessionId: SESSION_ID, adjudicatesLocally: true };
const READY_EVENT_NO_ID = { sessionId: null, adjudicatesLocally: true };

function start(
  pi: FakePi,
  overrides: {
    loadConfig?: ClassifierDependencies["loadConfig"];
    complete?: CompleteFn;
    writeJudge?: ClassifierDependencies["writeJudge"];
    buildPicker?: ClassifierDependencies["buildPicker"];
    loadGuidance?: ClassifierDependencies["loadGuidance"];
  } = {},
) {
  const agentDir = makeAgentDir();
  createClassifierExtension(pi.api as never, {
    agentDir: () => agentDir,
    loadConfig: overrides.loadConfig ?? (() => CONFIG_RESULT),
    complete: overrides.complete ?? vi.fn(),
    writeJudge: overrides.writeJudge ?? vi.fn(),
    ...(overrides.buildPicker ? { buildPicker: overrides.buildPicker } : {}),
    loadGuidance: overrides.loadGuidance ?? (() => []),
  });
  return agentDir;
}

describe("createClassifierExtension", () => {
  it("registers the classifier link from the ready handler via the keyed locator", () => {
    const pi = makeFakePi();
    start(pi);
    pi.lifecycle.get("session_start")?.({}, ctxWithModel());
    expect(service.registerAuthorizer).not.toHaveBeenCalled();
    publishForSession();
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(service.registerAuthorizer).toHaveBeenCalledTimes(1);
    expect(service.registerAuthorizer.mock.calls[0]?.[0]).toBe("classifier");
    expect(typeof service.registerAuthorizer.mock.calls[0]?.[1]).toBe(
      "function",
    );
  });

  it("registers at most once across repeated ready emissions", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pi = makeFakePi();
    start(pi);
    publishForSession();
    pi.lifecycle.get("session_start")?.({}, ctxWithModel());
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(service.registerAuthorizer).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("registers nothing and warns when the config is invalid", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pi = makeFakePi();
    start(pi, {
      loadConfig: () => ({
        config: undefined,
        issues: [{ path: "provider", message: "must come with model" }],
        projectSetsJudge: false,
      }),
    });
    publishForSession();
    pi.lifecycle.get("session_start")?.({}, ctxWithModel());
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(service.registerAuthorizer).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("warns once about an ignored surfaces field and still registers", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pi = makeFakePi();
    start(pi, {
      loadConfig: () => ({
        config: CONFIG_RESULT.config,
        issues: [
          {
            path: "surfaces",
            message: "This field is ignored: every surface is judged.",
            sourcePath: "/project/.pi/extensions/pi-permission-classifier/config.json",
          },
        ],
        projectSetsJudge: false,
      }),
    });
    publishForSession();
    pi.lifecycle.get("session_start")?.({}, ctxWithModel());
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(service.registerAuthorizer).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/surfaces/);
    expect(warn.mock.calls[0]?.[0]).toMatch(/ignored/);
  });

  it("judges with the session model captured at session_start", async () => {
    const complete = vi.fn<CompleteFn>(async () =>
      assistantToolCall({ verdict: "allow" }),
    );
    const pi = makeFakePi();
    start(pi, { complete });
    publishForSession();
    pi.lifecycle.get("session_start")?.({}, ctxWithModel());
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    const authorize = service.registerAuthorizer.mock
      .calls[0]?.[1] as RegisteredAuthorizer;
    await authorize(askDetails(), {}, { review: vi.fn(), debug: vi.fn() });
    expect(complete.mock.calls[0]?.[0]).toBe(SESSION_MODEL);
  });

  it("follows a mid-session model_select for the next judged ask", async () => {
    const complete = vi.fn<CompleteFn>(async () =>
      assistantToolCall({ verdict: "allow" }),
    );
    const pi = makeFakePi();
    start(pi, { complete });
    publishForSession();
    const ctx = ctxWithModel();
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    pi.lifecycle.get("model_select")?.(
      { type: "model_select", model: NEXT_MODEL, previousModel: SESSION_MODEL },
      ctx,
    );
    const authorize = service.registerAuthorizer.mock
      .calls[0]?.[1] as RegisteredAuthorizer;
    await authorize(askDetails(), {}, { review: vi.fn(), debug: vi.fn() });
    expect(complete.mock.calls[0]?.[0]).toBe(NEXT_MODEL);
  });

  it("disposes on session_shutdown and a fresh session registers afresh", () => {
    const pi = makeFakePi();
    start(pi);
    publishForSession();
    pi.lifecycle.get("session_start")?.({}, ctxWithModel());
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(service.registerAuthorizer).toHaveBeenCalledTimes(1);
    pi.lifecycle.get("session_shutdown")?.({}, ctxWithModel());
    expect(service.disposer).toHaveBeenCalledTimes(1);
    // A late ready from the torn-down session must not re-register.
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(service.registerAuthorizer).toHaveBeenCalledTimes(1);
    // A subsequent session registers on its own keyed service.
    const nextService = makeService();
    publishPermissionsService("session-2", nextService);
    try {
      pi.lifecycle.get("session_start")?.({}, ctxWithModel());
      pi.events.get(READY_CHANNEL)?.({
        sessionId: "session-2",
        adjudicatesLocally: true,
      });
      expect(nextService.registerAuthorizer).toHaveBeenCalledTimes(1);
      expect(service.registerAuthorizer).toHaveBeenCalledTimes(1);
    } finally {
      unpublishPermissionsService("session-2", nextService);
    }
  });

  it("warns once per session and registers nothing when ready carries no session id", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pi = makeFakePi();
    start(pi);
    publishForSession();
    pi.lifecycle.get("session_start")?.({}, ctxWithModel());
    pi.events.get(READY_CHANNEL)?.(READY_EVENT_NO_ID);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT_NO_ID);
    expect(service.registerAuthorizer).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/27\.0\.0/);
  });

  it("warns once per session and registers nothing on a keyed locator miss", () => {
    // Only a foreign session key is populated — the classifier must resolve
    // its own session's service or none, so this is a locator miss.
    const otherService = makeService();
    publishPermissionsService("other-session", otherService);
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const pi = makeFakePi();
      start(pi);
      pi.lifecycle.get("session_start")?.({}, ctxWithModel());
      pi.events.get(READY_CHANNEL)?.(READY_EVENT);
      pi.events.get(READY_CHANNEL)?.(READY_EVENT);
      expect(otherService.registerAuthorizer).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/27\.0\.0/);
    } finally {
      unpublishPermissionsService("other-session", otherService);
    }
  });

  it("resets the warn-once latch at session_shutdown", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pi = makeFakePi();
    start(pi);
    pi.lifecycle.get("session_start")?.({}, ctxWithModel());
    pi.events.get(READY_CHANNEL)?.(READY_EVENT_NO_ID);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT_NO_ID);
    expect(warn).toHaveBeenCalledTimes(1);
    pi.lifecycle.get("session_shutdown")?.({}, ctxWithModel());
    pi.lifecycle.get("session_start")?.({}, ctxWithModel());
    pi.events.get(READY_CHANNEL)?.(READY_EVENT_NO_ID);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT_NO_ID);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("footer health suffix", () => {
  const failingComplete = () =>
    vi.fn<CompleteFn>(async () => {
      throw new Error("model unavailable");
    });
  const denyingComplete = () =>
    vi.fn<CompleteFn>(async () =>
      assistantToolCall({ verdict: "deny", reason: "no" }),
    );
  const fakeLog = () => ({ review: vi.fn(), debug: vi.fn() });

  function lastStatus(ctx: ReturnType<typeof ctxWithModel>) {
    return ctx.ui.setStatus.mock.calls.at(-1)?.[1];
  }

  it("appends the failure reason and count after a failed review", async () => {
    const pi = makeFakePi();
    start(pi, { complete: failingComplete() });
    publishForSession();
    const ctx = ctxWithModel();
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(lastStatus(ctx)).toBe("judge:session");
    await lastAuthorizer()(askDetails(), {}, fakeLog());
    expect(lastStatus(ctx)).toBe("judge:session | call-failed x1");
    await lastAuthorizer()(askDetails(), {}, fakeLog());
    expect(lastStatus(ctx)).toBe("judge:session | call-failed x2");
  });

  it("shows timeout after a review that ran out of time", async () => {
    const pi = makeFakePi();
    const complete = vi.fn<CompleteFn>(
      (_model, _context, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    start(pi, {
      complete,
      loadConfig: () => ({
        ...CONFIG_RESULT,
        config: { ...CONFIG_RESULT.config!, timeoutMs: 20 },
      }),
    });
    publishForSession();
    const ctx = ctxWithModel();
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    await lastAuthorizer()(askDetails(), {}, fakeLog());
    expect(lastStatus(ctx)).toBe("judge:session | timeout x1");
  });

  it("keeps the count and drops the reason after a following allow", async () => {
    const complete = failingComplete();
    const pi = makeFakePi();
    start(pi, { complete });
    publishForSession();
    const ctx = ctxWithModel();
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    await lastAuthorizer()(askDetails(), {}, fakeLog());
    complete.mockImplementation(async () => assistantToolCall({ verdict: "allow" }));
    await lastAuthorizer()(askDetails(), {}, fakeLog());
    expect(lastStatus(ctx)).toBe("judge:session | defers x1");
  });

  it("leaves the reason in place after a following deny", async () => {
    const complete = failingComplete();
    const pi = makeFakePi();
    start(pi, { complete });
    publishForSession();
    const ctx = ctxWithModel();
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    await lastAuthorizer()(askDetails(), {}, fakeLog());
    complete.mockImplementation(async () =>
      assistantToolCall({ verdict: "deny", reason: "no" }),
    );
    await lastAuthorizer()(askDetails(), {}, fakeLog());
    expect(lastStatus(ctx)).toBe("judge:session | call-failed x1");
  });

  it("shows no suffix for a deny with no failures", async () => {
    const pi = makeFakePi();
    start(pi, { complete: denyingComplete() });
    publishForSession();
    const ctx = ctxWithModel();
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    await lastAuthorizer()(askDetails(), {}, fakeLog());
    expect(lastStatus(ctx)).toBe("judge:session");
  });

  it("shows breaker open with the remaining seconds once the breaker trips", async () => {
    const pi = makeFakePi();
    start(pi, { complete: failingComplete() });
    publishForSession();
    const ctx = ctxWithModel();
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    for (let i = 0; i < 3; i += 1) {
      await lastAuthorizer()(askDetails(), {}, fakeLog());
    }
    expect(lastStatus(ctx)).toBe("judge:session | breaker open 60s");
  });

  it("starts a fresh session with no suffix after session_shutdown", async () => {
    const pi = makeFakePi();
    start(pi, { complete: failingComplete() });
    publishForSession();
    const ctx = ctxWithModel();
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    await lastAuthorizer()(askDetails(), {}, fakeLog());
    expect(lastStatus(ctx)).toBe("judge:session | call-failed x1");
    pi.lifecycle.get("session_shutdown")?.({}, ctx);
    const next = ctxWithModel();
    pi.lifecycle.get("session_start")?.({}, next);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(lastStatus(next)).toBe("judge:session");
  });
});

describe("breaker countdown", () => {
  const fakeLog = () => ({ review: vi.fn(), debug: vi.fn() });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Trip the breaker with three failed reviews; returns the ctx and complete. */
  async function openBreaker(pi: FakePi) {
    const complete = vi.fn<CompleteFn>(async () => {
      throw new Error("model unavailable");
    });
    start(pi, { complete });
    publishForSession();
    const ctx = ctxWithModel();
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    for (let i = 0; i < 3; i += 1) {
      await lastAuthorizer()(askDetails(), {}, fakeLog());
    }
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      STATUS_KEY,
      "judge:session | breaker open 60s",
    );
    ctx.ui.setStatus.mockClear();
    return { ctx, complete };
  }

  it("refreshes the remaining seconds once per second while open", async () => {
    const pi = makeFakePi();
    const { ctx } = await openBreaker(pi);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.ui.setStatus).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      STATUS_KEY,
      "judge:session | breaker open 59s",
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.ui.setStatus).toHaveBeenCalledTimes(2);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      STATUS_KEY,
      "judge:session | breaker open 58s",
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(ctx.ui.setStatus).toHaveBeenCalledTimes(2);
  });

  it("stops after the cooldown ends and leaves no timer", async () => {
    const pi = makeFakePi();
    const { ctx } = await openBreaker(pi);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      STATUS_KEY,
      "judge:session | call-failed x3",
    );
    expect(vi.getTimerCount()).toBe(0);
    ctx.ui.setStatus.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("closes cleanly when the post-cooldown review succeeds", async () => {
    const pi = makeFakePi();
    const { ctx, complete } = await openBreaker(pi);
    await vi.advanceTimersByTimeAsync(60_000);
    complete.mockImplementation(async () => assistantToolCall({ verdict: "allow" }));
    await lastAuthorizer()(askDetails(), {}, fakeLog());
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      STATUS_KEY,
      "judge:session | defers x3",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a single interval when more asks arrive while open", async () => {
    const pi = makeFakePi();
    const { ctx } = await openBreaker(pi);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    await lastAuthorizer()(askDetails(), {}, fakeLog());
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      STATUS_KEY,
      "judge:session | breaker open 59s",
    );
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      STATUS_KEY,
      "judge:session | breaker open 58s",
    );
    expect(vi.getTimerCount()).toBe(1);
  });

  it("stops at session_shutdown with no further status writes", async () => {
    const pi = makeFakePi();
    const { ctx } = await openBreaker(pi);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.ui.setStatus).toHaveBeenCalledTimes(1);
    pi.lifecycle.get("session_shutdown")?.({}, ctx);
    expect(vi.getTimerCount()).toBe(0);
    ctx.ui.setStatus.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });
});

describe("footer status (REQ-18, REQ-19, REQ-20, REQ-21)", () => {
  it("sets judge:session when the link registers with an empty config", () => {
    const pi = makeFakePi();
    start(pi);
    publishForSession();
    const ctx = ctxWithModel();
    pi.lifecycle.get("session_start")?.({}, ctx);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(ctx.ui.setStatus).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(STATUS_KEY, "judge:session");
  });

  it("sets judge:<provider>/<id> for a configured judge the registry knows", () => {
    const pi = makeFakePi();
    start(pi, { loadConfig: () => CONFIG_PM_RESULT });
    publishForSession();
    const ctx = ctxWithModel();
    ctx.modelRegistry.find.mockReturnValue(PM_MODEL);
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(STATUS_KEY, "judge:p/m");
  });

  it("appends (unresolved) when the configured judge is not in the registry", () => {
    const pi = makeFakePi();
    start(pi, { loadConfig: () => CONFIG_PM_RESULT });
    publishForSession();
    const ctx = ctxWithModel();
    ctx.modelRegistry.find.mockReturnValue(undefined);
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      STATUS_KEY,
      "judge:p/m (unresolved)",
    );
  });

  it("sets the status once across repeated ready emissions", () => {
    const pi = makeFakePi();
    start(pi);
    publishForSession();
    const ctx = ctxWithModel();
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(service.registerAuthorizer).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setStatus).toHaveBeenCalledTimes(1);
  });

  it("re-sets the status on model_select", () => {
    const pi = makeFakePi();
    start(pi);
    publishForSession();
    const ctx = ctxWithModel();
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    pi.lifecycle.get("model_select")?.(
      { type: "model_select", model: NEXT_MODEL, previousModel: SESSION_MODEL },
      ctx,
    );
    expect(ctx.ui.setStatus).toHaveBeenCalledTimes(2);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      STATUS_KEY,
      "judge:session",
    );
  });

  it("clears the status with undefined at session_shutdown", () => {
    const pi = makeFakePi();
    start(pi);
    publishForSession();
    const ctx = ctxWithModel();
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    pi.lifecycle.get("session_shutdown")?.({}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(STATUS_KEY, undefined);
  });

  it("never sets a status when the config is missing or invalid", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const pi = makeFakePi();
    start(pi, {
      loadConfig: () => ({
        config: undefined,
        issues: [],
        projectSetsJudge: false,
      }),
    });
    publishForSession();
    const ctx = ctxWithModel();
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    pi.lifecycle.get("model_select")?.(
      { type: "model_select", model: NEXT_MODEL, previousModel: SESSION_MODEL },
      ctx,
    );
    pi.lifecycle.get("session_shutdown")?.({}, ctx);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("never sets a status when ready carries no session id", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const pi = makeFakePi();
    start(pi);
    publishForSession();
    const ctx = ctxWithModel();
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT_NO_ID);
    pi.lifecycle.get("session_shutdown")?.({}, ctx);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("never sets a status on a keyed locator miss", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const pi = makeFakePi();
    start(pi);
    // Nothing published for SESSION_ID.
    const ctx = ctxWithModel();
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    pi.lifecycle.get("session_shutdown")?.({}, ctx);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });
});

describe("launch flag --permission-model (REQ-15, REQ-16, REQ-22)", () => {
  it("registers a string CLI flag named permission-model", () => {
    const pi = makeFakePi();
    start(pi);
    expect(pi.api.registerFlag).toHaveBeenCalledTimes(1);
    expect(pi.api.registerFlag).toHaveBeenCalledWith(
      "permission-model",
      expect.objectContaining({ type: "string" }),
    );
  });

  it("a resolvable flag overrides config and session for the next ask and the status", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const complete = allowingComplete();
    const loadConfig = vi.fn(() => CONFIG_QN_RESULT);
    const writeJudge = vi.fn();
    const pi = makeFakePi();
    pi.api.getFlag.mockReturnValue("p/m");
    start(pi, { complete, loadConfig, writeJudge });
    publishForSession();
    const ctx = ctxWithModel();
    ctx.modelRegistry.find.mockImplementation(findKnown);
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(pi.api.getFlag).toHaveBeenCalledWith("permission-model");
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(STATUS_KEY, "judge:p/m");
    await lastAuthorizer()(askDetails(), {}, { review: vi.fn(), debug: vi.fn() });
    expect(complete.mock.calls[0]?.[0]).toBe(PM_MODEL);
    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(writeJudge).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("drops the override at session_shutdown so the config judge applies next session", async () => {
    const complete = allowingComplete();
    const pi = makeFakePi();
    pi.api.getFlag.mockReturnValue("p/m");
    start(pi, { complete, loadConfig: () => CONFIG_QN_RESULT });
    publishForSession();
    const ctx = ctxWithModel();
    ctx.modelRegistry.find.mockImplementation(findKnown);
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    pi.lifecycle.get("session_shutdown")?.({}, ctx);
    pi.api.getFlag.mockReturnValue(undefined);
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(STATUS_KEY, "judge:q/n");
    await lastAuthorizer()(askDetails(), {}, { review: vi.fn(), debug: vi.fn() });
    expect(complete.mock.calls[0]?.[0]).toBe(QN_MODEL);
  });

  it("an unknown flag value warns once and the config judge applies", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const complete = allowingComplete();
    const writeJudge = vi.fn();
    const pi = makeFakePi();
    pi.api.getFlag.mockReturnValue("nope/x");
    start(pi, { complete, loadConfig: () => CONFIG_QN_RESULT, writeJudge });
    publishForSession();
    const ctx = ctxWithModel();
    ctx.modelRegistry.find.mockImplementation(findKnown);
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("nope/x");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("nope/x"),
      "warning",
    );
    expect(writeJudge).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(STATUS_KEY, "judge:q/n");
    await lastAuthorizer()(askDetails(), {}, { review: vi.fn(), debug: vi.fn() });
    expect(complete.mock.calls[0]?.[0]).toBe(QN_MODEL);
  });

  it("an unknown flag value with an empty config leaves the session model judging", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const complete = allowingComplete();
    const pi = makeFakePi();
    pi.api.getFlag.mockReturnValue("not-a-pair");
    start(pi, { complete });
    publishForSession();
    const ctx = ctxWithModel();
    ctx.modelRegistry.find.mockImplementation(findKnown);
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(STATUS_KEY, "judge:session");
    await lastAuthorizer()(askDetails(), {}, { review: vi.fn(), debug: vi.fn() });
    expect(complete.mock.calls[0]?.[0]).toBe(SESSION_MODEL);
  });
});

describe("/permission-model command wiring (REQ-01, REQ-17, REQ-20)", () => {
  it("registers the command once with a description, completion hook, and handler", () => {
    const pi = makeFakePi();
    start(pi);
    expect(pi.api.registerCommand).toHaveBeenCalledTimes(1);
    expect(pi.api.registerCommand).toHaveBeenCalledWith(
      "permission-model",
      expect.objectContaining({
        description: expect.any(String),
        getArgumentCompletions: expect.any(Function),
        handler: expect.any(Function),
      }),
    );
  });

  it("a typed choice writes global, replaces the flag override, refreshes the status, and judges the next ask", async () => {
    const complete = allowingComplete();
    const writeJudge = vi.fn();
    const loadConfig = vi
      .fn<() => LoadConfigResult>()
      .mockReturnValueOnce(CONFIG_RESULT)
      .mockReturnValue(CONFIG_QN_RESULT);
    const pi = makeFakePi();
    pi.api.getFlag.mockReturnValue("p/m");
    start(pi, { complete, loadConfig, writeJudge });
    publishForSession();
    const ctx = ctxWithModel();
    ctx.modelRegistry.find.mockImplementation(findKnown);
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(STATUS_KEY, "judge:p/m");

    await pi.commands.get("permission-model")?.handler("q/n", ctx);

    expect(writeJudge).toHaveBeenCalledTimes(1);
    expect(writeJudge).toHaveBeenCalledWith("q", "n");
    expect(loadConfig).toHaveBeenCalledTimes(2);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(STATUS_KEY, "judge:q/n");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
    await lastAuthorizer()(askDetails(), {}, { review: vi.fn(), debug: vi.fn() });
    expect(complete.mock.calls[0]?.[0]).toBe(QN_MODEL);
  });

  it("a rejected typed pick writes nothing and the next ask keeps the configured judge", async () => {
    const complete = allowingComplete();
    const writeJudge = vi.fn();
    const loadConfig = vi.fn<() => LoadConfigResult>(() => CONFIG_QN_RESULT);
    const pi = makeFakePi();
    start(pi, { complete, loadConfig, writeJudge });
    publishForSession();
    const ctx = ctxWithModel();
    ctx.modelRegistry.find.mockImplementation(findKnown);
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(STATUS_KEY, "judge:q/n");

    await pi.commands.get("permission-model")?.handler("nope/x", ctx);

    expect(writeJudge).not.toHaveBeenCalled();
    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("nope/x"),
      "error",
    );
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(STATUS_KEY, "judge:q/n");
    await lastAuthorizer()(askDetails(), {}, { review: vi.fn(), debug: vi.fn() });
    expect(complete.mock.calls[0]?.[0]).toBe(QN_MODEL);
  });
});

describe("picker selection through the extension (REQ-09, REQ-11)", () => {
  it("writes global, refreshes the status, judges the next ask, and never calls pi.setModel", async () => {
    const complete = allowingComplete();
    const writeJudge = vi.fn();
    const loadConfig = vi
      .fn<() => LoadConfigResult>()
      .mockReturnValueOnce(CONFIG_RESULT)
      .mockReturnValue(CONFIG_QN_RESULT);
    let onSelect: ((model: Model<any>) => void) | undefined;
    const buildPicker = vi.fn((request: { onSelect: (model: Model<any>) => void }) => {
      onSelect = request.onSelect;
      return { render: () => [], handleInput: () => {} };
    });
    const pi = makeFakePi();
    start(pi, { complete, loadConfig, writeJudge, buildPicker: buildPicker as never });
    publishForSession();
    const ctx = ctxWithModel();
    ctx.modelRegistry.find.mockImplementation(findKnown);
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);

    const pending = pi.commands.get("permission-model")?.handler("", ctx);
    expect(buildPicker).toHaveBeenCalledTimes(1);
    onSelect?.(QN_MODEL);
    await pending;

    expect(writeJudge).toHaveBeenCalledWith("q", "n");
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(STATUS_KEY, "judge:q/n");
    expect(pi.api.setModel).not.toHaveBeenCalled();
    await lastAuthorizer()(askDetails(), {}, { review: vi.fn(), debug: vi.fn() });
    expect(complete.mock.calls[0]?.[0]).toBe(QN_MODEL);
  });
});

describe("default export", () => {
  it("wires the extension lifecycle handlers", () => {
    const pi = makeFakePi();
    piPermissionClassifier(pi.api as never);
    expect(pi.api.registerFlag).toHaveBeenCalledWith(
      "permission-model",
      expect.objectContaining({ type: "string" }),
    );
    expect(pi.commands.has("permission-model")).toBe(true);
    expect(pi.lifecycle.has("session_start")).toBe(true);
    expect(pi.lifecycle.has("model_select")).toBe(true);
    expect(pi.lifecycle.has("session_shutdown")).toBe(true);
    expect(pi.events.has(READY_CHANNEL)).toBe(true);
  });
});

describe("guidance wiring", () => {
  const GLOBAL_CONTENT = "operator: curl -O downloads are routine";
  const PROJECT_CONTENT = "project: rm -rf build/ is routine cleanup";

  function promptOf(complete: ReturnType<typeof allowingComplete>, call: number) {
    const context = complete.mock.calls[call]?.[1] as {
      messages: { content: string }[];
    };
    return context.messages[0]?.content ?? "";
  }

  /** Session started and link registered; returns the ctx, authorizer, and agent dir. */
  function registered(
    complete: ReturnType<typeof allowingComplete>,
    loadGuidance: ClassifierDependencies["loadGuidance"],
  ) {
    const pi = makeFakePi();
    const agentDir = start(pi, { complete, loadGuidance });
    publishForSession();
    const ctx = ctxWithModel();
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    return { ctx, authorize: lastAuthorizer(), agentDir };
  }

  function log() {
    return { review: vi.fn(), debug: vi.fn() };
  }

  it("calls the loader on every judged ask with the session cwd and the agent dir", async () => {
    const complete = allowingComplete();
    const loadGuidance = vi.fn(() => []);
    const { authorize, agentDir } = registered(complete, loadGuidance);
    await authorize(askDetails(), {}, log());
    await authorize(askDetails(), {}, log());
    expect(loadGuidance).toHaveBeenCalledTimes(2);
    expect(loadGuidance).toHaveBeenCalledWith({ cwd: "/project", agentDir });
  });

  it("includes the global file whether or not the project is trusted", async () => {
    const complete = allowingComplete();
    const { ctx, authorize, agentDir } = registered(complete, ({ agentDir }) => [
      { path: join(agentDir, "AGENTS.md"), content: GLOBAL_CONTENT },
      { path: "/project/AGENTS.md", content: PROJECT_CONTENT },
    ]);
    ctx.isProjectTrusted.mockReturnValue(false);
    await authorize(askDetails(), {}, log());
    const prompt = promptOf(complete, 0);
    expect(prompt).toContain(
      `Operator guidance from ${join(agentDir, "AGENTS.md")}:`,
    );
    expect(prompt).toContain(GLOBAL_CONTENT);
    expect(prompt).not.toContain(PROJECT_CONTENT);
  });

  it.each([
    ["untrusted then trusted", [false, true]],
    ["trusted then untrusted", [true, false]],
  ])(
    "reads trust per ask: %s flips project inclusion",
    async (_label, sequence) => {
      const complete = allowingComplete();
      const { ctx, authorize } = registered(complete, () => [
        { path: "/project/AGENTS.md", content: PROJECT_CONTENT },
      ]);
      ctx.isProjectTrusted.mockClear();
      for (const trusted of sequence) {
        ctx.isProjectTrusted.mockReturnValue(trusted);
        await authorize(askDetails(), {}, log());
      }
      expect(ctx.isProjectTrusted).toHaveBeenCalledTimes(2);
      sequence.forEach((trusted, index) => {
        const prompt = promptOf(complete, index);
        if (trusted) {
          expect(prompt).toContain("Project guidance from /project/AGENTS.md:");
          expect(prompt).toContain(PROJECT_CONTENT);
        } else {
          expect(prompt).not.toContain(PROJECT_CONTENT);
        }
      });
    },
  );

  it("renders content changed between asks in the second prompt", async () => {
    const complete = allowingComplete();
    let content = "first edition";
    const { authorize } = registered(complete, () => [
      { path: "/project/AGENTS.md", content },
    ]);
    await authorize(askDetails(), {}, log());
    content = "second edition";
    await authorize(askDetails(), {}, log());
    expect(promptOf(complete, 0)).toContain("first edition");
    expect(promptOf(complete, 0)).not.toContain("second edition");
    expect(promptOf(complete, 1)).toContain("second edition");
    expect(promptOf(complete, 1)).not.toContain("first edition");
  });

  it("never renders an over-cap file's text, even a trusted one", async () => {
    const complete = allowingComplete();
    const oversized = `OVERSIZED-MARKER ${"z".repeat(16 * 1024)}`;
    const { authorize } = registered(complete, () => [
      { path: "/project/AGENTS.md", content: oversized },
      { path: "/project/sub/AGENTS.md", content: PROJECT_CONTENT },
    ]);
    const entryLog = log();
    await authorize(askDetails(), {}, entryLog);
    const prompt = promptOf(complete, 0);
    expect(prompt).not.toContain("OVERSIZED-MARKER");
    expect(prompt).toContain(PROJECT_CONTENT);
    expect(entryLog.review.mock.calls[0]?.[1]).toMatchObject({
      guidanceDropped: [
        {
          path: "/project/AGENTS.md",
          bytes: Buffer.byteLength(oversized),
          reason: "over-file-cap",
        },
      ],
    });
  });

  it("logs the dropped project file as untrusted on the decision entry", async () => {
    const complete = allowingComplete();
    const { ctx, authorize } = registered(complete, () => [
      { path: "/project/AGENTS.md", content: PROJECT_CONTENT },
    ]);
    ctx.isProjectTrusted.mockReturnValue(false);
    const entryLog = log();
    await authorize(askDetails(), {}, entryLog);
    expect(entryLog.review.mock.calls[0]?.[1]).toMatchObject({
      guidanceIncluded: [],
      guidanceDropped: [
        {
          path: "/project/AGENTS.md",
          bytes: Buffer.byteLength(PROJECT_CONTENT),
          reason: "untrusted",
        },
      ],
    });
  });

  it("defers with guidance-load-failed when the loader throws", async () => {
    const complete = allowingComplete();
    const { authorize } = registered(complete, () => {
      throw new Error("unreadable");
    });
    const entryLog = log();
    const verdict = await authorize(askDetails(), {}, entryLog);
    expect(verdict).toEqual({ kind: "defer" });
    expect(complete).not.toHaveBeenCalled();
    expect(entryLog.review.mock.calls[0]?.[1]).toMatchObject({
      deferReason: "guidance-load-failed",
    });
  });
});

describe("config trust gate wiring", () => {
  it("loads with the session trust state and reloads with the state at reload time", async () => {
    const loadConfig = vi
      .fn<NonNullable<ClassifierDependencies["loadConfig"]>>()
      .mockReturnValue(CONFIG_RESULT);
    const pi = makeFakePi();
    start(pi, { loadConfig, writeJudge: vi.fn() });
    publishForSession();
    const ctx = ctxWithModel();
    ctx.isProjectTrusted.mockReturnValue(false);
    ctx.modelRegistry.find.mockImplementation(findKnown);
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(loadConfig).toHaveBeenLastCalledWith("/project", false);

    ctx.isProjectTrusted.mockReturnValue(true);
    await pi.commands.get("permission-model")?.handler("q/n", ctx);

    expect(loadConfig).toHaveBeenCalledTimes(2);
    expect(loadConfig).toHaveBeenLastCalledWith("/project", true);
  });

  it("treats a session context without a trust query as untrusted", () => {
    const loadConfig = vi
      .fn<NonNullable<ClassifierDependencies["loadConfig"]>>()
      .mockReturnValue(CONFIG_RESULT);
    const pi = makeFakePi();
    start(pi, { loadConfig });
    const { isProjectTrusted: _absent, ...legacyCtx } = ctxWithModel();
    pi.lifecycle.get("session_start")?.({}, legacyCtx);
    expect(loadConfig).toHaveBeenLastCalledWith("/project", false);
  });
});
