package store

import (
	"database/sql"
	"fmt"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// clutchCTE is the ONE Go copy of the 1vN alive-count clutch computation
// (dogfood/PLAN.md rulings 19 and 53). It is the `clutch` family's logic
// (schema.sql, round-grain, binds :round) with the round carried through
// every key, so one statement reads every counted round of a match. It binds
// :match_id only and ends in the CTE `clutch`, one row per clutch with the
// columns steam_id, round, side, start_tick, end_tick, size, how, won, equip,
// hp_left, bomb_state, kill_ticks and name.
//
// Two consumers read it: the six clutch metrics in schema.sql, whose exprs
// hold clutchPlaceholder (applySchema splices this text in, quotes doubled,
// so the seed rows never drift apart), and ClutchRows, which the Combat panel
// and the match report read. The table `clutches` is gone; nothing stores
// these rows.
//
// The alive count and the survivor come from the roster rule (backlog S10):
// round_player_sides for the side, minus the players killed in the round at or
// before the kill tick, or with a player_disconnect from the round start
// through that tick (inclusive). The survivor's HP read stays tick state.
const clutchCTE = `WITH kt AS (SELECT DISTINCT round, tick FROM events WHERE match_id = :match_id AND kind = 'kill' AND victim <> ''),
sd AS (SELECT 'ct' AS side UNION ALL SELECT 't'),
alv AS (SELECT kt.round AS round, kt.tick AS tick, rs.side AS side, rs.steam_id AS steam_id FROM kt JOIN round_player_sides rs ON rs.match_id = :match_id AND rs.round = kt.round LEFT JOIN rounds ro ON ro.match_id = :match_id AND ro.number = kt.round WHERE NOT EXISTS (SELECT 1 FROM events k WHERE k.match_id = :match_id AND k.round = kt.round AND k.kind = 'kill' AND k.victim = rs.steam_id AND k.tick <= kt.tick) AND NOT EXISTS (SELECT 1 FROM events dc WHERE dc.match_id = :match_id AND dc.kind = 'player_disconnect' AND dc.attacker = rs.steam_id AND dc.tick >= ro.start_tick AND dc.tick <= kt.tick)),
cnt AS (SELECT kt.round AS round, kt.tick AS tick, sd.side AS side, (SELECT COUNT(*) FROM alv WHERE alv.round = kt.round AND alv.tick = kt.tick AND alv.side = sd.side) AS n FROM kt CROSS JOIN sd),
cand AS (SELECT a.round AS round, a.tick AS tick, a.side AS side, b.n AS opp, (SELECT al.steam_id FROM alv al WHERE al.round = a.round AND al.tick = a.tick AND al.side = a.side) AS solo FROM cnt a JOIN cnt b ON b.round = a.round AND b.tick = a.tick AND b.side <> a.side WHERE a.n = 1 AND b.n >= 1),
starts AS (SELECT round, solo, side, MIN(tick) AS start_tick, opp AS size FROM cand GROUP BY round, solo, side),
deaths AS (SELECT round, victim AS solo, MIN(tick) AS dtick FROM events WHERE match_id = :match_id AND kind = 'kill' AND victim <> '' GROUP BY round, victim),
wont AS (SELECT s.round AS round, s.solo AS solo, MIN(z.tick) AS wtick FROM starts s JOIN cnt z ON z.round = s.round AND z.side <> s.side AND z.n = 0 AND z.tick > s.start_tick GROUP BY s.round, s.solo),
ended AS (SELECT s.round AS round, s.solo AS solo, s.side AS side, s.start_tick AS start_tick, s.size AS size, CASE WHEN d.dtick IS NOT NULL AND (w.wtick IS NULL OR d.dtick <= w.wtick) THEN 'lost' WHEN w.wtick IS NOT NULL THEN 'won' ELSE 'round' END AS how, CASE WHEN d.dtick IS NOT NULL AND (w.wtick IS NULL OR d.dtick <= w.wtick) THEN d.dtick WHEN w.wtick IS NOT NULL THEN w.wtick ELSE r.end_tick END AS end_tick, r.winner AS winner, r.equip_ct AS equip_ct, r.equip_t AS equip_t FROM starts s LEFT JOIN deaths d ON d.round = s.round AND d.solo = s.solo LEFT JOIN wont w ON w.round = s.round AND w.solo = s.solo JOIN rounds r ON r.match_id = :match_id AND r.number = s.round),
clutch AS (SELECT e.round AS round, e.solo AS steam_id, e.side AS side, e.start_tick AS start_tick, e.end_tick AS end_tick, e.size AS size, e.how AS how, CASE WHEN e.how = 'won' THEN 1 WHEN e.how = 'lost' THEN 0 WHEN e.winner = e.side THEN 1 ELSE 0 END AS won, CASE WHEN e.side = 'ct' THEN e.equip_ct ELSE e.equip_t END AS equip, CASE WHEN e.how = 'lost' THEN 0 WHEN EXISTS (SELECT 1 FROM events hv WHERE hv.match_id = :match_id AND hv.round = e.round AND hv.kind = 'damage' AND hv.victim = e.solo AND hv.tick <= e.end_tick AND json_extract(hv.detail_json, '$.health') IS NOT NULL) THEN MIN(100, MAX(1, (SELECT pt.hp FROM player_ticks pt WHERE pt.match_id = :match_id AND pt.round = e.round AND pt.steam_id = e.solo AND pt.tick <= e.end_tick ORDER BY pt.tick DESC LIMIT 1))) ELSE MIN(100, MAX(1, 100 - COALESCE((SELECT SUM(dh.dmg) FROM events dh WHERE dh.match_id = :match_id AND dh.round = e.round AND dh.kind = 'damage' AND dh.victim = e.solo AND dh.tick > e.start_tick AND dh.tick <= e.end_tick), 0))) END AS hp_left, (SELECT CASE WHEN bs.p >= 0 THEN CASE WHEN bs.en < 0 THEN 'planted' ELSE 'none' END WHEN bs.dr >= 0 AND bs.dr > bs.pu THEN 'dropped' ELSE 'carried' END FROM (SELECT COALESCE(MAX(CASE WHEN kind = 'bomb_plant' THEN tick END), -1) AS p, COALESCE(MAX(CASE WHEN kind IN ('bomb_explode', 'bomb_defuse') THEN tick END), -1) AS en, COALESCE(MAX(CASE WHEN kind = 'bomb_drop' THEN tick END), -1) AS dr, COALESCE(MAX(CASE WHEN kind = 'bomb_pickup' THEN tick END), -1) AS pu FROM events WHERE match_id = :match_id AND round = e.round AND kind IN ('bomb_plant', 'bomb_explode', 'bomb_defuse', 'bomb_drop', 'bomb_pickup') AND tick <= e.start_tick) bs) AS bomb_state, (SELECT CASE WHEN COUNT(*) = 0 THEN 'null' ELSE '[' || group_concat(k.tick, ',') || ']' END FROM (SELECT ev.tick AS tick FROM events ev WHERE ev.match_id = :match_id AND ev.round = e.round AND ev.kind = 'kill' AND ev.attacker = e.solo AND ev.victim <> '' AND ev.tick > e.start_tick AND (ev.tick < e.end_tick OR (e.how <> 'lost' AND ev.tick <= e.end_tick)) ORDER BY ev.tick) k) AS kill_ticks, (SELECT p.name FROM players p WHERE p.match_id = :match_id AND p.steam_id = e.solo LIMIT 1) AS name FROM ended e)`

// clutchPlaceholder marks where the clutch CTE goes inside a schema.sql
// metric expr (a single-quoted SQL literal, so applySchema escapes the text).
const clutchPlaceholder = "{{CLUTCH_CTE}}"

// clutchRowsSQL is the clutch rows statement: the CTE, then one row per clutch
// in round and start_tick order.
const clutchRowsSQL = clutchCTE + ` SELECT c.round, c.size, c.steam_id, COALESCE(c.name, '') AS name, c.start_tick, c.end_tick, c.bomb_state, c.hp_left, c.equip, c.won, c.kill_ticks FROM clutch c ORDER BY c.round, c.start_tick`

// ClutchCTE is the shared clutch CTE text (no SQL quoting applied). Test
// fixtures that spell out a clutch metric expr splice it in with this.
func ClutchCTE() string { return clutchCTE }

// ClutchRows returns a match's 1vN clutches by round and start_tick, computed
// from player_ticks and events over every counted round (no stored rows).
func (s *Store) ClutchRows(matchID int64) ([]models.Clutch, error) {
	rows, err := s.db.Query(clutchRowsSQL, sql.Named("match_id", matchID))
	if err != nil {
		return nil, fmt.Errorf("couldn't load the clutches: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []models.Clutch
	for rows.Next() {
		var r models.Clutch
		var won int
		if err := rows.Scan(&r.Round, &r.Size, &r.SteamID, &r.Name, &r.StartTick, &r.EndTick,
			&r.BombState, &r.HPLeft, &r.Equip, &won, &r.KillTicks); err != nil {
			return nil, fmt.Errorf("couldn't load the clutches: %w", err)
		}
		r.MatchID = matchID
		r.Won = won != 0
		r.ReplayAnchor = r.StartTick
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load the clutches: %w", err)
	}
	return out, nil
}
