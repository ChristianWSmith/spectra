# Rating, progress & player overview — roadmap research

**Unit:** stats-rating · **Priority tier:** P1 · **Date:** 2026-11-10
**LoE (aggregate):** L — item 1 (M) needs formula research + analytics-pass
work, item 2 (M) is mostly frontend over the existing trend series, item 3
(L) adds five new cross-library surfaces (rank/teammates/H2H/benchmarks/
achievements); no hard blockers, but the total is several weeks.
**Feasibility:** high — every input already exists in `player_stats` /
`player_round_stats` / `players` / `clutches`; blockers are honest-labelling
of an *approximate* HLTV 2.0 reproduction (exact weights are unpublished)
and unverified rank-data semantics/availability.

## Items in scope

1. **Composite rating metric** — HLTV Rating 1.0/2.0 reproduction plus our own documented rating, user-extendable
2. **Progress graphs and personal records** — performance over rolling match windows, achievements/personal bests
3. **Cross-library player overview** — trends, rank history, teammates, head-to-head, benchmarks and achievements for one player across every demo

## Current state

- **Metrics are definitions, computed on read.** The `metrics` table
  (`internal/store/schema.sql`, builtin ids 1–7 seeded from PRD §5.16)
  stores `origin=builtin|user|plugin` rows; `internal/metrics` (frozen v1
  grammar — `internal/metrics/doc.go`) parses a *single-source*
  expression (`from player_stats: ratio(kills, deaths)`), compiles it to
  parameterized SQL and runs it on the read-only session via
  `MetricsService.PreviewMetric` (library or `match:<id>` scope, row cap,
  `Value 0` beside `N` for missing data). **Nothing metric-valued is
  persisted** — only definitions. Pinned metrics render as extra Match
  scoreboard columns (`frontend/src/lib/views/Match.svelte`, pins in
  `localStorage spectra:pinned-metrics`), the Builder view is the custom
  metric builder, Reports previews metrics per scope.
- **Plugin metrics:** `plugin.MetricDef` (manifest JSON contract,
  `internal/plugin/manifest.go`) → `store.PluginMetricDef` (write input,
  `internal/plugin/manager.go metricDefs`) → `store.ReplacePluginMetrics`
  into the same `metrics` table (`platform_store.go`, byte-compatible DDL
  contract). Both ride the same frozen expression engine — **the v1
  grammar cannot express a weighted composite**: no arithmetic between
  aggregations (only `ratio(a,b)` = division), no joins, single source.
- **Analytics pass → columns:** `analytics.Compute` (orchestrated from
  `internal/library` on import and `analyticservice.go` on rule change)
  rewrites per-match derived tables (`player_round_stats` incl. KAST,
  `engagements`, `clutches`, `utility_events`) and `player_stats`
  rule-aware columns (e.g. `trade_kills`), then `store.RebuildCareer`
  refreshes the `player_career` rollup (matches/wins/adr_avg/adr_std/kd/
  hs_pct/kast_pct/openings/opener_wins/trades/clutches). Extract-time
  columns (`adr`, `hs_pct`, `opening_kills`, `two_k..five_k`,
  `best_streak`, …) live in `player_stats`. **This pass is the natural
  home for a stored rating column.**
