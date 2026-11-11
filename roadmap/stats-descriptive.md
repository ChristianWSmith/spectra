# Descriptive statistics additions — roadmap research

**Unit:** stats-descriptive · **Priority tier:** P1 · **Date:** 2026-11-10
**LoE (aggregate):** L — three M items (clutch 1vX replay mode, unused-utility data path, per-throw effectiveness) plus four 1–2-day query/view items and one XS ≈ 3–4 sequential weeks, even though seven of eight items are read-only over stored rows.
**Feasibility:** high — seven of eight items are queries/views over rows that already exist (`events`, `player_round_stats`, `round_player_sides`, `rounds`, `engagements`, `utility_events`, `clutches`, blind `detail_json`); the single blocker-class unknown is item 5's kill-time grenade inventory (new extract field or a `state.bin` sidecar read) and its required coordination with the sibling `stats-advanced` unit.

## Items in scope

1. **Kill and damage matrices** — first-class matrix tables
2. **Clutch step-by-step breakdown** — dedicated 1vX replay mode
3. **Per-match side-split table** — CT/T rounds, kills, deaths, ADR, KAST per player per match
4. **Exact opening success rate** — opening kills whose round was later won
5. **Unused utility value** — money lost on death from unthrown grenades, with an explicit price table
6. **Per-player blind-time aggregate** — total and average enemy flash seconds per player
7. **Grenades thrown by type** — per-player counts per grenade type
8. **Per-throw grenade effectiveness** — damage, enemies and teammates blinded with blind seconds, kills of blinded enemies

## Current state

