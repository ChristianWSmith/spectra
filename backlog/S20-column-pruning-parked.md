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

## Result (2026-11-23): money part done; in_air, speed, weapon not touched

Owner un-parked the money column on 2026-11-23 (`SESSION-INDEX.md`). This
branch removes `money` from `player_ticks`. Its one use, `round_player_money.money_start`,
now comes from the extractor, which takes each player's first tick sample of
each counted round (`extract.noteTickMoney` / `applyFirstTickMoney`). That
is the rule `SettleMatchRows` used to apply. The post-match tick delete in
settle is unchanged. `in_air`, `speed` and `weapon` stay as they are, pending
S18.

Verification:
- `go vet ./...`: passes. The root package needed the gitignored
  `src/frontend/dist` copied from the main checkout to compile (`go:embed`).
- `go test -count=1` for `./internal/store` (pass), `./internal/extract`
  (pass; includes new `TestFirstTickMoney`) and `./internal/library` (pass).
  The extract golden tests (`TestParseGolden` and the `TestDiag*` set) skip
  without `SPECTRA_TEST_DEMO` / `SPECTRA_DIAG`, so they did not run here.
- `TestGoldenPlayerTicks` (internal/integration): passes. The golden demos
  are present (LFS smudged). `TestGolden` (pistol-round money_start = 800)
  also passes.
- Equivalence on the snapshot (copied, read only). Match 1 (de_ancient) and
  match 7 (de_nuke) each ran through the real extractor on their raw demos.
  The extractor's `money_start` equals the settle first-tick rule on all 290
  and all 279 round-money rows. The snapshot holds 1,522 rows, all with tick
  rows, so the fallback to m_iStartAccount was not exercised on real data
  (the unit test covers it). The 20 cells that differ from the snapshot's
  stored values are round 25 (the first OT round) in matches 1 and 7, which
  is the S02 fix; the snapshot predates the settle rule. The extractor
  produces 10000 in those cells.

Not verified:
- Whether the extractor and the old settle agree for every demo. Only matches
  1 and 7 were run.
- The existing library. A schema change needs a wipe and re-import. Until
  then the old `money` column stays in place with DEFAULT 0, and new inserts
  leave it at 0. Nothing reads it.
- Only the `money` part of S20 is done. The other three columns and the
  in_air/speed derivation are unchanged.

## Decisions (2026-11-23, owner)

- Money: done (see the money result above).
- in_air, speed and weapon move to encounter data. They are not state-change pruned: encounter data is dense and high fidelity.
- Accuracy metrics are computed only inside encounter windows, not at every shot tick.
- Route: the encounter windows are built inside the extraction pass, from values the extractor already holds, not from the sidecar. Speed, weapon and in-air never go through player_ticks or a second file.
- Consequence: the encounter build moves from the import stage after analysis to the end of the parse, and it needs the render geometry available at extraction time. Failures stay non-fatal, as they are now.
- Wipe: the same wipe as the money and seed changes.
