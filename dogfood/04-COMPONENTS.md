# 04 · COMPONENTS — grammar, renderer registry, and the parity exercise

**Step 4 deliverable of `PLANNING.md`.** Contracts: `dogfood/MANIFESTO.md` §4
(Pillar 3) + §5 rule 2 (output-shape vocabulary) + §8 (boundary and the
ratified exception list), `dogfood/01-BASELINE.md` **Part C** (the parity seed —
every row of C6 dispositioned below), `dogfood/03-QUERIES.md` §4 (rule-2 shape
declaration) and §9 (owner rulings), `dogfood/PLANNING.md` owner rulings +
acceptance bar. Planning document only — no app code, no schema, no test.

**Status:** complete (sections 1–8). Citations are `file:line` reconciled at
worktree HEAD `3ba4a33`; baseline citations are carried from 01-BASELINE as
delivered (verified where marked). Confidence: **H** = read directly here ·
**M** = derived from adjacent code/docs · **flagged** = open question.

**Acceptance bar (PLANNING.md:45-53, verbatim intent):** everything currently
shown in the match and profile views must be expressible under the new
components system — an end user cannot tell a dogfooded component from a
bespoke one; characterization first, display parity pinned, honest states
intact (dash on empty pool, five metric states, no fabricated zeros).

**Headline verdict:** all 55 parity rows are expressible; no row is dropped.
The grammar needs three additions the parity exercise forced (§1.4: hybrid
record+metric columns, composite metric cells, chart/strip renderers — all
declared below). Six A-class rows (M19, M22, M30, M31, M36, M37) need owner
rulings — all recommend relocation to round-grain metrics, which is a
**sequencing dependency on 03-QUERIES' deferred §10.4 grain furniture**, not a
grammar gap (§7). One baseline claim is corrected with evidence (P07's
"raw ADR/KAST" are metric-backed — §7).

---

## 1. The component grammar

Posture (owner constraint, MANIFESTO.md:89): **no GUI builder.** Definitions
are authored as text — the same posture as metric expressions. Built-in
definitions ship first; users instantiate, rebind and arrange them; *type-level*
authoring (users writing new definitions) is a later extension and is out of
scope for parity.

### 1.1 What a definition declares

| Field | Meaning |
|---|---|
| `id` | stable domain name (`stat-cell`, `identity-card`, `data-table`, `filter-menu`, …). Never renamed casually — instances reference it. |
| `label` / `doc` | user-facing name and tooltip prose (domain language, tier rules apply at implementation). |
| `kind` | `display` \| `control` \| `sequence` — display renders data, control produces parameters, sequence orders instances. |
| `inputs` | **the input contract**: named slots, each declaring the set of shapes it accepts — `metric<scalar>` / `metric<identity>` / `metric<rows>` / `record<source>` / `param<name>` (MANIFESTO.md:88). A binding outside the set is a save-time refusal (§2.5). |
| `params` | (controls only) the parameters this definition **produces**: name, type (`enum` \| `bool` \| `int` \| `set`), option source (static list, or a declared domain source: "counted rounds", "metrics in sequence", "players in roster"), default. |
| `columns` | (row-bearing definitions) the **column role vocabulary** the instance's column list must draw from: `record-field` \| `metric` \| `identity` \| `composite` (§1.4). The definition declares the roles and their legality; the instance declares *which* columns. |
| `grain` / `default_sort` | (row-bearing) the key columns that identify a row, and the default sort. Sort/filter **state** is never stored here — it is view-local (§2.2). |
| `options` | **presentation-only schema**: typed options with defaults and allowed values (`show_n`, `unit`, `transpose`, `row_limit`, `remainder_line`, `empty_copy`, `hide_when_empty`, `hide_on_empty`, `unhideable`, …). **Never a formula** — a computed thing is a metric (MANIFESTO.md:88). An option may select *among* bound metrics or reshape display; it may not derive a number. |
| `render` | the renderer-registry key (§2.4). |
| `behaviors` | fixed honesty behaviors that are **not options** — the five-state cell, empty-pool ⇒ no card, dash-not-zero. Definitions ship these; no instance can disable them (§2.6). |

### 1.2 What an instance is

```
instance = {
  def:        <definition id>,
  bindings:   { <slot> → metric name | record source | param reference
                | { source: <metric>, with: { <param> → paramRef } } },   // §4
  columns:    [ … ]        // row-bearing only: which columns, from the role vocabulary
  parameters: { <name>: <initial value> }   // non-control instances: static defaults;
                                            // control instances: initial only — live value
                                            // is view-local working state (§4)
  options:    { … }        // presentation overrides over the definition's schema
}
```

A **layout** = an ordered list of instances for a scope (`match-overview`,
`match-scoreboard`, `profile-cards`, `economy-tab`, …), stored durably (§5).

**Multi-metric consumption is first-class** (owner, 2026-11-18): a definition
declares as many slots as it needs (K/D/A compounds, hybrid tables,
multi-series charts), each slot binds its own metric, and formula/N/state
evaluate **per binding** (§4) — a component consuming five metrics carries
five contracts. The boundary: a component may **juxtapose** bound metrics
(display side by side, align by grain, toggle among them via options) but may
**never derive a new number from them** — equip + cash is a metric (M19's
disposition is this rule applied); the component renders the metrics it is
given.
A view = a layout + navigation chrome; views hold no statistics (§6).

### 1.3 Worked definition sketches

Text format is illustrative (a declarative block; the real parser belongs to
execution), sufficient to prove the parity rows below could be written in it.

```
definition stat-cell {
  kind: display
  inputs   { value: metric<scalar> }
  options  { show_n: bool = true
             unit:   enum{plain,percent,ms,money} = plain
             chip:   enum{none,always,state} = state }   // state chip = five-state host
  behaviors { five_states, dash_on_nodata, zero_beside_n }   // not options
  render: number-cell
}

definition identity-card {
  kind: display
  inputs   { who: metric<identity> }        // key + caption (§2.3)
  options  { show_caption: bool = true
             drill: enum{none,round,player} = none }   // navigation action only
  behaviors { hide_on_empty_pool, hide_on_unresolvable_key, state_card }
  render: identity-card
}

definition data-table {
  kind: display
  inputs   { rows: metric<rows> | record<source> | metric<scalar>@partition }
  columns  [ { key, label, role: record-field|metric|identity|composite,
               fmt?, hideable?, sortable? } ]
  grain    [ <key columns> ]
  default_sort [ … ]                       // M13's seed lives here, e.g. kills DESC
  options  { transpose: bool = false       // M14; layout seeds it (§5)
             row_limit: int? = null        // M04 cap-200; remainder_line below
             remainder_line: bool = false  // honest hidden count
             empty_copy: enum{filtered,none} = filtered
             unhideable: [ 'Name' ] }      // M10: Name never hides
  render: table
}

definition filter-menu {                    // a control
  kind: control
  params   { filter: enum{…} | set{…} }     // produced parameter (§4)
  options  { source: <declared option source>
             allow_empty: bool = true }     // M25/M29: none-checked = no filter
  render: dropdown
}
```

