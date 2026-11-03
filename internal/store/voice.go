package store

import (
	"database/sql"
	"errors"
	"fmt"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// This file is the M4 voice persistence surface: voice_presence +
// voice_chunks (see the baseline schema). The DB is the chunk index —
// audio payloads stay in the sidecar's per-player .opus files
// (internal/sidecar).

// Per-table column lists (G1). voicePresenceCols is the WHOLE row (the
// reader selects the identical list); voiceChunksCols is the row without
// the match_id key column (the writer prefixes `match_id, `).
const (
	voicePresenceCols = `match_id, chunk_count, player_count, caster_count, key_found, out_sample_rate`

	voiceChunksCols = `seq, steam_id, tick, round, byte_off, len, caster, section`
)

// InsertVoice replaces a match's voice index in one transaction
// (delete-then-insert — reprocess safe). Round is computed per row here
// from the match's round tick ranges (rows arrive with Round 0: writers
// never know about rounds; library passes em.Rounds straight from the
// parse). Callers run it after SaveExtracted so the match row exists.
// A 123k-chunk match is one batched txn (measured import target).
//
// Not the replaceMatchRows shape: the transaction spans TWO tables plus the
// single presence row, and the per-row error names the failing index — so
// the shared helper's one-table BEGIN/DELETE/INSERT body does not fit
// without splitting the transaction (atomicity) or relabeling errors.
func (s *Store) InsertVoice(matchID int64, rows []models.VoiceIndexRow, presence models.VoicePresenceRow, rounds []models.Round) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("store: insert voice: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	for _, table := range []string{"voice_chunks", "voice_presence"} {
		if _, err := tx.Exec(`DELETE FROM `+table+` WHERE match_id = ?`, matchID); err != nil {
			return fmt.Errorf("store: insert voice: clear %s: %w", table, err)
		}
	}
	if _, err := tx.Exec(
		`INSERT INTO voice_presence (`+voicePresenceCols+`)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		matchID, presence.ChunkCount, presence.PlayerCount, presence.CasterCount,
		b2i(presence.KeyFound), presence.OutSampleRate,
	); err != nil {
		return fmt.Errorf("store: insert voice presence: %w", err)
	}

	stmt, err := tx.Prepare(
		`INSERT INTO voice_chunks (match_id, ` + voiceChunksCols + `)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return fmt.Errorf("store: insert voice: %w", err)
	}
	defer stmt.Close()
	for i, r := range rows {
		round, _ := RoundForTick(rounds, r.Tick)
		if _, err := stmt.Exec(
			matchID, i, scrub(r.SteamID), r.Tick, round,
			r.Off, r.Len, b2i(r.Caster), r.Section,
		); err != nil {
			return fmt.Errorf("store: insert voice chunk %d: %w", i, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: insert voice: %w", err)
	}
	return nil
}

// RoundForTick returns the round number whose [StartTick, EndTick] range
// contains tick, and whether any round did (false → 0 — a tick outside
// every range, e.g. before the first freeze). Rounds are chronological and
// non-overlapping; a warmup-less gap between rounds attributes to the
// preceding round via inclusive EndTick. The one implementation: the voice
// writer (chunk → round) and the heatmap's tick→round lookup both use it.
func RoundForTick(rounds []models.Round, tick int) (int, bool) {
	for _, r := range rounds {
		if tick >= r.StartTick && tick <= r.EndTick {
			return r.Number, true
		}
	}
	return 0, false
}

// GetVoicePresence returns a match's voice_presence row (ErrNotFound when
// absent — the no-voice case, not an error for callers that treat it as
// "badge off").
func (s *Store) GetVoicePresence(matchID int64) (models.VoicePresenceRow, error) {
	var p models.VoicePresenceRow
	var keyFound int64
	err := s.db.QueryRow(
		`SELECT `+voicePresenceCols+`
		 FROM voice_presence WHERE match_id = ?`, matchID,
	).Scan(&p.MatchID, &p.ChunkCount, &p.PlayerCount, &p.CasterCount, &keyFound, &p.OutSampleRate)
	if errors.Is(err, sql.ErrNoRows) {
		return models.VoicePresenceRow{}, ErrNotFound
	}
	if err != nil {
		return models.VoicePresenceRow{}, fmt.Errorf("store: get voice presence: %w", err)
	}
	p.KeyFound = i2b(keyFound)
	return p, nil
}

// GetVoicePlayers returns one row per speaking player (derived GROUP BY —
// no voice_players table), joined with the roster name ("" for unknown
// SteamIDs, e.g. casters), ordered by chunks DESC then steam ID.
func (s *Store) GetVoicePlayers(matchID int64) ([]models.VoicePlayerRow, error) {
	rows, err := s.db.Query(
		`SELECT v.steam_id, COALESCE(p.name, ''), COUNT(*), MIN(v.tick), MAX(v.tick)
		 FROM voice_chunks v
		 `+playersJoin(joinLeft, "p", "v.match_id", "v.steam_id", true)+`
		 WHERE v.match_id = ?
		 GROUP BY v.steam_id
		 ORDER BY COUNT(*) DESC, v.steam_id ASC`, matchID,
	)
	if err != nil {
		return nil, fmt.Errorf("store: get voice players: %w", err)
	}
	defer rows.Close()
	var out []models.VoicePlayerRow
	for rows.Next() {
		var r models.VoicePlayerRow
		if err := rows.Scan(&r.SteamID, &r.Name, &r.Chunks, &r.FirstTick, &r.LastTick); err != nil {
			return nil, fmt.Errorf("store: get voice players: %w", err)
		}
		r.MatchID = matchID
		r.Seconds = float64(r.Chunks) * 0.01 // 10 ms Opus frames
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get voice players: %w", err)
	}
	return out, nil
}

// GetVoiceTicks returns every captured chunk tick for a match (all players
// when steamID is ""), ordered by tick — the lane-bucketing source (no
// decode involved).
func (s *Store) GetVoiceTicks(matchID int64, steamID string) ([]int, error) {
	q := `SELECT tick FROM voice_chunks WHERE match_id = ?`
	args := []any{matchID}
	if sid := scrub(steamID); sid != "" {
		q += ` AND steam_id = ?`
		args = append(args, sid)
	}
	q += ` ORDER BY tick`
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("store: get voice ticks: %w", err)
	}
	defer rows.Close()
	var out []int
	for rows.Next() {
		var t int
		if err := rows.Scan(&t); err != nil {
			return nil, fmt.Errorf("store: get voice ticks: %w", err)
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get voice ticks: %w", err)
	}
	return out, nil
}

// GetVoiceChunkRange returns a player's chunk index rows with
// from <= tick <= to, ordered by tick — the PCM/WAV decode source (rows
// carry Off/Len into that player's .opus file).
func (s *Store) GetVoiceChunkRange(matchID int64, steamID string, from, to int) ([]models.VoiceIndexRow, error) {
	rows, err := s.db.Query(
		`SELECT `+voiceChunksCols+`
		 FROM voice_chunks
		 WHERE match_id = ? AND steam_id = ? AND tick BETWEEN ? AND ?
		 ORDER BY tick, seq`, matchID, scrub(steamID), from, to,
	)
	if err != nil {
		return nil, fmt.Errorf("store: get voice chunk range: %w", err)
	}
	defer rows.Close()
	var out []models.VoiceIndexRow
	for rows.Next() {
		var (
			r      models.VoiceIndexRow
			seq    int
			caster int64
		)
		if err := rows.Scan(&seq, &r.SteamID, &r.Tick, &r.Round, &r.Off, &r.Len, &caster, &r.Section); err != nil {
			return nil, fmt.Errorf("store: get voice chunk range: %w", err)
		}
		r.Caster = i2b(caster)
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get voice chunk range: %w", err)
	}
	return out, nil
}
