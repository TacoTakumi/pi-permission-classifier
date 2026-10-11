# Next actions after 2026-10-07 (local quick judge, Kev)

Written at the end of the 2026-10-07 session. Wiki page with the full
state: projects/pi-local-classifiers-and-the-kev-quick-judge-state-of-play-2026-10-07.

## Do in this order

1. Set Kev to 4 slots in ~/AI/Engines/models-llamacpp-swap.yaml, entry
   kev-4b-q8: add `--parallel 4 --ctx-size 32768` (replace `--ctx-size
   16384`). llama-swap watches the config, no restart needed. With one slot
   a three-question ask re-reads the state per question (2.55 s on a
   2,300-token state); with four slots it is 0.91 s.

2. Run the small eval (about 100 requests, 2 to 4 minutes after step 1):

       cd ~/AI/Projects/pi-permission-classifier
       EVAL_S1_MODEL=local-classifiers/kev-4b-q8 EVAL_CANDIDATES=shipped \
         EVAL_SAFE_LIMIT=30 EVAL_INTENT=0 EVAL_CONCURRENCY=1 npm run eval:quick

   Report: drafts/eval/report-local-classifiers-kev-4b-q8.md. Jev's files
   are untouched. If you must stop it, kill the vitest worker too, not only
   the parent (pgrep -af 'vitest run --config vitest.eval' shows both).

3. Log the hazard numbers in eval/RESULTS.md (every eval run is logged
   there). Ship bar: no hazard case allowed at the built-in thresholds, nor
   with every threshold 0.1 lower. For a fair read against Jev, run the same
   command once more without EVAL_S1_MODEL and compare the two reports.

4. If Kev passes: in ~/.pi/agent/extensions/pi-permission-classifier/config.json
   set `"quickJudge": { "provider": "local-classifiers", "model": "kev-4b-q8" }`
   and restart pi. Footer shows `quick:local-classifiers/kev-4b-q8`; a
   trailing "(unresolved)" means pi-local-classifiers did not load.

5. Commit the uncommitted work (nothing was committed on 2026-10-07):
   - ~/AI/Projects/pi-local-classifiers: whole repo, first commit.
   - pi-permission-classifier: eval/run.eval.ts (EVAL_S1_MODEL,
     EVAL_S1_BASE_URL, EVAL_SAFE_LIMIT, EVAL_INTENT), CLAUDE.md, README.md.
     Typecheck and all 995 tests pass. Needs a CHANGELOG entry (eval knobs
     are user-visible per the project rules).

6. Rewrite and submit the two llama-swap PRs (decisions capability; router
   props and source preset). Drafts by the engines session:
   ~/AI/Engines/Doc/llama-swap-decisions-pr-drafts-2026-10-07.md. The
   CONTRIBUTING file forbids AI-written PR text, so rewrite by hand.

7. When a pi release carries PR 10382 (merged 2026-10-06, not in 1.0.4):
   `/login llama.cpp` with http://127.0.0.1:8080, check that
   `llama.cpp/kev-4b-q8` is listed as a classifier while unloaded, then
   switch quickJudge provider to `llama.cpp` and uninstall
   pi-local-classifiers. Expect every llama-swap entry (49) to appear in
   /model as a preset once the built-in provider is configured.

## Already applied on 2026-10-07 (no action)

- Global judge config timeoutMs 15000 -> 25000 (gemini-3.8-flash timed out
  four times on 2026-10-06; p90 was 9.2 s).
- pi-permission-system external_directory: `"/": "deny"` after the `"*":
  "ask"` catch-all, so `df -h /` and `find /` are denied, not asked.
  Backup: config.json.bak-20261007-root-deny. /vol2 was already allowed.
- pi-local-classifiers installed in ~/.pi/agent/settings.json packages.
- /opt llama.cpp build 11474, llama-swap v262-5 with the decisions and
  router-props patches (engines session).
