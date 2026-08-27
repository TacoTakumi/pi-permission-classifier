/**
 * Extension wiring: load the config at `session_start`, register the
 * `"classifier"` link from `permissions:ready`, and dispose on shutdown.
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
 * Once the link registers, the footer status `permission-classifier` names
 * the effective judge (see `judge.ts`); it follows `model_select` and is
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

import { COMMAND_NAME, createPermissionModelCommand } from "./command";
import {
  type LoadConfigResult,
  loadClassifierConfig,
  writeGlobalJudge,
} from "./config-loader";
import {
  CLASSIFIER_EXTENSION_ID,
  type ClassifierConfig,
} from "./config-schema";
import {
  formatJudgeStatus,
  type JudgePair,
  parseJudgePair,
  resolveJudge,
} from "./judge";
import type { CompleteFn } from "./model-review";
import {
  createClassifierReviewer,
  type ModelRegistryLike,
} from "./reviewer";

/** The operator-facing chain-link name referenced from `authorizerChain`. */
const LINK_NAME = "classifier";

/** The footer status key naming the effective judge. */
const STATUS_KEY = "permission-classifier";

/** The launch flag carrying a session-only judge override. */
const FLAG_NAME = "permission-model";

/** Injectable seams; production defaults read the filesystem and call the model. */
export interface ClassifierDependencies {
  loadConfig?: (cwd: string) => LoadConfigResult;
  complete?: CompleteFn;
  /** Persist a judge pair to the global config; both `undefined` removes it. */
  writeJudge?: (provider: string | undefined, model: string | undefined) => void;
}

function warn(message: string): void {
  console.warn(`[${CLASSIFIER_EXTENSION_ID}] ${message}`);
}

export function createClassifierExtension(
  pi: ExtensionAPI,
  dependencies: ClassifierDependencies = {},
): void {
  // `getAgentDir()` is read here rather than hoisted out of the lambda so the
  // env read happens only on the production path, and only when a config is
  // actually loaded — it honors `PI_CODING_AGENT_DIR`, matching where
  // pi-permission-system looks for the same global scope.
  const loadConfig =
    dependencies.loadConfig ??
    ((cwd: string) => loadClassifierConfig({ cwd, agentDir: getAgentDir() }));
  const complete: CompleteFn =
    dependencies.complete ??
    ((model, context, options) => realComplete(model, context, options));
  const writeJudge =
    dependencies.writeJudge ??
    ((provider: string | undefined, model: string | undefined) =>
      writeGlobalJudge(getAgentDir(), provider, model));

  pi.registerFlag(FLAG_NAME, {
    description:
      "Judge model for the permission classifier this session only " +
      "(<provider>/<id>); overrides the configured judge, writes nothing.",
    type: "string",
  });

  let config: ClassifierConfig | undefined;
  let sessionModel: Model<any> | undefined;
  let registry: ModelRegistryLike | undefined;
  let ui: ExtensionContext["ui"] | undefined;
  let override: JudgePair | undefined;
  let dispose: (() => void) | undefined;
  let warnedUnreachable = false;

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
    warn(
      `--${FLAG_NAME} ${raw} is not a known <provider>/<id>; ` +
        "the configured judge applies.",
    );
    return undefined;
  }

  /** Name the effective judge in the footer; a no-op until the link registers. */
  function refreshStatus(): void {
    if (!dispose) {
      return;
    }
    ui?.setStatus(
      STATUS_KEY,
      formatJudgeStatus(resolveJudge(override, config, registry, sessionModel)),
    );
  }

  pi.registerCommand(
    COMMAND_NAME,
    createPermissionModelCommand({
      getConfig: () => config,
      getOverride: () => override,
      writeJudge,
      reload: (cwd) => loadConfig(cwd),
      apply: (next) => {
        // An explicit choice replaces a flag override for the rest of the session.
        config = next;
        override = undefined;
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
        "session; the classifier link is not registered.",
    );
  }

  pi.on("session_start", (_event, ctx) => {
    const result = loadConfig(ctx.cwd);
    config = result.config;
    sessionModel = ctx.model;
    registry = ctx.modelRegistry;
    ui = ctx.ui;
    override = readFlagOverride();
    for (const issue of result.issues) {
      warn(
        `config issue at ${issue.sourcePath ?? "(merged)"} — ${issue.path}: ${issue.message}`,
      );
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
    const authorize = createClassifierReviewer({
      getConfig: effectiveConfig,
      getSessionModel: () => sessionModel,
      getRegistry: () => registry,
      complete,
    });
    dispose = service.registerAuthorizer(LINK_NAME, authorize);
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
    override = undefined;
    warnedUnreachable = false;
  });
}
