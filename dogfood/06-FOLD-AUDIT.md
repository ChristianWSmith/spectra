# 06 · Fold audit of `player_stats` and the round-level columns

**Status:** complete, F1 deliverable (audit only, no code changed). Blocks F2.
**Date:** 2026-11-20.
**Scope:** every value column of `player_stats` (36), `player_round_stats`
(15), `rounds` (13), `round_economy` (6), `round_player_money` (3) and
`round_player_sides` (2), 75 columns in all. Key columns (`match_id`,
`steam_id`, `round`, `number`, `side` where it is part of a key) are not
audited. Analysis-owned tables (clutches, engagements, utility rows,
classifications) are listed in §5 for completeness, not audited.
**Decisions applied:** `PLAN.md` items 17 (fold layer moves to metrics),
18 (emulation stamps stay), 19 (analysis outputs), 21 (fold versus detector).

Classification was done by reading `src/internal/extract/agg.go`,
`build.go`, `extract.go`, `handlers.go`, `src/internal/analytics/rounds.go`,
`compute.go`, `engagements.go`, and the stamp writer in
`src/internal/store/lifecycle.go`, not from column names.

**Verification method.** The snapshot's `spectra.db` was copied (it has no
`-wal`/`-shm`) to `~/Programming/spectra-verify/f1/` and queried read-only
(7 matches, 73 `player_stats` rows of which 3 are bots, 1530
`player_round_stats` rows, 153 rounds). For every column the "Snapshot
check" cell says what was run against the copy. "Equal" means zero
mismatching rows across all matches using the SQL in the sketch (with the
gates named in §2). Column existence and non-null data was confirmed for
all 75 columns; the columns with no nonzero data are listed in §4.

## 1. Classes

| Class | Meaning here |
|---|---|
| fact | Observed engine value or event field stored as is (final-state snapshot, event field, sampled prop, or a copy of one) |
| fold | Aggregate over facts, or a deterministic derivation by join, with no interpretation (item 21) |
| detector-derived | Value produced by a trade-window rule, window, or state machine, stored by analysis (items 19, 21) |
| emulation stamp | Engine-internal decision the extractor emulates; stays at ingest (item 18) |

Totals across the 75 columns: **fact 23, fold 45, detector-derived 4,
emulation stamp 3** (`mvps`, `score`, `rounds.mvp`).

## 2. Shared gates the replacement metrics must reproduce

The extract folds apply these before counting. Every replacement sketch
below says "enemy", "counted" or "not fake" and means the following.

- **enemy(e)**: `e.attacker <> e.victim AND NOT same side`, where same side
  means both sides known and equal (`extract.sameSide`). An unknown side
  counts as enemy. Side comes from `round_player_sides` (F2 rule). Bots have
  no `round_player_sides` rows (0 in the snapshot), so the join must be a
  `LEFT JOIN` and an absent side must read as unknown, not as a filtered
  row. Three snapshot kill events have an attacker with no side row.
- **not fake**: excludes a World self-kill on the tick the victim has a
  `player_disconnect` row (`agg.kill`/`flushWorldSelf`; `analytics.WorldWeapon`).
  Snapshot: without this exclusion `deaths` mismatches 16 rows, with it 0.
  Suicides outside this case stay counted.
- **real**: the extract gates `deaths`, `kills`, `hits`, `total_damage`,
  `damage_taken`, `shots`, `enemies_flashed`, `flashed_times`,
  `bomb_plants` and `bomb_defuses` on `realPeriod(gs)` (`helpers.go`:
  match started, not warmup, game phase). That is an engine-state read at
  event time and is **not stored on the event rows**. The snapshot shows no
  difference (every column below reproduces without a real gate), but this
  is not guaranteed on other demos. See QUESTIONS Q1.
- **counted**: rounds are already only counted rounds (discard at ingest), so
  no round filter is needed.

## 3. The table

Source files are under `src/internal/`. "agg" is `extract/agg.go`.

### 3.1 `player_stats`

