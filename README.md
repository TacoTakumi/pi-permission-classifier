# pi-permission-classifier

An auto-classifier Authorizer chain link for `@gotgenes/pi-permission-system`,
giving pi a Claude-Code-style mode: a light model reviews each permission
`ask` and returns allow / deny / defer, so benign requests are handled
automatically and only uncertain ones reach the human.

Status: bootstrap only. No extension code written yet.

## Read first

- HANDOFF.md - the complete handoff: problem, decisions, references, design,
  and the exact paths to the existing permission system.

## What to do next

Run `specflo new` in this directory, then drive the brainstorm phase from
HANDOFF.md.

## Reference source

The permission system (loaded from source) and the reference Authorizer link
(model-judge) both live under:

    /home/rob/AI/Projects/pi-env/gh/pi-packages/packages/

See HANDOFF.md section 5 and 6 for the full inventory.