Instance examples (scoreboard column set; economy card; a filtered table):

```
{ def: "data-table", columns: [
    {key:'@Name', role:'record-field', hideable:false},
    {key:'@Team', role:'record-field'},
    {key:'@Score', role:'record-field', fmt:'score'},      // M11 — sanctioned raw (§7)
    {key:'m:adr', role:'metric', binding:'metric:adr'},    // M12 — one per pin
    … ] ,
  grain:['steam_id'], default_sort:[{key:'m:kills',dir:'desc'}],
  options:{ transpose:false } }

{ def:"stat-cell", bindings:{value:"metric:pistol_hold"}, options:{} }   // M20 card

{ def:"data-table", inputs.rows ← { source:"record:engagements",
      with:{ kind:"param:combat-kind", round:"param:combat-round" } } }  // M24+M25
```

### 1.4 Grammar additions forced by the parity exercise

The exercise falsified the naive "one input, one shape" reading; three
constructs are added here (all presentation-level, none computes):

1. **Hybrid columns** — a row component's rows may come from a `record<…>`
   read while individual columns bind `metric`/`identity` values joined on the
   grain key (P07 history: record rows + stored-metric cells; P10 Profiles:
   player rows + metric cells; M09 roster). This is the component twin of
   03-QUERIES' rule-2 interlock: the metric slot still carries its own
   formula/N/freshness per cell.
2. **Composite cells** — one cell composed of N metric bindings rendered
   together (M09's K/D/A compound, P07's K/D/A triple). Composition is
   *juxtaposition with shared tooltip*, never arithmetic: each half keeps its
   own honest state; a missing half renders the dash (baseline C1.2
   `compoundTitle` Match.svelte:951 behavior becomes definition behavior).
3. **Chart and strip renderers** — `render: chart` (line/bar; binds
   `metric<rows>` or a record series) and `render: strip` (binds
   `record<rounds>`), so P02/M19/M30/M31 and M05 have targets. Charts inherit
   the same honesty behaviors (hide-when-no-drawable-data = definition
   behavior, not a user option).

None of the three is statistics logic; they are rendering shapes.

---

## 2. Output kinds + renderer registry

### 2.1 Kind vocabulary and who may bind it

The component-facing vocabulary is the manifesto's three kinds
(MANIFESTO.md:68-76), keyed to rule 2's `metrics.shape` declaration
(03-QUERIES §4.2):

| Kind | Declared by | Display components that may bind | Notes |
|---|---|---|---|
| `scalar` | `shape.kind='scalar'` (keys derived from furniture) | number-cell, stat-card, table **cell** (per grain key), chart point, sparkline, sequence entry | A partitioned scalar (side/map/weapon) reads as one row per dim — today's partitioned read (P04/P05/P06), not a new kind. |
| `identity` | `shape.kind='identity'` + `value_key` | identity-card, identity cell (table column) | key + caption; empty pool ⇒ **no row at all** ⇒ dash/no card (03-QUERIES §1.4 E4c; baseline A3) — never a fabricated identity. |
| `rows` | `shape.kind='rows'` (**reserved** at 03-QUERIES §4.2 — ships with §10.4 grain furniture) | table, chart, strip-over-metric | **Sequencing dependency:** parity rows M19/M22/M30/M31/M36/M37 bind `metric<rows>`; until §10.4 lands they have no target. Grammar covers them; storage does not (§7, §8). |

`fetch` (03-QUERIES' percentile kind) is an engine-internal N mechanism, not a
component-facing kind — percentile scalars surface as `scalar`.

Record reads (`record<…>`) are the fourth binding source and are **not**
metrics: tables, strips, fact-lists, feeds over `rounds`/`engagements`/
`clutches`/`utility`/`warnings`/`chat`/economy rows — displayed as what they
are (MANIFESTO.md:82, §8 records = row reads).

Control components bind no data shape; they bind/produce parameters (§4).

### 2.2 The row component contract

A row-bearing instance declares: **columns** (each with a role from §1.1's
vocabulary), **grain key**, **default sort**. Runtime sort clicks and filter
text are **view-local working state** — the state-placement rule (AGENTS
"State placement"): they never restore across sessions, never enter the
layout config, never become a second source of truth (contrast: M18's compare
selection is a link ⇒ route query, MANIFESTO/AGENTS state placement). Sort is
generic presentation machinery over declared columns (nulls-last multi-key
fold — M13), **not** a statistic; "views may not compute" does not forbid
sorting (§6).

### 2.3 Identity contract

An identity binding yields `key + caption` (03-QUERIES §1.4: winner key,
companion value, N = candidate pool). The cell resolves `key → name` through
the roster read (presentation resolution, bot rules untouched: event-shaped
reads keep names, roster reads filter — AGENTS bot exclusion). Resolution
failure ⇒ **no card / dash**, never a guessed name (baseline M08 Match.svelte:
1175/1180).

### 2.4 Renderer registry

Keys shape → renderer; the registry is the ONE place a rendering shape is
chosen (MANIFESTO.md:82: "no arithmetic outside the component registry" —
the registry is also where the no-computation rule is enforced by
construction: renderers format, they do not fold).

| `render` key | Accepts | Today's bespoke analog (parity target) |
|---|---|---|
| `number-cell` | `metric<scalar>` | scoreboard metric cells, StatCard tile, economy card, statline half |
| `identity-card` | `metric<identity>` | M08 overview cards |
| `table` | `metric<rows>` \| `record<…>` \| partitioned scalar (hybrid columns §1.4) | scoreboard, Rounds, economy rounds table, engagements, clutches, throw log, history, sides/maps/weapons, Profiles list |
| `chart` | `metric<rows>` \| record series | EconCurve, trend, damage/blind bars, sparkline |
| `strip` | `record<rounds>` | RoundStrip (M05) |
| `fact-list` | `record<match>` | Details key-facts (M34) |
| `sequence` | ordered instance refs | ordering-dialog successor (§5) |
| `dropdown` / `multiselect` / `toggle` / `token-field` / `picker` | parameters (controls) | FilterBar selects, won/lost toggles, TokenSelect, MatchPicker/PlayerPicker |

### 2.5 Contract violation = save-time refusal

Same posture as the five rules one level up (MANIFESTO.md:88): binding a
shape outside an input's accepted set (`metric<scalar>` into a `rows` slot,
`record<…>` into a metric slot, a parameter of the wrong type, a column role
the definition does not declare) is **refused at instance/layout save** with a
positioned, domain-language message — never a runtime surprise, never a
silent skip (the 03-QUERIES §4.3 lesson: today's offset mappers skip short
rows quietly; components refuse loudly). Two distinct failure modes, never
conflated:

