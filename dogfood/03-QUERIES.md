# 03 · QUERIES — raw SQL metrics, the save gate, freshness, the builtin port

**Status:** design, updated 2026-11-20. Locked decisions are marked
**Decided**, including the storage and attribution model (§5). Current code
still implements the sugar grammar (`01-BASELINE.md` §A).

---

## 1. What a metric is

- **`expr`** is one SQL statement. Builtins and user metrics use the same form.
  The stored `expr` is the formula, and it is shown wherever the metric is
  shown. **Decided.**
- **No N.** The sample size is not stored or guaranteed. The `n` column and
  every reader of it go. **Decided.**
- **No display format.** The metric carries no format. Components format the
  values they show. **Decided.**
- **No result-shape validation.** The system does not interpret result columns.
  A statement that errors fails the metric; any other output is stored as
  returned. **Decided.** Storage and attribution are §5.
- **`metric('name')`** is the one reserved construct. It refers to another
  metric and is rewritten to a join on that metric's stored values at save.
  This keeps the dependency graph (`metric_deps`) and the cycle check working.
  **Decided.**
- **`denominator`** retires with the grammar. **Decided.**
- **`subject`, `scope`, `partition`** are not kept as furniture. Scope comes
  from the binds (§5), and a metric's key columns are whatever its SQL returns.

## 2. The save gate

One function serves the Builder's live check, save, preview and sweep. No call
site re-validates. The gate checks, in order:

1. **One statement.** No trailing content after the terminator.
2. **Read-only.** Leading keyword `select` or `with`. Write verbs anywhere are
   refused (`ValidateReadOnlySQL` and its tokenizer, reused). `CREATE VIEW` and
   all other DDL are refused.
3. **Allowlist.** Every `FROM` and `JOIN` target, including inside subqueries
   and CTEs, must be on the metric-readable allowlist below. Anything else is
   refused, and the refusal names the table. **Decided.**
4. **`metric('…')` references** resolve to existing metrics. Cycles are refused.
5. **Touched tables** are derived here and stored (§4).

The gate does not check meaning, bot filtering, or whether the result is
correct.

**Metric-readable allowlist (proposed list, owner confirms its contents):**

- Readable: `matches`, `teams`, `players`, `rounds`, `player_stats`,
  `player_round_stats`, `round_player_sides`, `round_player_money`,
  `round_economy`, `events`, `generic_events`, `engagements`, `clutches`,
  `utility_events`, `chat`, `sound_events`, `round_classifications`,
  `round_side_classes`, `match_trade_opps`.
- Denied: `sqlite_*`, `jobs`, `query_history`, `saved_queries`,
  `saved_filters`, `report_templates`, `plugins`, `analysis_config`,
  `components`, `layout_placements`, `metrics`, `metric_values`, `metric_deps`,
  and `voice_presence`. Voice stays in the sidecar (owner, 2026-11-20).
- **`generic_events` is readable** (owner, 2026-11-20). It is the escape hatch
  for raw game events. Its `payload_json` keys come from the game's event
  schema and are unversioned. A metric that reads a key can break after a
  parser change, and that is an accepted footgun.
- **Applies to components too** (owner, 2026-11-20). The same allowlist governs
  a component's `query()` reads. Components do not read any table outside it.

**Enforcement.** The allowlist is one explicit list. A test fails when a schema
table is not classified as readable or denied, so a new table cannot become
readable by accident.

**Why no view handling is needed.** Users cannot create views, so every name in
a `FROM` is a base table. If an app-shipped view is ever added, its base tables
must be recorded in the same classification.

## 3. Execution

- **Read-only connection.** Metric SQL runs on the `mode=ro` + `query_only`
  connection, including during sweeps. Sweep writes (replacing one metric's
  stored output) still go to the writer.
- **No timeout, no row cap.** Accepted footguns (PRODUCT.md **Power surfaces**).
- **Cancel.** A running metric can be cancelled from the UI. Cancel interrupts
  the statement, marks the metric failed with reason "cancelled", and writes no
  partial output.
- **Failure is a state.** A failed metric shows the failed state with its
  reason.

## 4. Freshness

Freshness is the one guarantee kept at full precision.

**Each metric stores its touched tables** (derived at save from §2 step 5). It
is a derived cache of the SQL and is never versioned.

| Change | What should happen |
|---|---|
| A match is imported or reprocessed | Metrics whose touched set includes a table that match wrote go behind. For a per-match metric, only that match's output goes behind. |
| An analysis rule **value** is edited | The rule's builtin **stub** recalculates. Its dependents recalculate through `metric_deps`. Metrics that read that rule's analysis table directly also go behind. Nothing else moves. |
| Analysis **code** changes (version bump) | Every metric whose touched set includes an analysis table goes behind. Metrics that read only facts stay fresh. |

