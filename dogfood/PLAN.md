# PLAN — SQL metrics, raw components, tick facts (execution handoff)

**Status:** READY FOR EXECUTION once the owner says go. Not roadmap work
(owner, 2026-11-20). Replaces the 2026-11-18 plan, which was partly executed
and cancelled. Its commits were deleted.

**Read first:** `MANIFESTO.md` (direction), `PRODUCT.md` (Freshness, Power
surfaces, Facts/metrics/records), `AGENTS.md` (Metric pipeline, Builtin
conventions, Components). Then `05-SEQUENCING.md` for the wave graph and the
wipe. Design depth lives in `02`, `03` and `04`. `01` is the current-state
summary.

---

## 1. Goal and acceptance

**Goal.** Metrics are raw SQL. Components are raw Svelte/JS in the database
with a Component Builder and per-component error boundaries. A tick-state fact
table exists. The grammar and its compiler are gone. Freshness works through
touched tables and analysis stubs.

**Acceptance (the only numeric bar):** every builtin metric's stored `value`
matches the pre-migration snapshot for every match, to the stored precision.
This is the only check that compares numbers to the past. Any changed value is
a bug in the port, not an accepted change. (N is no longer compared, since it
is dropped.)

**Non-acceptance (dropped):** N guarantees, the honest-metrics contract, the
parity bar that views must be indistinguishable from components, the
view-computation scan, the five-rule contract.

## 2. Decisions

Settled (owner, 2026-11-20 unless noted):

1. Metric expressions are raw SQL, one statement, read-only, no `CREATE VIEW`,
   every table resolved at save. The sugar grammar goes.
2. N is dropped. The `n` column goes with it.
3. No metric timeout and no row cap. Accepted footguns.
4. Metric SQL runs on the read-only connection, including during sweeps. Users
   can cancel a running metric.
5. Freshness is kept at full precision: touched tables plus analysis stubs.
   Blanket recalculation is only for analysis code changes.
6. Components are Svelte, the same language as the app's own views, stored in
   the database, with a Component Builder tab (preview). Each component has
   its own error boundary. Builtin and user components are both Svelte.
7. Components read metrics, and read tables through the read-only connection
   limited to the same allowlist as metrics (item 14). **Decided** (owner,
   2026-11-20). This replaces an earlier "any table" statement.
8. Views may compute for presentation. The exception list and the relocation
   rule are retired.
9. Builtins are held to the builtin conventions (AGENTS.md) and verified
   against the snapshot.
10. Documents: PRODUCT.md and AGENTS.md updated; dogfood docs updated to these
    decisions.
11. **D-1 (decided 2026-11-20):** Svelte runtime compilation, lazy, with source
    as the stored truth and an in-memory compile cache. The import rewrite is
    verified by a spike first (C0).
12. **D-2 (decided 2026-11-20):** duplicate-to-edit. "Use as my view" for the
    Match view (the tab bar and everything below it) and for an individual
    player's Profile view. The header, warnings, round strip and profiles list
    stay hardcoded. The shipped Match and Profile views are rebuilt as builtin
    components.
13. **D-3 (decided):** round-grain statistics are metrics. This makes B7
    required.
14. **D-4 (decided):** user metrics read only an explicit allowlist of tables
    (`03-QUERIES.md` §2). The save gate enforces it. Components' `query()` reads
    use the same allowlist. Voice is out of the allowlist and stays in the
    sidecar. `generic_events` is in it (owner, 2026-11-20).
15. **Formats (decided):** metrics carry no display format. Components format.
16. **No result-shape validation (decided):** the system does not interpret
    result columns. A statement that errors fails; anything else is stored.
