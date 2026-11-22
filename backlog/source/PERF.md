# Performance review: the dogfood migration

Status: research notes, untracked. Nothing in the repo has been changed for
this review. Every number comes from a 7-match snapshot of a real library
(scratch copy, never the live database), on the HEAD of this review, with the
app's own driver (modernc) unless marked otherwise. Treat all figures as
indicative until re-run at library scale.

Scope: the migration range `0c15508e^..HEAD` (pre-migration parent versus
current). The goal is to find what was lost, what the new paradigm makes
cheaper, and what to do first.

## Summary

- **Import regressed about 2x.** The golden demo went from about 9.1 s before
  the migration to about 19.1 s now (three runs each).
- **The sweep is slower than the SQL alone suggests.** A full Go sweep of 147
  metrics takes about 14.2 s on the snapshot. A CLI measurement earlier had
  suggested about 5 s; the CLI number was misleading.
- **The UI is call-count bound.** Each `metric()` read in a view costs about
  48 ms of uncached coverage work, and views issue many of them. A cold Match
  Overview spends about 0.6 s on backend calls, and a 100-row History panel
  about 25 s. The old views batched these reads.
- **Several fixes are cheap.** Two are frontend-only; the import fixes need no
  schema change.

## Ranked options

| # | Change | Layer | Estimated gain | Schema change? | Status |
|---|---|---|---|---|---|
| 1 | History panel via existing `getMetricSeries`; one state read per panel | UI | History 1.7 s to about 10 ms at 7 rows | No | Estimated from backend timings; not timed in GUI |
| 2 | Coalesce `getMetricStates` per scope in `readapi` | UI | Overview 0.6 s to about 0.05 s | No | Estimated |
| 3 | Parallel unit execution in the sweep | Metrics | About 2.5 to 3x on the sweep | No | Python thread test only: 2.2 s at 1 worker, 0.7 s at 4 |
| 4 | Sample once per frame, shared across sinks | Parse | About 1.6 s on import (19.1 to 17.5 s) | No | Prototype; tick fingerprints identical |
| 5 | Async tick flush with bounded channel | Parse | About 1.4 s more (17.5 to 16.0 s) | No | Prototype; needs abort and error handling before it can ship |
| 6 | Drop `idx_player_ticks_steam` if no reader needs it | Storage | −41 MB per match; 0.5 to 1 s ingest | Yes (wipe) | No production steam-only reader found; confirm by grep first |
| 7 | `WITHOUT ROWID` on `player_ticks` | Storage | About −49 MB per match; about 0.6 s ingest | Yes (wipe) | Micro-bench; design doc records +36% on subject-range reads |
| 8 | Index `player_ticks(match_id, round, tick)` | Metrics | Unknown | Yes | Untested; ANALYZE alone made the clutch query worse |
| 9 | Batch profile `metric()` refs per steam | Metrics | About 0.7 s | No | Estimate |
| 10 | Multi-row VALUES for tick inserts | Parse | About 0.4 s | No | Micro-bench |

Options 1 and 2 are the best value for what the user feels. Option 3 is the
largest backend lever. Options 4 and 5 are the largest import levers.

## Layer 1: tick state and parse time

**Where the import time goes.** Per-frame work runs up to four sinks: positions,
state, voice, and ticks. Each walks the player list, and the tick sink repeats
the position and state sampling that the other sinks already did. About 1.9 s
of the regression is this duplicated sampling. `TickWriter.flush` is
synchronous on the parse thread and costs about 5.6 s of CPU; it is most of
the rest. The sidecar writers are about 1% of CPU and are not the problem.

**Storage.** About 9.8 M rows across 7 matches, roughly 1.4 M per match. About
164 MB per match: 74 MB table, 49 MB primary-key index, 41 MB steam index.
The primary-key index duplicates the table's key.

**Reads.** Tick-based queries are cheap at this scale: events joined to ticks
about 1.6 ms, clutch CTE about 3.6 ms, a full-match speed and in-air
aggregate about 65 ms. Library-scale behaviour is untested.

**Insert micro-benchmark** (1.33 M rows, modernc driver): row-by-row 5.2 s;
multi-row 500 per statement 4.8 s; `WITHOUT ROWID` 4.6 s; no steam index 3.7 s;
deferred steam-index build 4.7 s total.

**Decision still open.** Full 64 Hz tick density is the recorded decision.
Lowering the rate would cut rows sharply, but it changes the data, so it is
not an optimization to make silently.

## Layer 2: metrics system (sweep)

**Sweep cost.** Full Go sweep of 147 metrics: 14.2 s, all succeeded. A second
sweep with nothing stale: 48 ms. Raw-SQL metrics (111, 3,259 units) take about
13 s of that. `metric()`-reference metrics (36) take about 1 s in Go, and about
0.05 s as raw SQL.

**Where it goes.** Units are one per library, 7 per match, 58 per human player,
and 153 per round. Round units are about 74% of raw time. Per unit, driver
execution dominates; the gate costs 30 to 75 µs, and commits are small.
Prepared-statement caching gave no gain. modernc is about 2.7x slower than C
SQLite on the same statements.

