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

## Result

**Status: DONE (numeric).** Tested on a copy of the snapshot (7 matches, 153
rounds, 1522 player-round money rows, 306 side-round economy rows). No CS2 price
data was used. The repo has a price table only for six utility items
(`utilityPrices`, `src/internal/models/weapons.go`) and none for guns, so
item-value tests are blocked without a sourced price table.

### 1. Event kinds (copy of snapshot)
- `events`: 52,608 rows. Purchase-related kinds: `weapon_pickup` 7,088,
  `weapon_drop` 1,836 (inferred from death drops), `bomb_pickup` 460,
  `bomb_drop` 382. No `item_purchase`, `buy`, or similar kind exists (0 rows).
- `generic_events`: 142,806 rows. Purchase-related names: `item_pickup` 9,856
  (includes armour: `vesthelm` 811, `vest` 407), `item_equip` 56,771,
  `bomb_pickup` 452, `bomb_dropped` 382. No purchase event name exists.
- Price fields: no payload or raw key matches price/cost/money/cash/spend
  (0 rows across generic_events payloads). `weapon_pickup` and `item_pickup`
  carry only `item`, `defindex`, `silent`, `userid` (`weapon_pickup` also
  `attacker` = steam id). `item_equip` carries only item name and flags.

### 2. Stored spend vs purchase events
- **Price sums: not possible.** No pickup, equip, or drop event carries a price.
- **Presence test** (`round_player_money`, steam-keyed `weapon_pickup` up to the
  `buytime_ended` tick): spend > 0 with a buy-window pickup 1,457; spend > 0
  with none 48; spend = 0 with one 17. Agreement 1,457 / 1,522 (95.7%).
  Armour cannot be attributed: `item_pickup` `userid` maps to 2 or 3 steam ids
  within one round, so the armour pickups (1,218 rows) are excluded from the
  per-player test.
- **Cash-delta test** (`round_player_money.spent` vs `money_start` minus
  `player_ticks.money` at the `buytime_ended` tick): exact 1,297 / 1,522 (85.2%;
  1,280 with spend > 0, 17 with spend = 0). Cash fell less than spend in 225
  rows (157 of them by exactly 300); cash fell more in 0 rows. Mismatches cluster:
  round 25 of matches 1 and 7 (20 rows, all players) and round 12 of match 7
  (10 rows, all players). Cause not investigated.
- **`round_economy.spent`** (side sums): equals the sum of the side's per-player
  `spent` in 150 / 306 side-rounds (156 differ; aggregate gap +21,000, economy
  higher). Equals the side's buy-window cash delta in 76 / 306. The field is a
  freeze-end-to-freeze-end counter delta, so this gap is expected by design.

### 3. Equipment value (`equip`, `equip_value`)
**Plainly: no event or tick field gives held-item value without a price table.**
`player_ticks` stores `money` (cash) and `weapon` (active weapon) only; no armour,
helmet, or grenade-count fields. Pickup, drop, and equip events carry item names
but no price. Held-inventory reconstruction from pickups and drops was not
tested, and it would still need a gun price table. `round_player_money.equip` is
> 0 in all 1,522 rows, with no further check possible.

### 4. Per-field verdicts
| Field | Verdict | Counts behind it |
|---|---|---|
| `round_player_money.spent` | **partly derivable** | Buy-window tick cash delta exact in 1,297 / 1,522 (85.2%); 225 residual (undershoot only). No price table needed. |
| `round_economy.spent` | **sampled-only** | Equals sum of player spend in 150 / 306; equals cash delta in 76 / 306. Test does not support derivation. |
| `round_player_money.equip` | **sampled-only** | No price-free field. Needs gun prices. |
| `round_economy.equip_value` | **sampled-only** | No price-free field. Needs gun prices. |

### 5. Recommendation for S16
The numbers support sampled-only for three fields (`round_economy.spent`,
`round_player_money.equip`, `round_economy.equip_value`). They **change one**:
`round_player_money.spent` is partly derivable from the stored `player_ticks.money`
over the buy window (85.2% exact, no price table). Treat it as a stored sampled
fact with a derivation check, not a blanket sampled-only field, until the 225
residual rows are explained. Keep the stored value authoritative.

Dependency: the derivation reads every tick in the buy window. The copy has every
tick (1,282 of 1,282 in match 1 round 1), so S17 tick-row pruning must keep buy-window
ticks if this derivation is used.

### Correction to the background
"Start minus end money: zero matches" tests round-end money. The buy-window end
(`buytime_ended`) is the right measure, and that test matches 85.2%.

### Superseded provisional text
The provisional code-reading result (commit `3a41ab8`, on branch
`worktree-agent-a1bb414a59d68401f`) is superseded by the counts above. Its
code-reading facts still hold: `equip_value` is the engine freeze-time-end team
value; `round_economy.spent` is a freeze-end counter delta; `item_purchase` does
not fire (confirmed: 0 rows); `item_equip` carries no spend; the only price table
is the utility one.
