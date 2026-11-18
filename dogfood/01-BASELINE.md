# 01 · BASELINE — the system as it exists at `24de283`

**Step 1 deliverable of `PLANNING.md`.** Three parallel researcher inventories
(R31 metrics engine · R32 facts/store/sidecar · R33 surfaces+prefs), compiled by
the lead. Every downstream design step (02 tick-state, 03 queries, 04
components) contracts against this document; citations are researcher-verified
against baseline `24de283` and reconciled against `main` at integration.

**Status:** COMPLETE — all three inventories in (R31 delivered 14:58, R32 15:05, R33 via wrap report after its deadline — nudge applied, sections complete, gaps explicitly marked).

**Confidence key (as delivered by each researcher):** **H** = read the cited
code directly · **M** = derived from adjacent code/docs · **L/flagged** = not
determined.

---

## Part A · R31 — metrics engine inventory

**INVENTORY — metrics system @ baseline `24de283`** (worktree `…/r31-baseline-metrics`, HEAD verified `24de283`; clock checked 14:52–14:58 — all well inside the 15:33 deadline; all 9 sections completed). All paths are repo-relative.

### A1. Compilation path (string → SQL → rows)

**Entry points (service layer, `src/metricservice.go`):**
- `ValidateExpr` — `src/metricservice.go:811` (Builder live check): `resolveRefsExpr` → `draftAddress` (`:600`) → `metrics.CompileRefs(expr, "", "", addr, refs)` (`:820`).
- `PreviewMetric` — `src/metricservice.go:632`: builds `metrics.Def` (draft leg uses `draftAddress` `:656`; saved leg reads row `:644-651`) → `resolveRefsExpr` `:660` → `metrics.RunPreview` `:672`.
- `CompileMetric` (no-execution provenance SQL) — `src/metricservice.go:748` → `CompileRefs` `:777` → `plan.DisplaySQL()` `:782`.
- **Save/materialization** — `SaveMetric` `:346`: `metrics.Parse` `:429` → `resolveRefs` `:460` → **compile gate** `metrics.CompileRefs(m.Expr, m.Denominator, "", addr, refs)` `:473` → cycle check `:478` → rename splice `:487-525` → `store.SaveMetricWithDeps` `:541`.
- **Compute pass** — `metrics.Sweep` `src/internal/metrics/pass.go:110`; per-metric `process` compiles at `pass.go:304-315` (`CompileRefs` for profile scope, `CompilePassMatch` otherwise) and executes at `pass.go:325` (`st.QueryWrite`).
- Package-level no-ref `Compile` `src/internal/metrics/compile.go:148`, `CompileRefs` `:187`, `CompilePassMatch` `:205`, all funneling to the one impl `compileRefs` `:223`; `Validate` `:571`.

**Parser:** `metrics.Parse` `src/internal/metrics/parse.go:260`; lexer `lexExpr` `:277`; DoS limits `:23-27` (8 KB / 16 aggs / cond depth 64). Parse output = `Spec{Sources, Aggs}` `parse.go:112`, `Agg` `:120`, `condNode` `:224`, `operand` `:199`.

**IR:** **no intermediate representation** — parsed nodes are walked once and emitted directly to SQL text by the `emitter` (`compile.go:893` onward). The de-facto IR boundary is the returned **`Plan`** (`compile.go:77-116`): `{Mode, SQL, Args, Secondary, Source, AggCount, SQLAggs, PercentileP, HasDenom, Subject, Partition, MatchAddress, Identity}` — every downstream consumer (`RunPreview` `preview.go:78`, `valuesFromPlan` `pass.go:502`, Sweep) reads only Plan + positional row columns.

**Emit stages (file:line):** FROM/joins built as a string before emission: primary + engine `LEFT JOIN`s on derived keys `compile.go:350-374`, curated-alias `tableFor` `:351/:362` (map `whitelist.go:146`); `metric()` refs → `INNER JOIN metric_values md0.. ON …` `compile.go:428-480` (join text `:471-474`); `writeFrom` `:903`. Shape emitters: `phase1` `:1061` (aggregate), `phaseIdentity` `:1156` (argmax window), `phase2` `:1232` (percentile raw fetch); value emitters `emitValue` `:1425`, `emitTerms` `:1507`, `emitCond` `:1563`, `emitOperand` `:1619`; denominator `emitDenom` `:1316`; address helpers `matchIDExpr` `:911`, `subjectExpr` `:925`, `subjectKeyExpr` `:943`, `emitMid` `:962`, `partitionKeyExpr` `:970`, `subjectConds` `:1012`, `writeSubject` `:1038`, `groupCols` `:1106` / `groupExprs` `:1123`.

**Emitted SELECT shape** (`phase1`, `compile.go:1062-1099`):
`SELECT [match_id AS mid,] <subjectKey> AS grp[, <dim> AS dim,] <v0>[, v1…], COUNT(*) AS n FROM <primary [+ LEFT JOINs + metric ref INNER JOINs]> [WHERE match_id = ?] <subjectConds…> GROUP BY <shape cols> ORDER BY <shape cols>` — first value column wrapped as `1.0*(<value>) / NULLIF((<denom subquery>), 0)` when a denominator exists (`:1077-1084`). Every literal is a `?` bind (`bind` `:893-896`).

**Execution:** interactive → `st.RunReadOnly(plan.SQL, plan.Args, …)` on the read-only connection (`preview.go:96`); sweep → `st.QueryWrite` on the write handle under the compute lock, which still runs the same `ValidateReadOnlySQL` gate (`src/internal/store/metric_values_store.go:521-524`, rationale `:510-519`).

**SQL-text / alias leakage a SQL-native path would reuse (H):** the column *contract* is positional aliases — `mid`, `grp`, `dim`, `idkey`, `v`/`v0..`, `x`, `n`, `rn` (`compile.go:1064-1087`, `1141-1146`, `1245`), consumed positionally by `RunPreview` (`preview.go:104-152`) and `valuesFromPlan` (`pass.go:502-565`). Engine-chosen table aliases: `md0…` (`compile.go:469`), `x0` (exists, `:1602-1604`), `nx0` (next, `:1633-1637`), `d`/`dm` (denominator, `:1321`/`:1402`). SQL is already user-visible: `Plan.DisplaySQL` + `InlineArgs` (`display.go:136`, `:29`) and `CompileMetric` hands it to the Builder (`metricservice.go:748`, Builder provenance `Builder.svelte:1118/:1123`). Console note: parameterized statements are refused there (`internal/query/session.go:32,74`), hence the inlining.

### A2. Grammar inventory

**Op table** `aggOps` `parse.go:35-39`: `count, sum, avg, min, max, stddev, percentile, median, ratio, metric, argmax`; nested-value gate `ratioNestedOps` `:47-50`; contextual keywords `exprKeywords` `:60-64` (`from as where and or not true false exists outer next`); comparisons `cmpOps` `:100`. Grammar doc (the canonical construct list): `doc.go:7-135` (op table `:32-135`), conditions `:137-164`, `next()` `:166-205`, `diff()` `:206-243`, `metric()` `:244+`, sources `:357`, joins `:375`, subject addressing `:439`, argmax `:502`, denominator `:531`, scope `:580`, percentile `:589`, preview semantics `:618`.

**Parse sites:** source clause + agg list `parseSpec` `:435`; `parseAgg` `:505`; `parseCountArgs` `:574`; `parseOpArgs` `:586`; scalar min/max dispatch `scalarShape` `:674`, `parseScalarArgs` `:698`, `parseScalarTerm` `:732`; `metric()` arg `parseMetricArg` `:797`; column/chain/diff args `parseColArg` `:823` (additive chain, `diff` reduced only by sum/avg); conditions `parseCond` `:915` → `parseOr/And/Not/Primary` `:917/:936/:955/:967`; `exists()` `parseExists` `:1019`; `next()` `parseWindow` `:1063`; `diff()` `parseDiff` `:1105`; operand `parseOperand` `:1173`.

**Addressing vocabulary:** `Address` `compile.go:33-45` + `normalize` `:51-71` (subjects `player|match|team`; partitions via `partitionColumns` `whitelist.go:251`; profile⇒player-only `:65-69`). Whitelist structures (`whitelist.go`): `sources` (14) `:19`, `sourceColumns` (per-source column sets) `:32`, `sourceTable` alias map `:146`, `sourceSubject` `:213`, `playerSources` `:230`, `teamSources` `:240`, `partitionColumns` `:251`, `sourceDims` `:269`, `denominatorTables` (`rounds|matches`) `:293`, `denominatorCareerTables` `:307`, population `:362-391`, `sourceUniqueKeys` `:393`, `joinKey` `:450`, `joinIsOneToOne` `:481`, `roundGrain` `:171`.

**Refusal matrix — categories × pinning tests** (test line numbers grep-verified; bodies not all read, M):

| Category | Pin |
|---|---|
| Syntax/lexing, unknown source/op/column, cross-source ambiguity, percentile range, nesting, scope, joins (dup source, non-unique secondary, n:1 secondary value col), anchor, scalar min/max borders | `internal/metrics/metrics_test.go:90` `TestParseAndCompileInvalid` (39 named cases); anchor copy `:162` `TestAnchorValidation` |
| Subject × scope / subject anchors / partition column / ref containment / subject-axis whitelist | `subject_addressing_test.go:264` (`TestSubjectScopeMatrixRefusals`), `:217`, `:290`, `:330`, `:159` |
| argmax shapes (profile, subject, lead, sole agg, denominator) | `argmax_test.go:19` `TestArgmaxRefusals` (each message at `compile.go:234-238, 282-302, 392-395`) |
| `exists()` position/depth/inner-scan | `exists_test.go:27` `TestExistsMatrix`, `:160` |
| `next()` round-grain/primary-column/nesting/value-position | `nextwindow_test.go:16` `TestNextWindowRefusals` |
| `diff()` position/arity/exists-in-diff | `rowdifference_test.go:21` `TestRowDifferenceRefusals` |
| `metric()` two legal positions, refusals, cycles | `refs_test.go:27` / `:65` / `:255` / `:274`; cross-scope matrix `metricdeps_test.go:258` |
| Agg-level arithmetic denied, sum chain, percentile-in-ratio | `metrics_test.go:604`, `:546`, `:638` |
| Whitelist-vs-schema drift (mechanical) | `schema_consistency_test.go:31` `TestSchemaConsistency`, `:201` `TestJoinKeyDeclarationsMatchSchema` |

Shared one-message-per-refusal constants: `existsValueMsg` `parse.go:71`, `nextValueMsg` `:79`, `diffPosMsg` `:87`, `diffArityMsg` `:91`, `diffExistsMsg` `:96`.

### A3. N manufacturing (the structural recipe)