**Stubs.** Each analysis rule value has one builtin stub metric, reading that
rule's stored analysis output. **Decided** (carried from the 2026-11-18 stub
model).

**`player_stats`** is written by extract (base columns) and analysis (`trade_kills`).
Any metric that touches it is treated as analysis-dependent. Column-level
attribution is deferred. This is conservative.

**Per-match or whole-library behind** follows the binds (§5).

## 5. Decided: scope is the set of bound values (D-5, 2026-11-20)

**Binds.** A metric's SQL may reference reserved bind names. The engine detects
them by tokenizing the text at save. The reserved names are:

- `:match_id`: match grain.
- `:steam_id`: career grain, one player.
- `:round` together with `:match_id`: round grain. Rounds are keyed by
  `(match_id, number)`, so the pair is the bind. A surrogate `round_id` would
  need a schema change and is deferred.

A metric with no reserved binds is library-wide.

**Runs.** A metric with binds runs once per value of its bound keys, over the
set of affected values. The engine enumerates those values from fact tables,
not from the metric's output:

- A changed match fans out to the players in it (the `players` table) and the
  rounds in it (the `rounds` table).
- A changed player fans out to that player's career metrics.

This is the one place the engine knows the schema. It is three lookups, one per
grain, and it is named in code so it can be read in one place.

**Storage.** Each run replaces the stored rows for its own bound values. Rows
are tagged with the bound values, and an unbound dimension is NULL. A
library-wide run replaces the metric's whole stored result. The output columns
are stored as opaque JSON. The engine never reads an output column.

**Freshness.** A change propagates with its scope, through the dependency
graph. A change to match M and player P marks behind only the dependents bound
to M, or to P, or to both. A dependent with no binds is marked behind whenever a
dependency changes. This is a change to the existing cascade, which currently
propagates only by metric name. It is named explicitly in `PLAN.md` B4.

**Career grain.** Career metrics are built from stored per-match components
through `metric('…')`, and combine them as ratios of sums. For example, career
ADR is total damage over total rounds, never a mean of per-match ADRs. A career
metric bound to `:steam_id` recomputes only for the players in the changed
match.

**Costs and accepted footguns.**

- A metric that forgets its filter stores other players' or matches' rows under
  the run's scope. That is user error, accepted (PRODUCT.md **Power surfaces**).
- A metric with no binds recomputes library-wide on any change. Also user error
  or deliberate, accepted.
- Cross-subject metrics (a percentile against everyone) are unbound, so they are
  library-wide.

**Still to verify, in the waves that need them:**

- That `metric('…')` can aggregate stored scoped rows per player.
- That the scope-aware cascade marks exactly the dependents it should, pinned by
  behavior tests in B4.
- That the save gate detects reserved binds reliably.

## 6. Dependency graph

Two graphs, and only one is new.

- **Metric to metric** (`metric_deps`, from `metric('…')`). Carries over
  unchanged: re-derived on save, cycle-checked, rename-spliced, cascaded.
- **Metric to table** (`metrics.touched`). New. Drives §4.

Stubs connect them: an analysis table is a table, and a stub is a metric that
reads it.

## 7. The builtin port

Builtins are authored once, then checked. The port is done while the old
compiler still exists.

**Per builtin (109 seeds):**

1. **Compile.** Run the existing compiler on the sugar expression to get emitted
   SQL (`CompileMetric` → `Plan.DisplaySQL`, with `InlineArgs` for `?` binds).
2. **Strip the positional `n` column** and its `COUNT(*) AS n`. N is dropped.
3. **Confirm the bot predicate.** The compiler injects the humans-only condition
   unconditionally (`subjectConds`, `compile.go:1012–1031`), so the compiled SQL
   already carries the bot filter. The port confirms it is present and moves the
   predicate into one shared fragment that `store.HumanOnlyBySteamID` owns. Do
   not add a second copy.
4. **Store** the result as `expr`. The sugar text is kept in git history only.
5. **Verify** against the snapshot (§8).

**Stubs and the analysis-rule builtins** are written by hand against the
analysis tables, and checked against the same snapshot.

**Formats.** The port drops the `format` of each seed. Components that show
those values take on the formatting. The list of which component shows which
seed is part of the component wave.

## 8. Verification against the snapshot

The snapshot is `~/Programming/spectra-home/.local/share/spectra/spectra.db`
(7 matches, 109 builtins, 9,562 stored values). Copy it before reading.

1. **Before any change**, export every stored `metric_values` row from a copy,
   keyed by `(metric name, match sha256, subject_key, dim)`, with `value`. Keep
   the old `n` for information only.
2. **Pre-wipe:** run each ported statement against a **copy** of the snapshot
   database (read-only) and compare its output to the export, for each metric
   and match. Needs no re-import and no schema change.
3. **After the wipe and re-import** from the snapshot's demo copies, export the
   same keys and diff.
