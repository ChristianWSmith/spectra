# FOLLOWUP — work still outstanding after the migration

The SQL-metrics, raw-components and tick-facts migration is merged. This file
is the only record of what it did not finish. The migration spec (`dogfood/`)
is removed by the commit that adds this file; its last copy is at `259992c`.
Each item was checked against the current code before it was listed. Source
cites that spec: `PLAN §2 r<N>` is ruling N of `dogfood/PLAN.md`, and `02 §x`
and so on are the sub-docs of that directory.

## Owner decisions open

- **Kill tags or kill class.** Ruling 32 renames the engagements family to
  "kill tags"; PLAN's open note suggests "kill class". The UI already says
  "kill tags" (`src/frontend/src/lib/strings/combat.js`). Decide the final name.
  Source: PLAN §2 r19, r32; PLAN "Open decisions".
- **Engagements table identifier.** The `engagements` table (`schema.sql`)
  keeps its name; only user-facing text was renamed. Decide whether the table
  is renamed, and if so, ride it on the next wipe. Source: PLAN §5 C5g, r32.
- **Economy view as a builtin.** PLAN lists this as not decided, but
  `src/frontend/src/lib/econpanels.js` already ships it. Record the decision
  as made, or revert it. Source: PLAN §5 C5 "Open for the owner".

## Deferred

- **Component read cache and learned reads.** Design held: learned reads per
  panel, tag-based invalidation with generation counters, speculative warms,
  compute states never cached. None of it is in code. It is polish, not
  migration scope. Source: PLAN §2 r52.
- **Covering index and `WITHOUT ROWID` for `player_ticks`.** Covering index
  measured 2.6 s to 542 ms at +50 MB; `WITHOUT ROWID` saves 25% space and costs
  36% on subject-range reads. Decide on measured sweep pain after the wipe.
  Source: 02 §2, §7.
- **Tick density as a sink parameter.** Full 64 Hz gives about 13 to 17 GB per
  100 matches. Revisit only if disk becomes the limit. Source: 02 §1, §7.
- **Position and velocity columns on `player_ticks`** (`yaw`, `pitch`, velocity
  vector). Needs a future wipe and a concrete metric that uses them. Source: 02 §7.
- **Counter-strafing threshold.** Not sourced. `CS2.md` needs a source before
  any counter-strafing metric ships. (The speed definition is sourced at
  `CS2.md` "Player movement speed".) Source: 02 §7; MANIFESTO §7.
- **Column-level freshness for `player_stats`.** Any metric that touches it is
  treated as analysis-dependent until attribution by column is built.
  Source: 03 §4.
- **Surrogate `round_id`.** Rounds stay keyed by `(match_id, number)`. Source:
  03 §5.

## Verification still owed

- **Wipe-time check of the tick-join seeds and shots.** `dmg_no_kill`,
  `kill_conversion`, the `weapon_damage` gate and `shots` cannot be checked
  against the snapshot before the wipe. Check them at the owner's wipe gate.
  Source: PLAN §2 r24; 06 §3.1; `schema.sql` comments near the tick-join seeds.
- **Wipe diff against the snapshot.** Run deep-clean, re-import from the
  snapshot's demos, then diff `metric_values` against the reference export.
  The only accepted changes are the ratified ones: NULL cells where the snapshot
  stored 0 (r23, 461 cells); `money_spent_total` redefined (06 Q3, 8 of 73
  rows); `side_adr` on capped damage (r49, 110 of 116 cells); the `post_match`
  stamp (r40). Any other change is a port bug. Nothing in the repo records that
  this has run. Source: PLAN §6.
- **Freshness, sweep and import checks that need a real re-import.** The sink was
  measured on the golden demo only (02 §8). Behind-marking on import and
  reprocess, and sweep consistency on the read connection (05 §5), are only
  proven by a full re-import. Source: PLAN §5 B1, B4; 05 §5.
