# FOLLOWUP

Work still outstanding after the 2026-11 backlog sprint, and the items carried
from the migration follow-up. Each item says what is needed to close it.

## From the 2026-11 sprint

### Still to do

- **Re-admit doors to the render geometry.** Doors (`prop_door_rotating`,
  `func_door`, `func_door_rotating`) are excluded from the render geometry, which
  blocks 3 kills on de_nuke. Needs either each door's state at the kill tick, or
  a per-door decision. Owner: follow-up, not sprint work.
- **See-through seed check on a larger library.** Test whether dropping the
  see-through seeds (smoke, steam, lightshaft, puddle, glass) adds seeds, and
  whether it condemns any of those materials. Needs the larger library.
- **Human GUI timing for S13.** Cold and warm Overview, Scoreboard and History at
  100 rows, before and after the frontend-read change.
- **Wipe existing libraries before the next release.** The sprint changed the
  schema: `player_ticks` is state-only (round, side, alive, hp), the encounter
  window samples carry speed, weapon and in-air, and the money column is gone.
  Existing libraries must be re-imported.

### Not done (skipped by the owner)

- **Peak memory of the in-parse encounter build.** The windows are built from
  every collected frame at the end of the parse. Not measured.
- **S14 parallel sweep speedup.** The parallel sweep is correct (identical to
  the sequential baseline on all 32,431 values) but its speedup was not measured.
- **S04 speed tolerance check and S07 tracer benchmark.** Not run.
- **S08 library-scale checks.** Dropped. The 7-match library is the only
  acceptance set, so rarer disconnects and bot cases are not covered.
- **S03 pruning ablation variant.** Not run. The harness is removed from this
  branch (see below); it is in the history up to `4e236f7`.

### Accepted caveats

- **Query console and kill-tick attacker rows.** Kill-tick attacker rows are not
  stored under the state-change rule. Console users who read `player_ticks` at a
  kill tick need the victim row. Owner accepts this.
- **`attacker_inair` and `in_air` disagree** on two kills in the golden set. Both
  are kept, and no test compares them. Known and accepted.
- **Window counts changed on the re-import.** Full-precision positions move
  some borderline sight lines: nuke's sample count is down 378, and several maps
  move by 1 to 3 windows. Ratified by the owner.
- **Map-pack DXT5 path.** No active-duty radar is DXT5, so the decoder is covered
  only by the synthetic `TestDecodeVTexDXT5`.

### Verified

- The window speed matches an independent recomputation from the parser's
  position stream on the golden demo: 1,973,904 values, zero mismatches
  (`TestGoldenWindowSpeedMatchesPositionStream`).
- Parser panic and cancelled imports leave no streamed tick rows
  (`TestImportPanicDeletesStreamedTicks`, `TestImportCancelledDeletesStreamedTicks`).
  Importer-level write-error test not added; the store-level write-error test
  covers that path.
- GUI checks from the S18 list were accepted by the owner.

### Removed from this branch (dev tools)

The S03 ablation harness (`internal/ablation`), and 34 environment-gated test
files that ran only with a `SPECTRA_*` variable set: encounter overlays, sweeps,
blocker and triangle probes, and mappack dumps and probes. They remain in the
history up to `4e236f7`. `-extract` and `-import` are kept as documented
headless modes.

## Carried from the migration follow-up

These come from `backlog/source/FOLLOWUP.md` on `main` (the file this commit
removes). They were not re-checked against the current code.

### Deferred

- **Component read cache and learned reads.** Design held, nothing in code.
  Polish, not migration scope.
- **Covering index and `WITHOUT ROWID` for `player_ticks`.** A covering index
  measured 2.6 s to 542 ms at +50 MB. `WITHOUT ROWID` is rejected for the sprint.
  Decide the covering index on measured sweep pain after the wipe.
- **Tick density as a sink parameter.** Full 64 Hz is about 13 to 17 GB per 100
  matches. Revisit only if disk becomes the limit.
- **Position and velocity columns on `player_ticks`** (`yaw`, `pitch`, velocity).
  Needs a wipe and a metric that uses them.
- **Counter-strafing threshold.** Needs a source in `CS2.md` before any
  counter-strafing metric ships.
- **Column-level freshness for `player_stats`.** Analysis-dependent until
  attribution by column is built.
- **Surrogate `round_id`.** Rounds stay keyed by `(match_id, number)`.

### Verification still owed

- Wipe-time check of the tick-join seeds and shots (`dmg_no_kill`,
  `kill_conversion`, the `weapon_damage` gate, `shots`).
- Wipe diff of `metric_values` against the snapshot's reference export. Only the
  ratified changes are accepted.
- Freshness, sweep and import checks that need a real re-import.
- Teamkill and same-side gates: the snapshot has no teamkills, so confirm the
  tests that mention them pin the gates.
- WebKitGTK component-runtime check, and confirm the Wails config has no CSP that
  blocks runtime evaluation.
- Save-gate bind handling for reserved binds in subqueries and CTEs.

### Cleanup owed

- Retired `metrics` furniture in plugin manifests (`Scope` field and the
  `reportTpls` scope check). Remove with the wipe.
- Expr-named leftovers: `ValidateExpr` and `ExprError` keep the grammar's name.
- Duplicate fold metric: `raw_rounds_played` duplicates `rounds_played`.
- Builtin duplicate action in `ComponentBuilder.svelte` (`duplicate()`, button
  `.cb-duplicate`). Ruling 43 cancelled duplicate-to-edit for builtins.
- Alive-count family name: the owner chose "XvY"; the code still says
  `alive_count` and "Alive count (raw SQL)".
- Retired-key names in test absence checks: keep only as absence checks.
- `metricorder.js`: trim to the default sequence and drop unused names.
- Delete over-invalidation: narrow the career rebuild on delete to the touched
  tables.

### Known gaps

- `Library.svelte` was never audited.
- Verification evidence lives outside the repo (`~/Programming/spectra-verify/`),
  so the repo cannot reproduce those checks alone.