- **Career/profile surfaces already exist** (item 3's base):
  `ProfileService` (`profileservice.go`) — `GetProfile` (career cards,
  per-round side splits, per-map, weapons, ≤100-row history),
  `GetCareerTrend(adr|kast|kd|hs)` (`store.GetTrend`, full per-match
  series oldest→newest, HumanOnly), `ListPlayers` → `Profiles.svelte`
  directory; frontend `PlayerProfile.svelte` has hand-rolled SVG
  sparklines (no chart lib), `StatCard`s, tooltip strings from
  `lib/definitions.js`.
- **Charting pattern:** hand-rolled SVG only — `EconCurve.svelte`
  (two-series economy curve, hover readout, click-through) and the
  PlayerProfile sparkline. No chart library anywhere (dependency
  minimalism preference).
- **Nothing exists for:** achievements, personal records, benchmarks,
  head-to-head, teammate lists, rank display (though see below), rolling
  windows. No `ROW_NUMBER`/window-function usage yet (modernc SQLite
  supports them if needed).
- **Rank data IS already extracted** but never displayed:
  `players.rank/rank_type/wins` are written from `m_iCompetitiveRanking`,
  `m_iCompetitiveRankingType`, `m_iCompetitiveWins` at the end-of-demo
  roster (`extract.go finalPlayer` → `lifecycle.go` insert). One snapshot
  per player per demo.
- **Ordering caveat:** `matches` has no played-at date yet — trends and
  history order by `extracted_at` (metadata unit adds played-at).

## Implementation path

### 1. Composite rating metric — **M** (up to a week)

- **Step 0 (documentation obligation, do first):** CS2.md has *no* rating
  formula entry — only a trade-window citation of the Rating 3.0 article.
  Research + append entries (could not be done here: one-file constraint):
  - **Rating 1.0** — structure known and reproducible: Kill rating =
    (K/R)/0.679, Survival = ((R−D)/R)/0.317, Multikill rating =
    ((1K+4·2K+9·3K+16·4K+25·5K)/R)/1.277, combined
    (K + 0.7·S + M)/2.7; constants are *historical longitudinal averages*
    (source: chrissardegna.com/blog/problems-with-csgo-rating-systems/,
    2017-09-20; retrieved 2026-11-10) → a local library cannot match a
    live-population baseline, document which constants we pin.
  - **Rating 2.0** — HLTV **never published the weights** ("the exact
    formula won't be public", hltv.org/news/20695, 2017-06-14): official
    components are 5 per side (Kill, Survival, KAST, Impact, Damage,
    side-split z-scores). Best available: reverse-engineered linear
    approximation (R²≈0.995), `0.0073·KAST + 0.3591·KPR − 0.5329·DPR +
    0.2372·Impact + 0.0032·ADR + 0.1587`, with `Impact ≈ 2.13·KPR +
    0.42·APR − 0.41` (flashed.gg/posts/reverse-engineering-hltv-rating/,
    dave.xn--tckwe, 2021-01-09; retrieved 2026-11-10). **"Reproduction"
    = documented approximation, labelled as such** (honest-metrics rule).
  - **Rating 3.0/2.1** — out of the roadmap item's scope; note that 3.0
    (hltv.org/news/42485, 2025-08-20, rebalanced 2025-10-31) is
    *event-normalized* with unpublished, repeatedly re-tuned constants and
    Round Swing over win-probability → not reproducible offline; record
    why we don't attempt it.
- **Compute:** new Go-side rating computation with all inputs already
  stored — KAST (`player_round_stats.kast`, canonical
  `store.kastPerMatchSQL`), ADR/K/D/rounds/openings/2K–5K
  (`player_stats`; one-kill count derivable from `player_round_stats`),
  clutches (`clutches`), assists. Two placement options:
  - **(a) stored column** written by `analytics.Compute` (precedent:
    `trade_kills` rewrite) → sortable scoreboard column, cheap profile
    reads; implies `schema.sql` edit + `<table>Cols` const update
    (`TestColumnListConstsMatchSchema`) + pre-release re-import (no
    migrations by policy), and re-run semantics when rules change;
  - **(b) compute-on-read** store SQL (precedent: `GetCombatStats`) →
    no schema change, but every surface re-derives it.
  Recommend (a) for rating (it feeds scoreboard sort + history + trends).
- **Surfacing:** Match scoreboard column, profile `StatCard`, trend
  metric added to `trendMetricWhitelist`, `definitions.js` glossary entry
  with the full formula string (the metric `doc` defaults to
  `Formula: <expr>` — rating's doc must state the pinned constants),
  report templates pick it up via the existing metric/report plumbing.
- **"Our own documented rating":** a second Go-side built-in with an
  owner-chosen formula, documented identically — no new mechanism needed.
- **"User-extendable":** rides on the *existing* plugin/metric-builder
  surface for component metrics (already shipped), NOT on a new system.
  The frozen v1 grammar cannot express composites — do **not** fork it
  here; a more expressive YAML/builder direction already exists as its
  own roadmap item ("User-authored YAML metric rules", Export unit).

### 2. Progress graphs and personal records — **M**

- **Rolling windows:** `GetTrend` already returns the full per-match
  series; a rolling mean/window is a **pure frontend function over the
  fetched rows** (allowed by the AGENTS.md view-level-aggregate rule:
  formula documented in the card title/tooltip) — no backend work. Extend
  `PlayerProfile.svelte`'s sparkline into a windowed chart (EconCurve
  pattern: hover readout, winner strip), with a window-size toggle
  (e.g. 5/10/20 matches). If series ever need server-side windows, SQLite
  window functions are available (no precedent in repo yet).
- **Personal records:** computed **on the fly** from existing aggregates —
  MAX-style store queries over `player_stats` / career / history (best ADR
  match, longest win streak, most kills/clutches, longest `best_streak`,
  highest KAST). **No new storage**: records auto-update on import/delete,
  stay deterministic, and never go stale (also sidesteps the no-migrations
  policy). Queries must read the full library (history is capped at 100).
- **Achievements:** a built-in **predicate catalog in Go** (id, title,
  condition, honest `N`/progress) evaluated on read from the same
  career/history/clutch reads; rendered as a badge grid on the profile.
  No persistence table for v1 — achievements are derived facts, and
  computing them on read means re-imports/deletes can't orphan them. (If
  unlock *timestamps* are ever wanted, a tiny table can come later.)
- **Charting:** hand-rolled SVG following `EconCurve`/sparkline
  conventions — no chart dependency.

### 3. Cross-library player overview — **L** (several weeks)

Five sub-surfaces on top of the existing `ProfileService` +
`PlayerProfile.svelte` (route stays `/player/:steamid`):

- **Trends:** already exist (4 metrics) — add rating from item 1; no new
  work beyond wiring.
- **Rank history:** data already in `players.rank/rank_type/wins` per
  match — one new store query (per-match rank ordered by `extracted_at`,
  HumanOnly) + a step chart on the profile. **Verify first** (CS2.md
  lookup): what `rank_type` values mean (Premier CS Rating vs. classic
  competitive stars), whether non-Valve demos (FACEIT/HLTV) carry 0
  (they almost certainly do — rank lives on the Valve-MM player
  controller), and that a 0 row must render as "unknown", never rank 0/1.
- **Teammates:** co-roster query over `players`/`player_stats` (same
  match, same team side) → "played N matches with X" list with shared
  W/L; route every roster read through the canonical bot filter
  (`store.HumanOnly`).
- **Head-to-head:** shared matches between two SteamIDs → per-match
  outcomes plus direct duels from `engagements` (a_steam/victim within
  shared matches); new sub-view with a `SuggestInput`/`PlayerPicker`
  opponent picker (reuse the canonical suggestion component).
- **Benchmarks:** percentile vs. the library population beside profile
  cards ("top X% by ADR over N matches"). Either store aggregate queries
  in the `GetCombatStats` style (recommended — the metrics engine's
  `percentile` requires GroupBy "" and is preview-oriented) or a
  library-wide ungrouped metric preview; formula + N always shown.
- **Achievements:** shared with item 2's catalog (same predicates,
  profile scope) — build once.

