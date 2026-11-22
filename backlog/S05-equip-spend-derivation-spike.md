# S05 — Spike: can equipment value and spend be derived from events?

**Type:** spike (research, gate G5)
**Source:** `source/PRUNE.md` (research item 4, option 9)

## Goal
Decide whether `round_economy.equip_value` and `round_player_money.equip` /
`spent` can be reconstructed from `events` and `generic_events`, or stay sampled
facts.

## Background
Tick rows store only the active weapon, so equipment value is not derivable
from them. `spent` is not start minus end money (zero matches on the snapshot).

## Work
- Survey event kinds: `item_pickup`, `weapon_pickup`, `weapon_drop`,
  `item_equip`, `player_team`, `player_spawn`, and any purchase-related
  generic events.
- Test a candidate valuation: sum of held item prices at freeze end against
  the sampled `equip_value`.
- Test spend as the sum of purchase events against `spent`.

## Acceptance
- A per-field verdict: derivable, partly derivable, or sampled-only.
- A recommendation for S16 (round-table decision).

## Unblocks
G5 for S16.

## Not covered
Price tables and item valuation are CS2 domain facts. If they are needed, a
`CS2.md` entry with a source is required first (the same rule the encounter
manifesto applies to BSP).