**Clutch.** The six clutch metrics each recompute the clutch CTE. That is at
most about 3% of time, so caching it is low value. The earlier "gate error"
on `clutch` came from a match-scope harness that didn't supply `:round`; the
sweep supplies both binds and does not hit it.

**Recompute cost.**
- One imported match invalidates about 700 units, roughly 2 s (estimate, not
  run against a real import).
- A rule change bumps nearly the whole catalogue, so it is roughly a full
  sweep.
- A metric edit affects that metric and its dependents only.

**Parallelism.** The sweep runs units sequentially on a 16-core machine.
Parallel execution was tested in Python only (round jobs 2.2 s at one worker,
0.7 s at four). Go parallelism is unverified and has to respect the single
writer and per-metric ordering.

## Layer 3: UI

**Call amplification.** Each `metric()` read makes three calls: list (cached),
values (cached per metric), and states (uncached). The states call reaches
`store.MetricCoverage`, which scans every metric with correlated EXISTS and
runs a COUNT per metric. It costs about 48 ms per call and is never memoized.

Per view, from code reading and scratch timings on the snapshot:

- Match Overview: about 12 `metric()` reads, about 0.6 s on the backend.
- Scoreboard: 19 reads, about 0.9 s.
- Economy: one read per round, about 25 to 30 calls (extrapolated).
- Profile History: up to 5 reads per row, up to 500 calls, about 25 s at 100 rows.

Concurrency does not help: seven concurrent state calls take about as long as
seven serial ones. The old views made one batched values call and one state
call; the History panel's `getMetricSeries` already exists and is unused by
the UI.

**Reactivity.** Profile panels each reload on `spectra:metric-done`, so six
panels re-run their reads per sweep. Job progress (about every 100 ms during
import) clears the read cache, so cache hits are rare while importing. Match
tab panels do not subscribe to metric-done, so cells can stay stale until
remount; check whether that is intended.

**Compile.** Components compile in a Worker and are cached by source hash in
an unbounded map. The live check compiles the same source twice per save (once
in the save gate, once in the preview). Compile time itself is unmeasured.

**Render.** Builtin tables are small (at most 10 players by 19 columns), and
the trend sparkline has at most about 100 points, so virtualization is not
needed at these sizes.

**Cache.** A frontend `cachedRead` exists, but it excludes states and
componentQuery by design. A memoized coverage keyed by a data generation
counter would remove most of the states cost, but it is the highest-risk change
because of stale-state bugs.

## Layer caveats and corrections

- **Sweep contention.** The profiled import ran concurrently with a
  `metrics.Sweep`. The 19.1 s golden figure may include that contention and
  be inflated. Re-time with the sweep disabled before trusting the deltas.
- **Clutch gate error.** Not reproduced on HEAD. The sweep gates with
  `allRawBinds` and supplies both binds for round scope.
- **Earlier "ruled out" claim.** The sweep's SQL was previously reported as
  about 5 s total from CLI timings. The Go sweep is about 14 s. The sweep
  matters.
- **Python rewrite.** The Python timings for `metric()` refs mirror
  `store.MetricRefSQL` by hand and have not been diffed against Go output.
- **Scale.** All numbers are from 7 matches. Nothing is verified at 50 or
  1,000 matches.

## Not verified

- Go parallel sweep; the Python test is only a proxy.
- The planner index for round statements; ANALYZE results were mixed.
- A real import's invalidation count and time.
- Rule-change affected subset (reasoned, not run).
- Frontend timings: Wails bridge overhead and render time.
- Compile time and the double-compile cost.
- Combat, Utility and Heatmaps views were not reviewed in depth.

## Measure in the GUI (run by a human; agents do not drive the GUI)

Per AGENTS.md, GUI checks are only run on request, in a solo pass.

1. Open a match Overview cold and warm. Record time to all panels loaded and
   the bridge call count (devtools Performance).
2. Time the History panel for the player with the most history rows.
3. Start a sweep, open the Match tab, and check whether cells update after
   metric-done.
4. Time one worker compile of a 200-line component, and confirm the double
   compile on save and preview.
5. Time a user component calling `spectra.metric` 20 times.
6. Open a Profile during an import and watch CPU.
7. Repeat items 1 and 2 on a library with 50+ matches to test scaling.

## Next steps

Suggested order, lowest risk first:

1. Re-time the golden import with the sweep disabled, to settle the contention
   question.
2. Frontend: switch History to `getMetricSeries`; coalesce `getMetricStates`
   per scope. Frontend only.
3. Remove the duplicated sampling in the extract path (prototype exists).
4. Make the sweep's unit execution parallel in Go, respecting the writer.
5. Decide the tick-table schema change (steam index, `WITHOUT ROWID`) and
   bundle it into one wipe.
6. Put the async tick flush behind proper abort handling, then measure.

Supporting material is in the scratch directory
`/tmp/claude-1000/-home-christian-Programming-spectra/78819d30-9d9d-4403-a80f-4e41e1afed85/scratchpad`
(reports `report-1-tick-state.md` and `report-2-metrics.md`, prototypes and
benchmark scripts).
