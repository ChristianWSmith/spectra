# MANIFESTO — SQL metrics, raw components, tick facts

**Status:** DIRECTION, committed by the owner (2026-11-20). Supersedes the
2026-11-18 direction (custom expression grammar, compiled SQL, component
grammar, honest-metrics contract, views-don't-calculate). The earlier
direction was executed in part and cancelled; its commits were deleted.
This document is stand-alone.

**Execution:** `dogfood/PLAN.md`. Nothing here is enqueued until the owner
says so. Not roadmap work.

---

## 1. The direction in one paragraph

Metrics are **SQL**, builtin and user-authored alike. Components are
**Svelte**, the same language as the app's own views, stored in the
database, previewed in a Component Builder, and each one renders inside its
own error boundary. Users duplicate a builtin to edit it and can make their
copy their Match or Profile view. Parsing produces a per-tick
fact table so that movement-based statistics become plain SQL joins. The app
keeps three things it refuses to give up: **freshness**, **read-only
execution**, and **the save-time syntax gate**. Everything else that used to
be a guarantee is dropped and accepted as a power-user footgun.

## 2. What is kept, what is dropped

| Area | Kept | Dropped |
|---|---|---|
| Metric expressions | SQL; one statement; read-only; no `CREATE VIEW`; every table resolved to a fixed app table or view at save; freshness from touched tables | the sugar grammar and its compiler; sample size (N) as a guarantee; the honest-metrics contract; the timeout and row cap; automatic bot filtering for user metrics |
| Metric values | stored values; processing / failed / fresh / no-data / behind states; the dependency graph (`metric('…')` references) | the rule that every number carries its formula and N |
| Analysis rules | rule outputs stored at analyze time; rule-value edits fire builtin stubs; code changes bump the analysis version | nothing else changes here |
| Components | Svelte source in the database; Component Builder with preview; error boundary per component; metrics and allowlisted tables readable; duplicate-to-edit; "use as my view" for the Match view (tab bar and below) and individual Profile views | the component grammar; contract refusals at save (syntax-only at save); the stale-reference placeholder machinery; in-place editing of builtins |
| Formatting | components format values | metric display formats |
| Views | they may compute for presentation | the exception list; the relocation rule; "views contain zero statistics logic" |
| Builtins | rigorous: rebuilt to the builtin conventions in `AGENTS.md`; verified against the pre-migration snapshot | none |
| Tick facts | a per-tick fact table at 64 Hz with derived features; sink-side speed; chunked writes | the streaming `TickSink`'s grammar admission (no grammar exists to admit into) |

## 3. Why

- **The treadmill.** Every new statistic shape needed a grammar extension,
  and every stamp needed a column, a seed, a whitelist entry and a test. A
  grammar is a bound on what users can say, and it is also maintenance we
  keep paying.
- **The honesty promises were not maintainable.** The compiler could not
  enforce N, formula and bot-exclusion guarantees across every expression
  shape we wanted, and maintaining that enforcement cost more than it
  returned. The owner accepts that user metrics can be wrong.
- **Our own views duplicated the metric system.** Keeping views free of
  arithmetic required a grammar for everything a view wanted, so the
  boundary had the same cost as the grammar. Components now carry the
  presentation and may compute.

## 4. The three kept guarantees, in precise terms

1. **Freshness.** A stored value is shown only when it is current with the
   data it was computed from. Each metric stores the set of tables it reads.
   A re-import or reprocess marks dependents behind through those tables. A
   rule-value edit fires that rule's builtin stub. A code change to analysis
   bumps the analysis version, which is the one broad recalculation path.
   Nothing recalculates blanket-style on a value edit.
2. **Read-only execution.** Metric SQL runs on a read-only connection, even
   during sweeps. A slow metric never holds the single writer, so it cannot
   stall imports, job progress or saves. Users can cancel a running metric.
3. **Save-time syntax gate.** One statement. No writes. No view creation.
   Every table read must resolve to a fixed app table or view. The same gate
   serves the Builder's live check, save, preview and sweep.

## 5. Accepted footguns

Users may write metrics and components that are wrong, slow, biased, or
contaminated by bots. Users may read allowlisted tables from a component. Metrics have
no timeout and no row cap. A metric that returns a very large result set can
use a lot of memory. These are documented in PRODUCT.md under **Power
surfaces** and are not bugs.

## 6. The builtin conventions, in short

Builtins are the one place the rigor lives. They are the old sugar compiled
to SQL once, with the bot predicate added, then checked against the
pre-migration snapshot. The full convention list is in `AGENTS.md`
(**Builtin conventions**). In short: canonical SQL, bot predicate in one
shared fragment, no fabricated values, round-grain statistics as metrics,
and value parity with the snapshot.

## 7. Tick facts and speed

The fact substrate is one table, `player_ticks`, with one row per (match,
tick, present player) at 64 Hz. It carries derived features only: round,
side, alive, hp, money, in_air, speed and weapon. Position and view angles
stay in the replay sidecar. The two stamps that the tick table can replace,
`events.same_side` and `events.attacker_inair`, are dropped, and their seeds
become SQL joins. `events.capped_dmg` stays as an ingest stamp because it
emulates an engine rule: it is order-dependent and row-local, so no per-tick
row can reproduce it.

**Speed must be sourced, not guessed.** The definition (horizontal or 3D,
units) and any counter-strafing threshold come from CS2 documentation or
community wikis, recorded in `CS2.md`, before any speed-consuming metric
ships.

## 8. Decided and open

**Decided (owner, 2026-11-20):**

- Builtin and user components are Svelte. Source is stored; the compiler
  loads lazily in the webview, with a compile cache. Import rewriting is
  verified by a spike before the component wave depends on it.
- Duplicate-to-edit, plus "use as my view" for the Match view (everything
  below the header, tab bar included) and individual Profile views.
  Header, warnings, round strip, and the profiles list stay hardcoded.
- The shipped Match and Profile views are rebuilt as builtin components.
- Round-grain statistics are metrics.
- User metrics read only the allowlisted tables.
- No display formats on metrics. Components format.
- No metric timeout, row cap, sample size, or result-shape validation.

- **Storage and scope** (D-5): a metric's scope is the set of reserved binds
  it references, `:match_id`, `:steam_id`, or `:round` with `:match_id`.
  Unbound metrics are library-wide. Each run replaces its own bound rows. See
  `dogfood/03-QUERIES.md` §5.

**Open:** nothing in the direction is open. Implementation questions are in
`PLAN.md`.

## 9. Read order

`PRODUCT.md` (Freshness, Power surfaces, Facts/metrics/records), then
`AGENTS.md` (Metric pipeline, Builtin conventions, Components), then this
document, then `PLAN.md`, then the sub-docs for the wave you are on.
