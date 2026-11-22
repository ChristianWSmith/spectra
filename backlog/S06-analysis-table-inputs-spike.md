# S06 — Spike: audit analysis-table inputs

**Type:** spike (research)
**Source:** `source/PRUNE.md` (research item 8, blast radius)

## Goal
Replace the upper-bound blast radius (105 of 147 metrics) with an exact
dependency map. For each analysis table, list its real inputs.

## Tables
`player_stats`, `player_round_stats`, `round_classifications`,
`round_side_classes`, `kill_tags`, `match_trade_opps`.

## Work
- For each table, trace the Go writer (`analytics.Compute`, `store/analytics.go`)
  and list which tables and columns it reads.
- Build a dependency graph from table to table, and table to metric.
- Confirm against the stored `metrics.touched` sets.

## Acceptance
- A dependency graph with one node per table and an explicit input list.
- A corrected blast-radius count for S16 and S17.

## Unblocks
Accurate scoping of S16 and S17.

## Not covered
Writers that read `player_ticks` through unexpected paths may be missed by
reading code alone. S03 can confirm this empirically.