- **Contract violation** → refusal at save (author error).
- **Stale reference at load** (metric renamed/deleted, definition retired) →
  **placeholder**, drop-never-migrate (§5): render a dash-with-note cell, drop
  the instance from the sequence by construction, never crash, never guess
  (MANIFESTO.md:87; precedent `parseStoredPins` metricorder.js:799-808).

### 2.6 Honest states are definition behaviors, not options

Every parity row's honesty requirement maps to a definition behavior the user
cannot switch off:

| Honesty behavior | Carrier | Parity rows |
|---|---|---|
| Five states (processing/failed/fresh/no-data/behind) + live progress chip | `behaviors { five_states }` on every metric-bound cell — reads `metricPresentation` (metricstate.js:46-61) and the progress feed, exactly today | M16 (all metric cells), M09, M12, M20, P01, P04–P07, P10, R03, R06 |
| Dash on empty pool / no row | `dash_on_nodata` (nodata kind — never 0) | M09, M20 (absent row; half-present team pair ⇒ dash), P04, P07, R03 |
| Empty identity pool ⇒ **no card**; unresolvable key ⇒ no card | `hide_on_empty_pool`, `hide_on_unresolvable_key` on identity-card | M08 |
| 0-beside-N (zero is only honest beside its pool) | metric contract (schema.sql:543-544) + `zero_beside_n` cell behavior; tooltip `n=` | M12, R06 |
| Honest hidden counts | `row_limit` + `remainder_line` (M04 cap 200 + remainder); sanctioned UI row counts (N-of-M) stay a row-count readout | M04, M29 |
| No drawable data ⇒ card hides entirely | `behaviors { hide_when_empty }` on chart definitions (presentation over absence, today Utility.svelte:493/612) | M30, M31 |
| Filter-aware empty copy | `empty_copy` option on record tables | M24, M26, M28 |
| State in title only / state ⇒ chip card | cell tooltip behavior + identity-card `state_card` | M08, M09, P07 |
| No tiles ⇒ no grid; no rows ⇒ no table | layout-level `hide_when_empty` on the sequence/table instance | P01, P04 |

---

## 3. THE PARITY EXERCISE

Every row of 01-BASELINE C6 (M01–M37, P01–P10, R01–R08 — 55 rows) gets
exactly one disposition:

- **(a)** component instance over a metric · **(b)** record-bound component ·
  **(c)** control component · **(d)** stays a view (reason) ·
  **(e)** needs owner ruling (recommendation given).

Citations in *Rendered in* / *data path* columns are the baseline's (reconciled
at `3ba4a33`); corrections are called out inline.

### Match — shared chrome

| # | item | disposition | target component/definition | notes (honest states!) |
|---|---|---|---|---|
| M01 | Team names + final score line | (d) stays view | — | Header chrome (spatial arrangement); data is a record read with no arithmetic. Score itself is a fact, `score` sanctioned (§7). |
| M02 | Map · duration · patch · StatusChip | (d) stays view | — | Match metadata chrome; StatusChip is the one status renderer (AGENTS). |
| M03 | Voice/encrypted-chat badge | (d) stays view | — | One boolean badge on the header; no statistic. |
| M04 | Warnings panel + remainder line | (b) record-bound | `data-table` over `record<warnings>` | `row_limit:200` + `remainder_line` ⇒ honest hidden count; loading chip = transient. |
| M05 | RoundStrip winner cells | (b) record-bound | `strip` over `record<rounds>` | Winner tint/arrow/separators = renderer presentation (RoundStrip.svelte:1-27); click emits a select action the view routes (composition, not statistics). **Overturns C7.8** (§6). |
| M06 | Tab bar | (d) stays view | — | Navigation chrome (router). |
| M07 | Loading / error | (d) stays view | — | Transient; never restores (state placement). |

### Match — Overview

| # | item | disposition | target component/definition | notes (honest states!) |
|---|---|---|---|---|
| M08 | Identity cards (default 5) | (a) over metric | `identity-card` × sequence over identity metrics (top_fragger, best_adr, most_util, entry_opens, most_mvps) | Empty pool ⇒ **no card**; unresolvable ⇒ no card; state ⇒ chip card with progress; number from stored row only. Identity kind, N = candidate pool (03-QUERIES §1.4). |
| M09 | Roster CT/T/Other: name + K/D/A + ADR chip | (b) record-bound, hybrid columns | `data-table` over roster record; columns: name (record), K/D/A (`composite` of 3 metric bindings), ADR (metric) | Dash on nodata per half (never a fabricated 0); state reaches the cell via title only (compoundTitle). Bot filter stays in the roster read (AGENTS). |

### Match — Scoreboard

| # | item | disposition | target component/definition | notes (honest states!) |
|---|---|---|---|---|
| M10 | Name / Team columns | (b) record-bound | scoreboard `data-table` fixed record columns | Name `unhideable` (definition); humans-only stays in the read. |
| M11 | Score column (raw) | (b) record-bound, **sanctioned** | same table, `record-field` role | `score` is on MANIFESTO §8's ratified list and carries the owner's no-seed ruling (metricorder.js:347-349). No ruling needed (§7). |
| M12 | Pinned metric columns (default 19) | (a) over metric | scoreboard column sequence: one `stat-cell`-column per pinned metric | shortName header, ⓘ = `doc`, value/`—`/state chip, tooltip `n=` — all cell behaviors. Column set = absorbed pref (§5). |
| M13 | Multi-key sort fold (seed kills DESC) | (d) stays view | — | Generic row-component sort over declared columns (§2.2); sort marks = view-local working state. No statistic. Seed re-spell becomes the instance's `default_sort`. |
| M14 | Transposed shape | (d) stays view | — | Shape toggle = view-local state; open-shape default = layout instance option seeded by the absorbed pref (§5). |
| M15 | Metric error banner | (d) stays view | — | Transient error state over the layout's read. |
| M16 | Five-state cells + live progress | (a) — cell behavior, not a separate instance | `behaviors { five_states }` on every metric-bound cell | **All five words are parity** (metricstate.js:30); live feed wins over refetch (liveMetricState). Cannot be disabled by an instance (§2.6). |

