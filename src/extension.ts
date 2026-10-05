/**
 * Extension wiring: load the config at `session_start`, register the
 * `"permission-judge"` link and its deprecated alias `"classifier"` from
 * `permissions:ready`, and dispose both on shutdown. The link reads the
 * config's `mode` on every ask and runs the LLM judge, the quick judge, or
 * both (see `judge-link.ts`); the names share one judge (see
 * `name-alias.ts`).
 *
 * The ready handler is the sole registration site. pi-permission-system
 * >=27.0.0 emits `permissions:ready` at least once after every extension's
 * `session_start` (and it may repeat), so registering there needs no second
 * attempt from this extension's own `session_start` — only an idempotency
 * guard, because `registerAuthorizer` rejects a duplicate name.
 *
 * The service is resolved per node with the session-keyed locator, using the
 * sessionId carried by the ready payload. When that id is missing, or the
 * locator has no service for it, the permission system in this session is too
 * old (or absent): warn once per session and register nothing — never fall
 * back to the process root's service, which is another node's inside an
 * in-process subagent child.
 *
 * The session's active model is captured at `session_start` and follows
 * `model_select`, so with no config override the judge is always the model
 * the session is actually running.
 *
 * Guidance files are read for every judged ask through the reviewer's
 * guidance seam: the loader walks the disk with the session cwd and the
 * agent dir, project trust is read from the session context at that moment
 * (never cached at ready), and the selection applies the trust gate and the
 * byte caps. An older pi without a trust query counts as untrusted.
 *
 * Once the link registers, the footer status `zz-permission-classifier` names
 * the active judges (see `judge.ts`); it follows `model_select` and is
 * cleared at `session_shutdown`. No status is set when the link does not
 * register.
 *
 * The `--permission-model` launch flag is read at `session_start`: a comma
 * list of `quick:<provider>/<id>`, `llm:<provider>/<id>`, `llm:chat-model`
 * and `mode:<mode>` (see `parseFlagOverride`). The values become a
 * session-only override merged over the config per ask; nothing is written.
 * An item that does not parse or resolve is ignored with a warning and the
 * rest still applies. A /permission-model write drops the values it touches,
 * and the override is dropped at `session_shutdown`.
 */

import type { Model } from "@earendil-works/pi-ai";
import { complete as realComplete } from "@earendil-works/pi-ai/compat";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
  getPermissionsService,
  PERMISSIONS_READY_CHANNEL,
  type PermissionsReadyEvent,
} from "@gotgenes/pi-permission-system";

import {
  COMMAND_NAME,
  type CommandRegistryLike,
  createPermissionModelCommand,
  type PickerSeam,
} from "./command";
import {
  formatConfigIssue,
  getGlobalConfigPath,
  getProjectConfigPath,
  globalConfigExists,
  type JudgeSelection,
  type LoadConfigResult,
  loadClassifierConfig,
  writeGlobalSelection,
} from "./config-loader";
import { CircuitBreaker } from "./breaker";
import {
  CLASSIFIER_EXTENSION_ID,
  type ClassifierConfig,
} from "./config-schema";
import {
  findGlobalGuidancePath,
  type GuidanceLoader,
  type GuidanceSelection,
  loadGuidanceFromDisk,
  selectGuidance,
} from "./guidance";
import { formatHealthSuffix, SessionHealth } from "./health";
import {
  applySessionOverride,
  formatJudgeStatus,
  formatQuickStatus,
  parseFlagOverride,
  resolveJudge,
  resolveQuickJudge,
  type SessionOverride,
} from "./judge";
import { createJudgeLink } from "./judge-link";
import type { CompleteFn } from "./model-review";
import { createNamedAuthorizers } from "./name-alias";
import type { QuickJudgeRegistryLike } from "./quick-judge";
import type { ModelRegistryLike } from "./reviewer";


/** The footer status key naming the effective judge. pi sorts extension
 * statuses by key on one footer line; the `zz-` prefix keeps this entry last. */
const STATUS_KEY = "zz-permission-classifier";

/** The launch flag carrying a session-only judge override. */
const FLAG_NAME = "permission-model";

/** Footer refresh period while the breaker counts down, in milliseconds. */
const COUNTDOWN_TICK_MS = 1000;

/** Injectable seams; production defaults read the filesystem and call the model. */
export interface ClassifierDependencies {
  /** The pi agent dir holding the global config; defaults to `getAgentDir()`. */
  agentDir?: () => string;
  /** Load the layered config; the project layer applies only when trusted. */
  loadConfig?: (cwd: string, projectTrusted: boolean) => LoadConfigResult;
  complete?: CompleteFn;
  /** Persist a /permission-model selection to the global config. */
  writeSelection?: (selection: JudgeSelection) => void;
  /** Builds the /permission-model picker; the default mounts pi's selector. */
  buildPicker?: PickerSeam;
  /** Reads the context files from disk; defaults to pi's context-file walk. */
  loadGuidance?: GuidanceLoader;
}

function warn(message: string): void {
  console.warn(`[${CLASSIFIER_EXTENSION_ID}] ${message}`);
}