20. **Storage and scope (decided 2026-11-20, `03-QUERIES.md` §5):** a metric's
    scope is the set of reserved binds its SQL references: `:match_id` (match
    grain), `:steam_id` (career grain), and `:round` with `:match_id` (round
    grain). Unbound metrics are library-wide. The engine fans a change out to
    the affected values from fact tables (players and rounds in a match). Each
    run replaces the stored rows for its own bound values, and library-wide runs
    replace the whole result. The engine reads only the reserved output columns
    `subject_key`, `dim` and `value` (ruling 22); every other output column is
    opaque JSON. Freshness
    propagates with scope through the dependency graph, which is a change to the
    existing cascade (B4). Career metrics are built from stored per-match
    components as ratios of sums.
17. **Fact/calculation split (decided 2026-11-20):** the fold layer of
    `player_stats` moves out of extract into metrics, the whole layer, not
    just kills and damage. Folds: `kills`, `deaths`, `assists`, `headshots`,
    `teamkills`, `suicides`, `total_damage`, `damage_taken`, `entry_kills`,
    `entry_deaths`, `two_k`–`five_k`, `best_streak`, `utility_damage`,
    `enemies_flashed`, `flashed_times`, `flash_assists`, `bomb_plants`,
    `bomb_defuses`, `money_spent_total`, `kills_by_weapon`, `shots`, `hits`,
    `rounds_played`, `adr` and `hs_pct` (derived), and the round-level folds
    (`03-QUERIES.md` §10).
    **Amended by the F1 audit (`06-FOLD-AUDIT.md`, decisions 2026-11-20):**
    `entry_kills`, `entry_deaths`, `first_kill`/`first_death` and `best_streak`
    are sequence interpretations and move to detectors (item 21), not folds.
    Owner decisions (2026-11-20): `money_spent_total` is redefined as the
    per-round sum (one ratified exception to the snapshot equality bar, F2);
    damage is capped only: `events.capped_dmg` stays an ingest stamp, and the
    uncapped `player_round_stats.dmg` column is removed (F3). The three
    round-economy sum columns stay ingest facts.
18. **Game-emulation stays at ingest (decided):** `mvps` and `score` are
    engine-internal decisions, so they stay as stamps under the emulation
    criterion. `capped_dmg` also stays.
19. **Analysis outputs (partly decided):** `trade_kills` and the economy
    classes are analysis-owned (decided). Engagements stay analysis-owned
    detectors (decided), and their counts become metrics. Engagements read the
    trade-window rule value, so they need a stub. Owner note: the name
    "engagements" is closer to "kill class," which is a rename to schedule
    later, not a blocker. Clutches are not kept as a detector. They become a
    general alive-count situation family, built as metrics over `player_ticks`
    (decided). Clutch becomes a builtin over that family. The port is verified
    against the snapshot's `clutches` rows. The Go detector stays only if the
    port can't reproduce it, which the test decides.
22. **Raw result to stored value (owner ruling, 2026-11-20):** a raw statement
    returns reserved columns `subject_key`, `dim` and `value`. The engine reads
    those three; every other column is opaque JSON. This amends 03 §5, which
    said the engine reads no output column.
23. **NULL is not zero (owner ruling, 2026-11-20):** where a statement has no
    data, `value` is NULL and is shown as a dash. The current engine turns NULL
    into 0 when it reads a value. The snapshot stores 0 in 461 cells: 460
    `weapon_damage` cells and 1 `team_force_win_rate` cell. Those cells are a
    ratified change from the snapshot, so the snapshot check accepts them as the
    only exception. Any other mismatch remains a port bug.
24. **Unverifiable values are checked at the wipe (owner ruling, 2026-11-20):**
    `shots` and the three tick-join builtins (`dmg_no_kill`, `kill_conversion`,
    `weapon_damage` gate) cannot be checked against the snapshot before the
    wipe, because it predates typed weapon-fire rows and `player_ticks`. They
    are checked at the owner's wipe gate diff (step 4). A mismatch there means a
    second wipe, which is an owner decision.
25. **Raw reads of player tables are allowed (owner ruling, 2026-11-20):** the
    save gate does not refuse raw reads of player-carrying tables. This is an
    accepted footgun under PRODUCT.md Power surfaces. Builtins still apply the
    shared bot predicate. The `src_*` view rule is retired (03 §10).