- **Grouped/aggregates:** trailing **`COUNT(*) AS n`** emitted after all value columns — `compile.go:1087`. It counts *source rows of the group* after scope `WHERE` (`:1090-1096`), the unconditional subject conditions `subjectConds` (`:1012-1031` — humans-only via `store.HumanOnlyBySteamID`, `subject <> ''` / `team <> ''`), and the per-agg filter folded into the value as `CASE` (`emitValue` `:1458-1470`) — i.e. N is rows-in-group, **not** the denominator. Read as the LAST column: `preview.go:129` / `pass.go:556` (`toN` `preview.go:413`).
- **Denominator (separate from N):** `emitDenom` `compile.go:1316` with the per-subject rule doc `:1273-1315` — player+match-scope scalar count, batched → correlated on row's match (`:1345-1367`), career → `denominatorCareerTables` correlated on subject (`:1384-1419`), team → `COUNT(DISTINCT d.round)` over `round_player_sides` or `matches` (`:1319-1330`), partition side/map scoping `:1350-1414`. Wrapped only around the FIRST value (`:1077-1084`); `ratio()`'s own divisor is in-expression (`:1485-1490`).
- **Identity (`argmax`):** `COUNT(*) OVER (PARTITION BY <groupExprs>)` inside the ranking window — `compile.go:1179-1181`; the pool = rows surviving scope + subject + the per-agg filter placed in the inner `WHERE` (`:1206-1218`). **Empty pool ⇒ no row at all** (`phaseIdentity` doc `:1153-1154`, pin `argmax_test.go:219 TestArgmaxEmptyPoolNoRows`; filtered-pool N pin `:191`).
- **Percentile:** N computed in Go = count of raw value rows in the subject/dim partition — `pass.go:634-640` (`N: len(p.vals)`); preview twin in `preview.go:153+`.
- **0-beside-N:** zero divisor → `NULLIF(d,0)` → SQL NULL (`:1080`, `:1488`) → `toFloat` maps NULL→**0** while n stays the group count (`preview.go:404-410`; comment `metrics_test.go:738`); sparse LEFT-joined secondary → NULL → 0 (`compile.go:344-347` design comment; pins `join_test.go:133 TestJoinedLeftJoinHonesty`, `fixtures_test.go:372,483`); schema states the invariant "value 0 always beside n; a group the statement did not produce has NO row" (`schema.sql:543-544`).
- **Empty pool → dash:** no stored row ⇒ `metricPresentation` → `{kind:'nodata'}` (`frontend/src/lib/metricstate.js:54-61`), never 0.

### A4. Output shapes

**Shapes that exist today:**
1. **Scalar** per `(metric_id, match_id, subject_key, dim)` — PK `schema.sql:560`, `value REAL` `:554`.
2. **Identity** — extra `value_key TEXT` column `schema.sql:555`; `Plan.Identity` `compile.go:115` (enforced: subject=match, sole agg, player-anchored lead, no denominator — `:282-302, 392-395`); mapped `pass.go:558-560` (store) and `preview.go:131-133` (preview).
3. **Nothing row-shaped**: no multi-column/row output exists — a `metric_values` row carries exactly one `value` (+ optional key) (H). Row surfaces in views are *record reads* (raw SQL/store reads), outside the metric contract.

**Where the validity matrix is enforced:**
- subject × scope: `Address.normalize` `compile.go:65-69` **and** save-time `SaveMetric` `metricservice.go:397-400` (both must agree; doc says so).
- subject × lead anchor: `compile.go:303-323` (three anchor messages); player-anchored copy `:306-310`.
- partition × columns (every source): `compile.go:330-339`.
- partition × denominator × subject: `compile.go:406-416` (weapon+denom refused; non-player subject+partition+denom refused).
- denominator vocabulary: `compile.go:381-388` (`rounds`, `matches`).
- scope vocabulary (`match|profile`), format vocabulary, subject/partition vocabulary, short-name cap: `SaveMetric` `metricservice.go:366-400`.
- **format × shape: NOT enforced** — the DDL deliberately carries no format CHECK (`schema.sql:834-840`), save only checks membership in `metricFormats` (`metricservice.go:144, 367-369`), and `identity` is withheld in the editor *because* "the format select has never been gated on the expression's SHAPE" (`frontend/src/lib/metricformats.js:19-31`, `filterOnly`).
- ref subject containment: `compile.go:457-461` + `refs.go:120`.

**What would have to grow for row outputs (observations, no design):** a `metric_values`-like key that isn't `(subject_key, dim)` (PK `schema.sql:560`); a positional→named row adapter (both mappers are offset-based: `preview.go:104-152`, `pass.go:502-565`); `MetricCoverage`'s fresh-row counting per unit (`metric_values_store.go:152-153`); `metricPresentation`'s scalar-only contract (`metricstate.js:44-61`); `fmtMetric`/`METRIC_FORMATS` scalar vocabulary; ordering (`metricorder.js`) sequences of metric IDs, not row sets.

### A5. Seed catalog + equivalence gates

- **Built-ins are schema-seeded**: 7 `INSERT OR IGNORE INTO metrics` blocks — `schema.sql:963, 1460, 1494, 1538, 1612, 1646, 1673` — **109 rows** (line count over the blocks = 109; pinned by `internal/integration/console_metrics_test.go:67` `len(res.Rows) != 109`; `internal/metrics/fixtures_test.go:37` "ONE HUNDRED AND NINE"; note the stale doc comment at `console_metrics_test.go:45` still says "one-hundred-four"). Rows carry `expr/scope/subject/partition/format/denominator/doc/origin='builtin'`.
- **The value+N gate**: `builtinSeed` table `fixtures_test.go:37-1046` — per-seed `wantValues`/`wantN`/`wantLabels`/`wantDims` hand-computed over `testdata/seed.sql` (91 `wantN:` entries); `TestBuiltinSeedMetrics` `fixtures_test.go:1087` locks expr/scope/subject/partition/denom/format/short_name/doc phrasing (`:1117-1160`) and checks **N** at `:1193-1194`. Corpus counts: `TestSyntheticCorpusCounts` `:1216`; scope/percentile/truncation `:1246/:1316/:1380`.
- **Equivalence gates (value, several with N):** `scoreboard_equivalence_test.go:105, 191, 421, 480, 535, 592, 640`; `econ_equivalence_test.go:532, 693` (0-beside-N note `:665`); `combat_equivalence_test.go:217, 337, 388, 434` (retired `GetCombatStats` oracle); `profile_splits_equivalence_test.go:108, 174` (exact `==`); `argmax` corpus identities `argmax_test.go:139`; `nextwindow_test.go:104`; `rowdifference_test.go:128`. **Stored == preview (value AND n)**: `src/metric_equivalence_test.go:234` `TestMetricEquivalenceStoredEqualsPreview` + `:314` — `eqVal{value,n}` compared at `:210`; read-path oracle `src/metric_read_test.go:66`.
- **How gates run:** `make test` = `go test -short ./...` (AGENTS); golden acceptance `internal/integration/golden_test.go` (demo `../../../golden/de_cache.dem.zst`, fixtures `testdata/donk.golden.json`/`donk.analytics.json`, `-update` regen `:10, :136-138`, skip-if-absent); builtins-through-the-console loop `console_metrics_test.go:54`. Frontend pins run from `frontend/` (`node --test src/lib/*.test.js`, jsdom harnesses).

### A6. Materialization + freshness

- **`metric_values` schema** — `schema.sql:549-561`: `(metric_id, match_id, subject_key, dim)` PK `:560`, `value` `:554`, `value_key` `:555`, `n` `:556`, `metric_version` `:557`, `rule_version` `:558`, `computed_at` `:559`; no-history delete-then-insert (`ClearMetricValues` `metric_values_store.go:198-209`, `InsertMetricValues` `:237`); indexes `schema.sql:633-634`. `metrics.version` column `schema.sql:836+` (`version INTEGER NOT NULL DEFAULT 1`, near `:848`). `metric_deps` table `schema.sql:574`.
- **Save flow:** `SaveMetric` `metricservice.go:346` → `store.SaveMetricWithDeps` `metrics_store.go:742` (one tx: upsert `:750-759`, wholesale deps replace `:760`/`replaceMetricDeps` `:793`, rename splices `:763-774`, semantic cascade bump `:778-782` → `bumpMetricAndDependents` `metric_values_store.go:585` — version+1 over the forward dep closure). "Semantic" = expr/scope/denominator changed (`metricservice.go:535-536`); created-or-semantic → `scheduleSweep()` `:549-551`.
- **Behind predicate / coverage:** `store.MetricCoverage(liveRuleVersion)` `metric_values_store.go:99-178`; row freshness const `metricValueFreshCond` `:45` (`metric_version >= m.version AND rule_version >= ?`); four axes documented `:48-58` (version, match-unit, career-unit, dim axis — dim builder `:107-133`); `MetricCoverage{MetricID,Behind,FreshRows}` `:31-35`.
- **Five states:** `GetMetricComputeState` `src/metriccompute.go:317-357` — precedence processing → failed (err + zero fresh rows) → behind → no-data → fresh (`:335-354`); display twin `frontend/src/lib/metricstate.js:30` (`METRIC_STATES`), `metricPresentation` `:46`, `liveMetricState` `:80`; uncached read pinned `services-cache.test.js:810`.
- **Recompute:** the metric recompute is `metrics.Sweep` (`pass.go:110`: behind set + dangling + forward closure `:149-175`, Kahn order `:184-226`, two-phase per metric `:247-358`, failures/skips as data `SweepResult` `:95-101`). Sweep triggers: `scheduleSweep` `metriccompute.go:140` — save (`metricservice.go:549`), import (`sweepForJob` `:300`, wired as `AfterAnalyze` `main.go:209, 348`), analysis recompute drain (`AnalyticsService.afterRecompute` = `metricsSvc.scheduleSweep`, `main.go:227`, fired from `RecomputeAll` `analyticservice.go:738-757`), plugin ops (`main.go:232`), startup (`main.go:275`). **`RecomputeAll`** (`analyticservice.go:715`) is the *analysis* recompute (match behind-set → `analytics.ComputeForBatch` → `RebuildCareer` `store/analytics.go:948`), which then *triggers* the metric sweep; `RebuildCareer` clears the career bucket → career metrics behind (`metric_values_store.go:84-86`). `rule_version` bumps on analysis-rule change only (`analyticservice.go:357`, `SetConfig` `store/analytics.go:118-132`).

### A7. SQL console safety gate (→ rule 1)

Layer order documented at `src/internal/store/query_store.go:20-43`; composed by `internal/query` + `QueryService`:
1. **`ValidateReadOnlySQL`** `query_store.go:395-448`: tokenizer-aware — exactly one `;` (final only) `:403-413`; **write verbs anywhere** forbidden via `readOnlyForbidden` `:225-232` (covers `WITH … INSERT`); leading keyword must be in `readOnlyLeading` `:237-240` (`select|with|explain|pragma|values`); PRAGMA names gated by `readOnlyPragmas` `:247-255`. Lexer `lexSQL` `:268-357` (strings/comments never tokenized). Parameters rejected by the console via `HasParameters` `:367-388` (`internal/query/session.go:74-75`, message `:32`).
2. **Separate read-only connection**: `roDSN` = `file:…?mode=ro&_pragma=query_only(1)&_pragma=busy_timeout(5000)` `query_store.go:74-81`, handle `roDB` `:87-121` (single conn), write handle unreachable.
3. **Timeout**: `context.WithTimeout` `:151` + driver `sqlite3_progress_handler`/`interrupt` (doc `:30-38`), per-row ctx check `:168`, error shaping `:195-206`.
4. **Row cap**: `:171-174` (`Truncated`), defaults `DefaultRowLimit=5000` `:47`, `DefaultTimeoutMS=5000` `:49`; entry `RunReadOnly` `:137-193`.

Service shell: `QueryService.Run` `src/queryservice.go:38` → `query.Session.Run` `internal/query/session.go:64` (history append `:91`).

