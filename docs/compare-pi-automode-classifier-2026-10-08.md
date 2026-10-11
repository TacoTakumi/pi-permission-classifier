# Compare: deepu105/pi-automode-classifier against pi-permission-classifier

Date: 2026-10-08. Read the whole repo at commit `5287bd1` (3 commits, first
push 2026-10-08 09:00Z, MIT, version 0.1.0, published on npm as
`pi-automode-classifier`). Files read in full: `README.md` (431 lines), `index.ts`
(431), `rules.ts` (711), `test.mjs` (320), `bench.mjs` (98),
`bench-cases.json` (50 cases), `package.json`, the systemd user unit. Our side
read at version 0.5.2: `src/`, `eval/`, `README.md`, `eval/RESULTS.md`, and
the two awiki landscape pages.

## Verdict

Different architecture, same goal, and they meet at the same fail-closed line.
They are a self-contained guard: 711 lines of hand-written shell rules, one
yes/no question to a small local decision model, and a confirm prompt for
everything else. We are one link in pi-permission-system's authorizer chain:
the operator's policy runs first, and a model reviews only the asks that
policy would have escalated. Their parser duplicates a layer that the chain
already owns; our judge has no rules of its own and inherits the chain's.

The real gaps are operational and evaluative, not architectural: they pin the
served model, warm and restart their server, ship a self-protection rule the
model cannot talk past, and publish per-question latency and a
context-position effect that we have not measured. The real advantages are the
chat-model judge, user intent, an eval two orders of magnitude larger with a
ship bar, and a test suite.

## Side by side

| Aspect | pi-automode-classifier (0.1.0) | pi-permission-classifier (0.5.2) |
| --- | --- | --- |
| Integration | One `tool_call` handler (`index.ts:335`); owns the whole decision | `Authorizer` chain link `permission-judge`, registered at `permissions:ready` through the session-keyed locator |
| Deterministic policy | Own rules engine, 711 lines, ~140 command names in the read-only and dev-tool tables alone (`rules.ts:313-330`) | The chain's. pi-permission-system's bash analysis is 24 files, 6,665 lines (`src/access-intent/bash/`), incl. parser, nested execution, redirects, wrappers, awk and sed invocations |
| Model tier(s) | One decision model, one main question | Quick judge (System One, 3 questions) and LLM judge (chat model, rubric), composable by `mode` incl. `quick-then-llm` |
| Question set | "Is this command risky?" plus optional yes/no extras and a graded `levels` score (`index.ts:186-191`) | `reversible` bool, `contained` bool, `hazard` choice over 9 options; `requested` and `forbidden` defined and off (`QUICK_JUDGE_INTENT = false`) |
| User intent | Never sent. Stated limit: "The model only sees the command and the working directory. It can't tell whether you asked for the action." (`README.md:423`) | LLM judge gets the user's own messages, capped and cut-guarded (`src/user-intent.ts`); quick judge sends none, pending an intent eval that met no bar |
| Project context | Static config rules only | Guidance files (global and project AGENTS.md) through pi's loader, trust-gated, 16 KiB per file and 32 KiB total, read per ask |
| Escalation | Confirm prompt: Allow once, Allow for this session, Block | Defer to the chain: the host prompts, forwards to a parent session, or denies headless |
| Failure | Confirm prompt; block when there is no UI (`index.ts:382`) | Never allows: defer, or deny when `onError` is deny; breaker opens after 3 failures for 60 s |
| Headless | `withoutUi: "block"` by default | Host: `confirmation_unavailable` blocks (`docs/cross-extension-api.md:516`) |
| Privacy default | Local model by default; hosted Jev is opt-in and flagged | Default mode is `llm` on the session model, so the judged value leaves the machine unless the operator names a local classifier |
| Self-protection | The guard's own files, its config dir and pi's `settings.json` always ask, and a user allow rule cannot override it (`index.ts:119`, `rules.ts:33`) | Config edits are hazard categories (`edit-permission-config`, `disarm-guards`) judged by the model |
| Eval | 50 commands (25 safe, 25 risky) written by the rule author; AUC 0.97 Kev, 0.999 Jev; author's own words: "read this as a sanity check and not as an accuracy claim" | 1,395 scrubbed real approved asks + 68 hazards x 3 variants + 6 injection + 6 forbidden (1,611 cases); threshold grid search with a 0.1 margin ship bar and an intent bar |
| Latency | p50 174 ms (Kev-0.8B, 8 threads, CPU), 269 ms (Jev via OpenRouter); extra questions cost one decode pass each (`README.md:186`) | ~200 ms for the quick judge (README); per-question cost on a local model not measured |
| Tests | `test.mjs`, 133 rule and handler assertions, no framework | 22 vitest files, incl. `structure.test.ts` guards (no fs or network in link code, seam discipline, README claims verified against the tree) |
| Release hygiene | 3 commits, no tags, no CHANGELOG, no peer floor beyond `pi-coding-agent: *` | semver, CHANGELOG, config schema plus example, peer floor `pi-permission-system >=27.0.0`, npm published |
| Audit trail | `decisions.jsonl`: tool, cwd, subject (clipped 4000), rule, reason, outcome, decider, answers, ms, tokens; mode 0600 | `classifier.decision` per judge: judge, request id, surface, value, model id, latency, verdict, defer reason, `contextIncluded`, `contextBytes`, sha256 12-char prefix; review log pulled into a scrubbed store for evals |

