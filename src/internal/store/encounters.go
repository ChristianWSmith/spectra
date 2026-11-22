package store

import (
	"fmt"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// SaveEncounters replaces a match's encounters and their samples in one
// transaction. Encounters are derived data: a re-run replaces them entirely.
func (s *Store) SaveEncounters(matchID int64, rows []models.EncounterRow) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("saving encounters: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`DELETE FROM encounter_samples WHERE match_id = ?`, matchID); err != nil {
		return fmt.Errorf("saving encounters: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM encounters WHERE match_id = ?`, matchID); err != nil {
		return fmt.Errorf("saving encounters: %w", err)
	}
	encStmt, err := tx.Prepare(`INSERT INTO encounters (match_id, round, shooter, enemy, start_tick, end_tick, seed_tick)
		VALUES (?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return fmt.Errorf("saving encounters: %w", err)
	}
	defer encStmt.Close()
	smpStmt, err := tx.Prepare(`INSERT INTO encounter_samples (encounter_id, match_id, tick,
		shooter_eye_x, shooter_eye_y, shooter_eye_z, enemy_eye_x, enemy_eye_y, enemy_eye_z,
		enemy_world_x, enemy_world_y, enemy_world_z) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return fmt.Errorf("saving encounters: %w", err)
	}
	defer smpStmt.Close()
	for _, r := range rows {
		res, err := encStmt.Exec(matchID, r.Round, r.Shooter, r.Enemy, r.StartTick, r.EndTick, r.SeedTick)
		if err != nil {
			return fmt.Errorf("saving encounters: %w", err)
		}
		id, err := res.LastInsertId()
		if err != nil {
			return fmt.Errorf("saving encounters: %w", err)
		}
		for _, sm := range r.Samples {
			if _, err := smpStmt.Exec(id, matchID, sm.Tick,
				sm.ShooterEye[0], sm.ShooterEye[1], sm.ShooterEye[2],
				sm.EnemyEye[0], sm.EnemyEye[1], sm.EnemyEye[2],
				sm.EnemyWorld[0], sm.EnemyWorld[1], sm.EnemyWorld[2]); err != nil {
				return fmt.Errorf("saving encounter samples: %w", err)
			}
		}
	}
	return tx.Commit()
}

// GetEncounters returns a match's encounters with their samples, in
// start-tick order.
func (s *Store) GetEncounters(matchID int64) ([]models.EncounterRow, error) {
	rows, err := s.db.Query(`SELECT id, round, shooter, enemy, start_tick, end_tick, seed_tick
		FROM encounters WHERE match_id = ? ORDER BY start_tick, id`, matchID)
	if err != nil {
		return nil, fmt.Errorf("reading encounters: %w", err)
	}
	type head struct {
		id  int64
		row models.EncounterRow
	}
	var heads []head
	for rows.Next() {
		var h head
		if err := rows.Scan(&h.id, &h.row.Round, &h.row.Shooter, &h.row.Enemy, &h.row.StartTick, &h.row.EndTick, &h.row.SeedTick); err != nil {
			rows.Close()
			return nil, err
		}
		heads = append(heads, h)
	}
	rows.Close()
	out := make([]models.EncounterRow, 0, len(heads))
	for _, h := range heads {
		smp, err := s.db.Query(`SELECT tick, shooter_eye_x, shooter_eye_y, shooter_eye_z,
			enemy_eye_x, enemy_eye_y, enemy_eye_z, enemy_world_x, enemy_world_y, enemy_world_z
			FROM encounter_samples WHERE encounter_id = ? ORDER BY tick`, h.id)
		if err != nil {
			return nil, fmt.Errorf("reading encounter samples: %w", err)
		}
		for smp.Next() {
			var sm models.EncounterSample
			if err := smp.Scan(&sm.Tick, &sm.ShooterEye[0], &sm.ShooterEye[1], &sm.ShooterEye[2],
				&sm.EnemyEye[0], &sm.EnemyEye[1], &sm.EnemyEye[2],
				&sm.EnemyWorld[0], &sm.EnemyWorld[1], &sm.EnemyWorld[2]); err != nil {
				smp.Close()
				return nil, err
			}
			h.row.Samples = append(h.row.Samples, sm)
		}
		smp.Close()
		out = append(out, h.row)
	}
	return out, nil
}
