# 01 · BASELINE — what exists today, and what the migration touches

**Status:** current-state summary for the 2026-11-20 direction. The detailed
2026-11-18 inventory (per-line citations, the full 55-row parity table, the
refusal matrix) is preserved in git at commit `23099ec`, under
`dogfood/01-BASELINE.md`. Citations below are from that inventory and were
**not re-verified** in this rewrite. Re-verify each one at the wave that
touches it.

**Pre-migration snapshot (the comparison instrument):**
`~/Programming/spectra-home/.local/share/spectra/` — verified 2026-11-20:

- `spectra.db` (+ `-wal`, `-shm`): **7 matches**, **109 builtin metrics**,
  **9,562 stored `metric_values` rows**.
- `demos/`: the 7 managed demo copies, so a re-import can run from the snapshot.
- `matches/<id>/`: sidecars and `meta.json`.
- `maps/ icons/ sounds/`: extracted assets.

**Rule:** copy the snapshot before opening it. The app's `store.Open` repair
path changes job rows, and an instance must never open another instance's
live database (AGENTS "Instance isolation"). Read the copy with `sqlite3`,
read-only.

---

## A. The metric system today (grammar-based)

**Pipeline.** A metric's `expr` is sugar text. `internal/metrics`
parses it (`parse.go`), validates it against a whitelist (`whitelist.go`),
and emits SQL (`compile.go`) into a `Plan`. The `Plan` is executed by
`RunPreview` (interactive) or `Sweep` (stored), with `valuesFromPlan` mapping
positional columns to `metric_values`. Entry points: `ValidateExpr`,
`PreviewMetric`, `CompileMetric`, `SaveMetric` (`metricservice.go`).

**Furniture on each metric row.** `subject` (player / match / team), `scope`
(match / profile), `partition` (side / map / weapon / …), `denominator`
(rounds / matches — a sugar construct), `format`, `doc` (the Formula
tooltip, defaulted to `Formula: <expr>`).

**Stored values.** `metric_values`: PK `(metric_id, match_id, subject_key,
dim)`, with `value`, `value_key` (identity only), `n`, `metric_version`,
`rule_version`, `computed_at`. Dependencies: `metric_deps` (metric-to-metric,
from `metric('…')` references, re-derived on save).

**Five states** (`metriccompute.go` → `metricstate.js`): processing → failed
→ behind → no-data → fresh. The word list is the vocabulary the UI uses.

**Freshness today.** `MetricCoverage` is blanket: a metric is behind when
`metric_version` or `rule_version` lags, for every metric. A rule-version
bump therefore marks the whole library behind. This is the behavior the new
direction narrows (see `03-QUERIES.md`).

**The SQL console** (`internal/query`, `query_store.go`): read-only layers
— `ValidateReadOnlySQL`, a separate `mode=ro` + `query_only` connection, a
timeout, a row cap. No table allowlist. The metric path reuses the first
layer and the connection pattern.

**Retirement list (the grammar):** `internal/metrics` parse / compile /
emit / whitelist / `doc.go` sugar reference; the `denominator` furniture; the
`metric-language.js` manual chapter (rewritten, not kept); the refusal test
matrix for sugar (`metrics_test.go`, `argmax_test.go`, `exists_test.go`,
`nextwindow_test.go`, `rowdifference_test.go`, `subject_addressing_test.go`,
`refs_test.go` where they test grammar behavior). Keep the equivalence and
fixture tests — they check values, not grammar.

## B. Stored analysis and facts

- **Analysis rules** (`internal/analytics` Compute) store their outputs at
  analyze time: trade windows (`player_stats.trade_kills`), eco classes
  (`round_classifications`, `round_side_classes`), clutches, engagements,
  utility events, `match_trade_opps`, `player_round_stats`. Rule values are
  editable (`analysis_config`); `analysis_config.rule_version` and
  `matches.analyzed_rule_version` drive the rule-change path.
- **Facts:** `matches`, `rounds`, `events`, `generic_events`, `chat`,
  `players`, `teams`, `player_stats`, `round_economy`, `round_player_sides`,
  `round_player_money`, `sound_events`.
- **Ingest:** `SaveExtracted` is a single transaction with row-by-row inserts
  and a `childTables` delete loop. Sidecars (`matches/<id>/positions.bin`,
  `state.bin`, `voice/`) are written by streaming sinks during parse.
- **Stamps on `events`:** `same_side`, `capped_dmg`, `attacker_inair`. The
  tick migration drops `same_side` and keeps `attacker_inair` (PLAN ruling
  39) and `capped_dmg`.
- **Already committed drops, effective at the wipe:** `player_stats.opening_kills`,
  `opening_deaths`, `damage_by_weapon`; `rounds.warmup`, `rounds.pregame`,
  `matches.warmup_rounds`.
- **Dead code** the owner ordered deleted: the win-percentage fold, the
  `internal/spatial/series.go` reader (one call site reported live at
  `platformservice.go:275`, verify before deleting), two unconsumed team
  aggregates, and the raw default scoreboard sort.

## C. Surfaces and preferences that the components replace

- **Match view:** overview identity cards and roster, scoreboard (fixed
  Name / Team / Score plus pinned metric columns), rounds list, economy
  (EconCurve, summary cards, rounds table, CT/T deaths per round), combat
  (engagements, clutches), utility (throw log, damage and blind bars),
  heatmaps, details, round detail, compare rounds.
- **Profile view:** career stat tiles, trend sparkline, sides / maps /
  weapons tables, match history.
- **Reports:** template grid, match / player / round targets, stats
  appendix, export.
- **Prefs that layouts currently use** (kvstore, `prefs.go`): `metric_order_match`,
  `metric_order_profile`, `metric_order_overview`, `metric_pins_overview`,
  `metric_economy`, `metric_hidden_match`, `metric_hidden_profile`,
  `scoreboard_starts_transposed`. Plus two localStorage keys,
  `spectra:pinned-metrics` and `spectra:pinned-profile-metrics`. Under the
  new direction these become database-stored component configurations.
  `loop_secs` stays a plain pref.
- **Controls:** the metric ordering dialog, the Builder, sort clicks, filter
  bars, the compare picker, pickers.

## D. Known gaps in this summary

- The per-line citations above are not re-verified in this rewrite.
- The full 55-row parity table, the 2026-11-18 A-class dispositions and the
  per-surface data paths are in git history at `23099ec`.
- Library.svelte was never audited.
