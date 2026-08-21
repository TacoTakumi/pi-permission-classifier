import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createClassifierExtension } from "./extension";

/**
 * Entry point: register the auto-classifier as a pi-permission-system
 * Authorizer chain link named `"classifier"`.
 */
export default function piPermissionClassifier(pi: ExtensionAPI): void {
  createClassifierExtension(pi);
}
