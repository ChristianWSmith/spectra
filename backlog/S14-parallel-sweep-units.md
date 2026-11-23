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

## Result (2026-11-23)

- Built: each metric's stale units run on a bounded worker pool (unitWorkers, default GOMAXPROCS). Each unit's SQL reads through the read-only pool, and its write stays one transaction on the writer. Metrics still run one at a time in dependency order. The first unit error stops new launches. The cancellation checks keep their original order.
- Acceptance, values: the parallel sweep on the live library matches the sequential baseline on all 32,431 metric_values rows, zero differences (ablation harness, ABLATION_WORKERS=1 vs default).
- Acceptance, cancellation: internal/metrics and internal/ablation tests pass.
- Speedup measurement: cancelled at the owner's direction. Observed as noticeably faster; not measured.
- Known nondeterminism: when two units fail at once, the recorded failure message may come from either. The metric still fails.