### Match — Rounds tab

| # | item | disposition | target component/definition | notes (honest states!) |
|---|---|---|---|---|
| M17 | Round rows (RD, Winner, Reason, Duration, Site, MVP, First blood, Kills) | (b) record-bound | `data-table` over `record<rounds>` | Dashes for absent fields; MVP/First blood are event-shaped reads — keep names (bot stance); winner-name parity presentation. |
| M18 | Compare checkbox (max 4) + hint + button | (c) control | `multiselect` over counted rounds → `param:rounds` → route `?rounds=` | Selection is a **link** ⇒ route query (state placement), not registry state. |

### Match — Economy tab

| # | item | disposition | target component/definition | notes (honest states!) |
|---|---|---|---|---|
| M19 | EconCurve (equip/net-worth toggle, winner strip, hover) | **(e) owner ruling** — recommend relocate | `chart` binding `metric<rows>` (round×side equip + net-worth series); toggle = chart option | Net worth = equip + cash is arithmetic (econ.js:33-39) ⇒ computed ⇒ metric (§7). Dependency: §10.4 rows kind + round grain. Absent round ⇒ gap in series, never interpolated. |
| M20 | Summary cards (default 6) + badges + drill | (a) over metric | `stat-cell`/team-pair cards via economy placement list (pistol_hold, team_force_wins, team_force_rounds, avg_equip_gap, lost_equip, team_lost_equip) | Absent row ⇒ dash; half-present team pair ⇒ dash; drill = navigation action only. Placement pref absorbed (§5). |
| M21 | Rounds econ table + why row + rule version | (b) record-bound | `data-table` over `record<economy>` (stored rule outputs) | Rule outputs are stored at analyze time (AGENTS) — read as rows; empty ⇒ empty copy. |
| M22 | CT/T Deaths per round | **(e) owner ruling** — recommend relocate | `table`/`chart` over a round-grain `metric<rows>` (deaths per side per round) | No side sample ⇒ dash, never 0 — carried by row absence. The Economy.svelte:76-89 criterion says metrics cannot express round grain *today* — that is §10.4's deferred furniture, not a permanent bar (§7). |
| M23 | Loss-bonus pips | (b) record-bound | economy table cell, `fmt:'loss-bonus-pips'` | The pip ladder is a **display format** over the recorded bonus (like percent scaling), one canonical home (econ.js `lossPips`); `$` in title. Flagged: if the owner reads "pips" as a statistic it becomes a metric — low-risk either way (§7 note). |

### Match — Combat tab

| # | item | disposition | target component/definition | notes (honest states!) |
|---|---|---|---|---|
| M24 | Engagements table | (b) record-bound | `data-table` over `record<engagements>` | Merge presentation-only; empty/error variants = `empty_copy`. |
| M25 | Kind multi-select + Round select | (c) control | `multiselect` (`param:combat-kind`) + `dropdown` over counted rounds (`param:combat-round`) | None-checked = **no filter** (param absent ⇒ unconstrained read). |
| M26 | Clutches table | (b) record-bound | `data-table` over `record<clutches>` | Filter-aware empty copy. |
| M27 | Won/Lost toggles | (c) control | `toggle` ×2 → `param:clutch-won`, `param:clutch-lost` | Both off ⇒ explicit empty text (empty_copy over an unconstrained-but-empty selection). |

### Match — Utility tab

| # | item | disposition | target component/definition | notes (honest states!) |
|---|---|---|---|---|
| M28 | Throw log rows | (b) record-bound | `data-table` over `record<utility>` | Zero-dash carve-outs = per-column `fmt` (presentation). |
| M29 | Kind/Thrower/Round filters + N-of-M | (c) control | three controls → `param:util-kind/thrower/round`; N-of-M = row-count readout | Options source = "rounds with throws only" (declared option source). N-of-M stays a sanctioned UI row count (MANIFESTO §8). |
| M30 | Damage-per-round bars | **(e) owner ruling** — recommend relocate | `chart` over round-grain `metric<rows>` (utility damage per side per round) | Hides when no drawable data (`hide_when_empty` behavior, Utility.svelte:293-298); computed badge retired (the metric carries Formula/N instead). |
| M31 | Blind-time bars | **(e) owner ruling** — recommend relocate | `chart` over round-grain `metric<rows>` (blind ms per side per round) | Same hide behavior; label honesty (not enemy-gated) moves into the metric's `doc`. |

### Match — Heatmaps

| # | item | disposition | target component/definition | notes (honest states!) |
|---|---|---|---|---|
| M32 | Heat raster + max/samples/grid readouts | (d) stays view | — | Spatial canvas (C7.2 confirmed); readouts are record metadata over the Go-computed raster, no statistic. Stale/pack notes stay chrome. |
| M33 | Kind/player/team/round-range/layer/region filters | (c) control | filter controls → params consumed by the heatmap read | Sanctioned replay-filter arrival path stays view routing. |

### Match — Details + drill-downs

| # | item | disposition | target component/definition | notes (honest states!) |
|---|---|---|---|---|
| M34 | Key facts dl + demo-copy state + Free | (b) record-bound | `fact-list` over `record<match>` | Copy states (copied/external/missing/—) = record-field formats. |
| M35 | Explorer diagnostics | (d) stays view | — | Technical diagnostics (C7.6 class). |
| M36 | RoundDetail: info, kills feed, bomb, economy card, chat | **(e) owner ruling** for the money mean; the rest (b) | composite drill layout: `fact-list` + `table` (feed/bomb/chat records) + economy `data-table` over `record<round-economy>`; money cell → round-grain `metric<rows>` | Money mean = `moneySampledSum/moneySamples` (RoundDetail.svelte:601) is arithmetic ⇒ metric (§7). No samples ⇒ dash carried by row absence; empties stay per-section. |
| M37 | CompareRounds: econ columns, utility summary, events | **(e) owner ruling** for the summary line; the rest (b) | column layout over record reads; summary cells → round-grain `metric<rows>` (nades/dmg/flash per round) | `utilSummary`'s reduce (CompareRounds.svelte:224-230) is arithmetic ⇒ relocate (§7). Missing-round cells ⇒ dash. |

### Profile