26. **No analysis stubs (owner ruling, 2026-11-20):** analysis rule values have
    no stub metrics. A rule-value edit makes the app recalculate the affected
    metrics directly. This replaces the stub design in 03 §6 and B4. `analysis_config`
    stays denied to metric reads.
27. **(Superseded by ruling 39.)** attacker_inair (owner ruling, 2026-11-20): accept the two-row change.
    The tick-sample `in_air` and the payload flag disagree on two HE grenade
    kills in seven golden demos. A3 drops the column. The golden fixture gets an
    explained update.
28. **Empty preference lists (owner question, answered as context):** these are
    the Match and Profile view settings, which C4 moves into placement rows.
    Options were a sentinel row (recommended) or a `props` marker. Ruling
    deferred to C4 start.
29. **Raw values numeric or NULL (owner ruling, 2026-11-20):** keep numeric-only.
    Text output is shown by the component from the numeric value. No text
    column.
30. **Duplicate fold metrics (owner ruling, 2026-11-20):** accepted, with the
    expectation that the duplicates are retired. The retirement happens in F3.
31. **Delete over-invalidation (owner ruling, 2026-11-20):** fix next. Narrow
    the career rebuild on delete to the touched tables.
32. **Naming (owner ruling, 2026-11-20):** the engagements family is renamed
    "kill tags", since a kill can carry several classes. The alive-count family
    name is still open.

33. **Pinning removed (owner ruling, 2026-11-20):** the whole pinning concept goes:
    pinned metrics, metric ordering, hiding and economy pins. Dogfooded view
    components replace it: a user changes a view by duplicating and editing its
    component. Retired keys are not absorbed, including
    `scoreboard_starts_transposed`: the scoreboard becomes a dogfooded builtin
    component that a user can duplicate and edit. Ruling 28 (empty lists) no
    longer applies.
34. **Component context (owner ruling, 2026-11-20):** a mounted component gets a
    read-only `context` (`matchId`, `steamId`, `round`) from the surface that
    mounts it. `metric()` and `query()` default their binds from it. The context
    is never stored in a placement row. See 04 §3.
35. **Component composability (owner note, 2026-11-20):** components are
    composable, and the builtin views are built from smaller components.
36. **Nested mount API (owner ruling, 2026-11-20):** a component mounts child
    components itself and passes `context` down. Placements stay per surface and
    name only the top-level component. See 04 §3.5.
37. **Alive-count family name (owner ruling, 2026-11-20):** "XvY" (for example
    1v1, 1v3). The rename of `engagements` to "kill tags" is folded into C5.
39. **Keep attacker_inair (owner ruling, 2026-11-20):** keep ingesting the game's
    `attacker_inair` flag as a stored fact column, and keep the event reader on
    it. The tick-sample version is reverted, because the two sources can't be
    shown to be right. Ruling 27's drop is superseded. `same_side` is still dropped.
38. **attacker_inair note (2026-11-20, not a ruling on the change):** the stored
    payload flag and the tick sample disagree on two kills in seven golden demos.
    Both come from the demo. The cause is probably timing: the kill event is set
    when damage applies, and replicated player state can lag. We trust the tick
    sample for consistency. The mismatch is a known data limit, not a parser bug.
21. **Fold versus detector (decided 2026-11-20):** a fold is an aggregate
    over facts with no interpretation. A detector interprets a sequence, a
    window, a state machine or a rule threshold. Detectors stay analysis-owned
    and store their rows. Any count or aggregate over detector rows is a
    metric.

**Open decisions:** none. Work items that remain are in the waves below.
Two naming notes are deferred and do not block anything: "engagements" should
probably be renamed "kill class," and the alive-count situation family needs a
name of its own.

## 3. Operating rules for the migration

