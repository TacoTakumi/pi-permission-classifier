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
};

const SESSION_MODEL = { provider: "anthropic", id: "claude-opus" } as Model<any>;
const NEXT_MODEL = { provider: "anthropic", id: "claude-haiku" } as Model<any>;

interface FakePi {
  lifecycle: Map<string, (event: unknown, ctx: unknown) => void>;
  events: Map<string, (data: unknown) => void>;
  api: {
    on: ReturnType<typeof vi.fn>;
    events: { on: ReturnType<typeof vi.fn>; emit: ReturnType<typeof vi.fn> };
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

function ctxWithModel(cwd = "/project") {
  return {
    cwd,
    model: SESSION_MODEL,
    modelRegistry: {
      find: vi.fn(),
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true as const,
        apiKey: "sk-test",
      })),
    },
  };
}

let service: ReturnType<typeof makeService>;

beforeEach(() => {
  service = makeService();
});

afterEach(() => {
  unpublishPermissionsService(service);
  vi.restoreAllMocks();
});

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
  it("registers the classifier link when session_start runs before ready", () => {
    const pi = makeFakePi();
    start(pi);
    pi.lifecycle.get("session_start")?.({}, ctxWithModel());
    publishPermissionsService(service);
    pi.events.get(READY_CHANNEL)?.({});
    expect(service.registerAuthorizer).toHaveBeenCalledTimes(1);
    expect(service.registerAuthorizer.mock.calls[0]?.[0]).toBe("classifier");
    expect(typeof service.registerAuthorizer.mock.calls[0]?.[1]).toBe(
      "function",
    );
  });

  it("registers when ready fires before this session_start", () => {
    const pi = makeFakePi();
    start(pi);
    publishPermissionsService(service);
    pi.events.get(READY_CHANNEL)?.({});
    expect(service.registerAuthorizer).not.toHaveBeenCalled();
    pi.lifecycle.get("session_start")?.({}, ctxWithModel());
    expect(service.registerAuthorizer).toHaveBeenCalledTimes(1);
  });

  it("registers only once across both triggers", () => {
    const pi = makeFakePi();
    start(pi);
    publishPermissionsService(service);
    pi.lifecycle.get("session_start")?.({}, ctxWithModel());
    pi.events.get(READY_CHANNEL)?.({});
    pi.events.get(READY_CHANNEL)?.({});
    expect(service.registerAuthorizer).toHaveBeenCalledTimes(1);
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
    publishPermissionsService(service);
    pi.lifecycle.get("session_start")?.({}, ctxWithModel());
    pi.events.get(READY_CHANNEL)?.({});
    expect(service.registerAuthorizer).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("judges with the session model captured at session_start", async () => {
    const complete = vi.fn<CompleteFn>(async () =>
      assistantToolCall({ verdict: "allow" }),
    );
    const pi = makeFakePi();
    start(pi, { complete });
    publishPermissionsService(service);
    pi.lifecycle.get("session_start")?.({}, ctxWithModel());
    pi.events.get(READY_CHANNEL)?.({});
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
    publishPermissionsService(service);
    const ctx = ctxWithModel();
    pi.lifecycle.get("session_start")?.({}, ctx);
    pi.events.get(READY_CHANNEL)?.({});
    pi.lifecycle.get("model_select")?.(
      { type: "model_select", model: NEXT_MODEL, previousModel: SESSION_MODEL },
      ctx,
    );
    const authorize = service.registerAuthorizer.mock
      .calls[0]?.[1] as RegisteredAuthorizer;
    await authorize(askDetails(), {}, { review: vi.fn(), debug: vi.fn() });
    expect(complete.mock.calls[0]?.[0]).toBe(NEXT_MODEL);
  });

  it("disposes on session_shutdown and a later ready does not re-register", () => {
    const pi = makeFakePi();
    start(pi);
    publishPermissionsService(service);
    pi.lifecycle.get("session_start")?.({}, ctxWithModel());
    pi.events.get(READY_CHANNEL)?.({});
    expect(service.registerAuthorizer).toHaveBeenCalledTimes(1);
    pi.lifecycle.get("session_shutdown")?.({}, ctxWithModel());
    expect(service.disposer).toHaveBeenCalledTimes(1);
    pi.events.get(READY_CHANNEL)?.({});
    expect(service.registerAuthorizer).toHaveBeenCalledTimes(1);
  });
});

describe("default export", () => {
  it("wires the extension lifecycle handlers", () => {
    const pi = makeFakePi();
    piPermissionClassifier(pi.api as never);
    expect(pi.lifecycle.has("session_start")).toBe(true);
    expect(pi.lifecycle.has("model_select")).toBe(true);
    expect(pi.lifecycle.has("session_shutdown")).toBe(true);
    expect(pi.events.has(READY_CHANNEL)).toBe(true);
  });
});
