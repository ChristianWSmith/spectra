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

## Result (2026-11-21, scratch snapshot)

Consecutive rows per `(match_id, steam_id)`, ordered by tick. A row is kept
when any non-speed field changed (alive, hp, money, in_air, weapon, round,
side) or when speed differs from the previous row by more than the tolerance.
First rows per player are counted separately.

| Tolerance (units/s) | Changed rows kept (of 9,817,283) | Saved share |
|---|---|---|
| exact | 4,112,893 | 58.1% |
| 0.01 | 3,120,303 | 68.2% |
| 0.1 | 2,826,334 | 71.2% |
| 1.0 | 2,132,823 | 78.3% |

Rows where only speed changed (exact): 4,031,707. The exact-rule count is
0.1% below the 4,116,968 in the story, which is within the definitional
difference (the story's "changed" definition is not in the repo).

**Not done.** The check that a tolerance does not drop real movement starts
and stops was not run. Before any tolerance is chosen, count rows where speed
crosses a stop threshold (for example, from below 1 to 1 or above) inside the
dropped set. Dedup also breaks exact-tick joins; that cost is still unmeasured.

**Recommendation.** Not decided. The saving is large at every tolerance, so
G4 looks positive for dedup, but the choice of tolerance needs the start/stop
check first.

## Speed and the exact-tick joins (2026-11-21)

Owner direction: speed should migrate into encounters eventually, without
breaking exact-tick joins. Checked which production reads depend on an exact
tick row (`player_ticks` joined on `tick =`):

1. **`weapon_damage` / `match_weapon_damage`** (`schema.sql`). Joins
   `player_ticks` on `events.tick` for the attacker and victim, to read their
   side for the team-damage gate. Replaceable. On the snapshot, the
   exact-tick side equals `round_player_sides` for all 4,102 damage events
   (attacker and victim). The same-team count is 85 by either source. The
   side is constant within a round, so the round side sample carries the same
   data. Not changed here: it is a metric-seed edit, and the migration rule
   requires the change to be ratified (the value is identical, so the
   ratification is a formality).
2. **Alive-count family** (`clutch_sql.go`, the `kill tags` alive counts,
   `schema.sql` `alive_count`). Joins `player_ticks` on the kill tick. All
   2,196 (kill tick × side) groups have an exact row. An as-of join
   (latest row at or before the tick) returns the same rows wherever an
   exact row exists. Migrating this to as-of is blocked by pruning (S17),
   because pruned rows are absent, not "unchanged" (S21).
3. **Speed and in-air.** No production SQL reads `speed` or `in_air` today.
   They are stored features with no metric consumer. Moving speed into
   encounters therefore breaks no exact-tick join now. Future speed-at-shot
   reads should use the encounter window (as-of within the window), not an
   exact tick.

So the answer to "could those joins get the same data without an exact-tick
join": yes for the side (round sides), yes for alive state if pruning does
not remove rows (as-of), and speed has no current exact-tick reader.

Owner direction also: speed is the pain point now and space is secondary.
The tolerance question (start/stop check) is therefore the priority, not
`WITHOUT ROWID` (S15/S20).
