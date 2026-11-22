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