| # | item | disposition | target component/definition | notes (honest states!) |
|---|---|---|---|---|
| P01 | Career StatCard tiles (default 13) | (a) over metric | `stat-cell` sequence over career metrics | No tiles ⇒ no grid; five-state slot per tile; `wins` sub on the Matches tile is a **recorded fact** (class F), displayed as a fact — not arithmetic; careerError Retry = transient. |
| P02 | Trend sparkline + tooltips + min/max | (a) over metric | `chart`/`sparkline` binding the metric's stored series (`metric<rows>` over `metric_values`) | States error/only-one/no-trend = definition behaviors (no-trend ⇒ empty copy, never a fake slope). |
| P03 | Trend metric picker | (c) control | `dropdown` over the match-scope metric sequence → **binding selector** (`param:trend-metric` rebinds which metric the chart reads) | Falls back to `adr` (default in the option source). |
| P04 | Sides table | (a) over metric | `table` binding the partitioned scalar read (dim=side) | Per-cell five-state; empty ⇒ consults states (dash). |
| P05 | Maps table | (a) over metric | `table` over partition=map rows; row click → Library filter (navigation action) | A-sort = view-local sort state. |
| P06 | Weapons top-8 | (a) over metric | `table` over partition=weapon rows; `row_limit:8` + sort options | Cap/sort are presentation options; honesty untouched. |
| P07 | Match history rows (K/D/A, ADR, KAST%) | (b) record-bound, hybrid columns | `table` over `record<match-history>`; K/D/A = `composite` metric cell (K,D raw-record halves + A from `assists` seed), ADR/KAST = metric columns | **Baseline correction (H):** ADR/KAST are *not* raw stored columns — `GetPlayerHistory` fills them from the stored `adr`/`kast` seed rows via the series read, nil ⇒ honest dash (store/analytics.go:1169-1179, 1226-1283). The "raw fields" note in C6 P07 is frontend plumbing, not provenance. No ruling needed; columns become explicit metric bindings (§7). Empty ⇒ `noHistory`. |
| P08 | Player finder | (c) control | `picker` over `record<players>` → `param:player` (route) | Navigation target ⇒ route query. |
| P09 | Loading / profileError Retry | (d) stays view | — | Transient. |
| P10 | Profiles list ADR/Matches columns | (a) over metric | metric columns on the Profiles record list (list chrome stays view — C7.6) | Five-state cells; metric sort key = view-local. |

### Reports