4. **Expected:** `value` identical for every pre-existing builtin, to the stored
   precision. `n` is not compared.
5. **Any changed value is a bug.** Fix the port. Do not re-pin values to new output.

The diff is a throwaway script written at the verification wave. It does not go
into the app tree.

## 9. Decisions

| Item | Status |
|---|---|
| Expressions are raw SQL, one statement, read-only, no `CREATE VIEW` | **Decided** |
| No N; `n` column and readers go | **Decided** |
| No timeout, no row cap; read-only connection; cancel | **Decided** |
| Metric-readable allowlist (§2), also applied to component reads | **Decided**; `voice_presence` denied; `generic_events` readable |
| Freshness via touched tables and analysis stubs | **Decided** |
| Round-grain statistics are metrics | **Decided**; needs a round dimension (B7) |
| No display format on metrics; components format | **Decided** |
| No result-shape validation | **Decided** |
| Result storage and attribution: scope is the set of bound values (§5) | **Decided** (2026-11-20) |
| `subject`, `scope`, `partition` as furniture | **Not kept**: scope comes from the bind; touched set stays on the row |
| `denominator` | **Retired** |
| The 2026-11-18 derivation ladder, declared pool, shape declaration, `src_*` views | **Retired** |

## 11. Folds versus detectors (proposed, 2026-11-20)

The fold layer moves into metrics (decided). Analysis-owned rows are not folds,
and the line between them is this:

- **Fold:** an aggregate over facts, with no interpretation. Example: kills
  per player, which counts kill events by attacker.
- **Detector:** interprets a sequence, a window, a state machine, or a rule
  threshold, and stores rows. Example: a trade, which is a kill within the
  trade-window rule value.

| Output | Class | Why | Consequence |
|---|---|---|---|
| `trade_kills`, economy classes | detector | Trade window is a rule value; economy classes are rule outputs | Stays analysis-owned. Stubs. (Decided.) |
| `engagements` (opening, trade, traded, untraded) | detector | Trade and traded kinds depend on the trade-window rule value | Stays analysis-owned. Needs a stub. Proposed. |
| `clutches` (1vN) | detector | Currently a state machine over alive sets, with bomb state and HP reconstruction; no rule value | Port to a general alive-count situation family, verified against the snapshot's `clutches` rows (`PLAN.md` item 19). The Go detector stays only if the port can't reproduce it. |
| Clutch counts, clutch sizes, engagement counts | fold | Aggregates over detector rows | Metrics over the stored rows. |

The owner's instinct that clutches and engagements look fold-like is right for
their counts. Engagements stay analysis-owned: they are detections, and the
trade kinds depend on a rule value. Clutches are the exception. The owner ruled
they become a general alive-count situation family built as metrics over
`player_ticks` (decided), so the Go detector goes once the port reproduces the
snapshot's `clutches` rows. Engagements are a naming candidate for "kill
class," deferred.

## 10. Round-level folds (decided in scope; the storage question is D-5)

**Scope (decided 2026-11-20):** the round-level folds move into metrics along
with `player_stats`. The audit (`PLAN.md` F1) will list each one. Analysis
outputs (`round_classifications`, `round_side_classes`, `player_round_stats`'s
rule columns, `clutches`, `engagements`) are not folds. They stay analysis-owned,
with stubs (`PLAN.md` item 19).

**Why this is the same problem as D-5.** A round-level metric has the same
scope question as a match-level one: which stored rows belong to which match.
The new part is the grain. A per-match run of a round metric returns many rows,
one per round, so the storage must hold `(metric, match, round, subject, dim)`.

**Why it may be free.** If D-5 is settled as generic stored rows, keyed by
metric and match, with the result stored as opaque JSON per row, then the round
grain needs no special handling. The engine doesn't read the round column, just
as it doesn't read any other column. That is the argument for D-5 going generic.
If D-5 instead keeps typed key columns, the round dimension becomes a typed
column, which is B7.

**Examples under option B, per match:**

| Metric | Scope | Works? | Notes |
|---|---|---|---|
| CT deaths per round | per match | Yes | One row per round. A round with no deaths produces no row, and the component shows a dash. |
| Money mean per round, per side | per match | Yes | Reads `round_player_money`, which is a fact sample. |
| `rounds_played` per player | per match | Yes | Counts rounds the player appears in `round_player_sides`. |
| Economy carry-over (previous round's loss bonus) | per match | Yes | Cross-round within one match. The bind scopes the match, and the rounds in it are all visible. |
| Average round count across the library | library-wide | Yes, slow | Reads every match on every import. Build it from stored per-match rows instead. |
| A round metric that reads round N of another match | per match, wrong | No | Fails the scope check (`03` §5 proposal), so it becomes library-wide. |

**Verification.** Round-level folds are verified against the snapshot's raw
round rows, the same way as `player_stats`: the reference is the stored raw
data, not a builtin.