- **Snapshot first.** `~/Programming/spectra-home/.local/share/spectra/` is
  the pre-migration reference. Copy `spectra.db` (with `-wal`/`-shm`) and
  `demos/` before reading. Read the copy with `sqlite3`, read-only. Never open
  the snapshot with the app. Put any verification export in a durable
  directory outside the repo, `~/Programming/spectra-verify/`, not `/tmp` (AGENTS
  scratch rule).
- **Instance isolation.** Every agent-launched instance uses per-worktree XDG
  dirs (AGENTS "Instance isolation"). Never kill with bare `pkill -x spectra`.
- **Characterization before change.** Where a wave changes behavior, pin the
  current behavior first.
- **Guide lockstep.** A wave that changes user-visible behavior updates the
  guide in the same wave (AGENTS, PRODUCT.md **The manual stays in lockstep**).
- **Schema changes ride one wipe.** Pre-release, so each schema change is a
  wipe and re-import, never an `ALTER`. The schema changes are gathered into
  one wipe at the end (`05 §2`).
- **No version machinery.** No format versions, no migrations, no compatibility
  branches (AGENTS "Version nothing until the first release").
- **Commits are the owner's call.** Do not commit or push unless asked.

## 4. Standing verification (every wave)

```
make fmt vet test lint          # from src/ (repo Makefile forwards)
make build
cd frontend && npm run build
node --test src/lib/*.test.js
# the jsdom harnesses in frontend/test/
node --test src/lib/strings-audit.test.js src/lib/docslockstep.test.js
```

Plus the wave's own check from §5. The `make test` target uses `-short`, so
network-bound tests skip.

**Wrap rule.** If a wave cannot finish, stop taking new work, finish or
abandon the current section honestly, and report completed, not done, and
skipped-with-reason. Commit only if green. A partial report is acceptable; a
green-looking claim without evidence is not.

## 5. Waves

### Track 0 — Snapshot and reference (no app code)

**W0 · Reference export.** Copy the snapshot. Export every stored
`metric_values` row keyed by `(metric name, match sha256, subject_key, dim)`
with `value`, to `~/Programming/spectra-verify/baseline.csv` (or similar).
Also export the 109 builtin rows (`name`, `expr`, `subject`, `scope`,
`partition`, `format`, `doc`).
- **Check:** 9,562 value rows; 109 builtin rows; seven matches.

### Track A — tick facts (backend)

**A1 · Tick table and sink.** `player_ticks` (`02 §2`), the `TickSink`
(`02 §3`), chunked writes, reprocess and failure cleanup, the Tier-1 steam
index with its rationale comment. Measure `SaveExtracted` and the sink's
wall-clock for a golden-sized match.
- **Check:** schema-consistency battery; ingest lifecycle tests (reprocess,
  failure, deletion); NULL-not-0 for dead frames; golden acceptance
  (`internal/integration`, requires `git lfs pull`), with any fixture diff
  explained.
- **Deps:** none.

**A2 · Tick seed rewrites.** Rewrite `dmg_no_kill`, `kill_conversion` and the
`weapon_damage` gate as SQL joins to `player_ticks`. Do this inside B3's port,
not before it: the port is the one place a seed's text changes, so the
rewrite lands there. A2 is therefore the tick-join *content* of B3's port for
those three seeds.
- **Check:** the B3 snapshot check on those three values; `combat_equivalence_test.go`
  oracle rewritten to the tick join.
- **Deps:** A1, B3.

**A3 · Stamp drops.** Drop `events.same_side` (ruling 39 keeps `events.attacker_inair`)
after A2 removes their readers. Keep `events.capped_dmg` with its honest
comment. Keep the extract predicates that gate `player_stats.total_damage`.
- **Check:** a pin that the dropped columns are absent from the schema;
  `kill_flags_test.go` re-proof for `in_air`; a grep showing no remaining
  readers.
- **Deps:** A2.

**A4 · Weapon-fire promotion.** `weapon_fire` becomes a typed event. Before the
wipe, so the re-imported corpus is uniform.
- **Check:** golden acceptance with an explained `-update`; the feed does not
  double-surface the row.
