package store

// damageCountedCTE is the ONE copy of the counted-damage fold: every damage
// event of a match outside post-match time, joined to the attacker's and
// victim's sides, with self-damage and same-side (team) damage dropped. `dmg`
// carries the full column set, `edmg` is the counted damage that metrics fold
// (sum of capped_dmg, hit counts, utility by weapon, damage taken). A metric
// reads only the columns it needs from edmg.
//
// schema.sql holds damagePlaceholder where the pair goes (the metric's own
// `WITH dmg AS (...), edmg AS (...)`); applySchema splices this text in.
const damageCountedCTE = `dmg AS (SELECT e.match_id, e.round, e.attacker, e.victim, e.weapon, e.capped_dmg, e.detail_json, sa.side AS a_side, sv.side AS v_side FROM events e {{SIDE_JOIN:sa:e:attacker}} {{SIDE_JOIN:sv:e:victim}} WHERE e.match_id = :match_id AND e.kind = 'damage' AND e.post_match = 0), edmg AS (SELECT * FROM dmg WHERE attacker <> '' AND attacker <> victim AND {{TEAM_FREE}})`

// damagePlaceholder marks the counted-damage pair inside a schema.sql metric expr.
const damagePlaceholder = "{{DAMAGE_CTE}}"

// damageRoundCTE is the counted-damage pair of one round: the counted-damage rule
// of damageCountedCTE restricted to the round bound as :round (raw_round_dmg and
// raw_round_util_dmg read it as their WITH list, then aggregate it per player).
const damageRoundCTE = `dmg AS ( SELECT e.round, e.attacker, e.victim, e.weapon, e.capped_dmg, e.detail_json, sa.side AS a_side, sv.side AS v_side FROM events e {{SIDE_JOIN:sa:e:attacker}} {{SIDE_JOIN:sv:e:victim}} WHERE e.match_id = :match_id AND {{LIVE_EVENT:e:damage}} AND e.round = :round ), edmg_r AS ( SELECT * FROM dmg WHERE attacker <> '' AND NOT (COALESCE(a_side,'') <> '' AND a_side = v_side) )`

// damageRoundPlaceholder marks the round-grain counted-damage pair inside a schema.sql metric expr.
const damageRoundPlaceholder = "{{DAMAGE_ROUND_CTE}}"
