# pi-permission-classifier

An auto-classifier Authorizer chain link for `@gotgenes/pi-permission-system`,
giving pi a Claude-Code-style permission mode: a light model reviews each
permission `ask` and returns allow / deny / defer, so benign requests are
handled automatically and only uncertain ones reach the human.

The link registers as `classifier`. It is fail-safe by construction: a
missing config, an unresolved model, an auth failure, a timeout, an
unparseable reply, or any internal error resolves to `defer` - more
prompting, never less.

## How it works

- On each reviewed ask, the classifier renders the structured ask facts
  (surface, tool names, the decision value, matched pattern, executed unit,
  requester provenance) into a prompt. Tool results and file contents never
  reach the judge, and the judged value is delimited as data, not
  instructions.
- The judge model is forced to call a `report_verdict` tool
  (allow / deny / defer) so no free-text parsing is involved. The call is
  aborted after `timeoutMs`.
- The verdict is returned to the engine uncapped. The engine itself
  downgrades any link `allow` on the `path` and `external_directory`
  surfaces to `defer`; the classifier does not even attempt those surfaces.
- A circuit breaker opens after 3 consecutive model-call failures or
  timeouts: asks then defer instantly for a 60 second cooldown.
- Every reviewed ask writes one `classifier.decision` entry to the
  permission review log (request id, surface, value, model id, latency,
  verdict, defer reason). Raw model replies go only to the debug log.

## Config

Config lives at:

- Global: `~/.pi/agent/extensions/pi-permission-classifier/config.json`
- Project: `<cwd>/.pi/extensions/pi-permission-classifier/config.json`

Project values override global values (shallow merge). A missing config
means the link registers nothing (safe no-op). An empty object `{}` enables
the defaults. See `config/config.example.json`.

Fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `provider` | unset | Judge model provider. Must be set together with `model`; with neither set, the session's active model judges. |
| `model` | unset | Judge model id, resolved from the session model registry. Must be set together with `provider`. |
| `instructions` | built-in rubric | System prompt for the judge. Replaces the default rubric verbatim when set. |
| `surfaces` | `bash, mcp, skill, tool, read, write, edit` | The reviewed surfaces. A configured array replaces the default. `path` and `external_directory` are never reviewed. |
| `timeoutMs` | `5000` | Per-review model call budget in milliseconds (positive integer). |

The default rubric is balanced: allow clearly benign, intent-aligned asks;
deny only the hard never-allow list (secret/credential access, exfiltration,
pipe-to-shell installs, force push, discarding uncommitted work, disarming
safety guards, permission-system or classifier config/log edits); defer
anything uncertain.

Note on `read`/`write`/`edit`: including them lets the model auto-allow
file access inside the working tree when the per-tool rule falls to `ask`.
Cross-cutting `path` and `external_directory` rules still apply, and any
allow that would fire on those surfaces is downgraded by the engine. Remove
the three tools from `surfaces` for a more conservative posture.

## Install (operator actions - you run these yourself)

The package never enables itself. Two steps, both edits the operator makes
by hand:

1. Add the package path to the `packages` list in
   `~/.pi/agent/settings.json`, for example:

       "packages": [
         "../../AI/Projects/pi-permission-classifier"
       ]

2. Name the link in `authorizerChain` in
   `~/.pi/agent/extensions/pi-permission-system/config.json`:

       "authorizerChain": ["classifier"]

Only links named in `authorizerChain` are consulted; registration alone
grants no authority. Removing the name (or the package) restores the
previous prompting behavior.

## Development

No build step: pi loads `src/index.ts` directly (see `pi.extensions` in
`package.json`).

    npm install
    npx tsc --noEmit
    npx vitest run

`@gotgenes/pi-permission-system` resolves via a `file:` reference to the
local source clone (see `package.json`), so the types track the current
26.x API rather than the stale npm copy.

## Read also

- HANDOFF.md - the original handoff: problem, decisions, references, and
  the exact paths to the existing permission system.
- The permission system and the reference link (model-judge) live under
  `/home/rob/AI/Projects/pi-env/gh/pi-packages/packages/`.