- **Deps:** A1 (serialized with it; both touch extract).

### Track B — metrics (backend, one package)

**B1 · Metric execution path.** Metric SQL runs on the read-only connection,
including during sweeps. Remove timeout and row cap from the metric path only;
the console keeps its own. Add cancel: the statement is interrupted, the metric
is marked failed with reason "cancelled", and no partial rows are written.
- **Check:** a test that a sweep with a metric running on the read connection
  does not block a concurrent write; a cancel test with no partial rows.
- **Deps:** none.

**B2 · Save gate.** One gate (`03 §2`): one statement; read-only; `CREATE VIEW`
and all DDL refused; every table on the allowlist; `metric('…')` refs resolve;
touched tables derived and stored in `metrics.touched`. The Builder's live
check, save, preview and sweep all call it.
- **Check:** refusal pins per rule (multi-statement, write verb, `CREATE VIEW`,
  a table not on the allowlist, `sqlite_*`, `metric()` to a missing metric);
  allowlist pin (every schema table classified, new tables fail the test);
  table-resolution pins across comma joins, CTEs, subqueries, and quoted names
  (refused, not silently skipped).
- **Deps:** B1. **Schema:** `metrics.touched` (wipe).
- **Decide before:** the allowlist contents (`03 §2`) are settled first.

**B3 · Builtin port.** For each of the 109 builtins: compile the current sugar
with the existing compiler (`CompileMetric` → `DisplaySQL`, `InlineArgs`),
strip the `n` column, confirm the compiled humans-only predicate is present
(it is injected by `subjectConds`), and store the SQL as `expr`. Hand-write the
three tick-join seeds (A2 content) and the analysis-rule stubs (B4).

**Pre-wipe verification without a wipe:** run each ported statement against a
**copy** of the snapshot's `spectra.db` (read-only), and compare its output to
`baseline.csv` for that metric and match. This needs no re-import and no
schema change. Any mismatch is a port bug.
- **Check:** every builtin, every match, value identical to the stored value
  (N not compared).
- **Deps:** B2 (the gate must accept the ported text).

**B4 · Freshness.** `metrics.touched` drives the behind predicate, so a
metric goes behind when a table it touches changes. Analysis rules get
direct recalculation, with no stub metrics (ruling 26). A rule-value edit
recalculates the metrics whose touched set contains the rule's analysis table,
and their dependents through the cascade. The analysis code-change path (version
bump) is the only broad recalculation, and it marks only metrics that touch an
analysis table. `player_stats` stays in the analysis class (conservative).
- **Check:** a fact-only metric does not go behind on an analysis code bump; a
  rule-value edit recalculates exactly the metrics that touch the analysis
  table, and their dependents; the five state words are unchanged (`metricstate.js`).
- **Deps:** B2, B3. The scope-aware
  cascade (item 20) is a change to the existing cascade and is pinned here.

**B5 · Retire the grammar.** Delete the sugar parser, the compiler's emitters,
the whitelist, `doc.go`, and the `denominator` furniture. Rewrite the
`metric-language.js` manual chapter around raw SQL, the save gate, the touched
tables and the cancel action. Delete the grammar's refusal tests. Keep the
equivalence and fixture tests, re-expressed over the ported SQL, because they
check values. Delete the sugar-only tests.
- **Check:** grep for the grammar's symbols (`Parse`, `CompileRefs`, `Plan`
  emitters, `whitelist`) returns nothing outside history; the snapshot check
  still passes against the ported SQL.
- **Deps:** B3, B4.

**B6 · Drop N.** Remove `n` from `metric_values` and from every reader and
display. The display stops offering N.
- **Check:** the readers compile and the UI shows values without N; the
  snapshot check ignores N.
- **Deps:** B5. **Schema:** `metric_values.n` (wipe).