**Reusable for saved metric queries (H):** `ValidateReadOnlySQL` + `lexSQL` are already reused by the sweep's plan runner (`QueryWrite` `metric_values_store.go:522`), and `RunReadOnly` already executes interactive metric plans (`preview.go:96`) — so layers 1–4 are drop-in. **Flagged gap:** there is **no table allowlist anywhere** (no table-name restriction in `ValidateReadOnlySQL` `:395-448`; the console deliberately exposes every non-`sqlite_%` table through `Schema()` `:454-458`) — rule 1's "our tables only" would be *new* code; the closest existing table allowlist is the metric engine's input-side `sources` whitelist (`whitelist.go:19`), which gates grammar sources, not arbitrary SQL.

### A8. Frontend touchpoints

- **`frontend/src/lib/docs/manuals/metric-language.js`** — the user-guide *manual chapter* (grammar/operators/refusals prose; `metricLanguageSections` export at `:37`; header `:1-36` documents the verbatim-port + re-verification rule; registered via `lib/docs/registry.js`). It is docs, not a parser — there is **no JS grammar** (H).
- **Builder / expression editor**: `frontend/src/lib/views/Builder.svelte` — expr textarea `bld-expr` `:1738-1746`; debounced 400 ms live check → `validateExpr(expr, subject, partition, scope)` `:806-833` (binding wrapper `lib/services.js:852`); preview `:1066` (`services.js:844`); provenance SQL `compileMetric` `:1118/:1123` (`services.js:951`); furniture selects — subject `:1690`, scope `:1698`, denominator `:1705`, format `:1719`; doc textarea `:1727` and doc-required-on-save `:960-961`; save payload `:992-997`. Format vocabulary `lib/metricformats.js:17-31` (identity `filterOnly`).
- **Formula tooltip source**: the stored `metrics.doc` (`"Formula: " + m.Expr` defaulted at save — `metricservice.go:526-528`; every seed doc is Formula-first and asserted non-empty `fixtures_test.go:1141-1144`). Render sites: `Match.svelte` `fixedTitle` `:919-931` (doc → fallback `` `${label} — sample size n=${pres.n}` `` `:927`), cell titles `:1538`, `:1596`, `:1740`; Builder ⓘ `:1190`; `PlayerPicker.svelte:115`.
- **`draftAddress`** — `src/metricservice.go:600-605`: THE one draft-addressing spelling, shared by `ValidateExpr` (`:819`) and `PreviewMetric`'s ad-hoc leg (`:656`).
- **Shape/format choice in UI**: subject/scope/denominator/format selects above (Built-ins load read-only, `Builder.svelte:837-845`); format drives display scaling only (`store.MetricDisplayScale` `metric_values_store.go:415`, `fmtMetric` in `fmt.js`). State chips/tooltip copy: `lib/metricstate.js` (five words `:30`, `STATE_TITLES` `:37`, progress frac `:88`).

### A9. Slot observations (observations only)

1. **`Plan` is the natural hand-off seam**: everything downstream (`RunPreview`, `valuesFromPlan`, `Sweep`, `DisplaySQL`, the row-position contract `[mid] grp [dim] [idkey] v… n`) consumes `Plan{Mode,Identity,Subject,Partition,MatchAddress,SQL,Args}`, not the grammar — an SQL-producing front end slots in wherever `compileRefs` currently returns (`compile.go:223`), leaving `pass.go`/`preview.go` untouched as long as the **positional column contract** (aliases `mid/grp/dim/idkey/v*/n`, `n` LAST) is emitted.
2. **Validation funnel is already single-threaded**: save `:473`, live check `:820`, preview (`RunPreview` → `CompileRefs` `preview.go:83`), sweep `pass.go:312/314` all call `compileRefs` — one function to swap.
3. **Rule 1 composes immediately**: `QueryWrite` already runs `ValidateReadOnlySQL` (`metric_values_store.go:522`) and `RunReadOnly` executes plans (`preview.go:96`); only a table-name allowlist is missing (§A7 gap).
4. **Rule 3's structural recipe exists only inside the emitters**: `COUNT(*) AS n` (`compile.go:1087`), `COUNT(*) OVER (…)` (`:1179`), `len(vals)` (`pass.go:639`) — all three are appended *by the compiler*, never declared by the author; there is no declared-N concept anywhere today (M: no declared-pool field exists in `metrics` DDL `schema.sql:836-852`).
5. **Freshness (rule 5) is metric-grained, not table-grained**: `MetricCoverage` keys off `metrics.version`/`rule_version` + unit/dim existence (`metric_values_store.go:134-159`); a touched-FROM-set notion has no current representation — `Plan.Source` (`compile.go:86`) records only the primary.
6. **Human-only + subject conditions are injected by the compiler** (`subjectConds` `compile.go:1012-1031`), i.e. an author-written SQL would have to reproduce or declare them; bot exclusion would otherwise silently regress (pins `metrics_test.go:202`, `bot_group_test.go:71`, `join_test.go:253`).
7. **Docs/tests are the grammar's ballast**: `doc.go` op/refusal tables, `metric-language.js` (quoted refusal copy, re-verified by hand), and the refusal tests in §A2 are the surfaces track C of the manifesto rewrites; `strings-audit`/`docslockstep` pins touch copy, not grammar (not re-verified here — L).

**Not determined / caveats:** (a) `git branch --show-current` printed nothing — HEAD hash verified `24de283`, branch name taken from instructions; (b) refusal-test citations are function-name + line verified, bodies not exhaustively read (M); (c) not every frontend metric test file enumerated (only `metricstate/metricorder/metricformats/metricdenoms/metricorigins/services-cache.test.js` confirmed present by grep); (d) the `builtinSeed` table's per-entry line span is approximate (entries seen through `:1046`); (e) `console_metrics_test.go:45` doc comment says "one-hundred-four" while the assertion (and schema) say 109 — a stale comment, not a discrepancy in data.

---

## Part B · R32 — facts/store/sidecar inventory

**R2 — Fact-side baseline inventory (store / extract / sidecar)** — worktree `r32-baseline-facts`, baseline `24de283` (= `fcdf01e` + the docs-only scaffold commit; `PLANNING.md` named `fcdf01e` — no code delta). Clock checks 14:52–15:05 vs 15:33 deadline; all 6 sections complete. **Paths carry a `ROOT/` prefix = the worktree root ≡ repo root.** Confidence noted per section.

### B1. Schema inventory (confidence: high — full file read, `src/internal/store/schema.sql`, 1702 lines)

Applied as ONE baseline by `store.applySchema` on every `Open` (`ROOT/src/internal/store/schema.go:11-31`; called at `ROOT/src/internal/store/store.go:85`). Grain / role per table (line = `CREATE TABLE`):

| Table | Grain | Role | Key columns (line) |
|---|---|---|---|
| `matches` | per-match | record read + system (lifecycle/provenance) | `sha256 UNIQUE` (13), `map`, `tick_rate`, `frames`, `status`/`error` (38-39), **sidecar mirror** `sample_rate`/`position_frames` (42-43), `enc_messages` (45), **`analyzed_rule_version`** (46-57, analytics provenance; `SaveExtracted` never touches it) |
| `teams` | per-match×side | fact (record read) | PK (match_id, side) (68) |
| `players` | per-match×player (roster) | record read (identity; `is_bot` drives HumanOnly) | PK (match_id, steam_id) (85), `final_alive` (83) |
| `player_stats` | per-player-match | fact + primary metric source | PK (match_id, steam_id) (164); **stamps** `team`/`won`/`map` (161-163); `kills_by_weapon` JSON (141); see stamp call-out below |
| `rounds` | per counted round (dense 1..N; knife/warmup discarded at ingest) | fact | PK (match_id, number) (186), `start_tick`/`end_tick`/`freeze_end_tick` (176-183) |
| `round_player_sides` | per round×player (freeze-end sample) | fact (sample) + stamp | PK (match_id, round, steam_id) (203), `team` stamp (202) |
| `round_player_money` | per round×player (round-end sample) | fact (sample) | PK (223), `money_start`/`equip`/`spent` (220-222) |
| `round_economy` | per round×side | fact + stamp | PK (match_id, round, side) (245), `team` (244), `free_pistol_value` (238) |
| `events` | per typed event (seq per match) | fact (the typed event table) | `UNIQUE (match_id, seq)` (310), `kind`/`tick`/`round` (252-254), actors (255-257), flags (259-269), **stamps** `same_side` (283), `capped_dmg` (296), `attacker_inair` (268), `dmg` (272), `pos_*`/`apos_*` (304-309), payloads `detail_json`/`raw_json` (298-299) |
| `generic_events` | per raw game event (untyped) | fact | `name`/`tick`/`round`/`payload_json` (315-318) — no PK, no seq |
| `chat` | per message | record read | `channel`/`decrypted`/`key_source` provenance (333-340) |
| `warnings` | per parse warning | system | PK (match_id, seq) (347) |
| `jobs` | job queue row | system | `status`/`stage`/`progress` (353-356) |
| `sound_events` | per attributed player sound | fact (event-shaped; bots kept) | `steam_id` join key (385) |
| `round_classifications` | per round | analysis-rule stored output (fact under "all-stored rule") | PK (410), `rule_version` (408) |
| `round_side_classes` | per round×side | rule output + stamp | PK (448), `team` (447) |
| `player_round_stats` | per player-round | fact + stamps | PK (481), `side` (474), `won` (480), `rule_version` (467) |
| `match_trade_opps` | per player-match (sparse, humans-only) | rule output | PK (521), `opps`/`missed` (519-520) |
| `metric_values` | metric×match×subject×dim | metric furniture (materialized value) | PK (560), `value`/`n`/`metric_version`/`rule_version` (554-558) |
| `metric_deps` | metric→dep name | metric furniture | PK (577) |
| `clutches` | per clutch (round×player×start_tick) | fact / record read | PK (652), `replay_anchor` (651) |
| `engagements` | per detected duel | fact | PK (match_id, seq) (668), `kind` ∈ opening/trade/traded/untraded |
| `utility_events` | per grenade detonation | fact | PK (698), throw-side + `det_*` (684-692) |
| `player_career` | per player (cross-match) | derived rollup (raw counts only) | PK steam_id (708) |
| `saved_filters` | user config | system | (715-722) |
| `analysis_config` | single row (id=1 CHECK) | system (rule config) | `rule_version DEFAULT 2` (742) |
| `voice_presence` | per-match header | record read (sidecar index header) | PK match_id (757) |
| `metrics` | metric definition | metric furniture | `name UNIQUE` (838), `expr` (841), `scope/subject/partition` CHECK (842-844) |
| `query_history` / `saved_queries` / `report_templates` / `plugins` | user/system rows | system | (857, 866, 896, 1693) |

**Index blocks** (all `CREATE INDEX IF NOT EXISTS`): per-table block after `events`/`generic_events`/`chat` (`schema.sql:364-370`); `sound_events` with its "deliberately NO kind twin" rationale (`381-396`); `player_round_stats(match_id, steam_id)` (`483`); **Tier-1 library-wide block** with full rationale comments — steam_id-leading mirrors for `players`/`player_stats`/`player_round_stats`, `events(kind, match_id)`, `jobs(path)`/`jobs(match_id)`, `metric_values` match- and subject-leading, `metric_deps(dep_name)`, `match_trade_opps(steam_id, match_id)` (`580-636`; note `idx_match_trade_opps_steam` is kept although its reader retired, because dropping it would be DDL — `600-609`); `clutches` (`654`); `engagements` (`670-671`); `utility_events` (`700`). Pins: `TestTier1IndexesPresent` (`ROOT/src/internal/store/indexes_test.go:19`), `TestListJobsRecentCap` (`indexes_test.go:52`), `TestColumnListConstsMatchSchema` (`ROOT/src/internal/store/columns_schema_test.go:19`).

