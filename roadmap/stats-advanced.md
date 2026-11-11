# Advanced analytics — roadmap research

**Unit:** stats-advanced · **Priority tier:** P1 · **Date:** 2026-11-10
**LoE (aggregate):** L — three M's plus one L sharing new statistical/rule machinery and one new sidecar-reading pass; several weeks even with heavy reuse.
**Feasibility:** high — every item grounds out on data that already exists (kill `distance` + world positions, untraded/`nearDist` rows, the 64 Hz position+yaw sidecar, `analysis_config` thresholds, `replayHash` tick seeks); no hard blockers, only definition research and library-scale sidecar cost.

## Items in scope

1. **Player habit / pattern mining** — predictability index, roles with reasons, stable patterns with confidence intervals and tunable thresholds
2. **Conditions → actions frequency tables** — each round rendered as "conditions → decision"
3. **Duel stance and distance analysis** — peek-vs-hold classification and duel results by distance bucket
4. **Self-review mistake moments** — untraded deaths, isolated deaths, unused grenades ($ lost), re-peeks, each with a `demo_gototick` jump

## Current state

- **Pass structure:** extract → `SaveExtracted` → library worker stage `"analyze"` runs `analytics.Compute` per match (pure-DB read of rounds/economy/events/players/sides → `Classify`, `PlayerRounds`, `Clutches`, `Engagements`, `Utility` → `Replace*` writers + `RebuildCareer`). `AnalyticsService.RecomputeAnalysis` re-runs it on demand. This is THE canonical home for new per-match derived rows; career-scale rollups follow the `RebuildCareer` pattern (seconds at 1k matches with the Tier-1 indexes).
- **Conditions already stored:** per-round per-side equip/money (`round_economy`), buy classification with required explanation (`round_classifications` — label/confidence/explanation, the transparent-rules precedent), score/winner/reason/bomb_site/first-kill (`rounds`), exact per-round sides (`round_player_sides`), per-player per-round K/D/traded/KAST/equip (`player_round_stats`), economy view + per-side buy classes (`analytics/classify.go`, thresholds from `analysis_config`), clutches, `engagements` (opening/trade/untraded with distance and won_by).
- **Distances:** every kill stores `events.distance` (demoinfocs `player_death.Distance`) plus both world positions (`pos_*`/`apos_*`); `engagements.distance` copies it; kill `detail_json.nearDist` is the extract-time nearest-living-teammate-of-victim distance behind `TradeOppMissed` (CS2.md documents the Leetify trade-opportunity reading).
- **Positions:** `internal/sidecar` — `positions.bin` at full 64 Hz: x/y/z (1 u quantized), **view yaw**, airborne/ducking/side flags per player per frame; `state.bin` sparse stream: hp, armor, active weapon, **full inventory**, ammo, **attack-button held**, money, helmet, reloading. Presence mirrored in `matches.sample_rate/position_frames`. Go whole-stream readers already exist: `sidecar.Load` in `AnalyticsService.heatmapPresence` and `internal/spatial` (spacing/spread series — its package doc records that **pattern detectors were descoped in M5** pending map-region polygons; polygon-free position patterns remain open).
- **Statistics machinery:** `internal/metrics` custom-metric engine — frozen v1 grammar over whitelisted sources (events, engagements, rounds, player_stats, player_round_stats, round_economy, clutches, utility_events, chat), `group_by`, stddev/percentile/median/ratio, Value-0-with-N honesty, Builder UI with builtin/user/plugin origins. No confidence-interval or probability helpers exist anywhere — Wilson/binomial CI code would be new (stdlib-only, per dependency minimalism).
- **Tick jump:** solved, no engine work. `nav.replayHash(matchId, filter, {tick, loop, sel, back})` + `entrySeekTick`/`entryLoopRange`/`entryLoopAround` are the one entry point; the Combat tab already deep-links engagement rows into Replay with ±10 s loops; `LandmarkRow` carries a per-row seek button. `demo_gototick` is an in-game console command (no CS2.md entry) — its in-app analog is the `?tick=` Replay entry seek.
- **Trade/untraded rule:** one owner — `analytics/engagements.go`, window from `analysis_config` (CS2.md pins the 5 s HLTV/KAST definition).
- **Frontend surfaces:** Match tabs (Rounds classification chips, Economy, Combat's engagement table with distance-in-metres and seek links), PlayerProfile (career/trends), Reports, Builder; canonical event-row renderer `lib/components/LandmarkRow.svelte`.

## Implementation path

### 1. Player habit / pattern mining — LoE: L
- **Features, v1 = DB-only:** weapon mix (`player_stats.kills_by_weapon`), opening/entry/trade rates, utility usage counts, site lean (`rounds.bomb_site` + plant events), save/commit and side habits — career aggregates as new SQL consts beside the KAST/K-D per-match/career consts in `store/queries.go`, humans-only via `HumanOnly`/`HumanOnlyBySteamID`.
- **Detectors:** new pure functions in `internal/analytics` emitting pattern rows `{feature, observed rate, N, CI, support, threshold, why}` — Wilson intervals in a small new Go helper; "stable" = support ≥ min-N plus a CI-width/exclusion criterion; `why` strings follow the `buyClass`/`round_classifications` explanation requirement.
- **Tunable thresholds:** extend `analysis_config` (GetConfig/SetConfig validation + `rule_version` bump + `RecomputeAnalysis` recompute is the established shape); long-term home is the roadmap's "User-authored YAML metric rules" — keep the field names aligned.
- **Roles with reasons:** rule-based classifier over the same aggregates (entry/anchor/AWP/support/lurk-style labels each carrying the triggering statistics and N).
- **Predictability index:** dispersion over the per-condition decision distribution — computed **from item 2's condition/decision vocabulary** (dependency below).
- **Storage/UI:** career-level rows rebuilt `RebuildCareer`-style at the end of `Compute`, read by a new PlayerProfile section; thresholds in Settings' analysis-rules block. Position-derived habits (spot predictability) are a separate scope decision — they need per-match sidecar streaming (`internal/spatial` precedent), keep v1 DB-only.

### 2. Conditions → actions frequency tables — LoE: M
- **Vocabulary:** design the condition vector (per counted round: score state, pistol, both sides' buy classes, equip diff, opening death for/against, side, man-count at freeze end from kill events) and decision vector (buy executed per side, bomb site, save vs commit, round outcome/pace) — every input is already stored; the design is the research part.
- **Rows:** one new pure `Classify`-sibling function in `internal/analytics`, one row per counted round with condition + decision + explanation; written by `Compute` into a new `round_decisions` table (or a structured extension of `round_classifications`).
- **Frequency tables:** read-time `GROUP BY` cross-tabs over those rows, match scope first, whole library after (dedicated `AnalyticsService` read, and/or the new table added to the metrics whitelist so the Builder can express user cross-tabs — the user-extendable shape PRODUCT.md asks for).
- **UI:** Rounds tab gains the per-round "conditions → decision" cell (classification-chip precedent); cross-tab frequency panel in Reports. No sidecar needed.

### 3. Duel stance and distance analysis — LoE: M
- **Distance buckets (the easy half, S on its own):** bucketed aggregation over existing `engagements.distance`/`events.distance` (kill = attacker side won, victim side lost; opening subset free) — grouped counts/win-rates by bucket rendered in the Combat tab beside today's metre column. Widening "duel" beyond kills to damage exchanges means computing distance from stored `pos_*`/`apos_*` (definition decision).
- **Peek-vs-hold (the driver):** a NEW sidecar-reading classifier — stream frames around each engagement tick (`sidecar.Load` precedent in heatmapPresence/spatial) and classify from: velocity by frame-diff of quantized positions (smooth 2–4 frames to beat the 1 u quantization), **yaw sweep vs stability** (hold = stable yaw + near-zero displacement pre-engagement; peek = displacement toward the angle with yaw change), ducking/airborne flags, corroborated by `sound_events` footsteps (running = committed wide peek) and `state.bin`'s Attack bit. Output: stance label + confidence + explanation per engagement row.
- **Compute placement:** v1 on-demand per match + `cachedRead` (keeps `Compute` store-pure, avoids whole-library sidecar scans); promoting to analyze-stage is a later decision.
- **Definitions:** no canonical CS2 definition of peek/hold exists (CS2.md silent) — AGENTS requires looking it up / defining it, then documenting the formula and N (honest metrics). Thresholds ride `analysis_config`.

### 4. Self-review mistake moments — LoE: M
Four detectors, one moments surface:
- **Untraded deaths:** already stored (`engagements kind=untraded`) — surfacing + jump only (S).
- **Isolated deaths:** existing proxies ready — `TradeOppMissed` (nearDist ≤ configured distance, `store.GetCombatStats`) and the `isolated_deaths` builtin metric; true spatial isolation (nearest living teammate over time) reuses item 3's sidecar machinery.
- **Unused grenades ($ lost):** victim kill-time inventory is already read authoritatively at extract (`extract/drops.go`), or reconstructable per death frame from `state.bin` inventory; price from `models.UtilityPrice` (the pinned canonical table). Extract-time stamping needs a library reimport (no-migrations policy); analyze-time sidecar reading does not. **Directly overlaps the sibling roadmap item "Unused utility value" — must be one implementation.**
- **Re-peeks:** new definition (no canonical source): returning to a position/angle within N seconds of a prior engagement or death there — sidecar positions around death/engagement ticks, thresholds configurable.
- **Moments list + jump:** derived match-scope rows `{kind, tick, round, player, why, severity}` written alongside `Compute`; UI is a Moments panel (PlayerProfile self-review scope + Match Reports) with rows on the `LandmarkRow` seek affordance and a "watch" action = `replayHash(id, filter, {tick, loop: entryLoopAround(tick)})` — the jump itself is done; the work is detection + vocabulary. Must share one detector vocabulary with the roadmap's "Automatic mistake flagging" (built-ins + user-extendable) instead of growing a second rule layer.

## Existing scaffolding to reuse

- `analytics.Compute` + `ConfigFrom` + `analysis_config` (thresholds, validation, `rule_version`, explicit recompute) — the whole config/recompute contract for items 1–4.
- `analytics/classify.go` buy-class labels with required `why` strings; `round_classifications` label/confidence/explanation columns — the transparency template for every new classification (stance, condition/decision, pattern, moment).
- `analytics/engagements.go` (one-owner trade/untraded rule), `store.GetCombatStats` (TradeOppMissed gating, `TestGetCombatStatsSQLDecisions`), `store.CountPlayerTradeOpportunities`, CS2.md trade/opportunity entries.
- Stored distances: `events.distance`, `engagements.distance`, kill `pos_*`/`apos_*`, `detail_json.nearDist`.
- `internal/sidecar` (`sidecar.Load` whole-stream reads), `internal/spatial` (the sidecar-derived series pattern), `AnalyticsService.heatmapPresence` (Go-side streaming precedent).
- `internal/metrics` (whitelist sources, group_by, honest Value+N) + Builder view — user-extendable expression layer for the frequency tables and pattern inputs; SQL console sees any new table for free.
- `store.RebuildCareer` (career-scale rebuild cadence), `HumanOnly`/`HumanOnlyBySteamID`, career SQL consts in `store/queries.go`.
- Frontend: `nav.replayHash`/`entrySeekTick`/`entryLoopAround` (the jump), `LandmarkRow` (seek-row rendering), Combat engagement table (distance + deep-link precedent), Rounds-tab classification chips, PlayerProfile, `services.js` `cachedRead` (on-demand cached reads flushed on `spectra:*`).
- `models.UtilityPrice` pinned price table + `extract/drops.go` authoritative kill-time inventory read.

## Dependencies & overlaps

- **Item 1 → item 2:** the predictability index is defined over item 2's per-condition decision distribution — build the condition/decision vocabulary first (or as one shared module).
- **Sibling statistics-tier items:** "Unused utility value" (identical computation to item 4's grenade detector), "Exact opening success rate" and "Kill and damage matrices" (item 3's distance tables), "Cross-library player overview" + "Progress graphs and personal records" (item 1's PlayerProfile surface and trend framing), "Grenades thrown by type" / "Per-throw grenade effectiveness" / "Per-player blind-time aggregate" (item 1 feature inputs).
- **Ratings tier:** "Composite rating metric — user-extendable" shares the tunable-threshold/user-extendable config story; roles/patterns must plug into that same extension surface, not fork it.
- **Export & scripting:** "User-authored YAML metric rules" is the intended long-term home for thresholds/pattern rules (`analysis_config` is the built-in stopgap); new rows should be covered by "Whole-match stats file export" and listed as metrics sources.
- **Video tier:** "Automatic mistake flagging" and "Rule-driven highlight detection" must consume item 4's detector vocabulary (one engine, built-ins + user-extendable) — orchestrator should co-schedule.
- **Replay:** pure consumer (seek/loop entry URLs); "Vision cones" later shares yaw signals but no logic. **Annotations/bookmarks:** moments rows are natural bookmark seeds (later). **Lineups:** item 1 utility/site habits link out once the lineup library exists.
- **Library:** new derived tables ride the existing per-import `"analyze"` stage; any whole-library recompute must stay a coalesced job path, never a second job/progress event stream (`spectra:job-progress` rule).
- **Metadata/localization:** stored reason strings stay English-in-DB (round_classifications precedent) until localization lands; per-shot aim telemetry (metadata tier, "later") would later strengthen peek detection with per-shot yaw/recoil.

## Risks & unknowns

- **Definition research is the core risk:** peek-vs-hold, re-peek, predictability index, role taxonomy and "stable pattern" criteria have no canonical definitions (CS2.md silent) — each needs a lookup (AGENTS domain rule) and a pinned, documented spectra formula with its N; item 1 is rated L chiefly because this catalogue is open-ended.
- **Library-scale cost:** position sidecars (~2.5 MB zstd/match on the golden demo) decoded whole per pass — fine per match on demand, minutes at 1k matches if batched. Keep sidecar-dependent detectors on-demand + `cachedRead` for v1; DB-only career passes match `RebuildCareer`'s measured cost class.
- **Schema policy:** new baseline tables are cheap (`CREATE … IF NOT EXISTS` on every Open), but **added columns to existing tables do not reach existing DBs** (no migrations by policy) — prefer new tables; any change implies dev-DB wipe/reimport, acceptable pre-1.0.
- **Sidecar absence fails soft** (`ErrNoSidecar`/`ErrNoState`, `position_frames = 0` on old imports) — detectors must surface "unknown + N", never a guessed value (honest metrics), which means item 3/4 outputs have two data-quality tiers.
- **Extract-time vs analyze-time placement:** stamping features at extract (stance, $-lost) forces a full-library reimport; analyze-time sidecar reads avoid that but add a sidecar dependency to `Compute`'s orchestration (currently store-pure).
- **Overlap de-confliction** (mistake flagging vs item 4, unused utility vs item 4, opening-success/matrices vs item 3, ratings vs item 1) is orchestrator work — the risk is two teams building two detectors for one rule.
