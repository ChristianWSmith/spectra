package store

import (
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// This file is the M5 platform persistence surface: the declarative-plugin
// registry and the plugin-metric rows it mirrors into the `metrics` table
// (created by the baseline schema — G1).
//
// COORDINATION CONTRACT with the metrics engine (M5 §2.1): the metrics
// table this file writes against is exactly:
//
//	CREATE TABLE IF NOT EXISTS metrics (
//		id INTEGER PRIMARY KEY AUTOINCREMENT,
//		name TEXT UNIQUE NOT NULL,
//		title TEXT NOT NULL DEFAULT '',
//		short_name TEXT NOT NULL DEFAULT '',
//		expr TEXT NOT NULL,
//		group_by TEXT NOT NULL DEFAULT '',
//		format TEXT NOT NULL DEFAULT '',
//		doc TEXT NOT NULL DEFAULT '',
//		origin TEXT NOT NULL DEFAULT 'user',
//		plugin_id TEXT NOT NULL DEFAULT '',
//		denominator TEXT NOT NULL DEFAULT '',
//		created_at DATETIME
//	);
//
// ensureMetricsTable creates that table IF NOT EXISTS before any plugin
// metric write: a no-op once the baseline schema has created it, and a
// safety net if this code ever runs against a database that predates it.
// Full expression validation belongs to the metrics engine on preview/use
// (plugin metric budget) — the plugin loader only enforces
// structural sanity (name + expr non-empty).
//
// short_name (optional user-entered short label — the width-constrained
// column-header display criterion short_name || title || name) is NOT a
// plugin-metric field: ReplacePluginMetrics omits it from its INSERT, so
// plugin rows always carry the DEFAULT ''.

// PluginRow is one plugins-registry row (M5 §2.7).
type PluginRow struct {
	ID          string
	Name        string
	Version     string
	Path        string
	Hash        string
	Enabled     bool
	Error       string
	InstalledAt time.Time
}

// PluginMetricDef is one manifest metric ready to be written into the
// metrics table (origin forced to 'plugin' by the writer).
type PluginMetricDef struct {
	Name        string
	Title       string
	Expr        string
	GroupBy     string
	Format      string
	Doc         string
	Denominator string
}

// metricsTableDDL is the exact coordination contract (see file doc).
const metricsTableDDL = `CREATE TABLE IF NOT EXISTS metrics (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT UNIQUE NOT NULL,
	title TEXT NOT NULL DEFAULT '',
	short_name TEXT NOT NULL DEFAULT '',
	expr TEXT NOT NULL,
	group_by TEXT NOT NULL DEFAULT '',
	format TEXT NOT NULL DEFAULT '',
	doc TEXT NOT NULL DEFAULT '',
	origin TEXT NOT NULL DEFAULT 'user',
	plugin_id TEXT NOT NULL DEFAULT '',
	denominator TEXT NOT NULL DEFAULT '',
	created_at DATETIME
)`

// ensureMetricsTable creates the metrics table when missing (no-op when
// the baseline schema already created it).
func (s *Store) ensureMetricsTable() error {
	if _, err := s.db.Exec(metricsTableDDL); err != nil {
		return fmt.Errorf("store: ensure metrics table: %w", err)
	}
	return nil
}

// pluginCols is the plugins-registry row (G1): the ONE list — the upsert
// INSERT, GetPluginRow and ListPluginRows all use it verbatim.
const pluginCols = `id, name, version, path, hash, enabled, error, installed_at`

// UpsertPlugin inserts or replaces one plugins-registry row keyed by id.
// installed_at is refreshed on every upsert (reinstall time).
func (s *Store) UpsertPlugin(row PluginRow) error {
	_, err := s.db.Exec(
		`INSERT INTO plugins (`+pluginCols+`)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
			name = excluded.name, version = excluded.version, path = excluded.path,
			hash = excluded.hash, enabled = excluded.enabled, error = excluded.error,
			installed_at = excluded.installed_at`,
		scrub(row.ID), scrub(row.Name), scrub(row.Version), scrub(row.Path),
		scrub(row.Hash), b2i(row.Enabled), scrub(row.Error), time.Now(),
	)
	if err != nil {
		return fmt.Errorf("store: upsert plugin: %w", err)
	}
	return nil
}

// GetPluginRow returns one registry row (ErrNotFound when absent).
func (s *Store) GetPluginRow(id string) (PluginRow, error) {
	var (
		row       PluginRow
		enabled   int64
		installed time.Time
	)
	err := s.db.QueryRow(
		`SELECT `+pluginCols+`
		 FROM plugins WHERE id = ?`, scrub(id),
	).Scan(&row.ID, &row.Name, &row.Version, &row.Path, &row.Hash, &enabled, &row.Error, &installed)
	if errors.Is(err, sql.ErrNoRows) {
		return PluginRow{}, ErrNotFound
	}
	if err != nil {
		return PluginRow{}, fmt.Errorf("store: get plugin: %w", err)
	}
	row.Enabled = i2b(enabled)
	row.InstalledAt = installed
	return row, nil
}

// ListPluginRows returns every registry row, id ASC.
func (s *Store) ListPluginRows() ([]PluginRow, error) {
	rows, err := s.db.Query(
		`SELECT ` + pluginCols + `
		 FROM plugins ORDER BY id ASC`,
	)
	if err != nil {
		return nil, fmt.Errorf("store: list plugins: %w", err)
	}
	defer rows.Close()
	var out []PluginRow
	for rows.Next() {
		var (
			row       PluginRow
			enabled   int64
			installed time.Time
		)
		if err := rows.Scan(&row.ID, &row.Name, &row.Version, &row.Path, &row.Hash, &enabled, &row.Error, &installed); err != nil {
			return nil, fmt.Errorf("store: list plugins: %w", err)
		}
		row.Enabled = i2b(enabled)
		row.InstalledAt = installed
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list plugins: %w", err)
	}
	return out, nil
}

// SetPluginEnabledRow toggles one registry row (ErrNotFound when absent).
func (s *Store) SetPluginEnabledRow(id string, enabled bool) error {
	res, err := s.db.Exec(`UPDATE plugins SET enabled = ? WHERE id = ?`, b2i(enabled), scrub(id))
	if err != nil {
		return fmt.Errorf("store: set plugin enabled: %w", err)
	}
	return affectedOrNotFound(res, "store: set plugin enabled")
}

// DeletePluginRow removes one registry row (ErrNotFound when absent).
func (s *Store) DeletePluginRow(id string) error {
	res, err := s.db.Exec(`DELETE FROM plugins WHERE id = ?`, scrub(id))
	if err != nil {
		return fmt.Errorf("store: delete plugin: %w", err)
	}
	return affectedOrNotFound(res, "store: delete plugin")
}

// ReplacePluginMetrics swaps one plugin's metrics rows: deletes every row
// with plugin_id, then upserts defs keyed by name (origin='plugin').
// Pass nil/empty to just clear. Creates the metrics table when missing.
// The INSERT deliberately omits short_name (DEFAULT empty string) —
// plugin manifests carry no short label, so plugin metric rows never
// have one.
//
// Deliberately NOT replaceMatchRows: the delete keys on plugin_id (not
// match_id), the INSERT carries a literal 'plugin' for origin (9 of its 10
// placeholders) plus an ON CONFLICT upsert clause — neither fits the
// helper's `WHERE match_id = ?` + plain-VALUES body.
func (s *Store) ReplacePluginMetrics(pluginID string, defs []PluginMetricDef) error {
	if err := s.ensureMetricsTable(); err != nil {
		return err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("store: replace plugin metrics: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`DELETE FROM metrics WHERE plugin_id = ?`, scrub(pluginID)); err != nil {
		return fmt.Errorf("store: replace plugin metrics: %w", err)
	}
	stmt, err := tx.Prepare(
		`INSERT INTO metrics (name, title, expr, group_by, format, doc, origin, plugin_id, denominator, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, 'plugin', ?, ?, ?)
		 ON CONFLICT(name) DO UPDATE SET
			title = excluded.title, expr = excluded.expr, group_by = excluded.group_by,
			format = excluded.format, doc = excluded.doc, origin = excluded.origin,
			plugin_id = excluded.plugin_id, denominator = excluded.denominator`,
	)
	if err != nil {
		return fmt.Errorf("store: replace plugin metrics: %w", err)
	}
	defer stmt.Close()
	for _, d := range defs {
		if _, err := stmt.Exec(
			scrub(d.Name), scrub(d.Title), scrub(d.Expr), scrub(d.GroupBy),
			scrub(d.Format), scrub(d.Doc), scrub(pluginID), scrub(d.Denominator), time.Now(),
		); err != nil {
			return fmt.Errorf("store: replace plugin metrics: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: replace plugin metrics: %w", err)
	}
	return nil
}

// DeletePluginMetrics removes one plugin's metric rows (disable/remove).
func (s *Store) DeletePluginMetrics(pluginID string) error {
	_, err := s.db.Exec(`DELETE FROM metrics WHERE plugin_id = ?`, scrub(pluginID))
	if err != nil {
		return fmt.Errorf("store: delete plugin metrics: %w", err)
	}
	return nil
}

// CountPluginMetrics returns how many metrics rows one plugin currently
// owns (tests + plugin-list badge).
func (s *Store) CountPluginMetrics(pluginID string) (int, error) {
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM metrics WHERE plugin_id = ?`, scrub(pluginID)).Scan(&n); err != nil {
		return 0, fmt.Errorf("store: count plugin metrics: %w", err)
	}
	return n, nil
}
