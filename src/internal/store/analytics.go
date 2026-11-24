package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// This file is the M3 persistence surface: analysis_config, the per-match
// derived-row replace/getters (round_classifications, player_round_stats,
// clutches, kill tags, utility_events), the economy view with loss-bonus
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
//
// RuleVersion is bumped only when an analysis RULE's output changes
// (a threshold save bumps it too, through SetConfig): 1 → 2 on
// 2026-11-18 for the owner's 2026-11-17 enemy-damage ruling —
// player_round_stats.dmg/util_dmg (analytics.rounds.go) and the
// utility burn-window sum (analytics.utility.go) now fold same-side
// damage out, so stored rows computed under v1 are behind → the
// behind facet lists them → RecomputeAll rewrites them. Existing
// databases: GetConfig's seed is insert-on-miss, so a pre-existing
// analysis_config row keeps its stored version — the owner's pending
// wipe + re-import covers those libraries (a fresh database seeds
// v2 at first GetConfig); no ensure/ALTER path exists (AGENTS
// "Version nothing until the first release").
var DefaultConfig = models.AnalysisConfig{
	TradeWindowS:     5.0,
	EcoFullBuy:       20000,
	EcoForce:         10000,
	TradeOppDistance: 1000,
	RuleVersion:      2,
}

// Per-table column lists (G1): each const is the row WITHOUT the
// match_id key column — the Replace* INSERT prefixes `match_id, `, the
// getter selects the list verbatim. Order is the scan/insert order.
// savedFilterCols has no match_id (saved_filters is library-scoped): the
// INSERT names it verbatim, the getters prefix `id, `.
const (
	analysisConfigCols = `trade_window_s, eco_full_buy, eco_force, trade_opp_distance, rule_version`

	roundClassCols = `round, label, confidence, rule_version, explanation`

	roundSideClassCols = `round, side, class, why, team`

	playerRoundCols = `round, steam_id, name, traded, kast, money_start, equip, spent, rule_version, side`

	killTagCols = `seq, tick, round, kind, a_steam, a_name, b_steam, b_name, distance, won_by`

	utilityCols = `seq, tick, throw_tick, round, thrower, thrower_name, kind, throw_x, throw_y, det_x, det_y,
		damage, flash_ms, affected, site, trajectory_ref`

	playerCareerCols = `steam_id, name, matches, wins, updated_at`

	matchTradeOppsCols = `steam_id, opps, missed`

	savedFilterCols = `name, scope, filter_json, created_at`
)

// GetConfig returns the analysis_config row, seeding the defaults on first
// use (single-row table: id = 1). The seed is an UPSERT MISS: concurrent
// first reads — N import jobs reaching the analyze stage together, or one
// racing the frontend's GetConfig binding — can all miss the SELECT, so
// the INSERT must lose gracefully (ON CONFLICT DO NOTHING) and every
// caller re-reads the row that actually landed; a check-then-insert here
// would fail all but the first reader with a raw UNIQUE constraint error.
func (s *Store) GetConfig() (models.AnalysisConfig, error) {
	var c models.AnalysisConfig
	err := s.db.QueryRow(
		`SELECT `+analysisConfigCols+` FROM analysis_config WHERE id = 1`,
	).Scan(&c.TradeWindowS, &c.EcoFullBuy, &c.EcoForce, &c.TradeOppDistance, &c.RuleVersion)
	if errors.Is(err, sql.ErrNoRows) {
		if _, err := s.db.Exec(
			`INSERT INTO analysis_config (id, `+analysisConfigCols+`)
			 VALUES (1, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO NOTHING`,
			DefaultConfig.TradeWindowS, DefaultConfig.EcoFullBuy, DefaultConfig.EcoForce,
			DefaultConfig.TradeOppDistance, DefaultConfig.RuleVersion,
		); err != nil {
			return models.AnalysisConfig{}, fmt.Errorf("couldn't load the analysis rules: %w", err)
		}
		// Re-read whatever row is there now: mine (defaults), or a
		// concurrent seeder's / SetConfig's that won the race.
		if err := s.db.QueryRow(
			`SELECT `+analysisConfigCols+` FROM analysis_config WHERE id = 1`,
		).Scan(&c.TradeWindowS, &c.EcoFullBuy, &c.EcoForce, &c.TradeOppDistance, &c.RuleVersion); err != nil {
			return models.AnalysisConfig{}, fmt.Errorf("couldn't load the analysis rules: %w", err)
		}
		return c, nil
	}
	if err != nil {
		return models.AnalysisConfig{}, fmt.Errorf("couldn't load the analysis rules: %w", err)
	}
	return c, nil
}

