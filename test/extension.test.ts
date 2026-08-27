import type { Model } from "@earendil-works/pi-ai";
import type {
  PermissionsService,
  PromptPermissionDetails,
} from "@gotgenes/pi-permission-system";
import {
  publishPermissionsService,
  publishRootPermissionsService,
  unpublishPermissionsService,
  unpublishRootPermissionsService,
} from "@gotgenes/pi-permission-system";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LoadConfigResult } from "#src/config-loader";
import { createClassifierExtension } from "#src/extension";
import piPermissionClassifier from "#src/index";
import type { CompleteFn } from "#src/model-review";
import { assistantToolCall } from "#test/fixtures/assistant-message";
import { askDetails } from "#test/fixtures/details";

const READY_CHANNEL = "permissions:ready";

const CONFIG_RESULT: LoadConfigResult = {
  config: {
    surfaces: ["bash", "mcp", "skill", "tool", "read", "write", "edit"],
    timeoutMs: 5000,
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
  };
}

function makeFakePi(): FakePi {
  const lifecycle = new Map<string, (event: unknown, ctx: unknown) => void>();
  const events = new Map<string, (data: unknown) => void>();
  return {
    lifecycle,
    events,
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
    model: SESSION_MODEL,
    modelRegistry: {
      find: vi.fn(),
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true as const,
        apiKey: "sk-test",
      })),
    },
    ui: { setStatus: vi.fn() },
  };
}

const STATUS_KEY = "permission-classifier";

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

beforeEach(() => {
  service = makeService();
});

afterEach(() => {
  unpublishPermissionsService(SESSION_ID, service);
  vi.restoreAllMocks();
});

/** Publish `service` under {@link SESSION_ID} in the keyed locator. */
function publishForSession(): void {
  publishPermissionsService(SESSION_ID, service);
}

const READY_EVENT = { sessionId: SESSION_ID, adjudicatesLocally: true };
const READY_EVENT_NO_ID = { sessionId: null, adjudicatesLocally: true };

function start(
  pi: FakePi,
  overrides: { loadConfig?: () => LoadConfigResult; complete?: CompleteFn } = {},
) {
  createClassifierExtension(pi.api as never, {
    loadConfig: overrides.loadConfig ?? (() => CONFIG_RESULT),
    complete: overrides.complete ?? vi.fn(),
  });
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
    // Only the deprecated root slot is populated — the classifier must not
    // resolve it, so this is a locator miss for the session key.
    const rootService = makeService();
    publishRootPermissionsService(rootService);
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const pi = makeFakePi();
      start(pi);
      pi.lifecycle.get("session_start")?.({}, ctxWithModel());
      pi.events.get(READY_CHANNEL)?.(READY_EVENT);
      pi.events.get(READY_CHANNEL)?.(READY_EVENT);
      expect(rootService.registerAuthorizer).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/27\.0\.0/);
    } finally {
      unpublishRootPermissionsService(rootService);
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
    const pi = makeFakePi();
    pi.api.getFlag.mockReturnValue("p/m");
    start(pi, { complete, loadConfig });
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
    const pi = makeFakePi();
    pi.api.getFlag.mockReturnValue("nope/x");
    start(pi, { complete, loadConfig: () => CONFIG_QN_RESULT });
    publishForSession();
    const ctx = ctxWithModel();
    ctx.modelRegistry.find.mockImplementation(findKnown);
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.(READY_EVENT);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("nope/x");
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

describe("default export", () => {
  it("wires the extension lifecycle handlers", () => {
    const pi = makeFakePi();
    piPermissionClassifier(pi.api as never);
    expect(pi.api.registerFlag).toHaveBeenCalledWith(
      "permission-model",
      expect.objectContaining({ type: "string" }),
    );
    expect(pi.lifecycle.has("session_start")).toBe(true);
    expect(pi.lifecycle.has("model_select")).toBe(true);
    expect(pi.lifecycle.has("session_shutdown")).toBe(true);
    expect(pi.events.has(READY_CHANNEL)).toBe(true);
  });
});
