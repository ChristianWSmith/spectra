package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// SetMetricEnabled turns one metric on or off. Disabling is a soft delete: the row, its stored
// values and its edges stay, and the sweep and the coverage read never compute a disabled metric.
// A metric can be disabled only where a delete would be allowed, with one difference: a disabled
// metric that reads it does not block, since it is not computed either. Components always block.
// It can be enabled only when every metric it reads is enabled. A refusal writes nothing.
func (s *Store) SetMetricEnabled(id int64, enabled bool) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("couldn't change the metric: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var name string
	var cur int
	if err := tx.QueryRow(`SELECT name, enabled FROM metrics WHERE id = ?`, id).Scan(&name, &cur); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("couldn't change the metric: %w", err)
	}
	if (cur != 0) == enabled {
		return nil
	}
	if enabled {
		blockers, err := namesOf(tx,
			`SELECT d.dep_name FROM metric_deps d
				WHERE d.metric_id = ? AND EXISTS (SELECT 1 FROM metrics x WHERE x.name = d.dep_name AND x.enabled = 0)
				ORDER BY d.dep_name`, id)
		if err != nil {
			return err
		}
		if len(blockers) > 0 {
			return fmt.Errorf("can't enable %q: it reads the disabled metric %s — enable that first", name, strings.Join(blockers, ", "))
		}
	} else {
		readers, err := namesOf(tx,
			`SELECT m.name FROM metric_deps d JOIN metrics m ON m.id = d.metric_id
				WHERE d.dep_name = ? AND m.enabled = 1 ORDER BY m.name`, name)
		if err != nil {
			return err
		}
		if len(readers) > 0 {
			return fmt.Errorf("can't disable %q: %s read it — edit or disable those first", name, strings.Join(readers, ", "))
		}
		comps, err := referrersOf(tx, "metric", name, "")
		if err != nil {
			return err
		}
		if len(comps) > 0 {
			return fmt.Errorf("can't disable %q: the components %s use it", name, strings.Join(comps, ", "))
		}
	}
	on := 0
	if enabled {
		on = 1
	}
	if _, err := tx.Exec(`UPDATE metrics SET enabled = ? WHERE id = ?`, on, id); err != nil {
		return fmt.Errorf("couldn't change the metric: %w", err)
	}
	return tx.Commit()
}

// namesOf runs a one-column text query and returns its values in row order.
func namesOf(tx *sql.Tx, q string, args ...any) ([]string, error) {
	rows, err := tx.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("couldn't check the metric: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, fmt.Errorf("couldn't check the metric: %w", err)
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// MetricToggleBlock says why one metric's switch cannot move. DisableBlock names what keeps an
// enabled metric on (an enabled reader or a component); EnableBlock names the disabled metrics a
// disabled one reads. Both are the rules SetMetricEnabled enforces, read for the whole library.
type MetricToggleBlock struct {
	DisableBlock string
	EnableBlock  string
}

// MetricToggleBlocks returns the toggle block of every metric whose switch cannot move, keyed by
// metric id. A metric not in the map can be switched.
func (s *Store) MetricToggleBlocks() (map[int64]MetricToggleBlock, error) {
	type pair struct {
		id   int64
		name string
	}
	read := func(q string) ([]pair, error) {
		rows, err := s.db.Query(q)
		if err != nil {
			return nil, fmt.Errorf("couldn't read the metric switches: %w", err)
		}
		defer func() { _ = rows.Close() }()
		var out []pair
		for rows.Next() {
			var p pair
			if err := rows.Scan(&p.id, &p.name); err != nil {
				return nil, fmt.Errorf("couldn't read the metric switches: %w", err)
			}
			out = append(out, p)
		}
		return out, rows.Err()
	}
	disable := map[int64][]string{}
	readers, err := read(`SELECT t.id, r.name FROM metric_deps d
		JOIN metrics r ON r.id = d.metric_id AND r.enabled = 1
		JOIN metrics t ON t.name = d.dep_name
		ORDER BY r.name`)
	if err != nil {
		return nil, err
	}
	for _, p := range readers {
		disable[p.id] = append(disable[p.id], p.name)
	}
	comps, err := read(`SELECT t.id, c.referrer FROM component_refs c
		JOIN metrics t ON t.name = c.target
		WHERE c.kind = 'metric' ORDER BY c.referrer`)
	if err != nil {
		return nil, err
	}
	for _, p := range comps {
		disable[p.id] = append(disable[p.id], "component "+p.name)
	}
	enable := map[int64][]string{}
	missing, err := read(`SELECT r.id, d.dep_name FROM metric_deps d
		JOIN metrics r ON r.id = d.metric_id AND r.enabled = 0
		JOIN metrics x ON x.name = d.dep_name AND x.enabled = 0
		ORDER BY d.dep_name`)
	if err != nil {
		return nil, err
	}
	for _, p := range missing {
		enable[p.id] = append(enable[p.id], p.name)
	}
	out := map[int64]MetricToggleBlock{}
	for id, by := range disable {
		b := out[id]
		b.DisableBlock = "read by " + strings.Join(by, ", ")
		out[id] = b
	}
	for id, names := range enable {
		b := out[id]
		b.EnableBlock = "reads disabled metric " + strings.Join(names, ", ")
		out[id] = b
	}
	return out, nil
}
