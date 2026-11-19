# 05 · SEQUENCING — the executable wave plan

**Step 5 deliverable of `PLANNING.md`.** Merges `02-TICK-STATE.md`,
`03-QUERIES.md` and `04-COMPONENTS.md` (plus `01-BASELINE.md` and
`MANIFESTO.md`) into one ordered, verifiable program. **Citations are
reconciled at worktree HEAD `550d6b7`** — `02 §5 W4` means section 5, item W4
of 02-TICK-STATE.md; `PLANNING:39` means line 39 of PLANNING.md (the owner
rulings section). Planning document only: no app code, no tests, no schema.

**Status:** complete (sections 1–7). The owner rulings in `PLANNING.md:36-43`
are binding and override any sub-doc text they conflict with; every such
override is recorded in §0 below. Nothing in this document invents an answer:
anything not settled by a doc or ruling is flagged decide-during-execution
with a named decider.

---

## 0. Reconciliation overrides (docs in conflict — resolved here)

| # | Conflict | Resolution | Why |
|---|---|---|---|
| O1 | `03 §2.2`/`§9` decisions 3 & 9 (two-field `expr` + `canonical_sql`) vs **PLANNING:41** (single field) | **Single field wins.** Stored formula IS the expanded SQL; sugar expands at save; `schema.sql` seeds normalize to their expansion at Open; the authored sugar stays the source of record in git. | Owner ruling 2026-11-18; 03 annotates its own decisions as overturned. |
| O2 | `03 §9` deferral "conservative fallback: touched-set recording first, lift blanket later" vs **PLANNING:42** (freshness = FULL NOW) | **Full lift ships in the same wave as rule 5** (wave *Staleness precision*); the conservative fallback is rejected. | Owner ruling 2026-11-18, refined same day with the stub model. |
| O3 | `01 B5.5`/`MANIFESTO:36` ("three stamps are tick-join replacements") vs `02` W5′ vs **PLANNING:40** | **Two drops, one keep**: drop `events.same_side` + `events.attacker_inair`; **KEEP `capped_dmg`** with its honest DDL comment (`schema.sql:284-296`). The standing gate for any future stamp question is the **engine-emulation criterion** (observable in per-tick state ⇒ join+drop; engine-internal rule ⇒ stays an ingest stamp) — no re-argument. | Owner ruling 2026-11-18. |
| O4 | `MANIFESTO:42` "derived-features-at-a-sane-tick-rate" vs `02 §1` | **64 Hz full rate; density is a WIDTH decision** (policy (c)). | 02 falsified the manifesto hedge with the equality-join mandate (`whitelist.go:450-481`). |
| O5 | `01 B5.1` (tick table needs a `childTables` entry) vs `02 §3.3` | **`streamedChildTables` + FK cascade + wipe-at-sink-creation** — `SaveExtracted`'s delete loop would erase streamed rows. | 02's baseline correction (finding 5). |
| O6 | `03 §8` places the docs/manual rewrite in its "wave C" vs **AGENTS docs-lockstep** (guide updates ride the wave that changes user-visible behavior) | **The `metric-language.js` manual rewrite rides the *Author-SQL gate* wave** (the wave that first changes expression behavior); the *Expression editor* wave keeps editor UX only. | AGENTS "manual stays in lockstep" is a standing repo rule; the wave label in 03's deferral table is not. |
| O7 | `02 W9` bundles the raw default scoreboard sort into the dead-fold sweep vs `04 §3` M13/D2 (layouts carry `default_sort`) | **The Go folds ride the *Dead-fold retirement* wave; the raw-default-sort elimination rides *Default layouts and parity*** (same file as the parity migration — bundling it with the sweep would create a guaranteed conflict). | File-conflict discipline; both land pre-parity-close, intent preserved. |
| O8 | `02 §2.5`/`W3` flags E2/E3 sequencing as "owner: lead" | **Resolved here:** E2/E3 are wave *Tick join extensions*, strictly between *Tick ingest* and *Tick seed rewrites* in the A-spine (W4 is blocked until they exist, `02 §6`). They are sugar-grammar extensions with no DDL — sequenced in A, file-wise they touch `internal/metrics` parse/compile. | This document is the lead's sequencing pass. |
| O9 | `03 §3.2` allowlist "∪ the tick tables when step 2 lands" (a manual union step) | **No manual step:** the allowlist and the `src_*` view set *derive* from `whitelist.go` `sources` (`tableFor(sources)` ∪ denominators ∪ …; one view per source), pinned to schema by a consistency test — A1's admission flows in automatically. | One-canonical-way; prevents a stale hard count. |

---

## 1. The wave graph

### 1.1 The graph

```
TRACK A — tick ingest (02's W1–W10 spine) · STRICTLY SEQUENTIAL · backend
  A1 Tick ingest ─▶ A2 Tick join extensions ─▶ A3 Tick seed rewrites ─▶ A4 Stamp drops ─▶ A5 Weapon-fire promotion
                                              (02 W4)                 (02 W5/W5′/W7)     (02 W8)

TRACK B — query language (03) · STRICTLY SEQUENTIAL · backend
  B1 Query-language core ─▶ B2 Author-SQL gate ─▶ B3 Shape validation ─▶ B4 Staleness precision ─▶ B5 Round-grain materialization
  (dispatcher + single-field)  (rules 1,3,§7)      (rule 2 + rule 4)    (rule 5 + stubs, ruling)   (§10.4 + rows + A-class seeds)

TRACK C — editor · after B2–B4 · frontend
  C1 Expression editor

TRACK D — components (04) · sequential within itself · frontend · parallel to backend
  D1 Component catalog (after B3) ─▶ D2 Default layouts and parity (after D1 + B5) ─▶ D3 Layout config absorption ─▶ D4 View boundary enforcement
                                                                                          (D4 also needs B5 for econ.js retirement)

SWEEP · parallel, code-only
  S1 Dead-fold retirement (02 W9, Go folds only — scoreboard-sort piece lives in D2, O7)

OWNER WIPE GATE — after {A1–A5, B1–B5, S1} are green (§2)
POST-WIPE — C1, D2–D4 may complete before or after the gate; they carry no schema
```

### 1.2 Parallel vs strictly sequential