#### Stamp call-out (the treadmill examples, with status)

| Column | Where | Status at this baseline |
|---|---|---|
| `events.same_side` | DDL `schema.sql:273-283` | **live ingest stamp** (2026-11-17) |
| `events.capped_dmg` | `schema.sql:284-296` | **live ingest stamp** (2026-11-17/18, M7 gate-closer) |
| `events.attacker_inair` | `schema.sql:264-268` | **live ingest stamp** (column since 2026-11-08, whitelisted 2026-11-18) |
| `player_stats.team/won/map` | `schema.sql:151-163` | live ingest row stamps (metrics §5) |
| `round_economy.team` (244), `round_player_sides.team` (202), `player_round_stats.side` (474) / `.won` (480) | as noted | live stamps (ingest- or analyze-owned) |
| `player_stats.opening_kills` / `opening_deaths` | **DROPPED from DDL 2026-11-18** — retirement comment `schema.sql:110-116` | column gone from baseline; **existing DBs still carry it until the wipe** |
| `player_stats.damage_by_weapon` | **DROPPED 2026-11-18** — `schema.sql:133-140` | same (twin of `kills_by_weapon`, which stays) |
| `rounds.warmup`/`pregame`, `matches.warmup_rounds` | **DROPPED earlier** — pinned gone by `TestDiscardedWarmupColumnsGone` (`columns_schema_test.go:99-127`, comment: "existing database keeps its dead columns until a wipe + re-import") | same (twin of `kills_by_weapon`, which stays) |
| `speed`, `in_air` (per-tick movement) | **never columns** — "NOT stored (sidecar-only)" | queued treadmill additions the manifesto wants to pre-empt (`ROOT/dogfood/MANIFESTO.md:36-37`) |

### B2. The stamp treadmill — how a stamped fact lands end-to-end (confidence: high)

The full chain is **extract handler → `models` field → DDL column → `eventCols`/col-const + bind in `SaveExtracted` → metrics whitelist + seed exprs → frontend read (direct or via stored metric) → tests/docs**, i.e. ~6–9 files per stamp.

**Example A — `same_side` + `capped_dmg` (one handler, two stamps):**
1. Extract: `agg.hurt` computes both and stamps the row — `ROOT/src/internal/extract/agg.go:1083-1135` (`same := sameSide(...)` at 1098, `capped := a.capDamage(...)` at 1110-1115, `SameSide:`/`CappedDmg:` at 1123-1124); the identical predicate also gates the stat (`agg.go:1145`).
2. Models: `ROOT/src/internal/models/models.go:398-417` (`SameSide bool` 405, `CappedDmg int` 417).
3. DDL: `schema.sql:273-283` / `284-296` (each comment ends "No migration: the baseline only CREATEs … wipe + re-import").
4. Store write: col const `eventCols` `ROOT/src/internal/store/lifecycle.go:277-279`, INSERT `463-466`, bind `475-476`; write pins `TestSaveExtractedWritesSameSide` (`store_test.go:333`), `TestSaveExtractedWritesCappedDmg` (`store_test.go:370-404`, arg-order swap pin).
5. Read side: metrics column whitelist `ROOT/src/internal/metrics/whitelist.go:46-53`; seed exprs `schema.sql:1296` (`dmg_no_kill`), `1301` (`kill_conversion`), `1619` (`weapon_damage` — value IS the stamp); fixtures `ROOT/src/internal/metrics/fixtures_test.go:603-625, 989`; equivalence gates `ROOT/src/internal/metrics/combat_equivalence_test.go:78-95`, `ROOT/src/internal/integration/profile_weapons_gate_test.go:17-31`.
6. Frontend: reaches the stamp only through stored metric values / docs — user guide column list `ROOT/src/frontend/src/lib/docs/manuals/metric-language.js:110-112` (explains `same_side` semantics to users).

**Example B — `attacker_inair` (payload → typed column):**
extract flush-time derivation `agg.go:1759` (`payloadBool(payload, "attackerinair")`) → `models.go:427-432` → DDL `schema.sql:264-268` → bind `lifecycle.go:475` → row scans `queries.go:1281` (detail) / `queries.go:1671` (`eventRowCols`) → DTO `ROOT/src/internal/models/dto.go:163-165,205` → **frontend read**: `ROOT/src/frontend/src/lib/replay/renderer.js:4240` (airborne icon on the kill marker). Whitelist admission is itself a treadmill artifact: `whitelist.go:37-43` — the column sat in DDL+DTO since 2026-11-08 and reached the whitelist only on 2026-11-18 as an "oversight, not a rule"; golden acceptance `ROOT/src/internal/integration/kill_flags_test.go:52-106`.

**Example C — `kills_by_weapon` and its dropped twin:**
written at ingest (`lifecycle.go:397`), models `models.go:321`, DDL `schema.sql:141`, **live frontend reader**: weapon filter union `ROOT/src/frontend/src/lib/components/FilterBar.svelte:206-214`; deliberately excluded from the expression whitelist as a JSON blob (`whitelist.go:29-31`). Its twin `damage_by_weapon` was **dropped 2026-11-18** (`schema.sql:133-140`) after the `weapon_*` seeds replaced the fold (fold-vs-seed flip `86300be` cited at `schema.sql:135-137`).

**Dropped/retired list (the wipe-relevant trail):** `opening_kills`/`opening_deaths` columns + their seeds (`schema.sql:110-116`, `1315-1317`; extract comments `agg.go:969`, `agg.go:1000`; report fill `ROOT/src/internal/report/report.go:106-107`); `damage_by_weapon` (`schema.sql:133-140`); warmup/pregame columns (`columns_schema_test.go:99-127`); SQL oracles that survive only as test references — `store.GetCombatStats` (`combat_equivalence_test.go:78-95`), `analytics.EconomyRows` (`schema.sql:419-422`), `kastPerMatchSQL`/`kdPerMatchSQL` (`queries.go:59-62` region, "RETIRED from production").

**Ingest-owned row stamps** (SaveExtracted = the ONLY writer): team/won/map family, pinned end-to-end by `TestIngestRowStamps` (`ROOT/src/internal/store/ingest_stamp_test.go:10-18, 77+`), computed in `lifecycle.go:342-380`.

### B3. Replay sidecar (confidence: high on format/size/readers; medium on demoinfocs tick identity — flagged)

**Files per match:** `<matchDir>/positions.bin` + `positions.idx` + `meta.json`; `state.bin` + `state.idx` (+ `meta.weaponNames`); `voice/<steamid>.opus` + `.idx` (`ROOT/src/internal/sidecar/sidecar.go:29-43`, `78-86`; `state.go:101-110`).

**Positions encoding ("q16")** — `sidecar.go:6-27`: per frame `tick int32 LE` + `mask uint16 LE`, then per present slot (ascending) exactly **8 B**: `x,y,z int16` quantized at 1.0 world unit (clamped ±32767), `yaw uint8` ((deg+180)/360·256), `flags uint8` (bit0 airborne, bit1 ducking, bits2-3 side). **Not carried:** velocity, pitch, health, weapon, money — those are the *state* stream. Slot table = SteamIDs in first-seen order, in `meta.json` (`sidecar.go:23-25, 97-121`); controller identity is per-slot, not per-frame.

**State encoding (sparse per-change)** — `ROOT/src/internal/sidecar/state.go:3-110`: records `frame uvarint (absolute)`, `slot u8`, `mask uvarint`, then fields `hp, armor, weapon, inventory, magAmmo, reserveAmmo, attack, money, helmet, mainMag, mainReserve, reloading` (`state.go:39-75`); emitted only on change + full seed on each round start (`state.go:88-99`); Alive is a **sample** (`hp=0`), never inferred (`ROOT/src/internal/extract/extract.go:71-76`).

**Sampling rate:** `SampleRate = 64`, "samples are 1:1 with demo frames (full 64 Hz)" (`sidecar.go:58-60`). The extractor emits **once per `FrameDone` with no downsampling** — positions sink `extract.go:317, 343-368`, state sink `extract.go:382-393` — gated to start at the first counted round (`extract.go:325-342`). demoinfocs runs sequentially (`MsgQueueBufferSize(0)`, `extract.go:172-175`); progress ticks every 1000 frames (`extract.go:30-32`). *Flag:* not independently verified that `FrameDone` fires for every ingame tick; the 64 Hz 1:1 claim is from `sidecar.go:58-60` comments.

**Where written:** `sidecarPath = <sidecarDir>/<matchID>` with `sidecarDir` defaulting to `data.MatchesDir()` = **`$XDG_DATA_HOME/spectra/matches/<id>/`** (`ROOT/src/internal/library/library.go:985, 352-354`; `ROOT/src/internal/data/data.go:45-51`). Writer created before the parse (`library.go:986-1006`), half-written sidecar removed on any failure (`library.go:991`), closed with tick rate after Parse (`library.go:1077`), meta mirrored onto `matches.sample_rate/position_frames` via `SetPositionMeta` (`library.go:1100`; `ROOT/src/internal/store/lifecycle.go:570`).

**Size (measured, golden demo):** 8 B/player/frame → **~9.1 MB raw / ~2.5 MB zstd** for positions (`sidecar.go:26-27`); exact: 8,847,682 B raw / 2,493,442 B zstd over **133,599 frames**, state stream 18,713 records = 168,409 B raw / 98,860 B zstd (~1.9%/4.0% of the sidecar) (`state.go:112-120`); the demo parses **136,948 frames** (`state.go:115`). Blocks of ≤256 frames, independent zstd frames (`sidecar.go:31-34`, `BlockFrames` `64`); slot cap 16 (`sidecar.go:66`). Voice is "~77% of a match's rows" (`schema.sql:749`).

**Who reads it today:**
- Frontend replay renderer — HTTP routes `/api/sidecar/<id>/positions|meta|state` (`ROOT/src/main.go:585-664`), fetched by `ROOT/src/frontend/src/lib/replay/preload.js:449` and `state.js:230` (state range read `ReadStateRange`, `main.go:650`); `ROOT/src/frontend/src/lib/services.js:505` notes the positions bytes bypass bindings deliberately.
- **Go-side readers (all binary decoders, none SQL):** heatmap presence `sidecar.LoadProgress` (`ROOT/src/analyticservice.go:967-986`); spatial spacing/spread series `ROOT/src/platformservice.go:275` → `ROOT/src/internal/spatial/series.go:61-73` (`sidecar.Load` at 70; this is one of the "dead Go folds" the manifesto lists for deletion, `MANIFESTO.md:139`); replay meta `ROOT/src/replayservice.go:94`; `main.go:616`.
- **No Go SQL query reads the sidecar** — the only DB mirror is `matches.sample_rate`/`position_frames` (`schema.sql:40-43`). *Design answer: the sidecar is fully outside SQLite today; a tick table would be a second consumer of the same parse (open convergence question, `MANIFESTO.md:38,44`).*

