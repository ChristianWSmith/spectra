# S02 — Spike: reconcile tick rows with round tables

**Type:** spike (research, gate G2)
**Source:** `source/PRUNE.md` (research items 2, 3); `source/PERF.md`

## Goal
Explain the two unexplained mismatches between `player_ticks` and the round
tables, which gate S09, S10 and S16.

## Background
- 9,244 tick rows have no matching `round_player_sides` row.
- 20 of 1,522 `round_player_money.money_start` values differ from the first
  tick row's money.
- **Presence gaps.** In match 4, round 23, one player has no tick rows after
  tick 136,597 while the round continues. This affects as-of results (322 of 324
  alive-count cells match; the two that don't are this gap). Presence gaps may
  be the same class as the 9,244 unmatched rows.

## Work
- Classify the 9,244 unmatched rows: bots, uncounted rounds, roster gaps,
  steam-ID scrubbing, or other.
- Classify the 20 money mismatches: sample timing, freeze-end ordering, or sink.
- Measure presence gaps across the snapshot: how many players have rows that
  stop before the round ends, and why (disconnect, takeover, parse gap).
  Feed the result into S21.

## Acceptance
- Each unmatched row class has a stated cause and a count.
- A decision on whether `round_player_sides` is safe as the side source for
  the rewrites in S09 and S10.

## Unblocks
S09, S10 (correctness of the side and roster sources), S16 (round-table
decision).

## Not covered
Snapshot only. If the cause is a parse-time bug, the fix is a separate story
and may change stored data for existing libraries.