- **Strictly sequential:** the A-spine (A1→A5: one subsystem — extract,
  lifecycle, whitelist admission, fixtures; `02 §5`'s ordering is itself the
  DDL↔seed consistency argument); the B-spine (B1→B5: one package,
  `internal/metrics`, each wave's pins building on the previous); the D-spine
  (D1→D4: each consumes the previous wave's runtime).
- **Parallel worktree tracks:** **A-spine ∥ B-spine ∥ D-track ∥ S1**, with
  these integration rules:
  1. **B1 before A3.** B1's single-field normalization re-pins the seed-expr
     fixtures once; A3 then rewrites its three seeds and re-pins their
     expansions. (Reverse order = two overlapping fixture re-pins.)
  2. **A1 before B2's pins are asserted by hand** — B2's allowlist/view set
     must *derive* from `sources` (O9), so ordering is safe either way; if a
     hard count ever appears, integrate A1 first.
  3. **A3 before or with B2 for `metric-language.js`** — A3 edits the column
     list (`metric-language.js:110-114`), B2 rewrites the chapter; if B2
     lands first, A3's edit applies to the rewritten chapter (or is
     re-expressed there). Coordinate in the merge, never silently drop.
  4. Shared files, distinct regions: `schema.sql` (A: player_ticks/drops/seeds
     · B: shape/n_pool/views · B5: `metric_values` key), `fixtures_test.go`
     (A3 expr pins vs B1 normalization — see rule 1), `whitelist.go` (A1
     admission only; B derives).
  5. **A1 and A5 serialize against any other extract/golden-touching wave**
     (both touch `internal/extract` handlers and the golden fixtures).
- **D1 may start as soon as B3 lands** (its binding vocabulary is keyed to
  `metrics.shape`, `04 §2.1`); grammar/parser work is frontend-only and can
  be drafted earlier but cannot close a contract test before B3.

### 1.3 The waves

#### Track A — tick ingest (the `02 §5` spine)

**A1 · Tick ingest** *(02 W1+E1, W2)*
- **Goal:** the fact substrate exists: `player_ticks` at 64 Hz, written by a
  streaming `TickSink`, admitted to the grammar, honest lifecycle.
- **Files/areas:** `internal/store/schema.sql` (table + Tier-1 index with
  rationale, `02 §2.2`), `internal/query/schema.go` (`tableNotes`),
  `internal/metrics/whitelist.go` (sources/sourceColumns/sourceSubject/
  sourceDims/sourceUniqueKeys/sourcePopulation + `playerSources` + **E1**
  `tick` join dimension — `02 §2.4`), `internal/extract` (FrameDone merge,
  `StatePlayer.Side`), `internal/library/library.go` (sink wiring beside the
  sidecar writers), `internal/store/lifecycle.go` (`streamedChildTables`,
  failure-cleanup DELETEs), pins: schema-consistency, column-list, notes,
  Tier-1, join-key.
- **Deps:** none. **Unlocks:** A2/A3's join partner; every event↔tick metric;
  the allowlist's tick tables (auto-derive, O9).
- **Verification:** the full schema-pin battery (`TestSchemaConsistency`,
  `TestJoinKeyDeclarationsMatchSchema`, `TestColumnListConstsMatchSchema`,
  `TestEverySchemaTableHasNote`, `TestTier1IndexesPresent` + the new index
  pin); ingest lifecycle tests (reprocess wipes at sink creation; every
  `cleanupSidecar` path also deletes ticks; `DeleteMatchData` hits
  `streamedChildTables`); `kill_flags_test.go:52-106` same-frame re-proof for
  `in_air` semantics; NULL-not-0 honesty tests (dead frames ⇒ NULL speed/
  in_air); **measure `SaveExtracted` wall-clock for a golden-sized match**
  (02 §6 open question — sizes busy-timeout headroom, record the number).

**A2 · Tick join extensions (E2, E3)** *(02 W3)*
- **Goal:** the two bounded language extensions the seed rewrites need:
  E2 per-secondary player-anchor override, E3 qualified `source.column`
  references (`02 §2.5`).
- **Files/areas:** `internal/metrics/parse.go`/`compile.go` (parser +
  validation + refusal copy; emission already qualifies — `compile.go:700+`),
  refusal pins.
- **Deps:** none technically; sequenced in A-spine per O8. **Unlocks:** A3
  (W4 blocked until these exist, `02 §6`).
- **Verification:** refusal pins for both extensions (ambiguous-column,
  bad anchor, qualified-name edge cases); a positive compile test spelling
  the same-side gate `NOT (atk.side = vic.side AND atk.side <> '' AND
  vic.side <> '')` (`02 §2.5`).

**A3 · Tick seed rewrites** *(02 W4 — columns still present)*
- **Goal:** the two droppable stamps stop being *read*; every value stays
  identical.
- **Files/areas:** `schema.sql` seeds `dmg_no_kill` (:1296),
  `kill_conversion` (:1301), `weapon_damage` gate (:1619 — **value stays
  `capped_dmg`**); attacker_inair read-path switch (`store/queries.go:253,
  1281, 1671` LEFT JOIN to `player_ticks`, or `renderer.js:4240` sidecar read —
  **decide-during-execution (lead), default = store-side join** (keeps the
  DTO contract unchanged; `02 W4` calls both honest)); oracle/test/guide in
  the same commit: `combat_equivalence_test.go:78-95` (rewrite retired-oracle
  SQL to the tick join), `fixtures_test.go` expr pins (re-pin to
  **expansions** per O1 — `wantValues`/`wantN` unchanged, which *is* the
  equivalence proof), `kill_flags_test.go` re-prove, `store_test.go` stamp-write
  pins, `metric-language.js:110-114`, `livestats.js:43,136` note;
  `testdata/seed.sql` gains `player_ticks` rows (explained diff).
- **Deps:** A1 (table), A2 (E2/E3), B1 (fixture re-pin order, rule 1 of §1.2).
  **Unlocks:** A4 (no references remain).
- **Verification:** **equivalence gate value AND N** — every rewritten seed's
  `wantValues`/`wantN` byte-identical pre/post (in-repo proof); golden
  acceptance (extraction read path changed) with any fixture diff explained;
  docs lockstep (guide column list updated in this wave).

**A4 · Stamp drops (DDL)** *(02 W5 + W5′ + W7)*
- **Goal:** `events.same_side` and `events.attacker_inair` are gone from every
  layer; `capped_dmg` stays with its honest comment (ruling O3); `speed`/
  `in_air` can never become `events`/`player_stats` columns.
- **Files/areas:** `schema.sql:264-283`, `lifecycle.go:277-279,475-476`,
  `queries.go` scans, `models.go:398-432`, `dto.go`, `whitelist.go:37-48`,
  `extract/agg.go:1759`, guide `metric-language.js:110-114`; **keep**
  `extract.sameSide`/`same` and `capDamage` — they gate
  `player_stats.total_damage`'s fold (`agg.go:1098,1145-1148`); new pin
  `TestDroppedEventStampColumnsGone` (pattern of
  `columns_schema_test.go:99-127`) + the W7 never-columns extension.
- **Deps:** A3. **Unlocks:** the wipe's column-drop enumeration (02 W6 takes
  the already-committed drops at the wipe — no action).
- **Verification:** the new gone-pin; grep-level proof the columns appear
  nowhere outside history; `capped_dmg` DDL comment present and truthful
  (engine-emulation rationale, `schema.sql:284-296`); `make test` green —
  fresh test DBs lack the columns while live DBs keep them until the wipe
  (harmless: explicit col consts, `01 B5`).

**A5 · Weapon-fire promotion** *(02 W8 — before the wipe so the re-imported
corpus is uniform)*
- **Goal:** `weapon_fire` becomes a typed `events` row (join partner for
  counter-strafing / shots-fired), out of `generic_events` payload JSON.