**B7 · Round-grain metrics (required, D-3).** Round-grain statistics are
metrics. The storage carries the round through the `:round` bind (item 20). Seed
the six metrics (M19 EconCurve series, M22 CT/T deaths per round, M30 utility
damage per round, M31 blind ms per round, M36 money mean per round, M37
CompareRounds nades/dmg/flash per round), each checked against the snapshot.
Dash on an absent round, never a fabricated zero.
- **Check:** each of the six values matches the snapshot's equivalent stored
  value or, where no stored equivalent existed, against a hand computation
  over the same corpus.
- **Deps:** B6.

### Track C — components (frontend, plus schema)

**C1 · Storage.** `components` and `layout_placements` (`04 §2`), in the
baseline schema. Builtin components are code, not rows.
- **Check:** schema-consistency battery; a test that a placement referencing a
  missing component reports, not crashes.
- **Deps:** none (schema rides the wipe).

**C0 · Runtime compile spike.** Before C2, prove the import-rewrite approach
(`04 §5`): compile a small Svelte 5 component with `svelte/compiler`, rewrite its
runtime imports to the app's own Svelte runtime, evaluate and mount it. Confirm
scoped styles apply and `<svelte:boundary>` catches a render error. Record the
result in `04` and in this plan. If it fails, fall back to compiling in the
builder and storing compiled JavaScript, and record why.
- **Check:** a written result with the test component, the rewrite used, and
  the outcome of each of the four checks.
- **Deps:** none. Can run in parallel with A and B.
- **Result (2026-11-20): passed under Node + jsdom** with Svelte 5.57.3. All
  four checks pass; the event-handler and async gaps are confirmed. Details in
  `04 §5`. The WebKitGTK check is not yet run. Scratch harness:
  `~/Programming/spectra-verify/c0-spike/` (outside the repo).

**C2 · Runtime.** The read API (`04 §3`), the `<svelte:boundary>` wrapper with
a dismissible failure frame (`04 §4`), the event and async wrapper, the lazy
compile with an in-memory cache (`04 §5`), and the save-time syntax check.
- **Check:** a deliberately broken component shows its frame and the rest of
  the surface still renders; an event-handler error is caught; a source with a
  syntax error is refused at save with its line; the compiler is not loaded at
  launch.
- **Deps:** C0, C1.

**C3 · Component Builder tab.** A top-level tab beside the Metric Builder and
Reports Builder, with source editor, live preview in the real boundary, save
gating, duplicate-builtin and delete actions, and placement as a separate
action (`04 §6`). Guide section in the same wave.
- **Check:** DOM tests for save gating and error display; `strings-audit` and
  `docslockstep` green.
- **Deps:** C2.

**C4 · Builtin placements and pinning removal.** Builtin default layouts render
through placement rows. Pinning is removed (ruling 33): retire the pin, order,
hide and transposed keys and the two localStorage pin keys, with no absorption.
The scoreboard becomes a dogfooded builtin component. Reset deletes placement rows.
Guide note on the absent-default / present-verbatim caveat for placements.
The empty-list question (ruling 28) no longer applies, because no list preference
survives.
- **Check:** per-key tests for absent, present and Reset; no reader remains
  for a retired key (grep).
- **Deps:** C2, C3.

**C5 · Dogfood surfaces (decided, D-2), decomposed.** Rebuild the Match view below
the header (tab bar and everything under it), the scoreboard, and the individual
Profile view as builtin components. The header, warnings, round strip and
profiles list stay hardcoded. Pinning is removed (ruling 33). Each sub-item is
its own commit with the guide updated in the same change.

- **C5a · Context and nested mount (rulings 34, 36).** The read API gives every
  mounted component a read-only `context` (`matchId`, `steamId`, `round`), and
  `metric()` and `query()` default their binds from it. A component can mount
  child components itself and pass `context` down. A child failure stays in its
  own frame. **Deps:** C2, C3. **Check:** a parent and child test where the child
  reads `context` from its parent; a failing child shows its own frame and the
  parent keeps rendering; `metric()` with no explicit binds reads the context's
  match.