### B4. Ingest flow (confidence: high)

**Pipeline** (one import job body, `ROOT/src/internal/library/library.go`):
claim → **one budget token taken BEFORE the compute lock** (`library.go:702-707`; pool `ROOT/src/internal/budget/budget.go:1-13`) → hash stage 0→0.10 → copy 0.10→0.20 → zstd sniff → **sidecar writers created** (`library.go:985-1006`) → `extract.Parse(ctx, reader, ParseOptions{Positions: sw, State: sw, Voice: vw, NetKey})` (`library.go:1014-1032`; stage range 0.20→0.90, `library.go:79-92`) → content guard (no players/rounds ⇒ fail, `library.go:1067-1075`) → `sw.Close(tickRate)` + `vw.Close()` (sidecar-first, `library.go:1077-1094`) → `SetPositionMeta` (`1100`) → **`SaveExtracted`** (`1105`) → `SaveVoicePresence` (`1120`) → stage analyze 0.95 → **`im.analyze` = `analytics.Compute` under the shared compute lock** (`library.go:1136-1143, 1179-1187`) → **`SetMatchRuleVersion` at the END of a successful Compute** (`ROOT/src/internal/analytics/compute.go:231`; writer doc `ROOT/src/internal/store/analytics.go:134-141`; column semantics `schema.sql:46-57`) → `AfterAnalyze` metric sweep 0.95→0.99 (`library.go:1158-1163`) → job done.

**`SaveExtracted`** (`ROOT/src/internal/store/lifecycle.go:297`): ONE transaction; `DELETE FROM <child>` for every `childTables` entry (`ROOT/src/internal/store/store.go:41-47` — a tick table must be added here or reprocess will strand rows); then per-table **prepared statements with row-by-row `Exec`** (no multi-row batching anywhere — `lifecycle.go:310-519`); col consts at `lifecycle.go:263-290` are the G1 one-list-per-table rule (pinned by `TestColumnListConstsMatchSchema`, `columns_schema_test.go:19`); match-header UPDATE skips `matchOwnedElsewhere` (`ROOT/src/internal/store/queries.go:44-48` = id/path/sha256/size + sample_rate/position_frames + analyzed_rule_version).

**Reprocess:** `Importer.Reprocess` (`library.go:490-538`) — coalesces via `FindPendingJobByMatch` (`library.go:495-499`), remembers the prior lifecycle state (`library.go:524-531`), skips sha256 dedupe, fail-fast on missing file (`library.go:500-515`); the job then re-parses from the managed copy (`resolveDemoFile`, `library.go:500`), **wipes + rewrites the sidecar** (`library.go:993`), `SaveExtracted` delete-then-reinserts all children, and analyze re-stamps `analyzed_rule_version` (the old stamp persists until then — `schema.sql:54-56`, `queries.go:37-43`).

**Single-writer / WAL constraints:** DSN `busy_timeout(5000)&journal_mode(WAL)&foreign_keys(1)` + **`SetMaxOpenConns(1)`** (`store.go:73-79`) — every write serializes on one connection; a concurrent console uses a separate `mode=ro + query_only` handle (`ROOT/src/internal/store/query_store.go:25-29, 70-73`). One process-wide compute lock for all `analytics.Compute` (`library.go:1170-1187`), and the token-before-lock order is pinned (`library.go:702-707`; `TestTokenWaitPrecedesComputeLock` `ROOT/src/internal/library/budget_test.go:107`; `TestSweepTakesTokenBeforeComputeLock` `ROOT/src/metricpass_test.go:468-478`).

**Existing guards a 1–2M-row/match table must respect:**
- Whole-match writes are single-tx row-by-row (`lifecycle.go:297-305, 463-482`) — a 1–2M-row table in that shape would hold the single writer for the whole insert; the sidecar's streaming-block precedent (`sidecar.go:31-34`) is the existing alternative.
- Read caps: `DefaultEventLimit = 50000`, `MaxEventLimit = 100000` (`queries.go:54-57`); `inListChunk = 400` bound-parameter chunking (`queries.go:633`); console row cap (`query_store.go:39-40`); `ListJobs` 200-recent display cap (`indexes_test.go:52`).
- Progress/event throttling: 100 ms byte-progress throttle (`library.go:70-74`); monotone stage ranges `library.go:79-92`.
- Scale reference: golden demo ≈ 133,599 frames × ~10 players ≈ **1.3M player-ticks** — consistent with the manifesto's "1–2M rows per match" estimate (`MANIFESTO.md:42`; that number is an estimate, no measured row count exists in-tree).
- Index cost: the Tier-1 block convention (`schema.sql:580-636`) — a tick table's indexes belong there with rationale.

**Where a tick-table producer would slot (two in-tree precedents):** (a) **streaming sink during parse** — `PositionSink`/`StateSink` interfaces (`extract.go:52-57, 124-133`), wired in `ParseOptions` at `library.go:1025-1030`, consumed by a writer that owns its own lifecycle — this is the sidecar path and avoids RAM; (b) **in-memory `ExtractedMatch` slice → `SaveExtracted`** (`ROOT/src/internal/models/models.go:566-590`) — simple but would hold 1–2M row structs in RAM for the whole parse (not measured in-tree; flagged as a design cost, not a finding).

### B5. Wipe surface (confidence: high)

**What `make deep-clean CONFIRM=1` wipes** (`ROOT/src/Makefile:127-150`): depends on `clean` (build outputs: `bin`, `.task`, `frontend/dist`, `frontend/bindings`, release artifacts — `Makefile:102-105`), refuses non-Linux (`129-131`) and refuses while a `spectra` process runs (`146-148`), then **`rm -rf` the three XDG-resolved dirs** (`149`; resolution `Makefile:116-121`): `$XDG_DATA_HOME/spectra` (→ `spectra.db` + `-wal`/`-shm` **the library, IRRECOVERABLE** per `Makefile:141`, plus `matches/` sidecars, `demos/`, `plugins/`, `tmp/`, `maps/ icons/ sounds/`), `$XDG_CONFIG_HOME/spectra` (`prefs.json`), `$XDG_CACHE_HOME/spectra`.

**"Baseline applied on every Open":** `applySchema` runs the embedded `schema.sql` in one tx; every statement is `CREATE … IF NOT EXISTS` / `INSERT OR IGNORE`, so "a stale database predating the baseline is simply **left as-is (it does not get upgraded)**" (`schema.go:11-17`, exec at `schema.go:23`; called `store.go:85`).

**Reaches an existing DB for free:**
- a **new table** (`CREATE TABLE IF NOT EXISTS`) — explicit: "A NEW TABLE reaches every existing DB at Open; adding these as columns on `round_classifications` would NOT" (`schema.sql:433-437`);
- a **new index** (`CREATE INDEX IF NOT EXISTS`);
- **new seed rows** (`INSERT OR IGNORE` keyed on UNIQUE name — "the one path by which rows … reach a database seeded before them", `schema.sql:945-947`, `819-822`).

**Requires the wipe:**
- **any new column / changed column / dropped column on an existing table** (CREATE-only, `schema.sql:1-5`; comments at `schema.sql:282, 295, 547-548, 677-679, 893-895` all end "wipe + re-import, never an ALTER"). Note drops already in the baseline (`opening_*`, `damage_by_weapon`, warmup columns) still exist in an old DB — harmless only because every write/read uses explicit col consts (`lifecycle.go:263-290`; `columns_schema_test.go:99-127`), but the wipe is what actually retires them;
- **changed seed TEXT for an already-present metric row** — `INSERT OR IGNORE` never rewrites stored expr/doc ("stale seed text stays as written until the row is wiped", `schema.sql:819-822`; also `ROOT/src/metricservice.go:361`);
- **stored `analysis_config.rule_version`** — insert-on-miss keeps a pre-existing row's version, "the owner's pending wipe + re-import covers those libraries" (`analytics.go:37-42`; DefaultConfig v2 `analytics.go:43-49`, mirrored DDL `schema.sql:742`);
- anything gated by `TestAnalysisConfigDDLDefaultsMatchGoSeed`-style pins (`schema.sql:730-735`).

**The one-wipe bundle — every known pending schema change (direction doc + this inventory):**

1. **NEW tick-state table** (per match×tick×player) + its indexes — `MANIFESTO.md:32, 42`, track A `MANIFESTO.md:151`. *Also required as companions:* a `tableNotes` entry (`ROOT/src/internal/query/schema.go:10-50`, pinned by `TestEverySchemaTableHasNote` `ROOT/src/internal/query/notes_test.go:53-78`), a `childTables` entry (`store.go:41-47`), and — if it becomes a metric source — a `whitelist.go` `sources`/`sourceColumns` entry + schema-consistency pins.
2. **Drops already committed in the baseline DDL, awaiting the wipe to take effect:** `player_stats.opening_kills`, `opening_deaths` (`schema.sql:110-116`), `player_stats.damage_by_weapon` (`schema.sql:133-140`), and the older warmup set `rounds.warmup`, `rounds.pregame`, `matches.warmup_rounds` (`columns_schema_test.go:99-127`).
3. **Stamps the direction names as tick-join replacements — drop decision owed by step 2 (not yet committed):** `events.same_side`, `events.capped_dmg`, `events.attacker_inair` (`MANIFESTO.md:36` names all three as treadmill stamps "become joins"; the DDL still ships them — treat as **candidates to drop in the wipe bundle, flagged open**: `capped_dmg`/`same_side` currently gate three live seeds, `schema.sql:1296, 1301, 1619`).
4. **Queued treadmill columns that must NOT be added as columns:** `speed`, `in_air` — currently sidecar-only, must land as tick facts instead (`MANIFESTO.md:36-37`); per-tick movement speed and in-air are *not stored anywhere in SQL today* (`MANIFESTO.md:37`).
5. **Non-schema, wipe-adjacent:** `weapon_fire` exists only in `generic_events` (unwhitelisted) and would need a fact surface (`MANIFESTO.md:37`); the dead Go folds the manifesto orders deleted regardless (`MANIFESTO.md:139`: win-percentage fold, unused spatial-series reader `spatial/series.go`, two unconsumed team aggregates, raw default scoreboard sort) — code, not schema, but part of the same migration bundle per `PLANNING.md:68-71`.

### B6. Event whitelisting / the read path new fact tables must join (confidence: high; one discrepancy flagged)

