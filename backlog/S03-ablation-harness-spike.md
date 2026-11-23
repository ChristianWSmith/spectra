# S03 — Spike: ablation harness

**Type:** spike (tooling, gate G3)
**Source:** `source/PRUNE.md` (research item 5)

## Goal
Build a repeatable scratch harness that removes or nulls columns (or swaps a
source table), runs the full sweep, and diffs `metric_values` against
baseline. Every schema-changing story uses it.

## Work
- Scratch copy of the library DB; baseline sweep recorded.
- Variant runner: null a column, or redirect a read, then re-sweep.
- Diff tool: per metric, per subject and dim, flag changed values and NULL
  changes.
- Document how to use it in `backlog/`, not in the repo.

## Acceptance
- Harness reproduces baseline with zero diff on an unmodified copy.
- Harness detects an injected change (control test).
- Runs against the 7-match snapshot in under 10 minutes (sweep runs ~14 s in
  Go, so this should be well within budget).

## Unblocks
G3: any column drop (S15, S20) and validation of the rewrites S09, S10, S17.

## Not covered
Scale is limited to the snapshot until S08 provides a larger library.

## Result (2026-11-23): PARTIAL, acceptance not met

Built: `src/internal/ablation` (dump, diff per metric/subject/dim, JSON dump files) and an opt-in
test `TestAblation` (set `ABLATION_SNAPSHOT`, `ABLATION_OUT`, `ABLATION_NAME`; variants via
`ABLATION_SQL`; `ABLATION_BASELINE` and `ABLATION_EXPECT` for the diff). `go vet` passes; the
default test run skips it. The snapshot schema matches `schema.sql`.

Not met:
- Full baseline sweep did not finish after about 970 s. It was stuck in `dmg_no_kill` (id 59), a
  correlated subquery over `events` and `player_ticks` on the 9.8M-row tick table. This is a
  performance problem in that metric, not in the harness. The "about 14 s sweep" figure does not hold
  for this metric on this snapshot. S09 rewrites this metric; its query plan needs looking at first.
- No zero-diff baseline reproduction and no control-variant run, so the diff tool is unverified against
  real data.

Next: profile `dmg_no_kill`, then rerun acceptance 1 and 2.
