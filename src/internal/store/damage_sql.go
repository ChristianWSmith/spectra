package store

import "strings"

// damageCountedCTE is the ONE copy of the counted-damage fold: every damage
// event of a match outside post-match time, joined to the attacker's and
// victim's sides, with self-damage and same-side (team) damage dropped. `dmg`
// carries the full column set, `edmg` is the counted damage that metrics fold
// (sum of capped_dmg, hit counts, utility by weapon, damage taken). A metric
// reads only the columns it needs from edmg.
//
// schema.sql holds damagePlaceholder where the pair goes (the metric's own
// `WITH dmg AS (...), edmg AS (...)`); applySchema splices this text in.
const damageCountedCTE = `dmg AS (SELECT e.match_id, e.round, e.attacker, e.victim, e.weapon, e.capped_dmg, e.detail_json, sa.side AS a_side, sv.side AS v_side FROM events e LEFT JOIN round_player_sides sa ON sa.match_id = e.match_id AND sa.round = e.round AND sa.steam_id = e.attacker LEFT JOIN round_player_sides sv ON sv.match_id = e.match_id AND sv.round = e.round AND sv.steam_id = e.victim WHERE e.match_id = :match_id AND e.kind = 'damage' AND e.post_match = 0), edmg AS (SELECT * FROM dmg WHERE attacker <> '' AND attacker <> victim AND NOT (COALESCE(a_side, '') <> '' AND a_side = v_side))`

// damagePlaceholder marks the counted-damage pair inside a schema.sql metric expr.
const damagePlaceholder = "{{DAMAGE_CTE}}"

// damageSeedText is the pair as it is spliced into a schema.sql literal.
func damageSeedText() string {
	return strings.ReplaceAll(damageCountedCTE, "'", "''")
}
