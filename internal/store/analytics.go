package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// This file is the M3 persistence surface: analysis_config, the per-match
// derived-row replace/getters (round_classifications, player_round_stats,
// clutches, engagements, utility_events), the economy view with loss-bonus
// reconstruction, combat stats computed from stored rows, saved-filter
// presets and the player_career rollup. Every string write passes scrub.

// DefaultConfig is the seeded analysis_config row (plan M3 — configurable
// definitions with transparent rules).
var DefaultConfig = models.AnalysisConfig{
	TradeWindowS: 5.0,
	EcoFullBuy:   4000,
	EcoForce:     2000,
	RuleVersion:  1,
}

// GetConfig returns the analysis_config row, seeding the defaults on first
// use (single-row table: id = 1).
func (s *Store) GetConfig() (models.AnalysisConfig, error) {
	var c models.AnalysisConfig
	err := s.db.QueryRow(
		`SELECT trade_window_s, eco_full_buy, eco_force, rule_version FROM analysis_config WHERE id = 1`,
	).Scan(&c.TradeWindowS, &c.EcoFullBuy, &c.EcoForce, &c.RuleVersion)
	if errors.Is(err, sql.ErrNoRows) {
		if _, err := s.db.Exec(
			`INSERT INTO analysis_config (id, trade_window_s, eco_full_buy, eco_force, rule_version)
			 VALUES (1, ?, ?, ?, ?)`,
			DefaultConfig.TradeWindowS, DefaultConfig.EcoFullBuy, DefaultConfig.EcoForce, DefaultConfig.RuleVersion,
		); err != nil {
			return models.AnalysisConfig{}, fmt.Errorf("store: seed analysis_config: %w", err)
		}
		return DefaultConfig, nil
	}
	if err != nil {
		return models.AnalysisConfig{}, fmt.Errorf("store: get analysis_config: %w", err)
	}
	return c, nil
}

// SetConfig upserts the analysis_config row and returns the stored value.
func (s *Store) SetConfig(c models.AnalysisConfig) (models.AnalysisConfig, error) {
	if _, err := s.db.Exec(
		`INSERT INTO analysis_config (id, trade_window_s, eco_full_buy, eco_force, rule_version)
		 VALUES (1, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET trade_window_s = excluded.trade_window_s,
			eco_full_buy = excluded.eco_full_buy, eco_force = excluded.eco_force,
			rule_version = excluded.rule_version`,
		c.TradeWindowS, c.EcoFullBuy, c.EcoForce, c.RuleVersion,
	); err != nil {
		return models.AnalysisConfig{}, fmt.Errorf("store: set analysis_config: %w", err)
	}
	return s.GetConfig()
}

// ReplaceRoundClassifications swaps a match's round_classifications rows in
// one transaction (delete-then-insert).
func (s *Store) ReplaceRoundClassifications(matchID int64, rows []models.RoundClassification) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("store: replace round classifications: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`DELETE FROM round_classifications WHERE match_id = ?`, matchID); err != nil {
		return fmt.Errorf("store: replace round classifications: %w", err)
	}
	stmt, err := tx.Prepare(
		`INSERT INTO round_classifications (match_id, round, label, confidence, rule_version, explanation)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return fmt.Errorf("store: replace round classifications: %w", err)
	}
	defer stmt.Close()
	for _, r := range rows {
		if _, err := stmt.Exec(matchID, r.Round, scrub(r.Label), r.Confidence, r.RuleVersion, scrub(r.Explanation)); err != nil {
			return fmt.Errorf("store: replace round classifications: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: replace round classifications: %w", err)
	}
	return nil
}

// ReplacePlayerRounds swaps a match's player_round_stats rows in one
// transaction.
func (s *Store) ReplacePlayerRounds(matchID int64, rows []models.PlayerRoundStat) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("store: replace player rounds: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`DELETE FROM player_round_stats WHERE match_id = ?`, matchID); err != nil {
		return fmt.Errorf("store: replace player rounds: %w", err)
	}
	stmt, err := tx.Prepare(
		`INSERT INTO player_round_stats (match_id, round, steam_id, name, kills, assists, deaths,
			traded, survived, kast, dmg, util_dmg, money_start, equip, spent, rule_version)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return fmt.Errorf("store: replace player rounds: %w", err)
	}
	defer stmt.Close()
	for _, r := range rows {
		if _, err := stmt.Exec(
			matchID, r.Round, scrub(r.SteamID), scrub(r.Name), r.Kills, r.Assists, r.Deaths,
			b2i(r.Traded), b2i(r.Survived), b2i(r.KAST), r.DMG, r.UtilDmg,
			r.MoneyStart, r.Equip, r.Spent, r.RuleVersion,
		); err != nil {
			return fmt.Errorf("store: replace player rounds: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: replace player rounds: %w", err)
	}
	return nil
}

