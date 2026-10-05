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
 * The `--permission-model <provider>/<id>` launch flag is read at
 * `session_start`. A value the registry knows becomes a session-only judge
 * override with precedence over the merged config and the session model;
 * nothing is written, and the override is dropped at `session_shutdown`. An
 * unknown value is ignored with a warning, so the merged config (or the
 * session model) applies as if no flag were given.
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
  formatJudgeStatus,
  formatSystemOneStatus,
  type JudgePair,
  parseJudgePair,
  resolveJudge,
  resolveSystemOneJudge,
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
  /** Persist a judge pair to the global config; both `undefined` removes it. */
  writeJudge?: (provider: string | undefined, model: string | undefined) => void;
  /** Persist a classifier pair to `systemOne` in the global config. */
  writeSystemOne?: (provider: string, model: string) => void;
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
  const writeJudge =
    dependencies.writeJudge ??
    ((provider: string | undefined, model: string | undefined) =>
      writeGlobalSelection(agentDir(), {
        llm: provider === undefined || model === undefined ? null : { provider, model },
      }));
  const writeSystemOne =
    dependencies.writeSystemOne ??
    ((provider: string, model: string) =>
      writeGlobalSelection(agentDir(), { quick: { provider, model } }));
  const loadGuidance = dependencies.loadGuidance ?? loadGuidanceFromDisk;

  pi.registerFlag(FLAG_NAME, {
    description:
      "Judge model for the permission classifier this session only " +
      "(<provider>/<id>); overrides the configured judge, writes nothing.",
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
  let override: JudgePair | undefined;
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

  /**
   * The config the reviewer judges with: the merged config, with the
   * provider/model pair replaced by the session-only override when one is
   * active. The reviewer's own resolution (registry lookup, auth check,
   * defer on failure) is unchanged, so an override can never widen a verdict.
   */
  function effectiveConfig(): ClassifierConfig | undefined {
    if (!config || !override) {
      return config;
    }
    return { ...config, provider: override.provider, model: override.model };
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

  /** Read the launch flag; a value the registry does not know is ignored. */
  function readFlagOverride(): JudgePair | undefined {
    const raw = pi.getFlag(FLAG_NAME);
    if (typeof raw !== "string" || raw.length === 0) {
      return undefined;
    }
    const pair = parseJudgePair(raw);
    if (pair && registry?.find(pair.provider, pair.model)) {
      return pair;
    }
    const message =
      `--${FLAG_NAME} ${raw} is not a known <provider>/<id>; ` +
      "the configured judge applies.";
    warn(message);
    ui?.notify(message, "warning");
    return undefined;
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
    const mode = config?.mode ?? "llm";
    const parts: string[] = [];
    if (mode !== "llm") {
      parts.push(
        formatSystemOneStatus(resolveSystemOneJudge(config?.quickJudge ?? {}, registry)) +
          formatHealthSuffix(quickHealth, quickBreaker.remainingMs()),
      );
    }
    if (mode !== "quick") {
      parts.push(
        formatJudgeStatus(resolveJudge(override, config, registry, sessionModel)) +
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
      getConfig: () => config,
      getOverride: () => override,
      getRegistry: () => registry,
      ...(dependencies.buildPicker
        ? { buildPicker: dependencies.buildPicker }
        : {}),
      globalConfigExists: () => globalConfigExists(agentDir()),
      globalConfigPath: () => getGlobalConfigPath(agentDir()),
      projectConfigPath: getProjectConfigPath,
      writeJudge,
      writeSystemOne,
      reload: (cwd) => loadConfig(cwd, projectTrusted()),
      apply: (next) => {
        // An explicit choice replaces a flag override for the rest of the session.
        config = next;
        override = undefined;
        refreshStatus();
      },
      applySystemOne: (next) => {
        // The flag override names the classifier judge; a systemOne write
        // leaves it alone.
        config = next;
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
    const disposers = createNamedAuthorizers(judge, { warn }).map(({ name, authorize }) =>
      service.registerAuthorizer(name, authorize),
    );
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
    override = undefined;
    warnedUnreachable = false;
    stopCountdown();
    health.reset();
    breaker = new CircuitBreaker();
    quickHealth.reset();
    quickBreaker = new CircuitBreaker();
  });
}
