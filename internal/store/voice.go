package store

import (
	"database/sql"
	"errors"
	"fmt"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// This file is the M4 voice persistence surface: the voice_presence header
// (see the baseline schema). The chunk index itself lives in the per-match
// sidecar — <matchDir>/voice/<steamid>.idx, internal/sidecar — so this
// package never reads it (and must NOT import sidecar: sidecar is the
// lower layer, importing it here would be a cycle).

// Per-table column lists (G1). voicePresenceCols is the WHOLE row (the
// reader selects the identical list; the writer prefixes nothing).
const voicePresenceCols = `match_id, chunk_count, player_count, caster_count, key_found, out_sample_rate`

// SaveVoicePresence writes a match's single voice_presence row (the
// provenance header: chunk/player/caster counts + the .dem.info key flag).
// A single-row INSERT, no delete-first: SaveExtracted already cleared the
// row through childTables before this runs (reprocess path), so the
// canonical replaceMatchRows DELETE would be a no-op here. The chunk index
// is NOT written by this call — it is already on disk in the sidecar.
// Callers run it after SaveExtracted so the match row exists.
func (s *Store) SaveVoicePresence(matchID int64, presence models.VoicePresenceRow) error {
	if _, err := s.db.Exec(
		`INSERT INTO voice_presence (`+voicePresenceCols+`)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		matchID, presence.ChunkCount, presence.PlayerCount, presence.CasterCount,
		b2i(presence.KeyFound), presence.OutSampleRate,
	); err != nil {
		return fmt.Errorf("store: save voice presence: %w", err)
	}
	return nil
}

// RoundForTick returns the round number whose [StartTick, EndTick] range
// contains tick, and whether any round did (false → 0 — a tick outside
// every round, e.g. before the first freeze). Rounds are chronological and
// non-overlapping; a warmup-less gap between rounds attributes to the
// preceding round via inclusive EndTick. The one implementation: the
// heatmap's tick→round lookup; a voice index read that needs a round
// derives it here too (the index stores ticks only).
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
// "badge off"). It is provenance, not capability: callers that serve or
// count voice also gate on the sidecar's voice/*.idx existing.
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
