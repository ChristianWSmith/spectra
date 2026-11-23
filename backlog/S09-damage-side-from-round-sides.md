# S09 — Damage family reads side from `round_player_sides`

**Type:** build (metric rewrite)
**Depends on:** S02 (G2), S03 (harness), S08 (scale)
**Source:** `source/PRUNE.md` (damage family; option 2)

## Goal
Replace the exact-tick joins in `dmg_no_kill`, `kill_conversion` and
`match_weapon_damage` with a per-round join to `round_player_sides`.

## Background
These metrics read only `side` from the attacker and victim tick rows. On the
snapshot the rewrite reproduced all stored values (70, 70, 1,217 cells; zero
mismatches), including 55 same-side damage events.

## Work
- Rewrite the three seed expressions, preserving the rule that a missing side
  is "not same side" (the current behaviour when a tick row is missing).
- Run S03 with the rewrite; diff must be empty on baseline data.
- Update the seed and any pins (`schema.sql` seeds; metric tests).

## Acceptance
- Zero value diff across the library after S02's rules are applied.
- Migration ratification noted: value changes, if any, need a recorded reason.

## Unblocks
Removes three of the 11 direct tick readers (S17 precondition).

## Not covered
The snapshot had no missing-side cases to test; S02's answer defines the
expected behaviour there.

## Result

**Changed**
- `src/internal/store/schema.sql`: the three seeds `dmg_no_kill`,
  `kill_conversion` and `match_weapon_damage` now join
  `round_player_sides` (aliases `pa`/`pv`) on
  `(match_id, round, steam_id)` for attacker and victim, instead of
  `player_ticks` on `(match_id, tick, steam_id)`. The same-side gate
  text is unchanged, so a missing side still means "not same side".
  The stale comment about these seeds reading `player_ticks` is updated.
- `src/internal/metrics/fixtures_test.go`: the Go copies of the three
  seed expressions (the fixture lock) carry the same join.
- `src/internal/metrics/combat_equivalence_test.go`: the characterization
  fixture also writes `RoundSides`, so the seed's per-round gate sees
  carl's side. The `player_ticks` frames stay, because the test's
  retired-SQL oracle still reads them.

**Comparison** (copy of the snapshot, 7 matches, binds `:match_id` per
match, compared against the stored `metric_values` rows)
- `dmg_no_kill`: 70 of 70 cells, 0 mismatches
- `kill_conversion`: 70 of 70 cells, 0 mismatches
- `match_weapon_damage`: 1,217 of 1,217 cells, 0 mismatches
- New vs old SQL on the copy: identical result sets for all three.

**Timings** (copy, sum over the 7 matches, one bound run each)
- Old `dmg_no_kill`: 493 s (per match: 9.1, 200.9, 231.7, 29.5, 21.8 s
  on the heavy matches). Old `kill_conversion`: 22.7 s. Old
  `match_weapon_damage`: 0.4 s.
- New `dmg_no_kill`: 1.5 s. New `kill_conversion`: 0.1 s. New
  `match_weapon_damage`: 0.1 s. The new query is no longer minutes.

**Tests**
- `go test -count=1 ./internal/store/`: ok.
- `go test -count=1 -run 'TestCombat|TestBuiltinSeedMetrics|TestSyntheticCorpusCounts' ./internal/metrics/`: ok.
- `go test -count=1 ./internal/metrics/` (full package, 1400 s timeout): ok, 86 s.
  An earlier run hit my own 540 s `-timeout` inside
  `TestEconomyForceLostSeedEquivalence`, while a concurrent 500 s
  comparison job was loading the disk.
- `TestCombatDamageSeedEquivalence` failed once, because the
  retired-SQL oracle reads `player_ticks` and I had removed those
  frames. Fixed by keeping them.

**Not verified**
- The library-scale zero diff. It needs S08 and a full S03 sweep.
- Rows where a side is missing on one or both ends. The snapshot has
  none; S02's answer defines the expected behaviour there.
- Stored seed text. `schema.sql` seeds are `INSERT OR IGNORE` and never
  rewrite a stored row, so an existing database keeps the old expression
  until its rows are wiped. The copy still holds the old text. The new
  text was run from `schema.sql` directly.
- The S03 harness was not used; the comparison was a direct script.
