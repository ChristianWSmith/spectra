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
