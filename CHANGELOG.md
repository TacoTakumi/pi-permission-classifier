# Changelog

All notable changes to pi-permission-classifier are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
