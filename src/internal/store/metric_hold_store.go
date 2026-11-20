package store

// The user-cancel hold (metrics.held, schema.sql): a metric whose stored
// run the user cancelled is held. Background sweeps leave it, and every
// metric downstream of it, alone until the metric is saved again. The
// service owns the triggers (MetricsService.runSweep sets the hold,
// SaveMetric clears it); this file is only the column's reader and
// writers. The hold is deliberately not part of models.MetricRow: it is
// compute state, not definition, and no definition read or write touches
// it.

// HoldMetric marks one metric held (its stored run was cancelled by the
// user). Unknown ids are a no-op.
func (s *Store) HoldMetric(id int64) error {
	_, err := s.db.Exec(`UPDATE metrics SET held = 1 WHERE id = ?`, id)
	return err
}

// ReleaseMetricHold clears one metric's hold and reports whether it was
// held. Unknown or unheld ids return false.
func (s *Store) ReleaseMetricHold(id int64) (bool, error) {
	res, err := s.db.Exec(`UPDATE metrics SET held = 0 WHERE id = ? AND held = 1`, id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// HeldMetricIDs returns every held metric's id.
func (s *Store) HeldMetricIDs() (map[int64]bool, error) {
	rows, err := s.db.Query(`SELECT id FROM metrics WHERE held = 1`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]bool{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}
