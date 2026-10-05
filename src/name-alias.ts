/**
 * The chain names the judge registers under: `permission-judge`, and for
 * this release the old name `classifier` as a deprecated alias.
 *
 * A link is never told which name the chain consulted, so each name gets
 * its own closure over the one judge callback. The closures share a ring of
 * the last judged request ids: with both names in `authorizerChain`, the
 * second name consulted for an ask already judged under the other one
 * defers at once, with no judge call and no decision entry. The chain only
 * consults the second entry after the first deferred, so the extra defer
 * never changes the outcome; an id that has left the ring is judged again,
 * which costs one model call and never a different verdict.
 *
 * Warnings are once per set of closures, which the extension builds once per
 * session.
 */

import type { Authorizer, AuthorizerVerdict } from "@gotgenes/pi-permission-system";

/** The chain-link name the operator lists in `authorizerChain`. */
export const JUDGE_NAME = "permission-judge";

/** The deprecated chain-link name, registered for one more release. */
export const ALIAS_NAME = "classifier";

/** How many judged request ids the closures remember. */
const RING_SIZE = 8;

export interface NamedAuthorizer {
  name: string;
  authorize: Authorizer["authorize"];
}

export interface NameAliasDeps {
  /** Operator warning sink. */
  warn: (message: string) => void;
}

/** Wrap `judge` into one callback per chain name, `permission-judge` first. */
export function createNamedAuthorizers(
  judge: Authorizer["authorize"],
  deps: NameAliasDeps,
): NamedAuthorizer[] {
  const ring: { requestId: string; name: string }[] = [];
  let next = 0;
  let warnedDeprecated = false;
  let warnedBothNames = false;

  const remember = (requestId: string, name: string): void => {
    ring[next] = { requestId, name };
    next = (next + 1) % RING_SIZE;
  };

  const judgedUnderOther = (requestId: string, name: string): boolean =>
    ring.some((entry) => entry.requestId === requestId && entry.name !== name);

  const named = (name: string): NamedAuthorizer => ({
    name,
    authorize: async (details, query, log): Promise<AuthorizerVerdict> => {
      if (name === ALIAS_NAME && !warnedDeprecated) {
        warnedDeprecated = true;
        deps.warn(
          `the chain-link name ${ALIAS_NAME} is deprecated and will be removed ` +
            `in a later release; name ${JUDGE_NAME} in authorizerChain instead.`,
        );
      }
      if (judgedUnderOther(details.requestId, name)) {
        if (!warnedBothNames) {
          warnedBothNames = true;
          deps.warn(
            `authorizerChain lists both ${JUDGE_NAME} and ${ALIAS_NAME}; each ask ` +
              `is judged once. Remove ${ALIAS_NAME} from authorizerChain.`,
          );
        }
        return { kind: "defer" };
      }
      remember(details.requestId, name);
      return judge(details, query, log);
    },
  });

  return [named(JUDGE_NAME), named(ALIAS_NAME)];
}
