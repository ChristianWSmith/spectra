# User-authored YAML metric rules — roadmap research

**Unit:** export-metrics · **Priority tier:** P1 · **Date:** 2026-11-10
**LoE (aggregate):** M — YAML schema + validation, a user rules dir with
disk→DB sync, export/import, and the thresholds home reuse four existing
precedents (manifest validation, plugin dir-scan, native save/open dialogs,
plugin metric-row sync) and fit inside a week; the rating forks to **L** if
"equally expressive as YAML" is read to require grammar v2 (joins,
inter-aggregation arithmetic/composites) — that is a parser/compiler/property-
test rebuild of the frozen v1 engine, tracked separately below.
**Feasibility:** high — no blockers: `gopkg.in/yaml.v3` is already in the
module graph (promote indirect→direct), every rule shape involved already has
a validating write path (`MetricsService.SaveMetric`,
`AnalyticsService.SetConfig`), and file↔row sync has a shipping precedent
(`plugin.Manager`). Open decisions are authority/sync model and the editor
choice, not capability.

## Items in scope

1. **User-authored YAML metric rules** — editable rulesets with schema
   validation, completion and a user rules directory; direction: the
   custom metric builder should be equally expressive as YAML, plus direct
   YAML authoring for power users with export/import

## Current state

- **Metric definitions are DB rows, evaluated on read.** The `metrics`
  table (`internal/store/schema.sql`, column list pinned by a coordination
  contract with `platform_store.go`'s byte-identical `metricsTableDDL`) holds
  `origin = builtin|user|plugin` rows; `internal/metrics` compiles the
  frozen v1 expression grammar (`doc.go`) into parameterized SQL and runs it
  on the store's **read-only session** (`MetricsService.PreviewMetric`, row
  cap, 10 s timeout). Nothing metric-valued is persisted — only definitions;
  scoreboard pins (localStorage `spectra:pinned-metrics`), the Reports
  appendix and CommandPalette all resolve ids through `ListMetrics()` and
  preview on demand.
- **The builder is a form over the same row, not a grammar extender.**
  `frontend/src/lib/views/Builder.svelte` edits name/title/groupBy/format/
  denominator/doc/expr with a debounced `ValidateExpr` live check (400 ms,
  `ExprError{message,pos}` byte offsets) and a preview pane showing value +
  **N** + compiled-SQL provenance. `SaveMetric` forces `origin=user`,
  validates through `metrics.Compile` before any write, rejects duplicate
  names across ALL origins, and defaults `doc` to `"Formula: <expr>"`
  (honest-metrics rule, PRD §5.16 citation in code).
