/**
 * Layered config loader: global then project `config.json`, project overriding
 * global, validated once against the zod source of truth.
 *
 * Fail-safe by construction: a malformed file is skipped with a recorded issue
 * (never fatal), and an invalid merged config yields `{ config: undefined }` so
 * the extension registers no link — a config error degrades to no
 * auto-decision, never to a wrong one (more prompting, never less).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CLASSIFIER_EXTENSION_ID,
  type ClassifierConfig,
  classifierConfigSchema,
} from "./config-schema";

const CONFIG_FILE_NAME = "config.json";

/** A validation or read problem, tied to the file(s) that produced it. */
export interface ConfigIssue {
  path: string;
  message: string;
  sourcePath?: string;
}

/** Outcome of a config load: a validated config (or `undefined`) plus issues. */
export interface LoadConfigResult {
  config: ClassifierConfig | undefined;
  issues: ConfigIssue[];
}

/** Global scope: `<agentDir>/extensions/<id>/config.json`. */
export function getGlobalConfigPath(agentDir: string): string {
  return join(
    agentDir,
    "extensions",
    CLASSIFIER_EXTENSION_ID,
    CONFIG_FILE_NAME,
  );
}

/** Project scope: `<cwd>/.pi/extensions/<id>/config.json`. */
export function getProjectConfigPath(cwd: string): string {
  return join(
    cwd,
    ".pi",
    "extensions",
    CLASSIFIER_EXTENSION_ID,
    CONFIG_FILE_NAME,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read and JSON-parse a layer. Returns `undefined` when the file is absent;
 * records an issue and returns `undefined` when it is present but malformed.
 */
function readLayer(
  path: string,
  issues: ConfigIssue[],
): Record<string, unknown> | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!isRecord(parsed)) {
      issues.push({
        path: "$",
        message: "Expected a JSON object.",
        sourcePath: path,
      });
      return undefined;
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push({
      path: "$",
      message: `Failed to read config: ${message}`,
      sourcePath: path,
    });
    return undefined;
  }
}

/**
 * Load the merged, validated classifier config from the global and project
 * scopes.
 *
 * Both scopes are supplied by the caller: the extension resolves `agentDir`
 * from the SDK's `getAgentDir()` (which honors `PI_CODING_AGENT_DIR`) and `cwd`
 * from the session context, so this module reads no process globals of its own.
 *
 * When neither file exists, returns `{ config: undefined, issues: [] }` — the
 * normal not-configured state, reported without noise. When a present config is
 * invalid, returns `{ config: undefined }` with the validation issues, each
 * naming the layer file(s) that fed the merge.
 */
export function loadClassifierConfig(options: {
  cwd: string;
  agentDir: string;
}): LoadConfigResult {
  const { cwd, agentDir } = options;
  const issues: ConfigIssue[] = [];

  const globalPath = getGlobalConfigPath(agentDir);
  const projectPath = getProjectConfigPath(cwd);
  const global = readLayer(globalPath, issues);
  const project = readLayer(projectPath, issues);

  if (global === undefined && project === undefined) {
    return { config: undefined, issues };
  }

  // Shallow merge: project scalars and arrays replace global wholesale.
  const merged = { ...(global ?? {}), ...(project ?? {}) };

  const parsed = classifierConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const sourcePath = [
      ...(global === undefined ? [] : [globalPath]),
      ...(project === undefined ? [] : [projectPath]),
    ].join(", ");
    for (const issue of parsed.error.issues) {
      issues.push({
        path: issue.path.join(".") || "$",
        message: issue.message,
        sourcePath,
      });
    }
    return { config: undefined, issues };
  }

  return { config: parsed.data, issues };
}
