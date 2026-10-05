import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createClassifierExtension } from "./extension";

/**
 * Entry point: register the permission judge as a pi-permission-system
 * Authorizer chain link named `"permission-judge"`.
 */
export default function piPermissionClassifier(pi: ExtensionAPI): void {
  createClassifierExtension(pi);
}
