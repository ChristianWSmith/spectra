# Schema pruning: findings and open questions

Status: research notes, untracked. Nothing in the repo has been changed for
this work. Every figure comes from a 7-match snapshot of a real library (a
scratch copy, never the live database) unless marked otherwise. Static
conclusions come from reading the builtin metric SQL with a regex-based
reference finder; they are not confirmed by running the metrics with columns
removed.

This document is aware of `ENCOUNTER-MANIFESTO.md`. Encounters (sparse,
visibility-seeded positions and view angles) are a direction, not a scheduled
task, so the pruning options below are assessed both with and without them.

Companion: `PERF.md` covers performance. This document covers what the
schema could drop, move or derive.

## Question

Which parts of the migration's tick-state and round-level tables are read by
nothing in the current builtin suite, and could we stop storing them at parse
time or derive them elsewhere? The owner plans to cut the builtin suite
eventually, but keeps it now to exercise the system. So "unused" here means
unused by the current suite, not unused by the product.

## Known

### Tick-state table `player_ticks`

- Size: 9,817,283 rows over 7 matches (about 1.40 M per match). About
  164 MB per match: table 74 MB, primary-key index 49 MB, steam index 41 MB.
- Ingest cost: golden-demo import 9.1 s before the migration, 19.1 s now.
  Prototypes reached 17.5 s (per-frame sample reuse) and 16.0 s (async flush),
  both with identical tick fingerprints. See `PERF.md`.

### Column readers (direct, from builtin metric SQL)

| Column | Direct builtin readers | Verdict |
|---|---|---|
| `tick` | 11 | Used |
| `side` | 11 | Used |
| `steam_id` | 10 | Used |
| `round` | 8 | Used |
| `alive` | 8 | Used |
| `hp` | 7 | Used (clutch HP only) |
| `money` | 0 | Unused by the suite |
| `in_air` | 0 | Unused by the suite |
| `speed` | 0 | Unused by the suite |
| `weapon` | 0 | Unused by the suite |

No Go code reads the four unused columns. The only Go reader of
`player_ticks` is the clutch CTE, which reads `steam_id`, `side`, `round`,
`tick`, `alive` and `hp`.

The 11 direct readers are the clutch family (`alive_count`, `clutch`,
`clutches`, `clutch_win_rate`, `clutch_avg_size`, `clutch_avg_hp`,
`clutch_avg_equip`, `match_clutch_wins`) and the damage family
(`dmg_no_kill`, `kill_conversion`, `match_weapon_damage`). Through `metric()`
references, 14 metrics depend on the tick table.

### Row-level profile

- Rows on any event tick: 384,438 (3.9%).
- Rows on kill or damage ticks: 39,641 (0.4%).
- Dead rows (`alive = 0`): 2,532,457 (26%). Of these, 11,796 fall on kill or
  damage ticks.
- Rows whose non-tick columns differ from the same player's previous row:
  4,116,968 (42%). So 5,700,315 rows (58%) would be spared by keeping only
  changed rows. `speed` changes on 4,070,962 of those rows. Any tolerance or
  exclusion on `speed` changes the figure.

### Damage family: side lookup can use `round_player_sides`

`dmg_no_kill`, `kill_conversion` and `match_weapon_damage` read only `side`
from the attacker and victim tick rows, on damage and kill events. Rewriting
the join to `round_player_sides` on match, round and steam ID reproduced every
stored value: 70, 70 and 1,217 cells, zero mismatches. The snapshot includes 55
same-side damage events, so the teamkill branch is exercised.

The exact-tick join is a design artifact. The old `same_side` stamp was
dropped in favour of a tick join under the stamp-drop rule (PLAN ruling 3,
"observable in per-tick state ⇒ tick join"). `round_player_sides` was not
considered as the source, although it holds the same information per round.

### Alive count: derivable from roster and kills

The clutch family's alive count at a kill tick is the roster size for the side
(from `round_player_sides`) minus the kills on that side at or before the tick.
That matched all 2,222 kill-tick cells. The rule must include kills at the same
tick; a strict-before rule fails half the cells. The survivor's identity is a
set difference over the same data.

### Round tables

