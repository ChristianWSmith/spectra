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
