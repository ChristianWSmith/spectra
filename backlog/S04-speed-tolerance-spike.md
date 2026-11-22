# S04 — Spike: speed change distribution and tolerance

**Type:** spike (research, gate G4)
**Source:** `source/PRUNE.md` (research item 7, option 5); `source/PERF.md`

## Goal
Find out how much row-dedup depends on the speed comparison, and whether a
tolerance is defensible.

## Background
Keeping only rows that change saves 58% of rows on the snapshot (4,116,968 of
9,817,283 changed). `speed` changes on 4,070,962 of those rows, so the saving
depends on how speed differences are compared.

## Work
- Histogram of consecutive-row `speed` differences per player, per match.
- Count saved rows at tolerances (exact, 0.01, 0.1, 1.0 units/s).
- Check that the tolerance does not drop real movement starts and stops.

## Acceptance
- Table of saved-row share by tolerance.
- A recommendation on tolerance, or a finding that dedup is not worth it.

## Unblocks
G4: any row-dedup story (not yet written; see S17 and `source/PRUNE.md` option 5).

## Not covered
Snapshot only. Dedup breaks exact-tick joins, so the reader rewrite cost is
separate and not measured here.
