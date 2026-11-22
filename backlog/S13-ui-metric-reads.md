# S13 — UI: fewer metric reads per view

**Type:** build (frontend only)
**Depends on:** none for the code; human GUI measurement for acceptance
**Source:** `source/PERF.md` (layer 3, options 1 and 2)

## Goal
Cut the number of backend calls per view: History reads a series in one call,
and `getMetricStates` is coalesced per scope.

## Background
Each `metric()` read in a component makes an uncached `getMetricStates` call
(about 48 ms each). A cold Match Overview spends about 0.6 s on backend calls;
a 100-row History about 25 s. `getMetricSeries` exists and is unused by the UI.

## Work
- `HistoryPanel` uses `getMetricSeries`, with one state read per panel.
- Coalesce state reads per (scope, id) in `componentruntime/readapi.js`, with a
  short-lived dedupe and no TTL.
- Do not add a cache with a TTL here. Stale-state bugs are the risk.

## Acceptance
- Call counts per view reduced (measured with the harness in `scratchpad`).
- **Human GUI measurement** (AGENTS.md: agents do not drive the GUI): time cold
  and warm Overview, Scoreboard, and History at 100 rows.

## Not covered
Wails bridge overhead and render time are unmeasured. The 25 s History figure
is an extrapolation.