- **Extract** (`internal/extract`): every kill/damage/blind/throw/detonation row lands in `events` (kind `kill|damage|blind|grenade_throw|grenade|weapon_drop|…`) with attacker/victim/weapon/`dmg`, world positions (`pos_*`/`apos_*`), `detail_json` payloads. Blind rows carry `flashDurationMs` (agg.blind); damage rows carry `health` (victim HP after the hit) + `damageTaken`; kill rows carry `nearDist` + killer/victim/assister names. The **enemy-blind credit rule** (cross-team, unknown side permissive, warmup/pregame gated) lives in `agg.blind` → `player_stats.enemies_flashed`; the **HP-capped, enemy-only** damage basis (ADR) lives in `agg.hurt`/`capDamage` → `player_stats.total_damage`/`adr`. The victim's **full inventory at the kill tick** is read authoritatively (`extract/drops.go` `dropInventory`, characterized 1174/1174) but **only the single inferred drop row is stored** (`weapon_drop`, at most one util).
- **Store** (`internal/store`): `schema.sql` baseline tables — `player_stats` (incl. `opening_kills/opening_deaths`, `enemies_flashed`, `utility_damage`, `kills_by_weapon`), `player_round_stats` (per-round K/A/D/traded/KAST/`dmg`/`util_dmg`), `rounds` (`winner`, `first_kill_steam`, `first_death_steam`, warmup/pregame), `round_player_sides` (exact per-round freeze-end sides), `engagements` (`kind = opening|trade|untraded`, distance, `won_by` = killer's team), `clutches` (size, start/end tick, `kill_ticks` JSON, `replay_anchor`, `won`, `hp_left`), `utility_events` (thrower, kind, `damage`, `flash_ms`, `affected` = JSON victim SteamIDs, det position), `player_career` (incl. `openings`/`opener_wins`). Canonical SQL consts in `queries.go` (`kastPerMatchSQL`/`kdPerMatchSQL` + career twins, `playersJoin`, `HumanOnly`/`HumanOnlyBySteamID`, `eventRowCols`), pinned rules in `GetCombatStats` (`TestGetCombatStatsSQLDecisions`), narrow payload side channels `GetBlindFlashDetails`/`GetBlindFlashDurations` (`json_extract` over `detail_json` is an established idiom).
- **Analytics** (`internal/analytics`, run at import stage `"analyze"` + `RecomputeAnalysis`): `Compute` → `Classify`, `PlayerRounds`, `Clutches`, `Engagements`, `Utility` → `Replace*` writers + `RebuildCareer`. `Utility()` already pairs throw↔detonation per row and attributes damage (burn/HE windows) and blind ms (5 s flash window), but does **not** side-split `affected` (it never receives `sides`) and does not track kills of blinded victims. `Engagements` already emits per-round `opening` rows with `won_by`. Career `opener_wins` is today just `SUM(player_stats.opening_kills)` — **not** "opening kill whose round was won" (the profile's OpeningRate is kills ÷ (kills+deaths), a duel win rate; see `definitions.js`).
- **Prices:** `models.UtilityPrice` is THE pinned canonical grenade price table (HE 300 / flash 200 / smoke 300 / molotov 400 / incendiary 500 / decoy 50, `TestUtilityPricesPinned`) — item 5's "explicit price table" exists; no other layer may re-derive prices (`econ.js` prices no gear).
- **Frontend:** Match view tabs are the canonical list `router.js MATCH_TABS` (Overview/Scoreboard/Rounds/Economy/Utility/Combat/Heatmaps/Reports/Details). Existing surfaces: Scoreboard table (`GetScoreboard` + `SortTh`, KAST% column sourced from `getCombatStats`), Utility view (per-round `utility_events` rows + team damage/flash rollups), Combat view (engagements table with filters + WON clutches card with a per-row "watch in the replay" deep link), PlayerProfile (StatCards + per-match history + trends), Reports (Go templates + metrics appendix), Builder/metrics whitelist, SQL console (any new table is queryable for free). Replay entry is one system: `nav.replayHash(id, filter, {tick, loop, sel, back})` + `entrySeekTick`/`entryLoopSpan`; engine already has frame `step(±1)`.
- **Positions:** stored per-event (kills/hurts/blinds/throws), full 64 Hz sidecar exists — but **none of these eight items needs positions** (the only distance consumer is the sibling `stats-advanced` unit).

## Implementation path

### 1. Kill and damage matrices — LoE: S
- New store read: `GROUP BY attacker, victim` over `events kind='kill'` (counts) and `kind='damage'` (Σ `dmg`, optionally HP-capped via `health` — document whichever) for one match; rows/cols = roster, cells = value + N, unknown/empty honest. Base rows humans-only via `HumanOnly` (it is an aggregate surface); note the deliberate bot-name exception for event-shaped cells if we ever show raw kill-feed rows.
- New DTO (`models`) + `AnalyticsService.GetMatrix(matchID, kind)` beside `GetCombatStats`; no schema change, no extract change.
- Surface: new section in the Combat tab (two grids, kill matrix + damage matrix) or a new `MATCH_TABS` entry — Combat is the cheaper, more coherent home. `StatCard` for the "hardest victim / easiest duel" callouts; `definitions.js` glossary entry for the formula + N.
- Optional follow-through: add to `internal/metrics` whitelist sources and the whole-match export (see overlaps).

### 2. Clutch step-by-step breakdown — LoE: M (replay UI feature, not just a stat)
- Data is complete: `clutches` rows carry `start_tick`/`end_tick`/`kill_ticks` (JSON array)/`hp_left`/`won`/`replay_anchor`, and Combat already deep-links a clutch into Replay. The work is the **mode**: a clutch picker/step list inside Replay (entry from Combat rows and a PlayerProfile/round chip), seek to `start_tick`, then step milestone-to-milestone (each kill tick, then resolve) with a compact HUD: 1vN size, alive counts, HP, bomb state, kills so far — all readable from stored rows + the existing state stream.
- Touches: `Replay.svelte` (panel + mode state), a small `lib/replay/` helper (clutch step list builder, twin of the landmark feed), `nav.replayHash` extras if the mode is URL-addressable (deep-linkable, per the one-navigation-system rule), `Combat.svelte` entry button.
- No extract/store changes. Keep it a consumer of `GetClutches`; do not fork clutch detection (`analytics/clutches.go` stays the one owner).

### 3. Per-match side-split table — LoE: S
- One new store query: per player × side over `player_round_stats` ⋈ `round_player_sides` (exact freeze-end samples) ⋈ `rounds` — rounds played per side, round wins (winner == player's side), K/A/D, KAST% (`AVG(prs.kast)` per side, same spelling as `kastPerMatchSQL`), damage. A round with no side sample → unknown side column, never a guess (AGENTS missing-data rule).
- **ADR basis decision (the one design call):** `prs.dmg` is raw attacker damage (includes FF/overkill) and will not equal the headline `ps.adr` (HP-capped, enemy-only, `agg.capDamage`). Either (a) compute HP-capped enemy damage per round in the analytics pass (hurt `health` details are already injected into `evs` by `Compute` for clutch HP — same injection can feed a cap in `PlayerRounds`, adding a column) or (b) show side damage on the raw basis with a documented formula + badge. Do not present a number that contradicts the scoreboard's ADR.
- Surface: Scoreboard tab toggle/sub-table ("CT | T" column groups) via `GetScoreboard` extension or a sibling read; `definitions.js` entry. No extract change; a new `player_round_stats` column would need the deliberate reimport (see risks).

### 4. Exact opening success rate — LoE: S
- Pure query: opening engagement rows (`engagements kind='opening'`, or `rounds.first_kill_steam`) ⋈ `rounds.winner` + the opener's side in that round (`round_player_sides`) → won/lost/not-stated; numerator = opening kills whose round was later won, denominator = opening kills (state both N and the exclusion of rounds with unknown sides). `engagements.won_by` already carries the killer's team, so the join is `won_by = rounds.winner`.
- New SQL const beside `kastPerMatchSQL`/`kdPerMatchSQL` in `queries.go`; read via `MatchService`/`AnalyticsService`; surface as a Scoreboard column/tooltip and a PlayerProfile StatCard. **Reconcile with the existing career `opener_wins`/`OpeningRate`** (today: duel win rate) — one owner, two clearly-named metrics, `definitions.js` text updated in the same change.

### 5. Unused utility value — LoE: M (needs a new data path; coordinate with `stats-advanced` item 4)
- Price table exists (`models.UtilityPrice` — surface it verbatim next to the $ figure). What's missing is the **victim's full grenade inventory at death**: the stored `weapon_drop` row carries at most ONE util (the drop rule), so drop rows alone under-count.
- Two candidate paths, pick one (the sibling unit's doc flags this as "must be one implementation"):
  1. **Extract-time stamp** — `agg.kill` already has `k.inv`; append the util names (+ prices) to the kill's `detail_json`. Cheap and sidecar-free, but forces a library reimport and a deliberate golden-fixture regeneration (`TestParseGolden`/kill-key pins), plus `Reprocess` for existing demos.
  2. **Analyze-time sidecar read** — `state.bin` carries full inventory per frame; read the victim's inventory at their death tick (`sidecar.Load` precedent in `heatmapPresence`). No reimport, but `Compute` gains a sidecar dependency and sidecar-less imports must fail soft ("unknown + N").
- Derivation is then trivial: Σ `UtilityPrice` over `IsUtilityWeapon` entries at death, per player/match; optionally split "bought-but-unthrown" from ground-picked-up (not distinguishable — document). Surface: Combat/Utility tab column + PlayerProfile aggregate + a Moments jump for the sibling's self-review list.

### 6. Per-player blind-time aggregate — LoE: S
- Data exists: `events kind='blind'` with `attacker`/`victim` + `detail_json.flashDurationMs` (read exactly like `GetBlindFlashDurations`). New store query: Σ ms and COUNT per attacker, gated to counted rounds (`rounds.warmup=0 AND pregame=0`) and to **enemy** blinds by joining `round_player_sides` (attacker side ≠ victim side in that round; mirror extract's permissive unknown-side rule or document the divergence), humans-only row set.
- Average = total ÷ enemy blinds (state N); no fabricated denominators. Surface: Utility tab summary strip (beside today's per-team flash rollup) and/or a PlayerProfile StatCard; `definitions.js` glossary entry (CS2.md "Enemies flashed" is the count convention this extends to seconds).
- Career-level totals would need a `player_career` column + `RebuildCareer` change (reimport) — match-scope first, career later.

### 7. Grenades thrown by type — LoE: XS
- `GROUP BY attacker, weapon` over `events kind='grenade_throw'`, projected to the canonical kind via `models.UtilityWeaponKind` (Molotov ≡ Incendiary). One new store read + a small per-player table (Utility tab rollup, or a Scoreboard expander). No schema/extract change; flash double-detonation rows are a `grenade` (detonation) artifact and do not affect throw counts.

### 8. Per-throw grenade effectiveness — LoE: M
- `utility_events` already stores per-detonation `damage`, `flash_ms`, `affected` (JSON victims), `kind`, thrower. Missing: (a) **enemy vs teammate split** of `affected` + blind seconds, (b) **kills of blinded enemies**.
- Path: extend `analytics.Utility` — pass `sides` (Compute already loads `GetRoundPlayerSides`; today `Utility()` doesn't receive it), split victims cross-team per round, and attribute kills: a kill whose victim is in this flash's blind set within the blind window (reuse `utilFlashWindowS` / the victim's blind-event interval) → `kills` count. Either (i) new columns on `utility_events` (schema change → reimport; baseline `CREATE IF NOT EXISTS` won't alter existing DBs) or (ii) a read-time join in the store that recomputes the split from `events` + `round_player_sides` (no schema change, but the window/attribution rule would then live in SQL, forking `Utility`'s one-owner rule). Prefer (i) — one computation owner, `RecomputeAnalysis` refreshes it.
- Surface: Utility view per-throw columns (enemies/teammates blinded, blind s, kills) + per-thrower rollup; formula + N in `definitions.js`.

## Existing scaffolding to reuse

- `analytics.Compute` / `ConfigFrom` / `analysis_config` / `RecomputeAnalysis` — the one home for new derived rows (items 3-ADR option, 5 sidecar path, 8).
- `store/queries.go` canonical consts (`kastPerMatchSQL`, `playersJoin`, `HumanOnly*`), `GetCombatStats` pinned-decisions + `TestGetCombatStatsSQLDecisions` pattern for documenting SQL rules, `GetBlindFlashDurations` (`json_extract` idiom) for item 6.
- `engagements` rows + `rounds.first_kill_*` for item 4; `clutches` rows + `analytics/clutches.go` (never a second detector) for item 2.
- `models.UtilityPrice`/`IsUtilityWeapon`/`UtilityWeaponKind` (items 5, 7, 8), `models.WinFor` for round/match wins.
- Frontend: `MATCH_TABS` + `SelectTab` deep-linking, Combat/Utility/Scoreboard table patterns (`SortTh`, `StatCard`), `listedPlayers`/`isHuman`, `lib/teams.js playerSideClassAt` for per-round side colors, `nav.replayHash`/`entryLoopSpan` for every "watch this" jump, `definitions.js` for every new metric string, `services.js cachedRead` for on-demand reads, `LandmarkRow` for event-shaped drill-down rows.
- `internal/query/schema.go` table descriptions — register any new table so the SQL console documents it.

## Dependencies & overlaps

- **`stats-advanced` (sibling unit):** its item 4 (self-review mistake moments) contains the *same* unused-grenades detector — **one implementation, shared vocabulary** (its doc says so explicitly); its item 3 distance tables are the natural neighbors of item 1's matrices; its habit mining consumes items 6/7/8 aggregates as inputs. Co-schedule or the orchestrator will get two detectors.
- **Ratings/benchmarks tier:** blind seconds, grenade counts and exact opening success are rating/Profile inputs — definitions must land in `definitions.js` once so rating formulas reuse them.
- **Replay:** item 2 is a replay feature (mode + HUD); items 1/3/4/5/8 are pure consumers via `replayHash` seeks. No engine changes needed beyond a step-to-tick helper (frame `step` exists).
- **Video/highlights:** `clutches.kill_ticks` is the highlight-detection source for clutches; mistake flagging (video tier) must reuse item 5's $-lost detector.
- **Export & scripting:** "Whole-match stats file export" (34 CSV tables) and the metrics whitelist should cover the new matrices/aggregates in the same wave, or they'll be re-derived by users in the SQL console anyway.
- **Library:** item 5 extract path ⇒ full reimport + deliberate golden-fixture regen; analyze-stage rows ride the existing `"analyze"` job (never a second job event stream); career-level columns (items 6/7) ride `RebuildCareer`.
- **Annotations:** clutch steps and $-lost deaths are natural bookmark seeds later. **Localization:** new strings ship English (`definitions.js`) until localization lands. **Metadata:** per-shot telemetry (later) is irrelevant to all eight.

## Risks & unknowns

- **Definition decisions are the main risk** (AGENTS: look up, don't guess): opening-success denominator and unknown-side handling; side-split ADR basis (raw vs HP-capped — a mismatched number is an honest-metrics violation); blind-seconds "average" denominator; matrix scope (enemy-only, bots, teamkills, warmup); "kill of a blinded enemy" attribution window (no canonical source in CS2.md).
- **Events carry no team column** — every side-dependent stat joins `round_player_sides`; a round without samples must yield "unknown + N", and extract's *permissive* unknown-side rules (`!sameSide` counts unknown as enemy) must either be mirrored exactly in SQL or explicitly documented as a divergence, or two layers will disagree.
- **Schema policy:** added columns do not reach existing DBs (no migrations; baseline is `CREATE … IF NOT EXISTS`) — any new column ⇒ dev-DB wipe/reimport, acceptable pre-1.0 but it forces fixture regen discipline if extract changes (item 5 path 1). Prefer new tables or read-time computation where the one-owner rule allows.
- **Sidecar dependency** (item 5 path 2): `ErrNoSidecar`/`position_frames = 0` on old imports → two data-quality tiers; must fail soft with N, never a guessed $0.
- **Existing-metric drift:** touching career `opener_wins`/`OpeningRate` (item 4) or `prs.dmg` semantics (item 3) ripples into profile/Reports/metrics consumers — change name and formula together, with tests pinning both.
- **UI density:** four of these want space in already-dense Match tabs; the cockpit/simplicity rubric means folding into existing tables (Scoreboard/Utility/Combat) before proposing a new tab.
