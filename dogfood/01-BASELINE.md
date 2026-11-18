# 01 · BASELINE — the system as it exists at `24de283`

**Step 1 deliverable of `PLANNING.md`.** Three parallel researcher inventories
(R31 metrics engine · R32 facts/store/sidecar · R33 surfaces+prefs), compiled by
the lead. Every downstream design step (02 tick-state, 03 queries, 04
components) contracts against this document; citations are researcher-verified
against baseline `24de283` and reconciled against `main` at integration.

**Status:** PARTIAL — R31 in; R32 + R33 pending.

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

_Pending._

---

## Part C · R33 — surfaces/prefs parity inventory

_Pending._
