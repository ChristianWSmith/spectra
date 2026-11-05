package store

import (
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// This file is the M3 persistence surface: analysis_config, the per-match
// derived-row replace/getters (round_classifications, player_round_stats,
// clutches, engagements, utility_events), the economy view with loss-bonus
// reconstruction, combat stats computed from stored rows, saved-filter
// presets and the player_career rollup. Every string write passes scrub.

// DefaultConfig is the seeded analysis_config row (configurable
// definitions with transparent rules). The eco thresholds are TEAM
// equipment values at freeze-time end (a full buy for five sits around
// $20k, a force around $10k). TradeOppDistance is the trade-opportunity
// radius in world units (an untraded death only counts as a missed trade
// when a living teammate of the victim was within it of the killer). The
// 1000 u default (~25 m) is the range in which trades actually happen:
// teammates close that much ground inside the default 5 s trade window at
// CS2 run speeds (215 u/s with a rifle, 250 u/s knife), and a radius
// inside the melee zone (5 m ≈ 200 u) would only ever select deaths that
// get traded anyway — leaving the gated count at ~0 on real demos.
var DefaultConfig = models.AnalysisConfig{
	TradeWindowS:     5.0,
	EcoFullBuy:       20000,
	EcoForce:         10000,
	TradeOppDistance: 1000,
	RuleVersion:      1,
}

// Per-table column lists (G1): each const is the row WITHOUT the
// match_id key column — the Replace* INSERT prefixes `match_id, `, the
// getter selects the list verbatim. Order is the scan/insert order.
// savedFilterCols has no match_id (saved_filters is library-scoped): the
// INSERT names it verbatim, the getters prefix `id, `.
const (
	analysisConfigCols = `trade_window_s, eco_full_buy, eco_force, trade_opp_distance, rule_version`

	roundClassCols = `round, label, confidence, rule_version, explanation`

	playerRoundCols = `round, steam_id, name, kills, assists, deaths, traded, survived,
		kast, dmg, util_dmg, money_start, equip, spent, rule_version`

	clutchCols = `round, size, steam_id, name, start_tick, end_tick, bomb_state, hp_left,
		equip, won, kill_ticks, replay_anchor`

	engagementCols = `seq, tick, round, kind, a_steam, a_name, b_steam, b_name, distance, won_by`

	utilityCols = `seq, tick, round, thrower, thrower_name, kind, det_x, det_y, damage,
		flash_ms, affected, site, trajectory_ref`

	playerCareerCols = `steam_id, name, matches, wins, adr_avg, adr_std, kd, hs_pct,
		kast_pct, openings, opener_wins, trades, clutches, updated_at`

	savedFilterCols = `name, scope, filter_json, created_at`
)

// GetConfig returns the analysis_config row, seeding the defaults on first
// use (single-row table: id = 1).
func (s *Store) GetConfig() (models.AnalysisConfig, error) {
	var c models.AnalysisConfig
	err := s.db.QueryRow(
		`SELECT `+analysisConfigCols+` FROM analysis_config WHERE id = 1`,
	).Scan(&c.TradeWindowS, &c.EcoFullBuy, &c.EcoForce, &c.TradeOppDistance, &c.RuleVersion)
	if errors.Is(err, sql.ErrNoRows) {
		if _, err := s.db.Exec(
			`INSERT INTO analysis_config (id, `+analysisConfigCols+`)
			 VALUES (1, ?, ?, ?, ?, ?)`,
			DefaultConfig.TradeWindowS, DefaultConfig.EcoFullBuy, DefaultConfig.EcoForce,
			DefaultConfig.TradeOppDistance, DefaultConfig.RuleVersion,
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
		`INSERT INTO analysis_config (id, `+analysisConfigCols+`)
		 VALUES (1, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET trade_window_s = excluded.trade_window_s,
			eco_full_buy = excluded.eco_full_buy, eco_force = excluded.eco_force,
			trade_opp_distance = excluded.trade_opp_distance,
			rule_version = excluded.rule_version`,
		c.TradeWindowS, c.EcoFullBuy, c.EcoForce, c.TradeOppDistance, c.RuleVersion,
	); err != nil {
		return models.AnalysisConfig{}, fmt.Errorf("store: set analysis_config: %w", err)
	}
	return s.GetConfig()
}

// ReplaceRoundClassifications swaps a match's round_classifications rows in
// one transaction (delete-then-insert).
func (s *Store) ReplaceRoundClassifications(matchID int64, rows []models.RoundClassification) error {
	const op = "store: replace round classifications"
	return s.replaceMatchRows(op, "round_classifications", "match_id, "+roundClassCols, matchID, len(rows),
		func(stmt *sql.Stmt, i int) error {
			r := rows[i]
			if _, err := stmt.Exec(matchID, r.Round, scrub(r.Label), r.Confidence, r.RuleVersion, scrub(r.Explanation)); err != nil {
				return fmt.Errorf("%s: %w", op, err)
			}
			return nil
		})
}

// ReplacePlayerRounds swaps a match's player_round_stats rows in one
// transaction.
func (s *Store) ReplacePlayerRounds(matchID int64, rows []models.PlayerRoundStat) error {
	const op = "store: replace player rounds"
	return s.replaceMatchRows(op, "player_round_stats", "match_id, "+playerRoundCols, matchID, len(rows),
		func(stmt *sql.Stmt, i int) error {
			r := rows[i]
			if _, err := stmt.Exec(
				matchID, r.Round, scrub(r.SteamID), scrub(r.Name), r.Kills, r.Assists, r.Deaths,
				b2i(r.Traded), b2i(r.Survived), b2i(r.KAST), r.DMG, r.UtilDmg,
				r.MoneyStart, r.Equip, r.Spent, r.RuleVersion,
			); err != nil {
				return fmt.Errorf("%s: %w", op, err)
			}
			return nil
		})
}

// ReplaceClutches swaps a match's clutches rows in one transaction.
func (s *Store) ReplaceClutches(matchID int64, rows []models.Clutch) error {
	const op = "store: replace clutches"
	return s.replaceMatchRows(op, "clutches", "match_id, "+clutchCols, matchID, len(rows),
		func(stmt *sql.Stmt, i int) error {
			r := rows[i]
			if _, err := stmt.Exec(
				matchID, r.Round, r.Size, scrub(r.SteamID), scrub(r.Name), r.StartTick, r.EndTick,
				scrub(r.BombState), r.HPLeft, r.Equip, b2i(r.Won), scrub(r.KillTicks), r.ReplayAnchor,
			); err != nil {
				return fmt.Errorf("%s: %w", op, err)
			}
			return nil
		})
}

// ReplaceEngagements swaps a match's engagements rows in one transaction
// (seq is rewritten 0..n-1 in slice order so the PK stays dense).
func (s *Store) ReplaceEngagements(matchID int64, rows []models.Engagement) error {
	const op = "store: replace engagements"
	return s.replaceMatchRows(op, "engagements", "match_id, "+engagementCols, matchID, len(rows),
		func(stmt *sql.Stmt, i int) error {
			r := rows[i]
			if _, err := stmt.Exec(
				matchID, i, r.Tick, r.Round, scrub(r.Kind), scrub(r.ASteam), scrub(r.AName),
				scrub(r.BSteam), scrub(r.BName), r.Distance, scrub(r.WonBy),
			); err != nil {
				return fmt.Errorf("%s: %w", op, err)
			}
			return nil
		})
}

// ReplaceUtility swaps a match's utility_events rows in one transaction
// (seq rewritten 0..n-1 in slice order).
func (s *Store) ReplaceUtility(matchID int64, rows []models.UtilityEvent) error {
	const op = "store: replace utility"
	return s.replaceMatchRows(op, "utility_events", "match_id, "+utilityCols, matchID, len(rows),
		func(stmt *sql.Stmt, i int) error {
			r := rows[i]
			if _, err := stmt.Exec(
				matchID, i, r.Tick, r.Round, scrub(r.Thrower), scrub(r.ThrowerName), scrub(r.Kind),
				nvl(r.DetX), nvl(r.DetY), r.Damage, r.FlashMs, scrub(r.Affected), scrub(r.Site), scrub(r.TrajectoryRef),
			); err != nil {
				return fmt.Errorf("%s: %w", op, err)
			}
			return nil
		})
}

// ReplaceTradeKills rewrites one match's player_stats.trade_kills from the
// cfg-aware analytics pass — the ONE trade-window rule (analytics.
// Engagements KindTrade rows counted per killer). Every player row resets
// to 0 first so a recompute under a smaller window leaves no stale counts;
// steam IDs without a player_stats row are ignored. The extractor's
// import-time value (hardcoded 5 s) is the seed this overwrites on every
// Compute, which is what makes the column — and every consumer of it
// (scoreboard Trade, career trades, profile trade rate, the
// successful_trades metric, Combat TradeRate) — follow
// analysis_config.TradeWindowS.
func (s *Store) ReplaceTradeKills(matchID int64, counts map[string]int) error {
	const op = "store: replace trade kills"
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("%s: %w", op, err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`UPDATE player_stats SET trade_kills = 0 WHERE match_id = ?`, matchID); err != nil {
		return fmt.Errorf("%s: %w", op, err)
	}
	stmt, err := tx.Prepare(`UPDATE player_stats SET trade_kills = ? WHERE match_id = ? AND steam_id = ?`)
	if err != nil {
		return fmt.Errorf("%s: %w", op, err)
	}
	defer func() { _ = stmt.Close() }()
	for sid, n := range counts {
		if n <= 0 {
			continue
		}
		if _, err := stmt.Exec(n, matchID, scrub(sid)); err != nil {
			return fmt.Errorf("%s: %w", op, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("%s: %w", op, err)
	}
	return nil
}

// GetRoundClasses returns a match's stored classifications by round ASC.
func (s *Store) GetRoundClasses(matchID int64) ([]models.RoundClassification, error) {
	rows, err := s.db.Query(
		`SELECT `+roundClassCols+`
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
	q := `SELECT ` + playerRoundCols + `
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
		`SELECT `+clutchCols+`
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
	q := `SELECT ` + engagementCols + `
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
		`SELECT `+utilityCols+`
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
		r.DetX, r.DetY = nullFloat(detX), nullFloat(detY)
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get utility: %w", err)
	}
	return out, nil
}

// GetEconomy returns the per-round economy view (warmup and pregame/knife
// rounds excluded — the counted-rounds predicate `warmup = 0 AND pregame = 0`
// below is the SQL twin of analytics.CountedRounds; keep the two in sync:
// index-based rules such as the MR12 pistol stride shift if a knife round
// slips into either side): rounds ⋈ round_economy ⋈ round_classifications with
// loss-bonus reconstruction applied. Loss bonus is INFERRED (reconstructed
// from round winners under the CS2 loss-count rules — see
// applyLossBonuses); InferredCT/ InferredT are set accordingly; per-side
// ClassCT/ClassT/ClassWhy* stay empty for the caller to fill via
// analytics.buyClass (unexported: package-internal only, and the store
// cannot import analytics anyway — documented cycle deviation). SpentCT/
// SpentT carry round_economy.spent — the side's real per-round buy spend
// (sum of the players' cumulative money-spent deltas between freeze-time
// ends, see extract.agg.freezeEnd). FreePistolCT/FreePistolT carry
// round_economy.free_pistol_value — the side's held free spawn-issued
// default-pistol value at the same freeze end (CS2.md "Free spawn-issued
// default pistol"). It is stored, NOT subtracted anywhere: the chart's
// net worth is Equip* + Money* (frontend lib/econ.js, pinned by
// lib/econ.test.js) and can therefore never fall below the equipment
// value — subtracting the granted pistols dropped it below equipment
// value on every side holding less cash than the pistols it still had.
func (s *Store) GetEconomy(matchID int64) ([]models.EconomyRow, error) {
	rows, err := s.db.Query(
		`SELECT r.number, r.winner, r.warmup, r.equip_ct, r.equip_t,
			COALESCE(ct.money_sampled_sum, 0), COALESCE(t.money_sampled_sum, 0),
			COALESCE(ct.spent, 0), COALESCE(t.spent, 0),
			COALESCE(ct.free_pistol_value, 0), COALESCE(t.free_pistol_value, 0),
			COALESCE(rc.label, ''), COALESCE(rc.explanation, ''),
			COALESCE(rc.rule_version, 0)
		 FROM rounds r
		 LEFT JOIN round_economy ct ON ct.match_id = r.match_id AND ct.round = r.number AND ct.side = 'ct'
		 LEFT JOIN round_economy t ON t.match_id = r.match_id AND t.round = r.number AND t.side = 't'
		 LEFT JOIN round_classifications rc ON rc.match_id = r.match_id AND rc.round = r.number
		 WHERE r.match_id = ? AND r.warmup = 0 AND r.pregame = 0
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
			&r.MoneyCT, &r.MoneyT, &r.SpentCT, &r.SpentT, &r.FreePistolCT, &r.FreePistolT,
			&r.Label, &r.Explanation, &r.RuleVersion); err != nil {
			return nil, fmt.Errorf("store: get economy: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get economy: %w", err)
	}
	// Outcome flags + loss-bonus reconstruction (inferred — Inferred*
	// signals the fact/inference badge).
	for i := range out {
		r := &out[i]
		r.WonCT = r.Winner == "ct"
		r.WonT = r.Winner == "t"
		r.InferredCT, r.InferredT = true, true
	}
	exact, _ := s.GetRoundPlayerSides(matchID)
	applyLossBonuses(out, sideFlips(out, exact))
	return out, nil
}

// CS2 loss-bonus rules (verified against the game — see CS2.md):
//
//   - per-TEAM loss count: +1 after a loss, -1 after a win (min 0, max 4;
//     mp_consecutive_loss_aversion = 1 — a win STEPS DOWN, it does not
//     reset the ladder);
//   - every half starts with the loss count at 1 (mp_starting_losses), so
//     losing a pistol round pays $1900, not $1400;
//   - a lost round pays cash_team_loser_bonus (1400) +
//     cash_team_loser_bonus_consecutive_rounds (500) × count, capped at
//     3400 (count 4).
//
// Sides are not teams: they swap at every side switch, so the walk tracks
// two teams (A opens CT, B opens T) and re-maps sides per round.
const (
	lossBonusBase  = 1400
	lossBonusStep  = 500
	lossBonusMax   = 4 // mp_consecutive_loss_max
	lossBonusStart = 1 // mp_starting_losses
)

// applyLossBonuses fills LossBonusCT/LossBonusT for every round: the bonus
// the side's team would collect by LOSING that round (never 0 in CS2 —
// even a team off a win earns the $1400 base). flips[i] marks a side
// switch on the boundary before round i.
func applyLossBonuses(out []models.EconomyRow, flips []bool) {
	bonus := func(count int) int {
		if count > lossBonusMax {
			count = lossBonusMax
		}
		return lossBonusBase + lossBonusStep*count
	}
	stepDown := func(c int) int {
		if c > 0 {
			return c - 1
		}
		return 0
	}
	stepUp := func(c int) int {
		if c < lossBonusMax {
			return c + 1
		}
		return lossBonusMax
	}
	counts := [2]int{lossBonusStart, lossBonusStart} // team A, team B
	flip := false                                    // sides swapped vs the first half
	teamOn := func(side string) int {                // 0 = team A, 1 = team B
		// A opens CT: before the first switch CT names A, afterwards B.
		ctIsA := !flip
		if side == "ct" {
			if ctIsA {
				return 0
			}
			return 1
		}
		if ctIsA {
			return 1
		}
		return 0
	}
	for i := range out {
		r := &out[i]
		if i < len(flips) && flips[i] {
			flip = !flip
			counts = [2]int{lossBonusStart, lossBonusStart} // half start
		}
		ct, t := teamOn("ct"), teamOn("t")
		r.LossBonusCT = bonus(counts[ct])
		r.LossBonusT = bonus(counts[t])
		switch r.Winner {
		case "ct":
			counts[ct] = stepDown(counts[ct])
			counts[t] = stepUp(counts[t])
		case "t":
			counts[t] = stepDown(counts[t])
			counts[ct] = stepUp(counts[ct])
		}
	}
}

// sideFlips reports, per round index, whether the side↔team mapping
// differs from the previous round (a side switch happened at that
// boundary). The comparison uses the extractor's exact per-round
// freeze-end sides (round_player_sides): a player observed on the other
// side proves the switch. Rounds missing exact samples on either side of
// the boundary report no flip.
func sideFlips(rounds []models.EconomyRow, exact map[int]map[string]string) []bool {
	n := len(rounds)
	flips := make([]bool, n)
	for i := 1; i < n; i++ {
		prev, cur := exact[rounds[i-1].Round], exact[rounds[i].Round]
		if len(prev) == 0 || len(cur) == 0 {
			continue
		}
		for sid, ps := range prev {
			if cs, ok := cur[sid]; ok && ps != "" && cs != "" && ps != cs {
				flips[i] = true
				break
			}
		}
	}
	return flips
}

// GetCombatStats computes per-player combat deep-dive rows from stored data
// — damage conversion and friendly fire from the events
// table, entry/trade rates from player_stats, untraded deaths from
// engagements, KAST% from player_round_stats. All four percent fields of
// the returned row (DMGConvPct, EntryRate, TradeRate, KASTPct) share one
// scale: 0..100 percents — the read-DTO convention every consumer renders
// with frontend fmtPercent directly (a 0..1 fraction there renders as
// "0.05%", not "5%"); the scale note at the assignments is pinned by
// TestGetCombatStatsFromStoredRows. Team attribution (FF, and the
// trade-opportunity heuristic) uses each player's FINAL side — events carry
// no team column, so this is an approximation (documented; badge in UI).
// UntradedDeaths is the raw engagement count (timing only);
// TradeOppMissed is the distance-gated subset of it (inferred heuristic —
// UI badge): an untraded death counts only when the kill event's
// detail_json.nearDist — the closest living teammate of the victim to the
// KILLER at the death tick, measured once at extract time (extract.
// nearTeammateDist) — is ≥ 0 (nobody measurable → -1 → never counted) and
// ≤ the stored analysis_config.trade_opp_distance (default 1000 units,
// calibrated to the range trades actually happen in — see DefaultConfig).
//
// This SQL is AUTHORITATIVE: it is the single implementation of these
// rules (there is no second in-memory copy to drift from), and every
// decision below is pinned by TestGetCombatStatsSQLDecisions:
//
//  1. Friendly fire is `ap.side = vp.side`: an absent player row (LEFT JOIN
//     NULL) never matches, but two players whose stored side is "" (unknown)
//     DO match (empty == empty).
//  2. Damage-on-kill needs a kill row with the SAME attacker, victim AND
//     tick — a same-tick trade kill credits the actual killer, never any
//     other death of the victim on that tick.
//  3. Rows come back ordered by player NAME (ORDER BY p.name ASC).
//  4. TradeOppMissed is proximity-gated against analysis_config.
//     trade_opp_distance: the untraded row must join to its kill event's
//     detail_json.nearDist within [0, distance]. No matching kill event,
//     malformed/absent JSON, a missing nearDist key or the -1 sentinel all
//     yield NULL/−1 → NOT counted (no position data → no opportunity
//     claim). UntradedDeaths stays the ungated count — the two columns are
//     deliberately different metrics.
//
// Change these decisions (and this comment) deliberately — they are
// pinned by TestGetCombatStatsSQLDecisions.
func (s *Store) GetCombatStats(matchID int64) ([]models.CombatStat, error) {
	cfg, err := s.GetConfig()
	if err != nil {
		return nil, err
	}
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
		 `+playersJoin(joinLeft, "ap", "e.match_id", "e.attacker", true)+`
		 `+playersJoin(joinLeft, "vp", "e.match_id", "e.victim", true)+`
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

	// Untraded deaths per victim (raw — timing only, no position claim).
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

	// Trade opportunities missed: the untraded deaths whose kill event
	// carries a nearDist within [0, cfg.TradeOppDistance] — i.e. a living
	// teammate of the victim was close enough to the killer at the death
	// tick to actually trade him. The scalar subquery joins the untraded
	// engagement back to its kill event (same tick/attacker/victim);
	// json_valid guards malformed payloads (json_extract would error),
	// a missing key or the -1 sentinel yields NULL/out-of-range → not
	// counted (decision 4 — see the doc comment).
	tradeOpp := map[string]int{}
	toRows, err := s.db.Query(
		`SELECT e.b_steam, COUNT(*) FROM engagements e
		 WHERE e.match_id = ? AND e.kind = 'untraded' AND e.b_steam <> ''
		   AND (SELECT CASE WHEN json_valid(k.detail_json)
		                    THEN json_extract(k.detail_json, '$.nearDist') END
		        FROM events k
		        WHERE k.match_id = e.match_id AND k.kind = 'kill'
		          AND k.tick = e.tick AND k.attacker = e.a_steam
		          AND k.victim = e.b_steam
		        LIMIT 1) BETWEEN 0 AND ?
		 GROUP BY e.b_steam`, matchID, cfg.TradeOppDistance,
	)
	if err != nil {
		return nil, fmt.Errorf("store: get combat stats: %w", err)
	}
	defer toRows.Close()
	for toRows.Next() {
		var sid string
		var n int
		if err := toRows.Scan(&sid, &n); err != nil {
			return nil, fmt.Errorf("store: get combat stats: %w", err)
		}
		tradeOpp[sid] = n
	}
	if err := toRows.Err(); err != nil {
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
		 `+playersJoin(joinInner, "p", "ps.match_id", "ps.steam_id", false)+`
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
		// Percent scale (pinned by TestGetCombatStatsFromStoredRows): all
		// four percent fields of this row are 0..100, like KASTPct and
		// DMGConvPct above — NOT 0..1 fractions. Entry% is bounded within
		// 0..100 by construction (the extractor credits at most one first
		// blood per round — extract/agg.go); Trade% is a ratio over the
		// player's own deaths and may legitimately exceed 100.
		if roundsPlayed > 0 {
			r.EntryRate = 100 * float64(entryKills) / float64(roundsPlayed)
		}
		if deaths > 0 {
			r.TradeRate = 100 * float64(tradeKills) / float64(deaths)
		}
		r.UntradedDeaths = untraded[r.SteamID]
		r.TradeOppMissed = tradeOpp[r.SteamID] // distance-gated subset (UI badge)
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
// match (round ASC, side). The SELECT is hand-listed rather than
// roundEconomyCols on purpose: the analytics view stops at the v1 fields
// (models.RoundEconomyView) while the table also carries `spent` and
// `free_pistol_value` (the writer's list, roundEconomyCols) — widen the
// view type first if the classification pass ever needs them.
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
// and pregame included — callers filter).
func (s *Store) GetRoundInfos(matchID int64) ([]models.RoundInfo, error) {
	rows, err := s.db.Query(
		`SELECT number, winner, warmup, pregame, start_tick, end_tick, freeze_end_tick, equip_ct, equip_t
		 FROM rounds WHERE match_id = ? ORDER BY number ASC`, matchID,
	)
	if err != nil {
		return nil, fmt.Errorf("store: get round infos: %w", err)
	}
	defer rows.Close()
	var out []models.RoundInfo
	for rows.Next() {
		var r models.RoundInfo
		if err := rows.Scan(&r.Number, &r.Winner, &r.Warmup, &r.Pregame, &r.StartTick, &r.EndTick, &r.FreezeEndTick, &r.EquipCT, &r.EquipT); err != nil {
			return nil, fmt.Errorf("store: get round infos: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get round infos: %w", err)
	}
	return out, nil
}

// GetRoundPlayerSides returns the extractor's per-round side samples as
// round → steamID → side (round ASC). Empty map when the match has no
// stored samples (e.g. an import that failed before they were written) —
// callers treat a missing sample as an unknown side (no guess).
func (s *Store) GetRoundPlayerSides(matchID int64) (map[int]map[string]string, error) {
	rows, err := s.db.Query(
		`SELECT round, steam_id, side FROM round_player_sides
		 WHERE match_id = ? ORDER BY round ASC, steam_id ASC`, matchID,
	)
	if err != nil {
		return nil, fmt.Errorf("store: get round player sides: %w", err)
	}
	defer rows.Close()
	out := map[int]map[string]string{}
	for rows.Next() {
		var (
			round int
			sid   string
			side  string
		)
		if err := rows.Scan(&round, &sid, &side); err != nil {
			return nil, fmt.Errorf("store: get round player sides: %w", err)
		}
		m := out[round]
		if m == nil {
			m = map[string]string{}
			out[round] = m
		}
		m[sid] = side
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get round player sides: %w", err)
	}
	return out, nil
}

// ---- saved filters ----

// ListSavedFilters returns all saved filter presets, newest first.
func (s *Store) ListSavedFilters() ([]models.SavedFilterRow, error) {
	rows, err := s.db.Query(
		`SELECT id, ` + savedFilterCols + ` FROM saved_filters ORDER BY created_at DESC, id DESC`,
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
		`INSERT INTO saved_filters (`+savedFilterCols+`) VALUES (?, ?, ?, ?)`,
		scrub(name), scrub(scope), scrub(filterJSON), time.Now(),
	)
	if err != nil {
		if isUniqueErr(err) {
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
// practice scale (100 matches) this is well under the 5 s budget and is the
// only writer of the table, so it cannot drift.
//
// Layer notes — per-match rows (player_stats) vs the cross-match rollup,
// justified and deliberate, not duplication:
//
//   - wins: the SUM(CASE WHEN …) below is the SQL twin of models.WinFor
//     (the Go helper GetPlayerHistory uses for its per-match Win flag).
//   - HS%: player_stats.hs_pct is the PER-MATCH rate (extract stamps it as
//     headshots/kills of that match); the career column pools the counts —
//     SUM(headshots)/SUM(kills) — because an average of per-match
//     percentages would over-weight short matches (same pooled shape the
//     metrics layer's ratio() emits).
//   - ADRStd: population stddev of the per-match player_stats.adr values,
//     sqrt(avg(x²) − avg(x)²), computed in SQL here because those are the
//     same rows this statement already aggregates; no Go code computes it
//     (internal/metrics' stddev() is a separate generic query layer over
//     arbitrary columns, not a second implementation of this one).
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
		`INSERT INTO player_career (`+playerCareerCols+`)
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
			`+kdCareerSQL+`,
			CASE WHEN SUM(ps.kills) > 0 THEN 100.0 * SUM(ps.headshots) / SUM(ps.kills) ELSE 0 END,
			`+kastCareerSQL+`,
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

// GetCareer returns one player's career rollup (ErrNotFound when absent).
func (s *Store) GetCareer(steamID string) (*models.CareerRow, error) {
	var (
		c       models.CareerRow
		updated time.Time
	)
	err := s.db.QueryRow(
		`SELECT `+playerCareerCols+`
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
// (identifiers only — no user input ever reaches the query text). The kast
// and kd entries reuse the shared scope consts in queries.go — the same
// expressions GetPlayerHistory and GetScoreboard run.
var trendMetricWhitelist = map[string]string{
	"adr":  "ps.adr",
	"kast": kastPerMatchSQL,
	"kd":   kdPerMatchSQL,
	"hs":   "ps.hs_pct"}

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
// when the match has no analytics rows) and StartSide — the freeze-end
// side sample of the player's first COUNTED round (warmup/pregame rounds
// are not the side a match opens on; a match with no stored sample yields
// "" rather than a guess). Side stays player_stats.side (final side) —
// the input models.WinFor uses below.
func (s *Store) GetPlayerHistory(steamID string) ([]models.ProfileHistoryRow, error) {
	rows, err := s.db.Query(
		`SELECT m.id, m.extracted_at, m.map, m.score_ct, m.score_t, ps.side,
			(SELECT rps.side FROM round_player_sides rps
			 JOIN rounds r ON r.match_id = rps.match_id AND r.number = rps.round
			 WHERE rps.match_id = ps.match_id AND rps.steam_id = ps.steam_id
			   AND r.warmup = 0 AND r.pregame = 0 AND rps.side IN ('ct','t')
			 ORDER BY r.number ASC LIMIT 1),
			ps.kills, ps.deaths, ps.assists, ps.adr,
			`+kastPerMatchSQL+`
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
		var startSide sql.NullString
		if err := rows.Scan(
			&r.MatchID, &extracted, &r.Map, &r.ScoreCT, &r.ScoreT, &r.Side, &startSide,
			&r.Kills, &r.Deaths, &r.Assists, &r.ADR, &r.KASTPct,
		); err != nil {
			return nil, fmt.Errorf("store: get player history: %w", err)
		}
		r.ExtractedAt = nullTime(extracted)
		r.StartSide = startSide.String
		r.Win = models.WinFor(r.Side, r.ScoreCT, r.ScoreT)
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
// triplets (merge in the caller — ProfileService.GetProfile).
//
// HeadshotsByWeapon is derived from the stored kill events rather than an
// extract column, with the SAME eligibility extract uses to credit
// player_stats.headshots and kills_by_weapon (internal/extract/agg.go):
//
//   - kind='kill' with headshot=1 (kp.headshots++ next to weaponKills),
//   - attacker = this player (killerKey != 0) and attacker <> victim
//     (suicides get no credit),
//   - NOT a teamkill: mirrors extract's sameSide gate — only two KNOWN,
//     equal sides block credit. The sides come from round_player_sides
//     (freeze-end samples) via LEFT JOINs, so a missing sample on either
//     side behaves like extract's unknown "" side and passes.
//   - a counted round (rounds.warmup = 0 AND pregame = 0): extract's
//     realPeriod gates warmup and pre-match (knife) rounds the same way,
//     and those rounds' kills still land in events.
//
// The golden-demo acceptance test pins the sum of the folded per-weapon
// headshots to player_stats.headshots for every player.
func (s *Store) GetPlayerWeaponJSONs(steamID string) ([]models.ProfileWeaponJSONs, error) {
	rows, err := s.db.Query(
		`SELECT ps.kills_by_weapon, ps.damage_by_weapon,
			COALESCE((SELECT json_group_object(w.weapon, w.n) FROM (
				SELECT e.weapon, COUNT(*) AS n
				FROM events e
				LEFT JOIN round_player_sides ka
					ON ka.match_id = e.match_id AND ka.round = e.round AND ka.steam_id = e.attacker
				LEFT JOIN round_player_sides kv
					ON kv.match_id = e.match_id AND kv.round = e.round AND kv.steam_id = e.victim
				JOIN rounds r ON r.match_id = e.match_id AND r.number = e.round
				WHERE e.match_id = ps.match_id AND e.attacker = ps.steam_id
					AND e.kind = 'kill' AND e.headshot = 1
					AND e.attacker <> e.victim
					AND r.warmup = 0 AND r.pregame = 0
					AND (ka.side IS NULL OR kv.side IS NULL OR ka.side <> kv.side)
				GROUP BY e.weapon) w), '')
		 FROM player_stats ps
		 WHERE ps.steam_id = ? ORDER BY ps.match_id ASC`, scrub(steamID),
	)
	if err != nil {
		return nil, fmt.Errorf("store: get player weapon jsons: %w", err)
	}
	defer rows.Close()
	var out []models.ProfileWeaponJSONs
	for rows.Next() {
		var r models.ProfileWeaponJSONs
		if err := rows.Scan(&r.KillsByWeapon, &r.DamageByWeapon, &r.HeadshotsByWeapon); err != nil {
			return nil, fmt.Errorf("store: get player weapon jsons: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get player weapon jsons: %w", err)
	}
	return out, nil
}

// ---- profile read models (side splits, trade opportunities, averages) ----

// GetPlayerSideSplits rolls a player's per-round stats up by the side
// they played each round — the profile's Sides card. Every counted round
// contributes to exactly ONE row (teams switch at halftime, which is why
// a per-match side column is meaningless): player_round_stats (one row
// per player per counted round — analytics.PlayerRounds) joined to that
// round's freeze-end side sample (round_player_sides — the extractor's
// exact per-round sides, never a guess) and to the round's winner
// (rounds.winner) for the round-win count. A round without a stored side
// sample for the player yields no row (unknown side → skipped). ADR =
// SUM(player_round_stats.dmg) / rounds — the same HP-capped damage basis
// player_stats.adr uses; KASTPct = 100 × AVG(player_round_stats.kast).
// Returned ordered by side (ct, t).
func (s *Store) GetPlayerSideSplits(steamID string) ([]models.ProfileSideSplit, error) {
	rows, err := s.db.Query(
		`SELECT rps.side, COUNT(*),
			SUM(CASE WHEN rd.winner = rps.side THEN 1 ELSE 0 END),
			SUM(prs.kills), SUM(prs.deaths),
			1.0 * SUM(prs.dmg) / COUNT(*),
			100.0 * AVG(prs.kast)
		 FROM player_round_stats prs
		 JOIN round_player_sides rps
		   ON rps.match_id = prs.match_id AND rps.round = prs.round AND rps.steam_id = prs.steam_id
		 JOIN rounds rd ON rd.match_id = prs.match_id AND rd.number = prs.round
		 WHERE prs.steam_id = ? AND rps.side IN ('ct','t')
		   AND rd.warmup = 0 AND rd.pregame = 0
		 GROUP BY rps.side
		 ORDER BY rps.side ASC`, scrub(steamID),
	)
	if err != nil {
		return nil, fmt.Errorf("store: get player side splits: %w", err)
	}
	defer rows.Close()
	var out []models.ProfileSideSplit
	for rows.Next() {
		var r models.ProfileSideSplit
		if err := rows.Scan(&r.Side, &r.Rounds, &r.Wins, &r.Kills, &r.Deaths, &r.ADR, &r.KASTPct); err != nil {
			return nil, fmt.Errorf("store: get player side splits: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get player side splits: %w", err)
	}
	return out, nil
}

// CountPlayerTradeOpportunities returns how many trade opportunities a
// player had across every match in the library — the denominator of the
// profile's Trade rate (profileservice.GetProfile). Nothing stores this
// count, so THIS query is the definition; it is pinned by
// TestCountPlayerTradeOpportunities.
//
// One opportunity = one ENEMY kill in a counted round (warmup/pregame
// excluded; both sides known from that round's freeze-end samples and
// different — the same gates analytics.Engagements applies) whose VICTIM
// is this player's teammate in that round, where BOTH:
//
//   - the player was ALIVE at the death tick: no death event for them in
//     that round at or before it — a dead player cannot answer; and
//   - the death was tradeable in principle: the kill event's
//     detail_json.nearDist (extract.nearTeammateDist — the nearest living
//     teammate of the victim to the killer at that tick; -1 when nobody
//     is measurable) falls within [0, analysis_config.trade_opp_distance].
//     This is the SAME proximity predicate store.GetCombatStats gates
//     "Trade opportunities missed" on, applied to every teammate death
//     rather than only the untraded ones (that metric is this set's
//     untraded subset).
//
// The proximity is measured to the NEAREST living teammate of the victim,
// not to this player specifically (per-player distances are not stored),
// so the gate is team-level: a teammate death counts for every player
// still alive on the victim's side, which can credit someone who was
// himself out of range — the same class of documented approximation as
// GetCombatStats' final-side friendly fire. The numerator (successful
// trades) is player_stats.trade_kills via the career rollup, recomputed
// by analytics.Compute, so both sides follow the configured trade window.
func (s *Store) CountPlayerTradeOpportunities(steamID string) (int, error) {
	cfg, err := s.GetConfig()
	if err != nil {
		return 0, err
	}
	sid := scrub(steamID)
	var n int
	err = s.db.QueryRow(
		`SELECT COUNT(*)
		 FROM events d
		 JOIN rounds rd ON rd.match_id = d.match_id AND rd.number = d.round
		 JOIN round_player_sides ks
		   ON ks.match_id = d.match_id AND ks.round = d.round AND ks.steam_id = d.attacker
		 JOIN round_player_sides vs
		   ON vs.match_id = d.match_id AND vs.round = d.round AND vs.steam_id = d.victim
		 WHERE d.kind = 'kill'
		   AND d.attacker <> '' AND d.attacker <> d.victim AND d.victim <> ?
		   AND rd.warmup = 0 AND rd.pregame = 0
		   AND ks.side IN ('ct','t') AND vs.side IN ('ct','t') AND ks.side <> vs.side
		   AND EXISTS (SELECT 1 FROM round_player_sides ps
		               WHERE ps.match_id = d.match_id AND ps.round = d.round
		                 AND ps.steam_id = ? AND ps.side = vs.side)
		   AND NOT EXISTS (SELECT 1 FROM events pd
		                   WHERE pd.match_id = d.match_id AND pd.round = d.round
		                     AND pd.kind = 'kill' AND pd.victim = ? AND pd.tick <= d.tick)
		   AND CASE WHEN json_valid(d.detail_json)
		            THEN json_extract(d.detail_json, '$.nearDist') END
		       BETWEEN 0 AND ?`,
		sid, sid, sid, cfg.TradeOppDistance,
	).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("store: count player trade opportunities: %w", err)
	}
	return n, nil
}

// GetPlayerMatchAverages returns per-match means over the player's
// player_stats rows (one row per match played): enemies flashed and
// utility damage. AVG over rows IS the per-match average here — no
// player_career column exists for them and the baseline schema has no
// migration path (a new career column would break an existing database),
// so the mean is taken at read time instead of at rollup time.
func (s *Store) GetPlayerMatchAverages(steamID string) (models.ProfileAverages, error) {
	var a models.ProfileAverages
	err := s.db.QueryRow(
		`SELECT COALESCE(AVG(enemies_flashed), 0), COALESCE(AVG(utility_damage), 0)
		 FROM player_stats WHERE steam_id = ?`, scrub(steamID),
	).Scan(&a.EnemiesFlashed, &a.UtilDamage)
	if err != nil {
		return models.ProfileAverages{}, fmt.Errorf("store: get player match averages: %w", err)
	}
	return a, nil
}