- **Teamkill and same-side gates.** The snapshot has zero teamkills and zero
  `five_k` rows, so those gates are not exercised by it. F2 asked for a
  synthetic or second-demo check. Confirm that the tests which mention teamkills
  actually pin the gates. Source: 06 §4 and the F2 recommendation.
- **WebKitGTK component-runtime check.** The C0 spike passed under Node and
  jsdom only. Run it in WebKitGTK. Also confirm the Wails configuration has no
  CSP that blocks runtime evaluation (not checked). Source: PLAN §5 C0; 04 §5.
- **Save-gate bind handling.** Confirm that the gate detects reserved binds in
  every SQL shape (subqueries, CTEs) and refuses a user statement that names a
  bind the engine does not supply. Neither was confirmed from the tests read.
  Source: PLAN §8 "Still unverified".

## Cleanup owed

- **Retired `metrics` furniture (r51).** `schema.sql` `metrics` still has
  `scope`, `subject` and `partition`. `ValidateExpr` takes them as parameters
  (`src/metricservice.go`), and plugin manifests still declare scope
  (`src/internal/plugin/manifest.go`). Remove them with the wipe.
  Source: PLAN §2 r51; 03 §1.
- **Expr-named leftovers.** `ValidateExpr` and `ExprError` (`src/metricservice.go`)
  keep the grammar's name. The `expr` column itself stays by design.
  Source: PLAN §5 B3.
- **Go clutch detector still runs (r53).** `analytics/compute.go` calls
  `Clutches` and `ReplaceClutches`. The `clutches` table (`schema.sql`) and the
  `clutches` and `match_clutch_wins` seeds still read it. Compute clutches inline
  from `player_ticks`, then drop the table with the wipe. The parity result
  (183 of 183) is already recorded. Source: PLAN §2 r53.
- **Duplicate fold metric (r30).** `raw_rounds_played` duplicates the
  `rounds_played` builtin. Retire one. This is the only duplicate pair found.
  Source: PLAN §2 r30.
- **Builtin duplicate action (r43, 04 §7).** `ComponentBuilder.svelte` still has
  `duplicate()`, which copies built-ins. Ruling 43 cancelled duplicate-to-edit
  for builtins. Remove that path, or keep it for user components only.
  Source: PLAN §2 r43; 04 §7.
- **Alive-count family name (r37).** The owner chose "XvY". The code still uses
  `alive_count` and the label "Alive count (raw SQL)" (`schema.sql`). Rename.
  Source: PLAN §2 r37.
- **Retired-key names in test absence checks.** `metric_order_*`,
  `metric_pins_overview`, `metric_economy`, `metric_hidden_*`,
  `scoreboard_starts_transposed` and the `spectra:pinned-metrics` key appear in
  `src/frontend/src/lib/*.test.js` and `src/frontend/test/*.mjs`. Keep them only
  as absence checks, and check the wording reads that way. Source: PLAN §5 C5e.
- **`metricorder.js` naming.** The module still provides the metric sequence to
  the builtin panels (`composedSequence`, `inSequence`, `rawItems`, `isRawId`).
  Ruling 33 removed ordering, so trim it to the default sequence and drop the
  unused names. Source: PLAN §2 r33; PLAN §5 C5e.
- **Delete over-invalidation (r31).** Narrow the career rebuild on delete to the
  touched tables. Not confirmed: no delete-specific freshness path was found in
  `src/internal/store/metric_scope.go`. Check, then fix. Source: PLAN §2 r31.

## Known gaps

- **`Library.svelte` was never audited.** Source: 01 §D.
- **`attacker_inair` disagreement.** The payload flag and the tick sample
  disagree on two kills in seven golden demos. The likely cause is timing. This
  is a known data limit, not a parser bug, so trust the tick sample for
  consistency. Source: PLAN §2 r38, r39.
- **Verification evidence lives outside the repo.** Pins cite
  `~/Programming/spectra-verify/` (`raw_fold_seed_test.go`,
  `headline_metrics_test.go`). The repo cannot reproduce those checks on its own.
  Source: PLAN §3, §8.