// SetConfig upserts the analysis_config row and returns the stored value.
//
// A rule-value edit is a direct recalculation of the affected metrics (ruling
// 26, no stub metrics): in the same transaction, every metric whose touched
// set holds the edited rule's analysis table is bumped, with its dependents
// through metric_deps. Metric values computed under the previous rule
// generation are then restamped to the new one, so the metrics no edit reached
// stay fresh (the rule axis would otherwise move every analysis metric).
func (s *Store) SetConfig(c models.AnalysisConfig) (models.AnalysisConfig, error) {
	old, err := s.GetConfig()
	if err != nil {
		return models.AnalysisConfig{}, err
	}
	tables := affectedRuleTables(old, c)
	tx, err := s.db.Begin()
	if err != nil {
		return models.AnalysisConfig{}, fmt.Errorf("couldn't save the analysis rules: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(
		`INSERT INTO analysis_config (id, `+analysisConfigCols+`)
		 VALUES (1, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET trade_window_s = excluded.trade_window_s,
			eco_full_buy = excluded.eco_full_buy, eco_force = excluded.eco_force,
			trade_opp_distance = excluded.trade_opp_distance,
			rule_version = excluded.rule_version`,
		c.TradeWindowS, c.EcoFullBuy, c.EcoForce, c.TradeOppDistance, c.RuleVersion,
	); err != nil {
		return models.AnalysisConfig{}, fmt.Errorf("couldn't save the analysis rules: %w", err)
	}
	if len(tables) > 0 {
		if err := bumpRuleAffectedMetrics(tx, tables); err != nil {
			return models.AnalysisConfig{}, err
		}
		if c.RuleVersion != old.RuleVersion {
			if _, err := tx.Exec(`UPDATE metric_values SET rule_version = ? WHERE rule_version = ?`,
				c.RuleVersion, old.RuleVersion); err != nil {
				return models.AnalysisConfig{}, fmt.Errorf("couldn't save the analysis rules: %w", err)
			}
			if _, err := tx.Exec(`UPDATE metric_runs SET rule_version = ? WHERE rule_version = ?`,
				c.RuleVersion, old.RuleVersion); err != nil {
				return models.AnalysisConfig{}, fmt.Errorf("couldn't save the analysis rules: %w", err)
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return models.AnalysisConfig{}, fmt.Errorf("couldn't save the analysis rules: %w", err)
	}
	return s.GetConfig()
}

// SetMatchRuleVersion stamps matches.analyzed_rule_version — the
// rule_version the match's derived rows were computed under. It is the
// ONE writer of the column and is called only at the END of a successful
// analytics.Compute (a failed pass keeps the previous stamp — 0 = never —
// so the match stays behind and retryable). SaveExtracted never touches
// the column (matchOwnedElsewhere), so a reprocess keeps its old stamp
// until its analyze stage re-stamps it. Unknown ids yield ErrNotFound.
func (s *Store) SetMatchRuleVersion(matchID int64, ruleVersion int) error {
	res, err := s.db.Exec(
		`UPDATE matches SET analyzed_rule_version = ? WHERE id = ?`, ruleVersion, matchID,
	)
	if err != nil {
		return fmt.Errorf("couldn't save the analysis version: %w", err)
	}
	return affectedOrNotFound(res, "recording the analysis version")
}

// GetMatchRuleVersion returns the match's rule stamp: the rule_version
// its derived rows were last computed under, 0 when it was never
// analyzed (0 is never a real version — analysis_config starts at 1).
// Unknown ids yield ErrNotFound.
func (s *Store) GetMatchRuleVersion(matchID int64) (int, error) {
	var v int
	err := s.db.QueryRow(
		`SELECT analyzed_rule_version FROM matches WHERE id = ?`, matchID,
	).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, fmt.Errorf("couldn't load the analysis version: %w", err)
	}
	return v, nil
}

// ReplaceRoundClassifications swaps a match's round_classifications rows in
// one transaction (delete-then-insert).
func (s *Store) ReplaceRoundClassifications(matchID int64, rows []models.RoundClassification) error {
	const op = "couldn't save the round classifications"
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
	const op = "couldn't save the per-round player stats"
	return s.replaceMatchRows(op, "player_round_stats", "match_id, "+playerRoundCols, matchID, len(rows),
		func(stmt *sql.Stmt, i int) error {
			r := rows[i]
			if _, err := stmt.Exec(
				matchID, r.Round, scrub(r.SteamID), scrub(r.Name),
				b2i(r.Traded), b2i(r.KAST),
				r.MoneyStart, r.Equip, r.Spent, r.RuleVersion, scrub(r.Side),
			); err != nil {
				return fmt.Errorf("%s: %w", op, err)
			}
			return nil
		})
}

// ReplaceKillTags swaps a match's kill tags rows in one transaction
// (seq is rewritten 0..n-1 in slice order so the PK stays dense).
func (s *Store) ReplaceKillTags(matchID int64, rows []models.KillTag) error {
	const op = "couldn't save the kill tags"
	return s.replaceMatchRows(op, "kill_tags", "match_id, "+killTagCols, matchID, len(rows),
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
	const op = "couldn't save the utility events"
	return s.replaceMatchRows(op, "utility_events", "match_id, "+utilityCols, matchID, len(rows),
		func(stmt *sql.Stmt, i int) error {
			r := rows[i]
			if _, err := stmt.Exec(
				matchID, i, r.Tick, r.ThrowTick, r.Round, scrub(r.Thrower), scrub(r.ThrowerName), scrub(r.Kind),
				nvl(r.ThrowX), nvl(r.ThrowY), nvl(r.DetX), nvl(r.DetY), r.Damage, r.FlashMs,
				scrub(r.Affected), scrub(r.Site), scrub(r.TrajectoryRef),
			); err != nil {
				return fmt.Errorf("%s: %w", op, err)
			}
			return nil
		})
}

// ReplaceTradeKills rewrites one match's player_stats.trade_kills from the
// cfg-aware analytics pass — the ONE trade-window rule (analytics.
// Kill tags KindTrade rows counted per killer). Every player row resets
// to 0 first so a recompute under a smaller window leaves no stale counts;
// steam IDs without a player_stats row are ignored. The extractor's
// import-time value (hardcoded 5 s) is the seed this overwrites on every
// Compute, which is what makes the column — and every consumer of it
// (scoreboard Trade, career trades, profile trade rate, the trade_rate
// and trade_rate_deaths builtin metrics) — follow
// analysis_config.TradeWindowS.
func (s *Store) ReplaceTradeKills(matchID int64, counts map[string]int) error {
	const op = "couldn't save the trade kills"
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
	if err := markTableWriteBehind(tx, matchID, "player_stats"); err != nil {
		return fmt.Errorf("%s: %w", op, err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("%s: %w", op, err)
	}
	return nil
}

// ReplaceTradeOpps swaps a match's match_trade_opps rows in one
// transaction (canonical replaceMatchRows — delete-then-insert, so a
// recompute under a smaller distance leaves no stale count). Rows are
// SPARSE: a steam ID whose two counts are both ≤ 0 writes no row (reads
// treat absence as 0 — the same rule as a missing player_stats row), and
// a match with nothing to count ends up with no rows at all.
//
// CONTRACT: the counts arrive pre-derived from analytics.Compute — the
// ONE writer, which applies cfg.TradeOppDistance at analyze time (see
// AGENTS.md "Analysis-rule derived values": every rules-derived value
// is stored at analyze time; read-time thresholding is forbidden). This
// writer applies no rule of its own. Like the neighboring Replace*
// functions, each table's transaction commits INDEPENDENTLY: a failed
// pass may have already committed this table, or failed here while
// earlier replaces committed — no cross-table rollback is attempted;
// the pass never stamps (compute.go's RULE STAMP note), so the match
// stays behind and the next run rewrites every table.
func (s *Store) ReplaceTradeOpps(matchID int64, opps, missed map[string]int) error {
	const op = "couldn't save the trade opportunities"
	set := map[string]bool{}
	for sid, n := range opps {
		if n > 0 {
			set[sid] = true
		}
	}
	for sid, n := range missed {
		if n > 0 {
			set[sid] = true
		}
	}
	keys := make([]string, 0, len(set))
	for sid := range set {
		keys = append(keys, sid)
	}
	sort.Strings(keys) // deterministic insert order (row errors name no index, but reproducibility is free)
	return s.replaceMatchRows(op, "match_trade_opps", "match_id, "+matchTradeOppsCols, matchID, len(keys),
		func(stmt *sql.Stmt, i int) error {
			sid := keys[i]
			if _, err := stmt.Exec(matchID, scrub(sid), opps[sid], missed[sid]); err != nil {
				return fmt.Errorf("%s: %w", op, err)
			}
			return nil
		})
}

// ReplaceRoundSideClasses swaps a match's round_side_classes rows in one
// transaction (canonical replaceMatchRows — delete-then-insert, so a
// recompute under new thresholds leaves no stale class behind). Rows are
// the per-(round, side) eco classes; a match with no counted rounds
// ends up with no rows at all.
//
// CONTRACT: the classes arrive pre-derived from analytics.Compute — the
// ONE writer, which applies cfg.EcoFullBuy / cfg.EcoForce at analyze
// time (see AGENTS.md "Analysis-rule derived values": every rules-derived
// value is stored at analyze time; read-time thresholding is forbidden).
// This writer applies no rule of its own. Like the neighboring Replace*
// functions, each table's transaction commits INDEPENDENTLY: a failed
// pass may have already committed this table, or failed here while
// earlier replaces committed — no cross-table rollback is attempted; the
// pass never stamps (compute.go's RULE STAMP note), so the match stays
// behind and the next run rewrites every table.
func (s *Store) ReplaceRoundSideClasses(matchID int64, rows []models.RoundSideClass) error {
	const op = "couldn't save the round eco classes"
	return s.replaceMatchRows(op, "round_side_classes", "match_id, "+roundSideClassCols, matchID, len(rows),
		func(stmt *sql.Stmt, i int) error {
			r := rows[i]
			if _, err := stmt.Exec(matchID, r.Round, scrub(r.Side), scrub(r.Class), scrub(r.Why), scrub(r.Team)); err != nil {
				return fmt.Errorf("%s: %w", op, err)
			}
			return nil
		})
}

// GetRoundClasses returns a match's stored classifications by round ASC.
func (s *Store) GetRoundClasses(matchID int64) ([]models.RoundClassification, error) {
	rows, err := s.db.Query(
		`SELECT `+roundClassCols+`
		 FROM round_classifications WHERE match_id = ? ORDER BY round ASC`, matchID,
	)
	if err != nil {
		return nil, fmt.Errorf("couldn't load the round classes: %w", err)
	}
	defer rows.Close()
	var out []models.RoundClassification
	for rows.Next() {
		var r models.RoundClassification
		r.MatchID = matchID
		if err := rows.Scan(&r.Round, &r.Label, &r.Confidence, &r.RuleVersion, &r.Explanation); err != nil {
			return nil, fmt.Errorf("couldn't load the round classes: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load the round classes: %w", err)
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
		return nil, fmt.Errorf("couldn't load the player rounds: %w", err)
	}
	defer rows.Close()
	var out []models.PlayerRoundStat
	for rows.Next() {
		var r models.PlayerRoundStat
		r.MatchID = matchID
		if err := rows.Scan(
			&r.Round, &r.SteamID, &r.Name,
			&r.Traded, &r.KAST,
			&r.MoneyStart, &r.Equip, &r.Spent, &r.RuleVersion, &r.Side,
		); err != nil {
			return nil, fmt.Errorf("couldn't load the player rounds: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load the player rounds: %w", err)
	}
	folds, err := s.roundFolds(matchID, scrub(steamID))
	if err != nil {
		return nil, err
	}
	for i := range out {
		f := folds[roundSteam{out[i].Round, out[i].SteamID}]
		out[i].Kills, out[i].Assists, out[i].Deaths = f.Kills, f.Assists, f.Deaths
		out[i].DMG, out[i].UtilDmg, out[i].Survived = f.DMG, f.UtilDmg, f.Survived
	}
	return out, nil
}

// GetKillTags returns a match's kill tags (kind "" = all kinds),
// ordered by seq.
func (s *Store) GetKillTags(matchID int64, kind string) ([]models.KillTag, error) {
	q := `SELECT ` + killTagCols + `
		FROM kill_tags WHERE match_id = ?`
	args := []any{matchID}
	if k := scrub(kind); k != "" {
		q += ` AND kind = ?`
		args = append(args, k)
	}
	q += ` ORDER BY seq ASC`
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("couldn't load the kill tags: %w", err)
	}
	defer rows.Close()
	var out []models.KillTag
	for rows.Next() {
		var r models.KillTag
		r.MatchID = matchID
		if err := rows.Scan(&r.Seq, &r.Tick, &r.Round, &r.Kind, &r.ASteam, &r.AName, &r.BSteam, &r.BName, &r.Distance, &r.WonBy); err != nil {
			return nil, fmt.Errorf("couldn't load the kill tags: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load the kill tags: %w", err)
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
		return nil, fmt.Errorf("couldn't load the utility: %w", err)
	}
	defer rows.Close()
	var out []models.UtilityEvent
	for rows.Next() {
		var r models.UtilityEvent
		r.MatchID = matchID
		var throwX, throwY, detX, detY sql.NullFloat64
		if err := rows.Scan(
			&r.Seq, &r.Tick, &r.ThrowTick, &r.Round, &r.Thrower, &r.ThrowerName, &r.Kind,
			&throwX, &throwY, &detX, &detY,
			&r.Damage, &r.FlashMs, &r.Affected, &r.Site, &r.TrajectoryRef,
		); err != nil {
			return nil, fmt.Errorf("couldn't load the utility: %w", err)
		}
		r.ThrowX, r.ThrowY = nullFloat(throwX), nullFloat(throwY)
		r.DetX, r.DetY = nullFloat(detX), nullFloat(detY)
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load the utility: %w", err)
	}
	return out, nil
}

// GetEconomy returns the per-round economy view: rounds ⋈ round_economy ⋈
// round_classifications ⋈ round_side_classes with loss-bonus
// reconstruction applied. Every stored round is counted play — the
// extractor discards knife/warmup rounds at ingest (extract.agg.roundStart),
// so the counted-rounds predicate that used to sit in this query's WHERE
// (`warmup = 0 AND pregame = 0`) is dead and went away with the columns
// (the Go twin is analytics.CountedRounds, now a documented identity).
//
// READ CONTRACT (AGENTS.md "Analysis-rule derived values"): the per-side
// ClassCT/ClassT/ClassWhy* fields are the STORED round_side_classes rows,
// fetched verbatim — a match with no stored rows (never analyzed, or
// analyzed before this table existed) reads ""/"" for both sides, which
// the UI renders as its honest "unknown" chip; this function never
// re-classifies (the retired read-time fill lived in analytics.EconomyRows
// and survives only as the reference oracle in internal/analytics' eco
// equivalence test). PistolRound derives from the STORED round label
// (round_classifications.label = "pistol") — the same label the round
// chips render, so the two can never disagree; it is a stored fact, not a
// rule re-derivation. Loss bonus is INFERRED (reconstructed
// from round winners under the CS2 loss-count rules — see
// applyLossBonuses); InferredCT/ InferredT are set accordingly. SpentCT/
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
		`SELECT r.number, r.winner, r.equip_ct, r.equip_t,
			COALESCE(ct.money_sampled_sum, 0), COALESCE(t.money_sampled_sum, 0),
			COALESCE(ct.spent, 0), COALESCE(t.spent, 0),
			COALESCE(ct.free_pistol_value, 0), COALESCE(t.free_pistol_value, 0),
			COALESCE(rc.label, ''), COALESCE(rc.explanation, ''),
			COALESCE(rc.rule_version, 0),
			COALESCE(rsct.class, ''), COALESCE(rsct.why, ''),
			COALESCE(rst.class, ''), COALESCE(rst.why, '')
		 FROM rounds r
		 LEFT JOIN round_economy ct ON ct.match_id = r.match_id AND ct.round = r.number AND ct.side = 'ct'
		 LEFT JOIN round_economy t ON t.match_id = r.match_id AND t.round = r.number AND t.side = 't'
		 LEFT JOIN round_classifications rc ON rc.match_id = r.match_id AND rc.round = r.number
		 LEFT JOIN round_side_classes rsct ON rsct.match_id = r.match_id AND rsct.round = r.number AND rsct.side = 'ct'
		 LEFT JOIN round_side_classes rst ON rst.match_id = r.match_id AND rst.round = r.number AND rst.side = 't'
		 WHERE r.match_id = ?
		 ORDER BY r.number ASC`, matchID,
	)
	if err != nil {
		return nil, fmt.Errorf("couldn't load the economy: %w", err)
	}
	defer rows.Close()
	var out []models.EconomyRow
	for rows.Next() {
		var r models.EconomyRow
		if err := rows.Scan(&r.Round, &r.Winner, &r.EquipCT, &r.EquipT,
			&r.MoneyCT, &r.MoneyT, &r.SpentCT, &r.SpentT, &r.FreePistolCT, &r.FreePistolT,
			&r.Label, &r.Explanation, &r.RuleVersion,
			&r.ClassCT, &r.ClassWhyCT, &r.ClassT, &r.ClassWhyT); err != nil {
			return nil, fmt.Errorf("couldn't load the economy: %w", err)
		}
		r.PistolRound = r.Label == "pistol"
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load the economy: %w", err)
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

// GetPlayerRefs returns one match's participants (identity + final side +
// the bot flag). Deliberately UNFILTERED: the analytics pass needs every
// participant's rows and the replay roster needs bots WITH IsBot — the
// exclusion rule applies to roster/aggregate listings (humanOnly in
// queries.go), never to this identity read.
func (s *Store) GetPlayerRefs(matchID int64) ([]models.PlayerRef, error) {
	rows, err := s.db.Query(
		`SELECT steam_id, name, side, is_bot FROM players WHERE match_id = ? ORDER BY name ASC`, matchID,
	)
	if err != nil {
		return nil, fmt.Errorf("couldn't load the players: %w", err)
	}
	defer rows.Close()
	var out []models.PlayerRef
	for rows.Next() {
		var r models.PlayerRef
		if err := rows.Scan(&r.SteamID, &r.Name, &r.Side, &r.IsBot); err != nil {
			return nil, fmt.Errorf("couldn't load the players: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load the players: %w", err)
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
		return nil, fmt.Errorf("couldn't load the economy: %w", err)
	}
	defer rows.Close()
	var out []models.RoundEconomyView
	for rows.Next() {
		var r models.RoundEconomyView
		if err := rows.Scan(&r.Round, &r.Side, &r.EquipValue, &r.MoneySampledSum, &r.MoneySamples); err != nil {
			return nil, fmt.Errorf("couldn't load the economy: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load the economy: %w", err)
	}
	return out, nil
}

// GetRoundInfos returns one match's rounds as analytics RoundInfos.
// Every stored round is counted play (knife/warmup rounds are discarded
// at ingest), so callers no longer filter — the read is the whole set in
// number order.
func (s *Store) GetRoundInfos(matchID int64) ([]models.RoundInfo, error) {
	rows, err := s.db.Query(
		`SELECT number, winner, start_tick, end_tick, freeze_end_tick, equip_ct, equip_t
		 FROM rounds WHERE match_id = ? ORDER BY number ASC`, matchID,
	)
	if err != nil {
		return nil, fmt.Errorf("couldn't load the rounds: %w", err)
	}
	defer rows.Close()
	var out []models.RoundInfo
	for rows.Next() {
		var r models.RoundInfo
		if err := rows.Scan(&r.Number, &r.Winner, &r.StartTick, &r.EndTick, &r.FreezeEndTick, &r.EquipCT, &r.EquipT); err != nil {
			return nil, fmt.Errorf("couldn't load the rounds: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load the rounds: %w", err)
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
		return nil, fmt.Errorf("couldn't load the round sides: %w", err)
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
			return nil, fmt.Errorf("couldn't load the round sides: %w", err)
		}
		m := out[round]
		if m == nil {
			m = map[string]string{}
			out[round] = m
		}
		m[sid] = side
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load the round sides: %w", err)
	}
	return out, nil
}

// GetRoundPlayerMoney returns the extractor's round-end per-player
// economy samples as round → steamID → row (round ASC). Empty map when
// the match has no stored samples — callers treat a missing sample as
// absence (player_round_stats' money columns keep their zero default,
// the same absence-as-zero convention as kills for rounds not played).
func (s *Store) GetRoundPlayerMoney(matchID int64) (map[int]map[string]models.RoundPlayerMoney, error) {
	rows, err := s.db.Query(
		`SELECT round, steam_id, money_start, equip, spent FROM round_player_money
		 WHERE match_id = ? ORDER BY round ASC, steam_id ASC`, matchID,
	)
	if err != nil {
		return nil, fmt.Errorf("couldn't load the round money: %w", err)
	}
	defer rows.Close()
	out := map[int]map[string]models.RoundPlayerMoney{}
	for rows.Next() {
		var (
			round int
			sid   string
			rm    models.RoundPlayerMoney
		)
		if err := rows.Scan(&round, &sid, &rm.MoneyStart, &rm.Equip, &rm.Spent); err != nil {
			return nil, fmt.Errorf("couldn't load the round money: %w", err)
		}
		m := out[round]
		if m == nil {
			m = map[string]models.RoundPlayerMoney{}
			out[round] = m
		}
		rm.Round = round
		rm.SteamID = sid
		m[sid] = rm
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load the round money: %w", err)
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
		return nil, fmt.Errorf("couldn't load the saved filters: %w", err)
	}
	defer rows.Close()
	var out []models.SavedFilterRow
	for rows.Next() {
		var r models.SavedFilterRow
		if err := rows.Scan(&r.ID, &r.Name, &r.Scope, &r.FilterJSON, &r.CreatedAt); err != nil {
			return nil, fmt.Errorf("couldn't load the saved filters: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load the saved filters: %w", err)
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
			return models.SavedFilterRow{}, fmt.Errorf("a filter named %q already exists in this scope", scrub(name))
		}
		return models.SavedFilterRow{}, fmt.Errorf("couldn't save the filter: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return models.SavedFilterRow{}, fmt.Errorf("couldn't save the filter: %w", err)
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
		return fmt.Errorf("couldn't delete the saved filter: %w", err)
	}
	return affectedOrNotFound(res, "deleting the saved filter")
}

// ---- career rollup ----

// RebuildCareer recomputes the whole player_career table — raw counts
// only: identity, name, match and win counts, all from player_stats ⋈
// matches. Full rebuild in one transaction — at the practice scale (100
// matches) this is well under the 5 s budget and is the only writer of
// the table, so it cannot drift. Every DERIVED career number (ADR, K/D,
// HS%, KAST%, openings, trades, clutches) is a stored metric row, never
// a column here: clearing the career metric bucket below (the same
// transaction) is what makes the sweep re-derive them from the rows this
// rebuild just refreshed.
//
// HUMANS ONLY (HumanOnly): the rollup also joins players, so a rebuild
// purges bot rows — including rows a pre-rule rebuild already wrote into
// an existing table (ListPlayers hides them in the meantime; see
// TestCareerRebuildDropsBotRowsFromExistingData). Every player_stats row
// has a players row — extract builds both from the same accumulator map
// (extract/build.go) — so the inner join drops nothing else.
//
// Layer notes — per-match rows (player_stats) vs the cross-match rollup,
// justified and deliberate, not duplication:
//
//   - wins: the SUM(CASE WHEN …) below is the SQL twin of models.WinFor
//     (the Go helper GetPlayerHistory uses for its per-match Win flag).
//   - name: the correlated subquery takes the player's LATEST name
//     (latest match by extracted_at, then id), so a rename lands on the
//     newest import — the name ListPlayers shows for the same id.
func (s *Store) RebuildCareer() error {
	return s.rebuildCareer(nil, true)
}

// RebuildCareerFor rebuilds the career rollup for a change that touched only
// the given players (their matches were analyzed or deleted). The career
// values of every other player stay fresh; a player whose career row
// disappears in the rebuild is invalidated too. Within those players, only the
// career values of metrics whose touched set holds a match-data table are
// cleared (invalidateCareerValues).
func (s *Store) RebuildCareerFor(steamIDs []string) error {
	return s.rebuildCareer(steamIDs, false)
}

// rebuildCareer regenerates player_career. whole clears every career-grain
// metric value (the rollup's full input changed); otherwise only the changed
// players' values are cleared (invalidateCareerValues). Both in one
// transaction with the rollup, so no crash leaves fresh-looking values built
// on the pre-rebuild rollup.
func (s *Store) rebuildCareer(steamIDs []string, whole bool) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("couldn't rebuild the career: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	oldIDs, err := careerSteamIDs(tx)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM player_career`); err != nil {
		return fmt.Errorf("couldn't rebuild the career: %w", err)
	}
	// Source-data axis for the stored metrics (design §4): the career
	// rollup regenerating means every PROFILE-grain metric value (the
	// match_id = 0 career bucket, all metrics) was computed over inputs
	// that just changed — clear them in the SAME transaction, so a crash
	// can never leave fresh-looking career values built from pre-rebuild
	// data. The sweep (which runs right after analyze) re-derives them:
	// absent → behind. This is input regeneration, NOT the version axis —
	// no metric's version moves here, and per-match metric rows are
	// untouched (their inputs are this match's rows, cleared through
	// childTables on reprocess instead).
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
			?
		FROM player_stats ps
		JOIN matches m ON m.id = ps.match_id
		JOIN players p ON p.match_id = ps.match_id AND p.steam_id = ps.steam_id
			AND `+HumanOnly("p")+`
		GROUP BY ps.steam_id`,
		time.Now(),
	)
	if err != nil {
		return fmt.Errorf("couldn't rebuild the career: %w", err)
	}
	// Source-data axis for the stored metrics (design §4): the career values
	// of the changed players were computed over inputs that just changed.
	// They are cleared in the SAME transaction, so a crash can never leave
	// fresh-looking career values built from pre-rebuild data. The sweep
	// re-derives them: absent → behind. No metric version moves here.
	scope := steamIDs
	if whole {
		scope = nil
	} else {
		newIDs, err := careerSteamIDs(tx)
		if err != nil {
			return err
		}
		have := map[string]bool{}
		for _, id := range newIDs {
			have[id] = true
		}
		for _, id := range oldIDs {
			if !have[id] {
				scope = append(scope, id) // its career row is gone
			}
		}
	}
	if err := invalidateCareerValues(tx, scope, whole); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("couldn't rebuild the career: %w", err)
	}
	return nil
}

// careerSteamIDs lists the players that have a career row.
func careerSteamIDs(tx *sql.Tx) ([]string, error) {
	rows, err := tx.Query(`SELECT steam_id FROM player_career`)
	if err != nil {
		return nil, fmt.Errorf("couldn't rebuild the career: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("couldn't rebuild the career: %w", err)
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// invalidateCareerValues clears the career-grain (match_id = 0) values and run
// records a rollup change reaches. whole clears every such value. Otherwise
// only metrics whose touched set holds a match-data table (matchDataTables: the
// tables a match write or delete changes) are reached. A metric bound to
// steam_id loses only the rows and runs of the changed players (its units are
// per player, so the others stay fresh), and any other career metric (a
// library-wide raw metric, a profile sugar metric) loses its whole career
// bucket. A metric that reads none of those tables (a matches-only metric)
// stays fresh. A metric with an unknown touched set (”) is reached
// conservatively.
func invalidateCareerValues(tx *sql.Tx, steamIDs []string, whole bool) error {
	if whole {
		if _, err := tx.Exec(`DELETE FROM metric_values WHERE match_id = 0`); err != nil {
			return fmt.Errorf("couldn't rebuild the career: %w", err)
		}
		if _, err := tx.Exec(`DELETE FROM metric_runs WHERE match_id = 0`); err != nil {
			return fmt.Errorf("couldn't rebuild the career: %w", err)
		}
		return nil
	}
	rows, err := tx.Query(`SELECT id, expr, touched FROM metrics WHERE id IN (
		SELECT metric_id FROM metric_values WHERE match_id = 0
		UNION SELECT metric_id FROM metric_runs WHERE match_id = 0)`)
	if err != nil {
		return fmt.Errorf("couldn't rebuild the career: %w", err)
	}
	type career struct {
		id      int64
		expr    string
		touched string
	}
	var list []career
	for rows.Next() {
		var c career
		if err := rows.Scan(&c.id, &c.expr, &c.touched); err != nil {
			rows.Close()
			return fmt.Errorf("couldn't rebuild the career: %w", err)
		}
		list = append(list, c)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("couldn't rebuild the career: %w", err)
	}
	rows.Close()
	ph := make([]string, len(steamIDs))
	args := make([]any, len(steamIDs))
	for i, id := range steamIDs {
		ph[i] = "?"
		args[i] = scrub(id)
	}
	in := strings.Join(ph, ",")
	for _, c := range list {
		if c.touched != "" && !touchesAnyOf(c.touched, matchDataTables()) {
			continue // reads none of the changed tables: this metric's units stay fresh
		}
		if perPlayer(c.expr) {
			if len(steamIDs) == 0 {
				continue // no player's career changed: this metric's units stay fresh
			}
			ids := append([]any{c.id}, args...)
			if _, err := tx.Exec(`DELETE FROM metric_values WHERE metric_id = ? AND match_id = 0
				AND (subject_key IN (`+in+`) OR scope_steam_id IN (`+in+`))`, append(ids, args...)...); err != nil {
				return fmt.Errorf("couldn't rebuild the career: %w", err)
			}
			if _, err := tx.Exec(`DELETE FROM metric_runs WHERE metric_id = ? AND match_id = 0
				AND scope_steam_id IN (`+in+`)`, ids...); err != nil {
				return fmt.Errorf("couldn't rebuild the career: %w", err)
			}
			continue
		}
		if _, err := tx.Exec(`DELETE FROM metric_values WHERE metric_id = ? AND match_id = 0`, c.id); err != nil {
			return fmt.Errorf("couldn't rebuild the career: %w", err)
		}
		if _, err := tx.Exec(`DELETE FROM metric_runs WHERE metric_id = ? AND match_id = 0`, c.id); err != nil {
			return fmt.Errorf("couldn't rebuild the career: %w", err)
		}
	}
	return nil
}

// perPlayer reports whether a metric's career values are units of one player:
// a raw statement bound to :steam_id and no match or round (the raw bind shapes
// rawBehind accepts for a per-player unit).
func perPlayer(expr string) bool {
	st, gerr := AnalyzeMetricSQL(expr, nil)
	if gerr != nil {
		return false
	}
	steam := false
	for _, b := range st.Binds {
		switch b {
		case ":steam_id":
			steam = true
		case ":match_id", ":round":
			return false
		}
	}
	return steam
}

// GetCareer returns one player's career rollup (ErrNotFound when absent).
// A bot's id yields ErrNotFound (HumanOnlyBySteamID): the career rollup
// is an aggregate surface, so a bot never resolves to a profile.
func (s *Store) GetCareer(steamID string) (*models.CareerRow, error) {
	var (
		c       models.CareerRow
		updated time.Time
	)
	err := s.db.QueryRow(
		`SELECT `+playerCareerCols+`
		 FROM player_career pc WHERE pc.steam_id = ? AND `+HumanOnlyBySteamID("pc.steam_id"),
		scrub(steamID),
	).Scan(&c.SteamID, &c.Name, &c.Matches, &c.Wins, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("couldn't load the career: %w", err)
	}
	c.UpdatedAt = updated
	return &c, nil
}

// ListPlayers returns career summaries ("" = all), optionally filtered by a
// case-insensitive name/steam-id LIKE, ordered by most-recent match first.
// HUMANS ONLY (HumanOnlyBySteamID): a steam_id that is a bot in any match
// never lists — this is the Profiles list, CommandPalette's player search
// and Library's player facet, so a bot is unselectable even on a database
// whose player_career still carries pre-rule bot rows.
//
// This read selects raw counts only: the picker's ADR
// cell reads the stored `career_adr` metric rows through the frontend's
// canonical career read, and player_career carries no derived columns
// at all (RebuildCareer's dual-write removal).
func (s *Store) ListPlayers(query string) ([]models.CareerSummary, error) {
	// MAX(extracted_at) is formatted via strftime: the scalar subquery's
	// result loses the DATETIME declared type (the driver would hand back
	// TEXT, which does not convert to time.Time on Scan).
	q := `SELECT c.steam_id, c.name, c.matches,
		strftime('%Y-%m-%dT%H:%M:%fZ', (SELECT MAX(m.extracted_at) FROM player_stats ps
			JOIN matches m ON m.id = ps.match_id
			WHERE ps.steam_id = c.steam_id)),
		c.updated_at
		FROM player_career c
		WHERE ` + HumanOnlyBySteamID("c.steam_id")
	var args []any
	if qq := scrub(query); qq != "" {
		q += ` AND (c.name LIKE ? OR c.steam_id LIKE ?)`
		like := "%" + qq + "%"
		args = append(args, like, like)
	}
	q += ` ORDER BY 4 DESC, c.steam_id ASC`
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("couldn't load the players: %w", err)
	}
	defer rows.Close()
	var out []models.CareerSummary
	for rows.Next() {
		var (
			r       models.CareerSummary
			last    sql.NullString
			updated time.Time
		)
		if err := rows.Scan(&r.SteamID, &r.Name, &r.Matches, &last, &updated); err != nil {
			return nil, fmt.Errorf("couldn't load the players: %w", err)
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
		return nil, fmt.Errorf("couldn't load the players: %w", err)
	}
	return out, nil
}

// GetTrend returns a per-match metric series for one player, ordered by
// CS2 patch number — the authoritative "when this match was played" (a
// demo carries no played-at date; see CS2.md's played-at entry) — with
// import time (m.extracted_at) as the tiebreaker inside a patch.
//
// metric IS the metric NAME: any match-scope definition resolves to its
// stored rows, user and plugin metrics included. Two honest edges — a
// name the catalog does not carry is still the unknown-metric ERROR (the
// API contract the service layer and the tests pin), and a PROFILE-scope
// name resolves but serves an EMPTY series, because the series read only
// ever returns match-grain rows (match_id > 0) — never a Go
// recomputation either way.
//
// The VALUES are the stored match-scope metric rows (design §3.5's
// gated D13 conversion — one series read, GetPlayerMetricSeries): a
// match with no FRESH row for the metric is SKIPPED, so an uncomputed or
// behind metric shows an honest gap in the sparkline (which already
// needs ≥2 points) instead of a number the store never produced — Q3's
// ruling, and §3.7's "never a fallback-to-Go".
//
// The row order IS the trend's x axis: known patches ascending first,
// unknowns (m.patch_version = 0 — the column default and the demo
// header's absent optional field, never "patch 0") TRAILING so an
// unpatched match never anchors the head of the line, then
// m.extracted_at ASC (import time — the within-patch tiebreaker) and
// m.id ASC as the final deterministic tiebreak. Ordering on the RAW
// flattened int (1.40.8.9 → 14089) is deliberate: CS2-era values are
// fixed-width (x = 1 digit, y = 2, z/w = 1), so int order equals
// (x,y,z,w) tuple order — the tuple caveat (a component growing past
// its fixed width, e.g. z/w rolling past 9, would flip raw order) is
// recorded in CS2.md instead of extra columns or a mapping table. Seq
// below is computed from that row order and the renderer is ordinal, so
// the ordering flows through as the x position.
//
// HUMANS ONLY (HumanOnlyBySteamID, applied inside the series read): this
// is the one profile read the frontend fires for a bare /player/<id>
// URL without going through GetProfile's GetCareer guard, so a bot id
// yields an empty series — no bot aggregate ever reaches the profile's
// trend card.
func (s *Store) GetTrend(steamID, metric string) ([]models.ProfileTrendPoint, error) {
	// seriesMetricFor resolves the NAME (it is the one name→definition
	// lookup behind the trend and history series reads); !found means the
	// catalog carries no such name — the unknown-metric error below, kept
	// byte for byte for the API contract the callers pin.
	m, found, err := s.seriesMetricFor(metric)
	if err != nil {
		return nil, fmt.Errorf("couldn't load the trend: %w", err)
	}
	if !found {
		return nil, fmt.Errorf("unknown trend metric %q", metric)
	}
	series, err := s.GetPlayerMetricSeries(steamID, []int64{m.id})
	if err != nil {
		return nil, fmt.Errorf("couldn't load the trend: %w", err)
	}
	var out []models.ProfileTrendPoint
	for _, p := range series {
		out = append(out, models.ProfileTrendPoint{
			MatchID:     p.MatchID,
			Seq:         len(out), // position in the series row order (oldest = 0)
			Value:       p.Value * m.scale,
			Patch:       p.Patch,
			ExtractedAt: p.ExtractedAt,
		})
	}
	return out, nil
}

// playerHistoryFrom is the match set every per-match profile fold reads:
// the player's extracted matches (one player_stats row each), most
// recent first, capped at 100 — the history table's window. Both
// GetPlayerHistory and GetPlayerMapADR build on it, so a Maps-card row's
// Matches cell and its ADR cell always describe the SAME matches (one
// spelling of the window, never two that can drift apart).
const playerHistoryFrom = `FROM player_stats ps
	 JOIN matches m ON m.id = ps.match_id
	 WHERE ps.steam_id = ? AND m.extracted_at IS NOT NULL
	 ORDER BY m.extracted_at DESC, m.id DESC
	 LIMIT 100`

// GetPlayerHistory returns one player's per-match history (most recent
// first, ≤100): every raw/inferred column the history table shows plus
// StartSide — the freeze-end
// side sample of the player's FIRST round (lowest number; every stored
// round is counted — knife/warmup rounds are discarded at ingest, so no
// counted-round predicate is needed here); a match with no stored sample
// yields "" rather than a guess). Side stays player_stats.side (final
// side) — the input models.WinFor uses below.
//
// The Assists, ADR and KAST% cells read the STORED match-scope metric
// rows (the `assists`/`adr`/`kast` seeds — design §3.5's gated D13
// conversion for ADR/KAST, the inferred-conversion W3a swap for the
// triple's A half, all through the same series read GetTrend uses),
// never the ps.adr / ps.assists / kastPerMatchSQL query-time arithmetic
// and raw select they replaced: a match with no FRESH row leaves that
// cell ABSENT (nil → the profile's honest "—"), never a fabricated 0
// and never a fallback-to-Go recomputation. The display scale follows
// the definition's format tag (see seriesMetric) so the cells keep the
// 0..100 percent they have always rendered; Kills and Deaths stay raw
// columns (Q2 — a value triple composes per half).
func (s *Store) GetPlayerHistory(steamID string) ([]models.ProfileHistoryRow, error) {
	rows, err := s.db.Query(
		`SELECT m.id, m.extracted_at, m.map, m.score_ct, m.score_t, ps.side,
			(SELECT rps.side FROM round_player_sides rps
			 JOIN rounds r ON r.match_id = rps.match_id AND r.number = rps.round
			 WHERE rps.match_id = ps.match_id AND rps.steam_id = ps.steam_id
			   AND rps.side IN ('ct','t')
			 ORDER BY r.number ASC LIMIT 1),
			0, 0
		 `+playerHistoryFrom, scrub(steamID),
	)
	if err != nil {
		return nil, fmt.Errorf("couldn't load the player history: %w", err)
	}
	defer rows.Close()
	var out []models.ProfileHistoryRow
	for rows.Next() {
		var r models.ProfileHistoryRow
		var extracted sql.NullTime
		var startSide sql.NullString
		if err := rows.Scan(
			&r.MatchID, &extracted, &r.Map, &r.ScoreCT, &r.ScoreT, &r.Side, &startSide,
			&r.Kills, &r.Deaths,
		); err != nil {
			return nil, fmt.Errorf("couldn't load the player history: %w", err)
		}
		r.ExtractedAt = nullTime(extracted)
		r.StartSide = startSide.String
		r.Win = models.WinFor(r.Side, r.ScoreCT, r.ScoreT)
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load the player history: %w", err)
	}
	if len(out) == 0 {
		return out, nil
	}

	// The metric-backed cells (K, D, A, ADR, KAST%), filled from ONE series
	// read (the history rows are keyed by match id, so the read's trend order
	// does not matter here). A metric definition absent from the catalog (or
	// a match with no fresh row) leaves that cell nil, or 0 for K and D.
	assists, assistsFound, err := s.seriesMetricFor("assists")
	if err != nil {
		return nil, fmt.Errorf("couldn't load the player history: %w", err)
	}
	adr, adrFound, err := s.seriesMetricFor("adr")
	if err != nil {
		return nil, fmt.Errorf("couldn't load the player history: %w", err)
	}
	kast, kastFound, err := s.seriesMetricFor("kast")
	if err != nil {
		return nil, fmt.Errorf("couldn't load the player history: %w", err)
	}
	kills, killsFound, err := s.seriesMetricFor("kills")
	if err != nil {
		return nil, fmt.Errorf("couldn't load the player history: %w", err)
	}
	deaths, deathsFound, err := s.seriesMetricFor("deaths")
	if err != nil {
		return nil, fmt.Errorf("couldn't load the player history: %w", err)
	}
	ids := make([]int64, 0, 5)
	if killsFound {
		ids = append(ids, kills.id)
	}
	if deathsFound {
		ids = append(ids, deaths.id)
	}
	if assistsFound {
		ids = append(ids, assists.id)
	}
	if adrFound {
		ids = append(ids, adr.id)
	}
	if kastFound {
		ids = append(ids, kast.id)
	}
	if len(ids) == 0 {
		return out, nil
	}
	series, err := s.GetPlayerMetricSeries(steamID, ids)
	if err != nil {
		return nil, fmt.Errorf("couldn't load the player history: %w", err)
	}
	byMatch := make(map[int64]map[int64]float64, len(series))
	for _, p := range series {
		m := byMatch[p.MatchID]
		if m == nil {
			m = make(map[int64]float64, 3)
			byMatch[p.MatchID] = m
		}
		m[p.MetricID] = p.Value
	}
	for i := range out {
		m := byMatch[out[i].MatchID]
		if m == nil {
			continue
		}
		if killsFound {
			if v, ok := m[kills.id]; ok {
				out[i].Kills = int(v)
			}
		}
		if deathsFound {
			if v, ok := m[deaths.id]; ok {
				out[i].Deaths = int(v)
			}
		}
		if assistsFound {
			if v, ok := m[assists.id]; ok {
				scaled := v * assists.scale
				out[i].Assists = &scaled
			}
		}
		if adrFound {
			if v, ok := m[adr.id]; ok {
				scaled := v * adr.scale
				out[i].ADR = &scaled
			}
		}
		if kastFound {
			if v, ok := m[kast.id]; ok {
				scaled := v * kast.scale
				out[i].KASTPct = &scaled
			}
		}
	}
	return out, nil
}

// GetPlayerMapADR rolls a player's stored damage up per map — the
// profile's Maps-card ADR cell (ProfileService.GetProfile folds it next
// to the Matches/Win counts). The value is the POOLED micro-average over
// that map's matches — SUM(player_stats.total_damage) ÷ the counted
// rounds of those matches (owner rule 2026-11-16: never the unweighted
// mean of the per-match ADR values, and never the rounds the player
// personally played) — computed over playerHistoryFrom, the SAME match
// set GetPlayerHistory returns, so a map row's Matches cell and its ADR
// cell always describe the same matches. A map whose matches carry no
// stored rounds divides by NULLIF's zero → SQL NULL → nil (the card's
// honest "—"), never a fabricated 0.
func (s *Store) GetPlayerMapADR(steamID string) ([]models.ProfileMapADR, error) {
	rows, err := s.db.Query(
		`SELECT m.id, m.map, (SELECT COUNT(*) FROM rounds r WHERE r.match_id = m.id)
			`+playerHistoryFrom, scrub(steamID),
	)
	if err != nil {
		return nil, fmt.Errorf("couldn't load the per-map ADR: %w", err)
	}
	defer rows.Close()
	type matchRow struct {
		id      int64
		mapName string
		rounds  int
	}
	var matches []matchRow
	for rows.Next() {
		var m matchRow
		if err := rows.Scan(&m.id, &m.mapName, &m.rounds); err != nil {
			return nil, fmt.Errorf("couldn't load the per-map ADR: %w", err)
		}
		matches = append(matches, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load the per-map ADR: %w", err)
	}
	// Per map: the pooled damage over the map's matches divided by their
	// counted rounds. A map with a match that has no fresh damage value, or
	// no rounds, has no ADR (nil) — never a fabricated 0.
	dmg, found, err := s.seriesMetricFor("total_damage")
	if err != nil {
		return nil, fmt.Errorf("couldn't load the per-map ADR: %w", err)
	}
	byMatch := map[int64]float64{}
	if found {
		series, err := s.GetPlayerMetricSeries(steamID, []int64{dmg.id})
		if err != nil {
			return nil, fmt.Errorf("couldn't load the per-map ADR: %w", err)
		}
		for _, p := range series {
			byMatch[p.MatchID] = p.Value
		}
	}
	type mapAgg struct {
		damage   float64
		rounds   int
		complete bool
	}
	aggs := map[string]*mapAgg{}
	for _, m := range matches {
		a := aggs[m.mapName]
		if a == nil {
			a = &mapAgg{complete: true}
			aggs[m.mapName] = a
		}
		v, ok := byMatch[m.id]
		if !found || !ok {
			a.complete = false
			continue
		}
		a.damage += v
		a.rounds += m.rounds
	}
	names := make([]string, 0, len(aggs))
	for name := range aggs {
		names = append(names, name)
	}
	sort.Strings(names)
	out := make([]models.ProfileMapADR, 0, len(names))
	for _, name := range names {
		r := models.ProfileMapADR{Map: name}
		if a := aggs[name]; a.complete && a.rounds > 0 {
			v := a.damage / float64(a.rounds)
			r.ADR = &v
		}
		out = append(out, r)
	}
	return out, nil
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
//   - a counted round (every stored round is counted — knife/warmup
//     rounds are discarded at ingest, so the rounds join only guarantees
//     the round row exists; extract's realPeriod used to gate those
//     rounds' kills the same way while their kill rows still landed in
//     events).
//
// The golden-demo acceptance test pins the sum of the folded per-weapon
// headshots to player_stats.headshots for every player.
func (s *Store) GetPlayerWeaponJSONs(steamID string) ([]models.ProfileWeaponJSONs, error) {
	rows, err := s.db.Query(
		`SELECT ps.match_id,
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
					AND (ka.side IS NULL OR kv.side IS NULL OR ka.side <> kv.side)
				GROUP BY e.weapon) w), '')
		 FROM player_stats ps
		 WHERE ps.steam_id = ? ORDER BY ps.match_id ASC`, scrub(steamID),
	)
	if err != nil {
		return nil, fmt.Errorf("couldn't load the weapon stats: %w", err)
	}
	defer rows.Close()
	type weaponRow struct {
		matchID int64
		heads   string
	}
	var wrows []weaponRow
	for rows.Next() {
		var w weaponRow
		if err := rows.Scan(&w.matchID, &w.heads); err != nil {
			return nil, fmt.Errorf("couldn't load the weapon stats: %w", err)
		}
		wrows = append(wrows, w)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load the weapon stats: %w", err)
	}
	kbw, found, err := s.seriesMetricFor("raw_kills_by_weapon")
	if err != nil {
		return nil, fmt.Errorf("couldn't load the weapon stats: %w", err)
	}
	out := make([]models.ProfileWeaponJSONs, 0, len(wrows))
	for _, w := range wrows {
		r := models.ProfileWeaponJSONs{HeadshotsByWeapon: w.heads}
		if found {
			vals, err := s.GetMetricValuesForMatch(w.matchID, []int64{kbw.id})
			if err != nil {
				return nil, fmt.Errorf("couldn't load the weapon stats: %w", err)
			}
			byWeapon := map[string]int{}
			for _, mv := range vals {
				if mv.SubjectKey == steamID && mv.Value != nil {
					byWeapon[mv.Dim] = int(*mv.Value)
				}
			}
			j, err := json.Marshal(byWeapon)
			if err != nil {
				return nil, fmt.Errorf("couldn't load the weapon stats: %w", err)
			}
			r.KillsByWeapon = string(j)
		}
		out = append(out, r)
	}
	return out, nil
}

// ---- profile read models (side splits, trade opportunities) ----

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
		 FROM `+playerRoundFoldsAll+` prs
		 JOIN round_player_sides rps
		   ON rps.match_id = prs.match_id AND rps.round = prs.round AND rps.steam_id = prs.steam_id
		 JOIN rounds rd ON rd.match_id = prs.match_id AND rd.number = prs.round
		 WHERE prs.steam_id = ? AND rps.side IN ('ct','t')
		 GROUP BY rps.side
		 ORDER BY rps.side ASC`, scrub(steamID),
	)
	if err != nil {
		return nil, fmt.Errorf("couldn't load the side splits: %w", err)
	}
	defer rows.Close()
	var out []models.ProfileSideSplit
	for rows.Next() {
		var r models.ProfileSideSplit
		if err := rows.Scan(&r.Side, &r.Rounds, &r.Wins, &r.Kills, &r.Deaths, &r.ADR, &r.KASTPct); err != nil {
			return nil, fmt.Errorf("couldn't load the side splits: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load the side splits: %w", err)
	}
	return out, nil
}
