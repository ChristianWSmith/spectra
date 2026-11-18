package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/rules"
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
		return 0, false, fmt.Errorf("couldn't look up the match: %w", err)
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
		return 0, fmt.Errorf("couldn't create the match: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("couldn't create the match: %w", err)
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
		return fmt.Errorf("couldn't update the match status: %w", err)
	}
	return affectedOrNotFound(res, "updating the match status")
}

// CreateJob inserts a queued job for path and returns its id.
func (s *Store) CreateJob(kind, path string) (int64, error) {
	res, err := s.db.Exec(
		`INSERT INTO jobs (kind, path, status, stage, progress, error, created_at, match_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		scrub(kind), scrub(path), models.JobQueued, models.StageQueued, 0.0, "", time.Now(), int64(0),
	)
	if err != nil {
		return 0, fmt.Errorf("couldn't create the job: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("couldn't create the job: %w", err)
	}
	return id, nil
}

// SetJobMatch links a job to its match row.
func (s *Store) SetJobMatch(jobID, matchID int64) error {
	res, err := s.db.Exec(`UPDATE jobs SET match_id = ? WHERE id = ?`, matchID, jobID)
	if err != nil {
		return fmt.Errorf("couldn't link the job to the match: %w", err)
	}
	return affectedOrNotFound(res, "linking the job to the match")
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
		return fmt.Errorf("couldn't update the job: %w", err)
	}
	ok, err := s.jobExists(id)
	if err != nil {
		return fmt.Errorf("couldn't update the job: %w", err)
	}
	if !ok {
		return ErrNotFound
	}
	return nil
}

// jobExists reports whether the jobs row is present: false for an unknown
// id, the raw driver error otherwise (callers wrap it with their own op
// label).
func (s *Store) jobExists(id int64) (bool, error) {
	var one int
	err := s.db.QueryRow(`SELECT 1 FROM jobs WHERE id = ?`, id).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// CancelJob moves a non-terminal (queued/running) job to cancelled. Jobs
// already terminal are left untouched; unknown ids return ErrNotFound.
func (s *Store) CancelJob(id int64) error {
	res, err := s.db.Exec(
		`UPDATE jobs SET status = ?, finished_at = ? WHERE id = ? AND status IN (?, ?)`,
		models.JobCancelled, time.Now(), id, models.JobQueued, models.JobRunning,
	)
	if err != nil {
		return fmt.Errorf("couldn't cancel the job: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("couldn't cancel the job: %w", err)
	}
	if n > 0 {
		return nil
	}
	ok, err := s.jobExists(id)
	if err != nil {
		return fmt.Errorf("couldn't cancel the job: %w", err)
	}
	if !ok {
		return ErrNotFound
	}
	return nil
}

// FindPendingJobByPath returns the newest non-terminal (queued/running)
// job recorded for path — the dedupe key behind Importer.Enqueue (a file
// already in flight never gets a second job, which is what stops a double
// click from turning into a guaranteed "already imported" failure) and
// the pending signal the Library's import-dir row flips on. The bool is
// false when no job is pending for the path.
func (s *Store) FindPendingJobByPath(path string) (models.Job, bool, error) {
	return s.findPendingJob(`path = ?`, scrub(path))
}

// FindPendingJobByMatch returns the newest non-terminal (queued/running)
// job linked to matchID — Importer.Reprocess's coalesce key (one reparse
// in flight per match). The bool is false when none is pending.
func (s *Store) FindPendingJobByMatch(matchID int64) (models.Job, bool, error) {
	return s.findPendingJob(`match_id = ?`, matchID)
}

// findPendingJob runs the one-job lookup behind the two exported forms:
// newest pending job matching where (args bound verbatim), false on no
// row. Callers label their own errors — the two lookups are one query
// shape, not one concept.
func (s *Store) findPendingJob(where string, args ...any) (models.Job, bool, error) {
	row := s.db.QueryRow(
		`SELECT `+jobsCols+` FROM jobs
		 WHERE `+where+` AND status IN (?, ?)
		 ORDER BY created_at DESC, id DESC LIMIT 1`,
		append(args, models.JobQueued, models.JobRunning)...,
	)
	job, err := scanJob(row)
	if errors.Is(err, sql.ErrNoRows) {
		return models.Job{}, false, nil
	}
	if err != nil {
		return models.Job{}, false, fmt.Errorf("couldn't look up the pending job: %w", err)
	}
	return job, true, nil
}

// UpdateJobProgress stamps stage + job-wide progress on a RUNNING job
// only. The status guard matters: a progress write racing a concurrent
// Cancel must never resurrect a job the store already moved to cancelled
// (UpdateJob has no such guard — it is the explicit lifecycle writer).
// A zero-row update is not an error: progress is advisory and "not
// running" (queued, terminal, or an unknown id) has nothing to write.
func (s *Store) UpdateJobProgress(id int64, stage string, progress float64) error {
	if _, err := s.db.Exec(
		`UPDATE jobs SET stage = ?, progress = ? WHERE id = ? AND status = ?`,
		scrub(stage), progress, id, models.JobRunning,
	); err != nil {
		return fmt.Errorf("couldn't update the job progress: %w", err)
	}
	return nil
}

// jobsCols is the jobs row read projection (ListJobs and the pending-job
// lookups), pinned to the DDL by TestColumnListConstsMatchSchema.
const jobsCols = `id, kind, path, status, progress, stage, error, created_at, started_at, finished_at, match_id`

// ListJobs returns the most recent jobs, newest first (created_at DESC,
// id DESC), capped at 200. The cap bounds the display list only: jobs is
// an append-forever history table and this query never prunes it —
// trimming the table itself is Tier 2 work.
func (s *Store) ListJobs() ([]models.Job, error) {
	rows, err := s.db.Query(
		`SELECT ` + jobsCols + ` FROM jobs ORDER BY created_at DESC, id DESC LIMIT 200`,
	)
	if err != nil {
		return nil, fmt.Errorf("couldn't load the jobs: %w", err)
	}
	defer rows.Close()
	var jobs []models.Job
	for rows.Next() {
		job, err := scanJob(rows)
		if err != nil {
			return nil, fmt.Errorf("couldn't load the jobs: %w", err)
		}
		jobs = append(jobs, job)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load the jobs: %w", err)
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
	j.StartedAt = nullTimePtr(started)
	j.FinishedAt = nullTimePtr(finished)
	return j, nil
}

// Per-table column lists (G1 — the ONE hand-written list per table). The
// consts below carry the row WITHOUT the match_id key column: SaveExtracted
// prefixes `match_id, ` for the INSERT, the readers select the list
// verbatim. player_stats/rounds/events have no second identical site (the
// read projections interleave joined display names and computed columns —
// eventRowCols, roundRowSelect, GetScoreboard), so they are named here for
// the schema test to pin against the DDL instead.
const (
	playerStatsCols = `steam_id, side, name, kills, deaths, assists, flash_assists, headshots,
		teamkills, suicides, mvps, score, total_damage, damage_taken, shots, hits, adr, hs_pct,
		rounds_played, entry_kills, entry_deaths, trade_kills,
		best_streak, two_k, three_k, four_k, five_k, utility_damage, enemies_flashed, flashed_times,
		bomb_plants, bomb_defuses, money_spent_total, kills_by_weapon, damage_by_weapon,
		team, won, map`

	roundCols = `number, winner, reason, duration_s, start_tick, end_tick,
		mvp, mvp_reason, equip_ct, equip_t, bomb_site, freeze_end_tick,
		first_kill_steam, first_death_steam`

	roundEconomyCols = `round, side, equip_value, money_sampled_sum, money_samples, spent, free_pistol_value, team`

	eventCols = `seq, tick, round, kind, attacker, victim, assister, weapon,
		headshot, wallbang, noscope, through_smoke, attacker_blind, attacker_inair, assisted_flash, distance,
		hitgroup, dmg, same_side, capped_dmg, site, detail_json, raw_json, pos_x, pos_y, pos_z, apos_x, apos_y, apos_z`

	// chatCols is the chat row WITHOUT match_id; the reader additionally
	// selects `id, ` + it + `, decrypted` (decrypted is M4 provenance with
	// a column default — no writer names it).
	chatCols = `tick, round, steam_id, name, text, kind, channel`

	// soundEventsCols is the sound_events row WITHOUT match_id (G1); both
	// SaveExtracted's INSERT and GetSoundEvents' SELECT use this list —
	// pinned to the DDL by TestColumnListConstsMatchSchema.
	soundEventsCols = `tick, round, steam_id, kind, material, team_prefix, sos_name`
)

// SaveExtracted persists a complete extract output for one match in a
// single transaction: existing child rows are deleted, all children are
// inserted (events numbered seq=0..n in slice order), and the matches
// header is updated from em.Match with status forced to ready. Lifecycle
// columns path/sha256/size are kept. A second call replaces the first.
func (s *Store) SaveExtracted(matchID int64, em *models.ExtractedMatch) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("saving the match data: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	for _, table := range childTables {
		if _, err := tx.Exec(`DELETE FROM `+table+` WHERE match_id = ?`, matchID); err != nil {
			return fmt.Errorf("saving the match data: %w", err)
		}
	}

	teamsStmt, err := tx.Prepare(
		`INSERT INTO teams (match_id, side, name, flag, score, money_spent, equip_total)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return fmt.Errorf("saving the match data: %w", err)
	}
	defer teamsStmt.Close()
	for _, t := range em.Teams {
		if _, err := teamsStmt.Exec(matchID, scrub(t.Side), scrub(t.Name), scrub(t.Flag), t.Score, t.MoneySpent, t.EquipTotal); err != nil {
			return fmt.Errorf("saving the match data: %w", err)
		}
	}

	playersStmt, err := tx.Prepare(
		`INSERT INTO players (match_id, steam_id, name, is_bot, side, clan_tag, crosshair_code,
			rank, rank_type, wins, ping, final_alive, final_state_present)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return fmt.Errorf("saving the match data: %w", err)
	}
	defer playersStmt.Close()
	for _, p := range em.Players {
		if _, err := playersStmt.Exec(
			matchID, scrub(p.SteamID), scrub(p.Name), b2i(p.IsBot), scrub(p.Side), scrub(p.ClanTag),
			scrub(p.CrosshairCode), p.Rank, p.RankType, p.Wins, p.Ping, b2i(p.FinalAlive), b2i(p.FinalStatePresent),
		); err != nil {
			return fmt.Errorf("saving the match data: %w", err)
		}
	}

	// Ingest-owned row stamps (metrics expansion §5): these three
	// tables are written ONLY by SaveExtracted, so their stamps travel
	// WITH the row they describe — a reprocess re-stamps them with the
	// row, and a rules bump never rewrites them (they are match facts,
	// not analysis-rule outputs). team resolves every round-scoped side
	// through the sideparity teamKeyAt formula over THIS extract's own
	// side switches and counted rounds (rules.TeamKeyAt — the same key
	// the Economy view derives client-side; unknown side ⇒ '' ⇒ the row
	// drops out of team-subject grouping, never a guessed team).
	// player_stats' team runs its final side through the same formula:
	// under the teamKeyAt vocabulary a team's key IS its final side, so
	// the round-scoped parity mapping collapses to the row's own side
	// (and a non-side value normalizes to ''). won comes from
	// models.WinFor — the ONE win predicate — over the stored score (tie
	// or unknown side is not a win); map is the match row's map.
	counted := len(em.Rounds)
	switches := em.Match.SideSwitches
	// The counted index of a stored round (position among the extract's
	// counted rounds — the same length RoundStrip feeds flipIndexes, and
	// the dense 1..N numbering makes it round-1; the map keeps the
	// synthetic non-dense fixture honest too).
	countedIndex := make(map[int]int, counted)
	for i, r := range em.Rounds {
		countedIndex[r.Number] = i
	}
	teamOfRound := func(side string, round int) string {
		idx, ok := countedIndex[round]
		if !ok {
			return "" // a row for a round the extract never stored carries no team — never guessed
		}
		return rules.TeamKeyAt(side, idx, counted, switches)
	}
	// A whole-match row's team: its final side IS the team key under the
	// teamKeyAt vocabulary, and the last counted round's index resolves
	// it through the same formula (any era does — the mapping is
	// identity at the final era).
	teamOfPlayer := func(side string) string {
		return rules.TeamKeyAt(side, counted-1, counted, switches)
	}

	statsStmt, err := tx.Prepare(
		`INSERT INTO player_stats (match_id, ` + playerStatsCols + `)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return fmt.Errorf("saving the match data: %w", err)
	}
	defer statsStmt.Close()
	for _, ps := range em.PlayerStats {
		if _, err := statsStmt.Exec(
			matchID, scrub(ps.SteamID), scrub(ps.Side), scrub(ps.Name), ps.Kills, ps.Deaths, ps.Assists,
			ps.FlashAssists, ps.Headshots, ps.Teamkills, ps.Suicides, ps.MVPs, ps.Score, ps.TotalDamage,
			ps.DamageTaken, ps.Shots, ps.Hits, ps.ADR, ps.HSPct, ps.RoundsPlayed, ps.EntryKills,
			ps.EntryDeaths, ps.TradeKills, ps.BestStreak, ps.TwoK,
			ps.ThreeK, ps.FourK, ps.FiveK, ps.UtilityDamage, ps.EnemiesFlashed, ps.FlashedTimes, ps.BombPlants,
			ps.BombDefuses, ps.MoneySpentTotal, scrub(ps.KillsByWeapon), scrub(ps.DamageByWeapon),
			teamOfPlayer(ps.Side), b2i(models.WinFor(ps.Side, em.Match.ScoreCT, em.Match.ScoreT)),
			scrub(em.Match.Map),
		); err != nil {
			return fmt.Errorf("saving the match data: %w", err)
		}
	}

	roundsStmt, err := tx.Prepare(
		`INSERT INTO rounds (match_id, ` + roundCols + `)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return fmt.Errorf("saving the match data: %w", err)
	}
	defer roundsStmt.Close()
	for _, r := range em.Rounds {
		if _, err := roundsStmt.Exec(
			matchID, r.Number, scrub(r.Winner), scrub(r.Reason), r.DurationS, r.StartTick, r.EndTick,
			scrub(r.MVP), scrub(r.MVPReason), r.EquipCT, r.EquipT,
			scrub(r.BombSite), r.FreezeEndTick, scrub(r.FirstKillSteam), scrub(r.FirstDeathSteam),
		); err != nil {
			return fmt.Errorf("saving the match data: %w", err)
		}
	}

	sidesStmt, err := tx.Prepare(
		`INSERT INTO round_player_sides (match_id, round, steam_id, side, team) VALUES (?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return fmt.Errorf("saving the match data: %w", err)
	}
	defer sidesStmt.Close()
	for _, rs := range em.RoundSides {
		if _, err := sidesStmt.Exec(matchID, rs.Round, scrub(rs.SteamID), scrub(rs.Side), teamOfRound(rs.Side, rs.Round)); err != nil {
			return fmt.Errorf("saving the match data: %w", err)
		}
	}

	econStmt, err := tx.Prepare(
		`INSERT INTO round_economy (match_id, ` + roundEconomyCols + `)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return fmt.Errorf("saving the match data: %w", err)
	}
	defer econStmt.Close()
	for _, e := range em.RoundEconomy {
		if _, err := econStmt.Exec(matchID, e.Round, scrub(e.Side), e.EquipValue, e.MoneySampledSum, e.MoneySamples, e.Spent, e.FreePistolValue, teamOfRound(e.Side, e.Round)); err != nil {
			return fmt.Errorf("saving the match data: %w", err)
		}
	}

	eventsStmt, err := tx.Prepare(
		`INSERT INTO events (match_id, ` + eventCols + `)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return fmt.Errorf("saving the match data: %w", err)
	}
	defer eventsStmt.Close()
	for i, e := range em.Events {
		if _, err := eventsStmt.Exec(
			matchID, i, e.Tick, e.Round, scrub(e.Kind), scrub(e.Attacker), scrub(e.Victim),
			scrub(e.Assister), scrub(e.Weapon), b2i(e.Headshot), b2i(e.Wallbang), b2i(e.Noscope),
			b2i(e.ThroughSmoke), b2i(e.AttackerBlind), b2i(e.AttackerInAir), b2i(e.AssistedFlash), e.Distance, scrub(e.Hitgroup),
			e.Dmg, b2i(e.SameSide), e.CappedDmg, scrub(e.Site), scrub(e.DetailJSON), scrub(e.RawJSON),
			nvl(e.PosX), nvl(e.PosY), nvl(e.PosZ),
			nvl(e.AttackerPosX), nvl(e.AttackerPosY), nvl(e.AttackerPosZ),
		); err != nil {
			return fmt.Errorf("saving the match data: %w", err)
		}
	}

	genericStmt, err := tx.Prepare(
		`INSERT INTO generic_events (match_id, name, tick, round, payload_json) VALUES (?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return fmt.Errorf("saving the match data: %w", err)
	}
	defer genericStmt.Close()
	for _, g := range em.GenericEvents {
		if _, err := genericStmt.Exec(matchID, scrub(g.Name), g.Tick, g.Round, scrub(g.PayloadJSON)); err != nil {
			return fmt.Errorf("saving the match data: %w", err)
		}
	}

	chatStmt, err := tx.Prepare(
		`INSERT INTO chat (match_id, ` + chatCols + `) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return fmt.Errorf("saving the match data: %w", err)
	}
	defer chatStmt.Close()
	for _, c := range em.Chat {
		if _, err := chatStmt.Exec(matchID, c.Tick, c.Round, scrub(c.SteamID), scrub(c.Name), scrub(c.Text), scrub(c.Kind), scrub(c.Channel)); err != nil {
			return fmt.Errorf("saving the match data: %w", err)
		}
	}

	soundStmt, err := tx.Prepare(
		`INSERT INTO sound_events (match_id, ` + soundEventsCols + `) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return fmt.Errorf("saving the match data: %w", err)
	}
	defer soundStmt.Close()
	for _, se := range em.SoundEvents {
		if _, err := soundStmt.Exec(matchID, se.Tick, se.Round, scrub(se.SteamID), scrub(se.Kind), scrub(se.Material), scrub(se.TeamPrefix), scrub(se.SOSName)); err != nil {
			return fmt.Errorf("saving the match data: %w", err)
		}
	}

	warnStmt, err := tx.Prepare(`INSERT INTO warnings (match_id, seq, message) VALUES (?, ?, ?)`)
	if err != nil {
		return fmt.Errorf("saving the match data: %w", err)
	}
	defer warnStmt.Close()
	for i, w := range em.Warnings {
		if _, err := warnStmt.Exec(matchID, i, scrub(w)); err != nil {
			return fmt.Errorf("saving the match data: %w", err)
		}
	}

	m := em.Match
	// ONE matches list: the SET clause walks matchColumns, skipping the
	// columns other writers own (path/sha256/size = lifecycle,
	// position_* = sidecar), so the extract write can never drift from
	// GetMatch's SELECT list.
	set := make([]string, 0, len(matchColumns))
	for _, c := range matchColumns {
		if matchOwnedElsewhere[c] {
			continue
		}
		set = append(set, c+" = ?")
	}
	res, err := tx.Exec(
		`UPDATE matches SET `+strings.Join(set, ", ")+` WHERE id = ?`,
		scrub(m.Map), m.PatchVersion, m.TickRate, m.DurationTicks, m.PlaybackTimeS, m.Frames,
		scrub(m.ServerName), scrub(m.ClientName), scrub(m.GameDir), scrub(m.NetProto), b2i(m.IsPOV),
		m.RealRounds, m.ScoreCT, m.ScoreT, m.HalfCT, m.HalfT, m.SideSwitches,
		m.EntityClasses, m.EndEntityCount, scrub(m.ParserVersion), m.ExtractedAt, m.ParseMS,
		m.WarningsCount, models.StatusReady, "", m.EncryptedMessages, matchID,
	)
	if err != nil {
		return fmt.Errorf("saving the match data: %w", err)
	}
	if err := affectedOrNotFound(res, "saving the match data"); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("saving the match data: %w", err)
	}
	return nil
}

// SetPositionMeta records the position sidecar's mirror columns on the
// match row (sample rate, frame count). Callers write it
// from sidecar.Writer.Close's meta after a successful parse; 0 values mean
// "no sidecar". Unknown ids return ErrNotFound.
func (s *Store) SetPositionMeta(matchID int64, sampleRate, frames int) error {
	res, err := s.db.Exec(
		`UPDATE matches SET sample_rate = ?, position_frames = ? WHERE id = ?`,
		sampleRate, frames, matchID,
	)
	if err != nil {
		return fmt.Errorf("couldn't save the position data: %w", err)
	}
	return affectedOrNotFound(res, "recording the position data")
}

// DeleteMatchData removes a match row and all of its child data in one
// transaction. Returns ErrNotFound when no such match exists.
func (s *Store) DeleteMatchData(id int64) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("couldn't delete the match data: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var one int
	if err := tx.QueryRow(`SELECT 1 FROM matches WHERE id = ?`, id).Scan(&one); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("couldn't delete the match data: %w", err)
	}
	for _, table := range childTables {
		if _, err := tx.Exec(`DELETE FROM `+table+` WHERE match_id = ?`, id); err != nil {
			return fmt.Errorf("couldn't delete the match data: %w", err)
		}
	}
	if _, err := tx.Exec(`DELETE FROM matches WHERE id = ?`, id); err != nil {
		return fmt.Errorf("couldn't delete the match data: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("couldn't delete the match data: %w", err)
	}
	// The deleted match's rows no longer exist — refresh the career rollup
	// so profiles stay correct (M3: LibraryService.DeleteMatch → rebuild).
	if err := s.RebuildCareer(); err != nil {
		return err
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

// replaceMatchRows is the canonical delete-then-insert transaction for one
// match's child table: BEGIN, DELETE FROM <table> WHERE match_id = ?,
// prepare INSERT INTO <table> (<cols>) VALUES (?, …) — placeholders derived
// from the column list — fill n rows in slice order, COMMIT (the deferred
// rollback swallows every failure path). op wraps the begin/
// delete/prepare/commit failures with the caller's label; fill returns its
// per-row error ALREADY labeled (row errors carry context the helper cannot
// know, e.g. a row index), so they pass through unwrapped. Transaction shape
// and error text are identical to the five hand-rolled Replace* bodies this
// replaces.
func (s *Store) replaceMatchRows(op, table, cols string, matchID int64, n int, fill func(*sql.Stmt, int) error) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("%s: %w", op, err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`DELETE FROM `+table+` WHERE match_id = ?`, matchID); err != nil {
		return fmt.Errorf("%s: %w", op, err)
	}
	// n columns → n-1 commas → n placeholders (`?,?,?`).
	placeholders := strings.Repeat("?,", strings.Count(cols, ",")) + "?"
	stmt, err := tx.Prepare(`INSERT INTO ` + table + ` (` + cols + `) VALUES (` + placeholders + `)`)
	if err != nil {
		return fmt.Errorf("%s: %w", op, err)
	}
	defer stmt.Close()
	for i := 0; i < n; i++ {
		if err := fill(stmt, i); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("%s: %w", op, err)
	}
	return nil
}
