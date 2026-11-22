# S14 — Parallel unit execution in the sweep

**Type:** build
**Depends on:** S03 (harness), S08 (baseline)
**Source:** `source/PERF.md` (layer 2, option 1)

## Goal
Run stale metric units in parallel in Go, respecting the single writer and
per-metric ordering.

## Background
Full sweep of 147 metrics: 14.2 s on the snapshot, sequential over 16 cores.
Round-scoped units are 74% of raw time. A Python thread test went from 2.2 s
(1 worker) to 0.7 s (4 workers). That test is a proxy only.

## Work
- Parallel reads through the read-only metric connection; serialised writes
  per unit.
- Keep the dependency order: an upstream metric's rows commit before dependents.
- Keep cancellation semantics: per-metric cancel, sweep cancel, and absent →
  behind on interruption.

## Acceptance
- S03 harness shows zero value diff.
- Measured speedup on the S08 baseline.
- Cancellation tests still pass.

## Not covered
The driver is modernc (about 2.7× slower than C SQLite). A cgo driver is a
separate, large dependency decision and is not part of this story.
