# S17 — Prune tick rows to the moments metrics read

**Type:** build (schema, needs wipe) — **contingent**
**Depends on:** G1 (S01), S09, S10, G3 (S03), G2 (S02), owner decision on round-boundary rows
**Source:** `source/PRUNE.md` (row-level profile, option 4); `source/PERF.md`

## Goal
Reduce tick-row volume to what metrics need. Two candidate policies, which
differ a lot in size:

- **Event-anchored:** keep only rows on kill and damage ticks (about 0.4% of
  rows on the snapshot). Smallest, but loses state changes between events.
- **State-change (dedup):** keep rows where a retained column changes. With
  `round`, `side`, `alive` and `hp` as the retained columns, that is about 0.07%
  of rows on match 4 (867 rows). If `money`, `speed`, `in_air` and `weapon` stay
  in the table, any change to them counts, and the figure is about 44%. Either
  way it retains HP at every change, so it fits the decision that HP stays in
  tier 1.

The state-change policy is the one that keeps `hp` as a real tier-1 fact. It
is the preferred candidate, and this story is written for it unless S21 or the
owner rules otherwise.

## Preconditions
1. S09 and S10 done: damage and alive count no longer use exact-tick joins.
2. **HP stays** in the tick table on every retained row (owner decision).
3. S21 ruled: presence semantics for pruned rows.
4. S03 confirms zero diff (or the recorded, ratified diff) with pruned rows.
5. Owner accepts that the tick table becomes sparse. Positional and motion data
   goes to encounters if built (S18), or stays out of the product, not into tick
   rows.

## Work
- Writer keeps a row when a retained column changes from the player's previous
  row, plus the event-anchored rows the rewritten metrics still read.
- Dead-player rows on kill and damage ticks stay until S09 removes the side
  lookup from the tick table.
- Readers that need the state at a tick use as-of lookups, with the presence
  rule from S21.
- Pin the retained-row policy in tests and the schema note.

## Acceptance
- Zero value diff (S03) on the snapshot and at S08 scale.
- Measured row count and storage change recorded.

## Not covered
Future metrics that need continuous state (speed, in-air, position) would
need a grid. This story does not provide one; encounters or a new fact would.

## Proposal: discard post-round rows (2026-11-21, needs a ruling)

Owner: discard post-win/loss rows, as warmup and knife rows already are.

Measured on the 7-match snapshot:
- Tick rows after their round's `end_tick`: 678,930 of 9,817,283 (6.9%).
- Of those, 17,101 are in each match's final round (the post-match tail).
- Each round has about 450 ticks (7 s) of rows after its end, for all players.

Proposed rule: the tick sink writes a round's rows only up to that round's
`end_tick` (the sink gate that already skips discarded rounds). This removes
the post-round tail from `player_ticks`, and it is what makes the presence
case (S21) look like a leave rather than a gap.

Why it needs a ruling: it changes stored tick rows, so metric values can change
(any read that counts rows after the round end). The migration rule requires
the ratified diff first. Before ruling, the sweep should run on the snapshot
with the rule applied (S03 harness, not yet built) to list the changed cells.

Open question: rows between rounds (after `end_tick`, before the next freeze)
are labeled with the round that just ended. Keep them or discard them? The
rule above discards them.

## Ruling (2026-11-22): keep post-round ticks, drop post-match ticks

Owner: post-round rows stay. Post-match rows (after the final counted round's
`end_tick`, when the match is decided) are dropped.

Implemented: `store.SettleMatchRows` (`src/internal/store/settle.go`), called
from the import path right after `SaveExtracted`. Covered by
`TestSettleMatchRows` (post-round kept, post-match dropped, idempotent).
Snapshot effect: 17,101 tick rows removed (the final-round tail). Sidecar
positions and state are not changed by this rule.

## Status (2026-11-23)

- Rule built: a player_ticks row is written on the first observation of a participant and on any change of round, side, alive or hp (store.TickWriter).
- Columns no longer on player_ticks: in_air, speed, weapon (moved to encounter_window_samples, phase 2).
- Acceptance on the 7-match snapshot and the re-imported library: established earlier (exact tick-row equality on the library comparison; kill join test passes on the golden, compared=159, missing=0).
- Owner rulings applied: S21 amendment (see S21), post-round rows follow the same rule, no buy-window ticks kept.
- Remaining before merge: wipe required on existing libraries (schema change); S03 pruning variant only if asked.
