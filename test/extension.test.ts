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
import { classifierConfigSchema } from "#src/config-schema";
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
    mode: "llm",
    verdicts: "allow-deny-defer",
    onError: "defer",
  },
  issues: [],
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
    isToolFullyDenied: vi.fn(() => false),
    registerToolInputFormatter: vi.fn(() => () => {}),
    getToolInputFormatter: vi.fn(),
    registerToolAccessExtractor: vi.fn(() => () => {}),
    getToolAccessExtractor: vi.fn(),
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
      findOfType: vi.fn(),
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
};
const PM_MODEL = { provider: "p", id: "m" } as Model<any>;

const CONFIG_QN_RESULT: LoadConfigResult = {
  config: { ...CONFIG_RESULT.config!, provider: "q", model: "n" },
  issues: [],
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

/** The latest callback registered as permission-judge. */
function lastAuthorizer(): RegisteredAuthorizer {
  return service.registerAuthorizer.mock.calls
    .filter((call) => call[0] === "permission-judge")
    .at(-1)?.[1] as RegisteredAuthorizer;
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

/** Overwrite the global config file in a scratch agent dir. */
function saveGlobal(agentDir: string, config: Record<string, unknown>): void {
  writeFileSync(getGlobalConfigPath(agentDir), JSON.stringify(config));
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
    writeSelection?: ClassifierDependencies["writeSelection"];
    buildPicker?: ClassifierDependencies["buildPicker"];
    loadGuidance?: ClassifierDependencies["loadGuidance"];
  } = {},
) {
  const agentDir = makeAgentDir();
  createClassifierExtension(pi.api as never, {
    agentDir: () => agentDir,
    loadConfig: overrides.loadConfig ?? (() => CONFIG_RESULT),
    complete: overrides.complete ?? vi.fn(),
    writeSelection: overrides.writeSelection ?? vi.fn(),
    ...(overrides.buildPicker ? { buildPicker: overrides.buildPicker } : {}),
    loadGuidance: overrides.loadGuidance ?? (() => []),
  });
  return agentDir;
}

describe("createClassifierExtension", () => {
  it("registers the permission-judge link from the ready handler via the keyed locator", () => {
    const pi = makeFakePi();
    start(pi);
    pi.lifecycle.get("session_start")?.({}, ctxWithModel());
    expect(service.registerAuthorizer).not.toHaveBeenCalled();
    publishForSession();
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(service.registerAuthorizer).toHaveBeenCalledTimes(2);
    expect(service.registerAuthorizer.mock.calls[0]?.[0]).toBe("permission-judge");
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
    expect(service.registerAuthorizer).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("registers nothing and warns when the config is invalid", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pi = makeFakePi();
    start(pi, {
      loadConfig: () => ({
        config: undefined,
        issues: [{ path: "provider", message: "must come with model" }],
      }),
    });
    publishForSession();
    pi.lifecycle.get("session_start")?.({}, ctxWithModel());
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(service.registerAuthorizer).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("ignores classifierEnabled false: permission-judge still registers", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pi = makeFakePi();
    start(pi, {
      loadConfig: () => ({
        ...CONFIG_RESULT,
        config: classifierConfigSchema.parse({ classifierEnabled: false }),
      }),
    });
    publishForSession();
    pi.lifecycle.get("session_start")?.({}, ctxWithModel());
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(service.registerAuthorizer).toHaveBeenCalledTimes(2);
    expect(service.registerAuthorizer.mock.calls[0]?.[0]).toBe("permission-judge");
    expect(warn).not.toHaveBeenCalled();
  });

  it("registers the permission-judge link for a config with only the pre-existing fields", async () => {
    const pi = makeFakePi();
    const complete = vi.fn<CompleteFn>(async () => assistantToolCall({ verdict: "defer" }));
    start(pi, {
      loadConfig: () => ({
        config: classifierConfigSchema.parse({ instructions: "be strict", timeoutMs: 250 }),
        issues: [],
      }),
      complete,
    });
    publishForSession();
    pi.lifecycle.get("session_start")?.({}, ctxWithModel());
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(service.registerAuthorizer).toHaveBeenCalledTimes(2);
    expect(service.registerAuthorizer.mock.calls[0]?.[0]).toBe("permission-judge");
    // The defaults apply: a model defer stays defer under allow-deny-defer.
    const log = { review: vi.fn(), debug: vi.fn() };
    expect(await lastAuthorizer()(askDetails(), {}, log)).toEqual({
      kind: "defer",
    });
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
      }),
    });
    publishForSession();
    pi.lifecycle.get("session_start")?.({}, ctxWithModel());
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(service.registerAuthorizer).toHaveBeenCalledTimes(2);
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
    expect(service.registerAuthorizer).toHaveBeenCalledTimes(2);
    pi.lifecycle.get("session_shutdown")?.({}, ctxWithModel());
    expect(service.disposer).toHaveBeenCalledTimes(2);
    // A late ready from the torn-down session must not re-register.
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(service.registerAuthorizer).toHaveBeenCalledTimes(2);
    // A subsequent session registers on its own keyed service.
    const nextService = makeService();
    publishPermissionsService("session-2", nextService);
    try {
      pi.lifecycle.get("session_start")?.({}, ctxWithModel());
      pi.events.get(READY_CHANNEL)?.({
        sessionId: "session-2",
        adjudicatesLocally: true,
      });
      expect(nextService.registerAuthorizer).toHaveBeenCalledTimes(2);
      expect(service.registerAuthorizer).toHaveBeenCalledTimes(2);
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
    expect(lastStatus(ctx)).toBe("perm-judge: llm:chat-model");
    await lastAuthorizer()(askDetails(), {}, fakeLog());
    expect(lastStatus(ctx)).toBe("perm-judge: llm:chat-model | call-failed x1");
    await lastAuthorizer()(askDetails(), {}, fakeLog());
    expect(lastStatus(ctx)).toBe("perm-judge: llm:chat-model | call-failed x2");
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
    expect(lastStatus(ctx)).toBe("perm-judge: llm:chat-model | timeout x1");
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
    expect(lastStatus(ctx)).toBe("perm-judge: llm:chat-model | defers x1");
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
    expect(lastStatus(ctx)).toBe("perm-judge: llm:chat-model | call-failed x1");
  });

  it("shows no suffix for a deny with no failures", async () => {
    const pi = makeFakePi();
    start(pi, { complete: denyingComplete() });
    publishForSession();
    const ctx = ctxWithModel();
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    await lastAuthorizer()(askDetails(), {}, fakeLog());
    expect(lastStatus(ctx)).toBe("perm-judge: llm:chat-model");
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
    expect(lastStatus(ctx)).toBe("perm-judge: llm:chat-model | breaker open 60s");
  });

  it("starts a fresh session with no suffix after session_shutdown", async () => {
    const pi = makeFakePi();
    start(pi, { complete: failingComplete() });
    publishForSession();
    const ctx = ctxWithModel();
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    await lastAuthorizer()(askDetails(), {}, fakeLog());
    expect(lastStatus(ctx)).toBe("perm-judge: llm:chat-model | call-failed x1");
    pi.lifecycle.get("session_shutdown")?.({}, ctx);
    const next = ctxWithModel();
    pi.lifecycle.get("session_start")?.({}, next);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(lastStatus(next)).toBe("perm-judge: llm:chat-model");
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
      "perm-judge: llm:chat-model | breaker open 60s",
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
      "perm-judge: llm:chat-model | breaker open 59s",
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.ui.setStatus).toHaveBeenCalledTimes(2);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      STATUS_KEY,
      "perm-judge: llm:chat-model | breaker open 58s",
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
      "perm-judge: llm:chat-model | call-failed x3",
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
      "perm-judge: llm:chat-model | defers x3",
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
      "perm-judge: llm:chat-model | breaker open 59s",
    );
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      STATUS_KEY,
      "perm-judge: llm:chat-model | breaker open 58s",
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

describe("footer status", () => {
  it("sets llm:chat-model when the link registers with an empty config", () => {
    const pi = makeFakePi();
    start(pi);
    publishForSession();
    const ctx = ctxWithModel();
    pi.lifecycle.get("session_start")?.({}, ctx);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(ctx.ui.setStatus).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(STATUS_KEY, "perm-judge: llm:chat-model");
  });

  it("sets llm:<provider>/<id> for a configured judge the registry knows", () => {
    const pi = makeFakePi();
    start(pi, { loadConfig: () => CONFIG_PM_RESULT });
    publishForSession();
    const ctx = ctxWithModel();
    ctx.modelRegistry.find.mockReturnValue(PM_MODEL);
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(STATUS_KEY, "perm-judge: llm:p/m");
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
      "perm-judge: llm:p/m (unresolved)",
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
    expect(service.registerAuthorizer).toHaveBeenCalledTimes(2);
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
      "perm-judge: llm:chat-model",
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

describe("launch flag --permission-model", () => {
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
    const writeSelection = vi.fn();
    const pi = makeFakePi();
    pi.api.getFlag.mockReturnValue("llm:p/m");
    start(pi, { complete, loadConfig, writeSelection });
    publishForSession();
    const ctx = ctxWithModel();
    ctx.modelRegistry.find.mockImplementation(findKnown);
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(pi.api.getFlag).toHaveBeenCalledWith("permission-model");
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(STATUS_KEY, "perm-judge: llm:p/m");
    await lastAuthorizer()(askDetails(), {}, { review: vi.fn(), debug: vi.fn() });
    expect(complete.mock.calls[0]?.[0]).toBe(PM_MODEL);
    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(writeSelection).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("drops the override at session_shutdown so the config judge applies next session", async () => {
    const complete = allowingComplete();
    const pi = makeFakePi();
    pi.api.getFlag.mockReturnValue("llm:p/m");
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
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(STATUS_KEY, "perm-judge: llm:q/n");
    await lastAuthorizer()(askDetails(), {}, { review: vi.fn(), debug: vi.fn() });
    expect(complete.mock.calls[0]?.[0]).toBe(QN_MODEL);
  });

  it("an unknown flag value warns once and the config judge applies", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const complete = allowingComplete();
    const writeSelection = vi.fn();
    const pi = makeFakePi();
    pi.api.getFlag.mockReturnValue("llm:nope/x");
    start(pi, { complete, loadConfig: () => CONFIG_QN_RESULT, writeSelection });
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
    expect(writeSelection).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(STATUS_KEY, "perm-judge: llm:q/n");
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
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(STATUS_KEY, "perm-judge: llm:chat-model");
    await lastAuthorizer()(askDetails(), {}, { review: vi.fn(), debug: vi.fn() });
    expect(complete.mock.calls[0]?.[0]).toBe(SESSION_MODEL);
  });

  const JEV = { provider: "typesafe", id: "jev-latest", type: "classifier" } as never;
  const QUICK_ALLOW = {
    api: "typesafe-system-one",
    provider: "typesafe",
    model: "jev-latest",
    answers: {
      reversible: { type: "bool", probability: 0.99 },
      contained: { type: "bool", probability: 0.99 },
      hazard: {
        type: "choice",
        choice: "none",
        probabilities: { none: 0.99 },
        confidence: 0.99,
      },
    } as Record<string, unknown>,
    stopReason: "stop",
    timestamp: 0,
  };

  function ctxWithJev(classify = vi.fn(async () => QUICK_ALLOW)) {
    const base = ctxWithModel();
    base.modelRegistry.find.mockImplementation(findKnown);
    return {
      ...base,
      modelRegistry: {
        ...base.modelRegistry,
        findOfType: vi.fn((type: string, provider: string, id: string) =>
          type === "classifier" && provider === "typesafe" && id === "jev-latest"
            ? JEV
            : undefined,
        ),
        classify,
      },
    };
  }

  it("a full list sets mode and both judges for the next ask and writes nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const complete = allowingComplete();
    const writeSelection = vi.fn();
    const classify = vi.fn(async () => ({ ...QUICK_ALLOW, answers: {} }));
    const pi = makeFakePi();
    pi.api.getFlag.mockReturnValue("quick:typesafe/jev-latest,llm:p/m,mode:quick-then-llm");
    start(pi, { complete, loadConfig: () => CONFIG_QN_RESULT, writeSelection });
    publishForSession();
    const ctx = ctxWithJev(classify);
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    await lastAuthorizer()(askDetails(), {}, { review: vi.fn(), debug: vi.fn() });
    expect(classify).toHaveBeenCalledTimes(1);
    expect((classify.mock.calls[0] as unknown[])[0]).toBe(JEV);
    expect(complete.mock.calls[0]?.[0]).toBe(PM_MODEL);
    expect(writeSelection).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("one bad item warns and the rest of the list applies", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const classify = vi.fn(async () => QUICK_ALLOW);
    const pi = makeFakePi();
    pi.api.getFlag.mockReturnValue("quick:typesafe/nope,llm:p/m,mode:quick");
    const complete = allowingComplete();
    start(pi, { complete, loadConfig: () => CONFIG_QN_RESULT });
    publishForSession();
    const ctx = ctxWithJev(classify);
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("typesafe/nope");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("typesafe/nope"), "warning");
    // mode quick applies with no quick model: the quick judge defers unresolved.
    expect(await lastAuthorizer()(askDetails(), {}, { review: vi.fn(), debug: vi.fn() })).toEqual({
      kind: "defer",
    });
    expect(classify).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("an unprefixed pair warns with the llm: form and changes nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const complete = allowingComplete();
    const pi = makeFakePi();
    pi.api.getFlag.mockReturnValue("p/m");
    start(pi, { complete, loadConfig: () => CONFIG_QN_RESULT });
    publishForSession();
    const ctx = ctxWithJev();
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("llm:p/m");
    await lastAuthorizer()(askDetails(), {}, { review: vi.fn(), debug: vi.fn() });
    expect(complete.mock.calls[0]?.[0]).toBe(QN_MODEL);
  });

  it("typed mode quick is refused when only a project config sets the quick model", async () => {
    const writeSelection = vi.fn();
    const projectQuick = classifierConfigSchema.parse({
      quickJudge: { provider: "typesafe", model: "jev-latest" },
    });
    const pi = makeFakePi();
    const agentDir = start(pi, {
      complete: allowingComplete(),
      loadConfig: () => ({ config: projectQuick, issues: [] }),
      writeSelection,
    });
    saveGlobal(agentDir, {});
    publishForSession();
    const ctx = ctxWithJev();
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    await pi.commands.get("permission-model")?.handler("mode quick", ctx);
    expect(writeSelection).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("does not count"),
      "warning",
    );
  });

  it.each(["quick", "quick-then-llm"])(
    "typed mode %s is refused when only the flag sets the quick model",
    async (mode) => {
      const writeSelection = vi.fn();
      const pi = makeFakePi();
      pi.api.getFlag.mockReturnValue("quick:typesafe/jev-latest");
      start(pi, { complete: allowingComplete(), loadConfig: () => CONFIG_QN_RESULT, writeSelection });
      publishForSession();
      const ctx = ctxWithJev();
      pi.lifecycle.get("session_start")?.({}, ctx);
      pi.events.get(READY_CHANNEL)?.(READY_EVENT);
      await pi.commands.get("permission-model")?.handler(`mode ${mode}`, ctx);
      expect(writeSelection).not.toHaveBeenCalled();
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("/permission-model quick <provider>/<id>"),
        "warning",
      );
    },
  );

  it("a command write of the quick model drops only the flag's quick value", async () => {
    const complete = allowingComplete();
    const classify = vi.fn(async () => ({ ...QUICK_ALLOW, answers: {} }));
    const KEV = { provider: "local", id: "kev", type: "classifier" } as never;
    const reloaded = classifierConfigSchema.parse({
      provider: "q",
      model: "n",
      // Saved values that differ from the flag's, so a dropped flag value shows.
      mode: "quick",
      quickJudge: { provider: "local", model: "kev" },
    });
    const loadConfig = vi
      .fn<() => LoadConfigResult>()
      .mockReturnValueOnce(CONFIG_QN_RESULT)
      .mockReturnValue({ config: reloaded, issues: [] });
    const pi = makeFakePi();
    pi.api.getFlag.mockReturnValue("quick:typesafe/jev-latest,llm:p/m,mode:quick-then-llm");
    start(pi, { complete, loadConfig, writeSelection: vi.fn() });
    publishForSession();
    const ctx = ctxWithJev(classify);
    ctx.modelRegistry.findOfType.mockImplementation((type: string, provider: string, id: string) =>
      type !== "classifier"
        ? undefined
        : provider === "typesafe" && id === "jev-latest"
          ? JEV
          : provider === "local" && id === "kev"
            ? KEV
            : undefined,
    );
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);

    await pi.commands.get("permission-model")?.handler("quick local/kev", ctx);

    await lastAuthorizer()(askDetails(), {}, { review: vi.fn(), debug: vi.fn() });
    expect((classify.mock.calls[0] as unknown[])[0]).toBe(KEV);
    // The flag's LLM judge and mode still apply.
    expect(complete.mock.calls[0]?.[0]).toBe(PM_MODEL);
  });
});

describe("/permission-model command wiring", () => {
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
    const writeSelection = vi.fn();
    const loadConfig = vi
      .fn<() => LoadConfigResult>()
      .mockReturnValueOnce(CONFIG_RESULT)
      .mockReturnValue(CONFIG_QN_RESULT);
    const pi = makeFakePi();
    pi.api.getFlag.mockReturnValue("llm:p/m");
    start(pi, { complete, loadConfig, writeSelection });
    publishForSession();
    const ctx = ctxWithModel();
    ctx.modelRegistry.find.mockImplementation(findKnown);
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(STATUS_KEY, "perm-judge: llm:p/m");

    await pi.commands.get("permission-model")?.handler("llm q/n", ctx);

    expect(writeSelection).toHaveBeenCalledTimes(1);
    expect(writeSelection).toHaveBeenCalledWith({ llm: { provider: "q", model: "n" } });
    expect(loadConfig).toHaveBeenCalledTimes(2);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(STATUS_KEY, "perm-judge: llm:q/n");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
    await lastAuthorizer()(askDetails(), {}, { review: vi.fn(), debug: vi.fn() });
    expect(complete.mock.calls[0]?.[0]).toBe(QN_MODEL);
  });

  it("a typed mode change applies on the next ask with no re-registration", async () => {
    const JEV = { provider: "typesafe", id: "jev", type: "classifier" } as never;
    const quick = classifierConfigSchema.parse({
      quickJudge: { provider: "typesafe", model: "jev" },
    });
    const writeSelection = vi.fn();
    const loadConfig = vi
      .fn<() => LoadConfigResult>()
      .mockReturnValueOnce({ config: quick, issues: [] })
      .mockReturnValue({
        config: { ...quick, mode: "quick-then-llm" },
        issues: [],
      });
    const classify = vi.fn(async () => ({
      api: "typesafe-system-one",
      provider: "typesafe",
      model: "jev",
      answers: {},
      stopReason: "error",
      timestamp: 0,
    }));
    const complete = allowingComplete();
    const pi = makeFakePi();
    const agentDir = start(pi, { complete, loadConfig, writeSelection });
    saveGlobal(agentDir, { quickJudge: { provider: "typesafe", model: "jev" } });
    publishForSession();
    const base = ctxWithModel();
    const ctx = {
      ...base,
      modelRegistry: {
        ...base.modelRegistry,
        findOfType: vi.fn((type: string, provider: string, id: string) =>
          type === "classifier" && provider === "typesafe" && id === "jev" ? JEV : undefined,
        ),
        classify,
      },
    };
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    const authorize = lastAuthorizer();
    await authorize(askDetails(), {}, { review: vi.fn(), debug: vi.fn() });
    expect(classify).not.toHaveBeenCalled();

    await pi.commands.get("permission-model")?.handler("mode quick-then-llm", ctx);

    expect(writeSelection).toHaveBeenCalledWith({ mode: "quick-then-llm" });
    await authorize(askDetails(), {}, { review: vi.fn(), debug: vi.fn() });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(service.registerAuthorizer).toHaveBeenCalledTimes(2);
  });

  it("a rejected typed pick writes nothing and the next ask keeps the configured judge", async () => {
    const complete = allowingComplete();
    const writeSelection = vi.fn();
    const loadConfig = vi.fn<() => LoadConfigResult>(() => CONFIG_QN_RESULT);
    const pi = makeFakePi();
    start(pi, { complete, loadConfig, writeSelection });
    publishForSession();
    const ctx = ctxWithModel();
    ctx.modelRegistry.find.mockImplementation(findKnown);
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(STATUS_KEY, "perm-judge: llm:q/n");

    await pi.commands.get("permission-model")?.handler("llm nope/x", ctx);

    expect(writeSelection).not.toHaveBeenCalled();
    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("nope/x"),
      "error",
    );
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(STATUS_KEY, "perm-judge: llm:q/n");
    await lastAuthorizer()(askDetails(), {}, { review: vi.fn(), debug: vi.fn() });
    expect(complete.mock.calls[0]?.[0]).toBe(QN_MODEL);
  });
});