| # | item | disposition | target component/definition | notes (honest states!) |
|---|---|---|---|---|
| R01 | Template grid | (d) stays view | — | Record list chrome of the consumption side; authoring (ReportsBuilder) stays out (C7.5). |
| R02 | Match target (MatchPicker) | (c) control | `picker` over `record<matches>` → `param:report-match` | "Embedded ⇒ fixed, no picker" = instance option (absent control ⇒ fixed target). |
| R03 | Player target + statline | (a) over metric (its picker is (c), P08-style) | statline = `stat-cell` row over stored seeds (kills/deaths/assists/adr/rounds_played), per half | Per-half dash + state title; identity of the picker feeds the binding's subject. |
| R04 | Round target (counted clamp) | (c) control | `dropdown`/`int` with option source "counted rounds" (clamp is the source's bound) | Never guesses an uncounted round. |
| R05 | Appendix token field (metrics + `raw:score`) | (c) control | `token-field` multi-select over `composedSequence` ∪ `{raw:score}` → `param:appendix-stats` | Universe = the sequence + exactly the one record offer (metricorder.js:451-458). |
| R06 | Per-stat readout: expr, rows chip / state chip / recorded chip | (a) over metric (raw:score leg = record cell) | one `stat-cell` per selected stat; Formula/N/state disclosure = metric contract | Loading `…`, "failed", "value not computed — <state>" = five-state vocabulary verbatim; recorded chip for `raw:score`. |
| R07 | Appendix export (md/html, sequence order, state copy) | (d) stays view | — | Export is a **renderer over the same component instances** (UI and export render one object — C3.4); it computes nothing. |
| R08 | Save + Generating… | (d) stays view | — | Transient job UI (StatusChip only). |

**Gaps:** none dropped. Rows with `(e)` are rulings, not grammar failures —
the grammar expresses all six via `metric<rows>` bindings; what is missing is
the storage/shape layer 03-QUERIES deferred to §10.4 (flagged in §8 as the
program's cross-step dependency). Heatmaps rows (M32/M33) and CompareRounds
(M37 columns) inherit the baseline's Med-confidence flags.

---

## 4. Controls → parameters

**Production.** A control instance declares `params` (name, type, option
source). Its **live value is view-local working state** — the viewstate
registry (`viewstate.svelte.js` `seed`/`remember`, the C5.4 keys:
`matchKey('combat')`, `matchKey('utility')`, `matchKey('heatmaps')`, flat
`reports`, `player`) — never a second source of truth, never restored by the
layout, never written into the layout config. The **layout is durable** (§5);
the control's current value is not. The state-placement exception applies
where the value *is or should be a link*: M18's compare rounds and P08's
player target go to the route query (`buildHash`), exactly as today.

**Consumption.** A sibling instance's binding may carry `with: { <param> →
paramRef }` (§1.3). Two consumption legs, distinguished honestly:

1. **Record reads (today's whole control surface).** The store read already
   takes bound values — `GetEngagements(kind, round)`,
   `queryEvents(round/kind/…)` (queries.go:994-1214), `GetUtility` filters.
   A filtered table = a prepared record query with a bound value: same
   posture, owned by the component runtime's input reader, not the view.
2. **Metrics (the forward case).** 03-QUERIES' parameter stance is binding:
   **stored metric SQL carries no free parameters** — the console's
   `HasParameters` refusal stays inverted only in the engine's favor (sugar
   plans keep engine-owned `?` binds; raw SQL is literals-only — 03-QUERIES
   §3.1, §2.1). Therefore a control parameter never reaches a metric by text
   substitution into the stored formula (that would break the single stored
   spelling and dedupe). The parameter resolves as one of:
   - **axis selection** (the common case): the parameter names a value on an
     axis the metric already materialized (round, side, weapon, subject,
     dim) ⇒ the component's read filters stored rows by the bound value.
     No recompute; the row's own formula/N travel with it.
   - **engine-bound read** (rare, forward): the compiled `Plan` executes on
     the read path with the bound arg — `RunReadOnly(plan.SQL, plan.Args)`
     already exists (preview.go:96) — bounded by row cap and timeout.

   **FLAGGED (owner/step-5):** whether parameterized metrics may *materialize*
   per binding (a param axis on `metric_values` — collides with the A4 PK and
   §10.4 grain furniture) or must always read-time execute. Recommendation:
   axis-selection only for v1 (everything in §3 needs it), engine-bound reads
   uncached until a measured need; materialization deferred with §10.4. This
   is the one parameter question the parity bar does **not** force.

**Per-binding contract.** Formula and N evaluate per binding (each binding's
plan passes the five rules at save — 03-QUERIES §9 decision 6's gate);
freshness is **parameter-independent** — it comes from the touched-table set
(MANIFESTO.md:66, rule 5), so one behind/failed/fresh word covers every
binding of a metric.

**C4 → control-component map (every current control):**

| Current control (baseline C4) | Control-component future |
|---|---|
| MetricOrderDialog (order/hidden/pins/economy/transpose/Reset) | Retires into the **layout/component editor** (a view-level editor over instances — not a data control; §5). |
| Builder list filters + `togglePin` (C4 Builder row) | Instance membership/sequence edits via the editor; Builder itself stays the metric-authoring power surface (C7.4). |
| Scoreboard sort clicks / transpose / shape | Row-component view-local state + instance option (M13/M14) — not controls. |
| Compare picker (M18) | `multiselect` control → route query. |
| Combat kind/round, won/lost (M25/M27) | `multiselect` + `dropdown` + `toggle` params. |
| Utility kind/thrower/round (M29) | three controls + sanctioned row-count readout. |
| Heatmaps toolbar (M33) | filter controls over the heatmap read. |
| Reports target/round/token filters (R02/R04/R05) | `picker` / clamped `int` / `token-field`. |
| Trend picker (P03) | `dropdown` binding selector. |
| EconCurve equip/net-worth toggle (M19) | chart **option** (presentation state of one instance), not a parameter — it picks which bound series shows. |
| MatchPicker / PlayerPicker / TokenSelect / SuggestInput | `picker`/`token-field` definitions; `SuggestInput` stays the shared primitive underneath (it is an input widget, not a stat control). |

---

## 5. Config storage + pref absorption

**Where instance configs live: the kvstore (prefs.json), not the DB.**
Rationale under the state-placement rule: layouts are installation-scoped
durable user configuration — the pref tier (survive a restart; not a link; not
shareable v1). Every absorbed pref already lives there with the exact
precedent components need: frontend-written, Go never consumes
(services.js:1204-1206), `AutoSave: true` durability (AGENTS Prefs), JSON
values, and a drop-never-migrate parse (`parseStoredPins`
metricorder.js:799-808). The DB is the single-writer library: layouts are not
library data, must not add write pressure or schema surface for UI config, and
a future "share layouts" feature can move them then (that *would* be a
shareability signal — re-decide at that point, do not pre-build it).
Layout keys are registered in `prefs.go` (frontend-written, Go never consumes).

**Exact absorption map** (semantics preserved unless stated):

| Pref / default (baseline) | Component-config equivalent | Semantics |
|---|---|---|
| `metric_order_match` (prefs.go:46) | scoreboard instance's column sequence (ordered metric-column instances) | absent ⇒ shipped default layout by name; present ⇒ verbatim |
| `metric_order_profile` ( :47 ) | profile card-block sequence instance | same |
| `metric_order_overview` ( :60 ) | overview row sequence | same |
| `metric_pins_overview` ( :61 ) | overview instance-set membership (which identity-card instances exist) | same |
| `metric_economy` ( :71 ) | Economy-tab layout list + its overview carve-out placement (two lists, one key family) | same; absent ⇒ `DEFAULT_ECONOMY` by name, present (even `[]`) ⇒ verbatim |
| `metric_hidden_match` / `metric_hidden_profile` ( :78-79 ) | per-instance `hidden` option in the sequence | same; Name exempt via the definition's `unhideable` (`HIDE_EXEMPT` metricorder.js:496 → definition vocabulary) |
| `scoreboard_starts_transposed` ( :91 ) | scoreboard instance open-shape option | strict-`true` reading preserved; **not touched by Reset** (today's behavior, MetricOrderDialog.svelte:532-544) |
| `spectra:pinned-metrics` (localStorage) | merged into the scoreboard layout config (column instance set) | absent ⇒ `DEFAULT_PINS.match` by name, present ⇒ verbatim — the rule moves intact; **the localStorage key is retired** (below) |
| `spectra:pinned-profile-metrics` (localStorage) | merged into the profile card-block layout config | same, key retired |
| `DEFAULT_RANKS` match/profile/overview (metricorder.js:172-231) | the shipped **built-in layouts** (seeded like built-in metrics; absence of a user layout ⇒ built-in by name) | default-by-name preserved |
| `FIXED_BLOCK`/`FIXED_RANKS` ( :355-409 ) | the scoreboard definition's declared fixed columns (Name/Team/Score; profile block empty) — definition-level, not user config | stays unpinnable/unhideable per `hideable()` |
| `DEFAULT_PINS` ( :264-317 ) | default instance sets inside the shipped layouts | by name |
| `DEFAULT_ECONOMY` ( :114-121 ) | default economy layout list | by name |
| `RAW_FIELDS` / `rawItems` = exactly `{Score}` ( :431-458 ) | the record-column offer vocabulary of the table definitions (`raw:score`) | post-unification offer set unchanged |
| `overviewDefs` (identity + economy carve-out, :482-487 ) | the shipped overview layout's composition | — |
| `loop_secs` (prefs.go:157) | **not absorbed** — replay-entry parameter, not stat display (baseline C5.1 note) | stays a plain pref |

**Absent ⇒ default-by-name / present ⇒ verbatim is preserved for every
absorbed key.** The dated caveat (a present key does not pick up
later-added defaults, metricorder.js:101-104) is **retained deliberately**
and now covers whole layouts: a user with a stored layout keeps it verbatim;
new shipped defaults reach them only via Reset. State this in the guide when
it ships (pre-release, no migration — owner's breakage-is-free ruling).

**Reset** (today's dialog Reset, MetricOrderDialog.svelte:338-365): deletes
the layout config keys (order/hidden/overview/pins/economy) ⇒ absence ⇒
shipped defaults return by name. `scoreboard_starts_transposed` stays out of
Reset, as today. Reset never writes a "default layout" literal — absence *is*
the default (one canonical way).

**Honest degradation (drop-never-migrate, MANIFESTO.md:87):** layout parse
mirrors `parseStoredPins`: unknown metric name ⇒ instance drops out of the
sequence by construction (no writer, no migration — the `raw:kda` precedent,
metricorder.js:425-432); unknown definition id ⇒ a placeholder cell (dash with
a "retired" note in the tooltip, never a crash, never a guessed render);
option values outside the schema ⇒ fall back to the definition default per
key. Nothing is versioned; nothing is rewritten.

**`webstorage.test.js` disposition:** the two pin keys move to the kvstore
⇒ their `PREF_SITES` entries (webstorage.test.js:27-38: Match.svelte,
Builder.svelte, PlayerProfile.svelte) are **removed with a dated comment
stating the reason** (pins relocate to durable layout config — the component
system's absorption, dogfood/04 §5); the test keeps its scan and its
theme/font-size exceptions, and thereby becomes *stronger*: any new
localStorage reference — including a future layout config written to the wrong
store — fails the suite. No pin is deleted without its replacement existing.

---

## 6. The boundary — views contain zero statistics logic

**Confirmations and overturns of C7's non-candidates:**

1. **Replay — stays view (confirm).** Spatial/temporal canvas (MANIFESTO.md:86);
   its HUD numbers are record reads, no folds.
2. **Heatmaps raster — stays view (confirm);** its filters/counter readouts
   become controls/records (M32/M33) as C7.2 itself anticipated.
3. **SqlConsole — stays view (confirm).** Power surface (AGENTS exemption).
4. **Builder editor — stays view (confirm).** Metric-authoring power surface;
   its pin toggles/filters become editor actions over instances (C4 map). The
   MetricOrderDialog retires into the layout/component editor.
5. **ReportsBuilder — stays view (confirm).** Authoring editor; the
   consumption side (R01–R08) is dispositioned above.
6. **Settings / Library / Explorer / CommandPalette / MapPackPrompt /
   DocsPopup — stay views (confirm).** Chrome and record lists; Library keeps
   its baseline "not audited" flag (01-BASELINE C7 note).
7. **Job/progress widgets — stay StatusChip-only (confirm, AGENTS).**
8. **RoundStrip — OVERTURN → record-bound component (M05).** It carries no
   arithmetic; its navigation coupling is an action, not a statistic, and
   leaving it bespoke would leave one visible non-dogfooded surface in the
   Match header. The in-Replay round ribbon reuses the same definition.
9. **Raw event reads (kill feed, chat, bomb) — OVERTURN to "records as
   components":** where these render *inside a view's layout* (RoundDetail,
   Combat, Utility) they become record-bound components (§3's (b) rows) — still
   records, never metrics (MANIFESTO.md:82). The **in-world Replay feed
   overlay** stays view (spatial, item 1).

**What stays view, generally:** navigation chrome, transient state, editors
and power surfaces, spatial canvases, export pipelines, and *composition*
(layouts are arrangements of instances). What becomes components: every
stat-bearing surface in §3.

**Components = presentation only; a computed thing is a metric.** A component
option may select, reshape, cap, sort, format or hide — it may never derive a
number from other numbers. Formats (percent, pip ladder, dash rules) are
display vocabulary over an already-produced value, like `fmtMetric` today.

**Mechanical pin shape — "views may not compute"** (modeled on
`webstorage.test.js`: scan + sanctioned sites, each entry carrying a `why`;
exact pattern list is implementation detail for step 5 — **M, flagged**):

1. **Raw-read denylist:** `lib/views/**` may not call the row-reading data
   methods (`getEconomy`, `getPlayerRounds`, `getUtility`, `getEngagements`,
   `getClutches`, `getRounds`, `getScoreboard`, …) — views fetch only through
   the component runtime's input reads. Sanctioned sites: the component
   runtime module itself and non-stat chrome reads (match header, warnings).
2. **Fold-pattern scan:** over `lib/views/**` (+ view-coupled components),
   comments/strings stripped: deny `.reduce(`, row-accumulating `+=` loops and
   `Math.max`/`Math.min` over fetched-row identifiers, with a sanctioned-site
   set (sort comparators, format helpers) — each with a `why`. Sort and
   formatting are explicitly allowed (§2.2, above).
3. **Computation-module ban:** a module that folds rows into numbers cannot
   live in the frontend presentation layer at all — `lib/econ.js`'s formulas
   (econ.js:1-11, "views must not re-derive them") retire into metric
   definitions; the pin denies new row-folding exports outside an allowlist.

The positive half of the boundary is §2.4: the renderer registry is the one
place rendering shapes resolve, and no renderer folds.

---

## 7. A-class dispositions (the sharpest open decisions)

> **OWNER RULING (2026-11-18): RELOCATE ALL SIX** — M19, M22, M30, M31, M36,
> M37 become round-grain metric values bound by their components (the
> chart/bar renderers of §1.4 already wait for them); **no additions to the
> ratified exception list.** This is the same set as the six `metric<rows>`
> bindings (falsified-assumption #3), so the ruling and the grain-furniture
> dependency are one sequencing item — Step 5 sequences §10.4 once, for both.
> M11/M05/M23 need no ruling as reported below.

**Verification basis — MANIFESTO.md:139's ratified exception list (status
quo to preserve):** playhead partials, `scoreThrough`, UI row counts, `score`,
narrowed sort-on-raw, appendix records, raw event reads, one dated
disconnect-self-kills render-only exception — "each with a written reason,
closed to casual growth." R33 explicitly did not verify these five sites
against it (01-BASELINE C6 marked gaps).

| Site | Verified against the ratified list? | Disposition | Recommendation |
|---|---|---|---|
| **M19 EconCurve** (`econ.js` equip/net-worth formulas) | **No — not on the list** | (e) owner ruling | **Relocate:** net worth (equip + cash, econ.js:33-39) is arithmetic ⇒ a round-grain `metric<rows>` (columns: equip, net-worth per side per round); the chart becomes a `chart` instance binding it, toggle = option. Grammar covers it; dependency = §10.4 rows kind + grain furniture. Equip-only-as-record is *not* recommended (the chart's second series is the derived one; sanctioning half would fork the surface). |
| **M22 CT/T deaths fold** (Economy.svelte:78-103) | **No.** C6's "documented exception" is the *code comment's* criterion (round-grain from round records), not a ratified exception — correct the baseline's implication | (e) owner ruling | **Relocate:** deaths per side per round becomes a round-grain `metric<rows>`; the code comment's own reason ("the metrics system cannot express a round at all") names the §10.4 gap this program closes. Honest dash = absent row (no side sample). |
| **M30 damage bars** (Utility.svelte:279-298) | **No** | (e) owner ruling | **Relocate:** utility damage per side per round ⇒ round-grain `metric<rows>`; `hide_when_empty` stays a chart behavior; the "computed" badge is replaced by Formula/N disclosure. |
| **M31 blind-time bars** (Utility.svelte:307-328) | **No** | (e) owner ruling | **Relocate:** blind ms per side per round ⇒ round-grain `metric<rows>`; label honesty (not enemy-gated) moves to the metric `doc`. |
| **M36 RoundDetail money mean** (RoundDetail.svelte:601) | **No** | (e) owner ruling | **Relocate:** mean sampled money per side per round ⇒ round-grain `metric<rows>` (the round×side cell); no-samples ⇒ dash via row absence. The rest of M36 stays record-bound (§3). |
| **M37 CompareRounds summary line** (CompareRounds.svelte:224-230) | **No** | (e) owner ruling | **Relocate:** nades/dmg/flash per round ⇒ round-grain `metric<rows>`; missing round ⇒ dash. Rest stays record-bound. |
| **P07 history ADR/KAST** (PlayerProfile.svelte:1037-1038) | **Not an A-class item — baseline corrected (H)** | no ruling needed | `GetPlayerHistory` fills ADR/KAST from the stored `adr`/`kast` seed rows via the series read, nil ⇒ honest dash (store/analytics.go:1169-1179, 1226-1283); K/D/A halves likewise (K/D raw record columns by Q2's stated half-rule, A = `assists` seed). Under components they become explicit hybrid metric columns (§3 P07). The C6 "raw fields" note described frontend DTO plumbing, not data provenance. |
| **M05 RoundStrip** | **No exception needed — not arithmetic** | no ruling needed | Winner-per-round is a recorded fact; tint/arrow/separators are presentation. Record-bound component (§3); overturns C7.8. |
| **M11 raw Score column** | **Yes — `score` is on the ratified list** (MANIFESTO.md:139) and carries the owner's no-seed ruling (metricorder.js:347-349: "a game-internal composite whose sum has no honest reading") | sanctioned | Stays a record column; `raw:score` remains the appendix's one record offer. Note MANIFESTO.md:139's standing cleanup: the *raw default scoreboard sort* gets eliminated (M13's seed already re-spells to the metric). |

**Common denominator for the six (e) rows:** every one needs **round-grain
materialization** — exactly what 03-QUERIES deferred ("round-grain
materialization … owner/step 4-5", §9 deferral table; `metric_values` PK has
no round column, baseline A4). The grammar and renderer registry already
express all six (`metric<rows>` bindings into `table`/`chart`); what they wait
on is the shape/storage layer. **Recommendation to the owner, standing:** rule
that round-grain statistics are metrics (the M22 comment's criterion is the
old bar, not the new one), land §10.4 grain furniture in the same wave as
these six surfaces, and keep the honest-dash behaviors as definition
behaviors. Alternative — sanctioning them as record arithmetic — would put
six computed numbers outside the honesty contract and re-open the whitelist's
core problem at the presentation layer; not recommended.

**Also flagged (low risk):** M23's pip ladder is dispositioned as a display
format (§3); if the owner reads "pips" as a statistic, it becomes a one-line
round-record metric instead — either way it leaves the view fold.

---

## 8. What PLAN.md must carry from this step

**Falsified / corrected assumptions (read first):**

1. **Baseline C6 P07 "ADR/KAST = raw fields" is wrong** — they are
   metric-backed (evidence §7); the parity question dissolves into the hybrid
   column contract.
2. **C6 M22's "documented exception" is not a ratified exception** — the
   ratified list (MANIFESTO.md:139) does not contain it; the code comment is a
   criterion written when round grain had no metric path. Needs an owner
   ruling (§7), not a presumption.
3. **`metric<rows>` does not exist yet** — 03-QUERIES §4.2 ships
   scalar/identity/fetch and reserves `rows` for §10.4. Six parity rows
   (M19/M22/M30/M31/M36/M37) depend on it. The grammar is not falsified;
   the **program's sequencing is**: track D cannot complete parity until §10.4
   grain furniture lands. This coupling goes to 05-SEQUENCING explicitly.
4. **The naive one-shape-one-slot grammar was falsified by the exercise** —
   hybrid columns, composite cells and chart/strip renderers were added (§1.4)
   rather than rows being dropped.

**Decisions made here (carry as settled, with pins-to-write):**

- Definition/instance schema (§1), the five-shape binding vocabulary and
  renderer registry (§2), save-time contract refusal + load-time placeholder
  split (§2.5), honest-state behavior table (§2.6).
- All 55 parity dispositions (§3) — the acceptance checklist itself; a
  parity-characterization pin should render the shipped default layouts and
  compare cells/state words against today's views.
- Controls → parameters with two consumption legs; axis-selection as the v1
  metric leg; per-binding formula/N, parameter-independent freshness (§4).
- **kvstore as the layout-config home** + the exact absorption map (§5) +
  `webstorage.test.js` entries removal with dated reason.
- C7 items 8/9 overturned, 1–7 confirmed (§6); pin shape for
  "views may not compute" (§6).
- **Pins to write:** component contract refusals (wrong-shape binding,
  wrong-typed param); stale-ref placeholder (drop-never-migrate) tests;
  layout absent⇒default / present⇒verbatim + Reset tests (incl.
  transpose-not-reset); five-state + empty-pool parity pins (M08/M16/M20);
  the §6 computation scan (sanctioned sites with `why`); webstorage update.

**Decisions deferred (with owners):**

| Item | Owner / step | Note |
|---|---|---|
| Round-grain materialization + `rows` shape kind (the six (e) rows) | owner ruling + §10.4 / step 5 | blocks track-D parity; the recommendation is §7's standing ruling |
| Parameterized metric materialization vs read-time execution | step 5 (flagged §4) | v1 = axis selection only; no param axis on `metric_values` until measured need |
| Component definition catalog home (code vs seeded table) | step 5 | recommendation: built-in definitions ship as code/seed like metrics; user instances in kvstore; type-level authoring later |
| The (e) rows' owner rulings themselves | owner (§7) | six rulings, one recommendation |
| Exact computation-scan pattern list | step 5 | shape decided (scan + sanctioned sites + `why`), patterns are implementation |
| Library.svelte audit (C7.6 flag) | step 5 | baseline never audited it; out of parity scope until flagged |
| "Share layouts" durability tier | future | would re-open §5's kvstore choice (shareability ⇒ different tier) — do not pre-build |

**Verification executed for this document:** read MANIFESTO/PLANNING/01-BASELINE/
03-QUERIES in full; spot-verified the P07 correction (store/analytics.go
1155-1294), the M11 owner ruling (metricorder.js 340-360, 425-460), the M22
criterion comment (Economy.svelte 70-110), M30/M31 folds (Utility.svelte
270-335), M36 mean (RoundDetail.svelte 560-612), M37 fold (CompareRounds.svelte
200-240), RoundStrip header, `webstorage.test.js`, `metricstate.js`, and
`GetPlayerHistory`'s metric-backed cells — all at `3ba4a33`. Tree state at
commit: this file is the only change.
