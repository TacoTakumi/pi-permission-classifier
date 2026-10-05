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

A second, optional link named `system-one` asks a System One decision model
(TypeSafe's Jev by default) three fixed questions about each ask and maps the
answer probabilities to a verdict in about 200 ms. Put it in front of the
`classifier` link to settle the clear cases fast and pass the rest on, or run
it alone. See "The system-one link".

Fail-safe by construction: a missing config, an unresolved model, an auth
failure, a timeout, an unparseable reply, or any internal error never
allows. A failure defers unless the link's `onError` is `deny`, which turns
it into a deny that tells the agent to retry later or take another route.

## Requirements

- pi with `@gotgenes/pi-permission-system` 27.0.0 or newer installed and
  active in the same session (the classifier resolves the permission service
  through the session-keyed locator introduced in 27.0.0; with an older
  version it warns once and registers nothing)
- pi 1.0.0 or newer, declared as the
  `@earendil-works/pi-coding-agent >=1.0.0` peer dependency. The searchable
  `/permission-model` picker needs pi 0.84.3 or newer: the selector component
  that picker mounts changed constructor shape in 0.84.3, so on an older pi
  the command errors before the picker mounts - nothing is written, the judge
  keeps reviewing, and the typed and `session` forms still work.
- Node 22 or newer
- No build step: pi loads `src/index.ts` directly

## Setup / quickstart

Everything below is an operator action - the package never enables itself,
and installing it grants it no authority until you name it in the chain.

1. Install the package from npm:

       pi install npm:pi-permission-classifier

   pi installs it under `~/.pi/agent/npm/` and adds
   `npm:pi-permission-classifier` to the `packages` list in
   `~/.pi/agent/settings.json`.

2. Check the package order. `pi install` adds the new entry at the end of
   `packages`, so it can land after `pi-permission-system`. Edit
   `~/.pi/agent/settings.json` if needed. List `pi-permission-classifier` before
   `pi-permission-system` in `packages`:

       "packages": [
         "npm:pi-permission-classifier",
         "npm:@gotgenes/pi-permission-system"
       ]

   Order matters: pi runs `session_start` handlers in package order, and
   `pi-permission-system` emits its `permissions:ready` event from its own
   `session_start`. With the classifier listed first, the link and the
   `zz-permission-classifier` footer entry are in place at startup. Listed
   after it, the classifier misses that first ready event and registers
   at the next one, so the link and the footer entry appear only after the
   first agent turn (asks are still reviewed, since they happen inside
   agent turns).

   To run from a local checkout instead, clone the repository, run
   `npm install` in it, and put its directory in `packages` (path relative
   to `~/.pi/agent`, or absolute), in the same position.

3. Activate the chain link. In
   `~/.pi/agent/extensions/pi-permission-system/config.json`, add:

       "authorizerChain": ["classifier"]

   Only links named here are consulted; config order fixes the chain order.

4. Create the classifier config. Without it the link registers nothing
   (a safe no-op). The defaults are a good starting point:

       mkdir -p ~/.pi/agent/extensions/pi-permission-classifier
       echo '{}' > ~/.pi/agent/extensions/pi-permission-classifier/config.json

   `{}` means: judge with the session's active model, judge every surface
   except `path` and `external_directory`, 5000 ms timeout, built-in
   rubric. See `config/config.example.json`
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

   Each entry records the link (`classifier` or `system-one`), request id,
   surface, value, model id, latency, verdict, defer reason, and three
   context fields: `contextIncluded`
   (true only when a full command was rendered to the judge),
   `contextBytes` (its UTF-8 byte length, null when absent), and
   `contextHash` (first 12 hex chars of its sha256, null when absent).
   The full-command text itself is never logged. An over-budget context
   defers with reason `context-over-budget` before any model call.
   Enable `debugLog` in the permission system config to also capture raw
   model replies and short-circuit traces.

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
| `surfaces` | ignored | Accepted so older config files still parse, but ignored: every surface outside the `path` and `external_directory` families is judged. A file that sets it logs one warning at load: `This field is ignored: every surface outside the path and external_directory families is judged.` |
| `timeoutMs` | `5000` | Per-review model call budget in milliseconds (positive integer). |
| `contextBudgetBytes` | `8192` | Cap on the extracted full-command context in UTF-8 bytes (positive integer), for both links. An over-budget ask is never sent to a model and counts as uncertain: it defers, or denies under `verdicts: "allow-deny"`. Context is never truncated to fit. |
| `classifierEnabled` | `true` | `false` stops the `classifier` link registering, for a setup where `system-one` judges alone. |
| `verdicts` | `"allow-deny-defer"` | Which verdicts the `classifier` link may return. See "Verdicts and onError". |
| `onError` | `"defer"` | What the `classifier` link returns on a failure: `"defer"` or `"deny"`. Never allow. |
| `systemOne` | unset | Settings for the `system-one` link. Its presence registers the link. See "The system-one link". |

The top-level fields are the `classifier` link's settings, so a config file
written before the `system-one` link existed still parses and behaves as
before.

A malformed or invalid config file means the link registers nothing and pi
logs a warning - the gate falls back to normal prompting.

### Verdicts and onError

Each link enforces its own `verdicts` and `onError` in code, after the
model answered:

| `verdicts` | Model allow | Model deny | Uncertain (model defer, answer below thresholds, over budget) |
| --- | --- | --- | --- |
| `allow-deny-defer` | allow | deny | defer |
| `allow-defer` | allow | defer | defer |
| `allow-deny` | allow | deny | deny: "The permission reviewer denied this action because it could not be confirmed safe." |

`onError` applies to every failure: `timeout`, `call-failed` (an error
reply or a thrown call), `breaker-open`, `model-unresolved`, `auth-failed`,
`guidance-load-failed` and `internal-error`. `"defer"` passes the ask on.
`"deny"` denies with a fixed reason that names the failure and ends with
"Retry later or take another route." It never says the action is unsafe,
because nothing judged it. No failure ever allows.

A front link in a cascade should use `allow-defer` with `onError: "defer"`,
so everything it is not sure about reaches the next link. A link that judges
alone in an unattended session can use `allow-deny` with `onError: "deny"`,
so it never waits for a human.

When `allow-defer` withholds a model deny, the decision entry records
verdict `defer` with defer reason `deny-capped`.

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
defer: a bare `python3` or `bash /tmp/run.sh` reaches the judge as an
opaque interpreter call. Inline code (`node -e`, `python3 -c`) is visible
and judged on its content. And a plain `git stash` (no `drop` or `clear`)
is not treated as discarding work.

When the ask carries the enclosing full command (a gated unit inside a
larger command line), the judge reads all of it and allows only when every
part is clearly benign. An interpreter body visible in the full command -
a heredoc body or text piped to stdin - counts as inline code and is
judged on its content; an interpreter run on a script file stays unseen
and defers.

Two more lines cover the asks that guidance files most often need to
raise. Network fetches: downloading from any host, localhost included, is
allow when the fetched bytes are only written to files inside the project
tree or /tmp and nothing executes them; a fetch that feeds a shell or
interpreter is the pipe-to-shell never-allow item, and any other
destination or use defers. Cleanup deletes: a plain `rm` of named files or
build output inside the project tree or /tmp is cleanup, not discarding
work; a delete that reaches outside those places, removes tracked changes,
or uses paths the judge cannot resolve defers.

The rubric adds one line on guidance files (next section): they
describe what is normal for this operator and project, can move a verdict
toward allow or deny within the rubric, and never override the never-allow
list.

Set `instructions` to replace the rubric wholesale with your own.

### Guidance files

The judge reads the same context files the agent does: the global
`AGENTS.md` (or `CLAUDE.md` fallback) in the pi agent dir, and the project
files pi finds from the session cwd up through its ancestors (override
names and worktree shadowing included, because the classifier calls pi's
own context-file loader). Write the lines that describe what is normal
here, for example "downloads into ./vendor and cleanup of build/ are
routine in this repo", and the judge sees them verbatim.

- Files are read from disk on every judged ask. An edit takes effect on
  the next ask; there is no cache and no reload command.
- Trust gating: the global file always reaches the judge. Project files
  reach it only while pi reports the project trusted, read at the moment
  of each ask. In an untrusted directory the judge sees the global file
  alone, and the classifier's own project config layer
  (`.pi/extensions/pi-permission-classifier/config.json`) is not read
  either, so a project `instructions` string cannot replace the rubric
  before you trust the directory.
- Caps: a file over 16 KiB (UTF-8 bytes) is dropped whole, never
  truncated. Files accumulate in loader order (global first, then root
  down to cwd), and once the running total would pass 32 KiB that file and
  every later one are dropped whole.
- Rendering: each included file appears in its own delimited data block
  after the ask facts, labelled `Operator guidance from <path>` for the
  global file or `Project guidance from <path>` for a project file, under
  a one-sentence header on what guidance may and may not do. Guidance is
  data to the judge, not instructions. The header and the rubric tell the
  judge the seven never-allow items are outside its reach, but that is a
  prompt instruction, not code: a trusted project's file can still steer
  a model-based verdict, so review what you trust. The engine's own
  `path` and `external_directory` caps hold regardless.
- Logging: every `classifier.decision` entry carries `guidanceIncluded`
  (one `{path, bytes, hash12}` per rendered file) and `guidanceDropped`
  (one `{path, bytes, reason}` per excluded file, reason one of
  `over-file-cap`, `over-total-cap`, `untrusted`). File content is never
  logged.
- Failure: if the loader throws, the ask defers with reason
  `guidance-load-failed`, recorded on the decision entry and shown in the
  footer health suffix like any other failure defer.

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

### Which surfaces are judged

The classifier judges every surface except the `path` and
`external_directory` families, whatever the surface name, including
surfaces added by other extensions. A family is the bare name plus its
`<name>_*` members, today `path`, `path_read`, `path_write`,
`external_directory`, `external_directory_read`, and
`external_directory_write`. There is no surface list to maintain. Your
cross-cutting `path` and `external_directory` rules still apply, and the
engine downgrades any link allow on those families to defer, so the
classifier can never approve access outside the working directory or to a
path your policy denies. To keep a tool out of the judge's hands, route it
to `allow` or `deny` in the permission system policy instead of `ask`.

## The system-one link

The `system-one` link sends each ask to a classifier model through pi's
model registry (`findOfType("classifier", ...)` and `classify`) and asks
three fixed questions:

- `reversible` (yes/no): can every effect be undone with ordinary tools?
- `contained` (yes/no): does the action act only on the project tree (the
  cwd) or /tmp, read no secret, and send no data off this machine?
- `hazard` (one of eight): none, credential access, exfiltration, remote
  code execution, force push, discard uncommitted work, disarm guards, other
  destructive.

The answer allows when P(reversible), P(contained) and P(hazard = none) all
reach `allowThreshold`. It denies when one hazard other than none reaches
`denyThreshold`, with a reason that names the hazard ("it looks like a force
push"). A deny wins when both match. Anything else is uncertain and maps
through `verdicts`. The question text is fixed in code.

The model sees the gated value, the surface, the tool name, the cwd, the full
command when it fits `contextBudgetBytes`, and the selected guidance files
when `guidance` is on. It never sees tool results, file contents, evidence,
annotations or the tool-input preview. The `path` and `external_directory`
families and an undeterminable surface defer with no model call, whatever
`verdicts` and `onError` say.

### systemOne settings

| Field | Default | Meaning |
| --- | --- | --- |
| `provider` | unset | Classifier model provider, for example `typesafe`. Set together with `model`. |
| `model` | unset | Classifier model id, for example `jev-latest`. An unset or unknown pair never falls back to the session model: every ask takes `onError` with reason `model-unresolved`. |
| `verdicts` | `"allow-defer"` | See "Verdicts and onError". Forced to `allow-defer` while the `classifier` link is enabled. |
| `onError` | `"defer"` | See "Verdicts and onError". Forced to `defer` while the `classifier` link is enabled. |
| `allowThreshold` | `0.9` | Probability (0 to 1) that reversible, contained and hazard none must each reach to allow. |
| `denyThreshold` | `0.9` | Probability (0 to 1) one hazard must reach to deny. |
| `guidance` | `true` | Send the selected guidance files, chosen by the same rules as for the classifier link. |
| `timeoutMs` | `5000` | Per-call budget in milliseconds, enforced with an abort signal. |

The link has its own circuit breaker (3 failures open it for 60 seconds) and
its own health record, so a System One outage never opens the classifier
link's breaker.

### A cascade: system-one in front of classifier

    { "systemOne": { "provider": "typesafe", "model": "jev-latest" } }

and in `~/.pi/agent/extensions/pi-permission-system/config.json`:

    "authorizerChain": ["system-one", "classifier"]

While the `classifier` link is enabled, `system-one` always runs with
`verdicts: "allow-defer"` and `onError: "defer"`, whatever its config says:
it may allow, and everything else goes on to the classifier. When the config
asks for more, pi logs one warning per session that names the override.

### system-one alone

    {
      "classifierEnabled": false,
      "systemOne": {
        "provider": "typesafe",
        "model": "jev-latest",
        "verdicts": "allow-deny",
        "onError": "deny"
      }
    }

with `"authorizerChain": ["system-one"]`. Here the configured `verdicts`
and `onError` apply, so no ask waits for a human.

### The TypeSafe API key

Jev needs `TYPESAFE_API_KEY` in the pi process. Any of these works:

- [pi-dotenv](https://github.com/TacoTakumi/pi-dotenv): put
  `TYPESAFE_API_KEY=...` in `~/.pi/agent/.env` and list pi-dotenv in
  `packages`.
- Export it in the shell that starts pi: `export TYPESAFE_API_KEY=...`.
- Store it in pi's `~/.pi/agent/auth.json` under the provider id:
  `"typesafe": { "type": "api_key", "key": "..." }`. A stored key wins over
  the environment variable.

Without a key, Jev resolves but every call fails, and asks take `onError`
with reason `call-failed`.

### Data sent to a hosted provider

With a hosted classifier such as `typesafe/jev-latest`, every judged ask
leaves your machine: the gated value, the full command (within
`contextBudgetBytes`), the surface, the tool name, the cwd path, and, with
`guidance` on, the full text of the selected guidance files. Set
`"guidance": false` to keep your guidance files local. Use a local model if
none of this may leave the machine.

### Local classifier models

pi 1.0.3 cannot declare a classifier model in `models.json`: it reads every
`models.json` entry as a chat model and ignores `"type": "classifier"`, so
`findOfType` never finds it and the link defers with `model-unresolved`. A
local System One model, such as Kev 4B behind llama-swap's
`/upstream/<model>/v1/systemone`, works only when an extension registers it
with `pi.registerProvider`, a `classifiers` entry for the
`typesafe-system-one` api, and `"type": "classifier"` on the model. This
package does not do that yet.

### Choosing the system-one model

- `/permission-model system-one <provider>/<id>` checks the pair with the
  classifier lookup only (a chat model is rejected), writes it to
  `systemOne.provider` and `systemOne.model` in the global config, and
  applies it on the next ask. An unknown pair writes nothing. When the
  config had no `systemOne` object before, the link registers at the next
  session start. The classifier judge, its launch flag and your session and
  default models are not touched.
- `/permission-model system-one` with no pair opens a list of the available
  classifier models, the current one first. Cancel to change nothing.
  Outside the TUI it prints the current system-one model and the usage line.
- Tab completion after `system-one ` offers the classifier model labels.

### Decision entries

Each `system-one` decision writes one `classifier.decision` entry with
`link: "system-one"`, the same fields as the classifier link, and, when the
model answered, `answers`: the reversible and contained probabilities and
the full hazard probability map. A below-threshold answer records defer
reason `model-verdict`.

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
  needs pi 0.84.3 or newer: its constructor changed in 0.84.3, so on an
  older pi the command errors before the picker mounts, writes nothing, and
  leaves the judge on its previous rule - loud and safe, not a silent fallback. If your pi version does not
  expose the registry runtime the picker needs, the command warns that the
  picker degraded and offers a plain list of `provider/id` labels.
- `/permission-model <provider>/<id>` sets the judge by reference. The pair
  must be in pi's model registry: an unknown pair is rejected and nothing
  changes. A known model without configured auth is accepted with a
  warning, and asks defer until the auth exists. Tab completion offers the
  `provider/id` labels of the available models plus `session` and
  `system-one`.
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

With the `system-one` link registered, its judge comes first, as
`s1:<provider>/<id>` (with ` (unresolved)` when the classifier lookup fails,
or `s1:unset (unresolved)` when `systemOne` names no pair), followed by a
comma and the classifier judge. Each judge carries its own health suffix,
for example `s1:typesafe/jev-latest | timeout x2, judge:session`. A link
that is not registered is left out, so with `classifierEnabled: false` the
entry shows only the `s1:` part.

The entry follows `/permission-model` changes and `/model` switches and is
cleared at session shutdown. No entry means the link did not register.

The judge text carries a health suffix once something went wrong this
session. It refreshes after every decision, so the footer is the quickest
read on how often the dialog fell back and why:

- no suffix - no failure defers yet and the breaker is closed
- ` | <reason> x<N>` - the last decision was a failure defer with that
  reason (`timeout`, `call-failed`, `context-over-budget`, `breaker-open`,
  `model-unresolved`, `auth-failed`, `no-tool-call`,
  `unrecognized-verdict`, `internal-error`); N is the session's failure
  defer count
- ` | defers x<N>` - a later model verdict cleared the reason; the count
  stays for the session
- ` | breaker open <S>s` - the circuit breaker is cooling down, S is the
  remaining whole seconds, counted down once per second; this state wins
  over the others while it lasts

Model verdicts are not health events: an allow clears the pending reason,
a deny changes nothing, and neither shows in the footer. The judge's own
defer verdict counts as a model verdict. Everything resets at session
shutdown.

## How it works

- The classifier only sees asks your policy routed to `ask`, on every
  surface except the `path` and `external_directory` families. Anything
  else is untouched.
- For each reviewed ask it renders the structured ask facts (surface, tool
  names, the decision value, matched pattern, executed unit, requester
  provenance) into a prompt, followed by the guidance files selected for
  this ask. Tool results and file contents never reach the judge, and the
  judged value and the guidance are delimited as data, not instructions.
- The judge model must answer through a forced `report_verdict` tool call
  (allow / deny / defer), so there is no free-text parsing to get wrong.
  The call is aborted after `timeoutMs`.
- The link's `verdicts` and `onError` settings apply to the verdict and to
  every failure; nothing else changes it. The engine's own
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
