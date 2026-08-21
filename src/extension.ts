/**
 * Extension wiring: load the config at `session_start`, register the
 * `"classifier"` link once the permission service is ready, and dispose on
 * shutdown.
 *
 * Registration is attempted from both `session_start` and `permissions:ready`
 * behind an idempotency guard, because the two orderings are both possible:
 * the ready event fires inside pi-permission-system's own `session_start`,
 * which may run before or after this extension's. Whichever completes the
 * pair (config loaded here + service published there) triggers the single
 * registration; the guard prevents a duplicate (which `registerAuthorizer`
 * would reject).
 *
 * The session's active model is captured at `session_start` and follows
 * `model_select`, so with no config override the judge is always the model
 * the session is actually running.
 */

import type { Model } from "@earendil-works/pi-ai";
import { complete as realComplete } from "@earendil-works/pi-ai/compat";
import {
  type ExtensionAPI,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
  getPermissionsService,
  getPermissionsServiceForSession,
  PERMISSIONS_READY_CHANNEL,
  type PermissionsReadyEvent,
} from "@gotgenes/pi-permission-system";

import { type LoadConfigResult, loadClassifierConfig } from "./config-loader";
import {
  CLASSIFIER_EXTENSION_ID,
  type ClassifierConfig,
} from "./config-schema";
import type { CompleteFn } from "./model-review";
import {
  createClassifierReviewer,
  type ModelRegistryLike,
} from "./reviewer";

/** The operator-facing chain-link name referenced from `authorizerChain`. */
const LINK_NAME = "classifier";

/** Injectable seams; production defaults read the filesystem and call the model. */
export interface ClassifierDependencies {
  loadConfig?: (cwd: string) => LoadConfigResult;
  complete?: CompleteFn;
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

  let sessionStarted = false;
  let config: ClassifierConfig | undefined;
  let sessionModel: Model<any> | undefined;
  let registry: ModelRegistryLike | undefined;
  let readySessionId: string | undefined;
  let dispose: (() => void) | undefined;

  function tryRegister(): void {
    if (dispose || !sessionStarted || !config) {
      return;
    }
    // The session-scoped accessor is the supported lookup (the legacy
    // zero-arg one resolves the process root's service — the wrong node in an
    // in-process subagent child). Once the ready payload has named this
    // node's session, only its own service will do; the legacy slot is a
    // fallback solely for a version-skew ready event that carried no id.
    const service =
      readySessionId !== undefined
        ? getPermissionsServiceForSession(readySessionId)
        : getPermissionsService();
    if (!service) {
      return;
    }
    const authorize = createClassifierReviewer({
      getConfig: () => config,
      getSessionModel: () => sessionModel,
      getRegistry: () => registry,
      complete,
    });
    dispose = service.registerAuthorizer(LINK_NAME, authorize);
  }

  pi.on("session_start", (_event, ctx) => {
    const result = loadConfig(ctx.cwd);
    config = result.config;
    sessionModel = ctx.model;
    registry = ctx.modelRegistry;
    // The supported id source alongside the ready payload; guarded so a
    // version-skew SDK without it degrades to the legacy service lookup.
    readySessionId ??= ctx.sessionManager?.getSessionId?.();
    sessionStarted = true;
    for (const issue of result.issues) {
      warn(
        `config issue at ${issue.sourcePath ?? "(merged)"} — ${issue.path}: ${issue.message}`,
      );
    }
    tryRegister();
  });

  pi.on("model_select", (event) => {
    sessionModel = event.model;
  });

  pi.events.on(PERMISSIONS_READY_CHANNEL, (event) => {
    const sessionId = (event as PermissionsReadyEvent | undefined)?.sessionId;
    if (typeof sessionId === "string") {
      readySessionId = sessionId;
    }
    tryRegister();
  });

  pi.on("session_shutdown", () => {
    dispose?.();
    dispose = undefined;
    sessionStarted = false;
    config = undefined;
    sessionModel = undefined;
    registry = undefined;
    readySessionId = undefined;
  });
}
