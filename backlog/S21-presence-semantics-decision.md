# S21 — Decision: presence semantics for pruned tick rows

**Type:** decision (owner ruling, with a spike feeding it)
**Gate:** G9
**Depends on:** S02 (presence-gap measurement), S03 (harness)
**Source:** `source/PRUNE.md` (research item 12, "As-of lookup on pruned rows")

## Goal
Decide how a player with no tick row at a given tick is counted, once rows are
pruned to state changes. Every as-of rewrite (S10, S17) depends on this.

## Background
- A state-change policy stores a row only when something changes. An exact-tick
  read cannot tell "player not present" from "no change".
- As-of lookups recover the state. They do not recover presence.
- On match 4, round 23, one player has no tick rows after tick 136,597. The
  exact-tick count and the as-of count differ there. The other 322 of 324
  alive-count cells agree.
- Keeping today's values exactly in gap cases would mean keeping per-frame
  presence, which is the row itself.

## Options
- **(a) Keep per-frame presence.** Store a presence marker per player per tick.
  Costs most of the saving; values unchanged.
- **(b) Accept the as-of result.** Values change in gap cases. Record the changed
  cells and ratify them under the migration rule.
- **(c) Exclude players with a gap.** Values change in gap cases, and the rule
  needs a definition of "gap" (for example, no row for a set number of ticks
  while the round is live).

## Work
- Take S02's presence-gap measurement (how often, how long, why).
- Quantify the value diff under (b) and (c) on the snapshot, with S03.
- Owner rules.

## Acceptance
- A recorded ruling, with the chosen option, the reason, and the expected value
  diff.
- If (b) or (c): the diff is listed and ratified before S10 or S17 ships.

## Unblocks
S10 (rule for the alive-count rewrite), S17 (as-of reads on pruned rows).

## Not covered
Gap frequency beyond the snapshot is unknown (S08). The ruling may need to be
revisited at library scale.

## Update (2026-11-21): the presence case is a post-round leave

The motivating case (the "match 4, round 23" gap) is the match-end tail of
de_cache in the pre-dogfood snapshot (its round 23 is the final round). Players
leave after the round ends. The gap is not a mid-round presence gap. See
`S02-tick-round-reconciliation-spike.md`, "Presence case, resolved."

Consequence: the presence rule for pruned rows (S21) may be settled by the
post-round discard in S17 instead, if the owner rules that discard. That
would leave mid-round absence as the only case, and no mid-round gap was
found on the snapshot. Of the 11 player-rounds that stop more than 1 s early,
3 are bot keys. The 8 human-key ones (gaps 0.3 to 34 s) are NOT yet checked
against the event log; only the de_cache case above is.

## Ruling (2026-11-22): safe option

Owner: the safe option for now. Absence is absence. A player with no row at a
tick is not present there, and no value is inferred from the last row. Pruning
that relies on "no row means no change" is not done. Other pruning strategies
may come later.

## Investigation (2026-11-23): what the "gap" actually is

- Match 4 is `golden/de_dust2.dem.zst` (sha256 matches). It has 17 counted rounds and no round 23.
- The round 23 case is in match 3, and S02 already says it is a tail difference after round end
  (last row 100 ticks after end_tick), not a mid-round gap.
- Across the snapshot, the rows that stop early before round end: 11 player-rounds. 3 are bots
  (mid-round join or leave). 8 are humans, stopping 167 to 2,178 ticks (about 2.6 to 34 s) before
  round end. Each of the 8 has a `player_disconnect` event for that player within 640 ticks of the
  last row, and none has a death near the last row. The 8 are disconnects, not presence gaps.
- Consequence for the roster rule (S10): it counts a disconnected player as alive until a kill
  removes them. That is wrong. The roster rule has to remove a player at their disconnect as well.
- No mid-round internal gaps longer than one second exist in the snapshot's player_ticks.

## Follow-up (2026-11-23): the roster rule resolves the alive-count consumers

The alive-count and clutch consumers can use the roster rule in S10 (roster minus kills and disconnects within
the round). It reproduces all 2,222 stored alive-count cells on the snapshot. Presence in tick rows is not needed
for those consumers once S10 is built.

## Owner amendment (2026-11-23)

- Target: "no row means no change in state" for player_ticks. Pruning on state change is the intended design, not a workaround.
- Presence (who is alive, who is in the round) comes from the roster (round_player_sides), kills and disconnect events, never from row absence.
- Frames that were never delivered are data gaps. They are not state changes. The 13 post-round kill ticks with no frames are one such gap class (World self-kills after round end).
- Post-round ticks follow the same state-change rule as every other tick.
- Dense per-tick facts (speed, weapon, in-air) live on encounter_window_samples, not on player_ticks.
