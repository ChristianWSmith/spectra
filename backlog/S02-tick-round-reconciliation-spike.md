# S02 — Spike: reconcile tick rows with round tables

**Type:** spike (research, gate G2)
**Source:** `source/PRUNE.md` (research items 2, 3); `source/PERF.md`

## Goal
Explain the two unexplained mismatches between `player_ticks` and the round
tables, which gate S09, S10 and S16.

## Background
- 9,244 tick rows have no matching `round_player_sides` row.
- 20 of 1,522 `round_player_money.money_start` values differ from the first
  tick row's money.
- **Presence gaps.** In match 4, round 23, one player has no tick rows after
  tick 136,597 while the round continues. This affects as-of results (322 of 324
  alive-count cells match; the two that don't are this gap). Presence gaps may
  be the same class as the 9,244 unmatched rows.

## Work
- Classify the 9,244 unmatched rows: bots, uncounted rounds, roster gaps,
  steam-ID scrubbing, or other.
- Classify the 20 money mismatches: sample timing, freeze-end ordering, or sink.
- Measure presence gaps across the snapshot: how many players have rows that
  stop before the round ends, and why (disconnect, takeover, parse gap).
  Feed the result into S21.

## Acceptance
- Each unmatched row class has a stated cause and a count.
- A decision on whether `round_player_sides` is safe as the side source for
  the rewrites in S09 and S10.

## Unblocks
S09, S10 (correctness of the side and roster sources), S16 (round-table
decision).

## Not covered
Snapshot only. If the cause is a parse-time bug, the fix is a separate story
and may change stored data for existing libraries.

## Result (2026-11-21, scratch snapshot)

Same 7-match scratch snapshot as S01. Note: `match_id` numbering here is
import order, so the owner's "match 4, round 23" is `match_id` 3 (de_cache)
in this snapshot.

**Unmatched tick rows (9,244 of 9,817,283).** All 9,244 are one bot
player-round set: three synthetic bot keys (`0xFF00…0C`-prefixed, `players.is_bot = 1`),
one round each:

| match | round | bot | tick rows |
|---|---|---|---|
| 4 (dust2) | 2 | Rebel | 3,404 |
| 5 (inferno) | 9 | Stone | 2,194 |
| 7 (nuke) | 4 | Crew | 3,646 |

Cause: each bot appears through `player_connect` (`bot: true`) at tick
9871, 63713 and 25155, which is after the round's freeze-end sample. The
side sampler (`agg.go`, `roundSides`) writes one row per participant at freeze
end, so these bots never get a `round_player_sides` row. Human player-rounds:
1,530 of 1,530 matched. Bots with a `round_player_sides` row: 0.

**Money mismatches (20 of 1,522 `round_player_money` rows).** All 20 are in
round 25 of match 1 (de_ancient) and match 7 (de_nuke), the first overtime round
in each. The first tick row for each player reads `money = 10000` and stays
there for about 470 ticks, until the buy phase, while `money_start`
(`m_iStartAccount`) is the real account (e.g. 6150). Cause: probably the
overtime money reset is visible in the tick sample before the game's start
account. Classified as sample timing / OT reset, **not proven**: no other
mechanism was tested.

**Presence gaps (S21 input).** Across 1,533 player-rounds, 11 stop more than 1 s
(64 ticks) before the round's `end_tick`:
- 3 are the bot keys above (mid-round join or leave).
- 8 are human-key rows, gaps from 0.3 s to 34 s.

**The "match 4, round 23 gap" does not reproduce as described.** In this
snapshot it is `match_id` 3, round 23 (`end_tick` 136497). The player's last row
is at tick 136597, 100 ticks after `end_tick`, and the other players' rows
run to 136688. So this is a tail difference after the round's end, not a
mid-round gap. The owner should check this against the original snapshot before S21
uses it.

**Decision on `round_player_sides` as the side source (S09, S10).** Safe for
human players. Bots that join mid-round have no side row, so S09 and S10 must
treat a missing row as "bot / mid-round join" and must not read a missing side
as a human.