// ReplaceClutches swaps a match's clutches rows in one transaction.
func (s *Store) ReplaceClutches(matchID int64, rows []models.Clutch) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("store: replace clutches: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`DELETE FROM clutches WHERE match_id = ?`, matchID); err != nil {
		return fmt.Errorf("store: replace clutches: %w", err)
	}
	stmt, err := tx.Prepare(
		`INSERT INTO clutches (match_id, round, size, steam_id, name, start_tick, end_tick,
			bomb_state, hp_left, equip, won, kill_ticks, replay_anchor)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return fmt.Errorf("store: replace clutches: %w", err)
	}
	defer stmt.Close()
	for _, r := range rows {
		if _, err := stmt.Exec(
			matchID, r.Round, r.Size, scrub(r.SteamID), scrub(r.Name), r.StartTick, r.EndTick,
			scrub(r.BombState), r.HPLeft, r.Equip, b2i(r.Won), scrub(r.KillTicks), r.ReplayAnchor,
		); err != nil {
			return fmt.Errorf("store: replace clutches: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: replace clutches: %w", err)
	}
	return nil
}

// ReplaceEngagements swaps a match's engagements rows in one transaction
// (seq is rewritten 0..n-1 in slice order so the PK stays dense).
func (s *Store) ReplaceEngagements(matchID int64, rows []models.Engagement) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("store: replace engagements: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`DELETE FROM engagements WHERE match_id = ?`, matchID); err != nil {
		return fmt.Errorf("store: replace engagements: %w", err)
	}
	stmt, err := tx.Prepare(
		`INSERT INTO engagements (match_id, seq, tick, round, kind, a_steam, a_name, b_steam, b_name, distance, won_by)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return fmt.Errorf("store: replace engagements: %w", err)
	}
	defer stmt.Close()
	for i, r := range rows {
		if _, err := stmt.Exec(
			matchID, i, r.Tick, r.Round, scrub(r.Kind), scrub(r.ASteam), scrub(r.AName),
			scrub(r.BSteam), scrub(r.BName), r.Distance, scrub(r.WonBy),
		); err != nil {
			return fmt.Errorf("store: replace engagements: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: replace engagements: %w", err)
	}
	return nil
}

