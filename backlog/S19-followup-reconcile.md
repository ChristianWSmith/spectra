# S19 — Reconcile FOLLOWUP.md with the code

**Type:** build (documentation)
**Depends on:** none
**Source:** `source/FOLLOWUP.md`

## Goal
Bring `FOLLOWUP.md` in line with the repo. Mark each item as done, stale, or
still open, based on the code as it is now.

## Status (checked against the code, this sprint's start)

### Stale: remove from the open list
- **Go clutch detector still runs (r53).** Stale. `analytics/compute.go` no
  longer calls `Clutches` or `ReplaceClutches`. Clutch metrics run from SQL
  (`store/clutch_sql.go`), and the `clutches` table is gone.
- **Retired `metrics` furniture (r51): `scope`, `subject`, `partition` in
  `schema.sql`.** Stale for the table. The `metrics` table no longer has these
  columns. **Still open** for the plugin side: `plugin/manifest.go` still has a
  `Scope` field.
- **Economy view as a builtin (owner decision).** The decision is effectively
  made: `econpanels.js` ships it. Record it as decided.

### Still open
- **Duplicate action in `ComponentBuilder` (r43).** `duplicate()` is still
  present (`ComponentBuilder.svelte`, line ~330).
- **Alive-count family name (r37).** The label is still "Alive count (raw SQL)"
  in the `alive_count` seed.
- **`metricorder.js` naming (r33).** `composedSequence` and `inSequence` are
  still exported and used by `compile.js` and several panels.
- **Covering index and `WITHOUT ROWID` for `player_ticks`.** Neither applied.
  Linked to S15.
- **Tick density as a sink parameter.** No change. Revisit only if disk binds.
- **Position and velocity columns on `player_ticks`.** Not added. Encounter
  fact may replace this need (`source/ENCOUNTER-MANIFESTO.md`).
- **Counter-strafing threshold.** No sourced entry in `CS2.md`.
- **Column-level freshness for `player_stats`.** Still treated conservatively as
  analysis-dependent (`metric_scope.go`). By design until attribution exists.
- **Surrogate `round_id`.** Not introduced. Rounds still keyed by
  `(match_id, number)`.
- **`attacker_inair` and `same_side` stamps.** Still in the schema. The planned
  drops are in the migration plan, not yet applied.
- **`Library.svelte` audit.** Not done. The file exists.
- **Kill tags versus kill class.** Decided: kill tags. Renamed everywhere on
  2026-11-21 (table `kill_tags`, Go `KillTag`, JS `killTags`, kebab `kill-tags`).
  Existing dev libraries need a wipe and re-import.
- **Component read cache with generation counters (r52).** Not built on the
  backend. The frontend has a `cachedRead` for lists and values, which is a
  different design. Linked to S13.
- **Delete over-invalidation (r31).** Not checked. No delete-specific freshness
  path was found. Needs a check before a fix.
- **Expr-named leftovers (`ValidateExpr`, `ExprError`).** Left as is by design.
- **Retired-key names in test absence checks.** Not checked.
- **Save-gate bind handling for reserved binds in subqueries and CTEs.** Not
  checked.
- **WebKitGTK component-runtime check and CSP.** Not checked.
- **Teamkill and same-side gate tests.** Not checked. The snapshot does contain
  55 same-side damage events, so the same-side branch is exercised there.
- **Wipe-time check of tick-join seeds and the wipe snapshot diff.** Still owed.
  Nothing in the repo records that it has run.

### Cannot verify from here
- **`spectra-verify` evidence** (`~/Programming/spectra-verify/`). The directory
  does not exist on this machine.
- **Verification evidence lives outside the repo** (`PLAN §3, §8`). Same cause.

## Work
- Apply the statuses above to `FOLLOWUP.md`: strike stale items, add the status
  to open ones, and record the economy decision.
- Link the open items to their stories (S13, S15, S20, and the sprint's
  owner decisions).
- Check the not-yet-checked items when time allows. Some may be trivial, and
  delete over-invalidation and the save-gate bind handling affect correctness.

## Acceptance
- Every FOLLOWUP item has a status, and each stale item is removed from the
  open list.
- The items cited as outside the repo are recorded as unavailable on this
  machine.

## Not covered
Items in the "not checked" list above. Each needs its own check before it can
be marked done or stale.

## Result (2026-11-21)
- Applied to `source/FOLLOWUP.md`: removed the Go clutch detector item (stale:
  no `Clutches`/`ReplaceClutches` call under `src/internal`, and no `clutches`
  CREATE TABLE in `src/internal/store/schema.sql`); moved the economy view to a
  "Decided (recorded)" section; narrowed the r51 item to the plugin side only
  (`src/internal/plugin/manifest.go` `Scope`); added file paths to the open
  `duplicate()`, `metricorder.js` and `alive_count` items.
- Still open and unchanged: the rest of the "still open" list above.
- Not checked in this pass (unchanged from the list above): delete
  over-invalidation (r31), save-gate reserved binds, the WebKitGTK/CSP check,
  the teamkill gate tests, and the retired-key absence checks.
- Cannot verify here: `~/Programming/spectra-verify/` (absent on this machine).
