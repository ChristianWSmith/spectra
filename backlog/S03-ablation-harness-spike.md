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