- **Files/areas:** `internal/extract` typed handler, `models.go:69-132` kind
  vocabulary (pre-release free, **no DDL**); `generic_events` keeps its
  escape-hatch copy by design; `feed.js` FEED_SOURCES descriptor check
  (flagged M — **queued here**: verify the events descriptor's kind list
  doesn't double-surface the row); golden fixture regen (`donk.golden.json`
  gains rows — explained).
- **Deps:** serialized against A1/A3 (extract + golden files). **Unlocks:**
  forward inputs (hit rate already expressible; speed-at-shot joins A1's
  table).
- **Verification:** golden acceptance with deliberate, explained `-update`
  regen; feed double-surface check; kind-vocabulary stability pin.

**S1 · Dead-fold retirement** *(02 W9, code only)* — see §4. Parallel to all;
the scoreboard-sort piece is O7 → D2.

#### Track B — query language behind sugar (03)

**B1 · Query-language core (dispatcher + single-field formula)** *(03 §2 +
PLANNING:41)*
- **Goal:** `compileRefs` becomes a front-end dispatcher; sugar emission
  stays byte-stable; the **stored formula is the expansion** (single field):
  sugar expands at save, `schema.sql` builtin rows normalize to their
  expansion at Open (idempotent derived refresh, same class as `metric_deps`
  re-derivation, `03 §2.2`). Raw-SQL *entry* lands with its gates (B2/B3) —
  this wave ships the seam with sugar-only behavior, no unsafe raw path.
- **Files/areas:** `internal/metrics/compile.go:223` (dispatcher), save/live/
  preview/sweep call sites unchanged (`03 §2.1`), `metricservice.go` save
  expansion + Open normalization, `display.go`, fixtures expr re-pin (to
  expansions, explained diff — O1).
- **Deps:** none. **Unlocks:** B2–B5 (raw branch), dedupe by one spelling,
  Formula tooltip = stored SQL (ruling).
- **Verification:** **characterization first** — sugar byte-stability: every
  existing expression compiles to the identical SQL text before/after the
  dispatcher (the migration's tripwire, `03 §2.3`); value+N gates unchanged
  (`builtinSeed`, equivalence suites — language-agnostic by construction);
  normalization idempotence test (Open twice ⇒ same text); dedupe test (sugar
  vs raw equivalent ⇒ one stored spelling).

**B2 · Author-SQL gate (rules 1, 3, §7 views)** *(03 §1, §3, §7)*
- **Goal:** raw author SQL becomes *savable* only through the full gate:
  `tablesOf` (fail-closed) + table allowlist (derived, O9) + rule-3
  derivation ladder + `metrics.n_pool` declaration + the `src_*` view rule
  (humans-only baked; `<>''` at output; raw player-carrying tables refused
  for authors). Truncation ⇒ metric failure, never a capped N.
- **Files/areas:** `internal/query/query_store.go` (`lexSQL`, `tablesOf`),
  `internal/metrics` save gate (`metricservice.go:473`) + run-time re-check,
  `schema.sql` (`metrics.n_pool` column; ~15 `CREATE VIEW src_…` — one per
  `sources` entry, pinned), refusal copy, **the `metric-language.js` manual
  rewrite rides this wave (O6)**, `strings` catalog entries.
- **Deps:** B1; A1 soft (allowlist derives player_ticks automatically).
  **Unlocks:** raw authoring; B3's result checks run on raw plans; C1.
- **Verification:** **refusal pins per rule** — allowlist misses
  (`generic_events`, `sqlite_*`, app tables), `tablesOf` edges (comma joins,
  CTE, quoted-name fail-closed), pool/FROM mismatch, identity-without-n,
  E6a/E6b/E6c classes (`03 §1.6`); **E7a/E7c equivalence** (author-over-view
  == compiler result — humans-only cannot regress); no-seed-`n_pool` pin;
  truncation⇒failure test; `TestJoinedPopulationAlignment` arbiter run
  (joined-secondary divergence, `03 §9` deferral); save-probe cost measured
  (row cap + timeout bound it — `03 §9` deferral); manual section + strings +
  docslockstep green in-wave (O6).

**B3 · Shape validation (rules 2 and 4)** *(03 §4, §5)*
- **Goal:** persisted `metrics.shape`; result-side validation at preview /
  save-probe / sweep (columns in positional order, keys unique at declared
  grain, numeric values, `value_key` populated, format×shape at save);
  silent short-row skip (`pass.go:523-525`) becomes a refusal; raw metrics
  store `denominator=''` and refuse a declared one.
- **Files/areas:** `schema.sql` (`metrics.shape`), `compile.go` `Plan.Shape`,
  `pass.go`/`preview.go` mappers, `metricservice.go` save probe,
  `metricformats.js` (`filterOnly` retires — rides the dead-code rule, §4).
- **Deps:** B2 (raw path exists to validate). **Unlocks:** D1's binding
  vocabulary (`04 §2.1` keys off `metrics.shape`); `kind:"rows"` slot for B5.
- **Verification:** refusal pins (short/extra/duplicate/non-numeric rows,
  format×shape mismatch); regression test converting the old silent skip into
  a refusal; identity-option gate test (`filterOnly` gone); stored==preview
  equivalence (value AND N) still green.

**B4 · Staleness precision + analysis-rule stubs (rule 5)** *(03 §6 +
PLANNING:42)*
- **Goal:** freshness from the touched-table set (`tablesOf` at save, stored
  as a derived cache like `metric_deps`); the blanket `rule_version` axis
  lifts for fact-only metrics **in this same wave** (ruling O2); analysis
  rules get **built-in metric stubs** — rule values stay user-editable, and
  updating them is the one thing that pushes the stubs, cascading to exactly
  the dependents through `SaveMetricWithDeps`' existing machinery. `player_stats`
  keeps the conservative analysis class until column-level attribution exists
  (`02 §5B` finding 1 — accepted, documented).
- **Files/areas:** `metric_values_store.go` (`MetricCoverage` /
  `metricValueFreshCond` becomes ONE builder parameterized by axis — fresh
  count, canonical read and sweep selection must take the same builder),
  touched-set column (DDL, rides wipe), stub seed rows + edit-push plumbing
  (`analyticservice`/`metricservice`), `02 §5B` map test-pinned to schema.
- **Deps:** B2 (`tablesOf`). **Unlocks:** the precision win; honest rule-edit
  propagation; closes `03 §9`'s blanket-lift deferral.
- **Verification:** **behavior pins** — a fact-only metric does NOT go behind
  on a rule bump; an analysis-touched metric goes behind exactly as today;
  editing a rule value bumps the stub ⇒ dependents recalc via cascade (new
  pin); five states untouched (`metricstate.js` five words, no new state);
  the §5B table classification pinned (incl. the five tables with match-stamp-
  only freshness, `02 §5B` finding 2); `player_ticks` has no rules axis
  (finding 3).

**B5 · Round-grain materialization (§10.4 grain furniture + `metric<rows>`)**
*(03 §1.3/§4.2 + 04 §7 ruling — ONE sequencing item for the same six rows)*
- **Goal:** where a per-round value row lands: extend the `metric_values`
  storage key for round grain (design below), ship `kind:"rows"` validation
  (the slot `03 §4.2` reserved), and seed the **six A-class round-grain
  metrics** the owner ruled to relocate (M19 EconCurve series, M22 CT/T deaths
  per round, M30 utility damage per round, M31 blind ms per round, M36 money
  mean per round, M37 CompareRounds nades/dmg/flash per round —
  PLANNING:39; 04 §7). This single wave serves both the six parity rows and
  the six relocations because they are the *same six* (`04 §7`).
- **Files/areas:** `schema.sql` (`metric_values` key change + seed rows),
  rule-2 `rows` validation (keys unique at round grain), materialization +
  read paths (`GetMetricValuesForMatch` family), `fixtures_test.go` new
  hand-computed value+N gates for the six seeds.
- **Deps:** B3 (`metrics.shape` / rows slot); A-spine need not be complete
  (the six seeds reference no dropped stamps) but must be integrated before
  the wipe so one diff covers everything.
  **Unlocks:** D2's parity closure for those six rows; retirement of the six
  view folds (econ.js, Economy/Utility/RoundDetail/CompareRounds folds) at D4.
- **Decide-during-execution (lead):** the exact storage key (round column in
  the PK vs a sibling table) — constraint: rides the wipe, unique-at-grain
  validated, `03 §1.3`'s N unaffected (rule 3's ladder already passes both
  readings). Not an owner question: the *what* is ruled (round-grain
  statistics ARE metrics).
