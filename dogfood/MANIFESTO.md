# FACTS & QUERIES — the next foundation

**Status:** DIRECTION, committed by the owner (2026-11-18) — "I think I want to commit to this direction once my token limit refreshes." This document preserves the direction; execution begins in a later session. **NOT enqueued, no work started.**
**Stand-alone by design** — it states the direction on its own terms and cites no other documents.
**Tracked** (lives under `dogfood/` with the rest of the planning artifacts).
**Rename at will** — the filename is a placeholder for the direction, not a commitment.

---

## 1. The direction — three layers

**Parsing produces complete per-tick state rows as the fact substrate — every future fact is a join against them, not a new extract stamp. Statistics are written as queries (SQL) over those facts, wrapped in the metrics system's furniture (subject / scope / denominator / format) and an honesty contract enforced on the query's OUTPUT rather than its syntax — a blacklist model, not a whitelist. Presentation is a catalog of COMPONENTS — defined in their own grammar, no GUI builder required — whose instances bind metrics, records and control state into layouts; a component can render as anything from a single number to a table panel to a filter dropdown. Views contain zero statistics logic, and the entire match/profile surface is dogfooded configuration.**

The stack, top to bottom:

```
layouts      views = compositions of component instances (user-customizable)
  ↑
components   own grammar (no GUI builder); define LOOK + INPUT CONTRACT + CONTROLS; instances bind data and parameters
  ↑
metrics      typed outputs (scalar | identity | rows) + formula/N/freshness
  ↑
facts        tick-state rows, events, rounds, per-match columns
```

The motivation is the one that killed the whitelist: **grammar demand is unbound.** Every new statistic shape under the whitelist costs a compiler project (L-sized: constructs, refusal matrices, N semantics), and there is always another shape coming. This direction moves the recurring cost from the *unbound semantic layer* to the *bounded storage layer* — new statistics become "is the fact in a table? then it's one query," and new surfaces become "is there a component? then it's one instance." Tables, grains and component types are physical, finite, build-once things. That is a cost you can plan around, and it is why this is framed as solving the problem **permanently** rather than until the next capability.

---

## 2. Pillar 1 — tick-state facts

**What:** the demo parse's output grows a per-tick state table: one row per (match, tick, player) carrying the observable state — position, velocity, on-ground/in-air, alive, health, money, weapon, view angles, controller identity — alongside the existing event rows, round rows and per-match facts.

**Why it is the right fact foundation:**

- **It kills the stamp treadmill.** The last two years of extract work were stamp-per-feature: `same_side`, `capped_dmg`, `attacker_inair`, and queued `speed`/`in_air` — each a new column, a new wipe, a new extract site. With tick facts those become **joins against facts**, not schema changes. New features stop being migrations.
- **It unlocks the forward inputs** (owner, 2026-11-18): *shots fired*, *movement speed*, *in air* must become addressable in metric expressions — enabling future metrics like **proper counter-strafing** (stated rationale: moving above a certain speed makes shots inaccurate in CS2; being in air has a similar effect — to be sourced from official documentation and community wikis before implementation, never guessed), **hit rate** (hits ÷ shots fired), and **headshot rate** (percent of total *shots* that were headshots — explicitly NOT headshot-kills ÷ shots). Availability status as of `110d16e`: `player_stats.shots` is recorded, whitelisted and seeded (match-grain hit rate is expressible today); `damage.hitgroup` is whitelisted (head hits exist); movement speed and per-tick in-air are NOT stored (sidecar-only — the kill-scoped `attacker_inair` cannot serve); `weapon_fire` exists only in `generic_events` (unwhitelisted). Tick facts resolve all of these as joins.
- **The data already exists** — the replay sidecar stores per-frame position/state for every match in an unqueryable binary format. This promotes a derived slice of it into SQL. Open design: whether sidecar and the SQL table converge or stay separate consumers of one parse.

**Costs to respect (design, not blockers):**

- Ingest time and DB size: full-rate player-ticks ≈ 1–2M rows per match — likely a **derived-features-at-a-sane-tick-rate** table (speed, on-ground, alive, weapon, controller) rather than literal complete state; density is an open design question.
- Single-writer SQLite; the library DB is precious (the owner already owes one wipe — this rides it, but a second schema break later is what the bundle discipline exists to avoid).
- The sidecar remains the replay renderer's source unless convergence is chosen.

---

## 3. Pillar 2 — SQL as the metrics definition language

