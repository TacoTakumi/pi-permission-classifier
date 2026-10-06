# pi-permission-classifier

A permission judge for the [pi coding agent](https://pi.dev/)'s
permission system. It registers an Authorizer chain link named
`permission-judge` with [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system):
a model reviews each permission `ask` and returns allow, deny, or defer, so
clearly benign requests are approved automatically, clearly bad ones are
rejected with a short teaching reason, and only genuinely uncertain ones
reach you.

Think of it as a Claude-Code-style auto-approve mode, without giving up the
permission gate: your deterministic policy still runs first, and the judge
only sees the asks that policy would have sent to you anyway.

Two judges can review an ask, and the `mode` setting picks who does:

- `llm` (the default): the LLM judge. A chat model reads the ask and
  reasons about it.
- `quick`: the quick judge. A System One decision model, such as TypeSafe's
  Jev, answers three fixed questions about the ask in about 200 ms, and
  the answer probabilities map to a verdict.
- `quick-then-llm`: the quick judge settles the clear cases, and the LLM
  judge reviews everything the quick judge does not allow.

You choose the mode, both models and the last judge's `verdicts` and
`onError` with `/permission-model`, inside pi.

Fail-safe by construction: a missing config, an unresolved model, an auth
failure, a timeout, an unparseable reply, or any internal error never
allows. A failure defers unless the judge's `onError` is `deny`, which turns
it into a deny that tells the agent to retry later or take another route.

## Requirements

- pi with `@gotgenes/pi-permission-system` 27.0.0 or newer installed and
  active in the same session (the judge resolves the permission service
  through the session-keyed locator introduced in 27.0.0; with an older
  version it warns once and registers nothing)
- pi 1.0.0 or newer, declared as the
  `@earendil-works/pi-coding-agent >=1.0.0` peer dependency
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
   `session_start`. With the judge listed first, the link and the
   `zz-permission-classifier` footer entry are in place at startup. Listed
   after it, the judge misses that first ready event and registers
   at the next one, so the link and the footer entry appear only after the
   first agent turn (asks are still reviewed, since they happen inside
   agent turns).

   To run from a local checkout instead, clone the repository, run
   `npm install` in it, and put its directory in `packages` (path relative
   to `~/.pi/agent`, or absolute), in the same position.

3. Activate the chain link. In
   `~/.pi/agent/extensions/pi-permission-system/config.json`, add:

       "authorizerChain": ["permission-judge"]

   Only links named here are consulted; config order fixes the chain order.
   This is the only edit to another package's config you ever make: the
   mode and the models are chosen inside pi (step 5).

4. Create the judge config. Without it the link registers nothing
   (a safe no-op). The defaults are a good starting point:

       mkdir -p ~/.pi/agent/extensions/pi-permission-classifier
       echo '{}' > ~/.pi/agent/extensions/pi-permission-classifier/config.json

   `{}` means: mode `llm`, judged by the session's chat model, every surface
   except `path` and `external_directory`, 5000 ms timeout, built-in
   rubric. See `config/config.example.json` for a version with a dedicated
   judge model.

5. Choose the judges. Start a new pi session and run `/permission-model`:
   in the menu, set who judges, the model for each judge that mode runs,
   and the last judge's verdicts and on error (see "Choosing the judges").
   Each pick is saved to the config file from step 4 and applies to the
   next ask.

6. Try it. Trigger something your policy sends to `ask` (for example a bash
   command not on your allowlist). A benign command should now be approved
   automatically; a command matching the never-allow list should be
   rejected with a reason; anything uncertain still prompts you.

7. Watch the decisions. Every judge that reviews an ask writes one
   `classifier.decision` entry to the permission review log:

       ~/.pi/agent/extensions/pi-permission-system/logs/pi-permission-system-permission-review.jsonl

   Each entry records the judge (`quick` or `llm`), request id,
   surface, value, model id, latency, verdict, defer reason, and three
   context fields: `contextIncluded`
   (true only when a full command was rendered to the judge),
   `contextBytes` (its UTF-8 byte length, null when absent), and
   `contextHash` (first 12 hex chars of its sha256, null when absent).
   The full-command text itself is never logged. An over-budget context
   defers with reason `context-over-budget` before any model call.
   Enable `debugLog` in the permission system config to also capture raw
   model replies and short-circuit traces.

To disable, remove `permission-judge` from `authorizerChain`, and the old
name `classifier` too if it is listed (or remove the package entry). The
previous prompting behavior returns immediately.

### The old chain name `classifier`

Earlier releases registered the link as `classifier`. For this release the
same judge is also registered under that name, so an existing
`"authorizerChain": ["classifier"]` keeps working. The first ask that
arrives under `classifier` in a session logs one warning that the name is
deprecated and that `authorizerChain` should name `permission-judge`. A
later release removes the old name; a chain that still names it then gets
only pi-permission-system's generic warning for an unregistered link.

With both names in `authorizerChain`, an ask is still judged once: the
second name consulted for a request the judge already reviewed under the
other name defers at once, with no model call and no decision entry. The
judge remembers the last 8 request ids per session for this. The first such
duplicate in a session logs one warning that both names are listed and
`classifier` should be removed.

## Configuration

Config files (project overrides global, shallow merge):

- Global: `~/.pi/agent/extensions/pi-permission-classifier/config.json`
- Project: `<cwd>/.pi/extensions/pi-permission-classifier/config.json`

The merge is shallow: a field the project file sets replaces the global
field whole. A project `quickJudge` object therefore replaces the global
`quickJudge` object completely. A project file that sets only
`"quickJudge": { "allowThreshold": 0.8 }` drops the global quick judge model,
and every quick judge ask is then `model-unresolved`; repeat `provider` and
`model` in the project object.

| Field | Default | Meaning |
| --- | --- | --- |
| `mode` | `"llm"` | Who judges: `"llm"`, `"quick"` or `"quick-then-llm"`. See "Modes". |
| `provider` | unset | LLM judge model provider. Set together with `model`; with neither set, the session's chat model judges. |
| `model` | unset | LLM judge model id, resolved from the session model registry. Set together with `provider`. |
| `instructions` | built-in rubric | System prompt for the LLM judge. Replaces the default rubric verbatim when set. |
| `surfaces` | ignored | Accepted so older config files still parse, but ignored: every surface outside the `path` and `external_directory` families is judged. A file that sets it logs one warning at load: `This field is ignored: every surface outside the path and external_directory families is judged.` |
| `timeoutMs` | `5000` | LLM judge model call budget in milliseconds (positive integer). |
| `contextBudgetBytes` | `8192` | Cap on the extracted full-command context in UTF-8 bytes (positive integer), for both judges. An over-budget ask is never sent to a model and counts as uncertain: it defers, or denies under `verdicts: "allow-deny"`. Context is never truncated to fit. |
| `verdicts` | `"allow-deny-defer"` | Which verdicts the LLM judge may return. See "Verdicts and onError". |
| `onError` | `"defer"` | What the LLM judge returns on a failure: `"defer"` or `"deny"`. Never allow. |
| `quickJudge` | unset | The quick judge settings. See "quickJudge settings". |

The top-level fields are the LLM judge's settings, so a config file written
before the quick judge existed still parses and behaves as before: mode
`llm`, no quick judge.

An unreleased build used the fields `systemOne` and `classifierEnabled`. A
file that still sets one loads, ignores it, and logs one config issue per
field: `systemOne` was renamed to `quickJudge`, and `classifierEnabled` is
replaced by `mode`.

A malformed or invalid config file means the link registers nothing and pi
logs a warning - the gate falls back to normal prompting.

### Verdicts and onError

Each judge enforces its own `verdicts` and `onError` in code, after the
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

A judge that runs alone in an unattended session can use `allow-deny` with
`onError: "deny"`, so it never waits for a human. In mode `quick-then-llm`
the quick judge always runs with `allow-defer` and `onError: "defer"` (see
"Modes").

`/permission-model` sets both fields for the last judge in line, the judge
whose answer ends the ask: the LLM judge (top-level fields) in modes `llm`
and `quick-then-llm`, the quick judge (`quickJudge` fields) in mode
`quick`. See "The /permission-model command".

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

Then point the LLM judge at it:

```json
{
  "provider": "llama-cpp-local",
  "model": "gemma-judge"
}
```

The model must support tool calling: the LLM judge forces a
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
names and worktree shadowing included, because the judge calls pi's
own context-file loader). Write the lines that describe what is normal
here, for example "downloads into ./vendor and cleanup of build/ are
routine in this repo", and the judge sees them verbatim.