| Column | Class | Computed from (file, function) | Replacement metric and SQL sketch | Snapshot raw column and check |
|---|---|---|---|---|
| `side` | fact | Final roster snapshot, `extract/extract.go` (final players) → `agg.applyFinal`; also refreshed live by `agg.kill`/`freezeEnd` | Not a metric. Duplicates `players.side` (read that). | `players.side`. Equal, 73 rows. |
| `name` | fact | Final roster snapshot, `agg.applyFinal` | Not a metric. Duplicates `players.name`. | `players.name`. Equal, 73 rows. |
| `map` | fact | Copy of `matches.map` stamped by `store.SaveExtracted` (`store/lifecycle.go`) | Not a metric. Join `matches.map`. | `matches.map`. Equal, 73 rows. |
| `kills` | fold | `agg.kill`: enemy kills only (killer not victim, not same side) | `kills`: `count(*) FROM events WHERE kind='kill' AND enemy GROUP BY attacker` | `player_stats.kills`. Equal (all 7 matches; `teamkills` is 0 everywhere, see §4). Also `player_round_stats.kills` sums to it. |
| `deaths` | fold | `agg.kill`/`flushWorldSelf`: every real death incl. suicides and teamkills, minus fake disconnect deaths | `deaths`: `count(*) FROM events WHERE kind='kill' AND victim<>'' AND not fake GROUP BY victim` | `player_stats.deaths`. Equal with the not-fake rule (16 rows differ without it). |
| `assists` | fold | `agg.kill`: assister cross-team, not `assisted_flash`, and only reached when attacker is not the victim (early return on suicide) | `assists`: `count(*) FROM events WHERE kind='kill' AND assister<>'' AND attacker<>victim AND assisted_flash=0 AND assister/victim not same side` | `player_stats.assists`. Equal except 1 row, a cross-side gate difference not reproduced by the quick check; F2 must close it (7 rows differ if the attacker<>victim gate is dropped, which is how the gate was found). |
| `flash_assists` | fold | `agg.kill`: same rule as assists with `assisted_flash=1` | `flash_assists`: as `assists` with `assisted_flash=1` | `player_stats.flash_assists`. Equal (21 nonzero rows). |
| `headshots` | fold | `agg.kill`: enemy kills with `headshot` | `headshots`: `sum(headshot)` over the `kills` rows | `player_stats.headshots`. Equal. |
| `teamkills` | fold | `agg.kill`: killer and victim same side, attacker not victim | `teamkills`: `count(*)` of kill events, attacker<>victim, same side | `player_stats.teamkills`. **No data** (all 0); cannot confirm. |
| `suicides` | fold | `agg.kill`/`flushWorldSelf`: killer == victim, minus fake disconnect deaths | `suicides`: `count(*)` kill events, attacker=victim, not fake | `player_stats.suicides`. 1 nonzero row; reproduced with the not-fake rule. |
| `total_damage` | fold | `agg.hurt`: enemy damage, per hit capped by `agg.capDamage`; the capped value is stamped on the event as `capped_dmg` | `total_damage`: `sum(capped_dmg) FROM events WHERE kind='damage' AND enemy GROUP BY attacker` (capped_dmg stays, item 18) | `player_stats.total_damage`. Equal. Note `player_round_stats.dmg` is the UNcapped `events.dmg`, so the two do not sum to each other (70 of 73 rows differ). |
| `damage_taken` | fold | `agg.hurt`: all damage taken, from `healthDamageTaken` (event `detail_json.damageTaken`, not `events.dmg`) | `damage_taken`: `sum(json_extract(detail_json,'$.damageTaken')) FROM events WHERE kind='damage' GROUP BY victim` | `player_stats.damage_taken`. Equal (0 mismatches). A typed column would be cleaner than reading `detail_json`; see Q4. |
| `shots` | fold | `agg.shot`, fed by the `WeaponFire` handler in `handlers.go` (`real` only). **No event row is stored**: the snapshot has 0 `weapon_fire` events | `shots`: `count(*) FROM events WHERE kind='weapon_fire' GROUP BY attacker` (needs A4 typed event) | `player_stats.shots`. **Not verifiable from the snapshot's events**; the reference is the stored column itself. Depends on A4. |
| `hits` | fold | `agg.hurt`: count of enemy damage events, **including utility damage** (HE, fire), so it is not a bullet-hit count | `hits`: `count(*)` of damage events where enemy | `player_stats.hits`. Equal. |
| `adr` | fold (derived) | `build.go` `build`: `total_damage / len(a.rounds)` (match round count, never the player's own rounds) | `adr`: `total_damage` metric / `(SELECT count(*) FROM rounds WHERE match_id=:match_id)`; career form is a ratio of sums | `player_stats.adr`. Equal (tolerance 0.01). |
| `hs_pct` | fold (derived) | `build.go` `build`: `pct(headshots, kills)` (0..100) | `hs_pct`: `100.0 * metric('headshots') / metric('kills')` (a dash when kills = 0; the stored column writes 0, see Q5) | `player_stats.hs_pct`. Equal. |
| `rounds_played` | fold | `agg.freezeEnd`: a round counts for a player who has a freeze-end sample in it (`a.participation`); read in `build` | `rounds_played`: `count(*) FROM round_player_sides WHERE steam_id=:steam_id` | `player_stats.rounds_played`. Equal (0 mismatches), against the count of `round_player_sides` rows. |
| `entry_kills` | fold (judgement) | `agg.kill`: the first non-teamkill kill of the round (`r.firstKillSteam == ""`), credited to the killer | `entry_kills`: `count(*)` over `rounds` where `first_kill_steam=:steam_id` (or a `row_number() OVER (PARTITION BY round ORDER BY seq)=1` over enemy kills) | `player_stats.entry_kills`. Equal to count of `rounds.first_kill_steam`. See Q2 (fold vs detector). |
| `entry_deaths` | fold (judgement) | `agg.kill`: the victim of that first kill | `entry_deaths`: `count(*)` over `rounds` where `first_death_steam=:steam_id` | `player_stats.entry_deaths`. Equal to count of `rounds.first_death_steam`. |
| `trade_kills` | detector-derived | Import-time 5 s default in `agg.kill` (`tradeWindow`), **overwritten** by `analytics.compute` via `store.ReplaceTradeKills` from `Engagements` (`KindTrade`) using `cfg.TradeWindowS` | Stays analysis-owned (items 19, 21). Metric `trade_kills`: `count(*) FROM engagements WHERE kind='trade' GROUP BY a_steam`, with the trade-window stub | `engagements` rows `kind='trade'` grouped by `a_steam`. Equal (0 mismatches). |
| `best_streak` | fold (judgement) | `agg.kill`: running kill count reset to 0 only on the player's death; **does not reset at round start**, so it spans rounds | `best_streak`: gaps-and-islands over a union of kill events (attacker, +1) and death events (victim, reset): `max(run_sum)` per player | `player_stats.best_streak`. Equal (0 mismatches) using a window-function sketch run on the copy. See Q2. |
| `two_k` | fold | `build.go` `buildMultiKills`: rounds with exactly 2 enemy kills | `two_k`: `count(*) FROM (SELECT round, count(*) c ... enemy kills GROUP BY round, attacker) WHERE c=2` | `player_stats.two_k`. Equal. |
| `three_k` | fold | `buildMultiKills`: exactly 3 | as `two_k`, `c=3` | `player_stats.three_k`. Equal. |
| `four_k` | fold | `buildMultiKills`: exactly 4 | as `two_k`, `c=4` | `player_stats.four_k`. Equal. |
| `five_k` | fold | `buildMultiKills`: 5 or more | as `two_k`, `c>=5` | `player_stats.five_k`. **No data** (all 0). |
| `utility_damage` | fold | `agg.hurt`: capped enemy damage where `h.isUtility` (`isUtilityEquipment`, `helpers.go`; the set is `models.IsUtilityWeapon`) | `utility_damage`: `sum(capped_dmg)` over enemy damage events where weapon is one of the six utility weapons | `player_stats.utility_damage`. Equal with all six grenade names (an HE/fire-only list mismatched 16 rows). |
| `enemies_flashed` | fold | `agg.blind`: thrower credited once per blinded enemy (cross-team, not self) | `enemies_flashed`: `count(*) FROM events WHERE kind='blind' AND attacker<>victim AND attacker/victim not same side GROUP BY attacker` | `player_stats.enemies_flashed`. Equal with the side rule (64 rows differ if sides are ignored). |
| `flashed_times` | fold | `agg.blind`: every blind of the player, incl. self and teammate flashes | `flashed_times`: `count(*) FROM events WHERE kind='blind' GROUP BY victim` | `player_stats.flashed_times`. Equal. |
| `bomb_plants` | fold | `agg.bombPlanted` (`real` only) | `bomb_plants`: `count(*) FROM events WHERE kind='bomb_plant' GROUP BY attacker` | `player_stats.bomb_plants`. Equal. |
| `bomb_defuses` | fold | `agg.bombDefused` (`real` only) | `bomb_defuses`: `count(*)` of `bomb_defuse` | `player_stats.bomb_defuses`. Equal. |
| `money_spent_total` | fact (judgement) | Final-roster read `pl.MoneySpentTotal()` (`extract.go` → `agg.applyFinal`): the engine's cumulative `m_iTotalCashSpent` at demo end. Not a fold in the code | If kept: not a metric, it is the engine's final counter. A metric `sum(round_player_money.spent)` does **not** reproduce it | `player_stats.money_spent_total`. `sum(round_player_money.spent)` differs on 8 of 73 rows (e.g. 69,900 vs 65,400): the counter also covers rounds with no end sample and discarded rounds. See Q3. |
| `kills_by_weapon` | fold | `agg.kill`: `weaponKills[weapon]++` per enemy kill; marshalled to JSON in `build` | `kills_by_weapon`: one row per (player, weapon): `count(*)` of enemy kills `GROUP BY attacker, weapon` (dim = weapon). The JSON blob goes. | `player_stats.kills_by_weapon`. Equal (0 mismatches against JSON built from events, sorted keys). |
| `mvps` | emulation stamp | `agg.mvpScan`: per-round delta of the engine's `m_iMVPs` counter at RoundEnd, credited to the round; knife-round MVPs absorbed | Stays (item 18). Reads of it stay a stored column. Cross-check: `rounds.mvp` | `player_stats.mvps`. Equal to `count(*) FROM rounds WHERE mvp=steam_id` (0 mismatches); both come from the same counter, so this is a consistency check, not independent. |
| `score` | emulation stamp | Final-roster read `pl.Score()` (`extract.go` → `agg.applyFinal`): the engine's scoreboard points | Stays (item 18): engine-internal point formula, no tick or event carries it | `player_stats.score`. Stored column is the reference (2722 across the snapshot). |
| `team` | fold (judgement) | Stamped by `store.SaveExtracted` via `rules.TeamKeyAt` (the team's final side) | `team`: derivable, `round_player_sides.team` is already stored per round. A metric needs it as a partition key, so it would be read from there | `round_player_sides.team`. Equal (0 mismatches; 3 rows blank = bots). See Q6. |
| `won` | fold (judgement) | Stamped by `store.SaveExtracted` via `models.WinFor` over the stored score and the player's team | `won`: `CASE team WHEN 'ct' THEN matches.score_ct>score_t ... END` over `round_player_sides.team` + `matches` | `matches.score_ct/score_t` with `team`. Equal (0 mismatches). See Q6. |

### 3.2 `player_round_stats` (one row per human per counted round; `analytics.PlayerRounds`)

| Column | Class | Computed from | Replacement metric and sketch | Snapshot raw column and check |
|---|---|---|---|---|
| `name` | fact | `analytics.PlayerRounds` copies the roster name | Not a metric. Read `players.name`. | `players.name`. |
| `kills` | fold | `PlayerRounds`: enemy kill events of the round (side from `round_player_sides`; permissive when unknown) | `round_kills` (round grain): `count(*)` of enemy kills `GROUP BY round, attacker` | `events` kills grouped by round. Sum equals `player_stats.kills` (0 mismatches). |
| `assists` | fold | `PlayerRounds`: cross-team, non-flash assister | `round_assists` (round grain), as `assists` per round | `events`, per round. Equal except 2 rows; the same cross-side gate as `player_stats.assists` (see its note). |
| `deaths` | fold | `PlayerRounds`: death events minus the fake disconnect kill | `round_deaths` (round grain) | `events`, per round, not-fake rule. Equal (0 mismatches). |
| `survived` | fold | `PlayerRounds`: no death event in the round | `round_survived`: `1 - min(1, round_deaths)` | `player_round_stats.deaths=0`. Equal (0 mismatches). |
| `dmg` | fold | `PlayerRounds`: enemy damage using **uncapped** `events.dmg` | `round_damage` (round grain): `sum(dmg)` of enemy damage events | `events.dmg` per round. Equal. Differs from the capped `total_damage` basis by design (judgement: two damage bases coexist, see Q7). |
| `util_dmg` | fold | `PlayerRounds`: enemy damage with `IsUtilityWeapon`, uncapped | `round_util_damage` (round grain) | `events.dmg`, utility weapons. Equal in structure to `dmg`. |
| `traded` | detector-derived | `PlayerRounds`: death answered by a teammate killing the killer within `cfg.TradeWindowS` | Analysis-owned; stays. The count over engagements is the metric. Needs the trade-window stub | `engagements` rows `kind='traded'` (216 rows) equals `sum(traded)` (216). |
| `kast` | detector-derived | `PlayerRounds`: `kills>0 OR assists>0 OR traded OR survived`, so it inherits the trade-window rule through `traded` | Analysis-owned through `traded`. A metric `kast` composes `round_kills`, `round_assists`, `round_survived` and the stored `traded` | `player_round_stats.kast`. Equal to the formula on the stored columns (0 mismatches). See Q8. |
| `money_start` | fact | Copy of `round_player_money.money_start` (the engine's `m_iStartAccount` sampled at RoundEnd) | Not a metric. Read `round_player_money` | `round_player_money.money_start`. Equal (0 mismatches). |
| `equip` | fact | Copy of `round_player_money.equip` (`m_unRoundStartEquipmentValue`) | as above | `round_player_money.equip`. Equal. |
| `spent` | fact | Copy of `round_player_money.spent` (`m_iCashSpentThisRound`) | as above | `round_player_money.spent`. Equal. |
| `rule_version` | detector-derived | `cfg.RuleVersion` stamped by `PlayerRounds` / `compute` | Analysis freshness stamp. Not a metric. It goes away with the stub propagation (items 19, B4) | `player_round_stats.rule_version`. Not a statistic. |
| `side` | fact | Copy of `round_player_sides.side` through `resolveRoundSides` | Not a metric. Read `round_player_sides.side` | `round_player_sides.side`. Equal (0 mismatches). |
| `won` | fold | `PlayerRounds`: `side = rounds.winner` | `round_won`: `side = rounds.winner` over `round_player_sides` JOIN `rounds` | `rounds.winner`. Equal (0 mismatches). |

### 3.3 `rounds`

| Column | Class | Computed from | Replacement | Snapshot check |
|---|---|---|---|---|
| `winner` | fact | `agg.roundEnd` from the RoundEnd event | Fact; also on the `round_end` event | `events.detail_json.winner`. Equal (0 mismatches). |
| `reason` | fact | `agg.roundEnd` | Fact | `round_end` event payload. |
| `start_tick` | fact | `agg.roundStart` | Fact | `round_start` event tick. |
| `end_tick` | fact | `agg.roundEnd` | Fact | `round_end` event tick. |
| `freeze_end_tick` | fact | `agg.freezeEnd` | Fact | Stored column is the reference. |
| `duration_s` | fold | `agg.roundEnd`: `(end_tick - start_tick) / tickRate` | `round_duration`: `(end_tick-start_tick)/matches.tick_rate` | `rounds.end_tick/start_tick` with `matches.tick_rate`. Equal (0 mismatches at 0.001). |
| `bomb_site` | fact | `agg.bombPlanted` writes the plant site into the round | Fact; equal to `events.site` of the `bomb_plant` event. Judgement: could instead be a fold (`max(site)` of the plant event) | `events` `bomb_plant`: `(bomb_site<>'')` equals "plant event exists" (0 mismatches). |
| `equip_ct`, `equip_t` | fact | `agg.freezeEnd`: team equipment value at freeze end | Fact; duplicates `round_economy.equip_value` | `round_economy.equip_value`. Equal for ct (0 mismatches). |
| `mvp` | emulation stamp | `agg.roundMVP` (announcement) and `agg.mvpScan` (m_iMVPs delta) | Stays (item 18), same reasoning as `mvps` | Matches `player_stats.mvps` totals. One round has an empty mvp. |
| `mvp_reason` | fact | `agg.roundMVP` (announcement; absent in many demos) | Fact | **No data** (0 nonempty in the snapshot). |
| `first_kill_steam` | fold (judgement) | `agg.kill`: killer of the first non-teamkill kill of the round | `first_kill`: `attacker` of the row with `min(seq)` among enemy kills of the round | `events` min-seq enemy kill. Equal (0 mismatches across 153 rounds). See Q2. |
| `first_death_steam` | fold (judgement) | `agg.kill`: the victim of that kill | `first_death`: `victim` of that row | Equal (same query). |

### 3.4 `round_economy`, `round_player_money`, `round_player_sides`

| Column | Class | Computed from | Replacement | Snapshot check |
|---|---|---|---|---|
| `round_economy.equip_value` | fact | `agg.freezeEnd`: engine team equipment value at freeze end | Fact | `rounds.equip_ct/equip_t`. Equal. |
| `round_economy.money_sampled_sum`, `money_samples` | fold over **unstored** samples | `agg.freezeEnd`: sum and count of each participant's freeze-end `money` per side | Cannot be a metric yet: the per-player freeze-end money is not stored (`round_player_money.money_start` is a different instant). Needs a new fact (per-player freeze-end sample) or the column stays. See Q9 | `round_player_money.money_start` summed by side differs on all 306 rows. Stored column is the reference. |
| `round_economy.spent` | fold over **unstored** samples | `agg.freezeEnd`: delta of the cumulative `m_iTotalCashSpent` counter per player since the previous freeze end, summed per side | Same: not reproducible from `round_player_money.spent` (differs on 156 of 306 rows: different instant and counter) | Stored column is the reference. |
| `round_economy.free_pistol_value` | fold over **unstored** samples | `agg.freezeEnd`: sum of held free default pistols (`s.freePistol`) | Same: needs the per-player sample | Stored column is the reference. |
| `round_economy.team` | fold (judgement) | `rules.TeamKeyAt` stamped by `store.SaveExtracted` | Derivable from the round side and the side switches; a stamp that metrics use as a partition key. See Q6 | Equal to `round_player_sides.team` shape. |
| `round_player_money.money_start`, `equip`, `spent` | fact | `agg.moneyEnd`: engine props sampled at RoundEnd | Fact (the source tables for the metrics) | The snapshot is the reference; 1522 rows, `spent` nonzero on 1505. |
| `round_player_sides.side` | fact | `agg.freezeEnd`: freeze-end side sample | Fact (the source for every side join) | Stored column is the reference. |
| `round_player_sides.team` | fold (judgement) | `rules.TeamKeyAt` over side, round index and side switches (`store.SaveExtracted`) | Derivable; kept as a join key. See Q6 | Equal to `player_stats.team`. |

## 4. Columns with no snapshot data to confirm against

These exist in the snapshot but every row is 0 or empty, so F2's equality
check passes vacuously and the gate each carries is unverified:

- `player_stats.teamkills` (0 nonzero). The same-side exclusion in `kills`,
  `assists`, `total_damage` and `enemies_flashed` is therefore also
  untested by this snapshot (the "equal" results above hold because no
  teamkill exists).
- `player_stats.five_k` (0 nonzero).
- `rounds.mvp_reason` (0 nonempty).
- `player_stats.shots`: data exists, but no `weapon_fire` events are stored,
  so the only reference is the stored column.

Recommendation for F2: add a synthetic or a second-demo check for the
teamkill and same-side gates, since the snapshot cannot exercise them.

## 5. Analysis-owned tables, not folds (items 19, 21)

Listed so the boundary is visible. These stay analysis-owned and store
their rows; counts and aggregates over them are metrics.

| Table / column group | Class | Why |
|---|---|---|
| `engagements` (opening, trade, traded, untraded) | detector | Trade kinds read the trade-window rule value; needs a stub |
| `clutches` | detector, to be ported | State machine over alive sets; item 19 ports it to metrics over `player_ticks` |
| `utility_events.damage`, `flash_ms`, `affected` | detector | Pairing windows (`utilPairWindowS`, `utilBurnWindowS`, `utilHEWindowS`, `utilFlashWindowS`) in `analytics/utility.go` |
| `round_classifications`, `round_side_classes` | detector | Eco thresholds from rule values (`analytics.buyClass`, `Classify`) |
| `match_trade_opps` (`opps`, `missed`) | detector | Distance-threshold rule value (`analytics/tradeopps.go`) |
| `player_career` (`matches`, `wins`) | rollup, outside the audit | Raw counts rebuilt from `player_stats`; goes with F3 |

## 6. Stamps kept under item 18 (with emulation reason)

| Stamp | Where | Emulation reason (criterion: not observable in per-tick state, requires emulating an engine rule) |
|---|---|---|
| `player_stats.mvps` | `agg.mvpScan` | The engine decides who is MVP of a round (kills, bomb actions, tiebreaks); no tick or event row carries the decision. Read from the engine's `m_iMVPs` counter delta. |
| `rounds.mvp` | `agg.roundMVP` / `agg.mvpScan` | Same decision, round grain. |
| `player_stats.score` | `agg.applyFinal` (`pl.Score()`) | The engine's scoreboard point formula; read as a final-state counter. |
| `events.capped_dmg` | `agg.hurt` / `agg.capDamage` | Per-victim HP cap replayed in event order (round 5 of the golden demo: 206 raw damage on one victim, credit at most 100); row-local and order-dependent, so not derivable by a query over events. Not a column of the audited tables; listed because `total_damage` and `utility_damage` metrics depend on it. |

Dropped for contrast (ruling 3, not stamps any more): `events.same_side`,
`events.attacker_inair`. The metric replacements above compute side from
`round_player_sides` (F2), not from `same_side`. Stamps that are
denormalizations of facts, not emulations, and so are NOT under item 18:
`player_stats.team/won/map`, `round_economy.team`, `round_player_sides.team`
(see Q6).

## 7. Columns I could not classify

None. Every column got a class. These are judgement calls, flagged
"(judgement)" in the tables: `money_spent_total`, `entry_kills`,
`entry_deaths`, `best_streak`, `rounds.first_kill_steam`,
`rounds.first_death_steam`, `team`, `won`, `round_economy.team`,
`round_player_sides.team`, `rounds.bomb_site`, `player_round_stats.rule_version`,
and the three `round_economy` sample sums (fold in code, not reproducible
as metrics until the samples are stored).

## QUESTIONS (product decisions, not decided here)

- **Q1. Post-match gate.** `realPeriod` (match started, not warmup, game
  phase) gates ten folds at ingest and is not stored on events. A metric
  over events cannot reproduce it on a demo whose tail has kills after the
  match ended. The snapshot shows no difference. Options: stamp a `real`
  flag on event rows (an ingest stamp, an emulation of engine state),
  or accept events as the truth and drop the gate (values can change
  on demos with a trailing tail, e.g. the golden demo's trailing World
  suicides noted in `helpers.go`).
- **Q2. Fold versus detector for first-of-round and streaks.** `entry_*`
  and `rounds.first_kill_steam` are "first enemy kill by seq in a round";
  `best_streak` is a running count reset by death that spans rounds. Under
  item 21 these read as sequence interpretations. I classified them as
  folds because a window function reproduces them exactly on the snapshot.
  Confirm, or move them to the detector side (`engagements` already stores
  an `opening` row per round, 153 in the snapshot).
- **Q3. `money_spent_total`.** Item 17 lists it as a fold, but the code
  stores the engine's final cumulative counter, and the sum of the
  per-round samples differs on 8 of 73 rows. Decide: keep it as a fact
  (final-state snapshot, not a metric), or redefine it as the per-round sum
  (values will differ from the snapshot, so F2's equality check cannot hold).
- **Q4. `damage_taken` basis.** The value lives in `detail_json`
  (`damageTaken`), not a typed column. A metric can read it with
  `json_extract`; decide whether to promote it to a typed event column or
  accept the JSON read.
- **Q5. Zero versus dash for `hs_pct`.** The stored column writes 0 when
  kills = 0; builtin convention 3 shows a dash for an empty pool. The
  metric will produce no value there, which differs from the snapshot's 0.
  Confirm that is acceptable for the equality check.
- **Q6. Denormalized stamps.** `team`, `won`, `map` on `player_stats` and
  `team` on three per-round tables are derivable by join. Keep them as join
  helpers (cheap partition keys for user SQL) or drop them under item 17.
- **Q7. Two damage bases.** `player_stats.total_damage` is HP-capped;
  `player_round_stats.dmg` is uncapped. After the fold removal the two
  metrics will disagree by design. Confirm that is intended or pick one
  basis.
- **Q8. `kast`.** It is a detector through `traded`. Decide whether the
  stored `player_round_stats.kast` stays as an analysis output, or the
  metric is composed from `round_kills`, `round_assists`, `round_survived`
  and the stored `traded` (the table above assumes the latter).
- **Q9. `round_economy` samples.** The money, spend and pistol sums are
  folds over per-player freeze-end samples that are not stored. Either
  store the per-player freeze-end sample as a new fact (then the sums
  become metrics) or keep the three sum columns as ingest facts.
- **Q10. Bots in the F2 check.** F2 says "every player"; builtin
  convention 2 excludes bots, and bots have no `round_player_sides`
  rows. The snapshot has 3 bot rows in `player_stats`. Confirm F2 compares
  humans only.

## DECISIONS (orchestrator, 2026-11-20)

Applied from the rules in AGENTS and PLAN §2. Open product calls are marked
OPEN and go to the owner.

- **Q1 (post-match gate): decided.** Stamp a `real` flag at ingest on event
  rows, under item 18 (engine state is emulated at ingest). Folds reproduce the
  gate from the stamp. Expect value changes only on demos with a post-match tail;
  F2 shows any change.
- **Q2 (first-of-round, streaks): decided, detector.** Item 21's criterion: a
  sequence interpretation is a detector. `entry_*`, `first_kill_steam`, first
  death and `best_streak` move to analysis-owned detectors. Their counts are
  metrics. Folding them into metrics is not a fold.
- **Q3 (`money_spent_total`): decided by the owner (2026-11-20): redefined** as
  the sum of per-round spend. The value changes from the snapshot on 8 of 73
  rows. This is the one owner-ratified exception to the equality bar: F2 checks
  the new definition against a hand computation over the per-round samples, and
  the snapshot diff for this metric is recorded, not treated as a bug.
- **Q4 (`damage_taken` in `detail_json`): decided, accept the JSON read** for
  the metric. No new typed column in this migration.
- **Q5 (`hs_pct` zero vs dash): decided, dash.** Builtin convention 3: no
  value for an empty pool. F2's equality check treats a stored 0 against a
  metric dash, with zero kills, as an expected, documented difference.
- **Q6 (denormalized stamps): decided, keep as join helpers.** They are cheap
  partition keys for user SQL. Item 17's fold removal does not apply to them.
- **Q7 (two damage bases): decided by the owner (2026-11-20).** The HP-capped
  damage is game emulation and stays an ingest stamp (`events.capped_dmg`, item
  18). The uncapped `player_round_stats.dmg` need not exist: F3 removes it, and
  round damage metrics use the capped basis.
- **Q8 (`kast`): decided, stays a stored analysis output.** Rule-derived values
  are stored at analyze time (AGENTS, Analysis-rule derived values).
- **Q9 (`round_economy` samples): decided, keep the three sum columns as ingest
  facts.** The per-player freeze-end samples are not stored, so the sums cannot
  become metrics without a new fact. Item 17's fold move does not apply.
- **Q10 (bots in F2): decided, humans only.** Builtin convention 2. Bots have no
  `round_player_sides` rows; the three bot `player_stats` rows are excluded.

### Product questions: resolved

- `money_spent_total`: redefined as the per-round sum (above).
- Damage basis: capped is the one basis; the uncapped column is removed (above).