- **Typed taxonomy:** `events.kind` vocabulary is the const block `ROOT/src/internal/models/models.go:69-132` (kill/damage/blind/bomb_*/weapon_drop/pickup/grenade_*/… — "keep them stable once shipped").
- **Extraction side:** *every* game event also lands in `generic_events` — the generic escape hatch `ROOT/src/internal/extract/handlers.go:28-31` → `agg.genericEvent` (`ROOT/src/internal/extract/agg.go:1702-1714`, stored only for counted rounds); typed handlers build normalized `events` rows whose raw payload is paired per frame (`agg.go:1716-1734`, `addEvent` `agg.go:1690-1693`). So "whitelisting" at ingest = **which demoinfocs handlers get typed rows**; everything else is queryable only by `name` from `generic_events`.
- **Query side (typed):** `GetEvents` → `queryEvents` (`ROOT/src/internal/store/queries.go:994-1005, 1174-1214`) sharing **one** `eventWhere` with `GetEventKeys` (`queries.go:1007-1024, 1216-1254`) — round range, `Kind`/`Kinds IN` (`queries.go:1036-1044`), player, kill-role, side/team (`queries.go:1061-1136`), weapon/distance/headshot/bbox (`queries.go:1140-1170`). **Kinds are NOT server-whitelisted** — the `IN` list takes caller strings verbatim; the effective whitelist of "what the feed can ask for" lives client-side in `FEED_SOURCES` (one descriptor per source with jobs/fetch/normalize/merge rank — `ROOT/src/frontend/src/lib/replay/feed.js:129-216`, ranks events 0 / generic 1 / sound 2) and the landmark categories (`lib/replay/landmarks.js`, per AGENTS). Hard read cap `DefaultEventLimit` (`queries.go:54-57`).
- **Query side (generic):** `GetGenericEvents` (`queries.go:1678-1719`, name+round filter equivalence pinned `ROOT/src/internal/store/generic_events_test.go:10-40`), the name histogram that feeds the feed's per-name jobs (`queries.go:1605`), service wrapper `ROOT/src/libraryservice.go:415-427` with THE labeler `ROOT/src/eventlabels.go:13-25`.
- **Metric-expression whitelist (the one a new fact table must join for statistics):** `ROOT/src/internal/metrics/whitelist.go:19-24` (`sources` — events, engagements, rounds, player_stats, player_round_stats, round_economy, clutches, utility_events, chat, match_trade_opps, round_classifications, round_side_classes, round_player_sides, engagements_victim) + per-source `sourceColumns` (`whitelist.go:32-120`), subject/join/denominator structures in the same file; pinned against the real DDL by `TestSchemaConsistency*` (`ROOT/src/internal/metrics/schema_consistency_test.go:15-30`) and `TestColumnListConstsMatchSchema` on the store side.
- **SQL console:** layered safety — `ValidateReadOnlySQL` (single statement, read-only leading keyword, no write verbs anywhere, PRAGMA read-allowlist) **before** execution, then a separate `mode=ro + query_only` connection, ctx deadline, row cap (`ROOT/src/internal/store/query_store.go:20-40, 390-395`). **⚠ Discrepancy (matches R31 §A7):** **no table-name allowlist** in the console path (no `allowedTables`-style symbol anywhere in `src/`); the console's table surface is *everything in sqlite_master* (`Schema()` `query_store.go:450-454`, notes at `ROOT/src/internal/query/schema.go:10-50`). The manifesto's rule-1 claim that "the SQL console already runs exactly this layer" is therefore **approximate at this baseline** — the only real table allowlist today is the metrics engine's (`whitelist.go`). Also required for any new table: a `tableNotes` entry (`notes_test.go:53-78`).

### B7. Not determined / flagged (R32)

- demoinfocs `FrameDone` ↔ ingame-tick identity (64 Hz 1:1) asserted from comments only (`sidecar.go:58-60`); not independently verified.
- No in-tree measured row counts for `events`/`generic_events` per match (only sidecar frame/record counts); the 1–2M tick-row figure is the manifesto's estimate (`MANIFESTO.md:42`).
- Exact frontend call site that renders the `weapon_damage` stored value (Profile weapons table) not traced — only the seed and gate chain was verified.
- `same_side`/`capped_dmg`/`attacker_inair` **drop** is an inference from `MANIFESTO.md:36`, not a committed decision — step 2 must ratify it.
- `PLANNING.md` named baseline `fcdf01e`; brief said `24de283` (docs-only delta) — corrected in `PLANNING.md` at compile time.

---

## Part C · R33 — surfaces/prefs parity inventory

**R33 — surfaces/prefs baseline** — worktree `r33-baseline-surfaces`, baseline `24de283`; delivered via wrap report (deadline 15:33 passed; worktree clean, read-only throughout, no new work taken on nudge). Consumer: `MANIFESTO.md` §4 (components/layouts), §8 (three classes), §9 track D. **Class shorthand:** **M** = metric (stored `metric_values` via five-state machine) · **F** = fact (stored scalar/recorded column) · **R** = record (row/event read as-is) · **A** = view-level arithmetic (parity must relocate or sanction) · **UI** = chrome/state.

**Completion:** all sections complete for read surfaces; gaps marked — Heatmaps + CompareRounds rows Med-confidence (grep-level), P07 history ADR/KAST intent unconfirmed, A-class exception status of five view-arithmetic sites not verified against the ratified list (each needs a ruling at design, not a guess). Library.svelte not audited (out of stated scope — listed as non-candidate with flag).

### C1. Match view surfaces (`src/frontend/src/lib/views/Match.svelte`, 1973 lines)

#### C1.1 Shared chrome

| Surface | Cite | Data path | Class |
|---|---|---|---|
| Header scoreline (team names + `scoreCT–scoreT`, map, duration, patch, StatusChip, voice badge) | Match.svelte:1216-1262 | `getMatch`/`getMatchSummary`/`getVoicePresence` (399-419) → `MatchService.GetMatch`/`GetMatchSummary` (matchservice.go:26,148), `VoiceService.GetVoicePresence` (voiceservice.go:136) | F/UI |
| Warnings panel (cap 200 + honest remainder) | Match.svelte:1266-1289 | `getWarnings` → `LibraryService.GetWarnings` (libraryservice.go:324) | R |
| RoundStrip (per-round winner cells, tooltip winner+reason) | Match.svelte:1291-1299; `components/RoundStrip.svelte:2-27,99-105` | `getRounds` → matchservice.go:44; `sideAtRound`/`teamStartClass` | R |
| Tab bar (9 deep-linkable tabs) | Match.svelte:1301-1307; `MATCH_TABS` in `lib/router.js` | — | UI |
| Loading/error | Match.svelte:1204-1213, 1955-1957 | — | UI |

#### C1.2 Overview

| Surface | Cite | Data path | Class |
|---|---|---|---|
| Top identity cards (default: top_fragger, best_adr, most_util, entry_opens, most_mvps) | selection `pinnedInSequence('overview')` + economy exclude Match.svelte:803-809; render 1310-1360; `OVERVIEW_COMPOSERS` 170-176; `topStats` 1166-1187 | ONE unioned read: `listMetrics`+`readOrder('overview')`+`readOverviewPins`+`readEconomyPins`+`getMetricValuesForMatch`+`getMetricComputeState` (743-852) → metricservice.go:147,700,317 | M(identity) |
| Roster CT/T/Other: name + K/D/A compound + ADR chip | 1393-1500; `rosterAdr` 1376-1392; `rosterKda` 967-976; `fixedPres` 895-902 | `FIXED_SLOTS` named slots in same ONE read (368-376, 828-851) | M |
| Honest states: empty pool ⇒ **no card** (1175); unresolvable key ⇒ no card (1180); state ⇒ chip card w/ progress (1312-1332); roster dash (1381-1390); state in title only (`compoundTitle` 951) | | `metricPresentation` (metricstate.js:57) | UI |

#### C1.3 Scoreboard

| Surface | Cite | Data path | Class |
|---|---|---|---|
| Fixed block **Name/Team/Score** | `SCORE_COLS` 134-140; `fixedCell` 1530-1532; team cell 1650-1661; name cell 1629-1649 | `cellText` over `getScoreboard` → matchservice.go:39, humans-only + `listedPlayers` (547-564) | F/descriptor |
| Metric columns (default 19 pins: K, D, DMG, Util, MVPs, A, ADR, KAST%, HS%, K/D, KDA, 2K–5K, entry K/D, Trade, Streak) | headers 1573-1607; cells `metricCellView` 1536-1555; `sbCols` 680-692; pins effect 727-864 | `parseStoredPins('spectra:pinned-metrics')` → `resolvePins` → `composedSequence('match')` ∩ pins; ONE `getMetricValuesForMatch` + compute state + progress feed (340-393) | M |
| Sort: multi-key fold, nulls-last, default `kills` re-spelled to `m:<id>`, client-side only | `sortStack` 209-211; 579-632; `toggleSort` 982-986; re-spell 820-827 | stored metric values; raw only name/side/score (630-631) | M/F |
| Transposed shape | toggle 995-1004; render 1669-1755; `statCols` 699-701 | viewstate `matchKey('selection')` (233-328); open shape pref (290-299) | M/UI |
| Five-state cells + live progress; `metricError` banner | 1536-1555, 874-886, 1556-1563 | metricstate.js:32-103 | UI |

#### C1.4 Rounds tab
Round rows: RD, Winner(+team name via `winnerName` parity 1115-1118), Reason, Duration, Site, MVP, First blood, Kills — Match.svelte:1759-1863, all `getRounds` (**R/F**); compare checkbox max 4 + hint + Compare button (1808-1817, 1865-1874, viewstate); separators `separatorFlags` (338); watch ▶ `watchRound` 1030-1036.

#### C1.5 Embedded tabs
Economy → 1876; Utility → 1878; Heatmaps → 1880; Combat → 1882; Reports embedded → 1884; Details → 1885-1953.

**Details:** Key-facts `<dl>` (server, tickrate, frames, size, imported, parser, voice, warnings, source, demo-copy state + Free) Match.svelte:1894-1952 — **F**; Explorer diagnostics embedded 1953 (`GetProvenance`/`GetEntitySummary`, platformservice.go:160,230).

#### C1.6 Economy tab (`views/Economy.svelte`, 541 lines)

| Surface | Cite | Data path | Class |
|---|---|---|---|
| Head `N rounds` + note | 409-417 | `getEconomy` → analyticservice.go:777 | UI count |
| **EconCurve** (equip/net-worth toggle, winner strip, hover) | embed 419; `components/EconCurve.svelte:2-28,45,245-363` | `econ.js` formulas over economy rows | **A** |
| **Summary cards** (default 6: pistol_hold, team_force_wins, team_force_rounds, avg_equip_gap, lost_equip, team_lost_equip) — stored rows, badges, drill | selection 121-157 (`resolvePins('economy')` = `metric_economy`); `econCards` 318-331; render 421-434; `matchRow`/`teamValues`/`fmtStored` 161-182 | ONE `getMetricValuesForMatch` | M; drill anchors = sanctioned navigation facts (234-282) |
| Rounds econ table: buy-class chips + why row + rule version | 443-534, 511-533 | GetEconomy stored rule outputs | stored-rule |
| **CT/T Deaths per round** | 498-499, fold 90-103 (criterion 78-89) | view fold over `getPlayerRounds` → analyticservice.go:787 | **A (round-grain, documented exception)**; no side sample ⇒ dash |
| Loss-bonus pips | 500-509 | `lossPips` over recorded bonus | F+A |
| States: loading 406-407; no rounds 438-439; death dash 498-499 | | | UI |

#### C1.7 Combat tab (`views/Combat.svelte`, 690 lines)
- **Engagements table** (round, clock, merged kind chips, killer/victim, distance) 511-591 → `getEngagements` analyticservice.go:809, merge presentation-only (209-259) — **R**.
- Kind multi-select (none-checked = no filter, 446-509, 322-326) + Round select default round 1 (494-509) — control; viewstate `matchKey('combat')` (110-178).
- **Clutches table** (1vN, won/lost chip, bomb, HP) 623-687 → `getClutches` analyticservice.go:792 — **R**; won ON/lost OFF toggles 604-617; filter-aware empty copy 357-365, 618-621.
- Loading/error 417-431; `loop_secs` stamps ▶ loops (82-89).