- **C5b · Match view tab bar and content as builtins.** Split the Match view into
  builtin components for the tab bar and each tab's content, mounted by the
  hardcoded shell. **Deps:** C5a. **Check:** on the snapshot, each stored value shown
  by the Match view appears unchanged (display check, not GUI smoke).
- **C5c · Scoreboard as a builtin (ruling 33).** The scoreboard is a builtin
  component mounted by C5b's content. Its transposed layout is not a preference:
  a user who wants it transposed duplicates it and edits it. **Deps:** C5a, C5b.
  **Check:** scoreboard values match the snapshot; no read of
  `scoreboard_starts_transposed` remains (grep).
- **C5d · Individual Profile view as a builtin.** **Deps:** C5a. **Check:** profile
  values match the snapshot; the profile header and profiles list stay hardcoded.
- **C5e · Pinning removal (ruling 33).** Remove the pin, order and hide controls and
  their keys (`metric_order_*`, `metric_pins_overview`, `metric_economy`,
  `metric_hidden_*`, `scoreboard_starts_transposed`, the two localStorage pin keys),
  and the metric ordering dialog. Update the guide. **Deps:** C5b, C5c, C5d (the
  views must have their components before their controls go). **Check:** grep finds
  no reader of a retired key; the guide has no pinning section.
- **C5f · Duplicate to edit and use as my view (`04 §7`).** Wire the actions to the
  placement store (C4 writers, merged). **Deps:** C5b, C5d, C4. **Check:** a
  duplicated builtin renders its copy; "use as my view" writes one placement that
  Reset removes.
- **C5g · Rename engagements to "kill tags" (ruling 32).** Schema, API and UI names,
  and the guide. Run after C5b so the Match view's names change once. **Deps:**
  C5b. **Check:** grep finds no `engagements` label in user-facing text; the
  stored data is unchanged.

Open for the owner: whether the Economy view (it reads `metric_economy` pins,
retired by ruling 33) is also a builtin component in this wave. Not decided.

### Track F — fact/calculation split (decided, item 17)

**F1 · Fold audit.** For every `player_stats` and round-level column, record:
the fact or fold class, the events or round records it is computed from, the
replacement metric, and the snapshot raw column that verifies it. Output is
one table in `dogfood/`, not code. Blocks F2.
- **Check:** every column in the audit has a class and a replacement; every
  stamp kept under item 18 is listed with its emulation reason.
- **Deps:** none.

**F2 · Replacement metrics.** One metric per fold, written as SQL over the fact
tables. Team-kill and team-damage exclusions use `round_player_sides`, not
`player_ticks`, so this wave does not depend on the tick sink. `shots` and
`hits` depend on `weapon_fire` being a typed event (A4).
- **Check:** for every fold column, the metric's output equals the snapshot's
  raw column for every player and match. The snapshot's raw columns are the
  reference, so this check does not depend on a builtin existing.
- **Deps:** F1, A4, B1.

**F3 · Remove the folds.** Delete the extract folds and the columns they fill,
then update each reader: scoreboard sort (moves to metric values), weapon filter
(`kills_by_weapon` moves to a metric), profile history and career tiles.
Career metrics read stored per-match metric values through `metric('…')`
rather than scanning raw rows, so a career tile is cheap to refresh.
- **Check:** no reader of a removed column remains (grep); golden fixture
  diffs explained; the snapshot check passes.
- **Deps:** F2, B6.

### Track S — sweep

**S1 · Dead folds.** Delete the win-percentage fold, the unused
`internal/spatial/series.go` reader (verify zero readers first; one call site
was reported live at `platformservice.go:275`), the two unconsumed team
aggregates, and the raw default scoreboard sort (the latter with C5, or with
C4 if C5 is skipped). Prove zero readers before each delete.
- **Check:** no non-test reader remains; `go vet` and `golangci-lint` green.

**Owner decision (2026-11-20):** `GetSpatialSeries` and
`internal/spatial` are deleted (no UI consumer; its sidecar series cannot be
expressed over `player_ticks`, which carries no positions).

