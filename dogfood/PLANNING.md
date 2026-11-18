# PLANNING — plan for planning the facts/queries/components migration

**Status:** IN PROGRESS. This is the planning phase's own plan. When every step
below is complete, this file is **deleted** and replaced by `dogfood/PLAN.md` —
the finalized, single-session-handoff migration plan. If tokens run out first,
this file is the fallback: a future session picks up at the first unchecked box.

**Source direction:** `dogfood/MANIFESTO.md` — the three-layer stack (facts →
typed metrics → grammar-defined components → layouts), the five-rule blacklist,
migration tracks A–D. It is stand-alone; the sub-docs below may cite it.

**Tracked:** everything under `dogfood/` is committed and pushed (the legacy
root docs stay untracked; these do not).

---

## How this phase works

1. **Staged research.** Each step has one sub-document in `dogfood/`. Steps run
   in dependency order; steps marked parallel may run concurrently.
2. **Findings pass forward.** Every worker/researcher brief carries the
   contracts established so far — the manifesto plus any completed sub-docs —
   so interfaces (output shapes, N semantics, component input contracts, table
   names) align across documents. Conflicts found later are reconciled by the
   lead before the next step starts, never left for PLAN.md to inherit.
3. **Commit + push on every completed step.** Lead integrates the sub-doc,
   ticks the checklist here, commits, pushes — same turn.
4. **Isolated worktrees** for every subagent (lead creates them; registry in
   `WORKING-DOC.md`). Wall-clock budget (estimate + absolute DEADLINE + `date`
   check + wrap-to-partial-report) in every brief.
5. **No implementation.** This phase produces documents only. Code changes
   (including the rule-3 prototype) are *worked examples* — SQL run read-only
   against a scratch/in-memory database or existing dev DB, never schema
   changes, never app code. The real prototype rides PLAN.md.

## Owner rulings (live)

- **2026-11-18 — pre-release breakage is free:** we are pre-release; schema and seed changes break whatever they need to, no compatibility paths, no ensure-column anything. Where verification is a concern, **cut a pre-migration database snapshot before the wipe** and diff metric values+N match-by-match after re-import — the sanctioned comparison instrument for the whole program. Applies directly to Step 2's stamp-drop decision (`events.same_side`/`capped_dmg`/`attacker_inair` drops are ON the table, coordinated with rewrites of the three seeds that reference them).
- **2026-11-18 — formula display = SINGLE FIELD (owner):** the stored metric formula IS the expanded SQL; the Formula tooltip and editor show the stored formula; no separate authored-source field. Flips `03-QUERIES.md` §9 decisions 3/9 (annotated there). Wave-B consequences: sugar input still expands at save; seed expressions in `schema.sql` normalize to their expansion at Open so every row carries one spelling (dedupe holds).
- **2026-11-18 — freshness precision = FULL NOW (owner):** lift the blanket `rule_version` axis for fact-only metrics in the SAME wave as rule 5 — the conservative fallback in `03-QUERIES.md` §9's deferral table is rejected; the pin updates ride that wave (annotated there). **Owner note, refined same day (this supersedes an earlier "analysis rules convert into ordinary metrics" paraphrase):** analysis rules get **built-in metric stubs** that feed propagation of dependent metrics; **analysis-rule values remain user-editable**, and updating them is **the one thing that pushes a change to the corresponding stubs**, which triggers recalculation of dependents as needed via the existing dependency-cascade machinery. So the blanket `rule_version` axis is replaced by **stub-mediated propagation** (precision = the cascade reaches exactly the dependents), not by a per-metric table-set lift alone; rule 5's touched-table set still governs fact freshness. Tilts manifesto open question 3: analysis outputs keep their identity (editable, Go-computed) but surface in the metrics system as stubs; boundary holds only until a query provably replaces a detector.

---

## The acceptance bar (carried into every step)

**Component parity:** everything currently shown in the match and profile views
must be expressible under the new components system — an end user cannot tell a
dogfooded component from a bespoke one. Same migration discipline as always:
characterization first, display parity pinned, honest states intact (dash on
empty pool, five metric states, no fabricated zeros).

**No-exceptions:** if numbers diverge, fix the metric until they match.

---

## Checklist

- [x] **Step 0 — setup:** `dogfood/` created, `FACTS-AND-QUERIES.md` →
      `dogfood/MANIFESTO.md` (now tracked), this file written. *Commit+push.*