#### C1.8 Utility tab (`views/Utility.svelte`, 708 lines)
- Throw log rows (kind, thrower, clock, dmg, blind, affected, coords) 428-482 → `getUtility` analyticservice.go:814 — **R**; zero-dash carve-outs (`coordCell` 208-214).
- Filters kind/thrower/round + N-of-M count 381-422 — control (viewstate 80-112); UI row count sanctioned.
- **Damage bars** 493-603 and **blind-time bars** 612-704 — **A** (view sums, `damageBars` 279-298 / `flashBars` 307-328); cards hide entirely when `!any` (493, 612).

#### C1.9 Heatmaps (`views/Heatmaps.svelte`) — **Med confidence**
Raster + `grid.max`/`grid.samples`/grid-size readouts (256-259, 708) → `getHeatmap`/`GetHeatmapKD` (analyticservice.go:867; binding line 383) — Go-computed **R**. Filter toolbar kind/player/team/round-range/layer/region (579-661), viewstate `matchKey('heatmaps')` (61-67, 294-307); sanctioned replay-filter arrival path (433-439); stale/pack notes 563-574.

#### C1.10 Drill-downs
**RoundDetail** (Med-High): info facts 396-453; kills feed 456-516 (R); bomb timeline 518-564 (R); economy card 566-610 with **money mean `moneySampledSum/moneySamples` = A** (601); chat 614+ (R); fetches 102-109.
**CompareRounds** (Med): equip/money/spent 301-317 (R), duration 325-328, **nade/dmg/flash summary line 225 = A**, event columns; fetches 112-118.

### C2. Profile view surfaces (`views/PlayerProfile.svelte`, 1050 lines)

| Surface | Cite | Data path | Class |
|---|---|---|---|
| Career StatCard tiles (default 13: Matches, Win%, ADR, ADR±σ, K/D, HS%, KAST%, opening/trade rate, clutches, clutch win %, avg flashed, avg util dmg) | `careerCards` 427-437; render 740-781; effect 224-281 | pins `localStorage 'spectra:pinned-profile-metrics'` (189, 210-219) → `pinnedInSequence('profile')`; ONE `getMetricValuesForPlayer('', ids)`+state (253); order/hidden (404-417) | M (+raw `wins` sub on Matches tile, 760 = F) |
| Empty invariant (no tiles ⇒ no grid) + careerError Retry | 740, 734-739 | | UI |
| Trend sparkline + dot tooltips + min/max caption; picker over `inSequence('match')` | picker 790-804; spark 483-517; render 811-845; states 806-844 | `getCareerTrend` → profileservice.go:201; viewstate `seed('player')` 56-61 | M |
| Sides table (Rounds/Win%/ADR/KAST/K-D) | 886-909; `SIDE_SEEDS` 529; 572-587 | partitioned rows via ONE `getMetricValuesForPlayer(sid,…)` (535-570), percent×100 (562) | M |
| Maps table (Matches/Wins/ADR) | 913-945; `MAP_SEEDS` 530 | same | M + A (sort) |
| Weapons top-8 (Kills/Damage/HS) | 947-971; `WEAPON_SEEDS` 531 | same | M + A (sort/cap 8) |
| Split-cell five-state + table-empty consults states | 853-882, 642-676 | metricPresentation | UI |
| Match history: imported, map, W/L, score, start side, **K/D/A**, ADR, KAST% | headers 978-992; rows 994-1043; empty 1040-1042 | K/D = `getMetricSeries` (299-335 → metricservice.go:725); A = stored assists fold (352-357); **ADR/KAST = raw history fields (1037-1038)** | M + **F** — flagged parity question |
| Loading/profileError | 712-717, 1047-1049 | | UI |

**Adjacent Profiles list** (Med): ADR/Matches columns metric-backed — Profiles.svelte:15-16, 82-206 (`getMetricValuesForPlayer('')` + compute state, five-state cells, metric sort).

### C3. Reports (`views/Reports.svelte`, 885 lines)
1. **Template grid** 707-732 → `ListReportTemplates` (platformservice.go:433); empty gated on error (725-731).
2. **Targets** 734-780: MatchPicker (record list from `ListMatches`, libraryservice.go:196); PlayerPicker statline = **stored seeds** `kills/deaths/assists/adr/rounds_played` via ONE `getMetricValuesForMatch` + career pair (238-284, comment 236-237); round input clamped to counted rounds (199-215).
3. **Stats appendix**: TokenSelect 814-830; universe = `composedSequence('match')` interleaved with raw (318-330); metric picks → ONE `getMetricValuesForMatch` + `getPlayerRefs`, subject-aware labels incl. identity `valueKey` (374-463); readout = expr line + rows chip or **state chip** (836-867); meta line `per subject · N rows · match #id` vs `value not computed — <state>` (606-618). **Record offer = exactly `raw:score`** (`rawItems` metricorder.js:451-458; comment 299-310); raw rows off `GetScoreboard`, N = stored `roundsPlayed`, static "recorded value" chip (440-453, 846-851). Hidden fixed stats still addable (317). Selection viewstate `seed('reports')` (48-66).
4. **Export** `render()` 536-554: `RenderReport` (Go template, platformservice.go:474) → client-side `compositeText` 662-667 (`appendixMd` 620-635 / `appendixHtml` 641-657), sections ranked by composed sequence (`appendixEntries` 569-583) → `downloadText`. UI and export render the same object.

### C4. Controls and dialogs

| Control | Cite | Effect | Persistence |
|---|---|---|---|
| **MetricOrderDialog** (3 sections) | `components/MetricOrderDialog.svelte:1-580`; opened from Builder (Builder.svelte:96,1975) | ↑/↓ whole-sequence write-through (`move` 175-197); eye show/hide fixed (`toggleHidden` 204); metric unpin via Builder writer (`unpin` 286-304); overview two-way pin (227-239); **Economy `$` toggle** (249-261); **"Scoreboard starts transposed"** checkbox (532-544, only writer, untouched by Reset); **Reset** deletes order+hidden(both scopes)+overview order+pins+economy (338-365) | kvstore prefs |
| **Builder** | Builder.svelte | list filters origin/scope/subject/denom/pinning (173-262, 511-596); **`togglePin` 879** = ONE writer of both localStorage pin keys (56-57, 437-447); expression editor + debounced `validateExpr` (283); preview table with own sort (306-363, 1830-1930) | localStorage + kvstore |
| Sort clicks / transpose / compare picker | Match.svelte:982-1004, 1063-1077, 1508-1518 | sort stack (reseed per id 547-550); shape; round selection | component/viewstate → URL for compare |
| Combat/Utility/Heatmaps/Reports/trend filters | Combat 446-509,604-617; Utility 381-417; Heatmaps 579-661; Reports 744-777,815-830; PlayerProfile 790-804 | rows/cards/sparkline shown | viewstate registry keys (C5.4) |
| EconCurve toggle | EconCurve.svelte:245-260 | series | component state |
| MatchPicker / PlayerPicker / TokenSelect / SuggestInput | MatchPicker.svelte:2-18; Reports 744-763; 815-830; PlayerProfile 700-709 | targets/selections | prop-driven |

### C5. Pref families

#### C5.1 kvstore (registered `src/prefs.go`; frontend-written, Go never consumes — services.js:1204-1206)

| Key | prefs.go | Written by | Read by | Component-config absorption |
|---|---|---|---|---|
| `metric_order_match` | :46 | dialog `writeOrder('match')` (metricorder.js:700) | Match:745; Reports:179; dialog:117; PlayerProfile trend:142 | scoreboard sequence config |
| `metric_order_profile` | :47 | dialog | PlayerProfile:236,406; dialog:118 | profile card-block sequence |
| `metric_order_overview` | :60 | dialog | Match:753; dialog:122 | overview row sequence |
| `metric_pins_overview` | :61 | dialog only (`writeOverviewPins` metricorder.js:744) | Match:754,803-809; dialog:134 | overview instance-set membership |
| `metric_economy` | :71 | dialog (`writeEconomyPins` :767) | Match:758,808; Economy:123,131 | Economy tab layout list + overview carve-out placement |
| `metric_hidden_match` / `metric_hidden_profile` | :78-79 | dialog `writeHidden` (:722) | Match:748,777-780; PlayerProfile:406,431 | per-instance visibility (Name exempt, `HIDE_EXEMPT` metricorder.js:496) |
| `scoreboard_starts_transposed` | :91 | dialog checkbox only | Match:290-299 | layout open-shape option |
| `loop_secs` (adjacent) | :157 | Settings | Combat:84, Utility:51, RoundDetail:69, CompareRounds:94 | replay-entry param, not stat display |

Absent/present rule shared: **absent ⇒ default by name; present (even `[]`) ⇒ verbatim** (`resolvePins` metricorder.js:843-852; non-array order ⇒ absent :691-695; strict `true` transpose :814-816); dated caveat — present key does not pick up later defaults (:101-104).

#### C5.2 localStorage pins (two sites, pinned by `webstorage.test.js:30-35`)
- `spectra:pinned-metrics` — written Builder (56, 437-447, togglePin 879); read Match:659, Builder:424; absent ⇒ `DEFAULT_PINS.match` (19 names, metricorder.js:265-285).
- `spectra:pinned-profile-metrics` — written Builder (57); read PlayerProfile:189,218; absent ⇒ `DEFAULT_PINS.profile` (13 names, 286-300).
- Parse + drop-never-migrate only in `parseStoredPins` (metricorder.js:799-808).

#### C5.3 Default tables the component catalog must reproduce (metricorder.js)
`DEFAULT_RANKS` match 172-196 / profile 205-219 / overview 225-231; `FIXED_BLOCK` 355-362 (Name/Team/Score; profile empty); `FIXED_RANKS` 402-409; `DEFAULT_PINS` 264-317; `DEFAULT_ECONOMY` 114-121; `RAW_FIELDS` = {Score} (431-438); `overviewDefs` identity + economy carve-out (482-487); resolvers `resolveOrder` 548, `inSequence` 609, `pinnedInSequence` 629, `composedSequence` 651.

#### C5.4 Viewstate (process-scoped; component layouts must pick their own durable home)
`matchKey('selection')` (Match:233-328), `matchKey('combat')` (Combat:110-178), `matchKey('utility')` (Utility:80-112), `matchKey('heatmaps')` (Heatmaps:61-67,307), flat `reports` (Reports:48-66), flat `player` (PlayerProfile:56-61), Builder filter seed (Builder:173-262).

### C6. THE PARITY TABLE (acceptance checklist)

#### Match — shared chrome
| # | Item | Rendered in | Data path | Class | Notes |
|---|---|---|---|---|---|
| M01 | Team names + final score line | Match.svelte:1218-1222 | GetMatch/GetMatchSummary | F | team color = start-side identity (`teamCls` 1131) |
| M02 | Map · duration · patch · StatusChip | Match.svelte:1244-1247 | GetMatch | F/UI | |
| M03 | Voice/encrypted-chat badge | Match.svelte:1248-1254 | GetVoicePresence | F | |
| M04 | Warnings panel + remainder line | Match.svelte:1266-1289 | GetWarnings | R | loading chip 1274; cap 200; honest hidden count |
| M05 | RoundStrip per-round winner cells | Match.svelte:1291-1299; RoundStrip.svelte:99-105 | GetRounds | R | no-winner = warmup tint; **design call: candidate vs stay-view** |
| M06 | Tab bar | Match.svelte:1301-1307 | router | UI | |
| M07 | Loading / error | Match.svelte:1204-1213, 1955-1957 | — | UI | |