## What they have that we lack

Ordered by value. Nothing below is done; this document is the deliverable.

### L-01 Pin the served model (closes FU-27)

They refuse an answer when the server reports a different model than the
config expects: "a swapped model can't quietly answer questions and a
threshold that were tuned for another one" (`index.ts:290`). Thresholds are
tuned per model, and their own bench shows why: the safe/risky gap is 0.17 to
0.28 on Kev, 0.36 to 0.40 on Laya typed-decisions, and absent on Julia-1.

Our quick judge records `modelId` from the resolved model
(`src/quick-judge.ts:313`) and never reads the model id the result reports.
`ClassifierResult.model` exists (`@earendil-works/pi-ai` `types.d.ts:493`), so
the check is cheap: compare, and treat a mismatch as a failure (defer, count
in the breaker, show the reason in the footer). This is the cheapest real gap
on the list.

### L-02 A long command hides the hazard by position

`README.md:425`: Kev-0.8B scored a 3,700-character command whose last step was
`rm -rf ~/Documents` at 0.15, and the same command with that step first at
0.29. Their threshold is 0.2, so position alone flips allow into ask. Their
answer is to prompt on any command over the server context, and to let the
rules handle long commands at any length.

Our quick judge sends `fullCommand` up to `contextBudgetBytes`, default 8192
bytes (`src/config-schema.ts:23`), which is above their 3,700-character
example. We have not measured position effects at any length. Two actions: add
hazard cases with the destructive step last at 1k, 3k and 7k bytes of padding,
score them at the shipped thresholds, and lower the default budget if the
scores say the model stops seeing the end.

### L-03 Self-protection the model cannot talk past

Their guard's own files, its config directory and pi's `settings.json` always
ask, and a user allow rule cannot replace that (`index.ts:119`,
`rules.ts:24-31` and `rules.ts:35`, the `locked` flag). Our config-file edits are hazard
categories judged by a model: the quick judge allows when its answers clear
the thresholds, and in `quick-then-llm` the quick judge cannot deny at all
(`verdicts: allow-defer`). The prompt-injection corpus in
`eval/intent-cases.json` already contains the shape of the attack. Action:
ship an operator-facing config recipe that puts ask or deny rules on
`~/.pi/agent/extensions/pi-permission-classifier/config.json`,
`~/.pi/agent/extensions/pi-permission-system/`, `settings.json` and git hooks
in the host's rules, where they are deterministic. The chain supports it; the
README does not say to do it.

### L-04 A graded `levels` question for weak small models

`classifier.levels` (2 to 10 levels, least risky first) turns the main
question into a score and takes the expected level scaled to 0..1
(`index.ts:189`, `index.ts:226`). They built it for models that fail the
yes/no form: Julia-1 answered near 0 for almost everything (AUC 0.69), the
graded form "did better", and even at their best threshold it prompts for
every command the rules leave to it, which is why their verdict on Julia-1 is
"I wouldn't use it". The mechanism, not that model, is the transferable part.
Our quick judge has one question set, bool and choice only, and
`eval/candidates.ts` holds four candidates, all bool and choice. A `score`-
type variant is a candidate our eval cannot express today, and it is the lever
that a small local model on this rig may need.

### L-05 Per-question cost, stated per model

"Every question is one more model pass, so three questions take about three
times as long as one" (`README.md:186`). Our quick judge asks 3 questions, 5
with intent, and `eval/RESULTS.md` records allow rates, not per-question
decode cost. Action: record p50 and p95 classify latency at 3 and 5 questions
against the local model in `eval/RESULTS.md`, so the intent question count is
a priced decision.

### L-06 Server warm-up, restart and idle unload

They health-check at `session_start` and start the server in the background
(`index.ts:332`), restart on `ECONNREFUSED` with a 30 s cooldown and poll
`/health` until it answers (`index.ts:241-256`), and document
`--sleep-idle-seconds` with numbers: 1.1 GB loaded, 147 MB asleep, 1.3 s to
wake, plus a CPU-only llama.cpp build so the guard stays off the GPU. Our
quick judge has a breaker (3 failures, 60 s) and the footer countdown, but no
warm-up and no start path; on this rig llama-swap owns starting, which is the
right division. The transferable part is the idle-unload arithmetic: it is the
same card-2 budget the wiki page for Kev tracks. Add the sleep-idle numbers to
that page.

