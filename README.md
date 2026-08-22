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
   `~/.pi/agent`, or absolute):

       "packages": [
         "../../pi-permission-classifier"
       ]

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
   for a version with a dedicated judge model.

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

Set `instructions` to replace the rubric wholesale with your own.

### Choosing surfaces

Including `read`/`write`/`edit` lets the model auto-allow file access
inside the working tree when the per-tool rule falls to `ask`. Your
cross-cutting `path` and `external_directory` rules still apply, and the
engine downgrades any link allow on those two surfaces to defer, so the
classifier can never approve access outside the working directory or to a
path your policy denies. Remove the three file tools from `surfaces` for a
more conservative posture.

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
    npx vitest run      # 97 tests

The `@gotgenes/pi-permission-system` dev dependency is a `file:` reference
to a local checkout of the permission system source, so types track the
current API rather than a published copy. Adjust the path in `package.json`
to wherever your checkout of `gotgenes/pi-packages` lives.

## License

MIT