- **Verification:** rows-kind refusal pins (duplicate round key, wrong
  columns); **value parity against the retired folds** computed over the same
  corpus (the six numbers must equal today's view arithmetic — no-exceptions
  bar, PLANNING:50); new seed value+N gates; dash-on-absent-row honesty
  (no side sample ⇒ row absence ⇒ dash, never 0 — `04 §3` M22/M36).

#### Track C — editor

**C1 · Expression editor** *(03 §8 §10.5, §10.6 — after B2–B4)*
- **Goal:** the editor surfaces the gate: debounced live check runs the full
  raw-SQL gate (classify → rules → probe) with `ExprError{Message,Pos}`
  positioning (statement-level for raw), refusal copy named by rule in
  domain language, SQL + sugar templates in the one textarea, the declared-N
  badge (`n_pool IS NOT NULL` ⇒ "declared pool: …" suffix on the Formula
  tooltip — provenance disclosure, no new state/pref), `denominator=''`
  display handling for raw metrics.
- **Files/areas:** `Builder.svelte` (:806-833 live check, :1738-1746 textarea,
  provenance panel), `services.js`, strings catalog, guide (badge section).
- **Deps:** B2, B3, B4 (nothing to surface before the rules exist).
  **Unlocks:** user-facing SQL authoring complete.
- **Verification:** DOM tests (live check gates, templates, badge);
  `strings-audit.test.js` (tier lengths, verb hints, denylist) +
  `docslockstep` green in-wave; refusal copy review against AGENTS
  domain-language rules.

#### Track D — components and layouts (04)

**D1 · Component catalog** *(04 §1, §2, §2.5 — after B3)*
- **Goal:** the grammar (definitions/instances/layouts, multi-metric slots —
  juxtapose-never-derive, PLANNING-2026-11-18), renderer registry
  (`number-cell/identity-card/table/chart/strip/fact-list/sequence/controls`),
  component runtime input reads, save-time contract refusal, load-time
  stale-ref placeholder, honest-state definition behaviors (`04 §2.6`).
- **Files/areas:** `frontend/src/lib/components/*` (new registry/runtime),
  grammar parser, refusal + placeholder + behavior pins; definition catalog
  home — **decide-during-execution (lead)** at this wave, recommendation
  `04 §8` (built-ins code/seed like metrics; user instances in kvstore).
- **Deps:** B3 (binding vocabulary keyed to `metrics.shape`).
  **Unlocks:** D2.
- **Verification:** unit + jsdom pins — grammar parse; wrong-shape binding and
  wrong-typed-param refusals at save; stale-ref placeholder (drop-never-
  migrate); five-state/empty-pool/0-beside-N behavior table (`04 §2.6`)
  exercised against stored reads.

**D2 · Default layouts and parity** *(04 §3, §8 — after D1 + B5)*
- **Goal:** the shipped Match/Profile/Reports default layouts are component
  compositions covering all 55 parity rows; the six relocated rows bind their
  round-grain metrics; **the parity-characterization pin lands FIRST**
  (render shipped default layouts, compare cells + state words against today's
  views — `04 §8`), then views migrate row-group by row-group.
- **Files/areas:** shipped built-in layouts (default-by-name),
  `Match.svelte`/`PlayerProfile.svelte`/`Reports.svelte` stat surfaces,
  `MetricOrderDialog` successor boundary (retirement lands in D3), the raw-
  default-scoreboard-sort elimination (O7), parity pin file.
- **Deps:** D1, B5 (six rows need `metric<rows>` targets — `04 §8`
  falsification 3). **Unlocks:** the acceptance bar
  (`PLANNING:45-53`) can be evaluated; D3/D4.
- **Verification:** **the parity-characterization pin** (cells + state words
  vs baseline renders; every state word of the five-state vocabulary parity,
  dash-on-empty, no fabricated zeros); layout absent⇒default/present⇒verbatim
  + Reset tests (incl. transpose-not-reset, `04 §5`); M08/M16/M20 honesty
  pins; guide sections for new surfaces in-wave (AGENTS lockstep).

**D3 · Layout config absorption** *(04 §5 — after D2)*
- **Goal:** every pref family becomes layout-instance config in the kvstore
  (absorption map `04 §5`, semantics preserved: absent ⇒ default-by-name,
  present ⇒ verbatim, dated caveat retained and stated in the guide); Reset
  deletes keys (never writes a default literal); `spectra:pinned-*`
  localStorage keys retired; `MetricOrderDialog` retires into the layout
  editor; `webstorage.test.js` PREF_SITES entries removed **with a dated
  comment, replacement existing first** — the scan stays and gets stronger.
- **Files/areas:** `prefs.go` (layout keys registered, frontend-written),
  `metricorder.js` readers/writers, `Builder.svelte`/`Match.svelte`/
  `PlayerProfile.svelte` sites, `webstorage.test.js`, Reset writer.
- **Deps:** D2. **Unlocks:** pref sprawl ends; S1's frontend pref-reader
  retirements.
- **Verification:** absent/present/Reset semantics tests (per key family);
  `webstorage.test.js` green with the two entries removed + dated comment;
  no reader remains for the retired keys (grep); guide note on the retained
  dated caveat (`04 §5`).

