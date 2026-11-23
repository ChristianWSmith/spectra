package store

import (
	"database/sql"
	"fmt"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// SaveEncounterWindows replaces a match's encounter windows, their samples and
// their encounters in one transaction. Derived data: a re-run replaces it all.
func (s *Store) SaveEncounterWindows(matchID int64, wins []models.EncounterWindow) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("saving encounters: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	for _, t := range []string{"encounter_window_samples", "encounters", "encounter_windows"} {
		if _, err := tx.Exec(`DELETE FROM `+t+` WHERE match_id = ?`, matchID); err != nil {
			return fmt.Errorf("saving encounters: %w", err)
		}
	}
	winStmt, err := tx.Prepare(`INSERT INTO encounter_windows (match_id, round, p1, p2, start_tick, end_tick)
		VALUES (?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return fmt.Errorf("saving encounters: %w", err)
	}
	defer winStmt.Close()
	smpStmt, err := tx.Prepare(`INSERT INTO encounter_window_samples (window_id, match_id, tick,
		p1_eye_x, p1_eye_y, p1_eye_z, p1_world_x, p1_world_y, p1_world_z,
		p2_eye_x, p2_eye_y, p2_eye_z, p2_world_x, p2_world_y, p2_world_z,
		p1_in_air, p1_speed, p1_weapon, p2_in_air, p2_speed, p2_weapon)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return fmt.Errorf("saving encounters: %w", err)
	}
	defer smpStmt.Close()
	encStmt, err := tx.Prepare(`INSERT INTO encounters (match_id, window_id, round, shooter, enemy, start_tick, end_tick, seed_tick)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return fmt.Errorf("saving encounters: %w", err)
	}
	defer encStmt.Close()
	for _, w := range wins {
		res, err := winStmt.Exec(matchID, w.Round, w.P1, w.P2, w.StartTick, w.EndTick)
		if err != nil {
			return fmt.Errorf("saving encounters: %w", err)
		}
		wid, err := res.LastInsertId()
		if err != nil {
			return fmt.Errorf("saving encounters: %w", err)
		}
		for _, sm := range w.Samples {
			if _, err := smpStmt.Exec(wid, matchID, sm.Tick,
				sm.P1Eye[0], sm.P1Eye[1], sm.P1Eye[2], sm.P1World[0], sm.P1World[1], sm.P1World[2],
				sm.P2Eye[0], sm.P2Eye[1], sm.P2Eye[2], sm.P2World[0], sm.P2World[1], sm.P2World[2],
				b2i(sm.P1Air), nullSpeed(sm.P1Speed), nullWeapon(sm.P1Weapon),
				b2i(sm.P2Air), nullSpeed(sm.P2Speed), nullWeapon(sm.P2Weapon)); err != nil {
				return fmt.Errorf("saving encounter samples: %w", err)
			}
		}
		for _, e := range w.Encounters {
			if _, err := encStmt.Exec(matchID, wid, w.Round, e.Shooter, e.Enemy, e.StartTick, e.EndTick, e.SeedTick); err != nil {
				return fmt.Errorf("saving encounters: %w", err)
			}
		}
	}
	return tx.Commit()
}

// GetEncounterWindows returns a match's windows with their samples and encounters,
// in start-tick order.
func (s *Store) GetEncounterWindows(matchID int64) ([]models.EncounterWindow, error) {
	rows, err := s.db.Query(`SELECT id, round, p1, p2, start_tick, end_tick FROM encounter_windows
		WHERE match_id = ? ORDER BY start_tick, id`, matchID)
	if err != nil {
		return nil, fmt.Errorf("reading encounter windows: %w", err)
	}
	type head struct {
		id int64
		w  models.EncounterWindow
	}
	var heads []head
	for rows.Next() {
		var h head
		if err := rows.Scan(&h.id, &h.w.Round, &h.w.P1, &h.w.P2, &h.w.StartTick, &h.w.EndTick); err != nil {
			rows.Close()
			return nil, err
		}
		heads = append(heads, h)
	}
	rows.Close()
	out := make([]models.EncounterWindow, 0, len(heads))
	for _, h := range heads {
		smp, err := s.db.Query(`SELECT tick, p1_eye_x, p1_eye_y, p1_eye_z, p1_world_x, p1_world_y, p1_world_z,
			p2_eye_x, p2_eye_y, p2_eye_z, p2_world_x, p2_world_y, p2_world_z,
			p1_in_air, p1_speed, p1_weapon, p2_in_air, p2_speed, p2_weapon
			FROM encounter_window_samples WHERE window_id = ? ORDER BY tick`, h.id)
		if err != nil {
			return nil, fmt.Errorf("reading window samples: %w", err)
		}
		for smp.Next() {
			var sm models.WindowSample
			var p1Air, p2Air int
			var p1Speed, p2Speed sql.NullFloat64
			var p1Weapon, p2Weapon sql.NullString
			if err := smp.Scan(&sm.Tick, &sm.P1Eye[0], &sm.P1Eye[1], &sm.P1Eye[2], &sm.P1World[0], &sm.P1World[1], &sm.P1World[2],
				&sm.P2Eye[0], &sm.P2Eye[1], &sm.P2Eye[2], &sm.P2World[0], &sm.P2World[1], &sm.P2World[2],
				&p1Air, &p1Speed, &p1Weapon, &p2Air, &p2Speed, &p2Weapon); err != nil {
				smp.Close()
				return nil, err
			}
			sm.P1Air, sm.P2Air = p1Air != 0, p2Air != 0
			if p1Speed.Valid {
				v := p1Speed.Float64
				sm.P1Speed = &v
			}
			if p2Speed.Valid {
				v := p2Speed.Float64
				sm.P2Speed = &v
			}
			sm.P1Weapon, sm.P2Weapon = p1Weapon.String, p2Weapon.String
			h.w.Samples = append(h.w.Samples, sm)
		}
		smp.Close()
		enc, err := s.db.Query(`SELECT shooter, enemy, start_tick, end_tick, seed_tick FROM encounters
			WHERE window_id = ? ORDER BY start_tick, id`, h.id)
		if err != nil {
			return nil, fmt.Errorf("reading encounters: %w", err)
		}
		for enc.Next() {
			var e models.Encounter
			if err := enc.Scan(&e.Shooter, &e.Enemy, &e.StartTick, &e.EndTick, &e.SeedTick); err != nil {
				enc.Close()
				return nil, err
			}
			h.w.Encounters = append(h.w.Encounters, e)
		}
		enc.Close()
		out = append(out, h.w)
	}
	return out, nil
}

// EncounterInputs returns a match's shots (weapon fire with a shooter, in a
// counted round) and its counted rounds' tick spans: what the encounter build
// reads besides the sidecar.
func (s *Store) EncounterInputs(matchID int64) ([]models.EncounterShot, []models.RoundSpan, error) {
	rr, err := s.db.Query(`SELECT number, start_tick, end_tick FROM rounds WHERE match_id = ? ORDER BY number`, matchID)
	if err != nil {
		return nil, nil, fmt.Errorf("reading rounds: %w", err)
	}
	var rounds []models.RoundSpan
	for rr.Next() {
		var r models.RoundSpan
		if err := rr.Scan(&r.Number, &r.Start, &r.End); err != nil {
			rr.Close()
			return nil, nil, err
		}
		rounds = append(rounds, r)
	}
	rr.Close()
	sr, err := s.db.Query(`SELECT round, tick, attacker FROM events
		WHERE match_id = ? AND kind = 'weapon_fire' AND round > 0 AND attacker <> '' ORDER BY tick`, matchID)
	if err != nil {
		return nil, nil, fmt.Errorf("reading shots: %w", err)
	}
	var shots []models.EncounterShot
	for sr.Next() {
		var sh models.EncounterShot
		if err := sr.Scan(&sh.Round, &sh.Tick, &sh.Shooter); err != nil {
			sr.Close()
			return nil, nil, err
		}
		shots = append(shots, sh)
	}
	sr.Close()
	return shots, rounds, nil
}

// nullSpeed and nullWeapon store the not-sampled cases as NULL: a speed that
// could not be derived, and a weapon that was not sampled ("").
func nullSpeed(v *float64) any {
	if v == nil {
		return nil
	}
	return *v
}

func nullWeapon(w string) any {
	if w == "" {
		return nil
	}
	return w
}