// ReplaceUtility swaps a match's utility_events rows in one transaction
// (seq rewritten 0..n-1 in slice order).
func (s *Store) ReplaceUtility(matchID int64, rows []models.UtilityEvent) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("store: replace utility: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`DELETE FROM utility_events WHERE match_id = ?`, matchID); err != nil {
		return fmt.Errorf("store: replace utility: %w", err)
	}
	stmt, err := tx.Prepare(
		`INSERT INTO utility_events (match_id, seq, tick, round, thrower, thrower_name, kind,
			det_x, det_y, damage, flash_ms, affected, site, trajectory_ref)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return fmt.Errorf("store: replace utility: %w", err)
	}
	defer stmt.Close()
	for i, r := range rows {
		if _, err := stmt.Exec(
			matchID, i, r.Tick, r.Round, scrub(r.Thrower), scrub(r.ThrowerName), scrub(r.Kind),
			nvl(r.DetX), nvl(r.DetY), r.Damage, r.FlashMs, scrub(r.Affected), scrub(r.Site), scrub(r.TrajectoryRef),
		); err != nil {
			return fmt.Errorf("store: replace utility: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: replace utility: %w", err)
	}
	return nil
}

// GetRoundClasses returns a match's stored classifications by round ASC.
func (s *Store) GetRoundClasses(matchID int64) ([]models.RoundClassification, error) {
	rows, err := s.db.Query(
		`SELECT round, label, confidence, rule_version, explanation
		 FROM round_classifications WHERE match_id = ? ORDER BY round ASC`, matchID,
	)
	if err != nil {
		return nil, fmt.Errorf("store: get round classes: %w", err)
	}
	defer rows.Close()
	var out []models.RoundClassification
	for rows.Next() {
		var r models.RoundClassification
		r.MatchID = matchID
		if err := rows.Scan(&r.Round, &r.Label, &r.Confidence, &r.RuleVersion, &r.Explanation); err != nil {
			return nil, fmt.Errorf("store: get round classes: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get round classes: %w", err)
	}
	return out, nil
}

// GetPlayerRounds returns one player's per-round rows (steamID "" = all
// players), ordered by round ASC, steam_id.
func (s *Store) GetPlayerRounds(matchID int64, steamID string) ([]models.PlayerRoundStat, error) {
	q := `SELECT round, steam_id, name, kills, assists, deaths, traded, survived, kast,
		dmg, util_dmg, money_start, equip, spent, rule_version
		FROM player_round_stats WHERE match_id = ?`
	args := []any{matchID}
	if sid := scrub(steamID); sid != "" {
		q += ` AND steam_id = ?`
		args = append(args, sid)
	}
	q += ` ORDER BY round ASC, steam_id ASC`
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("store: get player rounds: %w", err)
	}
	defer rows.Close()
	var out []models.PlayerRoundStat
	for rows.Next() {
		var r models.PlayerRoundStat
		r.MatchID = matchID
		if err := rows.Scan(
			&r.Round, &r.SteamID, &r.Name, &r.Kills, &r.Assists, &r.Deaths,
			&r.Traded, &r.Survived, &r.KAST, &r.DMG, &r.UtilDmg,
			&r.MoneyStart, &r.Equip, &r.Spent, &r.RuleVersion,
		); err != nil {
			return nil, fmt.Errorf("store: get player rounds: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get player rounds: %w", err)
	}
	return out, nil
}

// GetClutches returns a match's clutch records by round, start_tick ASC.
func (s *Store) GetClutches(matchID int64) ([]models.Clutch, error) {
	rows, err := s.db.Query(
		`SELECT round, size, steam_id, name, start_tick, end_tick, bomb_state, hp_left,
			equip, won, kill_ticks, replay_anchor
		 FROM clutches WHERE match_id = ? ORDER BY round ASC, start_tick ASC`, matchID,
	)
	if err != nil {
		return nil, fmt.Errorf("store: get clutches: %w", err)
	}
	defer rows.Close()
	var out []models.Clutch
	for rows.Next() {
		var r models.Clutch
		r.MatchID = matchID
		if err := rows.Scan(
			&r.Round, &r.Size, &r.SteamID, &r.Name, &r.StartTick, &r.EndTick,
			&r.BombState, &r.HPLeft, &r.Equip, &r.Won, &r.KillTicks, &r.ReplayAnchor,
		); err != nil {
			return nil, fmt.Errorf("store: get clutches: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get clutches: %w", err)
	}
	return out, nil
}

// GetEngagements returns a match's engagements (kind "" = all kinds),
// ordered by seq.
func (s *Store) GetEngagements(matchID int64, kind string) ([]models.Engagement, error) {
	q := `SELECT seq, tick, round, kind, a_steam, a_name, b_steam, b_name, distance, won_by
		FROM engagements WHERE match_id = ?`
	args := []any{matchID}
	if k := scrub(kind); k != "" {
		q += ` AND kind = ?`
		args = append(args, k)
	}
	q += ` ORDER BY seq ASC`
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("store: get engagements: %w", err)
	}
	defer rows.Close()
	var out []models.Engagement
	for rows.Next() {
		var r models.Engagement
		r.MatchID = matchID
		if err := rows.Scan(&r.Seq, &r.Tick, &r.Round, &r.Kind, &r.ASteam, &r.AName, &r.BSteam, &r.BName, &r.Distance, &r.WonBy); err != nil {
			return nil, fmt.Errorf("store: get engagements: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get engagements: %w", err)
	}
	return out, nil
}

// GetUtility returns a match's per-grenade rows, ordered by seq.
func (s *Store) GetUtility(matchID int64) ([]models.UtilityEvent, error) {
	rows, err := s.db.Query(
		`SELECT seq, tick, round, thrower, thrower_name, kind, det_x, det_y, damage,
			flash_ms, affected, site, trajectory_ref
		 FROM utility_events WHERE match_id = ? ORDER BY seq ASC`, matchID,
	)
	if err != nil {
		return nil, fmt.Errorf("store: get utility: %w", err)
	}
	defer rows.Close()
	var out []models.UtilityEvent
	for rows.Next() {
		var r models.UtilityEvent
		r.MatchID = matchID
		var detX, detY sql.NullFloat64
		if err := rows.Scan(
			&r.Seq, &r.Tick, &r.Round, &r.Thrower, &r.ThrowerName, &r.Kind, &detX, &detY,
			&r.Damage, &r.FlashMs, &r.Affected, &r.Site, &r.TrajectoryRef,
		); err != nil {
			return nil, fmt.Errorf("store: get utility: %w", err)
		}
		if detX.Valid {
			v := detX.Float64
			r.DetX = &v
		}
		if detY.Valid {
			v := detY.Float64
			r.DetY = &v
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get utility: %w", err)
	}
	return out, nil
}

// GetEconomy returns the per-round economy view (warmup rounds excluded):
// rounds ⋈ round_economy ⋈ round_classifications with loss-bonus
// reconstruction applied. Loss bonus is INFERRED (reconstructed from winner
// streaks: 1400/1900/2400/2900/3400 capped) — InferredCT/InferredT are set
// accordingly; per-side ClassCT/ClassT/ClassWhy* stay empty for the caller
// to fill via analytics.BuyClass (documented cycle deviation).
func (s *Store) GetEconomy(matchID int64) ([]models.EconomyRow, error) {
	rows, err := s.db.Query(
		`SELECT r.number, r.winner, r.warmup, r.equip_ct, r.equip_t,
			COALESCE(ct.money_sampled_sum, 0), COALESCE(t.money_sampled_sum, 0),
			COALESCE(rc.label, ''), COALESCE(rc.explanation, ''),
			COALESCE(rc.rule_version, 0)
		 FROM rounds r
		 LEFT JOIN round_economy ct ON ct.match_id = r.match_id AND ct.round = r.number AND ct.side = 'ct'
		 LEFT JOIN round_economy t ON t.match_id = r.match_id AND t.round = r.number AND t.side = 't'
		 LEFT JOIN round_classifications rc ON rc.match_id = r.match_id AND rc.round = r.number
		 WHERE r.match_id = ? AND r.warmup = 0
		 ORDER BY r.number ASC`, matchID,
	)
	if err != nil {
		return nil, fmt.Errorf("store: get economy: %w", err)
	}
	defer rows.Close()
	var out []models.EconomyRow
	for rows.Next() {
		var r models.EconomyRow
		if err := rows.Scan(&r.Round, &r.Winner, &r.Warmup, &r.EquipCT, &r.EquipT,
			&r.MoneyCT, &r.MoneyT, &r.Label, &r.Explanation, &r.RuleVersion); err != nil {
			return nil, fmt.Errorf("store: get economy: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get economy: %w", err)
	}
	// Loss-bonus reconstruction + outcome flags (inferred — plan M3 §9.1
	// requires the fact/inference badge, which Inferred* signals).
	for i := range out {
		r := &out[i]
		r.WonCT = r.Winner == "ct"
		r.WonT = r.Winner == "t"
		// Bonus applies when the side LOST the previous non-warmup round;
		// streak counts consecutive losses ending at that previous round.
		if i > 0 {
			r.LossBonusCT = lossBonusFor(out[:i], "ct")
			r.LossBonusT = lossBonusFor(out[:i], "t")
		}
		r.InferredCT, r.InferredT = true, true
	}
	return out, nil
}

// lossBonusFor reconstructs the loss bonus a side carries INTO the round
// after prefix: 1400 for a 1-round streak, +500 per consecutive loss,
// capped at 3400. 0 when the side won the most recent round.
func lossBonusFor(prefix []models.EconomyRow, side string) int {
	if len(prefix) == 0 {
		return 0
	}
	last := prefix[len(prefix)-1]
	won := func(r models.EconomyRow) bool {
		if side == "ct" {
			return r.WonCT
		}
		return r.WonT
	}
	if won(last) {
		return 0
	}
	streak := 0
	for i := len(prefix) - 1; i >= 0; i-- {
		if won(prefix[i]) {
			break
		}
		streak++
	}
	bonus := 1400 + 500*(streak-1)
	if bonus > 3400 {
		bonus = 3400
	}
	if bonus < 0 {
		bonus = 0
	}
	return bonus
}

// GetCombatStats computes per-player combat deep-dive rows from stored data
// (plan M3 §2.3): damage conversion and friendly fire from the events
// table, entry/trade rates from player_stats, untraded deaths from
// engagements, KAST% from player_round_stats. Team attribution (FF, and the
// trade-opportunity heuristic) uses each player's FINAL side — events carry
// no team column, so this is an approximation (documented; badge in UI).
// TradeOppMissed = untraded deaths (inferred heuristic — no position-based
// opportunity scan in v1).
func (s *Store) GetCombatStats(matchID int64) ([]models.CombatStat, error) {
	// Damage per attacker, splitting damage-on-kill (a kill event with the
	// same attacker/victim on the same tick) from damage-without-kill, and
	// same-final-side (friendly) damage.
	dmgRows, err := s.db.Query(
		`SELECT e.attacker,
			SUM(e.dmg),
			SUM(CASE WHEN EXISTS (
				SELECT 1 FROM events k
				WHERE k.match_id = e.match_id AND k.kind = 'kill' AND k.tick = e.tick
					AND k.attacker = e.attacker AND k.victim = e.victim
			) THEN e.dmg ELSE 0 END),
			SUM(CASE WHEN vp.steam_id IS NOT NULL AND ap.side = vp.side THEN e.dmg ELSE 0 END)
		 FROM events e
		 LEFT JOIN players ap ON ap.match_id = e.match_id AND ap.steam_id = e.attacker
		 LEFT JOIN players vp ON vp.match_id = e.match_id AND vp.steam_id = e.victim
		 WHERE e.match_id = ? AND e.kind = 'damage' AND e.attacker <> ''
		 GROUP BY e.attacker`, matchID,
	)
	if err != nil {
		return nil, fmt.Errorf("store: get combat stats: %w", err)
	}
	defer dmgRows.Close()
	type dmgAgg struct{ total, onKill, ff int }
	dmgs := map[string]dmgAgg{}
	for dmgRows.Next() {
		var sid string
		var a dmgAgg
		if err := dmgRows.Scan(&sid, &a.total, &a.onKill, &a.ff); err != nil {
			return nil, fmt.Errorf("store: get combat stats: %w", err)
		}
		dmgs[sid] = a
	}
	if err := dmgRows.Err(); err != nil {
		return nil, fmt.Errorf("store: get combat stats: %w", err)
	}

	// Untraded deaths per victim.
	untraded := map[string]int{}
	utrRows, err := s.db.Query(
		`SELECT b_steam, COUNT(*) FROM engagements
		 WHERE match_id = ? AND kind = 'untraded' AND b_steam <> '' GROUP BY b_steam`, matchID,
	)
	if err != nil {
		return nil, fmt.Errorf("store: get combat stats: %w", err)
	}
	defer utrRows.Close()
	for utrRows.Next() {
		var sid string
		var n int
		if err := utrRows.Scan(&sid, &n); err != nil {
			return nil, fmt.Errorf("store: get combat stats: %w", err)
		}
		untraded[sid] = n
	}
	if err := utrRows.Err(); err != nil {
		return nil, fmt.Errorf("store: get combat stats: %w", err)
	}

	// KAST% per player from player_round_stats.
	kastPct := map[string]float64{}
	kastRows, err := s.db.Query(
		`SELECT steam_id, 100.0 * AVG(kast) FROM player_round_stats
		 WHERE match_id = ? GROUP BY steam_id`, matchID,
	)
	if err != nil {
		return nil, fmt.Errorf("store: get combat stats: %w", err)
	}
	defer kastRows.Close()
	for kastRows.Next() {
		var sid string
		var pct float64
		if err := kastRows.Scan(&sid, &pct); err != nil {
			return nil, fmt.Errorf("store: get combat stats: %w", err)
		}
		kastPct[sid] = pct
	}
	if err := kastRows.Err(); err != nil {
		return nil, fmt.Errorf("store: get combat stats: %w", err)
	}

	// Base rows: every player with stats for the match.
	base, err := s.db.Query(
		`SELECT ps.steam_id, p.name, ps.entry_kills, ps.trade_kills, ps.deaths, ps.rounds_played
		 FROM player_stats ps
		 JOIN players p ON p.match_id = ps.match_id AND p.steam_id = ps.steam_id
		 WHERE ps.match_id = ? ORDER BY p.name ASC`, matchID,
	)
	if err != nil {
		return nil, fmt.Errorf("store: get combat stats: %w", err)
	}
	defer base.Close()
	var out []models.CombatStat
	for base.Next() {
		var r models.CombatStat
		var entryKills, tradeKills, deaths, roundsPlayed int
		if err := base.Scan(&r.SteamID, &r.Name, &entryKills, &tradeKills, &deaths, &roundsPlayed); err != nil {
			return nil, fmt.Errorf("store: get combat stats: %w", err)
		}
		d := dmgs[r.SteamID]
		r.DMGNoKill = d.total - d.onKill
		if d.total > 0 {
			r.DMGConvPct = 100 * float64(d.onKill) / float64(d.total)
		}
		r.FFDamage = d.ff
		if roundsPlayed > 0 {
			r.EntryRate = float64(entryKills) / float64(roundsPlayed)
		}
		if deaths > 0 {
			r.TradeRate = float64(tradeKills) / float64(deaths)
		}
		r.UntradedDeaths = untraded[r.SteamID]
		r.TradeOppMissed = r.UntradedDeaths // inferred heuristic (UI badge)
		r.KASTPct = kastPct[r.SteamID]
		out = append(out, r)
	}
	if err := base.Err(); err != nil {
		return nil, fmt.Errorf("store: get combat stats: %w", err)
	}
	return out, nil
}

// GetPlayerRefs returns one match's participants (identity + final side).
func (s *Store) GetPlayerRefs(matchID int64) ([]models.PlayerRef, error) {
	rows, err := s.db.Query(
		`SELECT steam_id, name, side FROM players WHERE match_id = ? ORDER BY name ASC`, matchID,
	)
	if err != nil {
		return nil, fmt.Errorf("store: get player refs: %w", err)
	}
	defer rows.Close()
	var out []models.PlayerRef
	for rows.Next() {
		var r models.PlayerRef
		if err := rows.Scan(&r.SteamID, &r.Name, &r.Side); err != nil {
			return nil, fmt.Errorf("store: get player refs: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get player refs: %w", err)
	}
	return out, nil
}

// GetRoundEconomyViews returns the raw per-side economy samples for one
// match (round ASC, side).
func (s *Store) GetRoundEconomyViews(matchID int64) ([]models.RoundEconomyView, error) {
	rows, err := s.db.Query(
		`SELECT round, side, equip_value, money_sampled_sum, money_samples
		 FROM round_economy WHERE match_id = ? ORDER BY round ASC, side ASC`, matchID,
	)
	if err != nil {
		return nil, fmt.Errorf("store: get round economy views: %w", err)
	}
	defer rows.Close()
	var out []models.RoundEconomyView
	for rows.Next() {
		var r models.RoundEconomyView
		if err := rows.Scan(&r.Round, &r.Side, &r.EquipValue, &r.MoneySampledSum, &r.MoneySamples); err != nil {
			return nil, fmt.Errorf("store: get round economy views: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get round economy views: %w", err)
	}
	return out, nil
}

// GetRoundInfos returns one match's rounds as analytics RoundInfos (warmup
// included — callers filter).
func (s *Store) GetRoundInfos(matchID int64) ([]models.RoundInfo, error) {
	rows, err := s.db.Query(
		`SELECT number, winner, warmup, start_tick, end_tick, freeze_end_tick, equip_ct, equip_t
		 FROM rounds WHERE match_id = ? ORDER BY number ASC`, matchID,
	)
	if err != nil {
		return nil, fmt.Errorf("store: get round infos: %w", err)
	}
	defer rows.Close()
	var out []models.RoundInfo
	for rows.Next() {
		var r models.RoundInfo
		if err := rows.Scan(&r.Number, &r.Winner, &r.Warmup, &r.StartTick, &r.EndTick, &r.FreezeEndTick, &r.EquipCT, &r.EquipT); err != nil {
			return nil, fmt.Errorf("store: get round infos: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get round infos: %w", err)
	}
	return out, nil
}

// ---- saved filters ----

// ListSavedFilters returns all saved filter presets, newest first.
func (s *Store) ListSavedFilters() ([]models.SavedFilterRow, error) {
	rows, err := s.db.Query(
		`SELECT id, name, scope, filter_json, created_at FROM saved_filters ORDER BY created_at DESC, id DESC`,
	)
	if err != nil {
		return nil, fmt.Errorf("store: list saved filters: %w", err)
	}
	defer rows.Close()
	var out []models.SavedFilterRow
	for rows.Next() {
		var r models.SavedFilterRow
		if err := rows.Scan(&r.ID, &r.Name, &r.Scope, &r.FilterJSON, &r.CreatedAt); err != nil {
			return nil, fmt.Errorf("store: list saved filters: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list saved filters: %w", err)
	}
	return out, nil
}

// CreateSavedFilter inserts a preset and returns the stored row. A name
// already used within the same scope yields a user-facing error.
func (s *Store) CreateSavedFilter(name, scope, filterJSON string) (models.SavedFilterRow, error) {
	res, err := s.db.Exec(
		`INSERT INTO saved_filters (name, scope, filter_json, created_at) VALUES (?, ?, ?, ?)`,
		scrub(name), scrub(scope), scrub(filterJSON), time.Now(),
	)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return models.SavedFilterRow{}, fmt.Errorf("store: a filter named %q already exists in this scope", scrub(name))
		}
		return models.SavedFilterRow{}, fmt.Errorf("store: create saved filter: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return models.SavedFilterRow{}, fmt.Errorf("store: create saved filter: %w", err)
	}
	rows, err := s.ListSavedFilters()
	if err != nil {
		return models.SavedFilterRow{}, err
	}
	for _, r := range rows {
		if r.ID == id {
			return r, nil
		}
	}
	return models.SavedFilterRow{}, ErrNotFound
}

// DeleteSavedFilter removes one preset; unknown ids yield ErrNotFound.
func (s *Store) DeleteSavedFilter(id int64) error {
	res, err := s.db.Exec(`DELETE FROM saved_filters WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("store: delete saved filter: %w", err)
	}
	return affectedOrNotFound(res, "store: delete saved filter")
}

