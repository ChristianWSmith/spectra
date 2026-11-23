

## Build result (2026-11-23)

What changed:
- `src/internal/store/schema.sql`: the `alive_count` seed now uses the roster rule
  (round grain, binds `:match_id` and `:round`). The doc line states the rule. The raw
  `clutch` seed, which carries its own copy of the alive count, uses the same rule.
- `src/internal/store/clutch_sql.go`: `clutchCTE` gains an `alv` CTE (roster players
  not killed at or before the kill tick, and without a `player_disconnect` from the
  round start through that tick). `cnt` and `cand` read `alv`. The survivor HP lookup
  and the rest of the CTE are unchanged. The CTE stays shared by the metrics and `ClutchRows`.
- `src/internal/store/clutch_sql_test.go`: the clutch fixture gains its roster rows. New
  `TestAliveCountRosterRule` on two rounds. Round 1 pins the inclusive kill tick, a
  disconnect 5 ticks before the kill (counts), and a disconnect before the round start
  (does not count). Round 2 pins a player who is both killed and disconnected (counts once).
- `src/internal/metrics/fixtures_test.go`: the career clutch pins (`career_clutches`,
  `career_clutch_win_rate`) were pinned to "no rows". The corpus (`testdata/seed.sql`)
  has no `player_ticks` rows, so the old tick rule saw no alive players and no clutches.
  The roster rule gives 72 clutches (36 per player), none won. Both pins now expect 2
  rows: 36 and 0. The match-scope clutch comments that said "clutchless corpus" are updated.

Results:
- `go vet ./internal/store ./internal/metrics`: pass.
- `go test -count=1 ./internal/store/`: ok (114.8 s), includes `TestAliveCountRosterRule`.
- `go test -count=1 ./internal/metrics/`: ok (135.4 s).
- Snapshot comparison (read-only copy of the snapshot DB, new seed SQL): 2,222 of 2,222
  stored `alive_count` cells agree (7 matches, 0 disagree).

Not done here:
- Schema change: the seed is `INSERT OR IGNORE`, so an existing library keeps the old
  `alive_count` and `clutch` expressions. The library needs a wipe and re-seed. Not performed.
- Library-scale zero-diff check (S08/S03): not run.
- S21 is still open. The S10 text says not to ship until S21 rules on presence semantics.
  The roster rule and the tick rule differ on the match 4, round 23 presence gap. This
  build implements the roster rule as the task specified, so that gap is now decided by
  the roster rule, not by S21.
