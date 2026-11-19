# PLAN — the facts/queries/components migration (single-session handoff)

**Status:** READY FOR EXECUTION. This is the complete handoff: a cold session
reads it top to bottom and executes the migration. It **replaces
`PLANNING.md`** (deleted when the lead accepts this plan). Depth — DDL,
benchmarks, evidence, designs, dispositions already settled — lives in the
sub-docs `dogfood/01…05` and `MANIFESTO.md`; this file carries **order,
gates, verification and lookups**, never copied design. Citations are
reconciled at worktree HEAD `afaeda2`: `02 §2.2` means section 2.2 of
`dogfood/02-TICK-STATE.md`, `05 §3` means section 3 of `05-SEQUENCING.md`,
and so on. Planning documents only — no app code, no tests, no schema were
written to produce this file.

**Goal:** execute the three-layer migration the direction commits to —
complete per-tick fact substrate, SQL as the metrics definition language
behind sugar with the five-rule output gate, and a component/layout catalog
that dogfoods the entire match/profile stat surface — in ordered waves,
bundled for one owner wipe, with every wave falsifiable and no existing
number changed.

---

## 1. The acceptance bar (owner, 2026-11-18 — carried into every wave)

**Component parity:** everything currently shown in the match and profile
views must be expressible under the new components system — an end user
cannot tell a dogfooded component from a bespoke one. Same migration
discipline as always: characterization first, display parity pinned,
honest states intact (dash on empty pool, five metric states, no fabricated
zeros).

**No-exceptions:** if numbers diverge, fix the metric until they match.

This bar is evaluated by the **PARITY gate** (§6) at wave D2 and by the
owner's values+N diff at the wipe; it is never relaxed to make a wave pass.

---

## 2. Owner rulings (live, complete record — 2026-11-18)

These five rulings are the **entire** owner-ruling record of the planning
phase; they are binding and override any sub-doc text they conflict with
(each conflict is recorded as an override in `05 §0` — nine overrides, all
settled there; never re-litigate them). **An executing session never needs
`PLANNING.md`:** where sub-docs or 05 cite `PLANNING:39` / `:41` / `:42`,
they mean these entries. Cite, never re-ask.

