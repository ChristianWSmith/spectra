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
// table created by the baseline schema (schema.sql — column list fixed by
// the coordination contract in platform_store.go). The write handle owns
// all of it — the read-only console session never reaches these methods.

// metricColumns is the full metrics column list in scan order: the DDL's
// 13 columns in schema order, pinned by metricColumnsContract.
const metricColumns = `id, name, title, short_name, expr, scope, format, doc, origin,
	plugin_id, denominator, version, created_at`

// scanMetric reads one metrics row (created_at is nullable → zero time on
// NULL, which the coordination-contract DDL allows).
func scanMetric(row interface{ Scan(...any) error }) (models.MetricRow, error) {
	var (
		m         models.MetricRow
		createdAt sql.NullTime
	)
	err := row.Scan(
		&m.ID, &m.Name, &m.Title, &m.ShortName, &m.Expr, &m.Scope, &m.Format, &m.Doc,
		&m.Origin, &m.PluginID, &m.Denominator, &m.Version, &createdAt,
	)
	if err != nil {
		return models.MetricRow{}, err
	}
	m.CreatedAt = nullTime(createdAt)
	return m, nil
}

// metricOriginRank is the canonical origin ordering expression: builtin
// → user → plugin. It is THE order every metric list sorts by, shared by
// ListMetrics' reference order and ListMetricsPage's windowed walk so the
// two can never drift, and it is the first half of the paged read's
// keyset key.
const metricOriginRank = `CASE origin WHEN 'builtin' THEN 0 WHEN 'user' THEN 1 ELSE 2 END`

// metricOrder is the canonical ORDER BY body (origin rank, then name
// ASC). metrics.name is UNIQUE across every origin (schema.sql), so
// (rank, name) is a unique, stable key for the whole list.
const metricOrder = metricOriginRank + `, name ASC`