- `round_player_sides` (50 metrics, 13 Go files): side matches the tick table
  on every row covered by both tables (zero mismatches).
- `round_player_money` (1 metric, 7 Go files): `money_start` equals the first
  tick row's money for 1,502 of 1,522 rows. `equip` is not derivable from the
  tick table, which stores only the active weapon. `spent` is not derivable:
  start money minus end money matches it on zero rows.
- `round_economy` (4 metrics, 14 Go files): `equip_value` is not derivable for
  the same reason. `free_pistol_value` needs freeze-end logic that is not in the
  tick table.
- The economy metrics read `round_player_money` and `round_economy`, not the
  per-tick money column. Nothing uses per-tick money.

The migration's classification (`dogfood/01`, "fact (sample)") and the F3
commit ("round economy sums stay as ingest facts") treat these as sampled
engine state, not event folds. That classification is deliberate.

### Blast radius (by metric touched-table sets)

- Metrics touching the round tables or `player_ticks` directly: 66 of 147.
- Including the analysis tables built on them (`player_stats`,
  `player_round_stats`, `round_classifications`, `round_side_classes`,
  `kill_tags`, `match_trade_opps`): 105 of 147.
- Touching only events, players, rounds and matches: 42.

The 105 figure is an upper bound. The analysis tables' inputs were not checked
one by one.

### Other tables

Row counts and metric readers, for reference:

| Table | Metrics | Notes |
|---|---|---|
| `players` | 103 | Identity; unaffected |
| `events` | 58 | Event facts; unaffected |
| `round_player_sides` | 50 | Sampled fact; see above |
| `player_stats` | 46 | Folds and stamps; analysis-derived |
| `player_round_stats` | 26 | Analysis-derived |
| `rounds` | 20 | Extract fact; unaffected |
| `player_ticks` | 11 | Direct; see above |
| `round_side_classes` | 8 | Analysis-derived |
| `round_classifications` | 6 | Analysis-derived |
| `utility_events` | 6 | Unaffected |
| `kill_tags` | 5 | Analysis-derived |
| `round_economy` | 4 | Sampled fact |
| `match_trade_opps` | 3 | Analysis-derived |
| `round_player_money` | 1 | Sampled fact |
| `matches` | 1 | Unaffected |

### Measured since the first write-up

**Row dedup, space (golden match, match 4, 1,334,370 rows; scratch `sim.db`).**
Current table: 153 MB (table 73 MB, primary-key index 43 MB, steam index 37 MB).

| Scenario | Rows | Size | Saving |
|---|---|---|---|
| Drop `money`, `in_air`, `speed`, `weapon`; keep all rows | 1,334,370 | 131 MB | −14% |
| Keep rows where any current column changes | 585,614 | 69 MB | −55% |
| Drop the four columns; keep rows where `round`, `side`, `alive` or `hp` changes | 867 | 0.1 MB | −99.9% |

Scaled to the 7-match snapshot (about 1.13 GB today): roughly 0.97 GB, 0.51 GB,
and about 1 MB respectively. These figures leave out encounter storage for the
moved columns, which is not yet sized.

**As-of lookup on pruned rows.** Alive counts at kill ticks, using the latest
pruned row at or before each tick, matched the exact-tick counts in 322 of 324
cells. The two mismatches are a presence gap, not a state error: one player has
no tick rows after tick 136,597 in round 23, so a row-existence rule and an
as-of rule count him differently. Pruning cannot tell "not present" from "no
change". Keeping today's values exactly in gap cases would require keeping
per-frame presence, which is the row itself. This needs an owner ruling (see
research item 12).

**Clutch HP is already an as-of read.** The HP subquery takes the latest row at
or before the end tick, so it works with pruned rows as-is.

**Encounter-seed scale (match 4).** 3,880 weapon-fire events and 162 kills. The
encounter fact's size depends almost entirely on whether overlapping shot
windows merge. Unmerged, one 2-second window per shot is about 1 M rows. One
window per kill is about 41,000 rows (about 3% of the tick table). The true
figure lies between them. Coverage measurement is research item 11.

**Money.** The economy metrics read round-grain money (`round_player_money`,
`round_economy`). Nothing reads per-tick money.

