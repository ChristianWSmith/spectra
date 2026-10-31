package store

import (
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// GetMatchBySHA reports the id of the match previously imported from a demo
// with the given sha256. The bool is false when no such match exists.
func (s *Store) GetMatchBySHA(sha string) (int64, bool, error) {
	var id int64
	err := s.db.QueryRow(`SELECT id FROM matches WHERE sha256 = ?`, scrub(sha)).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("store: get match by sha256: %w", err)
	}
	return id, true, nil
}

// CreateMatchRow inserts the lifecycle row for a newly accepted demo
// (status queued) and returns its id.
func (s *Store) CreateMatchRow(path, sha string, size int64) (int64, error) {
	res, err := s.db.Exec(
		`INSERT INTO matches (path, sha256, size, status) VALUES (?, ?, ?, ?)`,
		scrub(path), scrub(sha), size, models.StatusQueued,
	)
	if err != nil {
		return 0, fmt.Errorf("store: create match row: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("store: create match row: %w", err)
	}
	return id, nil
}

// SetMatchStatus updates the lifecycle status and error of a match row.
func (s *Store) SetMatchStatus(id int64, status, errMsg string) error {
	res, err := s.db.Exec(
		`UPDATE matches SET status = ?, error = ? WHERE id = ?`,
		scrub(status), scrub(errMsg), id,
	)
	if err != nil {
		return fmt.Errorf("store: set match status: %w", err)
	}
	return affectedOrNotFound(res, "store: set match status")
}

// CreateJob inserts a queued job for path and returns its id.
func (s *Store) CreateJob(kind, path string) (int64, error) {
	res, err := s.db.Exec(
		`INSERT INTO jobs (kind, path, status, stage, progress, error, created_at, match_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		scrub(kind), scrub(path), models.JobQueued, models.StageQueued, 0.0, "", time.Now(), int64(0),
	)
	if err != nil {
		return 0, fmt.Errorf("store: create job: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("store: create job: %w", err)
	}
	return id, nil
}

// SetJobMatch links a job to its match row.
func (s *Store) SetJobMatch(jobID, matchID int64) error {
	res, err := s.db.Exec(`UPDATE jobs SET match_id = ? WHERE id = ?`, matchID, jobID)
	if err != nil {
		return fmt.Errorf("store: set job match: %w", err)
	}
	return affectedOrNotFound(res, "store: set job match")
}

// UpdateJob stamps a job's status/stage/progress/error. Transitioning to
// running stamps started_at (once); done/failed/cancelled stamp
// finished_at. Unknown ids return ErrNotFound.
func (s *Store) UpdateJob(id int64, status, stage string, progress float64, errMsg string) error {
	now := time.Now()
	_, err := s.db.Exec(
		`UPDATE jobs SET status = ?, stage = ?, progress = ?, error = ?,
			started_at = CASE WHEN ? = ? AND started_at IS NULL THEN ? ELSE started_at END,
			finished_at = CASE WHEN ? IN (?, ?, ?) THEN ? ELSE finished_at END
		 WHERE id = ?`,
		scrub(status), scrub(stage), progress, scrub(errMsg),
		scrub(status), models.JobRunning, now,
		scrub(status), models.JobDone, models.JobFailed, models.JobCancelled, now,
		id,
	)
	if err != nil {
		return fmt.Errorf("store: update job: %w", err)
	}
	var one int
	err = s.db.QueryRow(`SELECT 1 FROM jobs WHERE id = ?`, id).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("store: update job: %w", err)
	}
	return nil
}

// CancelJob moves a non-terminal (queued/running) job to cancelled. Jobs
// already terminal are left untouched; unknown ids return ErrNotFound.
func (s *Store) CancelJob(id int64) error {
	res, err := s.db.Exec(
		`UPDATE jobs SET status = ?, finished_at = ? WHERE id = ? AND status IN (?, ?)`,
		models.JobCancelled, time.Now(), id, models.JobQueued, models.JobRunning,
	)
	if err != nil {
		return fmt.Errorf("store: cancel job: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("store: cancel job: %w", err)
	}
	if n > 0 {
		return nil
	}
	var one int
	err = s.db.QueryRow(`SELECT 1 FROM jobs WHERE id = ?`, id).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("store: cancel job: %w", err)
	}
	return nil
}

// ListJobs returns all jobs, newest first (created_at DESC, id DESC).
func (s *Store) ListJobs() ([]models.Job, error) {
	rows, err := s.db.Query(
		`SELECT id, kind, path, status, progress, stage, error, created_at, started_at, finished_at, match_id
		 FROM jobs ORDER BY created_at DESC, id DESC`,
	)
	if err != nil {
		return nil, fmt.Errorf("store: list jobs: %w", err)
	}
	defer rows.Close()
	var jobs []models.Job
	for rows.Next() {
		job, err := scanJob(rows)
		if err != nil {
			return nil, fmt.Errorf("store: list jobs: %w", err)
		}
		jobs = append(jobs, job)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list jobs: %w", err)
	}
	return jobs, nil
}

func scanJob(row interface{ Scan(...any) error }) (models.Job, error) {
	var (
		j                 models.Job
		created           time.Time
		started, finished sql.NullTime
	)
	err := row.Scan(
		&j.ID, &j.Kind, &j.Path, &j.Status, &j.Progress, &j.Stage, &j.Error,
		&created, &started, &finished, &j.MatchID,
	)
	if err != nil {
		return j, err
	}
	j.CreatedAt = created
	if started.Valid {
		t := started.Time
		j.StartedAt = &t
	}
	if finished.Valid {
		t := finished.Time
		j.FinishedAt = &t
	}
	return j, nil
}

// SaveExtracted persists a complete extract output for one match in a
// single transaction: existing child rows are deleted, all children are
// inserted (events numbered seq=0..n in slice order), and the matches
// header is updated from em.Match with status forced to ready. Lifecycle
// columns path/sha256/size are kept. A second call replaces the first.
func (s *Store) SaveExtracted(matchID int64, em *models.ExtractedMatch) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("store: save extracted: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	for _, table := range childTables {
		if _, err := tx.Exec(`DELETE FROM `+table+` WHERE match_id = ?`, matchID); err != nil {
			return fmt.Errorf("store: save extracted: clear %s: %w", table, err)
		}
	}

	teamsStmt, err := tx.Prepare(
		`INSERT INTO teams (match_id, side, name, flag, score, money_spent, equip_total)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return fmt.Errorf("store: save extracted: %w", err)
	}
	defer teamsStmt.Close()
	for _, t := range em.Teams {
		if _, err := teamsStmt.Exec(matchID, scrub(t.Side), scrub(t.Name), scrub(t.Flag), t.Score, t.MoneySpent, t.EquipTotal); err != nil {
			return fmt.Errorf("store: save extracted: teams: %w", err)
		}
	}

	playersStmt, err := tx.Prepare(
		`INSERT INTO players (match_id, steam_id, name, is_bot, side, clan_tag, crosshair_code,
			rank, rank_type, wins, ping, final_alive, final_state_present)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return fmt.Errorf("store: save extracted: %w", err)
	}
	defer playersStmt.Close()
	for _, p := range em.Players {
		if _, err := playersStmt.Exec(
			matchID, scrub(p.SteamID), scrub(p.Name), b2i(p.IsBot), scrub(p.Side), scrub(p.ClanTag),
			scrub(p.CrosshairCode), p.Rank, p.RankType, p.Wins, p.Ping, b2i(p.FinalAlive), b2i(p.FinalStatePresent),
		); err != nil {
			return fmt.Errorf("store: save extracted: players: %w", err)
		}
	}

	statsStmt, err := tx.Prepare(
		`INSERT INTO player_stats (match_id, steam_id, side, name, kills, deaths, assists, headshots,
			teamkills, suicides, mvps, score, total_damage, damage_taken, shots, hits, adr, hs_pct,
			rounds_played, entry_kills, entry_deaths, opening_kills, opening_deaths, trade_kills,
			best_streak, three_k, four_k, five_k, utility_damage, flashes_popped, flashed_times,
			bomb_plants, bomb_defuses, money_spent_total, kills_by_weapon, damage_by_weapon)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return fmt.Errorf("store: save extracted: %w", err)
	}
	defer statsStmt.Close()
	for _, ps := range em.PlayerStats {
		if _, err := statsStmt.Exec(
			matchID, scrub(ps.SteamID), scrub(ps.Side), scrub(ps.Name), ps.Kills, ps.Deaths, ps.Assists,
			ps.Headshots, ps.Teamkills, ps.Suicides, ps.MVPs, ps.Score, ps.TotalDamage, ps.DamageTaken,
			ps.Shots, ps.Hits, ps.ADR, ps.HSPct, ps.RoundsPlayed, ps.EntryKills, ps.EntryDeaths,
			ps.OpeningKills, ps.OpeningDeaths, ps.TradeKills, ps.BestStreak, ps.ThreeK, ps.FourK,
			ps.FiveK, ps.UtilityDamage, ps.FlashesPopped, ps.FlashedTimes, ps.BombPlants, ps.BombDefuses,
			ps.MoneySpentTotal, scrub(ps.KillsByWeapon), scrub(ps.DamageByWeapon),
		); err != nil {
			return fmt.Errorf("store: save extracted: player_stats: %w", err)
		}
	}

	roundsStmt, err := tx.Prepare(
		`INSERT INTO rounds (match_id, number, winner, reason, duration_s, start_tick, end_tick,
			warmup, mvp, mvp_reason, equip_ct, equip_t, bomb_site, freeze_end_tick,
			first_kill_steam, first_death_steam)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return fmt.Errorf("store: save extracted: %w", err)
	}
	defer roundsStmt.Close()
	for _, r := range em.Rounds {
		if _, err := roundsStmt.Exec(
			matchID, r.Number, scrub(r.Winner), scrub(r.Reason), r.DurationS, r.StartTick, r.EndTick,
			b2i(r.Warmup), scrub(r.MVP), scrub(r.MVPReason), r.EquipCT, r.EquipT, scrub(r.BombSite),
			r.FreezeEndTick, scrub(r.FirstKillSteam), scrub(r.FirstDeathSteam),
		); err != nil {
			return fmt.Errorf("store: save extracted: rounds: %w", err)
		}
	}

	econStmt, err := tx.Prepare(
		`INSERT INTO round_economy (match_id, round, side, equip_value, money_sampled_sum, money_samples)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return fmt.Errorf("store: save extracted: %w", err)
	}
	defer econStmt.Close()
	for _, e := range em.RoundEconomy {
		if _, err := econStmt.Exec(matchID, e.Round, scrub(e.Side), e.EquipValue, e.MoneySampledSum, e.MoneySamples); err != nil {
			return fmt.Errorf("store: save extracted: round_economy: %w", err)
		}
	}

	eventsStmt, err := tx.Prepare(
		`INSERT INTO events (match_id, seq, tick, round, kind, attacker, victim, assister, weapon,
			headshot, wallbang, noscope, through_smoke, attacker_blind, assisted_flash, distance,
			hitgroup, dmg, site, detail_json, raw_json)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return fmt.Errorf("store: save extracted: %w", err)
	}
	defer eventsStmt.Close()
	for i, e := range em.Events {
		if _, err := eventsStmt.Exec(
			matchID, i, e.Tick, e.Round, scrub(e.Kind), scrub(e.Attacker), scrub(e.Victim),
			scrub(e.Assister), scrub(e.Weapon), b2i(e.Headshot), b2i(e.Wallbang), b2i(e.Noscope),
			b2i(e.ThroughSmoke), b2i(e.AttackerBlind), b2i(e.AssistedFlash), e.Distance, scrub(e.Hitgroup),
			e.Dmg, scrub(e.Site), scrub(e.DetailJSON), scrub(e.RawJSON),
		); err != nil {
			return fmt.Errorf("store: save extracted: events: %w", err)
		}
	}

	genericStmt, err := tx.Prepare(
		`INSERT INTO generic_events (match_id, name, tick, round, payload_json) VALUES (?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return fmt.Errorf("store: save extracted: %w", err)
	}
	defer genericStmt.Close()
	for _, g := range em.GenericEvents {
		if _, err := genericStmt.Exec(matchID, scrub(g.Name), g.Tick, g.Round, scrub(g.PayloadJSON)); err != nil {
			return fmt.Errorf("store: save extracted: generic_events: %w", err)
		}
	}

	chatStmt, err := tx.Prepare(
		`INSERT INTO chat (match_id, tick, round, steam_id, name, text, kind) VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return fmt.Errorf("store: save extracted: %w", err)
	}
	defer chatStmt.Close()
	for _, c := range em.Chat {
		if _, err := chatStmt.Exec(matchID, c.Tick, c.Round, scrub(c.SteamID), scrub(c.Name), scrub(c.Text), scrub(c.Kind)); err != nil {
			return fmt.Errorf("store: save extracted: chat: %w", err)
		}
	}

	warnStmt, err := tx.Prepare(`INSERT INTO warnings (match_id, seq, message) VALUES (?, ?, ?)`)
	if err != nil {
		return fmt.Errorf("store: save extracted: %w", err)
	}
	defer warnStmt.Close()
	for i, w := range em.Warnings {
		if _, err := warnStmt.Exec(matchID, i, scrub(w)); err != nil {
			return fmt.Errorf("store: save extracted: warnings: %w", err)
		}
	}

	m := em.Match
	res, err := tx.Exec(
		`UPDATE matches SET map = ?, patch_version = ?, tick_rate = ?, duration_ticks = ?,
			playback_time_s = ?, frames = ?, server_name = ?, client_name = ?, game_dir = ?,
			net_proto = ?, is_pov = ?, warmup_rounds = ?, real_rounds = ?, score_ct = ?,
			score_t = ?, half_ct = ?, half_t = ?, side_switches = ?, entity_classes = ?,
			end_entity_count = ?, parser_version = ?, extracted_at = ?, parse_ms = ?,
			warnings_count = ?, status = ?, error = ?
		 WHERE id = ?`,
		scrub(m.Map), m.PatchVersion, m.TickRate, m.DurationTicks, m.PlaybackTimeS, m.Frames,
		scrub(m.ServerName), scrub(m.ClientName), scrub(m.GameDir), scrub(m.NetProto), b2i(m.IsPOV),
		m.WarmupRounds, m.RealRounds, m.ScoreCT, m.ScoreT, m.HalfCT, m.HalfT, m.SideSwitches,
		m.EntityClasses, m.EndEntityCount, scrub(m.ParserVersion), m.ExtractedAt, m.ParseMS,
		m.WarningsCount, models.StatusReady, "", matchID,
	)
	if err != nil {
		return fmt.Errorf("store: save extracted: update match: %w", err)
	}
	if err := affectedOrNotFound(res, "store: save extracted: update match"); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: save extracted: %w", err)
	}
	return nil
}

// DeleteMatchData removes a match row and all of its child data in one
// transaction. Returns ErrNotFound when no such match exists.
func (s *Store) DeleteMatchData(id int64) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("store: delete match data: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var one int
	if err := tx.QueryRow(`SELECT 1 FROM matches WHERE id = ?`, id).Scan(&one); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("store: delete match data: %w", err)
	}
	for _, table := range childTables {
		if _, err := tx.Exec(`DELETE FROM `+table+` WHERE match_id = ?`, id); err != nil {
			return fmt.Errorf("store: delete match data: clear %s: %w", table, err)
		}
	}
	if _, err := tx.Exec(`DELETE FROM matches WHERE id = ?`, id); err != nil {
		return fmt.Errorf("store: delete match data: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: delete match data: %w", err)
	}
	return nil
}

// affectedOrNotFound turns a zero-row UPDATE into ErrNotFound.
func affectedOrNotFound(res sql.Result, op string) error {
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("%s: %w", op, err)
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
