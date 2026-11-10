package store

import (
	"fmt"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// This file is the sound_events read surface: the player sounds
// (footsteps/lands/jumps/fall damage) the extractor stored from
// CMsgSosStartSoundEvent (extract.sos.go). The writer is SaveExtracted
// (lifecycle.go, batch insert beside every other child table).

// GetSoundEvents returns one match's player-sound rows in (tick, insertion)
// order inside an INCLUSIVE tick window: `tick >= fromTick AND tick <= toTick`.
// Either bound <= 0 is OPEN on that side — the repo's "0 = open bound"
// convention (the same rule store.queryEvents applies to RoundFrom/RoundTo),
// so (0, 0) reads the whole match. Kind/steamId filtering is deliberately
// NOT part of this query: every read is match-bounded
// (idx_sound_events_match_tick), and the frontend wave filters the returned
// window client-side. An unknown match simply yields no rows — the header
// reads (GetMatch/GetRounds) are the ones that return ErrNotFound.
func (s *Store) GetSoundEvents(matchID int64, fromTick, toTick int) ([]models.SoundEvent, error) {
	q := `SELECT ` + soundEventsCols + ` FROM sound_events WHERE match_id = ?`
	args := []any{matchID}
	if fromTick > 0 {
		q += ` AND tick >= ?`
		args = append(args, fromTick)
	}
	if toTick > 0 {
		q += ` AND tick <= ?`
		args = append(args, toTick)
	}
	// rowid keeps ties (same tick) in insertion order — deterministic reads.
	q += ` ORDER BY tick, rowid`
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("store: get sound events: %w", err)
	}
	defer rows.Close()
	var out []models.SoundEvent
	for rows.Next() {
		var se models.SoundEvent
		if err := rows.Scan(&se.Tick, &se.Round, &se.SteamID, &se.Kind, &se.Material, &se.TeamPrefix, &se.SOSName); err != nil {
			return nil, fmt.Errorf("store: get sound events: %w", err)
		}
		se.MatchID = matchID
		out = append(out, se)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: get sound events: %w", err)
	}
	return out, nil
}

// GetSoundEventPresence returns the match's sound-event counts by kind —
// the presence signal the UI reads to know a match HAS footstep data at
// all (Total = every row; ByKind = the step/land/jump/fall split, kinds
// with no rows ABSENT from the map rather than a fabricated 0).
//
// Optional-read contract (the same rule as store.GetBlindFlashDurations /
// GetDropDetails): a match with no sound rows — or an unknown match —
// yields a zero presence with no error; only a real query failure errors.
// A second query therefore never runs: absence of rows IS the answer.
func (s *Store) GetSoundEventPresence(matchID int64) (models.SoundEventPresence, error) {
	pres := models.SoundEventPresence{
		MatchID: matchID,
		ByKind:  map[string]int{},
	}
	rows, err := s.db.Query(
		`SELECT kind, COUNT(*) FROM sound_events WHERE match_id = ? GROUP BY kind`,
		matchID,
	)
	if err != nil {
		return models.SoundEventPresence{}, fmt.Errorf("store: sound event presence: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var kind string
		var n int
		if err := rows.Scan(&kind, &n); err != nil {
			return models.SoundEventPresence{}, fmt.Errorf("store: sound event presence: %w", err)
		}
		pres.ByKind[kind] = n
		pres.Total += n
	}
	if err := rows.Err(); err != nil {
		return models.SoundEventPresence{}, fmt.Errorf("store: sound event presence: %w", err)
	}
	return pres, nil
}