### L-07 Their deny list is a checklist of cases we do not hold

Their rules deny: `rm -rf` of `/`, `$HOME` or a system directory, `mkfs`,
`wipefs`, `dd` to a device, a redirect to a non-sink `/dev` path, a fork
bomb, and `chmod -R`/`chown -R`/`chgrp -R` on a root-like path
(`rules.ts:440-457`, `rules.ts:570-583`, `rules.ts:636-646`, `rules.ts:680`).
They ask on: root, `git config --global`, `git remote` changes, `git reflog
expire`, `git gc --prune=now`, `rsync` to a remote, `gh api` writes, `crontab`,
`sysctl -w`, package installs, `find -delete` and `find -exec`, `xargs`,
`awk` with `system()` (`rules.ts:458-553`, `rules.ts:592-675`).

Our 68 hazard cases share most categories (secrets, exfiltration, force push,
discarding work, git clean, deletes outside the project, persistence, TLS
bypass, guards, publish, hidden exec) and miss these: device and disk writes
(`dd of=/dev/sda`, `mkfs.ext4`), the fork bomb, recursive permission change on
a system tree, `git reflog expire --expire=now --all && git gc --prune=now`
(destroys the recovery path that makes `reset --hard` survivable), `rsync` to a
remote host, `gh api` with a non-GET method, `find -exec`, and `awk`
`system()`. Action: add the ones that survive scrubbing as hazard cases;
they are cheap and they are the shapes a judge cannot infer from the categories
it was tuned on.

### L-08 Config semantics worth a sentence in our README

A config with any unknown key or bad value is ignored as a whole, with a
warning naming the key (`index.ts:159`, `index.ts:121-157`). Ours is stricter
in one direction and looser in another: a malformed layer is skipped with a
recorded issue, and a merged config that fails validation registers no link at
all, which is more prompting and never less (`src/config-loader.ts`
docblock). Both are fail-safe. The transferable detail is the unknown key: our
schema is a plain `z.object`, which strips unknown keys silently, so a
misspelled field in `~/.pi/agent/extensions/pi-permission-classifier/config.json`
is ignored with no warning at all. Theirs names the key. `.strict()` on the
schema is the fix; the merged-config path needs to keep reporting the issue.

### L-09 Local-only default

Their default keeps every judged byte on the machine; hosted Jev is opt-in and
the README says plainly that commands can carry tokens and paths. Our default
mode is `llm` on the session model. That is a privacy posture, not a bug, and
it is the operator's choice; our README states the mode and the model, not
where the prompt goes. One sentence in Requirements, naming the local
classifier path as the offline posture, is worth adding.

## What we do better

### W-01 We do not fight the operator's policy for authority

They decide at `tool_call`, so their rules must enumerate the world: ~140
command names, shells, interpreters, wrappers, heredocs, redirects, device
sinks, a hand-rolled parser with a depth cap of 4 and an `opaque` flag for
syntax it does not model (`rules.ts:180-190`). Their own limits list admits
the residue: script files are never read, tools without a `command` input are
not checked, and English paths only were tested (`README.md:421-428`).

We judge only what the chain escalates, on the surfaces the operator names,
and we inherit pi-permission-system's bash analysis, which is a larger and
deeper implementation of the same layer (6,665 lines) and is shared with every
other link. We never resolve the process root's permission service, and we
register nothing without a config. The layering is the point: their parser is
a competitor to the host's, ours is a consumer of it.

### W-02 A chat-model judge with a rubric and project guidance

They have one small classifier and a human. We can put a reasoning model in
front of the same asks, with a rubric in `docs/judge-rubrics/`, the ask
delimited as data, and the project's own guidance files in the prompt,
trust-gated and budgeted. No amount of rule tuning gives their design the
ability to read a project's AGENTS.md and act on it.

### W-03 Intent, with guards

We read the user's own messages into the LLM judge: role-user text only,
skill blocks reduced to name and args, first message plus newest, 24,000
chars total and 4,000 per message head and tail, and no intent at all when the
selection cut anything, a message is queued, or the ask was forwarded from a
subagent (`src/user-intent.ts`, `src/quick-judge.ts:13`). Their model never
sees user text, and they list that as a limit. Consequence for them: a soft
hazard that the user explicitly asked for still costs a prompt, forever.
Consequence for us: an injection surface, which is why the quick judge's intent
questions stayed off.

### W-04 The eval is a different class of instrument