- **What v1 CAN express:** single-source aggregation over nine whitelisted
  tables; count/sum/avg/min/max/stddev/percentile/median/ratio; WHERE-style
  conditions on whitelisted columns (comparison/AND/OR/NOT, literals bound
  as `?`); fixed per-source `groupBy` (player/round/team/weapon/side/map);
  a scalar `denominator` (rounds/matches/player_rounds); library or
  `match:<id>` scope. **Where it falls short (the gap list driving the
  parity half):**
  - **no joins / cross-source** — the seeded builtins document their own
    proxies (`opening_kill_round_win_pct`, `round_win_rate`: "needs a
    cross-source join");
  - **no arithmetic between aggregations** except `ratio` (division) — no
    weighted composites; `stats-rating.md` explicitly defers the composite
    rating's user-extendability to this item and forbids forking the
    grammar there;
  - **no thresholds/rules in the metric system at all** — trade window, eco
    thresholds and trade-opportunity distance live in the single-row
    `analysis_config` table (`models.AnalysisConfig`, `GetConfig/SetConfig`
    with a validation gate, `rule_version` bump, explicit
    `RecomputeAnalysis`), edited by Settings' "Analysis rules" block.
    `stats-advanced.md` designates THIS item as their long-term home —
    "keep the field names aligned";
  - **no ruleset grouping** (one row = one metric; no related-rule files,
    no metric-references-metric), no trend/window metrics (career trends
    are a separate hardcoded `GetTrend(adr|kast|kd|hs)` whitelist).
- **Plugin metrics show the file→row sync shape** a rules dir would copy:
  `spectra-plugin.json` `plugin.MetricDef` (manifest schema; deliberately
  NOT `store.PluginMetricDef`, the write input — both documented variants)
  → `metricDefs()` → `ReplacePluginMetrics` upserting `origin=plugin` rows
  in the same table; disk manifest is the source of truth, DB is the cache;
  `Manager.List` **rescans the directory on demand** — the app has no
  file-watcher anywhere (fsnotify is an indirect dep only), so a rules dir
  needs no watch either.
- **No YAML in application code today.** `gopkg.in/yaml.v3` /
  `go.yaml.in/yaml/v3` exist only as indirect deps; there is no JSON-Schema
  usage either (`jsonschema-go` indirect). The house validation pattern is
  hand-rolled structs with user-facing errors (`plugin.ValidateManifest`,
  `SaveMetric`, `SetConfig`).
- **No code editor component exists.** SQL console and the metric
  expression are plain `<textarea>`s; there is no codemirror/monaco
  anywhere; the frontend `yaml` package appears only as an optional postcss
  peer dep. The canonical suggestion widget is
  `components/SuggestInput.svelte` (search-input dropdown, not a code
  completion engine). "Completion" is therefore a real build item, not a
  wiring item.
- **Export/import plumbing exists but nothing exports metric definitions
  yet.** `lib/save.js`/`lib/download.js` (native save via
  `DialogService.SaveFile`/`WriteFile`) and `DialogService.OpenFile`
  (`LibraryService.importDialog`) cover both directions; plugin install
  today takes a typed path (no picker) in Settings.

## Implementation path

### 1. Ruleset schema + validation (Go) — ~1 day
- Promote `gopkg.in/yaml/v3` to a direct dep; strict-decode
  (`KnownFields(true)`) into a new `internal/ruleset` (or `internal/rules`
  sibling — note `internal/rules` is already the side-parity arithmetic
  home, so pick a distinct package name) struct mirroring `MetricRow`
  fields (name/title/expr/groupBy/format/denominator/doc) plus an
  `analysis` section carrying the `AnalysisConfig` field names verbatim
  (stats-advanced's alignment requirement).
- Semantic validation reuses existing gates rather than duplicating them:
  every `expr` through `metrics.Compile`, thresholds through the same rules
  as `AnalyticsService.SetConfig`, `doc` required (never let an import skip
  the formula), name regex following `metricNameRe`. Errors carry YAML
  line/column (yaml.v3 `TypeError` gives them) mapped to the `ExprError`
  contract style. Unknown keys are hard errors — the `ValidateManifest`
  posture, not silent drops.

### 2. User rules directory + sync — ~1.5 days
- Path helper beside the `internal/data` / `plugin.DefaultDir()` pattern:
  `$XDG_DATA_HOME/spectra/rules/` (XDG env relocation comes free; add to
  `EnsureDirs` and to AGENTS.md's instance-isolation doc when implementing).
- **Authority decision (the key design call):** follow the plugin model —
  files are the source of truth, DB rows are the runtime cache synced on
  load/launch/List (rescan-on-demand, no watcher). Consequence to solve:
  editing a file-backed metric in the Builder must write through to the
  file (or explicitly detach to a plain user row) — otherwise last-writer-
  wins between the two surfaces. The lighter alternative (DB is truth,
  YAML is export/import only, dir is just where exports land) ships faster
  but weakens "direct YAML authoring for power users".
- Row provenance: a fourth `origin` value (the column is `TEXT` with no
  CHECK — no DDL change) touches every origin branch: `ListMetrics`
  ORDER BY, `UpdateMetric`/`DeleteMetric` immutability guards, Builder's
  three-bucket grouping (`builtin|user|plugin`), plugin-disable semantics.
  Budget a sweep of those call sites (grep `origin` is small today).

### 3. Export/import round-trip — ~0.5–1 day
- Export: serialize selected/all user metrics (+ thresholds) to YAML via
  `saveText`/`downloadText`. Import: native open dialog → Go parse/validate
  → per-metric upsert with duplicate-name policy decided (skip / rename /
  overwrite — `CreateMetric` currently rejects any cross-origin collision,
  so import needs an explicit conflict story). Round-trip fixture test
  (export → import → identical rows) in the house characterization style.

### 4. Completion + editor experience — ~1–2 days (the swing factor)
- No editor exists, so choose: **(a)** hand-rolled completion over a
  textarea — a Go service exposing the schema vocabulary (field names,
  enum values from `metricFormats`/groupTokens/whitelist sources, existing
  metric names) consumed by a `SuggestInput`-style overlay, plus the
  existing `ValidateExpr` live-check for the expr field; **(b)** adopt a
  real editor (codemirror) — matches the "VS Code design language"
  aesthetic and gives YAML folding/errors for free but violates
  dependency-minimalism comfort and is a large new frontend dep.
  Recommendation: (a) for v1, revisit (b) if YAML authoring proves heavy.
- All YAML parsing/validation stays Go-side (house style: bindings return
  structured errors; the frontend never becomes the validator).

### 5. Thresholds (`analysis_config`) as the YAML home — ~1 day
- The table stays the runtime store (the analytics pass reads it every
  compute); YAML becomes its authoring/export format with a defined sync
  direction. Import must bump `rule_version` and surface the existing
  "re-run analysis to apply" flow (Settings' recompute affordance) — never
  silently change stored numbers (determinism + honest-labeling).

### 6. Builder-parity half — scope-gated
- At current vocabulary, parity is already true (the builder edits exactly
  what YAML can serialize) — v1 of this item needs verification, not work.
- If the owner wants YAML to be MORE expressive (the gap list: joins,
  composites, cross-source), that is **grammar v2**: `parse.go`/`compile.go`/
  `whitelist.go` grow, `doc.go`'s FROZEN banner is deliberately lifted,
  property/fixture/`schema_consistency` tests all extend, and every consumer
  of `ExprError` inherits the new diagnostics. Rate **L** on its own; do not
  start it inside this item without an explicit scope decision.

## Existing scaffolding to reuse

- `plugin.ValidateManifest` / `Manager.List` / `Install` — validation
  posture (unknown keys hard-error), dir-scan-on-demand, disk→row sync via
  `ReplacePluginMetrics`; the closest structural precedent for a rules dir.
- `metrics.Compile` / `Validate` / `SaveMetric` — the ONE expression gate;
  YAML must feed it, never bypass it (read-only console layering: compiled
  parameterized SQL on the RO session stays the only execution path).
- `AnalyticsService.SetConfig` validation + `rule_version` +
  `RecomputeAnalysis` — the whole thresholds change contract.
- `DialogService` (`SaveFile`/`WriteFile`/`OpenFile`) + `lib/save.js` /
  `lib/download.js` — export/import dialogs, cancel contract included.
- `internal/data` / `plugin.DefaultDir()` XDG path pattern (+ AGENTS.md
  instance-isolation: rules dir must relocate with `XDG_DATA_HOME`).
- Builder's debounced `ValidateExpr` + `ExprError` byte positions — live
  validation UI to reuse for YAML/expr fields; `SuggestInput.svelte` — the
  one suggestion-dropdown component for completion v1.
- `models.MetricRow` JSON tags ARE the frontend contract (no service twin)
  — the YAML field names should mirror them so import/export/builder share
  one vocabulary.
- Honest-metrics enforcement already in `SaveMetric` (formula doc default,
  N from preview) — replicate on the import path, don't reinvent.

## Dependencies & overlaps

- **stats-advanced (P1):** its thresholds/pattern-rule items name THIS
  item as the long-term home for tunable thresholds — `analysis_config`
  field names must be mirrored in the YAML `analysis` section, and its
  `GetConfig/SetConfig/rule_version/recompute` shape is the contract to
  preserve. Co-schedule or at least sequence after its field additions land.
- **stats-rating (P1):** composite rating's "user-extendable" explicitly
  defers deeper expressiveness here and forbids forking the grammar there —
  if the composite wants weighted sums, this item's grammar-v2 question is
  its blocker.
- **Export-unit siblings:** "Whole-match stats file export" shares the
  `save.js`/`download.js`/dialog plumbing and the JSON-envelope export
  conventions; "profile export" shares the same buttons. De-conflict who
  builds the generic export surface first.
- **CLI / flag-driven scripting:** a user rules directory is a natural CLI
  input later; keep the loader a standalone Go package (no service
  dependency) so the CLI can reuse it — this directly serves the CLI unit's
  "scope is a known concern" worry.
- **Video unit — "Automatic mistake flagging" / "Rule-driven highlight
  detection":** both are "built-ins, user-extendable" rule layers; the
  AGENTS.md consolidation rule (one rule layer, never a second) means they
  should consume this ruleset mechanism or be de-conflicted explicitly —
  otherwise three rule layers (metrics YAML, thresholds, flag rules) fork.
- **Reports / scoreboard / CommandPalette:** pure consumers of
  `ListMetrics` — file-origin rows must appear and preview identically;
  no work beyond the origin sweep.
- **Library:** rules dir lives under the data dir — the demo scanner must
  not walk it (it already skips `RootDir`'s subtree per `data.go` docs).
- **Localization:** rules files are English content (round_classifications
  precedent — DB strings stay English until localization lands).
- **Annotations / lineups / metadata / descriptive stats:** no direct
  overlap beyond shared export buttons.

## Risks & unknowns

- **Two-sources-of-truth is THE design risk:** DB-native user metrics
  (today) vs files-as-truth (plugin model). Half-syncs produce visible drift
  (Builder edits a file row, preview shows stale, pins dangle). Decide the
  authority model before building; write-through or detach on edit either
  way.
- **Frozen-grammar tension:** the item's parity direction invites a grammar
  v2 (joins/composites) that `doc.go`, `metricservice.go` and three test
  files all pin as FROZEN. Scope must be stated up front: serialization
  parity (M) vs expressiveness expansion (L). Letting it creep silently is
  the most likely way this item blows its estimate.
- **Origin-contract sweep:** a fourth origin value is DDL-free but
  semantically loaded (ordering, immutability, grouping, plugin interplay);
  missing a branch shows up as a user metric silently deletable/editable in
  the wrong place.
- **Completion without an editor:** a textarea overlay will be primitive
  (no YAML folding, no inline line/column markers beyond what we render);
  codemirror solves it at dependency cost. Decide per the aesthetic-vs-
  minimalism preference; document the choice either way.
- **Import conflict policy** is unspecified: name collisions are currently
  hard errors across all origins; bulk import needs skip/rename/overwrite
  semantics pinned by a test before UI work.
- **Threshold sync side effects:** importing thresholds that differ from
  stored values changes future analysis — must bump `rule_version` and
  require explicit recompute (never silent), or determinism/honest-labeling
  regress.
- **No-versioning policy applies:** no format-version keys or
  compat ladders in the YAML schema — describe THE current layout once
  (AGENTS.md pre-release rule); stale files are fixed by hand or re-
  imported, never detected-and-branched.
