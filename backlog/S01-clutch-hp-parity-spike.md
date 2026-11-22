# S01 — Spike: clutch HP without tick rows

**Type:** spike (research, gate G1)
**Source:** `source/PRUNE.md` (option 8, research item 1); `source/PERF.md`

## Goal
Find out whether the clutch family's HP can also be derived from
health-carrying damage events, for performance. This is an option, not a
requirement.

**Decided (owner):** HP stays in the tick tier. This spike must not remove
`player_ticks.hp`, and no story may drop it unless the owner rules otherwise.
HP is kept so that performant visibility to HP is not lost before a future
metric needs it (`source/PRUNE.md`, "HP is kept on purpose").

## Background
The clutch CTE's HP branch reads the last tick HP at or before the clutch's end
tick when a damage event carries `detail_json.health`. Otherwise it falls back
to `100 - summed damage`. Only the first branch touches tick rows.

## Work
- Compare, for every clutch in the snapshot and on any other library available:
  current HP (tick) against the last health-carrying damage event at or before
  the end tick.
- Record mismatches and their causes (timing at the end tick, healing, dead
  players, round-end boundary).

## Acceptance
- A parity table: clutches tested, exact matches, mismatches with causes.
- A recommendation on a performance path only: keep the tick read, or add the
  event-derived path as an alternative. Either way `hp` stays in the tick tier.
- Output recorded as a short report in `backlog/` (not in the repo's code).

## Unblocks
Nothing in the pruning path is blocked by this any more. Its result only
decides whether an HP read can avoid tick rows for performance. HP-in-encounters
is off the table (`source/PRUNE.md` option 8).

## Not covered
Tested on the 7-match snapshot only. Whether the fallback branch is ever hit
at scale is unknown.
