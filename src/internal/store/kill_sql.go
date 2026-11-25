package store

// killsCountedCTE is the ONE copy of the counted-kill fold that the kill
// metrics read: every kill event of a match outside post-match time, joined to
// its killer's and victim's sides and assister's side, with the fake-kill
// flag (a world-damage self kill that is the disconnect tick of the player who
// left). Its outer filters decide which kills a metric counts, so the CTE
// carries the full column set and a metric names only the columns it needs.
//
// The dc join is keyed by match and disconnect tick; the match-scoped DISTINCT
// keeps one row per kill. schema.sql holds killsPlaceholder where the CTE goes
// (the metric's own `WITH k AS (...)`), and applySchema splices this text in
// with quotes doubled, so every kill metric reads the same rule.
const killsCountedCTE = `k AS (SELECT e.match_id, e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash, {{FAKE_KILL}}, sa.side AS a_side, sv.side AS v_side, ss.side AS s_side FROM events e LEFT JOIN (SELECT DISTINCT match_id, attacker, tick FROM events WHERE match_id = :match_id AND kind = 'player_disconnect') dc ON dc.match_id = e.match_id AND dc.attacker = e.victim AND dc.tick = e.tick {{SIDE_JOIN:sa:e:attacker}} {{SIDE_JOIN:sv:e:victim}} {{SIDE_JOIN:ss:e:assister}} WHERE e.match_id = :match_id AND e.kind = 'kill' AND e.post_match = 0)`

// killsPlaceholder marks the counted-kill CTE inside a schema.sql metric expr.
const killsPlaceholder = "{{KILLS_CTE}}"

// killsCountedEKCTE is the counted-kill rule: the kills a metric counts are the
// k rows that are not self or team kills and not fake (the disconnect self
// kill). It follows killsCountedCTE in a metric's WITH list, as ek.
const killsCountedEKCTE = `ek AS (SELECT * FROM k WHERE attacker <> '' AND attacker <> victim AND fake = 0 AND {{TEAM_FREE}})`

// killsEKPlaceholder marks the counted-kill rule inside a schema.sql metric expr.
const killsEKPlaceholder = "{{KILLS_EK}}"

// killsCountedAKCTE is the counted-assist rule: the k rows that credit an
// assist. A kill credits its assister unless the assister is the killer or the
// victim, the kill is not self or team, not fake, and the assister is not on the
// victim's side. It follows killsCountedCTE in a metric's WITH list, as ak; the
// flash flag stays a metric's own filter (assisted_flash = 0 or = 1). Shared by
// the assist metrics, so the rule is written once.
const killsCountedAKCTE = `ak AS (SELECT * FROM k WHERE assister <> '' AND assister <> victim AND attacker <> '' AND attacker <> victim AND fake = 0 AND {{TEAM_FREE}} AND NOT (COALESCE(s_side, '') <> '' AND s_side = v_side))`

// killsAKPlaceholder marks the counted-assist CTE inside a schema.sql metric expr.
const killsAKPlaceholder = "{{KILLS_AK}}"

// killsCountedEKRCTE is the per-round kill count of the counted kills: one row
// per (match, round, attacker) with the number of counted kills, as ekr. The
// multi-kill rounds (two_k … five_k) fold it; it follows killsCountedEKCTE in a
// metric's WITH list.
const killsCountedEKRCTE = `ekr AS (SELECT match_id, round, attacker, COUNT(*) AS c FROM ek GROUP BY match_id, round, attacker)`

// killsEKRPlaceholder marks the per-round counted-kill count inside a schema.sql metric expr.
const killsEKRPlaceholder = "{{KILLS_EKR}}"

// killsRoundCTE is the counted-kill fold of one round: the same kill rows as
// killsCountedCTE, restricted to the round bound as :round. The round-grain
// kill metrics (raw_round_kills, raw_round_assists, raw_round_deaths and
// raw_round_survived) read it as their k CTE.
const killsRoundCTE = `k AS (SELECT e.round, e.attacker, e.victim, e.assister, e.weapon, e.headshot, e.assisted_flash, {{FAKE_KILL}}, sa.side AS a_side, sv.side AS v_side, ss.side AS s_side FROM events e {{DISCONNECT_JOIN}} {{SIDE_JOIN:sa:e:attacker}} {{SIDE_JOIN:sv:e:victim}} {{SIDE_JOIN:ss:e:assister}} WHERE e.match_id = :match_id AND {{LIVE_EVENT:e:kill}} AND e.round = :round)`

// killsRoundPlaceholder marks the round-grain kill CTE inside a schema.sql metric expr.
const killsRoundPlaceholder = "{{KILLS_ROUND}}"