**What changes:** the expression grammar inside `internal/metrics` becomes SQL (with the grammar preserved as **sugar**). **What does NOT change:** the metrics *system* — `metric_values` materialization, freshness/behind/five-state machinery, metric ordering, economy placement, report appendices, Formula tooltips, the equivalence gates, the subject/scope/denominator/format furniture. The system and the language are orthogonal; only the language layer is swapped.

**The sugar layer:**

- Every existing construct compiles to SQL today — so this is a refactor of the compiler's IR, not a rewrite. All built-in seeds and saved user metrics keep parsing exactly as they do; sugar expands to SQL and **the expanded SQL becomes the stored canonical formula** (two spellings of one query dedupe — the one-canonical-way rule gets *stronger*).
- **Built-ins are always authored in sugar** — the guarded dialect with auto-derived N — then proven against golden fixtures. The tests are the backstop, not the only line: we never author a built-in as raw SQL with a hand-declared N, because the sugar path is strictly easier.
- New constructs become **optional sugar on a convenience backlog** — ergonomics, never a capability gate again.

**What users see:** the expression editor grows SQL-shaped (with templates and the furniture intact); the read-only SQL console's proven safety gate becomes the metrics' safety gate. "Look and feel" survives through sugar + the furniture; the ceiling story inverts — sugar is a backlog item, not a permission.

---

## 4. Pillar 3 — components and layouts

**What:** presentation inverts. Instead of a metric saying "render me like this," a **component** defines how it looks and what data feeds it; a **component instance** = `{definition, bound metric(s)/record source, parameters, options}`; a **layout** = an ordered arrangement of instances (the Match view, the Profile view, a report section). Component definitions have **their own grammar** — authored as text, no GUI builder required (the same posture as metric expressions). The metric declares only its output *shape* (rule 2 — already mandatory); shape decides which component *can* bind it; the instance decides *which* metric.

**Components include controls, not just displays.** A component can render as anything from a single number to a table panel to a **filter dropdown**; control components (dropdowns, toggles, multi-selects) produce **parameters** that sibling components' bound metrics consume — a table metric with a round parameter, filtered by the layout's dropdown, is a prepared query with a bound value. A parameterized metric's contract (formula, N, freshness) evaluates per parameter binding; freshness itself is parameter-independent (it comes from the touched tables). Control state is view-local working state — never a second source of truth — while layouts themselves are durable.

**The metric output kinds** (the shape vocabulary, shared with rule 2) — display components bind these; control components bind parameters instead:

| Kind | Output | Example | Renderer |
|---|---|---|---|
| scalar | one number | ADR 91.5 (N=24) | number cell / StatCard |
| identity | key + caption | `top_fragger` → player key + "34 kills" | identity cell (name + tooltip) |
| rows | a table | round outcomes, economy panel, per-round money | table component (columns / grain / default sort) |

Identity is nearly a one-row table with a key column — the real surface is **scalar | table**.