### Tiered fidelity (framework)

The recurring theme is that different facts need different fidelity. Note:
the tiers and the rules below are a proposal, not an established design. Which
tiers a metric reads does not need declaring: the metric system already derives
the tables each metric reads at save time (`metrics.touched`), so a tier can be
derived from those tables.

| Tier | Grain | Holds | Coverage |
|---|---|---|---|
| 0. Round and event | Event, round | `events`, `rounds`, round tables (sampled facts) | Whole match, exact |
| 1. Tick state, event-anchored | Tick, changes only | `player_ticks` pruned to state changes and the moments metrics read; HP kept | Whole match, but only where state changes or an event occurs |
| 2. Encounters | Tick, dense | Position, view angles, and (if moved) speed, in-air and weapon | Only inside shot-seeded visibility windows |
| 3. Sidecar | Frame, quantized | Replay-grade position and state | Whole demo, not queryable from metrics |

Rules that follow:

- Which tiers a metric reads is derived from its touched tables, not declared.
- Only tier-2 reads (partial coverage) need a label. Anything outside a tier's
  coverage has no value at that tier, and the metric must say so.
- Tier 1 keeps the state a metric needs (`hp`, `alive`, `side`, `round`).
  Values that vary every frame (`speed`, `in_air`, position) belong in tier 2.
- Moving a column to a finer tier is only a saving if the finer tier's coverage
  is small. Encounter size is therefore the tier-2 risk.

### HP is kept on purpose

Clutch HP is not an interesting fact in itself, and we don't rely on it. It is
kept in tier 1 so that performant HP visibility is not lost before it is needed
for a future metric. This is a decision, not an open question: no spike may
remove `hp` from `player_ticks` unless the owner rules otherwise. The HP
research below is about whether HP can also be derived from events, which
would be an option, not a requirement.

## Options

Each option is classed by whether it needs a schema change (a wipe, since the
project is pre-release) and whether it depends on the encounter fact.

1. **Drop `money`, `in_air`, `speed`, `weapon` from `player_ticks`.** No
   builtin reads them. Dropping `speed` and `in_air` also removes their
   derivation, and the tick sink's position sampling. That is roughly 1.2 s of
   parse CPU, the largest parse saving on the list. Schema change: yes.
   Encounter-dependent: `speed` and `in_air` are the columns encounters could
   derive (velocity from consecutive samples), but only inside coverage. Keeping
   them everywhere would be needed for any future metric outside encounters.
   The owner's "no column pruning right now" note means this is parked.

2. **Replace the damage family's tick join with `round_player_sides`.**
   Verified against stored values. No schema change to `player_ticks` needed
   for this alone, but it makes option 3 possible. Encounter-independent.

3. **Replace the alive count with roster-minus-kills.** Verified at kill ticks.
   Makes the clutch family independent of the tick table except for HP.
   Encounter-independent. Needs a parity test on more matches before shipping.

4. **Prune tick rows to kill and damage ticks (0.4% of rows).** Only valid
   after options 2 and 3 and an answer to HP (below). Round-boundary rows would
   also be needed for any HP fallback. Schema change: yes (rows, not columns).
   Encounter-dependent: the encounter fact would become the home for positional
   and state data at moments that matter, so the pruned tick table would not
   need to serve those.

5. **Keep only changed rows (58% spared).** Speed-driven. Needs as-of joins in
   every reader that currently joins on exact tick, which is the design doc's
   rejected pattern. Only sensible after option 4 is evaluated; the two overlap
   heavily. Encounter-independent.

6. **Drop `idx_player_ticks_steam`** (41 MB per match, 0.5 to 1 s ingest). No
   steam-only reader was found in the store code or the builtin SQL. Needs a
   wipe. Confirm no planned library-wide steam read first.

7. **`WITHOUT ROWID` on `player_ticks`** (about 25% smaller, about 11% faster
   insert in a micro-benchmark). The design doc records a 36% slowdown on
   steam-range reads. Needs a wipe.