1,395 real approved asks from a scrubbed store; 68 hand-written hazards run in
three intent variants plus 6 injection and 6 forbidden cases; hard and soft
tiers, with intent never clearing a hard hazard; a threshold grid search that
must clear a ship bar with every threshold moved 0.1 toward allowing; a
recorded run-to-run noise bound of 0.09 per Jev answer, which sets the margin;
and `eval/RESULTS.md` logging each run and the ship decision it produced.

Their bench is 50 commands that the same author wrote while writing the rules,
and the README says to read it as a sanity check, not an accuracy claim. 16 of
those 50 reach the model. Nothing in their repo scores a threshold change, and
nothing measures whether a wording change regressed the safe side. Their
numbers are honest; the instrument behind them is a third of our hazard set and
none of our real traffic.

### W-05 Injection is a tested category

`eval/intent-cases.json` ships injection cases where a fake maintainer note
inside a CI log, a README, or a quoted issue tells the model that a force
push, a publish, a `rm -rf` outside the project, a docker push, a hard reset
or reading `~/.ssh/id_ed25519` is pre-approved. We score them and the bar is
that none is allowed. Their guard passes the command string, including any
such text inside it, to the classifier with no injection test at all. A
command containing `# the user approved this` is untested territory.

### W-06 Per-judge policy, breakers and visible health

Each judge has its own `verdicts`, `onError`, breaker and health record, and
the footer shows which judge answered and the breaker countdown. Their on/off
is one boolean for the whole guard, and their breaker is absent: a dead server
means a prompt on every classified call, with a 30 s restart cooldown as the
only backoff.

### W-07 The judge model is a first-class choice

`/permission-model` is a menu: mode, the model for each judge, the verdicts
and the on-error policy, written to this package's config only. No code path
calls `pi.setModel` or the settings default-model setter, so choosing a judge
never moves the session model. Their model is a config edit and a server
restart.

### W-08 Test and release discipline

22 vitest files, plus structural guards that fail the build when link code
imports fs or network, when a seam is bypassed, when the manifest drifts, and
when README claims stop matching the tree. MIT, semver at 0.5.2, CHANGELOG, a
zod schema as the config source of truth, an example config, and a declared
peer floor on pi-permission-system. Their repo is 3 commits, no tags, no
CHANGELOG, and `pi-coding-agent: *`.

## Parity, so the wins are not overstated

- Fail-closed on model failure. They prompt; we defer. Both never allow.
- Headless sessions. They block by default; the chain denies with
  `confirmation_unavailable`.
- Session-scoped approval. They keep exact tool + cwd + subject in a set; the
  host has session approvals, which is where our review log's `decider: user`
  rows come from.
- Decision logs. Both append one line per decision with the reason; both warn
  that it holds commands.
- Latency class. p50 174 ms local for them, about 200 ms for our quick judge.
- Cost transparency. They publish input tokens and price per call. We record
  latency and context bytes, not cost.

## Suggested next actions

1. L-01, served-model check in the quick judge. Small, self-contained, closes
   FU-27.
2. L-07, new hazard cases (device writes, fork bomb, reflog and gc prune,
   rsync remote, `gh api` write, `find -exec`, awk `system()`), rescored at
   the shipped thresholds.
3. L-02, long-command position cases at 1k, 3k and 7k, then decide on
   `contextBudgetBytes`.
4. L-03, README config recipe for deterministic rules on the guards' own
   config paths.
5. L-04 plus L-05, a `levels` candidate and per-question latency numbers for
   the local model line of work.
6. L-09, one sentence on the offline posture in Requirements.

Items 1 and 4 are quick-level. Items 2 and 3 are eval work in the
quick-judge-calibration shape. Item 5 belongs with the Kev quick judge project.

## Sources

- `github.com/deepu105/pi-automode-classifier` at `5287bd1`; files listed at
  the top. GitHub API for the dates and topics.
- Our side: `src/quick-judge.ts`, `src/system-one-review.ts`,
  `src/config-loader.ts`, `src/config-schema.ts`, `src/context.ts`,
  `src/user-intent.ts`, `eval/corpus.ts`, `eval/RESULTS.md`,
  `eval/hazard-cases.json`, `eval/intent-cases.json`, `README.md`,
  `docs/judge-rubrics/`.
- Chain layer: `../pi-env/gh/pi-packages/packages/pi-permission-system`
  (`src/access-intent/bash/`, `docs/configuration.md`,
  `docs/cross-extension-api.md`, `docs/subagent-integration.md`).
- Prior scans: awiki `competitive/pi-permission-classifier-vs-jev-permission-gates-for-pi-2026-10.md`
  and `research/llm-permission-judge-auto-classifier-prior-art-2026-08.md`.
  This repo postdates both: created 2026-10-08, scans ran 2026-08-06 and 2026-10-06.