## Existing scaffolding to reuse

- **Metric engine + plugin metrics** (`internal/metrics`, `metrics` table,
  Builder view, `plugin.MetricDef`→`PluginMetricDef`) — component-level
  user-extendability for item 1; `SaveMetric` already defaults the
  `Formula:` doc.
- **Analytics pass + `player_career` rollup** (`analytics.Compute`,
  `RebuildCareer`) — the write path for a stored rating and the pattern
  for rule-aware recompute.
- **`ProfileService` / `GetTrend` / `GetPlayerHistory` / `ListPlayers`** —
  the read models item 2 and 3 extend.
- **Canonical SQL homes** (`store/queries.go`): `kastPerMatchSQL`,
  `kastCareerSQL`, `kdPerMatchSQL`, `kdCareerSQL` — rating/benchmark
  inputs must reuse these, not re-express them.
- **Frontend:** `StatCard`, `SortTh`, `SuggestInput`/`PlayerPicker`,
  `definitions.js` (formula tooltips), `fmt.js`, `EconCurve`+sparkline
  SVG chart pattern, `lib/players.js` `listedPlayers`/`isHuman`,
  `cachedRead` for any new service reads, `nav.js`/`router.js` for the
  H2H route.
- **Docs:** honest-metrics rule (value 0 beside N), `Formula:` doc on
  every metric.

## Dependencies & overlaps

- **Match metadata unit** — played-at date (fixes trend/rank ordering off
  `extracted_at`) and "ranked flag" detection overlap directly with rank
  history; de-conflict who owns rank semantics/CS2.md entries.
- **Descriptive-stats unit** (side-split, opening success, utility
  aggregates…) — shares `player_stats` and the PlayerProfile surface;
  keep stored columns in one home each (rating must not duplicate an
  ADR/KAST formula; benchmark percentiles must not fork
  `store.GetCombatStats` decisions).
- **Advanced analytics** (habit mining, conditions→actions) — same
  profile/career read models; achievement predicates may later consume its
  outputs.
- **Export unit** — "profile export" and "user-authored YAML metric
  rules" are the likely home for item 1's deeper user-extendability and
  for exporting records/achievements.
- **Reports** (`report_templates` capability) — natural renderer for
  rating + achievements; **Localization** — `definitions.js` strings become
  the glossary to translate later.
- **Highlight detection** (Video unit) — achievement definitions like
  "ace" share event vocabulary with `lib/replay/landmarks.js`; no code
  dependency yet.
- **Replay/video/annotations/lineups/library** — no direct overlap.

## Risks & unknowns

- **HLTV 2.0 exact weights are unpublished** — "reproduction" can only be
  a documented approximation (R²≈0.995), and Rating 1.0's constants are
  historical population averages; both must be labelled in
  `definitions.js`/metric doc (honest metrics) or users will read them as
  official numbers. Rating 3.0 is event-normalized with re-tuned private
  constants → out of scope, say so explicitly.
- **CS2.md entries are a prerequisite** (formula sources, rank semantics)
  and were NOT written here (single-file constraint) — the implementing
  agent must append them per the AGENTS.md domain-knowledge rule.
- **Schema change for a stored rating** touches the pinned column-list
  test and requires re-import of stale dev DBs (pre-release policy: no
  migrations); compute-on-read (option b) avoids it at the cost of
  repeated derivation.
- **Rank data availability** may be near-zero outside Valve MM demos —
  feature must degrade to an explicit "unknown" state, not fabricated
  history (and coordinate with the metadata unit's ranked-flag work).
- **Library-wide aggregate performance** — RebuildCareer is already the
  heavy path at 1k+ matches; new benchmark/teammate/PB queries must use
  the Tier-1 steam_id indexes and run on the read-only session
  (perf_dev_test.go is the local measurement harness).
- **Scope creep on achievements** — a large predicate catalog is the
  main LoE risk in item 2; ship a small pinned set first.
