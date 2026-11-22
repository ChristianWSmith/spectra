# S16 — Round tables: sampled facts or derived views

**Type:** decision (owner) + possible build
**Depends on:** S02 (G2), S05 (G5), S06 (analysis inputs)
**Source:** `source/PRUNE.md` (round tables; option 9); `source/PERF.md` (blast radius)

## Goal
Decide whether `round_player_sides`, `round_player_money` and `round_economy`
stay as sampled facts (the current migration classification) or become views
over tick rows and events.

## Background
- `round_player_sides`: derivable from tick side (zero mismatches on covered rows).
- `round_player_money.money_start`: derivable for about 99% of rows.
- `round_player_money.equip`, `spent` and `round_economy.equip_value`: not
  derivable from current tick columns.
- The F3 commit and `dogfood/01` classify these as sampled facts, deliberately.

## Work
- Take S02, S05 and S06 results.
- Owner decides per table: keep as fact, derive the derivable columns, or
  derive all.
- If derived, the change follows S03 and the migration's "no existing value
  changes" rule.

## Acceptance
- Recorded decision per table, with the reason.
- If a derive is chosen: S03 zero-diff and an updated classification in
  `dogfood/` docs (or their successor).

## Not covered
Equipment valuation needs CS2 price facts with sources, if derivation is pursued.
