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