describe("picker selection through the extension", () => {
  it("writes global once, refreshes the status, judges the next ask, and never calls pi.setModel", async () => {
    const complete = allowingComplete();
    const writeSelection = vi.fn();
    const loadConfig = vi
      .fn<() => LoadConfigResult>()
      .mockReturnValueOnce(CONFIG_RESULT)
      .mockReturnValue(CONFIG_QN_RESULT);
    const steps: { onSelect: (value: string) => void }[] = [];
    const buildPicker = vi.fn((request: { onSelect: (value: string) => void }) => {
      steps.push(request);
      return { render: () => [], handleInput: () => {} };
    });
    const pi = makeFakePi();
    start(pi, { complete, loadConfig, writeSelection, buildPicker: buildPicker as never });
    publishForSession();
    const ctx = ctxWithModel();
    ctx.modelRegistry.find.mockImplementation(findKnown);
    ctx.modelRegistry.getAvailable.mockReturnValue([QN_MODEL] as never);
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);

    const pending = pi.commands.get("permission-model")?.handler("", ctx);
    await vi.waitFor(() => expect(steps).toHaveLength(1));
    steps[0]!.onSelect("llm");
    await vi.waitFor(() => expect(steps).toHaveLength(2));
    steps[1]!.onSelect("q/n");
    await pending;

    expect(writeSelection).toHaveBeenCalledTimes(1);
    expect(writeSelection).toHaveBeenCalledWith({
      mode: "llm",
      llm: { provider: "q", model: "n" },
    });
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(STATUS_KEY, "perm-judge: llm:q/n");
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
    start(pi, { loadConfig, writeSelection: vi.fn() });
    publishForSession();
    const ctx = ctxWithModel();
    ctx.isProjectTrusted.mockReturnValue(false);
    ctx.modelRegistry.find.mockImplementation(findKnown);
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(loadConfig).toHaveBeenLastCalledWith("/project", false);

    ctx.isProjectTrusted.mockReturnValue(true);
    await pi.commands.get("permission-model")?.handler("llm q/n", ctx);

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

describe("permission-judge modes", () => {
  const JEV = { provider: "typesafe", id: "jev", type: "classifier" } as never;
  const DENY_RESULT = {
    api: "typesafe-system-one",
    provider: "typesafe",
    model: "jev",
    answers: {
      reversible: { type: "bool", probability: 0.1 },
      contained: { type: "bool", probability: 0.9 },
      hazard: {
        type: "choice",
        choice: "force_push",
        probabilities: { none: 0.02, force_push: 0.98 },
        confidence: 0.98,
      },
    },
    stopReason: "stop",
    timestamp: 0,
  };

  function ctxWithClassifier(classify = vi.fn(async () => DENY_RESULT)) {
    const ctx = ctxWithModel();
    return {
      ...ctx,
      modelRegistry: {
        ...ctx.modelRegistry,
        findOfType: vi.fn((type: string, provider: string, id: string) =>
          type === "classifier" && provider === "typesafe" && id === "jev" ? JEV : undefined,
        ),
        classify,
      },
    };
  }

  function configWith(top: Record<string, unknown>): LoadConfigResult {
    return {
      config: classifierConfigSchema.parse(top),
      issues: [],
    };
  }

  function registeredNames(): string[] {
    return service.registerAuthorizer.mock.calls.map((call) => call[0] as string);
  }

  const QUICK = { provider: "typesafe", model: "jev" };
  const log = () => ({ review: vi.fn(), debug: vi.fn() });

  it.each(["llm", "quick", "quick-then-llm"])(
    "registers permission-judge and the classifier alias in mode %s, once across ready events, disposed at shutdown",
    (mode) => {
      const pi = makeFakePi();
      start(pi, {
        loadConfig: () =>
          configWith({ mode, quickJudge: QUICK, systemOne: QUICK, classifierEnabled: false }),
      });
      publishForSession();
      pi.lifecycle.get("session_start")?.({}, ctxWithClassifier());
      pi.events.get(READY_CHANNEL)?.(READY_EVENT);
      pi.events.get(READY_CHANNEL)?.(READY_EVENT);
      expect(registeredNames()).toEqual(["permission-judge", "classifier"]);
      pi.lifecycle.get("session_shutdown")?.({}, ctxWithClassifier());
      expect(service.disposer).toHaveBeenCalledTimes(2);
    },
  );

  it("judges under the classifier alias as under permission-judge, warning once per session", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const complete = allowingComplete();
    const pi = makeFakePi();
    start(pi, { complete });
    publishForSession();
    for (let session = 0; session < 2; session += 1) {
      pi.lifecycle.get("session_start")?.({}, ctxWithClassifier());
      pi.events.get(READY_CHANNEL)?.(READY_EVENT);
      const alias = service.registerAuthorizer.mock.calls
        .filter((call) => call[0] === "classifier")
        .at(-1)?.[1] as RegisteredAuthorizer;
      expect(await alias({ ...askDetails(), requestId: "a1" }, {}, log())).toEqual({
        kind: "allow",
      });
      await alias({ ...askDetails(), requestId: "a2" }, {}, log());
      pi.lifecycle.get("session_shutdown")?.({}, ctxWithClassifier());
    }
    expect(complete).toHaveBeenCalledTimes(4);
    const deprecated = warn.mock.calls.filter(([message]) =>
      String(message).includes("deprecated"),
    );
    expect(deprecated).toHaveLength(2);
  });

  it("keeps permission-judge when registering the alias throws, and never retries", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    service.registerAuthorizer.mockImplementation((name: string) => {
      if (name === "classifier") {
        throw new Error("authorizer classifier is already registered");
      }
      return service.disposer;
    });
    const pi = makeFakePi();
    start(pi);
    publishForSession();
    pi.lifecycle.get("session_start")?.({}, ctxWithClassifier());
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(registeredNames()).toEqual(["permission-judge", "classifier"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("classifier");
    expect(warn.mock.calls[0]?.[0]).toContain("already registered");
    pi.lifecycle.get("session_shutdown")?.({}, ctxWithClassifier());
    expect(service.disposer).toHaveBeenCalledTimes(1);
  });

  it("judges an ask once when both names are in the chain", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const complete = vi.fn<CompleteFn>(async () => assistantToolCall({ verdict: "defer" }));
    const pi = makeFakePi();
    start(pi, { complete });
    publishForSession();
    pi.lifecycle.get("session_start")?.({}, ctxWithClassifier());
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    const named = (name: string) =>
      service.registerAuthorizer.mock.calls.find((call) => call[0] === name)?.[1] as RegisteredAuthorizer;
    const details = { ...askDetails(), requestId: "same" };
    const first = log();
    const second = log();
    expect(await named("permission-judge")(details, {}, first)).toEqual({ kind: "defer" });
    expect(await named("classifier")(details, {}, second)).toEqual({ kind: "defer" });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(first.review).toHaveBeenCalledTimes(1);
    expect(second.review).not.toHaveBeenCalled();
  });

  it("judges with the quick judge in mode quick, under its own policy", async () => {
    const classify = vi.fn(async () => DENY_RESULT);
    const complete = vi.fn<CompleteFn>();
    const pi = makeFakePi();
    start(pi, {
      complete,
      loadConfig: () =>
        configWith({ mode: "quick", quickJudge: { ...QUICK, verdicts: "allow-deny" } }),
    });
    publishForSession();
    pi.lifecycle.get("session_start")?.({}, ctxWithClassifier(classify));
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(await lastAuthorizer()(askDetails(), {}, log())).toMatchObject({ kind: "deny" });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it("ignores systemOne: mode llm never calls classify", async () => {
    const classify = vi.fn(async () => DENY_RESULT);
    const pi = makeFakePi();
    start(pi, {
      complete: allowingComplete(),
      loadConfig: () => configWith({ systemOne: QUICK }),
    });
    publishForSession();
    pi.lifecycle.get("session_start")?.({}, ctxWithClassifier(classify));
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(await lastAuthorizer()(askDetails(), {}, log())).toEqual({ kind: "allow" });
    expect(classify).not.toHaveBeenCalled();
  });

  it("applies a mode change on the next ask with no re-registration", async () => {
    const classify = vi.fn(async () => DENY_RESULT);
    let current = configWith({ quickJudge: QUICK });
    const pi = makeFakePi();
    start(pi, { complete: allowingComplete(), loadConfig: () => current });
    publishForSession();
    pi.lifecycle.get("session_start")?.({}, ctxWithClassifier(classify));
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    const authorize = lastAuthorizer();
    await authorize(askDetails(), {}, log());
    expect(classify).not.toHaveBeenCalled();

    // A config reload swaps the live config; the registered callback reads it.
    current = configWith({ mode: "quick-then-llm", quickJudge: QUICK });
    pi.lifecycle.get("session_start")?.({}, ctxWithClassifier(classify));
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(await authorize(askDetails(), {}, log())).toEqual({ kind: "allow" });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(service.registerAuthorizer).toHaveBeenCalledTimes(2);
  });

  it("warns once per session about a cascade policy override", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pi = makeFakePi();
    start(pi, {
      complete: allowingComplete(),
      loadConfig: () =>
        configWith({
          mode: "quick-then-llm",
          quickJudge: { ...QUICK, verdicts: "allow-deny", onError: "deny" },
        }),
    });
    publishForSession();
    for (let i = 0; i < 2; i += 1) {
      pi.lifecycle.get("session_start")?.({}, ctxWithClassifier());
      pi.events.get(READY_CHANNEL)?.(READY_EVENT);
      await lastAuthorizer()(askDetails(), {}, log());
      await lastAuthorizer()(askDetails(), {}, log());
      pi.lifecycle.get("session_shutdown")?.({}, ctxWithClassifier());
    }
    const forced = warn.mock.calls.filter(([message]) =>
      String(message).includes("quick-then-llm"),
    );
    expect(forced).toHaveLength(2);
  });

  it("sends the session cwd to the quick judge", async () => {
    const classify = vi.fn(async () => DENY_RESULT);
    const pi = makeFakePi();
    start(pi, { loadConfig: () => configWith({ mode: "quick", quickJudge: QUICK }) });
    publishForSession();
    pi.lifecycle.get("session_start")?.({}, ctxWithClassifier(classify));
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    await lastAuthorizer()(askDetails(), {}, log());
    const context = (classify.mock.calls[0] as unknown[])[1] as { state: { cwd: string } };
    expect(context.state.cwd).toBe("/project");
  });
});

describe("footer status by mode", () => {
  const JEV = { provider: "typesafe", id: "jev-latest", type: "classifier" } as never;

  function ctxWith(classify: () => Promise<unknown> = async () => ({
    api: "typesafe-system-one",
    provider: "typesafe",
    model: "jev-latest",
    answers: {},
    stopReason: "error",
    errorMessage: "503",
    timestamp: 0,
  })) {
    const ctx = ctxWithModel();
    return {
      ...ctx,
      modelRegistry: {
        ...ctx.modelRegistry,
        findOfType: vi.fn((type: string, provider: string, id: string) =>
          type === "classifier" && provider === "typesafe" && id === "jev-latest" ? JEV : undefined,
        ),
        classify: vi.fn(classify),
      },
    };
  }

  /** Boot a session on `top`; a later reload (after a command write) loads `next`. */
  function boot(top: Record<string, unknown>, ctx = ctxWith(), next = top) {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const pi = makeFakePi();
    let loads = 0;
    const agentDir = start(pi, {
      complete: allowingComplete(),
      loadConfig: () => ({
        config: classifierConfigSchema.parse(loads++ === 0 ? top : next),
        issues: [],
      }),
    });
    publishForSession();
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    return { pi, ctx, agentDir };
  }

  function lastStatus(ctx: ReturnType<typeof ctxWith>): unknown {
    return ctx.ui.setStatus.mock.calls.at(-1)?.[1];
  }

  const JEV_PAIR = { provider: "typesafe", model: "jev-latest" };

  it("shows the quick judge before the LLM judge in mode quick-then-llm", () => {
    const { ctx } = boot({ mode: "quick-then-llm", quickJudge: JEV_PAIR });
    expect(lastStatus(ctx)).toBe("perm-judge: quick:typesafe/jev-latest -> llm:chat-model");
  });

  it("marks an unresolved quick judge", () => {
    const { ctx } = boot({
      mode: "quick-then-llm",
      quickJudge: { provider: "typesafe", model: "nope" },
    });
    expect(lastStatus(ctx)).toBe("perm-judge: quick:typesafe/nope (unresolved) -> llm:chat-model");
  });

  it("shows only the quick judge in mode quick", () => {
    const { ctx } = boot({ mode: "quick", quickJudge: JEV_PAIR });
    expect(lastStatus(ctx)).toBe("perm-judge: quick:typesafe/jev-latest");
  });

  it("shows only the LLM judge in mode llm, even with a quickJudge object", () => {
    const { ctx } = boot({ quickJudge: JEV_PAIR, systemOne: JEV_PAIR });
    expect(lastStatus(ctx)).toBe("perm-judge: llm:chat-model");
  });

  it("gives the quick judge its own health suffix", async () => {
    const { ctx } = boot({ mode: "quick-then-llm", quickJudge: JEV_PAIR });
    await lastAuthorizer()(askDetails(), {}, { review: vi.fn(), debug: vi.fn() });
    expect(lastStatus(ctx)).toBe("perm-judge: quick:typesafe/jev-latest | call-failed x1 -> llm:chat-model");
  });

  it("shows the quick breaker countdown while it is open", async () => {
    const { ctx } = boot({ mode: "quick", quickJudge: JEV_PAIR });
    for (let i = 0; i < 3; i += 1) {
      await lastAuthorizer()(askDetails(), {}, { review: vi.fn(), debug: vi.fn() });
    }
    expect(lastStatus(ctx)).toMatch(/^perm-judge: quick:typesafe\/jev-latest \| breaker open \d+s$/);
  });

  it("names a configured LLM pair, and marks it unresolved when the registry lacks it", () => {
    const { ctx } = boot({ provider: "nope", model: "x" });
    expect(lastStatus(ctx)).toBe("perm-judge: llm:nope/x (unresolved)");
  });

  it("marks a quick judge with no pair as unset", () => {
    const { ctx } = boot({ mode: "quick" });
    expect(lastStatus(ctx)).toBe("perm-judge: quick:unset (unresolved)");
  });

  it("updates the entry after a mode change", async () => {
    const { pi, ctx, agentDir } = boot({ quickJudge: JEV_PAIR }, ctxWith(), {
      mode: "quick-then-llm",
      quickJudge: JEV_PAIR,
    });
    saveGlobal(agentDir, { quickJudge: JEV_PAIR });
    expect(lastStatus(ctx)).toBe("perm-judge: llm:chat-model");
    await pi.commands.get("permission-model")?.handler("mode quick-then-llm", ctx);
    expect(lastStatus(ctx)).toBe("perm-judge: quick:typesafe/jev-latest -> llm:chat-model");
  });

  it("clears the status at shutdown", () => {
    const { pi, ctx } = boot({ mode: "quick", quickJudge: JEV_PAIR });
    pi.lifecycle.get("session_shutdown")?.({}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(STATUS_KEY, undefined);
  });
});

