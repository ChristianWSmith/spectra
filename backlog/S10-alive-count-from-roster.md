# S10 — Alive count from roster minus kills

**Type:** build (metric rewrite)
**Depends on:** S02 (G2), S08 (scale), S03 (harness)
**Source:** `source/PRUNE.md` (alive count); `source/ENCOUNTER-MANIFESTO.md` §3 (discovery needs living players at a shot tick)

## Goal
Compute the clutch family's per-side alive count, and the survivor's identity,
from `round_player_sides` (roster) and kill events, instead of tick `alive`
rows.

## Background
Living count at a kill tick = roster size for the side minus kills on that side
at or before the tick. On the snapshot this matched all 2,222 kill-tick cells.
A strict-before rule fails half the cells, so the inclusive rule is required.

## Work
- Rewrite `alive_count` and the `cnt`/`cand` CTEs in the clutch SQL.
- Keep the clutch CTE shared between metrics and `ClutchRows`.
- Pin the inclusive-tick rule with a test.

## Acceptance
- Zero value diff at library scale (S08).
- The rule is documented in the seed comment and the test name.

## Unblocks
Removes the alive-count dependency on tick rows. Clutch HP (S01) remains.

## Not covered
Assumes every death is a `kill` event with a victim. Revives, disconnects and
bot takeovers are not tested. Encounter discovery (S18) would reuse this rule.

**Presence gaps.** The roster rule counts a player as alive until a kill
removes them. A tick-row rule instead counts only players who have a row at
that tick. In match 4, round 23, one player has no rows after tick 136,597, so
the two rules disagree there (322 of 324 cells agree). Which rule is correct,
and whether the value changes, is decided in S21. Do not ship S10 until S21 rules.