1. **Pre-release breakage is free + the pre-wipe snapshot is the comparison
   instrument** *(owner, 2026-11-18)*: we are pre-release; schema and seed
   changes break whatever they need to — no compatibility paths, no
   ensure-column anything (consistent with AGENTS "version nothing until the
   first release"). Where verification is a concern, **cut a pre-migration
   database snapshot before the wipe** and diff metric values+N
   match-by-match after re-import — the sanctioned comparison instrument
   for the whole program. This puts the `same_side` / `attacker_inair` /
   `capped_dmg` drops on the table, coordinated with rewrites of the three
   seeds that reference them (see ruling 3 for the outcome).

2. **A-class ×6 — RELOCATE ALL SIX** *(owner, 2026-11-18)*: M19 EconCurve,
   M22 CT/T deaths fold, M30/M31 Utility bars, M36 money mean, M37
   CompareRounds summary become **round-grain metric values bound by their
   components** (the chart/bar renderers already exist in the grammar) —
   **NO additions to the ratified exception list.** This is the same set as
   the six `metric<rows>` parity bindings, so the ruling resolves both the
   parity rows and track D's grain-furniture dependency together: wave B5
   sequences the grain furniture once, for both.

3. **`capped_dmg`: two drops, one keep + the engine-emulation criterion**
   *(owner, 2026-11-18)*: drop `same_side` + `attacker_inair` as tick-join
   replacements (same_side needs the two bounded language extensions E2/E3,
   sequenced at wave A2); **KEEP `capped_dmg`** as an ingest stamp with an
   honest DDL comment — it is not tick-derivable (order-dependent,
   row-local; the DDL says so at `schema.sql:284-296`); revisit after the
   SQL jump. The "three stamps" premise now reads **"two drops, one keep"**
   everywhere. **Generalized into a standing CRITERION:** capped damage is
   *us emulating the engine*, not an invented statistic — same class as
   assist assignment. The standing test for any future stamp-drop candidate:
   **is the value observable in per-tick state, or does it require
   emulating an engine-internal rule?** Observable ⇒ tick join, drop the
   stamp; engine-emulation ⇒ stays a derived-at-ingest stamp (no tick row
   carries the engine's decision). Wave A4 applies this gate instead of
   re-arguing cases; it also governs every future stamp question after the
   wipe.

4. **Formula display = SINGLE FIELD** *(owner, 2026-11-18)*: the stored
   metric formula **IS** the expanded SQL; the Formula tooltip and the
   editor show the stored formula; no separate authored-source field. Flips
   `03 §9` decisions 3/9 (annotated there). Wave-B consequences: sugar
   input still expands at save; seed expressions in `schema.sql` normalize
   to their expansion at Open so every row carries one spelling (dedupe
   holds); the authored sugar stays the authoring source of record in git.

5. **Freshness precision = FULL NOW + the analysis-rule stub model**
   *(owner, 2026-11-18, refined same day)*: lift the blanket `rule_version`
   axis for fact-only metrics in the **same wave as rule 5** (wave B4) —
   the conservative fallback in `03 §9`'s deferral table is rejected; the
   pin updates ride that wave. **Refinement (supersedes an earlier
   "analysis rules convert into ordinary metrics" paraphrase):** analysis
   rules get **built-in metric stubs** that feed propagation of dependent
   metrics; **analysis-rule values remain user-editable**, and updating them
   is **the one thing that pushes a change to the corresponding stubs**,
   which triggers recalculation of dependents via the existing
   dependency-cascade machinery. So the blanket axis is replaced by
   **stub-mediated propagation** (precision = the cascade reaches exactly
   the dependents), while rule 5's touched-table set still governs fact
   freshness. Analysis outputs keep their identity (editable, Go-computed)
   but surface in the metrics system as stubs; the boundary holds only until
   a query provably replaces a detector.

---

## 3. How a cold session starts

**Read order:** `MANIFESTO.md` (the direction; §9 is the migration shape)
→ `01-BASELINE.md` (the system as it exists — Parts A/B/C) → **this
document's wave list (§5)** → the cited sub-doc section for the wave you
are on (the one-hop index, §4). `05-SEQUENCING.md` is the deep sequencing
source — keep it open beside this file while executing; its §0 (the nine
reconciliation overrides), §2 (wipe choreography), §3 (verification
strategy), §4 (dead-code sweep) and §5 (dispositions) are the authority
behind the compressed statements here.

**Worktree / branch conventions** (AGENTS.md is binding in full; the ones
that bite):

- **Instance isolation (XDG):** every agent-launched instance exports
  per-worktree dirs first, before anything runs:
  `export XDG_CONFIG_HOME=$REPO/.xdg/config XDG_DATA_HOME=$REPO/.xdg/data
  XDG_CACHE_HOME=$REPO/.xdg/cache` (`$REPO` = worktree root; `.xdg/` is
  gitignored). Seed assets once per worktree by symlinking
  `maps/ icons/ sounds/` from the real data dir — an isolated instance must
  **not** run extraction. Never open another instance's live db; kill by
  recorded PID, never `pkill -x spectra` blind.
- **No push without the lead.** Commit on the branch you were given; the
  lead integrates, pushes, and owns cross-session reconciliation.
- **GUI smoke only on request, never by default** (parallel agents + focus
  stealing; solo pass only, per AGENTS). The parity pin (D2) and the
  computation scan (D4) are the mechanical stand-ins.
- **Guide lockstep per wave** (AGENTS "manual stays in lockstep"): a wave
  that changes user-visible behavior, surfaces or wording updates
  `frontend/src/lib/docs/manuals/` in the **same wave**; every
  user-visible surface gets a guide section (or explicit placeholder)
  before merge. `docslockstep.test.js` enforces coverage.
- **No session/plan/wave tokens in file, test or commit names** — domain
  language throughout (AGENTS no-session-leakage; mechanically pinned by
  `TestNoSessionLeakageInFileNames`).
- **Golden fixtures only deliberately:** regen with `-update`, diff
  explained; a fixture diff without justification is a rejected change.
  `git lfs pull` first or golden acceptance skips.
- **Pre-release, no versioning:** no format-version constants, no
  ensure-column/ALTER paths, no legacy-data fallbacks — stale local data is
  wiped + re-imported (AGENTS). Data missing a required input yields
  unknown/skipped rows, never a guessed fallback.

**Standing verification battery — every wave, no exceptions** (`05 §3`):

```
make fmt vet test lint          # from src/ (repo Makefile forwards)
make build
cd frontend && npm run build
node --test src/lib/*.test.js
# the jsdom harnesses in frontend/test/
# the frontend liveness driver
node --test src/lib/strings-audit.test.js src/lib/docslockstep.test.js
```

Golden acceptance (`internal/integration`) runs for every
extraction-touching wave (**A1, A3, A5**). Driver/DOM count assertions:
**dated re-pins only**, when the change is deliberate — a count pin updated
without a dated comment and a stated reason is a rejected change.

**Wrap rule (every session):** carry a wall-clock budget with an absolute
DEADLINE; check it with one `date '+%Y-%m-%d %H:%M %Z'` call after each
major section and before starting the next. At/past deadline (or clearly
not going to finish the current wave): **stop taking new work**, finish or
abandon the current section honestly, report **completed vs not-done vs
skipped-with-reason**, run the cheapest verification (the tree builds, the
changed files are committed, `git status` clean apart from them), commit
only if green — otherwise report the tree state. A partial report at the
deadline is a success; a green-looking lie is not.

---

## 4. Sub-doc index — one hop to depth

| Question | Where |
|---|---|
| The direction (three layers, five rules, migration shape) | `MANIFESTO.md` §1–§9 (read-order first entry) |
| Baseline inventories: metrics engine / store-extract-sidecar / surfaces+prefs | `01` Parts A / B / C (parity table `01 §C6`) |
| `player_ticks` DDL, grain, PK, indexes, column provenance | `02 §2` (DDL text `02 §2.2`) |
| Whitelist admission + E2/E3 language extensions | `02 §2.4–§2.5` |
| Ingest path: streaming `TickSink`, chunked txs, lifecycle | `02 §3` |
| Sidecar relationship (two sinks of one parse, revisit triggers) | `02 §4` |
| The one-wipe bundle — W1–W10, ordered, per-item | `02 §5` |
| Table ownership / freshness classification (rule-5 input) | `02 §5B` |
| Rule-3 derivation ladder + declaration + executed E1–E7 evidence | `03 §1` |
| Sugar→SQL refactor shape; stored-canonical-formula mechanics | `03 §2` (ruling 4 above overrides decisions there) |
| Rules 1–5 designs (safety gate, shape, furniture matrix, freshness) | `03 §3–§6` |
| `src_*` views / humans-only-under-author-SQL rule | `03 §7` |
| Editor UX, declared-N badge, docs/refusal rewrite scope | `03 §8` |
| Component grammar (definitions/instances, grammar additions) | `04 §1` |
| Kind vocabulary, renderer registry, contract refusal, honest-state behaviors | `04 §2` |
| **The 55-row parity table** (the acceptance checklist) | `04 §3` |
| Controls→parameters (axis-selection v1) | `04 §4` |
| **Pref absorption map** (layout-config home, per-key semantics) | `04 §5` |
| Boundary + computation-scan shape (sanctioned sites with `why`) | `04 §6` |
| A-class dispositions (the six relocations) | `04 §7` |
| Per-doc falsified lists and "what PLAN must carry" | `02 §6`, `03 §9`, `04 §8` |
| The nine reconciliation overrides (docs in conflict — resolved) | `05 §0` |
| Wave graph, per-wave design pointers, wipe choreography, verification table, sweep, dispositions | `05 §1–§6` |
| Benchmarks (density cost, tick volume, disk) | `02 §1.2` |

**Rule of thumb** (`05 §7.2`): PLAN carries order, gates, verification and
lookups; sub-docs carry design and evidence. If a sub-doc answer changes
during execution, the lead reconciles it into the sub-doc ("findings pass
forward") — never an ad-hoc divergence in code.

---

## 5. The ordered waves

The graph (`05 §1.1`): the **A-spine** (tick ingest) and **B-spine**
(query language) are each strictly sequential; **D-track** (components) is
sequential within itself; **S1** (sweep) is parallel and code-only; tracks
run in parallel worktrees under the integration rules of §7 below. **C1**
comes after B2–B4. The **OWNER gate** (§6) fires when {A1–A5, B1–B5, S1}
are green; C1 and D1–D4 carry no schema and never gate it (they may
complete before or after).

Retirement note in each wave = AGENTS "adoption means migration": the wave
retires the production path it supersedes **in the same wave**, and
oracles are rewritten, never left stale.

### Track A — tick ingest (the `02 §5` spine, strictly sequential, backend)

**A1 · Tick ingest** *(02 W1+E1, W2)*
- **Goal:** the fact substrate exists — `player_ticks` at 64 Hz, written by
  a streaming `TickSink`, admitted to the grammar, honest lifecycle.
- **Files/contracts:** `internal/store/schema.sql` (table + Tier-1 index
  with rationale — `02 §2.2`); `internal/query/schema.go` table notes;
  `internal/metrics/whitelist.go` sources/sourceColumns/sourceSubject/
  sourceDims/sourceUniqueKeys/sourcePopulation + `playerSources` + the E1
  `tick` join dimension (`02 §2.4`); `internal/extract` (FrameDone merge,
  `StatePlayer.Side`); `internal/library/library.go` (sink wiring beside
  the sidecar writers); `internal/store/lifecycle.go`
  (`streamedChildTables`, failure-cleanup DELETEs — the B5.1 correction,
  `02 §3.3`); pins: schema-consistency, column-list, notes, Tier-1,
  join-key.
- **Deps:** none. **Unlocks:** A2/A3's join partner; every event↔tick
  metric; the allowlist's tick tables (auto-derived, `05 §0` O9).
- **Verification:** the full schema-pin battery (`TestSchemaConsistency`,
  `TestJoinKeyDeclarationsMatchSchema`, `TestColumnListConstsMatchSchema`,
  `TestEverySchemaTableHasNote`, `TestTier1IndexesPresent` + the new index
  pin); ingest lifecycle tests (reprocess wipes at sink creation; every
  `cleanupSidecar` path also deletes ticks; `DeleteMatchData` hits
  `streamedChildTables`); `kill_flags_test.go:52-106` same-frame re-proof
  for `in_air`; NULL-not-0 honesty tests (dead frames ⇒ NULL speed/in_air);
  **measure `SaveExtracted` wall-clock for a golden-sized match** (open
  question, `02 §6` — record the number; it sizes busy-timeout headroom).
  Golden acceptance runs (extraction-touching).
- **Guide/retirement:** no user-visible surface change (guide unchanged,
  docslockstep green); no retirement — this is pure addition.
- **Open items:** none beyond the wall-clock measurement (§8 row 3).

**A2 · Tick join extensions (E2, E3)** *(02 W3; sequenced by `05 §0` O8)*
- **Goal:** the two bounded language extensions the seed rewrites need: E2
  per-secondary player-anchor override, E3 qualified `source.column`
  references (`02 §2.5`).
- **Files/contracts:** `internal/metrics/parse.go`/`compile.go` (parser +
  validation + refusal copy; emission already qualifies —
  `compile.go:700+`); refusal pins.
- **Deps:** none technically; placed strictly between A1 and A3 in the
  A-spine (W4 is blocked until these exist, `02 §6`). **Unlocks:** A3.
- **Verification:** refusal pins for both extensions (ambiguous-column,
  bad anchor, qualified-name edge cases); a positive compile test spelling
  the same-side gate `NOT (atk.side = vic.side AND atk.side <> '' AND
  vic.side <> '')` (`02 §2.5`).
- **Guide/retirement:** expression-language surface — refusal copy in
  domain language (AGENTS); no retirement.

**A3 · Tick seed rewrites** *(02 W4 — columns still present)*
- **Goal:** the two droppable stamps stop being *read*; every value stays
  identical.
- **Files/contracts:** `schema.sql` seeds `dmg_no_kill` (:1296),
  `kill_conversion` (:1301), `weapon_damage` gate (:1619 — **value stays
  `capped_dmg`**); the attacker_inair read-path switch
  (`store/queries.go:253,1281,1671` LEFT JOIN to `player_ticks`, or
  `renderer.js:4240` sidecar read — **decide-during-execution (lead),
  default = store-side join** (keeps the DTO contract unchanged; `02 W4`
  calls both honest)); oracle/test/guide in the same commit:
  `combat_equivalence_test.go:78-95` (rewrite retired-oracle SQL to the
  tick join), `fixtures_test.go` expr pins re-pinned to **expansions** per
  ruling 4 (`wantValues`/`wantN` unchanged, which *is* the equivalence
  proof), `kill_flags_test.go` re-prove, `store_test.go` stamp-write pins,
  `metric-language.js:110-114`, `livestats.js:43,136` note;
  `testdata/seed.sql` gains `player_ticks` rows (explained diff).
- **Deps:** A1 (table), A2 (E2/E3), **B1** (fixture re-pin order — §7
  rule 1). **Unlocks:** A4 (no references remain).
- **Verification:** **equivalence gate value AND N** — every rewritten
  seed's `wantValues`/`wantN` byte-identical pre/post (in-repo proof; the
  no-exceptions bar); golden acceptance with any fixture diff explained;
  docs lockstep (guide column list updated **in this wave**).
- **Retirement:** the `same_side`/`attacker_inair` read paths retire here;
  the combat oracle is rewritten, not left stale (the model for all oracle
  rewrites).

**A4 · Stamp drops (DDL)** *(02 W5 + W5′ + W7)*
- **Goal:** `events.same_side` and `events.attacker_inair` are gone from
  every layer; `capped_dmg` stays with its honest comment (ruling 3);
  `speed`/`in_air` can never become `events`/`player_stats` columns (the
  W7 never-columns extension).
- **Files/contracts:** `schema.sql:264-283`, `lifecycle.go:277-279,475-476`,
  `queries.go` scans, `models.go:398-432`, `dto.go`, `whitelist.go:37-48`,
  `extract/agg.go:1759`, guide `metric-language.js:110-114`; **keep**
  `extract.sameSide`/`same` and `capDamage` — they gate
  `player_stats.total_damage`'s fold (`agg.go:1098,1145-1148`); new pin
  `TestDroppedEventStampColumnsGone` (pattern of
  `columns_schema_test.go:99-127`) + the never-columns extension.
- **Deps:** A3. **Unlocks:** the wipe's column-drop enumeration (02 W6's
  already-committed drops take effect at the wipe — enumeration only, no
  action).
- **Verification:** the new gone-pin; grep-level proof the columns appear
  nowhere outside history; `capped_dmg` DDL comment present and truthful
  (engine-emulation rationale, `schema.sql:284-296`); `make test` green —
  fresh test DBs lack the columns while live DBs keep them until the wipe
  (harmless: explicit col consts, `01 B5`).
- **Guide/retirement:** guide's stamp wording updated in-wave; the dropped
  columns' read/write paths are the retirement (grep-proofed by A4 itself).

**A5 · Weapon-fire promotion** *(02 W8 — before the wipe so the re-imported
corpus is uniform)*
- **Goal:** `weapon_fire` becomes a typed `events` row (join partner for
  counter-strafing / shots-fired), out of `generic_events` payload JSON.
- **Files/contracts:** `internal/extract` typed handler,
  `models.go:69-132` kind vocabulary (pre-release free, **no DDL**);
  `generic_events` keeps its escape-hatch copy by design; `feed.js`
  FEED_SOURCES descriptor check (flagged M — **queued here**: verify the
  events descriptor's kind list doesn't double-surface the row); golden
  fixture regen (`donk.golden.json` gains rows — explained).
- **Deps:** serialized against A1/A3 (extract + golden files — §7 rule 5).
  **Unlocks:** forward inputs (hit rate already expressible; speed-at-shot
  joins A1's table).
- **Verification:** golden acceptance with deliberate, explained `-update`
  regen; feed double-surface check (a double-surface falsifies it);
  kind-vocabulary stability pin.
- **Guide/retirement:** no new surface (feed row kind is internal);
  `generic_events`' escape-hatch copy stays (listed in `05 §4`'s
  explicitly-not-dead set — do not "clean" it).

**S1 · Dead-fold retirement** *(02 W9, code only — parallel to all)*
- **Goal:** the dead Go folds die, proven dead first.
- **Files/contracts:** the `05 §4` sweep table rows that ride S1: the
  win-percentage fold (the `win_pct` seed owns it — **re-verify live/dead
  at execution**), `internal/spatial/series.go:61-73`,
  two unconsumed team aggregates. **The scoreboard-sort piece is NOT here**
  — it rides D2 (`05 §0` O7).
- **Deps:** none (parallel). **Unlocks:** the final audit's code rows.
- **Verification:** prove-zero-readers per item — any non-test reader
  falsifies deletion.
- **Guide/retirement:** no user-visible change (the folds are dead code —
  guide unchanged, docslockstep green); the deletions are the retirement.
- **Conflict to check (do not delete blind):** MANIFESTO:139 orders
  `spatial/series.go` deleted, but `01 B3` cites a live call site
  (`platformservice.go:275`) — prove readers first; if genuinely called,
  the disposition returns to the **owner** (delete-ordered vs consumed), a
  non-blocking micro-decision (§9).

### Track B — query language behind sugar (03, strictly sequential, backend)

**B1 · Query-language core (dispatcher + single-field formula)**
*(03 §2 + ruling 4)*
- **Goal:** `compileRefs` becomes a front-end dispatcher; sugar emission
  stays byte-stable; the **stored formula is the expansion** (single
  field): sugar expands at save, `schema.sql` builtin rows normalize to
  their expansion at Open (idempotent derived refresh, same class as
  `metric_deps` re-derivation, `03 §2.2`). Raw-SQL *entry* lands with its
  gates (B2/B3) — this wave ships the seam with sugar-only behavior, no
  unsafe raw path.
- **Files/contracts:** `internal/metrics/compile.go:223` (dispatcher),
  save/live/preview/sweep call sites unchanged (`03 §2.1`),
  `metricservice.go` save expansion + Open normalization, `display.go`,
  fixtures expr re-pin (to expansions, explained diff — ruling 4).
- **Deps:** none. **Unlocks:** B2–B5 (raw branch), dedupe by one spelling,
  Formula tooltip = stored SQL.
- **Verification:** **characterization first** — sugar byte-stability:
  every existing expression compiles to the identical SQL text before/after
  the dispatcher (the migration's tripwire, `03 §2.3`); value+N gates
  unchanged (`builtinSeed`, equivalence suites — language-agnostic by
  construction); normalization idempotence test (Open twice ⇒ same text);
  dedupe test (sugar vs raw equivalent ⇒ one stored spelling).
- **Guide/retirement:** the Formula tooltip now shows the stored SQL
  (user-visible) — guide touch in-wave, docslockstep green; the two-field
  formula surfaces retire here (ruling 4's consequence); fixtures re-pin
  once, then A3 re-pins its three seeds (§7 rule 1).

**B2 · Author-SQL gate (rules 1, 3, §7 views)** *(03 §1, §3, §7)*
- **Goal:** raw author SQL becomes *savable* only through the full gate:
  `tablesOf` (fail-closed) + table allowlist (derived, `05 §0` O9) +
  rule-3 derivation ladder + `metrics.n_pool` declaration + the `src_*`
  view rule (humans-only baked; `<>''` at output; raw player-carrying
  tables refused for authors). Truncation ⇒ metric failure, never a capped
  N.
- **Files/contracts:** `internal/query/query_store.go` (`lexSQL`,
  `tablesOf`), `internal/metrics` save gate (`metricservice.go:473`) +
  run-time re-check, `schema.sql` (`metrics.n_pool` column; ~15
  `CREATE VIEW src_…` — one per `sources` entry, pinned), refusal copy,
  **the `metric-language.js` manual rewrite rides this wave (`05 §0` O6)**,
  `strings` catalog entries.
- **Deps:** B1; A1 soft (the allowlist derives `player_ticks`
  automatically — if a hard count ever appears, integrate A1 first, §7
  rule 2). **Unlocks:** raw authoring; B3's result checks on raw plans; C1.
- **Verification:** **refusal pins per rule** — allowlist misses
  (`generic_events`, `sqlite_*`, app tables), `tablesOf` edges (comma
  joins, CTE, quoted-name fail-closed), pool/FROM mismatch,
  identity-without-n, E6a/E6b/E6c classes (`03 §1.6`); **E7a/E7c
  equivalence** (author-over-view == compiler result — humans-only cannot
  regress); no-seed-`n_pool` pin; truncation⇒failure test;
  `TestJoinedPopulationAlignment` arbiter run (joined-secondary
  divergence); save-probe cost measured (row cap + timeout bound it);
  manual section + strings + docslockstep green **in-wave** (O6).
- **Guide/retirement:** the manual's expression chapter is rewritten here
  (O6 — AGENTS lockstep); no production retirement beyond ruling 4's
  two-field surfaces (B1).

**B3 · Shape validation (rules 2 and 4)** *(03 §4, §5)*
- **Goal:** persisted `metrics.shape`; result-side validation at preview /
  save-probe / sweep (columns in positional order, keys unique at declared
  grain, numeric values, `value_key` populated, format×shape at save);
  the silent short-row skip (`pass.go:523-525`) becomes a refusal; raw
  metrics store `denominator=''` and refuse a declared one.
- **Files/contracts:** `schema.sql` (`metrics.shape`), `compile.go`
  `Plan.Shape`, `pass.go`/`preview.go` mappers, `metricservice.go` save
  probe, `metricformats.js` (`filterOnly` retires — rides the dead-code
  rule).
- **Deps:** B2 (the raw path exists to validate). **Unlocks:** D1's
  binding vocabulary (`04 §2.1` keys off `metrics.shape`); the `kind:"rows"`
  slot for B5.
- **Verification:** refusal pins (short/extra/duplicate/non-numeric rows,
  format×shape mismatch); a regression test converting the old silent skip
  into a refusal; identity-option gate test (`filterOnly` gone);
  stored==preview equivalence (value AND N) still green.
- **Guide/retirement:** no new surface (refusal copy only — domain
  language per AGENTS); `metricformats.js` `filterOnly` retires in this
  wave.

**B4 · Staleness precision + analysis-rule stubs (rule 5)**
*(03 §6 + ruling 5)*
- **Goal:** freshness from the touched-table set (`tablesOf` at save,
  stored as a derived cache like `metric_deps`); the blanket `rule_version`
  axis lifts for fact-only metrics **in this same wave** (ruling 5 — O2);
  analysis rules get **built-in metric stubs** — rule values stay
  user-editable, and editing them is the one thing that pushes the stubs,
  cascading to exactly the dependents through `SaveMetricWithDeps`'s
  existing machinery. `player_stats` keeps the conservative analysis class
  until column-level attribution exists (`02 §5B` finding 1 — accepted,
  documented).
- **Files/contracts:** `metric_values_store.go` (`MetricCoverage` /
  `metricValueFreshCond` becomes ONE builder parameterized by axis — fresh
  count, canonical read and sweep selection must take the same builder),
  touched-set column (DDL, rides the wipe), stub seed rows + edit-push
  plumbing (`analyticservice`/`metricservice`), the `02 §5B` map
  test-pinned to schema.
- **Deps:** B2 (`tablesOf`). **Unlocks:** the precision win; honest
  rule-edit propagation; closes `03 §9`'s blanket-lift deferral.
- **Verification:** **behavior pins** — a fact-only metric does NOT go
  behind on a rule bump; an analysis-touched metric goes behind exactly as
  today; editing a rule value bumps the stub ⇒ dependents recalc via
  cascade (new pin); five states untouched (`metricstate.js` five words, no
  new state); the `02 §5B` classification pinned (incl. the five tables
  with match-stamp-only freshness, finding 2); `player_ticks` has no rules
  axis (finding 3).
- **Retirement:** the blanket-axis behavior retires here (ruling 5).

**B5 · Round-grain materialization (grain furniture + `metric<rows>`)**
*(03 §1.3/§4.2 + 04 §7 ruling — ONE sequencing item for the same six rows)*
- **Goal:** where a per-round value row lands: extend the `metric_values`
  storage key for round grain, ship `kind:"rows"` validation (the slot
  `03 §4.2` reserved), and seed the **six A-class round-grain metrics** the
  owner ruled to relocate (ruling 2: M19 EconCurve, M22 CT/T deaths, M30
  utility damage, M31 blind ms, M36 money mean, M37 CompareRounds
  nades/dmg/flash). This single wave serves both the six parity rows and
  the six relocations because they are the *same six* (`04 §7`).
- **Files/contracts:** `schema.sql` (`metric_values` key change + seed
  rows), rule-2 `rows` validation (keys unique at round grain),
  materialization + read paths (`GetMetricValuesForMatch` family),
  `fixtures_test.go` new hand-computed value+N gates for the six seeds.
- **Deps:** B3 (`metrics.shape` / rows slot); A-spine need not be complete
  (the six seeds reference no dropped stamps) but must be integrated
  before the wipe so one diff covers everything. **Unlocks:** D2's parity
  closure for those six rows; retirement of the six view folds (econ.js,
  Economy/Utility/RoundDetail/CompareRounds folds) at D4.
- **Decide-during-execution (lead):** the exact storage key (round column
  in the PK vs a sibling table) — constraint: rides the wipe,
  unique-at-grain validated, `03 §1.3`'s N unaffected (rule 3's ladder
  already passes both readings). Not an owner question: the *what* is ruled
  (round-grain statistics ARE metrics).
- **Verification:** rows-kind refusal pins (duplicate round key, wrong
  columns); **value parity against the retired folds** computed over the
  same corpus (the six numbers must equal today's view arithmetic —
  no-exceptions bar); new seed value+N gates; dash-on-absent-row honesty
  (no side sample ⇒ row absence ⇒ dash, never 0 — `04 §3` M22/M36).
- **Guide/retirement:** the six metrics become user-visible definitions —
  guide touch in-wave (docslockstep); oracles for the six folds are
  rewritten in this wave; the view folds themselves retire at D4 (they
  still render until then).

### Track C — editor (frontend)

**C1 · Expression editor** *(03 §8 §10.5, §10.6 — after B2–B4)*
- **Goal:** the editor surfaces the gate: debounced live check runs the
  full raw-SQL gate (classify → rules → probe) with
  `ExprError{Message,Pos}` positioning (statement-level for raw), refusal
  copy named by rule in domain language, SQL + sugar templates in the one
  textarea, the declared-N badge (`n_pool IS NOT NULL` ⇒ "declared pool:
  …" suffix on the Formula tooltip — provenance disclosure, no new
  state/pref), `denominator=''` display handling for raw metrics.
- **Files/contracts:** `Builder.svelte` (:806-833 live check, :1738-1746
  textarea, provenance panel), `services.js`, strings catalog, guide
  (badge section).
- **Deps:** B2, B3, B4 (nothing to surface before the rules exist).
  **Unlocks:** user-facing SQL authoring complete.
- **Verification:** DOM tests (live check gates, templates, badge);
  `strings-audit.test.js` (tier lengths, verb hints, denylist) +
  `docslockstep` green in-wave; refusal copy review against AGENTS
  domain-language rules.
- **Decide-during-execution (lead):** `denominator=''` display
  implications for raw metrics (`03 §9` deferral) — N carries pool
  disclosure meanwhile.
- **Retirement:** none (additive surface).

### Track D — components and layouts (04, frontend, parallel to backend)

**D1 · Component catalog** *(04 §1, §2, §2.5 — after B3)*
- **Goal:** the grammar (definitions/instances/layouts, multi-metric slots
  — **juxtapose-never-derive**, ruling noted at `05 §1.3`), renderer
  registry (`number-cell/identity-card/table/chart/strip/fact-list/
  sequence/controls`), component runtime input reads, save-time contract
  refusal, load-time stale-ref placeholder, honest-state definition
  behaviors (`04 §2.6`).
- **Files/contracts:** `frontend/src/lib/components/*` (new
  registry/runtime), grammar parser, refusal + placeholder + behavior
  pins; definition catalog home — **decide-during-execution (lead)** at
  this wave, recommendation `04 §8` (built-ins code/seed like metrics;
  user instances in kvstore).
- **Deps:** B3 (binding vocabulary keyed to `metrics.shape`). **Unlocks:**
  D2.
- **Verification:** unit + jsdom pins — grammar parse; wrong-shape binding
  and wrong-typed-param refusals at save; stale-ref placeholder
  (drop-never-migrate); the five-state/empty-pool/0-beside-N behavior
  table (`04 §2.6`) exercised against stored reads.
- **Guide/retirement:** new user-visible surfaces ⇒ guide section (or
  placeholder) in-wave; no retirement.

**D2 · Default layouts and parity** *(04 §3, §8 — after D1 + B5)*
- **Goal:** the shipped Match/Profile/Reports default layouts are
  component compositions covering all 55 parity rows; the six relocated
  rows bind their round-grain metrics; **the parity-characterization pin
  lands FIRST** (render shipped default layouts, compare cells + state
  words against today's views — `04 §8`), then views migrate row-group by
  row-group.
- **Files/contracts:** shipped built-in layouts (default-by-name),
  `Match.svelte`/`PlayerProfile.svelte`/`Reports.svelte` stat surfaces,
  `MetricOrderDialog` successor boundary (retirement lands in D3), the
  raw-default-scoreboard-sort elimination (`05 §0` O7 — this file, not
  S1), parity pin file.
- **Deps:** D1, B5 (six rows need `metric<rows>` targets — `04 §8`
  falsification 3). **Unlocks:** the acceptance bar (§1) can be evaluated;
  D3/D4.
- **Verification:** **the parity-characterization pin** (cells + state
  words vs baseline renders; every state word of the five-state
  vocabulary parity, dash-on-empty, no fabricated zeros) — this pin *is*
  the PARITY gate (§6); layout absent⇒default/present⇒verbatim + Reset
  tests (incl. transpose-not-reset, `04 §5`); M08/M16/M20 honesty pins;
  guide sections for new surfaces in-wave.
- **Retirement:** the raw default scoreboard sort retires here (O7).

**D3 · Layout config absorption** *(04 §5 — after D2)*
- **Goal:** every pref family becomes layout-instance config in the
  kvstore (absorption map `04 §5` — the checklist; semantics preserved:
  absent ⇒ default-by-name, present ⇒ verbatim, dated caveat retained and
  stated in the guide); Reset deletes keys (never writes a default
  literal); `spectra:pinned-*` localStorage keys retired;
  `MetricOrderDialog` retires into the layout editor;
  `webstorage.test.js` PREF_SITES entries removed **with a dated comment,
  replacement existing first** — the scan stays and gets stronger.
- **Files/contracts:** `prefs.go` (layout keys registered,
  frontend-written), `metricorder.js` readers/writers,
  `Builder.svelte`/`Match.svelte`/`PlayerProfile.svelte` sites,
  `webstorage.test.js`, Reset writer.
- **Deps:** D2. **Unlocks:** pref sprawl ends; S1's frontend pref-reader
  retirements.
- **Verification:** absent/present/Reset semantics tests (per key family);
  `webstorage.test.js` green with the two entries removed + dated comment;
  no reader remains for the retired keys (grep); guide note on the
  retained dated caveat (`04 §5`).
- **Retirement:** pref readers, `MetricOrderDialog`, the two localStorage
  pin writers — all in this wave.

**D4 · View boundary enforcement** *(04 §6 — after D2/D3 + B5)*
- **Goal:** "views contain zero statistics logic" becomes mechanical: the
  **computation-scan pin** in `04 §6`'s shape — raw-read denylist over
  `lib/views/**` (fetch only through the component runtime), fold-pattern
  scan (`.reduce(`, row-accumulating loops, `Math.max/min` over
  fetched-row identifiers) with a sanctioned-site set **each carrying a
  `why`**, and the computation-module ban (`lib/econ.js` formulas retire
  into metric definitions — possible only because B5 seeded them);
  renderer registry is the positive half (no renderer folds).
- **Files/contracts:** the pin test (pattern list = implementation detail
  of this wave, `04 §8`), `econ.js` retirement, remaining view folds,
  Library audit decision — **decide-during-execution (lead)**: baseline
  never audited `Library.svelte` (`04 §8`); out of parity scope unless the
  pin flags it.
- **Deps:** D2, D3, B5. **Unlocks:** the boundary claim; the AUDIT gate
  (§6).
- **Verification:** the computation scan itself (fails on any new view
  fold or raw read outside sanction); `econ.js` gone with its formulas
  living as metric definitions (cross-checked by B5's parity gates);
  docslockstep.
- **Retirement:** `econ.js` and the remaining view folds — in this wave.

---

## 6. The gates

### GREEN gate — before any wave is "done"

The standing battery (§3) runs green on the wave's tree: `make fmt vet
test lint`, `make build`, frontend build + unit tests + jsdom harnesses +
liveness driver, `strings-audit` + `docslockstep`, golden acceptance for
A1/A3/A5. Plus the wave's own falsifiable verification from §5. A wave
whose check in `05 §3`'s table is missing is not sequenced — it does not
start (characterization pins B1 and D2 are written first, in-wave).

### OWNER gate — the one wipe (the hard gate)

**Boxed owner obligation (§9): this gate is run by the owner, never by the
executing session.**

**Precondition:** every wave in `05 §2.1` is GREEN — A1, A2, A3, A4,
A5, B1, B2, B3, B4, B5, S1 (row 5 of that table — 02 W6's already-committed
drops — is enumeration only, no action). **C1 and D1–D4 do NOT gate this
list** (schema-free; they may land before or after).

**Choreography, in order** (`05 §2.2`, verbatim commands):

1. **Snapshot first:** `sqlite3 "<live-db>" ".backup /tmp/opencode/pre-wipe.db"`
   — the pre-migration snapshot, the **sanctioned comparison instrument
   for the whole program** (ruling 1). Do not skip; do not wipe first.
2. **Owner runs** `make deep-clean CONFIRM=1` (refuses while `spectra`
   runs; wipes the XDG data+config+cache dirs — `01 B5`).
3. **Full re-import** of the library (every demo: parse incl. A1's tick
   sink → analyze → metric sweep).
4. **Values+N diff keyed on `matches.sha256`** (autoincrement ids differ
   across DBs): per match, join snapshot ↔ new DB on `(metric name,
   subject_key, dim)` comparing **`value` AND `n`**.
   - Expected: **byte-identical for every pre-existing seed** — the two
     rewritten gates are exact (side is a per-round constant, `02 §2.5`),
     `capped_dmg` untouched, B1/B4 change text/axes not values.
   - The new surfaces (tick-sourced metrics, weapon-fire-derived rows, the
     six A-class round-grain seeds, stub rows) appear **only as ADDED
     metric rows, never changed ones** (`02 W10.3`).
   - **Any changed row = a bug** — fix the metric until it matches
     (no-exceptions bar, §1). The snapshot remains the instrument; a
     second wipe is an owner decision, never a workaround.

**After the gate:** the engine-emulation criterion (ruling 3) governs every
future stamp question — no re-argument of cases.

### PARITY gate — D2's characterization pin = the acceptance bar

The program does not close until the parity-characterization pin (D2)
passes: every state word of the five-state vocabulary, dash-on-empty, no
fabricated zeros, all 55 rows expressible — an end user cannot tell a
dogfooded component from a bespoke one (§1). Any state-word or cell diff
falsifies it.

### AUDIT gate — the final audit (post-D4)

From `05 §4`: for every sweep-table row — prove-zero-readers (no non-test
reference; `go vet`/golangci green), tests updated or item deleted, guide
updated if user-visible; schema rows confirmed at the wipe
(`TestDroppedEventStampColumnsGone` for dropped columns; kept index
present). Schema items ride the wipe; code items ride their wave. Plus the
docs/lockstep sweep. This is the plan's last gate.

---

## 7. Integration-order notes (parallel worktree tracks — `05 §1.2`)

Tracks run **A-spine ∥ B-spine ∥ D-track ∥ S1**, under five rules:

1. **B1 before A3.** B1's single-field normalization re-pins the seed-expr
   fixtures once; A3 then rewrites its three seeds and re-pins their
   expansions. (Reverse order = two overlapping fixture re-pins.)
2. **A1 before B2's pins are asserted by hand** — B2's allowlist/view set
   must *derive* from `sources` (`05 §0` O9), so ordering is safe either
   way; if a hard count ever appears, integrate A1 first.
3. **A3 before or with B2 for `metric-language.js`** — A3 edits the column
   list (`metric-language.js:110-114`), B2 rewrites the chapter; if B2
   lands first, A3's edit applies to the rewritten chapter (or is
   re-expressed there). Coordinate in the merge, never silently drop.
4. **Shared files, distinct regions:** `schema.sql` (A:
   player_ticks/drops/seeds · B: shape/n_pool/views · B5: `metric_values`
   key), `fixtures_test.go` (A3 expr pins vs B1 normalization — see rule 1),
   `whitelist.go` (A1 admission only; B derives).
5. **A1 and A5 serialize against any other extract/golden-touching wave**
   (both touch `internal/extract` handlers and the golden fixtures).

Also: **D1 may start as soon as B3 lands** (its binding vocabulary is
keyed to `metrics.shape`, `04 §2.1`); grammar/parser work is frontend-only
and can be drafted earlier but cannot close a contract test before B3.

If a merge conflict or an inconsistency between sub-docs surfaces: the
rulings (§2) win, `05 §0` holds the nine settled overrides — **the lead
reconciles, annotates the sub-doc, and updates `05 §0`; never resolve it
silently in a commit.**

---

## 8. Open items — every open row, with its decider

Only **queued-to-wave** and **decide-during-execution** rows appear; every
`05 §5` row marked *resolved-by* is settled (by a ruling or a sub-doc) and
does not reappear. Full dispositions live in `05 §5`.

### Queued / decide-during-execution

| # | Item | Wave | Disposition / decider |
|---|---|---|---|
| 1 | attacker_inair read-path switch (store-side LEFT JOIN vs sidecar read) | A3 | **decide lead** — default **store-side join** (DTO contract unchanged, one read path); sidecar option equally honest and recorded |
| 2 | `weapon_fire` feed double-surface check (flagged M) | A5 | queued — verify `feed.js` FEED_SOURCES kind list |
| 3 | `SaveExtracted` wall-clock for a golden-sized match | A1 | queued — measure at execution; sizes busy-timeout headroom |
| 4 | Win-percentage fold live/dead | S1 | re-verify at execution (`02 W9` instructs it) |
| 5 | `internal/spatial/series.go` unused reader | S1 | prove-zero-readers first; if genuinely called → **owner** (delete-ordered vs consumed) — non-blocking micro-decision; do not delete blind |
| 6 | Two unconsumed team aggregates | S1 | re-verify at execution |
| 7 | Save-time probe cost budget | B2 | queued — measure; row cap + timeout already bound it |
| 8 | Joined-secondary population divergence | B2 | queued — arbiter `join_test.go` / `TestJoinedPopulationAlignment` |
| 9 | Fetch truncation parity audit | B2 | queued — rule: truncated ⇒ failure, never capped N |
| 10 | Round-grain storage key (round column in PK vs sibling table) | B5 | **decide lead** — constraint: rides the wipe, unique-at-grain validated, `03 §1.3`'s N unaffected; the *what* is ruled (ruling 2) |
| 11 | `denominator=''` display for raw metrics | C1 | **decide lead** — N carries pool disclosure meanwhile |
| 12 | Component definition catalog home (code vs seeded table) | D1 | **decide lead** — recommendation `04 §8` (built-ins code/seed; user instances kvstore) |
| 13 | Exact computation-scan pattern list | D4 | queued — shape fixed by `04 §6` (scan + sanctioned sites + `why`); patterns are implementation |
| 14 | `Library.svelte` audit (baseline never audited) | D4 | **decide lead** — out of parity scope unless the pin flags it |
| 15 | Parameterized metric materialization vs read-time execution | v1 default | **decide lead** on any deviation — v1 adopts `04 §4`'s **axis-selection only**; no param axis on `metric_values` until measured need (owner input only if execution wants to deviate) |
| 16 | N semantics for tick sources with NULL (structural `COUNT(*)` vs `COUNT(col)`) | first speed/NULL-pool seed | **decide lead** — **no such seed ships in this program**; default = ladder row 2 (structural `COUNT(*)`) with the `n_pool` override available |
| 17 | Per-detector conversions (third-category fate, per detector) | none forced | **decide lead** — proof standard = equivalence gate; no wave forces them (ruling 5 sets the stub model) |
| 18 | M23 loss-bonus pips (display format vs statistic) | any time | **decide owner, NON-BLOCKING** — ships as a display format; either disposition leaves the view fold; no wave waits on it |

### External gates (never guessed — AGENTS domain rule)

- **`speed` definition sourcing** (horizontal vs 3-D, units;
  counter-strafing threshold): CS2.md/web lookup at implementation time,
  **before any speed-consuming metric** — the substrate lands in this
  program (A1/A5), the metrics ride later and are gated here.
- **Git LFS:** `git lfs pull` before golden acceptance runs.

### Future triggers — not queued, no wave waits

- Covering index / `WITHOUT ROWID` adoption — implementer, on measured
  sweep pain (free-later index / wipe-ride table option), post-wipe.
- Density rate as a sink parameter — revisit if disk binds (measured
  13–17 GB/100 matches); re-import-only.
- `yaw`/`pitch` columns, velocity vector, armor/inventory columns —
  revisit on a concrete metric; future wipe, deliberately not bundled.
- "Share layouts" durability tier — re-decide on the shareability signal;
  do not pre-build (`04 §5`).

---

## 9. Owner obligations (callouts at the waves they gate)

1. **The wipe (the OWNER gate, §6)** — fires when `05 §2.1`'s list
   {A1–A5, B1–B5, S1} is green. Owner runs snapshot → `deep-clean` → full
   re-import → values+N diff. The plan **stops at the gate** until it
   completes and the diff is clean. A second wipe is an owner decision,
   never a workaround.
2. **GUI smoke — on request only, never by default** (AGENTS: parallel
   agents, focus stealing; solo pass only, X11 + xdotool per AGENTS). The
   parity pin (D2) and the computation scan (D4) are the mechanical
   stand-ins; live-app checks are the owner's call.
3. **Non-blocking micro-decisions** if/when they surface: M23 pips (row
   18); the spatial-series reader if the sweep proves it live (row 5).
   Neither blocks any wave.
4. **Rulings (§2) are delivered — cite, never re-ask.** The planning phase
   raised zero owner questions beyond them (`05 §6`).

**Machine/time disclosure:** the wipe + re-import is wall-clock on the
owner's machine; re-import includes A1's measured 9–22 s/match tick insert
— disclosed, honest.

---

## 10. Recovery notes — what to do when a gate fails (`05 §7.3`)

- **Characterization pin fails after a language wave (B1 byte-stability,
  D2 parity):** the tripwire fired — bisect the emission/render change;
  never re-pin fixtures to match new output without an explained diff
  (AGENTS golden/fixture rule: a fixture diff without justification is a
  rejected change).
- **Equivalence gate fails (value or N diverges):** fix the metric until
  it matches (no-exceptions bar). Do not adjust `wantValues`/`wantN` to the
  new number; do not re-argue the ruling that produced the rewrite.
- **Owner-gate diff shows a changed row:** treat as a bug in the bundle —
  identify the wave by the metric's touched tables, fix, re-run the diff
  against the **same snapshot**. A second wipe is an owner decision, never
  a workaround.
- **Golden fixture diff appears in a non-golden wave:** an extract change
  leaked — either it belongs to A1/A3/A5 (move it there) or it is
  unintended.
- **DOM/driver count pin fails:** only a dated, reasoned re-pin if the
  change is deliberate; otherwise treat as a regression.
- **A wave cannot reach green within its budget:** stop, leave the tree
  exactly as-is, report completed vs not-done vs skipped-with-reason (the
  wrap rule, §3), and hand the failing gate to the next session — a partial
  plan executed honestly beats a green-looking lie.
- **A new conflict between sub-docs surfaces at execution:** the lead
  reconciles (rulings section wins), annotates the sub-doc, and updates
  `05 §0` — never resolve it silently in a commit.