// ListMetrics returns every definition, builtin first, then user, then
// plugin (name ASC within each origin).
func (s *Store) ListMetrics() ([]models.MetricRow, error) {
	rows, err := s.db.Query(
		`SELECT ` + metricColumns + ` FROM metrics ORDER BY ` + metricOrder,
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

// Metric-list window bounds (ListMetricsPage's rows per window).
const (
	// ListMetricsPageSize is the default window (the Builder's first
	// window and every "Load more" click fetches one of these). It is
	// deliberately smaller than the library list's 200: the left rail is
	// narrow, rows are two lines tall, and a realistic catalog (the
	// seeded builtin + user + plugin definitions) fits one window — so
	// the window bound only matters for a pathological catalog, where it
	// still keeps the scan and the IPC payload bounded.
	ListMetricsPageSize = 100
	// ListMetricsPageMaxRows is the largest window any caller may ask
	// for — the row scan stays bounded either way.
	ListMetricsPageMaxRows = 500
)

// ListMetricsPage returns ONE keyset window of the metric-definition
// list ListMetrics returns: the rows strictly after the cursor row
// (afterID — 0 starts the first window) in ListMetrics' exact order,
// limited to limit rows (<= 0 means ListMetricsPageSize, clamped to
// ListMetricsPageMaxRows). HasNext reports whether another window exists
// beyond the returned rows (the query reads limit+1 rows — a window of
// exactly limit rows with no successor reports false).
//
// SEARCH: query narrows the window SERVER-side with a case-insensitive
// LIKE over name and title — the store.ListPlayers search spelling
// (scrubbed, %-wrapped; SQLite's LIKE is ASCII case-insensitive by
// default). It rides the SAME WHERE as the cursor predicate, so a
// filtered walk tiles the filtered list exactly.
//
// ORIGIN FILTER: originFilter narrows the window SERVER-side to one side
// of the built-in partition — "builtin" (origin = 'builtin'), "mine"
// (every OTHER origin: user + plugin — spelled as the complement
// `origin <> 'builtin'`, so the two Builder toggles can never disagree
// with the store about what "mine" means, and a future origin value
// lands on the mine side by default), "none" (both toggles off — the
// empty set, still one read path), "" (no predicate — the whole
// catalog). It rides the SAME WHERE as the search and the cursor, so the
// composed walk tiles the composed list exactly; a client-side filter
// over a page window would drop rows at the window edges. An unknown
// value is rejected before any SQL.
//
// CURSOR: the caller passes the last window's row id, and the store
// resolves it to that row's stored (origin rank, name) — the same
// in-store resolution ListMatchesPage does (one driver path, and a
// cursor row that vanished between two windows is ErrNotFound instead of
// a silently mis-placed page). The cursor row may sit OUTSIDE the
// origin-filtered set (a builtin cursor on a "mine" walk): it still
// resolves, because the predicate is the row's stored key, not membership.
//
// KEYSET PREDICATE: `(rank, name) > (?, ?)` — SQLite's row-value
// comparison is lexicographic over the pair, which is exactly what
// `ORDER BY rank, name ASC` needs, and it keeps the CASE expression
// spelled once instead of the three-fold composite expansion. The
// composite key is unique (metrics.name is UNIQUE across origins), so
// no id tie-break is needed: windows can neither skip nor duplicate a
// row, and each origin stays contiguous across window boundaries — the
// view renders its Builtins/Yours/Plugins headers from those runs.
func (s *Store) ListMetricsPage(query string, originFilter string, afterID int64, limit int) (*models.MetricListPage, error) {
	if limit <= 0 {
		limit = ListMetricsPageSize
	}
	if limit > ListMetricsPageMaxRows {
		limit = ListMetricsPageMaxRows
	}
	var (
		where strings.Builder
		args  []any
	)
	// addWhere appends ONE ANDed predicate to the shared WHERE — every
	// narrowing (origin filter, search, cursor) rides the same clause,
	// so they compose in any order and none can silently bypass another.
	addWhere := func(pred string, a ...any) {
		if where.Len() == 0 {
			where.WriteString(" WHERE ")
		} else {
			where.WriteString(" AND ")
		}
		where.WriteString(pred)
		args = append(args, a...)
	}
	// The origin partition goes first (the coarsest narrowing). "none"
	// is a constant-false predicate rather than a view-side short-circuit
	// so both-off keeps the ONE read path (same cache key shape, same
	// cursor semantics as every other window).
	switch originFilter {
	case "": // no predicate — the whole catalog
	case "builtin":
		addWhere(`origin = 'builtin'`)
	case "mine":
		addWhere(`origin <> 'builtin'`)
	case "none":
		addWhere(`0 = 1`)
	default:
		return nil, fmt.Errorf("store: list metrics page: unknown origin filter %q", originFilter)
	}
	if qq := scrub(query); qq != "" {
		addWhere(`(name LIKE ? OR title LIKE ?)`, "%"+qq+"%", "%"+qq+"%")
	}
	if afterID > 0 {
		after, a, err := s.metricKeysetAfter(afterID)
		if err != nil {
			return nil, err
		}
		addWhere("("+after+")", a...)
	}
	// limit+1: the extra row is the "there is more" probe, never returned.
	var b strings.Builder
	b.WriteString(`SELECT ` + metricColumns + ` FROM metrics`)
	b.WriteString(where.String())
	fmt.Fprintf(&b, " ORDER BY %s LIMIT %d", metricOrder, limit+1)

	rows, err := s.db.Query(b.String(), args...)
	if err != nil {
		return nil, fmt.Errorf("store: list metrics page: %w", err)
	}
	defer rows.Close()
	page := &models.MetricListPage{Rows: []models.MetricRow{}}
	for rows.Next() {
		m, err := scanMetric(rows)
		if err != nil {
			return nil, fmt.Errorf("store: list metrics page: %w", err)
		}
		page.Rows = append(page.Rows, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list metrics page: %w", err)
	}
	if len(page.Rows) > limit {
		page.Rows = page.Rows[:limit]
		page.HasNext = true
	}
	return page, nil
}

// metricKeysetAfter resolves the cursor row (afterID) to its stored
// (origin rank, name) and renders the "strictly after" row-value
// predicate with its bound arguments (see ListMetricsPage). ErrNotFound
// when the cursor row no longer exists.
func (s *Store) metricKeysetAfter(afterID int64) (string, []any, error) {
	var (
		rank int
		name string
	)
	err := s.db.QueryRow(
		`SELECT `+metricOriginRank+`, name FROM metrics WHERE id = ?`, afterID,
	).Scan(&rank, &name)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil, fmt.Errorf("store: list metrics page: cursor metric %d: %w", afterID, ErrNotFound)
	}
	if err != nil {
		return "", nil, fmt.Errorf("store: list metrics page: cursor metric %d: %w", afterID, err)
	}
	return `(` + metricOriginRank + `, name) > (?, ?)`, []any{rank, name}, nil
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
// uniqueness error — API saves can never shadow a builtin. scope is
// written from the row; version is NOT in the INSERT (column DEFAULT 1 —
// the counter starts at 1 and only the semantic-edit bump moves it).
func (s *Store) CreateMetric(m models.MetricRow) (models.MetricRow, error) {
	// A zero scope is an OMITTED field (pre-W2 callers never send one):
	// write the DDL DEFAULT's value — the CHECK rejects '' — so an
	// omitted scope behaves exactly like the column DEFAULT 'match'.
	if m.Scope == "" {
		m.Scope = "match"
	}
	res, err := s.db.Exec(
		`INSERT INTO metrics (name, title, short_name, expr, scope, format, doc, origin, plugin_id, denominator, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		scrub(m.Name), scrub(m.Title), scrub(m.ShortName), scrub(m.Expr), scrub(m.Scope),
		scrub(m.Format), scrub(m.Doc), scrub(m.Origin), scrub(m.PluginID),
		scrub(m.Denominator), time.Now(),
	)
	if err != nil {
		if isUniqueErr(err) {
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
// rows via ReplacePluginMetrics, and builtins are schema-seeded. scope is
// written from the row; version is deliberately NOT touched here — the
// +1 bump on semantic edits (expr/scope/denominator, with the
// transitive-dependent cascade) lives with the SaveMetric save
// transaction in a later wave (stored-metrics design §2); until then this
// stays a pure overwrite (no-history model — no shadow rows, no
// versioned copies).
func (s *Store) UpdateMetric(m models.MetricRow) (models.MetricRow, error) {
	// Same omitted-scope rule as CreateMetric: '' → the DDL DEFAULT
	// 'match', never the empty string the CHECK rejects.
	if m.Scope == "" {
		m.Scope = "match"
	}
	existing, err := s.GetMetric(m.ID)
	if err != nil {
		return models.MetricRow{}, err
	}
	if existing.Origin != "user" {
		return models.MetricRow{}, fmt.Errorf("store: metric %q is origin %s and cannot be modified", existing.Name, existing.Origin)
	}
	if _, err := s.db.Exec(
		`UPDATE metrics SET name = ?, title = ?, short_name = ?, expr = ?, scope = ?, format = ?,
			doc = ?, plugin_id = ?, denominator = ? WHERE id = ?`,
		scrub(m.Name), scrub(m.Title), scrub(m.ShortName), scrub(m.Expr), scrub(m.Scope),
		scrub(m.Format), scrub(m.Doc), scrub(m.PluginID), scrub(m.Denominator), m.ID,
	); err != nil {
		if isUniqueErr(err) {
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
