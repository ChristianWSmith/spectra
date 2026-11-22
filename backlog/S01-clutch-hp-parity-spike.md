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

## Result (2026-11-21, scratch snapshot)

Snapshot: the 7 golden demos in `golden/`, imported with the current code into
a scratch instance (`match_id` 1..7 in import order: ancient, anubis, cache,
dust2, inferno, mirage, nuke). Queries used the production `clutchCTE` text
(`src/internal/store/clutch_sql.go`) with `:match_id` substituted, plus a
per-clutch join to `player_ticks` and to damage events.

| Measure | Count |
|---|---|
| Clutches (matches 1–7) | 183 (matches the FOLLOWUP "183 of 183" parity) |
| Lost clutches (HP branch not used, `hp_left` = 0) | 138 |
| Not lost, with a health-carrying damage event at or before end tick | 33 |
| …of which tick HP equals that event's `health` | **33 of 33** |
| Not lost, no health event (fallback `100 - summed damage`) | 12 |
| …of which fallback equals tick HP | 11 of 12 |

**Mismatch and cause.** One fallback case: match 7, round 23, victim
`76561198067705522`. The round's `end_tick` is 151868. A damage event at tick
151902 (34 ticks after the end; `attacker` empty, `damageTaken` 48, `health`
52) is summed by the fallback because the fallback's bound is
`(e.how = 'round' OR dh.tick <= e.end_tick)`: a `round` outcome has no upper
bound. The fallback gives 52, tick HP at the end tick is 100.

**Recommendation.**
- Health branch: an event-derived HP path matches tick HP exactly on this
  snapshot. It is usable as a performance option. `hp` stays in the tick tier
  (owner decision).
- Fallback: the post-round damage inclusion is a real defect. Fixing it changes
  one stored `hp_left` value on the snapshot, so it needs a recorded ruling
  before the change (migration rule). Not changed here.
- Gate G1: positive for the health branch, with the fallback fix as a
  prerequisite for any event-derived path that uses the fallback.

**Not covered.** Seven matches only. Healing and the health-field semantics
were not tested beyond this snapshot.