**D4 · View boundary enforcement** *(04 §6 — after D2/D3 + B5)*
- **Goal:** "views contain zero statistics logic" becomes mechanical: the
  **computation-scan pin** in 04 §6's shape — raw-read denylist over
  `lib/views/**` (fetch only through the component runtime), fold-pattern
  scan (`.reduce(`, row-accumulating loops, `Math.max/min` over fetched-row
  identifiers) with a sanctioned-site set **each carrying a `why`**, and the
  computation-module ban (`lib/econ.js` formulas retire into metric
  definitions — possible only because B5 seeded them); renderer registry is
  the positive half (no renderer folds).
- **Files/areas:** the pin test (pattern list = implementation detail of
  this wave, `04 §8`), `econ.js` retirement, remaining view folds, Library
  audit decision — **decide-during-execution (lead)**: baseline never audited
  `Library.svelte` (`04 §8`); out of parity scope unless the pin flags it.
- **Deps:** D2, D3, B5. **Unlocks:** the boundary claim; the final audit (§4).
- **Verification:** the computation scan itself (fails on any new view fold
  or raw read outside sanction); `econ.js` gone with its formulas living as
  metric definitions (cross-checked by B5's parity gates); docslockstep.

---

## 2. The one wipe — exact choreography

**Invariant (`02 §5`):** tests build fresh DBs from `schema.sql` every run —
**every pre-wipe commit keeps DDL ↔ seed ↔ whitelist ↔ tests consistent.**
Order within the bundle: language enablers → table+ingest → seed rewrites
(columns still present, unreferenced) → column drops (no references remain) →
data-shape items → owner wipe. 02's W1–W10 is the spine; the mapping below
is exhaustive.

### 2.1 Must land BEFORE the owner's wipe

| # | Wave / item | 02 mapping | Schema touched? |
|---|---|---|---|
| 1 | **A1 Tick ingest** (E1 rides it as one commit — `02 W1`) | W1+W2 | yes: `player_ticks` + Tier-1 index (new objects — reach live DBs free, honest empty pre-wipe state) |
| 2 | **A2 Tick join extensions** | W3 | no |
| 3 | **A3 Tick seed rewrites** (incl. attacker_inair read-path switch, oracle/fixture/guide updates, seed.sql tick rows) | W4 | no (columns still present) |
| 4 | **A4 Stamp drops** (`same_side` + `attacker_inair` out; `capped_dmg` KEPT per O3 with honest comment; `TestDroppedEventStampColumnsGone`; speed/in_air never-columns pin) | W5 + W5′ + W7 | yes: drops |
| 5 | already-committed drops take effect at the wipe (`opening_*`, `damage_by_weapon`, warmup set) — **enumeration only, no action** | W6 | (already in DDL) |
| 6 | **A5 Weapon-fire promotion** — must precede the wipe so the re-imported corpus is uniform | W8 | no (kind vocabulary only) |
| 7 | **B1 Query-language core** + single-field normalization at Open | 03 §2 / O1 | no (derived text refresh) |
| 8 | **B2 Author-SQL gate** — `metrics.n_pool` + `src_*` views | 03 §3/§7 | yes: column + views |
| 9 | **B3 Shape validation** — `metrics.shape` | 03 §4 | yes: column |
| 10 | **B4 Staleness precision** — touched-set column + stub seeds | 03 §6 / PLANNING:42 | yes: column (+ seed rows) |
| 11 | **B5 Round-grain materialization** — `metric_values` key + rows kind + six A-class seeds | §10.4 / 04 §7 | yes: key change + seed rows |
| 12 | **S1 Dead-fold retirement** (Go folds; code — bundled for one review per `02 W9`) | W9 | no |

Guide/strings/docs updates ride their waves throughout (AGENTS lockstep) —
nothing doc-shaped waits for the wipe.

### 2.2 The owner gate, in order (`02 W10`, PLANNING:38)

1. **Snapshot first:** `sqlite3 "<live-db>" ".backup /tmp/opencode/pre-wipe.db"`
   — the pre-migration snapshot, the **sanctioned comparison instrument for
   the whole program** (owner ruling). Do not skip; do not wipe first.
2. **Owner runs** `make deep-clean CONFIRM=1` (refuses while `spectra` runs;
   wipes the XDG data+config+cache dirs — `01 B5`).
3. **Full re-import** of the library (every demo: parse incl. A1's tick sink
   → analyze → metric sweep).
4. **Values+N diff keyed on `matches.sha256`** (autoincrement ids differ
   across DBs): per match, join snapshot ↔ new DB on `(metric name,
   subject_key, dim)` comparing **`value` AND `n`**.
   - Expected: **byte-identical for every pre-existing seed** — the two
     rewritten gates are exact (side is a per-round constant, `02 §2.5`),
     `capped_dmg` untouched, B1/B4 change text/axes not values.
   - The new surfaces (tick-sourced metrics, weapon-fire-derived rows, the
     six A-class round-grain seeds, stub rows) appear **only as ADDED metric
     rows, never changed ones** (`02 W10.3`).
   - **Any changed row = a bug** — fix the metric until it matches
     (no-exceptions bar, PLANNING:50). The snapshot remains the instrument;
     a second wipe is an owner decision, never a workaround.

**After the gate:** the engine-emulation criterion (O3) governs every future
stamp question — observable in per-tick state ⇒ tick join + drop; requires
emulating an engine-internal rule ⇒ stays a derived-at-ingest stamp. No
re-argument of cases.

### 2.3 What may land AFTER the wipe

- Everything schema-free: **C1, D1–D4** (they may also complete *before* the
  gate — they never block it; the gate fires on §2.1's list only).
- CREATE-only items explicitly deferred as free-later: the `player_ticks`
  covering index / WITHOUT ROWID adoption (`02 §6` — on measured sweep pain).
- Re-import-only items: density-as-a-sink-parameter (if disk binds; measured
  13–17 GB/100 matches).
- Future-wipe items (pre-release free, but NOT bundled — no current trigger):
  `yaw`/`pitch` columns, velocity vector, armor/inventory columns
  (`02 §1.3/§6`).
- Forward-input *metrics* (counter-strafing, hit-rate variants beyond today's
  expressibility) — the substrate lands in this program; the metrics ride
  later, gated on the CS2.md sourcing rule (§6).

---

## 3. Per-wave verification strategy

**Standing battery — every wave, no exceptions:** `make fmt vet test lint` ·
`make build` · frontend `npm run build` + `node --test src/lib/*.test.js` +
the jsdom harnesses in `frontend/test/` + the frontend liveness driver ·
`strings-audit.test.js` + `docslockstep.test.js` (from `frontend/`). Driver/
DOM count assertions: **dated re-pins only** when the change is deliberate —
a count pin updated without a dated comment and a stated reason is a rejected
change. **GUI smoke only on request, never by default** (AGENTS — parallel
agents + focus stealing). Golden acceptance (`internal/integration`) runs for
every extraction-touching wave (A1, A3, A5); fixture regen is deliberate,
`-update`, diff explained (AGENTS golden rule).

**Which verification proves WHICH claim:**

| Wave(s) | Verification | Claim it proves (and would falsify) |
|---|---|---|
| A1 | schema/whitelist/lifecycle pin battery; kill_flags re-proof; NULL-honesty tests; SaveExtracted wall-clock measurement | the substrate exists, joins at event ticks, and cannot strand rows — a missing pin or a NULL written as 0 falsifies it |
| A2 | extension refusal + positive compile pins | E2/E3 are bounded and declaration-driven — an unbounded parser change falsifies it |
| A3 | **equivalence: `wantValues`/`wantN` byte-identical** + oracle rewrite + golden | dropping the stamps changes no number — ANY value/N diff falsifies it (the no-exceptions bar) |
| A4 | `TestDroppedEventStampColumnsGone` + layer-wide grep + kept-comment check | columns gone everywhere; predicate survives; capped_dmg honest — a surviving reference falsifies it |
| A5 | golden regen (explained) + feed double-surface check | weapon_fire rows exist exactly once in the feed — a double-surface falsifies it |
| S1 | prove-zero-readers per item (§4) | dead code is dead — any non-test reader falsifies deletion |
| B1 | **characterization: sugar byte-stability** + value/N gates unchanged + normalization idempotence + dedupe | the language swap is a refactor, results language-agnostic — an emission-text diff without explanation falsifies it |
| B2 | refusal pins per rule; **E7a/E7c equivalence**; no-seed-n_pool; truncation⇒failure; probe-cost measurement | raw SQL is gated as hard as sugar and humans-only cannot regress — an E7b-shaped leak falsifies it |
| B3 | shape refusal pins; silent-skip→refusal regression; format×shape | output form is policed, not syntax — a silent skip surviving falsifies it |
| B4 | fact-only-not-behind pin; analysis-behaves-as-today pin; stub-cascade pin; §5B map pin; five-states-untouched | freshness reaches exactly the dependents — an over/under-approximation pin failure falsifies it |
| B5 | rows-kind refusal pins; **value parity vs the six retired folds**; dash-on-absent-row | round-grain statistics are metrics and the six numbers match today — any divergence falsifies it (no exceptions) |
| C1 | DOM tests + strings-audit + docslockstep | the editor surfaces the rules honestly in domain language |
| D1 | contract-refusal + stale-ref + behavior-table pins | violations refuse at save; stale refs degrade — a runtime surprise falsifies it |
| D2 | **parity-characterization pin (cells + state words vs today)** + absent/present/Reset + M08/M16/M20 honesty pins | the acceptance bar: an end user cannot tell a dogfooded component from a bespoke one — a state-word or cell diff falsifies it |
| D3 | per-key absorption semantics tests; webstorage green with dated removals; retired-key grep | prefs absorbed without semantic drift; the webstorage pin got stronger — a lost default/verbatim rule falsifies it |
| D4 | the computation scan (denylist + fold scan + sanctioned sites with `why`) | views contain zero statistics logic — any unsanctioned fold/read fails the pin |
| Owner gate (§2.2) | **values+N diff keyed on `matches.sha256`** | the whole backend bundle changed no existing number — any changed row falsifies the bundle |
| Final audit (§4) | prove-zero-readers + docs/lockstep sweep | the program left no dead production path behind |

**Characterization-before-change discipline:** B1 (byte-stability) and D2
(the parity pin) are *written first, in-wave*, before the behavior they guard
moves. A wave without a falsifiable check in the table above is not
sequenced — it does not start.

---

## 4. The dead-code sweep

**Owner standing order:** retire dead code as we shift to metrics
(MANIFESTO:139 cleanup + `02 W9`). **Per-wave rule (adoption means
migration):** each migration wave retires the production path it supersedes
**in the same wave** — A3 retires the `same_side`/`attacker_inair` read
paths; B1 retires the two-field formula surfaces; B3 retires
`metricformats.js` `filterOnly`; B4 retires the blanket-axis behavior; D3
retires the pref readers + `MetricOrderDialog` + the two localStorage keys;
D4 retires `econ.js` and the remaining view folds. Oracles are rewritten, not
left stale, in the wave that supersedes them (A3's combat-oracle rewrite is
the model).

| Item | Code vs schema | Rides | Status / note |
|---|---|---|---|
| Win-percentage fold (the `win_pct` seed owns it) | code | S1 | **re-verify live/dead at execution** (`02 W9` instructs this) |
| `internal/spatial/series.go` unused reader (`:61-73`) | code | S1 | **CONFLICT TO CHECK:** MANIFESTO:139 orders deletion, but `01 B3` cites a live call site (`platformservice.go:275`) — prove-zero-readers first; if genuinely called, disposition returns to **owner** (delete-ordered vs consumed) — do not delete blind |
| Two unconsumed team aggregates | code | S1 | re-verify at execution |
| Raw default scoreboard sort | frontend code | **D2** (O7) | eliminated when layouts carry `default_sort` |
| `webstorage.test.js` PREF_SITES entries (two pin keys) | test | D3 | removed with dated comment; replacement must exist first (`04 §5`) |
| Superseded oracle paths (`GetCombatStats` same_side SQL, retired read-time fills) | test | rewritten in the wave that supersedes them (A3, B5) | production paths already retired — oracles stay as test references by design |
| Retired pref readers (`metricorder` readers/writers, `MetricOrderDialog`, localStorage pin writers) | frontend | D3 | absorption map `04 §5` is the checklist |
| `lib/econ.js` formulas | frontend | D4 (after B5 seeds exist) | retire into metric definitions (`04 §6` item 3) |
| `metricformats.js` `filterOnly` | frontend | B3 | retires to a real format×shape gate |
| `idx_match_trade_opps_steam` | schema | **not swept** | kept deliberately (dropping = DDL, `01 B1`); rides a future wipe only if ever chosen — default: keep |
| Explicitly NOT dead: `extract.sameSide`/`same`, `capDamage` (fold gates), `phase1/phaseIdentity/phase2` (sugar path), `generic_events` (escape hatch), test-only oracles (`kast/kd` SQL, `EconomyRows`) | — | — | listed so the audit doesn't "clean" them (`02 W5`, AGENTS canonical-homes) |

**Final audit (PLAN's last gate, post-D4):** for every row above —
prove-zero-readers (no non-test reference; `go vet`/golangci green), tests
updated or item deleted, guide updated if user-visible; schema rows confirmed
at the wipe (dropped columns absent via `TestDroppedEventStampColumnsGone`;
kept index present). Schema items ride the wipe (§2.1); code items ride their
wave.

---

## 5. Open-question dispositions — every deferral table, one row each

Deduplicated across tables (several items appear in more than one). Verdicts:
**resolved-by** (the doc/ruling that settles it) · **queued-to-wave** ·
**decide-during-execution** (named decider).

### MANIFESTO §10

| # | Question | Disposition |
|---|---|---|
| 1 | Rule-3 prototype (the gating question) | **resolved-by 03 §1** — all five shapes PASS; E1–E7 executed |
| 2 | Tick density + sidecar/SQL convergence | **resolved-by 02 §1** (policy (c), 64 Hz, width-not-rate — O4) **+ 02 §4** (two sinks of one parse; revisit triggers (a)/(b) stated) |
| 3 | Third-category fate: which rule outputs become queries | **resolved-by PLANNING:42** (stub model: analysis rules get built-in stubs, editable, rule-edit = the single propagation trigger; boundary holds until a query provably replaces a detector); per-detector conversions → **decide-during-execution (lead)**, proof standard = equivalence gate; no wave forces them |
| 4 | Grain furniture for materialization | **resolved-by PLANNING:39 + 04 §7** for the WHAT (round-grain statistics are metrics; the six rows relocate); **queued to B5** for the HOW; storage-key design → **decide-during-execution (lead)** within B5 |
| 5 | Editor UX + error copy; docs/refusal-matrix rewrite | manual rewrite **queued to B2** (O6, AGENTS lockstep); editor UX + copy polish **queued to C1**; refusal copy rules apply at implementation (AGENTS) |
| 6 | Declared-N governance; dialect lock-in | **resolved-by 03 §8** — `n_pool IS NOT NULL` badge (no new state/pref); SQLite-only stated in the manual (one sentence, rides B2's manual rewrite) |
| 7 | Sugar-vs-raw canonical form; Formula tooltip | **resolved-by PLANNING:41** (SINGLE FIELD — O1; overrides 03 §2.2/§9 decisions 3 & 9) |
| 8 | Component grammar + renderer contract | **resolved-by 04 §1–§2** (definition/instance schema, input contracts, save-time refusal, renderer registry) |
| 9 | Config evolution for built-in component definitions | **resolved-by 04 §5** — drop-never-migrate: unknown name ⇒ drop, unknown definition ⇒ placeholder, bad option ⇒ default |
| 10 | View-migration scope | **resolved-by 04 §3 + §6** — all 55 rows dispositioned; stays-view list (chrome, editors, spatial canvases, export, composition) |

### 02 §6 (deferred table + open questions)

| Item | Disposition |
|---|---|
| E2/E3 sequencing vs step 3 (W4 blocked) | **resolved-by this document** — O8: wave *Tick join extensions* (A2) strictly before *Tick seed rewrites* (A3) |
| `capped_dmg` disposition | **resolved-by PLANNING:40** (O3) — keep; drop the other two; revisit post-SQL under the engine-emulation criterion |
| N semantics for tick sources with NULL (structural `COUNT(*)` vs `COUNT(col)` — affects any `avg(speed)` seed) | **queued: decide-during-execution (lead)** at the first speed/NULL-pool seed — **no such seed ships in this program**; default = ladder row 2 (structural `COUNT(*)`) with the `n_pool` override available; record as open in PLAN |
| `speed` definition sourcing (horizontal vs 3-D, units; counter-strafing threshold) | **external gate:** CS2.md/web lookup at implementation time (AGENTS domain rule, `MANIFESTO:37`) — before any speed-consuming metric; never guessed |
| "Avg speed at shots" as a value under the sugar n:1 refusal | **resolved-by 03's raw-SQL path** — authorable as raw SQL (ladder rows 1–2/declaration); the n:1 refusal stays a sugar-grammar rule |
| `weapon_fire` feed double-surface check (flagged M) | **queued to A5** (verify `feed.js` FEED_SOURCES kind list) |
| Covering index / WITHOUT ROWID adoption | **decide-during-execution (implementer)** on measured sweep pain — free-later (index) / wipe-ride (table option); post-wipe |
| `yaw`/`pitch` SQL column | revisit on a concrete metric; future wipe — not queued |
| Density rate as a sink parameter | revisit if disk binds (13–17 GB/100 matches measured) — not queued |
| Golden demo's distinct event-tick count (open question) | **resolved-by 02 §1.2** — option (d) was rejected; the estimate no longer matters |
| `SaveExtracted` wall-clock (open question) | **queued to A1** — measure at execution; sizes busy-timeout headroom |

### 03 §9 (decisions deferred)

| Item | Disposition |
|---|---|
| Round-grain materialization (where a per-round row lands) | **queued to B5** (dedup with §10.4) |
| `metrics.shape` / `n_pool` / touched-set naming, backfill order, exact DDL | **queued:** `n_pool` → B2, `shape` → B3, touched-set → B4 (all ride the wipe; derived data, never versioned) |
| Lifting the blanket `rule_version` axis for fact-only metrics | **resolved-by PLANNING:42** (O2) — FULL NOW, same wave as rule 5 → **B4**; conservative fallback rejected |
| Rows-kind (`kind: "rows"`) validation + storage | **queued to B5** (dedup with §10.4) |
| Joined-secondary population divergence verification | **queued to B2's verification** — arbiter `join_test.go` / `TestJoinedPopulationAlignment` |
| `denominator=''` display implications for raw metrics | **queued to C1** — decide-during-execution (lead); N carries pool disclosure meanwhile |
| Fetch truncation parity audit | **queued to B2's verification** — rule: truncated ⇒ failure, never capped N |
| Exact analysis-vs-extract table classification (§6.2 marked M) | **resolved-by 02 §5B** — verified at `b5373e7`; the map is test-pinned in B4 |
| Save-time probe cost budget | **queued to B2** — measure; row cap + timeout already bound it |

### 04 §8 (decisions deferred)

| Item | Disposition |
|---|---|
| Round-grain materialization + `rows` shape kind (the six (e) rows) | **resolved-by PLANNING:39 / 04 §7** (relocate all six) for the ruling; **queued to B5** — one sequencing item for both the parity rows and the relocations (same six) |
| Parameterized metric materialization vs read-time execution | **decide-during-execution (lead)** — v1 adopts 04 §4's recommendation: **axis-selection only**, no param axis on `metric_values` until measured need; parity does not force it (owner input only if execution wants to deviate) |
| Component definition catalog home (code vs seeded table) | **decide-during-execution (lead)** at D1 — recommendation `04 §8` (built-ins code/seed; user instances kvstore; type-level authoring later) |
| The (e) rows' owner rulings | **resolved-by PLANNING:39** — all six relocated; no exception-list additions |
| Exact computation-scan pattern list | **queued to D4** — shape fixed by `04 §6` (scan + sanctioned sites + `why`); patterns are implementation |
| Library.svelte audit (baseline never audited) | **decide-during-execution (lead)** at D4 — out of parity scope unless the pin flags it |
| "Share layouts" durability tier | **resolved-by 04 §5** — re-decide on the shareability signal; do not pre-build |

### Other flagged notes (not in a deferral table, dispositioned so nothing is dropped)

| Item | Disposition |
|---|---|
| `attacker_inair` renderer read path (store-side LEFT JOIN vs sidecar read — `02 W4` "lead's call") | **decide-during-execution (lead)** — default **store-side join** (DTO contract unchanged, one read path); the sidecar option is equally honest and recorded |
| M23 loss-bonus pips (display format vs statistic — `04 §7`) | **decide-during-execution (owner, non-blocking)** — ships as a display format; either disposition leaves the view fold; no wave waits on it |

---

## 6. Owner obligations and external gates

**Owner rulings already delivered — cite, never re-ask** (`PLANNING:36-43`):
pre-release breakage free + pre-wipe snapshot as the comparison instrument;
A-class ×6 relocate to round-grain row metrics (one sequencing item with the
grain furniture); `capped_dmg` keep + the engine-emulation criterion;
formula display = single field; freshness full-precision now + the
analysis-rule stub model. Every question in §5 that looked open is settled by
one of these or by a sub-doc — **this document raises ZERO new owner
rulings.** The two decide-during-execution items that name the *owner* (M23
pips; the spatial-series conflict if it proves live) are non-blocking and
queued, not asked now.

**Owner obligations, in program order:**

1. **The wipe (the one hard gate)** — fires when §2.1's list {A1–A5,
   B1–B5, S1} is green: (a) `.backup` snapshot, (b) `make deep-clean
   CONFIRM=1`, (c) full re-import, (d) values+N diff keyed on
   `matches.sha256` — exact choreography in §2.2. Owner runs it; the plan
   stops at the gate until it completes and the diff is clean.
2. **GUI smoke — on request only, never by default** (AGENTS: parallel
   agents, focus stealing; solo pass only). The parity pin (D2) and the
   computation scan (D4) are the mechanical stand-ins; live-app checks are
   the owner's call.
3. **Non-blocking micro-decisions** if/when they surface: M23 pips; the
   spatial-series reader if the sweep proves it live.

**External gates:**

- **CS2.md / web sourcing** (AGENTS domain rule): `speed` definition and the
  counter-strafing threshold must be sourced, never guessed — before any
  speed-consuming metric (post-program; §5).
- **Git LFS:** `git lfs pull` before golden acceptance runs (AGENTS).
- **Machine/time:** the wipe + re-import is wall-clock on the owner's
  machine; re-import includes A1's measured 9–22 s/match tick insert —
  disclosed, honest.

---

## 7. The PLAN.md handoff spec

`PLAN.md` replaces `PLANNING.md` (which is then deleted, `PLANNING:105-107`).
It must let a **fresh session execute the whole migration in one session**:
self-sufficient to START and to know where to look — **not** a copy of the
sub-docs.

### 7.1 What PLAN.md contains

1. **Header block:** goal; the acceptance bar (`PLANNING:45-53` verbatim
   intent); read order for a cold session (`MANIFESTO` → `01` → this doc's
   wave list → the cited sub-doc section per wave); worktree/branch
   conventions (AGENTS instance isolation, XDG env exports, no push without
   lead); the standing battery (§3 above) and the wrap rule (deadline check,
   partial report, cheapest verification).
2. **The sub-doc index** — section → question it answers, so lookups are one
   hop: DDL text and ingest design → `02 §2–§3`; wipe bundle → `02 §5`;
   table-ownership/freshness classification → `02 §5B`; rule-3 ladder →
   `03 §1`; rules 1–5 designs → `03 §3–§6`; `src_*` views → `03 §7`; component
   grammar/registry/behaviors → `04 §1–§2`; the 55-row parity table → `04 §3`;
   controls→parameters → `04 §4`; pref absorption map → `04 §5`; boundary +
   computation-scan shape → `04 §6`; A-class dispositions → `04 §7`;
   baseline inventories → `01` Parts A/B/C; direction → `MANIFESTO §9`.
3. **The ordered waves** — for each: name (domain-named, as in §1.3), goal,
   files/contracts (pointers, not pasted DDL), deps, unlocks, **verification
   (the falsifiable check)**, guide-lockstep note, retirement note (§4 rule),
   and any decide-during-execution item with its decider.
4. **Gates between waves:**
   - **GREEN gate** — the standing battery before any wave is "done".
   - **OWNER gate** — §2.2 verbatim (commands, order, expected diff), with an
     explicit callout that waves listed in §2.1 must be green first and that
     C1/D-tracks do not gate it.
   - **PARITY gate** — D2's characterization pin = the acceptance bar; the
     program does not close until it passes.
   - **AUDIT gate** — §4's final audit (prove-zero-readers + docs sweep).
5. **Owner-obligation callouts** — §6, placed at the waves they gate (a
   boxed note before the wipe section; GUI smoke noted as request-only).
7. **Integration-order notes** — §1.2's five rules (B1 before A3, derived
   allowlist/views, guide coordination, shared-file regions, extract/golden
   serialization).
8. **Recovery notes** (below).

### 7.2 What stays in the sub-docs (referenced, never copied)

DDL/DDL-comment text (`02 §2.2`), the absorption map (`04 §5`), the parity
table (`04 §3`), the rule designs and executed E1–E7 evidence (`03 §1–§7`),
benchmarks (`02 §1.2`), per-doc falsified lists (`02 §6`, `03 §9`, `04 §8`),
the baseline inventories (`01`), dispositions already resolved (§5's
resolved-by rows — PLAN carries only queued/decide rows as open items).
Rule of thumb: **PLAN.md carries order, gates, verification and lookups;
sub-docs carry design and evidence.** If a sub-doc answer changes during
execution, the lead reconciles it into the sub-doc (PLANNING "findings pass
forward") — never an ad-hoc divergence in code.

### 7.3 Recovery notes (what to do when a wave fails)

- **Characterization pin fails after a language wave (B1 byte-stability,
  D2 parity):** the tripwire fired — bisect the emission/render change; never
  re-pin fixtures to match new output without an explained diff (AGENTS
  golden/fixture rule: a fixture diff without justification is a rejected
  change).
- **Equivalence gate fails (value or N diverges):** fix the metric until it
  matches (no-exceptions bar). Do not adjust `wantValues`/`wantN` to the new
  number; do not re-argue the ruling that produced the rewrite.
- **Owner-gate diff shows a changed row:** treat as a bug in the bundle —
  identify the wave by the metric's touched tables, fix, re-run the diff
  against the **same snapshot**. A second wipe is an owner decision, never a
  workaround.
- **Golden fixture diff appears in a non-golden wave:** an extract change
  leaked — either it belongs to A1/A3/A5 (move it there) or it is unintended.
- **DOM/driver count pin fails:** only a dated, reasoned re-pin if the change
  is deliberate; otherwise treat as a regression.
- **A wave cannot reach green within its budget:** stop, leave the tree
  exactly as-is, report completed vs not-done vs skipped-with-reason (the
  wrap rule), and hand the failing gate to the next session — a partial plan
  executed honestly beats a green-looking lie.
- **A new conflict between sub-docs surfaces at execution:** the lead
  reconciles (rulings section wins), annotates the sub-doc, and updates this
  document's §0 — never resolve it silently in a commit.