- Files are read from disk on every judged ask. An edit takes effect on
  the next ask; there is no cache and no reload command.
- Trust gating: the global file always reaches the judge. Project files
  reach it only while pi reports the project trusted, read at the moment
  of each ask. In an untrusted directory the judge sees the global file
  alone, and the judge's own project config layer
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

The judges review every surface except the `path` and
`external_directory` families, whatever the surface name, including
surfaces added by other extensions. A family is the bare name plus its
`<name>_*` members, today `path`, `path_read`, `path_write`,
`external_directory`, `external_directory_read`, and
`external_directory_write`. There is no surface list to maintain. Your
cross-cutting `path` and `external_directory` rules still apply, and the
engine downgrades any link allow on those families to defer, so the
judge can never approve access outside the working directory or to a
path your policy denies. To keep a tool out of the judge's hands, route it
to `allow` or `deny` in the permission system policy instead of `ask`.

## Modes

The `mode` field picks who judges each ask. It is read on every ask, so a
change from `/permission-model` or a config reload applies to the next ask,
with no new session.

- `llm` (default): only the LLM judge runs, under the top-level `verdicts`
  and `onError`. The quick judge is never called.
- `quick`: only the quick judge runs, under `quickJudge.verdicts` and
  `quickJudge.onError`. The LLM judge is never called.
