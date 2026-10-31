package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// This file is the M5 §2.1 persistence surface: CRUD over the `metrics`
// table created by migrations/005_metrics.sql (column list fixed by the
// coordination contract in platform_store.go). The write handle owns all
// of it — the read-only console session never reaches these methods.

// metricColumns is the full metrics column list in scan order.
const metricColumns = `id, name, title, expr, group_by, format, doc, origin,
	plugin_id, denominator, created_at`

// scanMetric reads one metrics row (created_at is nullable → zero time on
// NULL, which the coordination-contract DDL allows).
func scanMetric(row interface{ Scan(...any) error }) (models.MetricRow, error) {
	var (
		m         models.MetricRow
		createdAt sql.NullTime
	)
	err := row.Scan(
		&m.ID, &m.Name, &m.Title, &m.Expr, &m.GroupBy, &m.Format, &m.Doc,
		&m.Origin, &m.PluginID, &m.Denominator, &createdAt,
	)
	if err != nil {
		return models.MetricRow{}, err
	}
	if createdAt.Valid {
		m.CreatedAt = createdAt.Time
	}
	return m, nil
}

// ListMetrics returns every definition, builtin first, then user, then
// plugin (name ASC within each origin).
func (s *Store) ListMetrics() ([]models.MetricRow, error) {
	rows, err := s.db.Query(
		`SELECT ` + metricColumns + ` FROM metrics
		 ORDER BY CASE origin WHEN 'builtin' THEN 0 WHEN 'user' THEN 1 ELSE 2 END,
			name ASC`,
	)
	if err != nil {
		return nil, fmt.Errorf("store: list metrics: %w", err)
	}
	defer rows.Close()
	var out []models.MetricRow
	for rows.Next() {
		m, err := scanMetric(rows)
		if err != nil {
			return nil, fmt.Errorf("store: list metrics: %w", err)
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list metrics: %w", err)
	}
	return out, nil
}

// GetMetric returns one definition by id (ErrNotFound when absent).
func (s *Store) GetMetric(id int64) (models.MetricRow, error) {
	m, err := scanMetric(s.db.QueryRow(`SELECT `+metricColumns+` FROM metrics WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return models.MetricRow{}, ErrNotFound
	}
	if err != nil {
		return models.MetricRow{}, fmt.Errorf("store: get metric: %w", err)
	}
	return m, nil
}

// CreateMetric inserts a definition and returns the stored row. A name
// already used by ANY origin (including builtins) yields a user-facing
// uniqueness error — API saves can never shadow a builtin.
func (s *Store) CreateMetric(m models.MetricRow) (models.MetricRow, error) {
	res, err := s.db.Exec(
		`INSERT INTO metrics (name, title, expr, group_by, format, doc, origin, plugin_id, denominator, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		scrub(m.Name), scrub(m.Title), scrub(m.Expr), scrub(m.GroupBy),
		scrub(m.Format), scrub(m.Doc), scrub(m.Origin), scrub(m.PluginID),
		scrub(m.Denominator), time.Now(),
	)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return models.MetricRow{}, fmt.Errorf("store: a metric named %q already exists", scrub(m.Name))
		}
		return models.MetricRow{}, fmt.Errorf("store: create metric: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return models.MetricRow{}, fmt.Errorf("store: create metric: %w", err)
	}
	return s.GetMetric(id)
}

// UpdateMetric replaces one definition (id must exist). Builtin and plugin
// rows are immutable through this path — the plugin loader writes its own
// rows via ReplacePluginMetrics, and builtins are migration-owned.
func (s *Store) UpdateMetric(m models.MetricRow) (models.MetricRow, error) {
	existing, err := s.GetMetric(m.ID)
	if err != nil {
		return models.MetricRow{}, err
	}
	if existing.Origin != "user" {
		return models.MetricRow{}, fmt.Errorf("store: metric %q is origin %s and cannot be modified", existing.Name, existing.Origin)
	}
	if _, err := s.db.Exec(
		`UPDATE metrics SET name = ?, title = ?, expr = ?, group_by = ?, format = ?,
			doc = ?, plugin_id = ?, denominator = ? WHERE id = ?`,
		scrub(m.Name), scrub(m.Title), scrub(m.Expr), scrub(m.GroupBy),
		scrub(m.Format), scrub(m.Doc), scrub(m.PluginID), scrub(m.Denominator), m.ID,
	); err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return models.MetricRow{}, fmt.Errorf("store: a metric named %q already exists", scrub(m.Name))
		}
		return models.MetricRow{}, fmt.Errorf("store: update metric: %w", err)
	}
	return s.GetMetric(m.ID)
}

// DeleteMetric removes one definition; builtins are protected (contract:
// "builtin protected"), unknown ids yield ErrNotFound. Plugin rows are
// removable by the API — the plugin host re-seeds them on enable.
func (s *Store) DeleteMetric(id int64) error {
	existing, err := s.GetMetric(id)
	if err != nil {
		return err
	}
	if existing.Origin == "builtin" {
		return fmt.Errorf("store: builtin metric %q cannot be deleted", existing.Name)
	}
	res, err := s.db.Exec(`DELETE FROM metrics WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("store: delete metric: %w", err)
	}
	return affectedOrNotFound(res, "store: delete metric")
}