// ---- career rollup ----

// RebuildCareer recomputes the whole player_career table from player_stats
// ⋈ matches (wins/ADR/KD/HS/openings/trades), player_round_stats (KAST)
// and clutches (record count). Full rebuild in one transaction — at the
// plan's scale (100 matches) this is well under the 5 s budget and is the
// only writer of the table, so it cannot drift (plan M3 §4).
func (s *Store) RebuildCareer() error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("store: rebuild career: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`DELETE FROM player_career`); err != nil {
		return fmt.Errorf("store: rebuild career: %w", err)
	}
	_, err = tx.Exec(
		`INSERT INTO player_career (steam_id, name, matches, wins, adr_avg, adr_std, kd, hs_pct,
			kast_pct, openings, opener_wins, trades, clutches, updated_at)
		SELECT ps.steam_id,
			COALESCE((SELECT p2.name FROM player_stats p2
				JOIN matches m2 ON m2.id = p2.match_id
				WHERE p2.steam_id = ps.steam_id
				ORDER BY m2.extracted_at DESC, m2.id DESC LIMIT 1), ''),
			COUNT(*),
			SUM(CASE WHEN (ps.side = 'ct' AND m.score_ct > m.score_t)
				OR (ps.side = 't' AND m.score_t > m.score_ct) THEN 1 ELSE 0 END),
			AVG(ps.adr),
			sqrt(MAX(AVG(ps.adr * ps.adr) - AVG(ps.adr) * AVG(ps.adr), 0)),
			CAST(SUM(ps.kills) AS REAL) / MAX(SUM(ps.deaths), 1),
			CASE WHEN SUM(ps.kills) > 0 THEN 100.0 * SUM(ps.headshots) / SUM(ps.kills) ELSE 0 END,
			COALESCE((SELECT 100.0 * AVG(prs.kast) FROM player_round_stats prs
				WHERE prs.steam_id = ps.steam_id), 0),
			SUM(ps.opening_kills + ps.opening_deaths),
			SUM(ps.opening_kills),
			SUM(ps.trade_kills),
			COALESCE((SELECT COUNT(*) FROM clutches c WHERE c.steam_id = ps.steam_id), 0),
			?
		FROM player_stats ps
		JOIN matches m ON m.id = ps.match_id
		GROUP BY ps.steam_id`,
		time.Now(),
	)
	if err != nil {
		return fmt.Errorf("store: rebuild career: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: rebuild career: %w", err)
	}
	return nil
}

