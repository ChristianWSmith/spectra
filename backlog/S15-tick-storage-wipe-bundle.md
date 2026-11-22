# S15 — Tick storage decisions (steam index, WITHOUT ROWID) in one wipe

**Type:** decision + build (schema, needs wipe)
**Depends on:** owner decision; grep confirmation; S08 (steam-range read cost)
**Source:** `source/PRUNE.md` (options 6, 7); `source/PERF.md` (storage)

## Goal
Decide and bundle the storage-only schema changes to `player_ticks`, so they
ride one wipe.

## Options
- Drop `idx_player_ticks_steam` (41 MB per match, 0.5–1 s ingest). No steam-only
  reader found in store code or builtin SQL.
- `WITHOUT ROWID` on `player_ticks` (about 25% smaller, about 11% faster insert),
  with a recorded 36% slowdown on steam-range reads (design doc, not
  re-measured).

## Work
- Confirm no steam-only reader, including the owner's planned library-wide reads.
- Re-measure steam-range reads with and without `WITHOUT ROWID` at S08 scale.
- Owner decides; the bundle is applied in one wipe with the other schema changes.

## Acceptance
- Recorded decision with measured trade-off.
- Schema pins updated (`TestSchemaConsistency`, `TestTier1IndexesPresent`).
- Re-import on the snapshot; metric values unchanged.

## Not covered
The owner may want to keep steam-range reads fast for future library-wide
features. That is a product question, not a measurement.