- `quick-then-llm`: the quick judge runs first, always with
  `verdicts: "allow-defer"` and `onError: "defer"`, whatever `quickJudge`
  says. A quick allow ends the ask. Anything else - a deny, an uncertain
  answer, a failure, an unresolved quick model - goes to the LLM judge,
  which decides under the top-level `verdicts` and `onError`. When
  `quickJudge` asks for other verdicts or onError, pi logs one warning per
  session that names the override.

Each judge has its own circuit breaker (3 failures open it for 60 seconds)
and its own health record, so a quick judge outage never opens the LLM
judge's breaker or changes its footer part, and the reverse.

## The quick judge

The quick judge sends each ask to a classifier model through pi's model
registry (`findOfType("classifier", ...)` and `classify`) and asks three
fixed questions:

- `reversible` (yes/no): can every effect be undone with ordinary tools?
  Output that can be made again (caches, build and test output, logs,
  files the action creates) counts as undoable. Deleting files git does not
  hold, discarding uncommitted work, rewriting history, pushing or
  publishing, and sending a message do not.
- `contained` (yes/no): do the effects stay inside the project: the
  project tree (the cwd), /tmp, and the usual caches, build output, temp
  files and display of the project's own build, run and test tools?
  Reading a secret (keys, tokens, credentials, .env files, the
  environment), sending data off this machine, and changing files
  elsewhere are not contained.
- `hazard` (one of eight): none, credential access, exfiltration, remote
  code execution, force push, discard uncommitted work, disarm guards, other
  destructive.