**What it dissolves:**
- **100% dogfooding becomes literal:** the shipped Match/Profile views are default component-instance sets over the built-in metric catalog — the same catalog the user rebinds. "Our views" and "their customization" are one mechanism.
- **The ordering/placement pref sprawl ends:** every pref family (`metric_order_*`, `metric_hidden_*`, `metric_pins_overview`, `metric_economy`) becomes the storage of specific component instances (a "sequence" component's config). The ordering dialog becomes a component editor.
- **Reports unify with views:** report sections are components bound to metrics — export and UI render the same objects.
- **The boundary gets structural:** metrics are computed-with-contract (scalar **or** row-shaped); records are raw observation surfaces (the kill feed stays a record — it is not a statistic); components contain presentation only; views contain composition only. "Views may not compute" becomes a trivially enforceable pin: no arithmetic outside the component registry.
- **Future panels are cheap:** a new panel = a component instance bound to a metric, not a new view component plus a hand-rolled data path.

**Honest costs (none fatal):**
1. **Scope — three migrations, sequenced.** Components need typed outputs; typed outputs need the SQL direction; full power needs tick facts. "The entire match view dogfooded" means the **stat-bearing surfaces** (scoreboard, cards, tables, charts, reports) rebuild as component compositions; chrome, Replay (spatial/temporal) and editors stay views.
2. **Component-instance configs are durable user data** — layouts survive restarts (state placement: pref/DB) and must degrade honestly when a built-in's options change or a type retires. The no-versioning, drop-never-migrate, honest-fallback policy applies exactly as it does to metrics: stale refs render placeholders, never crash, never guess.
3. **Input contracts stay disciplined:** a component declares what it consumes (`metric<scalar>`, `metric<rows>`, `record<events>`…); binding outside the contract is a save-time refusal — the same five-rules gate, one level up. Options are presentation, never formulas; a computed thing is a metric.
4. **No GUI builder; grammar-defined components:** component definitions are text in the component grammar — instantiated, rebound and arranged by the user, with built-in definitions shipping first. *Type-level* authoring (users composing new component definitions in the grammar) is a natural later extension; the first version delivers unlimited customization over a bounded built-in set with no drag-and-drop builder anywhere.

**Sequencing:** pillar 3 rides or immediately follows the SQL jump (the shape declaration is already required by rule 2); the component grammar, the renderer registry and the first built-in definitions (display + control) are the first feature wave *after* the foundation lands.

## 5. The blacklist model — five rules (the honesty contract's new enforcement)

The whitelist policed **input syntax**; this model polices **output form** — a stronger place to stand, because output-form problems (fan-out joins, undeclared pools) are exactly the ones input syntax-checking could never predict.

1. **Table allowlist + safety gate.** Our tables only (tick facts included; no system tables), read-only connection, timeout, row cap. Non-negotiable, and proven: the SQL console already runs exactly this layer. (Safety, not honesty — a saved query must not take the app down.)
2. **Output-shape validation.** The query must deliver its *declared* shape: required columns present, **keys unique at the declared grain**, numeric values, an optional `value_key` column when the format is identity. Validate the result, not the syntax.
3. **N-derivability or N-declaration — the crux.** N is the pool a value is a summary of; it travels with every number (see §7). Every accepted query must either (a) yield N mechanically — companion `COUNT(*)` over the same row source, or the sugar's structural recipe — or (b) carry a **declared pool** whose table set is checked against the query's actual FROM and, where cheap, companion-counted. A query whose N can neither be derived nor declared is refused. The residual risk (a declaration that lies about its *filter*) is documented as power-user territory — the same responsibility users already carry for meaning.
4. **Subject × scope × partition validity matrix.** Pure furniture validation over metadata — unchanged from today.
5. **Freshness from the touched-table set.** Parse the FROM/JOINs, take the max known staleness — the existing behind/recompute machinery reads the same answer as it does today.

**What this concedes (honestly):** syntax-level refusals for *user-authored* metrics disappear. But they policed form, not meaning — a user can already write a valid, N-carrying, wrong metric today (wrong denominator choice, wrong `where`, avg-of-ratios vs ratio-of-averages — cases where even *we* needed owner rulings). Form-level errors for user metrics are re-caught at the output by rules 2 and 3.

**What is NOT conceded:** the safety layer, output-shape validation, N attached to every metric, and our own verification posture.

---

## 6. The honesty promise, restated under this direction

- **System-level (structural):** every metric carries formula + N + freshness, enforced by rules 3, 2 and 5. The honesty principle — every number discloses its formula, its pool and its freshness — governs *disclosure and provenance*; it never promised omniscience about the author's intent, and it survives the language swap intact.
- **Built-in values:** proven against golden fixtures by the equivalence gates — machinery that compares values and N and is entirely language-agnostic. Nothing about SQL weakens it.
- **User semantics:** the author's responsibility, exactly as it is today. "Promising that OUR metrics are honest is enough" (owner, 2026-11-18): users can already make bad metrics; the class of error the grammar blocked for them was form-level, and form is what rules 2/3 now guard.

---

## 7. What N is, and why rule 3 is the crux (stand-alone)

**N is the pool** — the set of rows a value is a summary of, and its size. ADR 91.5 over N = 24 rounds; win rate 62% over N = 50 matches; an identity metric over its candidate pool (empty pool → dash, never a fabricated 0). We care because:

1. **A number without its pool is an unfalsifiable claim** — the difference between a measurement and a number someone said.
2. **N is the tripwire for silent misreporting** — equivalence gates pin value AND N together (corpus pins like "N=8 per match", "0-beside-N"); wrong-filter and row-fan-out bugs show in N first while the value still looks plausible.
3. **N drives the honesty states** — empty pool → dash; zero is only honest as 0-beside-N; behind/failed key off whether a valid pool existed.
4. **Comparability** — trend, history and report comparisons are meaningless without knowing what each point was computed over.

Under the whitelist, the engine manufactured N for free because shapes were closed (every construct had a known recipe). Under SQL the pool isn't announced — hence rule 3. **The model lives or dies here:** if N survives for the shapes people actually ask for (ratios, rates, per-round aggregates, identities, percentiles), the contract survives intact and the rest is engineering. **Prototype rule 3 first** — that is the one thing to prove before committing the plan.

---

## 8. The boundary under this direction (status quo and what must change)

The three classes — facts, metrics, records — remain the philosophy, but the boundary becomes *mechanical* rather than doctrinal:

- **Facts = tables.** Tick rows, event rows, round rows, per-match columns, stamps. Declared grain per table. No interpretation in a fact.
- **Metrics = contract-bearing materialized queries.** Anything rendered as a statistic goes through `metric_values` with formula + N + freshness — written in sugar or SQL, gated by the five rules.
- **Records = row reads.** Tables, lists, series, grids, exports — displayed as what they are.
- **Components = presentation; layouts = composition.** A component instance binds declared inputs (metric or record) and holds options only; a view instantiates components and holds no statistics. The classes govern *data*; the component contract governs *rendering*.

**Status quo to preserve** (verified at the current baseline): the scoreboard's fixed block is Name/Team/Score; the Reports appendix's recorded offer is exactly the raw `score` column; the ratified exception list (playhead partials, `scoreThrough`, UI row counts, `score`, narrowed sort-on-raw, appendix records, raw event reads + one dated render-only exception for disconnect self-kills) — each with a written reason, closed to casual growth. **Cleanup that stands regardless of language:** the dead Go folds (a win-percentage fold the `win_pct` seed already owns, an unused spatial-series reader, two unconsumed team aggregates) get deleted; the raw default scoreboard sort gets eliminated.

**Open question — the third category.** Analysis-rule stored outputs (clutches, trade windows, eco classes) were the old plan's hardest problem. Under tick/event facts + SQL, some become queries; temporal detectors may stay in Go Compute for now. Design work, not a blocker: the boundary rule (rules-derived values are stored at analyze time, versioned) holds until a query provably replaces a detector.

**Enforcement adapts, doesn't die.** The class-provenance pins keep their role: the engine package remains the ONE place metric queries run (view-level arithmetic stays banned; only facts and contract-bearing queries produce rendered statistics). Pin B's allowlist just gains "user metrics run through the engine's gated path, never through views."

---

## 9. Migration shape (sketch — sequencing is later-session work)

Four tracks, all future work, none enqueued:

- **A — tick-state ingest** (the big one): the parse produces the tick table; density/derived-feature policy decided first; rides the eventual wipe.
- **B — SQL definition language behind the sugar**: engine IR swap; seeds unchanged; characterization pins keep every existing expression compiling; sugar's expanded SQL becomes the stored canonical formula.
- **C — the five rules + editor UX + docs**: output-shape validator, N derivation/declaration, safety gate reuse, the expression editor's SQL texture, and the docs rewrite (the operators/refusal tables become "expressions are SQL with sugar" + the five rules).
- **D — components and layouts** (after B): the component grammar and its parser, the renderer registry, the first built-in definitions (number, identity, table, sequence, chart, plus control components such as filter dropdowns), the Match/Profile default layouts, the ordering/placement surfaces reworked as component configurations, and the consolidation of the ordering/placement pref families into component-instance configs.

**Deliberately NOT done yet** (superseded from the old plan): the grammar-construct wave (mean-of-ratios, cumulative) largely evaporates — user-writable queries cover it; `partition='round'` may survive in reduced form as *materialization furniture* (where round-grain results land so ordering/UI read them like any other metric), not as expression power.

## 10. Open questions to design later

1. **Rule 3 prototype** — prove N derivation/declaration for ratios, rates, per-round aggregates, identities, percentiles. The gating question.
2. Tick-row density and derived-feature policy (complete state vs features-at-rate); sidecar/SQL convergence.
3. Third-category fate: which rule outputs become queries, which detectors stay in Compute.
4. Grain furniture for materialization (does a `round` dim survive; how are output keys declared and validated).
5. Editor UX and error copy for SQL + shape refusals; the docs/refusal-matrix test rewrite.
6. Declared-N governance (how the UI marks power-user metrics); dialect lock-in acceptance (SQLite-only — already true).
7. The sugar-vs-raw canonical form: what the Formula tooltip shows (source text vs expansion) and how dedupe reports equivalence.
8. **Component grammar + renderer contract** — the grammar's shape (definition syntax, parameter binding for controls, the standard for row components: columns / grain / default sort) and the input-contract refusal surface (`metric<scalar>`, `metric<rows>`, `record<…>`, control parameters).
9. **Config evolution for built-in component definitions** — honest degradation of stale instance configs (same drop-never-migrate policy as metrics).
10. **View-migration scope** — which Match/Profile surfaces become component compositions vs stay views (Replay, chrome, editors).