// UpsertCareerFromMatch refreshes the player_career rollup after one
// match's rows changed. Implementation note: this performs the same full
// rebuild as RebuildCareer — incremental per-match merging is not worth the
// correctness risk at this library scale, and the full path stays under the
// plan §8 budget (documented deviation from the incremental wording).
func (s *Store) UpsertCareerFromMatch(_ int64) error { return s.RebuildCareer() }

// GetCareer returns one player's career rollup (ErrNotFound when absent).
func (s *Store) GetCareer(steamID string) (*models.CareerRow, error) {
	var (
		c       models.CareerRow
		updated time.Time
	)
	err := s.db.QueryRow(
		`SELECT steam_id, name, matches, wins, adr_avg, adr_std, kd, hs_pct, kast_pct,
			openings, opener_wins, trades, clutches, updated_at
		 FROM player_career WHERE steam_id = ?`, scrub(steamID),
	).Scan(
		&c.SteamID, &c.Name, &c.Matches, &c.Wins, &c.ADRAvg, &c.ADRStd, &c.KD,
		&c.HSPct, &c.KASTPct, &c.Openings, &c.OpenerWins, &c.Trades, &c.Clutches, &updated,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("store: get career: %w", err)
	}
	c.UpdatedAt = updated
	return &c, nil
}