## 6. The wipe, and the gate

Schema changes gathered by the waves:

- New: `player_ticks` and its index (A1), `metrics.touched` (B2), `components`
  and `layout_placements` (C1), stub rows (B4), and the round dimension (B7).
  The exact storage shape is set by item 20.
- Dropped: `events.same_side`, `events.attacker_inair` (A3), `metric_values.n`
  (B6), plus the already-committed drops (opening, damage-by-weapon, warmup).
- Changed text: every builtin `expr` (B3). `INSERT OR IGNORE` never rewrites
  an existing row, so the wipe is what applies the port.

**Gate (owner runs):**

1. Confirm every wave's check is green.
2. Run `make deep-clean CONFIRM=1` (refuses while `spectra` runs).
3. Re-import from the snapshot's `demos/` into the fresh library. Full
   pipeline: parse with the tick sink, analyze, metric sweep.
4. Diff `metric_values.value` against `baseline.csv`, keyed by
   `(metric name, match sha256, subject_key, dim)`.
5. **Expected:** identical for every pre-existing builtin. Ticks, weapon-fire
   rows, stubs and components appear only as additions.
6. **Any changed value is a bug.** Fix the port and re-run from the snapshot.
   A second wipe is an owner decision.

The pre-wipe check in B3 means step 4 should already pass before the wipe,
since the port was verified on the snapshot copy. The wipe checks the
pipeline (re-import, sweep, sink) as well as the port.

## 7. Recovery

- **A port value differs from the snapshot:** bisect the port (B3). Do not
  edit `baseline.csv` or the expected values to match.
- **A metric blocks writes during a sweep:** B1 is wrong. The metric path must
  use the read connection.
- **A component takes down the surface:** C2's boundary is wrong. Fix the
  boundary; do not add a special case for the component.
- **Freshness marks a metric fresh that should be behind:** B4's touched-set
  derivation is wrong for that SQL. Fix the parse; if the parse cannot resolve
  a read, the metric falls back to behind, never to fresh.
- **Golden fixture diff in a non-extraction wave:** an extract change leaked.
  Move it to A1 or A4, or revert.

## 8. Verified up front (2026-11-20)

Checked before any wave starts. Scratch work lives in `~/Programming/spectra-verify/`,
outside the repo. The snapshot was copied first and only read.

| Claim | Result | Evidence |
|---|---|---|
| Career metrics can be built from stored per-match rows | **Verified** | Career kills summed from stored per-match `kills` rows equal both the stored `career_kills` and raw `player_stats` sums for all 73 players in the snapshot. |
| Career ADR is a ratio of sums, not a micro-average | **Verified** | The stored `career_adr` equals total damage over total rounds for every player. A micro-average of per-match ADRs differs for several players, for example 86.72 stored against 90.63. |
| The driver accepts named binds like `:match_id` | **Verified** | Probe test with the repo's `modernc.org/sqlite` v1.61.0: a named bind works, and a missing bind fails with "missing named argument" instead of returning NULL. |
| The lexer detects `:name` markers | **Verified** | `store.HasParameters` already treats `:name` as a marker. The metric path needs to accept only the reserved names. |
| The current cascade is metric-grained | **Verified by reading** | `bumpMetricAndDependents` (`metric_values_store.go:585`) bumps the metric and its dependents by name. No match or player scope is carried, so the scope-aware cascade is new work. |
| Fan-out sources exist | **Verified** | The snapshot has a players row set per match (10 to 11 per match) and a rounds row set per match (14 to 29). Fan-out must filter out bots, which the `players` table also holds. |

**Still unverified, and to be verified by tests in their waves:**

- The scope-aware cascade (B4): not built yet, so its behavior is unpinned.
- That the save gate reliably detects reserved binds in all SQL shapes, including
  binds inside subqueries and CTEs (B2).
- That `metric('…')` expands to the aggregate form the career stats need (B2).
- That a user's SQL cannot reference a bind the engine doesn't supply (B2).
