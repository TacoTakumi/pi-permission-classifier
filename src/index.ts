import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  Authorizer,
  AuthorizerVerdict,
} from "@gotgenes/pi-permission-system";

export type { Authorizer, AuthorizerVerdict };

export default function piPermissionClassifier(_pi: ExtensionAPI): void {
  // Scaffold stub: the real wiring (createClassifierExtension) lands in T-08.
}