#### Match — Overview
| # | Item | Rendered in | Data path | Class | Notes |
|---|---|---|---|---|---|
| M08 | Identity cards (default 5) | Match.svelte:1310-1360 | ONE unioned stored read (743-852) | M(identity) | empty pool ⇒ **no card** (1175); state ⇒ chip card (1312-1332); unresolvable key ⇒ no card (1180); number from stored row, never raw field (904-916, 1196-1200) |
| M09 | Roster CT/T/Other: name + K/D/A + ADR chip | Match.svelte:1393-1500, 1376-1392, 967-976 | named-slot metric rows (368-376) | M | dash on nodata; state in title only (951) |

#### Match — Scoreboard
| # | Item | Rendered in | Data path | Class | Notes |
|---|---|---|---|---|---|
| M10 | Name / Team columns | Match.svelte:1629-1661 | GetScoreboard | F | Name unhideable; humans-only (1643-1648) |
| M11 | Score column (raw) | Match.svelte:1530-1532 | GetScoreboard | F | owner ruling: no seed (metricorder.js:347-349) |
| M12 | Pinned metric columns (default 19) | 1573-1607, 1536-1555 | stored rows (743-864) | M | shortName header; ⓘ=`doc`; value/`—`/chip; tooltip `n=` |
| M13 | Multi-key sort fold (seed kills DESC) | 209-211, 579-632, 982-986 | stored values / raw name·side·score | M/F | nulls-last both directions; seed re-spell 820-827; never re-requests store order |
| M14 | Transposed shape | 995-1004, 1669-1755 | same | M/UI | registry per match; pref seeds open shape; entering clears sort marks |
| M15 | Metric error banner | 1556-1563 | — | UI | |
| M16 | Five-state cells (processing/failed/fresh/no-data/behind) + live progress | 1536-1555, 874-886; metricstate.js:32-103 | compute state + progress feed | UI | **all five words are parity** |

#### Match — Rounds tab
| # | Item | Rendered in | Data path | Class | Notes |
|---|---|---|---|---|---|
| M17 | Round rows: RD, Winner(+team), Reason, Duration, Site, MVP, First blood, Kills | Match.svelte:1784-1861 | GetRounds | R/F | dashes for absent fields; separators 338; winner name via parity 1115 |
| M18 | Compare checkbox (max 4) + hint + button | 1808-1817, 1865-1874 | viewstate → URL `?rounds=` | control | |

#### Match — Economy tab
| # | Item | Rendered in | Data path | Class | Notes |
|---|---|---|---|---|---|
| M19 | EconCurve (equip/net-worth toggle, winner strip, hover) | Economy.svelte:419; EconCurve.svelte:45,245-363 | `econ.js` formulas over GetEconomy | **A** | sharpest open decision |
| M20 | Summary cards (default 6) + badges + drill | Economy.svelte:421-434, 318-331 | stored rows via `metric_economy` (121-157) | M | absent row ⇒ dash; half-present team pair ⇒ dash (172-178); drill anchors navigation-only (234-282) |
| M21 | Rounds econ table + why row + rule version | Economy.svelte:443-534, 511-533 | GetEconomy stored outputs | stored-rule | empty 438 |
| M22 | CT/T Deaths per round | Economy.svelte:498-499, 90-103 | view fold over GetPlayerRounds | **A (round-grain, documented)** | no side sample ⇒ dash never 0 (78-89) |
| M23 | Loss-bonus pips | Economy.svelte:500-509 | `lossPips` over recorded bonus | F+A | $ in title |

#### Match — Combat tab
| # | Item | Rendered in | Data path | Class | Notes |
|---|---|---|---|---|---|
| M24 | Engagements table | Combat.svelte:511-591 | GetEngagements (merge presentation-only) | R | empty/error variants 582-588 |
| M25 | Kind multi-select + Round select | Combat.svelte:446-509 | viewstate | control | none-checked = no filter |
| M26 | Clutches table | Combat.svelte:623-687 | GetClutches | R | filter-aware empty 357-365 |
| M27 | Won/Lost toggles | Combat.svelte:604-617 | viewstate | control | both off ⇒ explicit empty text |

#### Match — Utility tab
| # | Item | Rendered in | Data path | Class | Notes |
|---|---|---|---|---|---|
| M28 | Throw log rows | Utility.svelte:428-482 | GetUtility | R | zero-dash carve-outs (208-214) |
| M29 | Kind/Thrower/Round filters + N-of-M | Utility.svelte:381-422 | viewstate | control/UI | options = rounds with throws only |
| M30 | Damage-per-round bars | Utility.svelte:493-603 | view sums (279-298) | **A** | hides when no drawable data (493); computed badge |
| M31 | Blind-time bars | Utility.svelte:612-704 | view sums (307-328) | **A** | hides when empty; inferred badge |

#### Match — Heatmaps (Med confidence)
| # | Item | Rendered in | Data path | Class | Notes |
|---|---|---|---|---|---|
| M32 | Heat raster + max/samples/grid readouts | Heatmaps.svelte:256-259, 708 | GetHeatmap/GetHeatmapKD | Go-computed R | stale/pack notes 563-574 |
| M33 | Kind/player/team/round-range/layer/region filters | Heatmaps.svelte:579-661, 307 | viewstate | control | sanctioned replay-filter arrival (433-439) |

#### Match — Details + drill-downs
| # | Item | Rendered in | Data path | Class | Notes |
|---|---|---|---|---|---|
| M34 | Key facts dl + demo-copy state + Free | Match.svelte:1894-1952 | GetMatch/GetVoicePresence | F | states copied/external/missing/— (1932-1948) |
| M35 | Explorer diagnostics | Match.svelte:1953; Explorer.svelte:158,212,254 | GetProvenance/GetEntitySummary | R (technical) | |
| M36 | RoundDetail: info, kills feed, bomb, economy card, chat | RoundDetail.svelte:396-619+ | GetRoundDetail/GetRounds/GetScoreboard/GetEconomy | R/F + **A** (money mean 601) | empties 458,520,605,616 |
| M37 | CompareRounds: econ columns, utility summary, events | CompareRounds.svelte:225,301-317,325-328 | GetEconomy/GetUtility/GetRoundDetail/GetRoundClasses | R + **A** (summary line 225) | |

#### Profile
| # | Item | Rendered in | Data path | Class | Notes |
|---|---|---|---|---|---|
| P01 | Career StatCard tiles (default 13) | PlayerProfile.svelte:740-781, 427-437 | ONE GetMetricValuesForPlayer('') (224-281) | M | no tiles ⇒ no grid; Matches sub = raw `wins` (760); five-state slot; careerError (734) |
| P02 | Trend sparkline + tooltips + min/max | PlayerProfile.svelte:811-845, 483-517 | GetCareerTrend | M | states error/only-one/no-trend (806-844) |
| P03 | Trend metric picker | PlayerProfile.svelte:790-804 | inSequence('match') | control | falls back to `adr` (160-163) |
| P04 | Sides table | PlayerProfile.svelte:883-911 | partitioned stored rows (535-570) | M | per-cell five-state (853-869); empty consults states (870-882) |
| P05 | Maps table | PlayerProfile.svelte:913-945 | same | M + A sort | row → Library filter |
| P06 | Weapons top-8 | PlayerProfile.svelte:947-971 | same | M + A sort/cap | |
| P07 | Match history rows (incl. K/D/A, ADR, KAST%) | PlayerProfile.svelte:974-1046 | K/D = GetMetricSeries; A = assists fold; **ADR/KAST = raw fields (1037-1038)** | M + **F** | empty `noHistory` (1041); state in title (379-395); **raw ADR/KAST = parity question** |
| P08 | Player finder | PlayerProfile.svelte:700-709 | ListPlayers | control | |
| P09 | Loading / profileError Retry | PlayerProfile.svelte:712-717, 1047-1049 | — | UI | |
| P10 | Profiles list ADR/Matches columns (adjacent, Med) | Profiles.svelte:15-16, 82-206 | GetMetricValuesForPlayer('') + state | M | metric sort key (170) |

#### Reports
| # | Item | Rendered in | Data path | Class | Notes |
|---|---|---|---|---|---|
| R01 | Template grid | Reports.svelte:707-732 | ListReportTemplates | R | empty gated on error (725) |
| R02 | Match target (MatchPicker) | Reports.svelte:742-750 | ListMatches | R | embedded ⇒ fixed, no picker (738) |
| R03 | Player target + statline | Reports.svelte:752-764, 238-284 | stored seeds GetMetricValuesForMatch | M | per-half dash + state title |
| R04 | Round target (counted clamp) | Reports.svelte:766-778, 199-215 | GetRounds | F | |
| R05 | Appendix token field (metrics + `raw:score`) | Reports.svelte:814-830, 318-343 | composedSequence universe | control | |
| R06 | Per-stat readout: expr, rows chip / state chip / recorded chip | Reports.svelte:836-868, 473-500 | stored read + state | M/R | loading `…`, "failed" (842-845) |
| R07 | Appendix export (md/html, sequence order, `value not computed — <state>`) | Reports.svelte:620-667, 569-618 | same object as UI | M/R | raw N = stored roundsPlayed, never a formula N |
| R08 | Save + Generating… | Reports.svelte:827-829 | RenderReport + downloadText | UI | |

**Marked gaps:** Heatmaps rows M32/M33 Med-confidence; CompareRounds M37 column list incomplete (grep-level); P07 raw ADR/KAST status unconfirmed; four **A-class** items (M19 EconCurve, M22 deaths fold, M30/M31 Utility bars, M36 money mean, plus M37 summary line) not checked against the ratified exception list (`MANIFESTO.md:139`) — each needs an owner ruling at design, not a guess.

### C7. Explicit non-candidates (confirm/overturn at design)
1. **Replay** (`views/Replay.svelte`) — spatial/temporal canvas; named chrome in `MANIFESTO.md:86`.
2. **Heatmaps raster canvas** — spatial image; its filters/counters (M32/M33) are candidate controls.
3. **SqlConsole** — read-only power surface (AGENTS power-surface exemption).
4. **Builder expression editor + preview** — metric-authoring power surface; its pin toggles/filters ARE controls (C4).
5. **ReportsBuilder** (`ReportsBuilder.svelte:1-40`) — template *authoring* editor; consumption side (Reports) is in scope.
6. **Settings / Library / Explorer / CommandPalette / MapPackPrompt / DocsPopup** — chrome/record lists/diagnostics (Library not audited in depth — flagged).
7. **Job/progress widgets** — render only through StatusChip (AGENTS).
8. **RoundStrip** — borderline (stat-bearing but navigation-coupled); shipped as M05 for an explicit decision.
9. **Raw event reads (kill feed, chat, bomb)** — records by definition (`MANIFESTO.md:82`), but must become *record-bound components* if the feed is dogfooded — open scope question, listed not presumed.

**Could not determine (flagged):** Heatmaps toolbar exact filter set (Med); CompareRounds full columns (Med); Library internals (not audited); P07 history ADR/KAST intent (comment at PlayerProfile.svelte:294 covers K/D/A only); A-class exception status of the five arithmetic sites.
