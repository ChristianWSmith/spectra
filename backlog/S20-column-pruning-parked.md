# S20 — Drop unused tick columns (money, in_air, speed, weapon) — PARKED

**Type:** build (schema, needs wipe) — **parked by owner**
**Depends on:** G3 (S03 ablation), owner un-parking, S18 decision on speed/in-air
**Source:** `source/PRUNE.md` (column readers; option 1)

## Goal
Remove the four columns no builtin metric reads. Dropping `speed` and `in_air`
also removes their derivation and the tick sink's position sampling (about
1.2 s of parse CPU).

## Status
Parked: the owner does not want column pruning now. Recorded so the work is not
lost. It is not in the sprint's critical path.

`hp` is **not** in this list, and stays in tier 1 by owner decision.

## Measured space (for when it is un-parked)
On match 4 (golden):
- Dropping the four columns, keeping all rows: 153 MB → 131 MB (−14%).
- Dropping them and keeping only state-change rows (`round`, `side`, `alive`,
  `hp`): 153 MB → 0.1 MB. Most of the saving comes from the row policy, not the
  columns (S17).
- Moved columns (`speed`, `in_air`, `weapon`) also need tier-2 storage. The
  net saving depends on encounter coverage (S07, S18).
- `money` is a clean saving: no reader at tick grain.

## Why it is parked, not dropped
- The metric language can read any column; a future metric could use them.
- `speed` and `in_air` are the columns the encounter fact would derive, so
  their removal depends on S18.
- The builtin suite is kept deliberately to exercise the system.

## When to revisit
When the owner un-parks it, after S03 shows zero diff with the columns nulled.
