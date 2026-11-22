# PATH — next sprint: order, dependencies, and what is not covered

Intent documents live in `backlog/source/` (PERF, PRUNE, ENCOUNTER-MANIFESTO,
FOLLOWUP). Each story is one file in `backlog/`, named `S<nn>-*.md`. Stories
are sketches: scope and acceptance are proposals, not commitments.

Story types: **spike** (research, produces a recorded answer), **build** (code
change), **decision** (owner call, recorded), **deferred** / **parked** (not in
the sprint's critical path).

## 0. Governing principles

- **Tiered fidelity** (`source/PRUNE.md`, "Tiered fidelity"; a proposal, not an
  established design). Facts live at tiers: round and event, tick state
  (event-anchored), encounters (dense, shot-seeded), and sidecar. Which tiers a
  metric reads is derived from its touched tables, not declared. Only partial-
  coverage reads (tier 2) need a label.
- **HP stays in tier 1** (owner decision). No story may remove
  `player_ticks.hp` unless the owner rules otherwise. HP may get an
  event-derived performance path, but the column stays.
- **No existing value changes without a recorded ruling** (migration rule). Any
  story that changes a value needs a ratified diff first.

## 1. Stories

| ID | Title | Type | Status in sprint |
|---|---|---|---|
| S21 | Presence semantics for pruned rows | decision | Owner ruling, gate G9 |
| S01 | Clutch HP derivation (performance option) | spike | Active — gate G1, no longer removes HP |
| S02 | Reconcile tick rows with round tables | spike | Active — gate G2 |
| S03 | Ablation harness | spike | Active — gate G3 |
| S04 | Speed change tolerance | spike | Active — gate G4 |
| S05 | Equipment value and spend from events | spike | Active — gate G5 |
| S06 | Analysis-table inputs audit | spike | Active |
| S07 | Encounter tracer, BSP, CS2 format | spike | Active — gate G7 |
| S08 | Library scale and clean timing | spike | Active — gate G8, **blocked on data** |
| S09 | Damage family side from round sides | build | Contingent on G2, G3 |
| S10 | Alive count from roster minus kills | build | Contingent on G2, G8 |
| S11 | Sample once per frame | build | Ships early, no gate |
| S12 | Async tick flush | build | Contingent on G8 |
| S13 | UI metric reads | build | Ships early; human GUI acceptance |
| S14 | Parallel sweep units | build | Contingent on G3, G8 |
| S15 | Tick storage wipe bundle | decision + build | Owner decision |
| S16 | Round tables: fact or derived | decision | Owner decision, gates G2, G5, S06 |
| S17 | Prune tick rows | build | Contingent — see §4 |
| S18 | Encounter fact build | build | **Deferred**, not in sprint |
| S19 | Reconcile FOLLOWUP | build (docs) | Ships early |
| S20 | Drop unused tick columns | build | **Parked** by owner |

## 2. Dependency structure

```
Early, no gate:
  S11 (sample once)          S13 (UI reads)          S19 (FOLLOWUP)
  S12 waits on S08 baseline

Spikes (run in parallel):
  S01 ─G1─┐
  S02 ─G2─┼──> S09 (damage side) ──┐
  S03 ─G3─┼──> S10 (alive count)   │  (S10 also needs G8)
  S04 ─G4─┤                        │
  S05 ─G5─┼──> S16 (round tables)  │
  S06 ────┤                        │
  S07 ─G7─┘──> S18 (encounters, deferred)
  S08 ─G8───> S10, S12, S14 (need scale baseline)

Presence gate (owner ruling):
  S02 (presence data) ──> S21 (G9) ──> S10 (alive rule), S17 (as-of reads)

Build, after gates:
  S09 + S10 + G2 + G3 + G9 + HP-kept ──> S17 (state-change pruning)
  S03 + S08 ──> S14 (parallel sweep)
  S08 ──> S12 (async flush)

Owner decisions (independent of code):
  S15 (storage wipe bundle), S16 (round tables), S17 (pruning), S20 (parked)
```

G-numbers are the gates: a spike's recorded answer releases its dependents.
Dependents do not start on an unrecorded or negative answer.

## 3. Order to work them

**Wave 1: now.** No dependencies.
- Spikes S01, S02, S03, S04, S05, S06, S07 in parallel.
- Ship S11 (parse sample reuse), S19 (FOLLOWUP reconcile).
- S13 implementation, with the human GUI measurement as its acceptance step.
- S08 data acquisition: start immediately, because it blocks several stories.

**Wave 2: after spikes return.**
- S09 once G2 and G3 are recorded.
- S10 once S09's pattern is proven and G8 is recorded.
- S12 and S14 once S08 baselines exist.
- S16 decision once G2, G5 and S06 are recorded.

**Wave 3: contingent.**
- S17 (state-change pruning) only if S09 and S10 land, G9 is ruled, and HP stays
  on the retained rows. G1 no longer gates it. The owner also decides on
  round-boundary rows.
- S15 wipe bundle applied in one wipe, after the owner decides on the steam
  index and `WITHOUT ROWID`, and after any other schema change in this sprint
  is ready. The wipe should happen once.

**Not in sprint:** S18 (deferred until S07 returns go and the owner enqueues),
S20 (parked by owner).

## 4. Gates and what each one changes

| Gate | Spike | If positive | If negative |
|---|---|---|---|
| G1 | S01 | An event-derived HP path exists for performance; `hp` stays in the tick table either way (owner decision) | HP read stays on tick rows; no change to S17 |
| G9 | S21 | Presence rule chosen; the value diff is recorded and ratified (or none) | S10 and S17 cannot ship; the alive rule and as-of reads stay blocked |
| G2 | S02 | Round tables and tick rows are reconciled; S09/S10 proceed | S09/S10 need a fix to the source data first (may be a parse bug) |
| G3 | S03 | Harness trusted; column drops can be tested | Column drop claims are unverified |
| G4 | S04 | A speed tolerance is defensible; dedup is worth considering | Dedup scrapped; S17 uses only event rows |
| G5 | S05 | `equip`/`spent` derivable (or not) | Round tables stay sampled facts (S16 default) |
| G7 | S07 | Encounter build can be scheduled | S18 stays deferred, or is redesigned around the format answer |
| G8 | S08 | Timing and scale baselines are trustworthy | Parse, sweep and rule numbers stay 7-match only |

## 5. Knowledge horizon: what this sprint does NOT cover

This is the honest part. The plan is partial by design, and these items limit
it.

**Data.**
- All numbers so far come from a 7-match snapshot. Rule checks (the inclusive
  kill tick, the roster rule) have not been tested at scale. S08 needs a library
  of 50+ matches, which does not exist in this environment. **If S08 cannot get
  data, every contingent story (S10, S12, S14, S17) stays blocked or runs on
  unproven rules.**
- The golden import timing (19.1 s) may include sweep contention. S08 is the
  only correction.

**Unexplained observations.**
- 9,244 tick rows have no `round_player_sides` match (S02).
- 20 `money_start` values differ from the first tick row (S02).
- Neither has an explanation yet. Either could be a parse-time bug that
  changes stored data for existing libraries.

**Presence semantics (new, the largest correctness question).**
- Pruned rows cannot tell "player not present" from "no change". On match 4,
  round 23, a player with no rows after tick 136,597 makes the as-of and exact
  counts differ in 2 of 324 cells. Whether that is typical is unknown (S02, S21).
- Any ruling that changes values needs ratifying first (S21).

**Tier-2 (encounter) size is unknown.**
- The owner expects encounters to be far smaller than `player_ticks`. The
  merged-window coverage that would confirm this has not been measured (S07).
  Unmerged scenarios range from 41k to about 1 M rows on match 4, so the answer
  depends entirely on the merge rule.

**HP is kept on purpose.**
- No story removes `player_ticks.hp`. The event-derived path (S01) is a
  performance option only, and it is not required by any current metric.

**Unverified claims.**
- Clutch HP fallback parity (S01).
- Equipment and spend derivability (S05).
- Speed tolerance (S04).
- Analysis-table inputs (S06). The 105-metric blast radius is an upper bound.
- Static metric-reference analysis was regex-based. Only the ablation harness
  (S03) would catch missed references.

**Not measured.**
- The frontend: Wails bridge overhead and render time.
- Windows timing, and fsync cost on the user's disk.
- Parallel sweep in Go (S14 is proven in Python only).
- The async flush under a real concurrent import queue (S12).
- Encounter tracer speed, coverage fraction, and CS2 BSP format (S07). The
  manifesto's sizing claim ("same order as `player_ticks`") is unproven, so the
  encounter fact may not save space at all.

**Owner decisions still open.**
- Presence semantics for pruned rows (S21, gate G9). Blocks S10 and S17.
- Round-boundary rows (S17).
- Steam-range read importance (S15).
- Round tables as facts or derived (S16).
- Round-boundary rows and pruning (S17).
- Column pruning un-parking (S20).
- Encounter enqueue (S18).
- Kill tags naming (FOLLOWUP).

**Source-document gaps.**
- `FOLLOWUP.md` (checked in S19): two items are stale, the Go clutch detector
  and the `metrics` table's scope columns (the plugin side is still open). The
  economy view decision is effectively made but unrecorded. Several items are
  still open, including the `duplicate()` action, the `alive_count` label,
  `metricorder.js` naming, the covering index and `WITHOUT ROWID`, counter-strafing
  sourcing, `Library.svelte`, the kill tags naming, and the backend component
  read cache.
- Not checked in FOLLOWUP: delete over-invalidation (r31), the save-gate bind
  handling for reserved binds in subqueries and CTEs, the WebKitGTK and CSP check,
  the teamkill gate tests, and the retired-key absence checks. Each could be
  stale or a real correctness issue, and each needs its own check.
- The wipe-time snapshot diff (FOLLOWUP "Verification still owed") has no record
  in the repo. Whether it ran is unknown.
- Some FOLLOWUP evidence lives outside the repo (`~/Programming/spectra-verify/`)
  and does not exist on this machine, so it cannot be checked.
- `PERF.md` and `PRUNE.md` were written from subagent reports; the UI report
  never reached a file, so the UI numbers come from a hand-back message only.
- The encounter manifesto has not been checked against the current HP and
  velocity needs beyond what `PRUNE.md` records.

**Risk if the sprint is partial.** The early wave (S11, S13, S19, spikes) is
useful on its own. The contingent wave depends on several gates that may not
resolve, so the realistic outcome is that the early wave ships and the
schema-changing work waits for data and decisions.

## 6. Status log

**2026-11-21, autonomous pass (Wave 1).** Uncommitted, on `main`.

| Story | Result |
|---|---|
| S19 | Done. FOLLOWUP reconciled: stale clutch item removed, economy view recorded as decided, open items given paths. Not-checked items remain listed in S19. |
| S11 | Implemented in `extract.go`. Sample once per frame. `player_ticks` fingerprint and sidecar bytes identical to baseline on `de_cache`. `TestGoldenPlayerTicks` passes. Import saving not measured (machine busy; S08 blocked). |
| S01 | Result: health branch 33 of 33 exact; fallback 11 of 12, one case counts post-round damage (tick 151902 > end 151868). Gate G1 positive, with the fallback bound as a prerequisite (value change needs a ruling). |
| S02 | Result: 9,244 unmatched rows = 3 mid-round bot joins (no side samples). 20 money mismatches = OT round 25 in two matches (cause probable, not proven). The "match 4 round 23 gap" is a 100-tick tail after round end, not a mid-round gap. |
| S04 | Result: saved share 58.1% exact, 68.2% at 0.01, 71.2% at 0.1, 78.3% at 1.0. Start/stop check not run; G4 not decided. |

**Scratch snapshot.** The 7 golden demos were imported into a scratch XDG
instance (outside the repo) and used for S01, S02, S04 and S11. Their `match_id`s
are import order, not the owner's numbering.

**Not started this pass.** S03 (harness), S05 (equipment and spend), S06
(analysis inputs audit), S07 (encounter tracer and BSP format).

**Needs the owner.**
- S13 needs a human GUI acceptance step. No GUI is used here, per AGENTS.md.
- S08 needs a 50+ match library. It does not exist in this environment.
- S21 and S16 are owner rulings. S02 raised the presence question, and S01 raised
  the fallback post-round bound, which needs a ruling before any value change.
- The FOLLOWUP "match 4 round 23" presence case should be checked against the
  original snapshot (its numbering is not this one).

## 7. Status, second pass (2026-11-21)

Owner rulings applied:
- **S01 fallback bound:** accepted and fixed (`clutch_sql.go`). Fallback 12 of 12.
- **Bot filter (S02):** `is_bot_key(steam_id)` SQL function added
  (`src/internal/store/botkey.go`, rule in `models.IsBotKey`). Applied only to
  single-human reads. **Not** applied to `GetRoundPlayerSides`: enemy bots
  matter to trade opportunities, and filtering them broke the trade-opp
  equivalence test. Bots present at freeze end do have side rows.
- **Engagements rename:** done. "Kill tags" everywhere: table `kill_tags`,
  Go `KillTag`/`KillTags`, JS `killTags`, kebab `kill-tags`, UI "Kill tags".
  Existing dev libraries need a wipe and re-import.
- **Worktrees:** pruned. 64 clean worktrees and their merged branches removed.
  Seven worktrees with uncommitted work were kept (see below).
- **Speed (item 7):** the pain point. Priority is the start/stop check for S04
  tolerance. `WITHOUT ROWID` (S15/S20) is deprioritized.
- **Exact-tick joins (item 5):** the side join can use round sides (identical
  on the snapshot). Alive state can use as-of if pruning allows. Speed has no
  current exact-tick reader. See S04.
- **Deferred by owner:** S05 (until derivation is attempted), S08 (no matches
  available), S13 (TTY, no GUI). S16 stays sampled.

Findings:
- **Presence case resolved:** post-round leave in the final round of de_cache.
  Every round has a ~7 s post-round tail (678,930 rows, 6.9%).
- **OT money:** `money_start` in OT round 25 is the round-24 final money (stale).
  The tick sample (10000) is right. Needs a ruling for the 20 cells.
- **BSP:** `bsp-tracer` reads CS:GO BSP. CS2 maps are Source 2 vmaps with
  embedded physics. Not applicable as it stands (S07, CS2.md).

Needs a ruling:
1. **Discard post-round tick rows** (S17). Changes stored rows, 6.9%.
2. **OT `money_start`** (S02). Set to the reset value, or derive from the tick sample.
3. **Bot-side filter scope.** Confirm that bots stay in side reads (as now),
   and that only human-profile reads filter them.

Not done this pass: S03 (harness), S06 (analysis inputs audit).

Still dirty, not pruned (owner call): 7 worktrees with uncommitted work,
listed in the chat summary.

## 8. Rulings applied, third pass (2026-11-22)

- **Post-round ticks:** kept. **Post-match ticks:** dropped (17,101 rows on the
  snapshot). Implemented in `store.SettleMatchRows` (S17).
- **OT `money_start`:** taken from the first tick of the round (S02, option B).
  20 cells change.
- **Bot filter:** the per-player reads that did nothing are removed.
  `is_bot_key` stays as a tested function. No current read needs it.
- **Worktrees:** the seven dirty ones are archived to
  `~/Programming/spectra-archive/worktrees/` (diffs and untracked files), then
  removed. Only the main checkout remains.
- **Wipe:** owner will wipe when launching the app (kill tags rename needs it).
- **Stale integration test:** `TestBuiltinMetricsPreview` updated to the
  current schema. Scope is derived from the binds. The 147 / 114 / 33 contract
  still holds.
- **CS2 geometry options (S07, CS2.md):** ValveResourceFormat (C#, MIT) is the
  candidate. Shelling out is cheaper than a Go DMX port. Spike: export
  `de_cache` collision with VRF, count triangles, time a ray batch.
