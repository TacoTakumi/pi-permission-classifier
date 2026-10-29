# Next actions 2026-10-08: the secret-read gap

Written at the end of the 2026-10-07 session. Carries on from
`docs/next-actions-2026-10-07.md` (Kev quick judge eval, uncommitted work); that
list is still live.

## What was found

Live test in this repo. I asked the agent to read `test-secrets.key` (5 bytes,
content `test`). The read ran with no dialog and no verdict.

The ask never reached the classifier. It was allowed by the policy table.

### Evidence

- `~/.pi/agent/extensions/pi-permission-system/logs/pi-permission-system-permission-review.jsonl`:
  `grep -c "test-secrets"` returns 1, and that line is my own `grep` command
  logged as a bash `session_approved` ask. The read itself has no row.
- Same file, `pi-permission-system-debug.jsonl`: 0 hits.
- Reads appear in the review log only as `decidedBy.kind: "infrastructure_read"`,
  646 rows, all skill files under `~/.pi`. A read of a project file is never
  logged, so reads are unauditable today.

### Root cause

Two facts in the permission system, both verified in
`~/AI/Projects/pi-env/gh/pi-packages/packages/pi-permission-system`:

1. The authorizer chain runs only on an ask. `composeAuthorizerChain` is
   composed inside `escalate()` (`src/authority/authorizer-selection.ts:258`),
   which `src/handlers/gates/runner.ts:204` calls only from the
   `promptForApproval` arm of `applyPermissionGate`. A gate that resolves to
   `allow` returns at the rule with `decidedBy: {kind: "rule"}` and no link is
   consulted. This is by design, not a bug.
2. `read` resolves to `allow` for this path. The global config
   `~/.pi/agent/extensions/pi-permission-system/config.json` has `"read":
   "allow"`, and the `path` surface table has `"*": "allow"`. `read` is a
   path-bearing built-in tool, so the `path` table applies to its path argument
   (`src/policy/permission-manager.ts:439`, `classifyToolKind` -> `"path"`).
   The secret rules in that table are `*.env`, `*.env.*`, `*.pem`,
   `*/.aws/credentials*`, `*/.git-credentials`, `*/.gnupg/*`, `*/.npmrc`,
   `*/.ssh/*`, `*/auth.json`, `*/id_ed25519`, `*/id_rsa`, `*/id_rsa.*` (deny)
   and `*/credentials.json`, `*secrets.json` (ask). None matches
   `test-secrets.key`: the suffix is `.key`, and `*secrets.json` needs the
   literal `secrets.json` tail.

So the judge is not at fault. Its rubric item 1 ("Secret or credential access:
reading or copying private keys...") covers this file; it was simply never
asked. The gap is in the pattern table in front of it.

## Do in this order

1. Add the missing secret suffixes to the `path` table in
   `~/.pi/agent/extensions/pi-permission-system/config.json`. Backup first in
   the existing convention (`config.json.bak-20261008-secret-suffixes`).
   Suggested rules, deny so the ask cost is zero:

       "*.key": "deny",
       "*.key.pem": "deny",
       "*.p12": "deny",
       "*.pfx": "deny",
       "*.keystore": "deny",
       "*.jks": "deny",
       "*secrets.key": "deny",
       "*id_*": "deny",
       "*token*": "ask"

   Caveat on the last two: `*id_*` and `*token*` collide with ordinary project
   file names (`user_id.txt`, `token_bucket.py`). Check the repo names you
   actually keep before adding them, or narrow to the basename forms
   `id_rsa`, `id_ed25519`, `*.token`.

2. Re-run the probe after the edit, in this repo, on `test-secrets.key`. Expect
   a deny with `decidedBy.kind: "rule"` in the review log. Then probe a path
   that asks, and confirm a row appears with
   `decidedBy: {kind: "authorizer", name: "permission-judge"}` so you know the
   chain is live on the `path` surface, not only on bash.

3. Decide the audit question: reads of project files leave no trail. Two
   options, pick one.
   - Keep `"read": "allow"` and rely on the `path` deny list as a blocklist.
     Cheap, no dialogs, and a new secret file name is unguarded until you add
     its suffix.
   - Add `"*": "ask"`-style ask rules for the secret families on the `path`
     surface so the judge reviews them. This is the allowlist direction: the
     judge rubric already covers private keys, and in `quick-then-llm` mode the
     quick judge answers first. Cost: a classify call per matched read.

4. If you take option 2 of step 3, add a guard case to
   `eval/hazard-cases.json` for a `.key` read and re-run
   `EVAL_S1_MODEL=local-classifiers/kev-4b-q8 npm run eval:quick`. The Kev
   quick judge has three fixed questions; whether it flags a `.key` read is
   untested. Log the run in `eval/RESULTS.md`.

5. Remove the probe artifact `test-secrets.key` from the repo root, or add it
   to `.gitignore` if you want it around for repeat probes. It is untracked
   now.

6. Side observation from the same session, worth one look: the bash command
   `L=$(ls -t ~/.pi/agent/extensions/pi-permission-system/logs/* | head -3)`
   was denied with reason "The permission reviewer denied this action because it
   could not be confirmed safe." A plain `ls` of the same directory was
   `session_approved` on the `external_directory` surface. The command
   substitution form is what tripped it. If bash asks are getting noisy, this is
   a rubric wording case for the read-only allow list.

## Ship bar for this fix

The probe command reads the file and the log. It passes when the read is denied
by a rule, and a matching review-log row exists. Nothing in `src/` changes for
this: the gap is operator config, in a file the classifier's own rubric item 7
puts off limits to the agent. You apply the edit.

## State of the repo at handoff

- Project `judged-ask-store`: execute phase, complete, 14/14 tasks.
  Review round 3 was changes-requested (2026-10-06, `893bd54`); status reports
  every item settled. Next: start the next project.
- Uncommitted from 2026-10-07, unchanged: `CLAUDE.md`, `README.md`,
  `eval/run.eval.ts` modified; `docs/ideas.md`, `docs/research.md`,
  `eval/zz-replay.eval.ts` untracked. See the 2026-10-07 file, item 5, for
  what they are and the CHANGELOG entry they need.
- Global judge config: mode `quick-then-llm`, quickJudge
  `local-classifiers/kev-4b-q8`, verdicts `allow-deny`, onError `deny`,
  timeoutMs 25000.
