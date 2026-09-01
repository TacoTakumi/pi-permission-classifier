# Changelog

All notable changes to pi-permission-classifier are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-08-31

### Added

- `contextBudgetBytes` config field: a positive integer capping the
  extracted full-command context in UTF-8 bytes, default `8192`. It
  merges like every other field (project overrides global). An ask whose
  context exceeds the budget defers before any model call; context is
  never truncated to fit.

### Changed

- The default rubric grounds allow in the whole visible command: when a
  full command is shown the judge reads all of it and allows only when
  every part is clearly benign. An interpreter body visible in the full
  command (heredoc or stdin) is judged as inline code; an interpreter
  run on a script file stays unseen and defers.

## [0.3.0] - 2026-08-28

### Added

- `/permission-model` command to choose the judge model. With no argument
  it opens pi's own searchable model picker (needs pi 0.84.3 or newer,
  declared as a peer dependency `@earendil-works/pi-coding-agent >=0.84.3`)
  with the current judge preselected; if the registry runtime is missing
  it degrades to a plain `provider/id` list, and with no available models
  it warns instead of opening an empty list. `/permission-model
  <provider>/<id>` sets the judge by reference (unknown pairs are rejected,
  missing auth is accepted with a warning), and `/permission-model session`
  makes the session's active model judge again. Outside the TUI the
  no-argument form prints the current judge and the usage line. Tab
  completion offers the available `provider/id` labels plus `session`.
- A choice is written to the global config file: only `provider` and
  `model` are rewritten, every other field is preserved, and the write goes
  through an fsynced temp file and rename. A symlinked config target and
  its file mode are kept. The command never creates the file and refuses to
  write when the global file is absent or the merged config is invalid. A
  project config that sets `provider` or `model` still lets the global
  write happen but the command warns that the project file shadows it.
- `--permission-model <provider>/<id>` launch flag: a session-only judge
  override that takes precedence over the config and the session model,
  writes nothing, and is dropped at session shutdown.
- Footer status entry `zz-permission-classifier` showing the effective
  judge: `judge:<provider>/<id>`, `judge:session`, or
  `judge:<provider>/<id> (unresolved)`. It follows `/permission-model`
  changes and `/model` switches and is cleared at session shutdown.
- README: a local judge model example and a Config suggestions section for
  pairing the judge with the permission-system policy.

### Changed

- Shipped rubric: an interpreter running code the judge cannot read (a
  bare `python3`, `bash /tmp/x.sh`) now defers instead of being allowed
  blind; inline `-e`/`-c` code is still judged on its content. A plain
  `git stash` is no longer read as a discard.
- Choosing a judge never calls pi.setModel or changes the default model:
  `/model` and `/permission-model` are independent.

### Fixed

- An aborted judge call (deadline hit) is reported as `timeout` and counted
  by the circuit breaker. Previously pi-ai resolved with the partial
  message on abort, so the trail logged `no-tool-call` and the breaker never
  counted it.
- A judge write that leaves the merged config invalid keeps the previous
  config live and reports the issue with the global path.
## [0.2.0] - 2026-08-22

### Changed

- BREAKING: requires `@gotgenes/pi-permission-system` 27.0.0 or newer,
  declared as a peer dependency (`>=27.0.0`). No 26.x compatibility.
- Registration moved to a single site: the `permissions:ready` handler
  resolves the service with the session-keyed `getPermissionsService(sessionId)`
  using the sessionId from the ready payload. The dual-path `session_start`
  registration attempt and the legacy root-service fallback are removed;
  the classifier never resolves the process root's permission service.

### Added

- Warn-once per session when the ready payload carries no sessionId or the
  keyed locator has no service (pi-permission-system 27.0.0 or later must be
  loaded in the same session); the classifier then registers nothing. The
  warn latch resets at `session_shutdown`.
- README known-issues section: a stray late ready carrying a previous
  session's id would register on that session's still-published service
  (inherent to the 27.0.0 contract).

### Fixed

- The forced tool choice is now spelled per judge-model API dialect:
  "required" for OpenAI-family APIs, "any" elsewhere. Previously the
  Anthropic spelling "any" was sent to every provider, so OpenAI-compatible
  judges (local llama.cpp, OpenRouter) rejected each review call with a 400
  and every ask fail-safed to defer.

## [0.1.0] - 2026-08-21

### Added

- Initial release.
- `classifier` Authorizer chain link for `@gotgenes/pi-permission-system`:
  a judge model reviews each permission ask on the configured surfaces and
  returns allow, deny (with a teaching reason), or defer.
- Fail-safe by construction: missing config, unresolved model, auth failure,
  timeout, unparseable reply, and any internal error all resolve to defer.
- Balanced default rubric with a hard never-allow list (secret/credential
  access, exfiltration, pipe-to-shell installs, force push, discarding
  uncommitted work, disarming safety guards, permission-system or classifier
  config/log edits); a config `instructions` string replaces it verbatim.
- Config via global and project scopes: `provider`/`model` judge override
  (session's active model by default, following mid-session model switches),
  `surfaces` (default: bash, mcp, skill, tool, read, write, edit), and
  `timeoutMs` (default 5000).
- Forced `report_verdict` tool call, so no free-text parsing; the judged
  value and executed unit are delimited as data in the prompt, and tool
  results and file contents never reach the judge.
- Circuit breaker: 3 consecutive model-call failures or timeouts open a
  60 second cooldown during which asks defer instantly.
- One `classifier.decision` review-log entry per reviewed ask (request id,
  surface, value, model id, latency, verdict, defer reason); raw model
  replies only on the debug log.
- Session-scoped registration, ordering-robust across `session_start` and
  `permissions:ready`, disposed on shutdown.