// ListPlayers returns career summaries ("" = all), optionally filtered by a
// case-insensitive name/steam-id LIKE, ordered by most-recent match first.
func (s *Store) ListPlayers(query string) ([]models.CareerSummary, error) {
	// MAX(extracted_at) is formatted via strftime: the scalar subquery's
	// result loses the DATETIME declared type (the driver would hand back
	// TEXT, which does not convert to time.Time on Scan).
	q := `SELECT c.steam_id, c.name, c.matches,
		strftime('%Y-%m-%dT%H:%M:%fZ', (SELECT MAX(m.extracted_at) FROM player_stats ps
			JOIN matches m ON m.id = ps.match_id
			WHERE ps.steam_id = c.steam_id)),
		c.updated_at, c.adr_avg
		FROM player_career c`
	var args []any
	if qq := scrub(query); qq != "" {
		q += ` WHERE c.name LIKE ? OR c.steam_id LIKE ?`
		like := "%" + qq + "%"
		args = append(args, like, like)
	}
	q += ` ORDER BY 4 DESC, c.steam_id ASC`
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("store: list players: %w", err)
	}
	defer rows.Close()
	var out []models.CareerSummary
	for rows.Next() {
		var (
			r       models.CareerSummary
			last    sql.NullString
			updated time.Time
		)
		if err := rows.Scan(&r.SteamID, &r.Name, &r.Matches, &last, &updated, &r.ADRAvg); err != nil {
			return nil, fmt.Errorf("store: list players: %w", err)
		}
		r.LastSeen = updated
		if last.Valid {
			if t, err := time.Parse("2006-01-02T15:04:05.000Z", last.String); err == nil {
				r.LastSeen = t
			}
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list players: %w", err)
	}
	return out, nil
}

