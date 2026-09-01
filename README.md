# pi-permission-classifier

An auto-classifier for the [pi coding agent](https://pi.dev/)'s
permission system. It registers an Authorizer chain link named `classifier`
with [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system):
a light model reviews each permission
`ask` and returns allow, deny, or defer, so clearly benign requests are
approved automatically, clearly bad ones are rejected with a short teaching
reason, and only genuinely uncertain ones reach you.

Think of it as a Claude-Code-style auto-approve mode, without giving up the
permission gate: your deterministic policy still runs first, and the
classifier only sees the asks that policy would have sent to you anyway.

Fail-safe by construction: a missing config, an unresolved model, an auth
failure, a timeout, an unparseable reply, or any internal error resolves to
defer. More prompting, never less.

## Requirements

- pi with `@gotgenes/pi-permission-system` 27.0.0 or newer installed and
  active in the same session (the classifier resolves the permission service
  through the session-keyed locator introduced in 27.0.0; with an older
  version it warns once and registers nothing)
- pi 0.84.3 or newer for the searchable `/permission-model` picker, declared
  as the `@earendil-works/pi-coding-agent >=0.84.3` peer dependency: the
  selector component that picker mounts changed constructor shape in 0.84.3,
  so on an older pi the command errors before the picker mounts - nothing is
  written, the judge keeps reviewing, and the typed and `session` forms still
  work. Everything else needs only the permission-system floor above.
- Node 22 or newer
- No build step: pi loads `src/index.ts` directly

## Setup / quickstart

Everything below is an operator action - the package never enables itself,
and installing it grants it no authority until you name it in the chain.

1. Get the package and install its dependencies:

       git clone <this repo> ~/pi-permission-classifier
       cd ~/pi-permission-classifier
       npm install

2. Register the package with pi. In `~/.pi/agent/settings.json`, add the
   package directory to the `packages` list (path relative to
   `~/.pi/agent`, or absolute). List `pi-permission-classifier` before
   `pi-permission-system` in `packages`:

       "packages": [
         "../../pi-permission-classifier",
         "<path to pi-permission-system>"
       ]

   Order matters: pi runs `session_start` handlers in package order, and
   `pi-permission-system` emits its `permissions:ready` event from its own
   `session_start`. With the classifier listed first, the link and the
   `zz-permission-classifier` footer entry are in place at startup. Listed
   after it, the classifier misses that first ready event and registers
   at the next one, so the link and the footer entry appear only after the
   first agent turn (asks are still reviewed, since they happen inside
   agent turns).

3. Activate the chain link. In
   `~/.pi/agent/extensions/pi-permission-system/config.json`, add:

       "authorizerChain": ["classifier"]

   Only links named here are consulted; config order fixes the chain order.

4. Create the classifier config. Without it the link registers nothing
   (a safe no-op). The defaults are a good starting point:

       mkdir -p ~/.pi/agent/extensions/pi-permission-classifier
       echo '{}' > ~/.pi/agent/extensions/pi-permission-classifier/config.json

   `{}` means: judge with the session's active model, review the default
   surfaces, 5000 ms timeout, built-in rubric. See `config/config.example.json`
   for a version with a dedicated judge model, or pick one later from
   inside pi with `/permission-model` (see "Choosing the judge model").

5. Try it. Start a new pi session and trigger something your policy sends
   to `ask` (for example a bash command not on your allowlist). A benign
   command should now be approved automatically; a command matching the
   never-allow list should be rejected with a reason; anything uncertain
   still prompts you.

6. Watch the decisions. Every reviewed ask writes one `classifier.decision`
   entry to the permission review log:

       ~/.pi/agent/extensions/pi-permission-system/logs/pi-permission-system-permission-review.jsonl

   Each entry records request id, surface, value, model id, latency,
   verdict, and defer reason. Enable `debugLog` in the permission system
   config to also capture raw model replies and short-circuit traces.

To disable, remove `classifier` from `authorizerChain` (or remove the
package entry). The previous prompting behavior returns immediately.

## Configuration

Config files (project overrides global, shallow merge):

- Global: `~/.pi/agent/extensions/pi-permission-classifier/config.json`
- Project: `<cwd>/.pi/extensions/pi-permission-classifier/config.json`

| Field | Default | Meaning |
| --- | --- | --- |
| `provider` | unset | Judge model provider. Set together with `model`; with neither set, the session's active model judges. |
| `model` | unset | Judge model id, resolved from the session model registry. Set together with `provider`. |
| `instructions` | built-in rubric | System prompt for the judge. Replaces the default rubric verbatim when set. |
| `surfaces` | `bash, mcp, skill, tool, read, write, edit` | The reviewed surfaces. A configured array replaces the default. `path` and `external_directory` are never reviewed. |
| `timeoutMs` | `5000` | Per-review model call budget in milliseconds (positive integer). |
| `contextBudgetBytes` | `8192` | Cap on the extracted full-command context in UTF-8 bytes (positive integer). An ask whose context exceeds the budget defers before any model call; context is never truncated to fit. |

A malformed or invalid config file means the link registers nothing and pi
logs a warning - the gate falls back to normal prompting.

### Example: a local judge model

A small local model makes a good judge: verdicts stay on your machine, cost
nothing, and return fast. Register the model in pi's `models.json` under a
local OpenAI-compatible provider (llama.cpp, llama-swap, Ollama, vLLM):

```json
{
  "providers": {
    "llama-cpp-local": {
      "baseUrl": "http://localhost:8080/v1",
      "api": "openai-completions",
      "apiKey": "no-key",
      "models": [
        {
          "id": "gemma-judge",
          "name": "Gemma 4 E4B (judge)",
          "reasoning": false,
          "contextWindow": 16384,
          "maxTokens": 4096,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

Then point the classifier at it:

```json
{
  "provider": "llama-cpp-local",
  "model": "gemma-judge"
}
```

The model must support tool calling: the classifier forces a
`report_verdict` tool call and treats a reply without one as defer. Verify
with a quick curl (`"tool_choice": "required"`) that your server returns
`finish_reason: "tool_calls"`. Keep the model resident if you can - a cold
load on the first ask can eat the `timeoutMs` budget.

### The default rubric

Balanced and defer-first: allow clearly benign, intent-aligned asks; deny
only the hard never-allow list; defer anything uncertain. The never-allow
list covers secret/credential access, exfiltration, pipe-to-shell installs,
force push, discarding uncommitted work, disarming safety guards, and edits
to the permission system's or the classifier's own config and logs.

Two refinements come from field use. Scripts the judge cannot see always
defer: the gate hands the judge the executed command, not a heredoc body or
a script file, so a bare `python3`, `python3 - <<'EOF'`, or `bash
/tmp/run.sh` reaches the judge as an opaque interpreter call. Inline code
(`node -e`, `python3 -c`) is visible and judged on its content. And a plain
`git stash` (no `drop` or `clear`) is not treated as discarding work.

Set `instructions` to replace the rubric wholesale with your own.

### Config suggestions

The judge decides only what the pi-permission-system policy sends to
`ask`. A few policy choices, learned from the review log, keep the judge
useful and cheap:

- Allow the commands you run all day with static rules instead of a judge
  call each time: `npm run *`, `npm test*`, `npx vitest*`, `npx tsc*`. In
  one logged day the judge allowed these 30-plus times at 2-5 s each. Do
  not allow `npx *` broadly; it downloads and runs packages.
- Remember that `*` crosses `/` in bash patterns. `rm -rf /*` denies every
  absolute-path `rm -rf`, including `/tmp/scratch`; write the exact
  `rm -rf /` instead and let the judge see the rest. The same applies to
  `rm -rf ~/*`.
- Send `find *-exec*` to `ask` rather than `deny`. The judge receives the
  executed unit (`cat {}`) and allows read-only uses.
- Turn reasoning off on a local judge (llama-server `--reasoning-budget 0`,
  or `"enable_thinking": false` in the chat template kwargs). A thinking
  block of 250 tokens costs 2-5 s on a small GPU and hits the 5000 ms
  budget on long asks; without it a verdict returns in under 1 s with the
  same verdicts on the same asks.
- Read the decision trail. The permission system's review log
  (`logs/pi-permission-system-permission-review.jsonl`) records one
  `classifier.decision` entry per reviewed ask with the verdict, defer
  reason, and latency. A run of `defer` with reason `timeout` means the
  model, not the rubric, needs attention.

### Choosing surfaces

Including `read`/`write`/`edit` lets the model auto-allow file access
inside the working tree when the per-tool rule falls to `ask`. Your
cross-cutting `path` and `external_directory` rules still apply, and the
engine downgrades any link allow on those two surfaces to defer, so the
classifier can never approve access outside the working directory or to a
path your policy denies. Remove the three file tools from `surfaces` for a
more conservative posture.

## Choosing the judge model

The judge is the model that reviews each ask. With no `provider` and
`model` in the config it is the session's active model. Three ways to
change it:

### The /permission-model command

- `/permission-model` with no argument opens pi's own searchable model
  picker (the same list as `/model`, scoped models included) with the
  current judge preselected. Pick a model to make it the judge; cancel to
  change nothing. Outside the TUI (rpc, json, print modes) the command
  prints the current judge and the usage line instead. The searchable picker
  needs pi 0.84.3 or newer (`@earendil-works/pi-coding-agent >=0.84.3`): its
  constructor changed in 0.84.3, so on an older pi the command errors before
  the picker mounts, writes nothing, and leaves the judge on its previous
  rule - loud and safe, not a silent fallback. If your pi version does not
  expose the registry runtime the picker needs, the command warns that the
  picker degraded and offers a plain list of `provider/id` labels.
- `/permission-model <provider>/<id>` sets the judge by reference. The pair
  must be in pi's model registry: an unknown pair is rejected and nothing
  changes. A known model without configured auth is accepted with a
  warning, and asks defer until the auth exists. Tab completion offers the
  `provider/id` labels of the available models plus `session`.
- `/permission-model session` removes `provider` and `model` so the
  session's active model judges again.

A choice applies to the next reviewed ask immediately and is saved to the
global config file
(`~/.pi/agent/extensions/pi-permission-classifier/config.json`): only
`provider` and `model` are rewritten, every other field is preserved, and
the write goes through a temporary file that is fsynced and then renamed, so
neither a process crash nor an OS crash leaves a truncated config. The command
never creates the file. Every write form refuses - nothing is written, and the
setup hint names the global path - when the global config file is absent or
there is no valid merged config, which means no config file was found this
session or the files found failed validation. The precondition is the config,
not registration: with a valid config and a link that never registers
(`pi-permission-system` absent or older than 27.0.0) a write still succeeds,
and the new judge applies as soon as the link does register.
When the project config sets `provider` or `model`, the global write still
happens but the command warns that the project file shadows the choice in
that project.

Choosing a judge never changes pi's session model or your default model:
`/model` and `/permission-model` are independent.

### The --permission-model launch flag

`pi --permission-model <provider>/<id>` makes that model the judge for the
session only. It takes precedence over the config and the session model,
nothing is written, and it is dropped at session shutdown. The flag is read
again at every session start in that pi process, so after `/reload` or a new
session in the same process it applies again. A reference the registry does
not know is ignored with a warning and the configured judge applies. An
explicit `/permission-model` choice during the session replaces the flag for
the rest of that session.

### The status bar entry

Once the link registers, the footer shows the effective judge under the
key `zz-permission-classifier`, in one of three states (pi sorts extension
statuses by key on one footer line; the `zz-` prefix keeps the judge entry
last, at the end of that line):

- `judge:<provider>/<id>` - a configured or flag-set judge
- `judge:session` - the session's active model judges
- `judge:<provider>/<id> (unresolved)` - the configured pair is not in the
  registry, so every ask defers until it resolves

The entry follows `/permission-model` changes and `/model` switches and is
cleared at session shutdown. No entry means the link did not register.

## How it works

- The classifier only sees asks your policy routed to `ask`, and only on
  the configured surfaces. Anything else is untouched.
- For each reviewed ask it renders the structured ask facts (surface, tool
  names, the decision value, matched pattern, executed unit, requester
  provenance) into a prompt. Tool results and file contents never reach
  the judge, and the judged value is delimited as data, not instructions.
- The judge model must answer through a forced `report_verdict` tool call
  (allow / deny / defer), so there is no free-text parsing to get wrong.
  The call is aborted after `timeoutMs`.
- The verdict returns to the engine uncapped; the engine's own
  bounded-delegation checkpoint enforces the `path` / `external_directory`
  line.
- A circuit breaker opens after 3 consecutive model-call failures or
  timeouts; asks then defer instantly for a 60 second cooldown, so a down
  model never stalls your session.
- In-process subagents are handled correctly: registration is
  session-scoped, so the link always serves the session that raised the ask.

## Known issues

- The classifier trusts the sessionId on the `permissions:ready` payload. A
  stray late ready that carries a previous session's id after a new
  `session_start` would register the link on the old session's
  still-published service. This is inherent to the pi-permission-system
  27.0.0 contract and the reference implementation has the same property.

## Development

    npm install
    npx tsc --noEmit    # typecheck
    npx vitest run      # 200 tests

The `@gotgenes/pi-permission-system` dev dependency is a `file:` reference
to a local checkout of the permission system source, so types track the
current API rather than a published copy. Adjust the path in `package.json`
to wherever your checkout of `gotgenes/pi-packages` lives.

## License

MIT
