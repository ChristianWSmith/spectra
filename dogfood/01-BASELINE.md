# 01 · BASELINE — the system as it exists at `24de283`

**Step 1 deliverable of `PLANNING.md`.** Three parallel researcher inventories
(R31 metrics engine · R32 facts/store/sidecar · R33 surfaces+prefs), compiled by
the lead. Every downstream design step (02 tick-state, 03 queries, 04
components) contracts against this document; citations are researcher-verified
against baseline `24de283` and reconciled against `main` at integration.

**Status:** PARTIAL — R31 + R32 in; R33 pending.

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

_Pending._