// trendMetricWhitelist maps GetTrend metric names to SQL expressions
// (identifiers only — no user input ever reaches the query text).
var trendMetricWhitelist = map[string]string{
	"adr": "ps.adr",
	"kast": `COALESCE((SELECT 100.0 * AVG(prs.kast) FROM player_round_stats prs
		WHERE prs.match_id = m.id AND prs.steam_id = ps.steam_id), 0)`,
	"kd": "CAST(ps.kills AS REAL) / MAX(ps.deaths, 1)",
	"hs": "ps.hs_pct"}

// GetTrend returns a per-match metric series for one player, oldest →
// newest. metric ∈ adr|kast|kd|hs (unknown names yield an error).
func (s *Store) GetTrend(steamID, metric string) ([]models.ProfileTrendPoint, error) {
	expr, ok := trendMetricWhitelist[metric]
	if !ok {
		return nil, fmt.Errorf("store: unknown trend metric %q", metric)
	}
	rows, err := s.db.Query(
		`SELECT m.id, `+expr+`
		 FROM player_stats ps
		 JOIN matches m ON m.id = ps.match_id
		 WHERE ps.steam_id = ? AND m.extracted_at IS NOT NULL
		 ORDER BY m.extracted_at ASC, m.id ASC`, scrub(steamID),
	)
	if err != nil {
		return nil, fmt.Errorf("store: get trend: %w", err)
	}
	defer rows.Close()
	var out []models.ProfileTrendPoint
	for rows.Next() {
		var r models.ProfileTrendPoint
		if err := rows.Scan(&r.MatchID, &r.Value); err != nil {
			return nil, fmt.Errorf("store: get trend: %w", err)
		}
		r.Seq = len(out)
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get trend: %w", err)
	}
	return out, nil
}

