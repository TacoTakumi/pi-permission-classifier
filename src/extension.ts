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
 */

import type { Model } from "@earendil-works/pi-ai";
import { complete as realComplete } from "@earendil-works/pi-ai/compat";
import {
  type ExtensionAPI,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
  getPermissionsService,
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

  let config: ClassifierConfig | undefined;
  let sessionModel: Model<any> | undefined;
  let registry: ModelRegistryLike | undefined;
  let dispose: (() => void) | undefined;
  let warnedUnreachable = false;

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
    for (const issue of result.issues) {
      warn(
        `config issue at ${issue.sourcePath ?? "(merged)"} — ${issue.path}: ${issue.message}`,
      );
    }
  });

  pi.on("model_select", (event) => {
    sessionModel = event.model;
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
      getConfig: () => config,
      getSessionModel: () => sessionModel,
      getRegistry: () => registry,
      complete,
    });
    dispose = service.registerAuthorizer(LINK_NAME, authorize);
  });

  pi.on("session_shutdown", () => {
    dispose?.();
    dispose = undefined;
    config = undefined;
    sessionModel = undefined;
    registry = undefined;
    warnedUnreachable = false;
  });
}