- [ ] **Step 1 — baseline inventory** → `dogfood/01-BASELINE.md`
      (3 parallel researchers: metrics engine · store/extract/sidecar ·
      surfaces+prefs). *No dependencies. Everything else contracts against it.*
- [ ] **Step 2 — tick-state design** → `dogfood/02-TICK-STATE.md`
      (depends: 1). Density/derived-feature policy, schema shape, ingest path,
      sidecar relationship, what rides the owner's wipe.
- [x] **Step 3 — query language + five rules, rule-3 prototype** →
      `dogfood/03-QUERIES.md` (depends: 1). **The crux:** worked examples
      proving N derivation/declaration for ratios, rates, per-round aggregates,
      identities, percentiles. Sugar→SQL IR shape, output-shape validation,
      freshness-by-table-set. **DONE 2026-11-18 — crux PASSED for all five
      shapes** (executed against scratch DB); derivation ladder + `n_pool`
      declaration + `src_*` view rule settled; two owner rulings pending
      (formula display two-field vs one, rule_version axis lift).
- [ ] **Step 4 — components + parity inventory** → `dogfood/04-COMPONENTS.md`
      (depends: 1; shape vocabulary from the manifesto, cross-checked against
      3 when it lands). Component grammar, input contracts, controls→parameters,
      renderer registry, and the **complete list** of current match/profile
      content that must be expressible.
- [ ] **Step 5 — sequencing + verification** → `dogfood/05-SEQUENCING.md`
      (depends: 2, 3, 4). Order tracks A–D into executable waves, bundle every
      schema change for the single owner wipe, per-wave verification strategy,
      dead-code sweep list, open-question dispositions.
- [ ] **Final — delete this file, write `dogfood/PLAN.md`** — the actual
      migration steps referencing the sub-docs, complete enough for a fresh
      session to execute the whole migration in one session. *Commit+push.*

---

## Step details (briefs get built from these)

**Step 1 — baseline inventory (parallel, read-only researchers).**
Three briefs over one fixed baseline (`24de283`):
- *R1 metrics engine:* grammar constructs + refusal matrix, compiler/IR, seed
  catalog, `metric_values` materialization, freshness/behind states, N as
  manufactured today, subject/scope/partition/denominator/format furniture,
  equivalence gates, editor touchpoints. → contracts for Step 3.
- *R2 store/extract/sidecar:* `schema.sql` tables/columns/indexes, extract
  stamp pipeline, sidecar per-tick payload (what already exists, format),
  import/analyze/reprocess flow, `generic_events`, wipe surface. → contracts
  for Step 2.
- *R3 surfaces+prefs:* every statistic rendered in Match and Profile (scoreboard,
  cards, tables, charts, economy panel, reports appendix, ordering dialog) with
  its data path, plus every pref family (`metric_order_*`, `metric_hidden_*`,
  `metric_pins_overview`, `metric_economy`, …). → the Step 4 parity seed.
Lead compiles the three reports into `01-BASELINE.md`.

**Step 2 — tick-state design.** Takes R2's inventory + the manifesto's §2;
decides density (complete state vs derived-features-at-rate), table shape and
grain, ingest point in the parse, sidecar convergence question, and the exact
list of schema changes bundled into the owner's one wipe.

**Step 3 — queries (crux first).** Takes R1's inventory + the manifesto's §5–7.
Rule-3 worked examples come FIRST (ratios, rates, per-round aggregates,
identities, percentiles — each: the query, how N is derived or declared, what
the refusal would be). Then the sugar→SQL IR refactor shape, output-shape
validation, freshness-by-table-set, and what the Formula tooltip shows.

**Step 4 — components.** Takes R3's parity seed + the manifesto's §4. The
component grammar (text, no GUI builder), display vs control components,
parameters produced by controls and consumed by sibling metrics, input-contract
refusal, renderer registry, config storage/evolution, and the full
parity checklist (every current match/profile item mapped to a component
instance or an explicit "stays a view" disposition — Replay, chrome, editors).

**Step 5 — sequencing.** Merges 2–4 into wave order: what lands in the wipe
bundle, which waves are independently verifiable, characterization/parity pins
per wave, the dead-fold/sort dead-code sweep, and each open question from the
manifesto §10 given a disposition or an explicit "decide during execution."

**Final — PLAN.md.** The handoff: ordered waves with files, contracts from the
sub-docs, verification per wave, and the owner's obligations (wipe +
re-import) called out where they gate the work.