// GetPlayerHistory returns one player's per-match history (most recent
// first, ≤100) with KAST% averaged from player_round_stats per match (0
// when the match has no analytics rows).
func (s *Store) GetPlayerHistory(steamID string) ([]models.ProfileHistoryRow, error) {
	rows, err := s.db.Query(
		`SELECT m.id, m.extracted_at, m.map, m.score_ct, m.score_t, ps.side,
			ps.kills, ps.deaths, ps.assists, ps.adr,
			COALESCE((SELECT 100.0 * AVG(prs.kast) FROM player_round_stats prs
				WHERE prs.match_id = m.id AND prs.steam_id = ps.steam_id), 0)
		 FROM player_stats ps
		 JOIN matches m ON m.id = ps.match_id
		 WHERE ps.steam_id = ? AND m.extracted_at IS NOT NULL
		 ORDER BY m.extracted_at DESC, m.id DESC
		 LIMIT 100`, scrub(steamID),
	)
	if err != nil {
		return nil, fmt.Errorf("store: get player history: %w", err)
	}
	defer rows.Close()
	var out []models.ProfileHistoryRow
	for rows.Next() {
		var r models.ProfileHistoryRow
		var extracted sql.NullTime
		if err := rows.Scan(
			&r.MatchID, &extracted, &r.Map, &r.ScoreCT, &r.ScoreT, &r.Side,
			&r.Kills, &r.Deaths, &r.Assists, &r.ADR, &r.KASTPct,
		); err != nil {
			return nil, fmt.Errorf("store: get player history: %w", err)
		}
		if extracted.Valid {
			r.ExtractedAt = extracted.Time
		}
		r.Win = (r.Side == "ct" && r.ScoreCT > r.ScoreT) || (r.Side == "t" && r.ScoreT > r.ScoreCT)
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get player history: %w", err)
	}
	return out, nil
}

// GetPlayerClutchStats aggregates one player's clutch records (played/won).
func (s *Store) GetPlayerClutchStats(steamID string) (models.ProfileClutchCounts, error) {
	var c models.ProfileClutchCounts
	err := s.db.QueryRow(
		`SELECT COUNT(*), COALESCE(SUM(won), 0) FROM clutches WHERE steam_id = ?`, scrub(steamID),
	).Scan(&c.Played, &c.Won)
	if err != nil {
		return models.ProfileClutchCounts{}, fmt.Errorf("store: get player clutch stats: %w", err)
	}
	return c, nil
}

// GetPlayerWeaponJSONs returns one player's per-match weapon-breakdown JSON
// pairs (merge in the caller — see ProfileService.GetProfile).
func (s *Store) GetPlayerWeaponJSONs(steamID string) ([]models.ProfileWeaponJSONs, error) {
	rows, err := s.db.Query(
		`SELECT kills_by_weapon, damage_by_weapon FROM player_stats
		 WHERE steam_id = ? ORDER BY match_id ASC`, scrub(steamID),
	)
	if err != nil {
		return nil, fmt.Errorf("store: get player weapon jsons: %w", err)
	}
	defer rows.Close()
	var out []models.ProfileWeaponJSONs
	for rows.Next() {
		var r models.ProfileWeaponJSONs
		if err := rows.Scan(&r.KillsByWeapon, &r.DamageByWeapon); err != nil {
			return nil, fmt.Errorf("store: get player weapon jsons: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get player weapon jsons: %w", err)
	}
	return out, nil
}
