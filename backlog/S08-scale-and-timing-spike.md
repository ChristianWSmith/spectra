# S08 — Spike: library scale and clean timing

**Type:** spike (measurement, gate G8)
**Source:** `source/PERF.md` (caveats, not verified); `source/PRUNE.md` (research items 9, 10)

## Goal
Re-measure the key numbers at a realistic library size, with the sweep
disabled for import timing, so that every later story has trustworthy
baselines.

## Work
- Import timing: golden demo with no concurrent sweep (the 19.1 s figure may
  include contention).
- Scale: repeat the row-level, alive-count and round-table checks on a library
  of 50 or more matches.
- Full sweep time at that scale.

## Acceptance
- Baseline table: import time, sweep time, row counts, and the rule checks
  from S02 and S10 at scale.
- A statement of which earlier numbers changed.

## Unblocks
G8: S12 (async flush timing), S14 (parallel sweep baseline), S10 (alive rule at scale).

## Not covered
**Knowledge horizon.** This needs a library of 50+ matches. The working
snapshot has 7, and the golden directory has 7 demos. Without more demos this
spike cannot complete; the sprint should either acquire data or record the gap.