8. **Keep `hp` in tier 1 (decided), and optionally derive it from events.**
   HP is not moved to encounters. The clutch HP read is at the clutch's end
   tick, and encounter coverage is visibility-seeded, so encounters can't
   guarantee a sample there (the gap is shown in S18). Keeping HP in tier 1 costs
   little, since `hp` changes only on damage and is already a state-change
   column. Deriving HP from health-carrying damage events is an optional
   performance path, researched in item 1 below, and it does not remove the
   column.

9. **Round tables.** `round_player_sides` could be derived from tick rows at
   round boundaries, or left as a sampled fact. `round_player_money` and
   `round_economy` are only partly derivable: `money_start` is, `equip` and
   `spent` are not. Dropping any of them needs an answer to the classification
   question first (sampled fact or derived view). Encounter-independent.

## Research needed

These are ordered by what they would unblock.

1. **Clutch HP without tick rows.** Compare the current HP branch (tick HP at or
   before the end tick, otherwise 100 minus summed damage) with the last
   health-carrying damage event at or before the end tick. Measure parity on
   every clutch. If parity holds, option 8's main obstacle goes away.
2. **The 9,244 tick rows with no `round_player_sides` match.** Identify them
   (bots, uncounted rounds, roster gaps). Option 9 and option 2 depend on this.
3. **The 20 `money_start` mismatches** against the first tick row. Identify
   whether the sample timing or the tick sink is the cause.
4. **Equipment value and spend.** Find out whether the events table or
   `generic_events` (for example `item_pickup`, `weapon_pickup`, `weapon_drop`)
   can reconstruct inventory value and spend. If so, `equip` and `spent` may be
   derivable. If not, they stay sampled facts.
5. **Ablation test.** In a scratch copy, remove the four unused columns (or null
   them), run the full sweep, and diff `metric_values` against the current
   values. This is the only check that catches references the regex finder
   missed. It must be run before any column is dropped.
6. **Round-end ticks.** How many rows are needed for an HP fallback, and whether
   they can be derived from round start and end events.
7. **Speed tolerance.** Distribution of consecutive-row `speed` differences. The
   changed-row figure in option 5 depends entirely on this.
8. **Analysis-table inputs.** Check, one table at a time, which tables
   `player_stats`, `player_round_stats`, `round_classifications`,
   `round_side_classes`, `kill_tags` and `match_trade_opps` read. The 105
   figure depends on it.
9. **Library scale.** Repeat the row-level and alive-count checks on a library
   with 50 or more matches. Seven matches is not enough to confirm rules like
   "kills at or before the tick".
10. **Golden timings with the sweep disabled.** The profiled import ran
    concurrently with a metrics sweep. The 19.1 s figure may be inflated, which
    would also overstate the parse-time savings in option 1.
11. **Encounter coverage fraction, with merge rule.** The owner's expectation is
    that encounters are far smaller than `player_ticks`, because CS2 time-to-kill
    is short and windows last seconds. The measurement is still needed: the size
    depends on how overlapping shot windows merge (see "Encounter-seed scale"
    above). The tracer benchmark in the manifesto's spike batch answers this.
12. **Presence semantics for pruned rows.** Decide how a player with no row at a
    tick is counted when rows are pruned. The round 23 gap (above) shows the
    choice changes values. Options: (a) keep per-frame presence (costs most of
    the saving), (b) accept the as-of result and record the changed values, (c)
    exclude players with a gap. Each needs the owner's ratification, because
    the migration rule is that existing values don't change. Also check how
    often gaps occur across libraries (links to item 2).
13. **HP derivation from events (optional).** Parity of the health value on the
    last health-carrying damage event against tick HP, for performance only. It
    does not remove `hp` from the tick table (see "HP is kept on purpose").

## Constraints

- Pre-release: schema changes are allowed and need no compatibility path, but
  every change needs a wipe and a re-import.
- Golden acceptance tests need `git lfs pull` and are extraction-touching.
- The migration rule is that existing metric values do not change without a
  recorded, ratified reason. Each option that changes a value needs that
  ratification.
- Metric SQL reads only allowlisted tables. Any new table (encounters) is
  allowlisted when added, and touched tables are derived at save.
- The owner has said there should be no column pruning for now. That is a
  scheduling decision, not a technical one. These notes record it so it is not
  lost.