The answer allows when P(reversible), P(contained) and P(hazard = none)
each reach their allow threshold: 0.8 each, built in, or `allowThreshold`
for all three when you set it. It denies when one hazard other than none reaches
`denyThreshold`, with a reason that names the hazard ("it looks like a force
push"). A deny wins when both match. Anything else is uncertain and maps
through `verdicts`. The question text is fixed in code.

The model sees the gated value, the surface, the tool name, the cwd, the full
command when it fits `contextBudgetBytes`, and the selected guidance files
when `guidance` is on. It never sees tool results, file contents, evidence,
annotations or the tool-input preview. The `path` and `external_directory`
families and an undeterminable surface defer with no model call, whatever
`verdicts` and `onError` say.

### quickJudge settings

| Field | Default | Meaning |
| --- | --- | --- |
| `provider` | unset | Classifier model provider, for example `typesafe`. Set together with `model`. |
| `model` | unset | Classifier model id, for example `jev-latest`. An unset or unknown pair never falls back to the session model: every ask takes `onError` with reason `model-unresolved`. |
| `verdicts` | `"allow-defer"` | See "Verdicts and onError". In mode `quick-then-llm` it is always `allow-defer`. |
| `onError` | `"defer"` | See "Verdicts and onError". In mode `quick-then-llm` it is always `defer`. |
| `allowThreshold` | unset | Probability (0 to 1) that reversible, contained and hazard none must each reach to allow. Unset uses the built-in threshold per question (0.8 each), chosen by the eval (see "Development"). |
| `denyThreshold` | `0.9` | Probability (0 to 1) one hazard must reach to deny. |
| `guidance` | `true` | Send the selected guidance files, chosen by the same rules as for the LLM judge. |
| `timeoutMs` | `5000` | Per-call budget in milliseconds, enforced with an abort signal. |

A config for the quick judge in front of the LLM judge:

    {
      "mode": "quick-then-llm",
      "quickJudge": { "provider": "typesafe", "model": "jev-latest" }
    }

The quick judge alone, never waiting for a human:

    {
      "mode": "quick",
      "quickJudge": {
        "provider": "typesafe",
        "model": "jev-latest",
        "verdicts": "allow-deny",
        "onError": "deny"
      }
    }

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

With a hosted classifier such as `typesafe/jev-latest`, every ask the quick
judge reviews leaves your machine: the gated value, the full command (within
`contextBudgetBytes`), the surface, the tool name, the cwd path, and, with
`guidance` on, the full text of the selected guidance files. Set
`"guidance": false` to keep your guidance files local. Use a local model if
none of this may leave the machine.

### Local classifier models

pi 1.0.3 cannot declare a classifier model in `models.json`: it reads every
`models.json` entry as a chat model and ignores `"type": "classifier"`, so
`findOfType` never finds it and the quick judge defers with
`model-unresolved`. A local System One model, such as Kev 4B behind
llama-swap's `/upstream/<model>/v1/systemone`, works only when an extension
registers it with `pi.registerProvider`, a `classifiers` entry for the
`typesafe-system-one` api, and `"type": "classifier"` on the model. This
package does not do that yet.

### Decision entries

Each judge that reviews an ask writes one `classifier.decision` entry with
`judge` set to `quick` or `llm`. In mode `quick-then-llm` an ask the quick
judge does not allow writes two entries, `quick` then `llm`. Quick entries
carry, when the model answered, `answers`: the reversible and contained
probabilities, and `hazard` as a list of `[option, probability]` pairs for all
eight options, highest first. The pairs keep the option names out of the JSON
keys, because the permission log masks any value whose key looks like a
credential name, which would hide `credential_access`. A below-threshold answer
records defer reason `model-verdict`. A request skipped as a duplicate (see
"The old chain name `classifier`") writes no entry.

## Choosing the judges

Everything is chosen with `/permission-model` and saved to this package's
global config file. You never edit another package's config for it, and
choosing a judge never changes pi's session model or your default model:
`/model` and `/permission-model` are independent.

### The /permission-model command

- `/permission-model` with no argument opens the "Permission judge" menu.
  Each entry shows its current value:

  ```
  Who judges          quick-then-llm
  Quick judge model   typesafe/jev-latest
  LLM judge model     Same as the chat model (follows /model)
  LLM judge verdicts  allow-deny-defer
  LLM judge on error  defer
  ```

  - Who judges lists the modes `quick-then-llm`, `llm`, `quick`, each with
    a one-line description.
  - Quick judge model lists the available classifier models.
  - LLM judge model lists `Same as the chat model (follows /model)` and the
    available chat models.
  - The verdicts entry lists `allow-deny-defer`, `allow-defer` and
    `allow-deny`; the on error entry lists `defer` and `deny`. Both belong
    to the last judge in line, so they read "LLM judge" in `llm` and
    `quick-then-llm` and "Quick judge" in `quick`.

  A model entry whose judge the mode does not run is marked, for example
  `(not used in llm)`, and can still be set. Each list marks the current
  value `(current)` and preselects it. A configured model that is not
  available shows first as `(current, not available)`; picking it changes
  nothing and says so. A pick is saved at once, exactly as the matching
  typed form saves it, and the menu opens again with the new value. If the
  save lands but the merged config no longer validates, the menu closes
  after the error instead. Picking `quick` or `quick-then-llm` while the
  global config file has no quick model opens the quick model list next
  and saves the mode and the model together. Press escape in a list to go
  back to the menu without a change, and escape on the menu to close it.
- Outside the TUI (rpc, json, print modes), `/permission-model` with no
  argument prints the mode, the model of each judge the mode runs, the last
  judge's verdicts and onError, and the usage line, and writes nothing.
- `/permission-model mode <llm|quick|quick-then-llm>` sets the mode. Mode
  `quick` or `quick-then-llm` needs a quick judge model in the global config
  file, where the mode is saved: without one it writes nothing and says to
  set one first. A quick model that only the launch flag or a project config
  sets does not count, because the saved mode would outlive the flag or apply
  in other projects. The menu asks for the quick model in that case.
- `/permission-model llm <provider>/<id>` sets the LLM judge. The pair must
  be a chat model in pi's model registry: an unknown pair or a classifier
  model is rejected and nothing changes. A known model without configured
  auth is accepted with a warning, and asks defer until the auth exists.
- `/permission-model llm chat-model` removes `provider` and `model`, so the
  LLM judge follows the session's chat model (it changes with `/model`).
- `/permission-model quick <provider>/<id>` sets the quick judge. The pair
  must be a classifier model: an unknown pair or a chat model is rejected
  and nothing changes.
- `/permission-model verdicts <allow-deny-defer|allow-defer|allow-deny>`
  and `/permission-model on-error <defer|deny>` set that field for the last
  judge in line of the mode in effect (a `mode:` launch flag value or a
  project config mode counts). The confirmation names the judge. An
  unknown value is rejected and nothing changes.
- Setting a model never changes the mode.
- Tab completion offers `mode`, `llm`, `quick`, `verdicts` and `on-error`,
  then the mode values, `chat-model` and the chat model labels, the
  classifier model labels, or the verdicts and onError values.

A choice applies to the next reviewed ask immediately and is saved to the
global config file
(`~/.pi/agent/extensions/pi-permission-classifier/config.json`): only the
fields the choice sets are rewritten (`mode`, `provider` and `model`,
`quickJudge.provider` and `quickJudge.model`, and `verdicts` and `onError`
at the top level or inside `quickJudge`), every other field is
preserved, and the write goes through a temporary file that is fsynced and
then renamed, so neither a process crash nor an OS crash leaves a truncated
config. The command never creates the file. Every write form refuses -
nothing is written, and the setup hint names the global path - when the
global config file is absent or there is no valid merged config, which
means no config file was found this session or the files found failed
validation. The precondition is the config, not registration: with a valid
config and a link that never registers (`pi-permission-system` absent or
older than 27.0.0) a write still succeeds, and the new choice applies as
soon as the link does register. When the project config sets its own value
for a field the write changed, the global write still happens but the
command warns that the project file shadows the choice in that project.

### The --permission-model launch flag

`pi --permission-model <list>` sets the judges for the session only. The
list is comma-separated, in any subset and order:

- `quick:<provider>/<id>` - the quick judge model
- `llm:<provider>/<id>` - the LLM judge model
- `llm:chat-model` - the LLM judge follows the chat model
- `mode:<llm|quick|quick-then-llm>` - the mode

For example `pi --permission-model quick:typesafe/jev-latest,mode:quick-then-llm`.
The values take precedence over the config, nothing is written, and they
are dropped at session shutdown. The flag is read again at every session
start in that pi process, so after `/reload` or a new session in the same
process it applies again. An unknown model, an unknown prefix or a bad mode
is ignored with a warning, and the rest of the list still applies. A bare
`<provider>/<id>` is not accepted: the warning names the `llm:` form. A
`/permission-model` choice during the session replaces the flag value it
touches, for the rest of that session.

### The status bar entry

Once the link registers, the footer shows the active judges under the key
`zz-permission-classifier` (pi sorts extension statuses by key on one
footer line; the `zz-` prefix keeps the entry last). The entry opens with
the label `perm-judge:`, then a part for each judge the mode runs. In mode
`quick-then-llm` the quick judge comes first and `->` joins the parts in
the order the judges run:

- `quick:<provider>/<id>` - the quick judge model
- `llm:<provider>/<id>` - a configured or flag-set LLM judge
- `llm:chat-model` - the session's chat model judges
- ` (unresolved)` after a part - the pair is not in the registry, so that
  judge's asks are `model-unresolved` until it resolves;
  `quick:unset (unresolved)` means no quick judge model is set

For example `perm-judge: quick:typesafe/jev-latest | timeout x2 -> llm:chat-model`
in mode `quick-then-llm`. The entry follows `/permission-model` changes and `/model`
switches and is cleared at session shutdown. No entry means the link did
not register.

Each part carries its own judge's health suffix once something went wrong
this session. It refreshes after every decision, so the footer is the
quickest read on how often the dialog fell back and why:

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
a deny changes nothing, and neither shows in the footer. A judge's own
defer verdict counts as a model verdict. Everything resets at session
shutdown.

## How it works

- The judges only see asks your policy routed to `ask`, on every
  surface except the `path` and `external_directory` families. Anything
  else is untouched.
- The mode picks which judge runs (see "Modes"). For each ask the LLM
  judge reviews, it renders the structured ask facts (surface, tool
  names, the decision value, matched pattern, executed unit, requester
  provenance) into a prompt, followed by the guidance files selected for
  this ask. Tool results and file contents never reach the judge, and the
  judged value and the guidance are delimited as data, not instructions.
- The judge model must answer through a forced `report_verdict` tool call
  (allow / deny / defer), so there is no free-text parsing to get wrong.
  The call is aborted after `timeoutMs`.
- Each judge's `verdicts` and `onError` settings apply to its verdict and
  to every failure; nothing else changes it. The engine's own
  bounded-delegation checkpoint enforces the `path` / `external_directory`
  line.
- Each judge has a circuit breaker that opens after 3 consecutive
  model-call failures or timeouts; that judge's asks then defer instantly
  for a 60 second cooldown, so a down model never stalls your session.
- In-process subagents are handled correctly: registration is
  session-scoped, so the link always serves the session that raised the ask.

## Known issues

- The extension trusts the sessionId on the `permissions:ready` payload. A
  stray late ready that carries a previous session's id after a new
  `session_start` would register the link on the old session's
  still-published service. This is inherent to the pi-permission-system
  27.0.0 contract and the reference implementation has the same property.

## Development

    npm install
    npx tsc --noEmit    # typecheck
    npx vitest run      # full test suite
    npm run eval:quick  # quick judge eval against TypeSafe Jev

The quick judge eval sends each candidate question set (`eval/candidates.ts`)
to Jev for two sets of asks: the hazard cases in `eval/hazard-cases.json`,
which must never be allowed, and the asks your own permission review log
shows as approved, rebuilt with their full commands from your pi session
files. It writes the corpus, a score cache and `report.md` under
`drafts/eval/`, which git ignores: the corpus is your command history, and
running the eval sends it to TypeSafe. The report gives, per question set,
the safe asks and hazard cases allowed at 0.9, at the built-in thresholds,
and at the best thresholds that allow no hazard even 0.1 lower.
`TYPESAFE_API_KEY` comes from the environment or `~/.pi/agent/.env`.

The `@gotgenes/pi-permission-system` dev dependency is a `file:` reference
to a local checkout of the permission system source, so types track the
current API rather than a published copy. Adjust the path in `package.json`
to wherever your checkout of `gotgenes/pi-packages` lives.

## License

MIT