export function createClassifierExtension(
  pi: ExtensionAPI,
  dependencies: ClassifierDependencies = {},
): void {
  // `agentDir()` is called inside each lambda rather than hoisted so the env
  // read happens only on the production path, and only when a config is
  // actually touched — `getAgentDir()` honors `PI_CODING_AGENT_DIR`, matching
  // where pi-permission-system looks for the same global scope.
  const agentDir = dependencies.agentDir ?? getAgentDir;
  const loadConfig =
    dependencies.loadConfig ??
    ((cwd: string, projectTrusted: boolean) =>
      loadClassifierConfig({ cwd, agentDir: agentDir(), projectTrusted }));
  const complete: CompleteFn =
    dependencies.complete ??
    ((model, context, options) => realComplete(model, context, options));
  const writeSelection =
    dependencies.writeSelection ??
    ((selection: JudgeSelection) => writeGlobalSelection(agentDir(), selection));
  const loadGuidance = dependencies.loadGuidance ?? loadGuidanceFromDisk;

  pi.registerFlag(FLAG_NAME, {
    description:
      "Permission judge for this session only, a comma list of " +
      "quick:<provider>/<id>, llm:<provider>/<id>, llm:chat-model and " +
      "mode:<llm|quick|quick-then-llm>; writes nothing.",
    type: "string",
  });

  let config: ClassifierConfig | undefined;
  let sessionModel: Model<any> | undefined;
  let registry:
    | (ModelRegistryLike & CommandRegistryLike & QuickJudgeRegistryLike)
    | undefined;
  let ui: ExtensionContext["ui"] | undefined;
  /** The session context, for the per-ask cwd and trust reads. */
  let session: ExtensionContext | undefined;
  let override: SessionOverride = {};
  let dispose: (() => void) | undefined;
  let warnedUnreachable = false;
  /** Per-session LLM judge health and breaker; both start fresh at shutdown. */
  const health = new SessionHealth();
  let breaker = new CircuitBreaker();
  /** The quick judge's own health and breaker, apart from the LLM judge's. */
  const quickHealth = new SessionHealth();
  let quickBreaker = new CircuitBreaker();
  /** The once-per-second footer refresh while the breaker cools down. */
  let countdown: ReturnType<typeof setInterval> | undefined;

  /** The config the judges read: the merged config with the flag values over it. */
  function effectiveConfig(): ClassifierConfig | undefined {
    return applySessionOverride(config, override);
  }

  /**
   * The project's trust state right now, from the session context. A pi
   * without the trust query, or no context yet, counts as untrusted.
   */
  function projectTrusted(ctx: ExtensionContext | undefined = session): boolean {
    return typeof ctx?.isProjectTrusted === "function"
      ? ctx.isProjectTrusted()
      : false;
  }

  /**
   * Load and select this ask's guidance. Called by the reviewer once per
   * judged ask; every read here is live — the disk walk, the agent dir, and
   * the trust query — so nothing decided at ready can go stale. Throws
   * propagate: the reviewer turns them into a guidance-load-failed defer.
   */
  function getGuidance(): GuidanceSelection {
    if (!session) {
      throw new Error("no session context to read guidance for");
    }
    const dir = agentDir();
    const files = loadGuidance({ cwd: session.cwd, agentDir: dir });
    return selectGuidance(
      files,
      findGlobalGuidancePath(files, dir),
      projectTrusted(session),
    );
  }

  /** The session cwd for the quick judge state; no session is an internal error. */
  function sessionCwd(): string {
    if (!session) {
      throw new Error("no session context to read the cwd from");
    }
    return session.cwd;
  }

  /** Read the launch flag; each item that does not apply is ignored with a warning. */
  function readFlagOverride(): SessionOverride {
    const raw = pi.getFlag(FLAG_NAME);
    if (typeof raw !== "string" || raw.length === 0) {
      return {};
    }
    const parsed = parseFlagOverride(raw, registry);
    for (const warning of parsed.warnings) {
      const message = `--${FLAG_NAME}: ${warning} Ignored.`;
      warn(message);
      ui?.notify(message, "warning");
    }
    return parsed.override;
  }

  /**
   * Repaint the footer: a part for each judge the mode runs, the quick judge
   * first, each with its own health suffix. A no-op until the link
   * registers. Refreshed on judge changes and after every judge outcome.
   */
  function refreshStatus(): void {
    if (!dispose) {
      return;
    }
    const effective = effectiveConfig();
    const mode = effective?.mode ?? "llm";
    const parts: string[] = [];
    if (mode !== "llm") {
      parts.push(
        formatQuickStatus(resolveQuickJudge(effective?.quickJudge ?? {}, registry)) +
          formatHealthSuffix(quickHealth, quickBreaker.remainingMs()),
      );
    }
    if (mode !== "quick") {
      parts.push(
        formatJudgeStatus(resolveJudge(undefined, effective, registry, sessionModel)) +
          formatHealthSuffix(health, breaker.remainingMs()),
      );
    }
    ui?.setStatus(STATUS_KEY, parts.join(", "));
  }

  /** The longer of the two breakers' remaining cooldowns. */
  function breakerRemainingMs(): number {
    return Math.max(breaker.remainingMs(), quickBreaker.remainingMs());
  }

  function stopCountdown(): void {
    if (countdown !== undefined) {
      clearInterval(countdown);
      countdown = undefined;
    }
  }

  /**
   * Keep the breaker countdown in step with the breaker: start one interval
   * when the breaker is open, stop it once the cooldown has elapsed (the tick
   * that reaches zero repaints without the breaker suffix) or the breaker
   * closed. The interval never keeps the process alive.
   */
  function syncCountdown(): void {
    if (breakerRemainingMs() === 0) {
      stopCountdown();
      return;
    }
    if (countdown !== undefined) {
      return;
    }
    countdown = setInterval(() => {
      refreshStatus();
      if (breakerRemainingMs() === 0) {
        stopCountdown();
      }
    }, COUNTDOWN_TICK_MS);
    countdown.unref?.();
  }

  pi.registerCommand(
    COMMAND_NAME,
    createPermissionModelCommand({
      getConfig: effectiveConfig,
      getSavedConfig: () => config,
      getRegistry: () => registry,
      ...(dependencies.buildPicker
        ? { buildPicker: dependencies.buildPicker }
        : {}),
      globalConfigExists: () => globalConfigExists(agentDir()),
      globalConfigPath: () => getGlobalConfigPath(agentDir()),
      projectConfigPath: getProjectConfigPath,
      write: writeSelection,
      reload: (cwd) => loadConfig(cwd, projectTrusted()),
      apply: (next, selection) => {
        // An explicit choice replaces the flag value it touches for the rest
        // of the session.
        config = next;
        override = {
          ...(selection.mode === undefined && override.mode !== undefined
            ? { mode: override.mode }
            : {}),
          ...(selection.llm === undefined && override.llm !== undefined
            ? { llm: override.llm }
            : {}),
          ...(selection.quick === undefined && override.quick !== undefined
            ? { quick: override.quick }
            : {}),
        };
        refreshStatus();
      },
    }),
  );

  function warnUnreachableOnce(): void {
    if (warnedUnreachable) {
      return;
    }
    warnedUnreachable = true;
    warn(
      "could not resolve this session's permission service — " +
        "pi-permission-system 27.0.0 or later must be loaded in the same " +
        "session; no permission link is registered.",
    );
  }

  pi.on("session_start", (_event, ctx) => {
    const result = loadConfig(ctx.cwd, projectTrusted(ctx));
    config = result.config;
    sessionModel = ctx.model;
    registry = ctx.modelRegistry;
    ui = ctx.ui;
    session = ctx;
    override = readFlagOverride();
    for (const issue of result.issues) {
      warn(`config issue: ${formatConfigIssue(issue)}`);
    }
  });

  pi.on("model_select", (event) => {
    sessionModel = event.model;
    refreshStatus();
  });

  pi.events.on(PERMISSIONS_READY_CHANNEL, (event) => {
    // Idempotent: ready fires at least once per session and may repeat.
    if (dispose || !config) {
      return;
    }
    const sessionId = (event as PermissionsReadyEvent | undefined)?.sessionId;
    if (typeof sessionId !== "string") {
      warnUnreachableOnce();
      return;
    }
    const service = getPermissionsService(sessionId);
    if (!service) {
      warnUnreachableOnce();
      return;
    }
    // One link per session: its once-per-session warnings live in the closures.
    const judge = createJudgeLink({
      getConfig: effectiveConfig,
      warn,
      llm: {
        getSessionModel: () => sessionModel,
        getRegistry: () => registry,
        complete,
        breaker,
        getGuidance,
        onOutcome: (outcome) => {
          health.record(outcome);
          refreshStatus();
          syncCountdown();
        },
      },
      quick: {
        getRegistry: () => registry,
        getCwd: sessionCwd,
        getGuidance,
        breaker: quickBreaker,
        onOutcome: (outcome) => {
          quickHealth.record(outcome);
          refreshStatus();
          syncCountdown();
        },
      },
    });
    // Register each name on its own: a name another extension already holds
    // is skipped with a warning, the others stay registered, and dispose is
    // set either way so a repeated ready never retries a taken name.
    const disposers: (() => void)[] = [];
    for (const { name, authorize } of createNamedAuthorizers(judge, { warn })) {
      try {
        disposers.push(service.registerAuthorizer(name, authorize));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        warn(`could not register the chain link ${name}: ${reason}`);
      }
    }
    dispose = () => {
      for (const disposeName of disposers) {
        disposeName();
      }
    };
    refreshStatus();
  });

  pi.on("session_shutdown", () => {
    if (dispose) {
      ui?.setStatus(STATUS_KEY, undefined);
    }
    dispose?.();
    dispose = undefined;
    config = undefined;
    sessionModel = undefined;
    registry = undefined;
    ui = undefined;
    session = undefined;
    override = {};
    warnedUnreachable = false;
    stopCountdown();
    health.reset();
    breaker = new CircuitBreaker();
    quickHealth.reset();
    quickBreaker = new CircuitBreaker();
  });
}
