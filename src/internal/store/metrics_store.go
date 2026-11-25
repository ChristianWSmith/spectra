package store

import (
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// This file is the M5 §2.1 persistence surface: CRUD over the `metrics`
// table created by the baseline schema (schema.sql — column list fixed by
// the coordination contract in platform_store.go). The write handle owns
// all of it — the read-only console session never reaches these methods.

// metricColumns is the stored metrics column list in scan order. There is
// no scope, subject or partition column (ruling 51): scope
// is derived from the expr's binds on scan (ScopeOfExpr).
const metricColumns = `id, name, title, short_name, expr, run_expr, format, doc, origin,
	plugin_id, touched, version, created_at, enabled`

// touchedColumn encodes a touched set for metrics.touched: the sorted table
// names, comma-joined (” = not derived). Table names never contain a comma.
func touchedColumn(tables []string) string {
	return strings.Join(tables, ",")
}

// parseTouched decodes metrics.touched; ” is nil (not derived).
func parseTouched(s string) []string {
	if s == "" {
		return nil
	}
	return strings.Split(s, ",")
}

// scanMetric reads one metrics row (created_at is nullable → zero time on
// NULL, which the coordination-contract DDL allows).
func scanMetric(row interface{ Scan(...any) error }) (models.MetricRow, error) {
	var (
		m         models.MetricRow
		createdAt sql.NullTime
		touched   string
		enabled   int
	)
	err := row.Scan(
		&m.ID, &m.Name, &m.Title, &m.ShortName, &m.Expr, &m.RunExpr,
		&m.Format, &m.Doc, &m.Origin, &m.PluginID, &touched, &m.Version, &createdAt, &enabled,
	)
	if err != nil {
		return models.MetricRow{}, err
	}
	m.Scope = ScopeOfExpr(m.RunExpr)
	m.Touched = parseTouched(touched)
	m.CreatedAt = nullTime(createdAt)
	m.Enabled = enabled != 0
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
		return nil, fmt.Errorf("couldn't load the metrics: %w", err)
	}
	defer rows.Close()
	var out []models.MetricRow
	for rows.Next() {
		m, err := scanMetric(rows)
		if err != nil {
			return nil, fmt.Errorf("couldn't load the metrics: %w", err)
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load the metrics: %w", err)
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

// metricOriginTokens is the CANONICAL metric-origin vocabulary in
// origin-rank order (the three values metricOriginRank sorts by) — the
// tokens ListMetricsPage's origin filter accepts: the Builder Origin
// group's three boxes (Built-in / Custom / Plugin — "builtin",
// "user" the user-authored origin behind the Custom box, "plugin" the
// installed-plugin origin). Like metricFormatTokens it is what makes a
// subset word canonical instead of merely valid; the empty checked set
// is the caller's separate "none" word (see the ORIGIN FILTER note
// below).
var metricOriginTokens = []string{"builtin", "user", "plugin"}

// originFilterPredicate renders ListMetricsPage's origin-subset
// predicate for a word that is neither "" (all-on) nor "none" (all-off,
// the caller's switch): one `origin IN (?, …)` — the canonical
// comma-subset, every token a literal column value (the format vocabulary
// binds its ” value as its own equality; origin has no such bucket). Every token must be known,
// DISTINCT and in metricOriginTokens order (a known-but-reordered word
// is a non-canonical word, and an empty segment is an unknown token),
// so anything else is the pre-SQL rejection `unknown origin filter %q`
// (the scope/format copy) and NO SQL ever runs.
func originFilterPredicate(word string) (string, []any, error) {
	var (
		literals []string
		lastRank = -1
	)
	for _, tok := range strings.Split(word, ",") {
		rank := slices.Index(metricOriginTokens, tok)
		if rank < 0 || rank <= lastRank { // unknown, duplicate or reordered
			return "", nil, fmt.Errorf("couldn't load the metrics: unknown origin filter %q", word)
		}
		lastRank = rank
		literals = append(literals, tok)
	}
	args := make([]any, 0, len(literals))
	for _, lit := range literals {
		args = append(args, lit)
	}
	return `origin IN (` + strings.TrimSuffix(strings.Repeat("?,", len(literals)), ",") + `)`, args, nil
}

// metricFormatTokens is the CANONICAL metric-format vocabulary in enum
// order — the tokens ListMetricsPage's format filter accepts, with
// "auto" naming the format column's ” value (the form's own Auto /
// Int / Float1 / Float2 / Percent / Currency — the editor's format
// select — plus "identity", the key-valued format (metrics expansion
// D2 — the M1 identity seeds), which the Builder's Type filter offers
// but the editor's Format select never does (the filter-only split
// lives in the frontend twin, lib/metricformats.js — metrics expansion
// Phase 7, 2026-11-18). It is the store-side twin of the service's
// metricFormats
// contract (metricservice.go — same vocabulary, one order): the filter
// word is a comma-subset of THESE tokens in THIS order, which is what
// makes the subset word canonical instead of merely valid.
var metricFormatTokens = []string{"auto", "int", "float1", "float2", "percent", "currency", "identity"}

// formatFilterPredicate renders ListMetricsPage's format-subset
// predicate for a word that is neither "" (all-on) nor "none" (all-off,
// the caller's switch): `(format = ? OR format IN (?, …))` — the
// canonical comma-subset with "auto" (the column's ” format) spelled
// as its own equality beside the literal tokens' single IN — plus its
// bound arguments. Every token must be known, DISTINCT and in
// metricFormatTokens order (a known-but-reordered word is a non-
// canonical word, and an empty segment is an unknown token), so
// anything else is the pre-SQL rejection `unknown format filter %q`
// (the origin/scope copy) and NO SQL ever runs.
func formatFilterPredicate(word string) (string, []any, error) {
	var (
		preds    []string
		args     []any
		literals []string
		lastRank = -1
	)
	for _, tok := range strings.Split(word, ",") {
		rank := slices.Index(metricFormatTokens, tok)
		if rank < 0 || rank <= lastRank { // unknown, duplicate or reordered
			return "", nil, fmt.Errorf("couldn't load the metrics: unknown format filter %q", word)
		}
		lastRank = rank
		if tok == "auto" {
			preds = append(preds, `format = ?`)
			args = append(args, "")
			continue
		}
		literals = append(literals, tok)
	}
	if len(literals) > 0 {
		preds = append(preds, `format IN (`+strings.TrimSuffix(strings.Repeat("?,", len(literals)), ",")+`)`)
		for _, lit := range literals {
			args = append(args, lit)
		}
	}
	return `(` + strings.Join(preds, " OR ") + `)`, args, nil
}

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
// ORIGIN FILTER: originFilter narrows the window SERVER-side to a
// SUBSET of the origin column — the Builder Origin group's three
// checkboxes (Built-in / Custom / Plugin). It is the same canonical
// comma-subset shape as FORMAT below, over
// metricOriginTokens (builtin, user, plugin — metricOriginRank's three
// values): "" = every box checked (no predicate — the whole catalog),
// "none" = no box checked (the empty set, the same spelling scope
// uses), and any other word is a CANONICAL COMMA-SUBSET
// ("builtin,plugin"): every token known, distinct and in
// metricOriginTokens order. An unknown token, an empty element, a
// duplicate or a reorder is rejected before any SQL. It rides the SAME
// WHERE as the search and the cursor, so the composed walk tiles the
// composed list exactly; a client-side filter over a page window would
// drop rows at the window edges.
//
// FORMAT FILTER: formatFilter narrows the window to a SUBSET of the
// format column — the Builder Filters popover's fourth group (Type).
// Unlike the three pairs it is not a pair but a seven-way checkbox set,
// so the word is the CHECKED SET in metricFormatTokens' canonical order:
// "" = every box checked (no predicate — the other groups' all-on),
// "none" = no box checked (the empty set, the same spelling origin
// uses), and any other word is a CANONICAL COMMA-SUBSET
// ("auto,int,float1"): every token known, distinct, in enum order — and
// the "auto" token names the column's ” format, bound as its own
// `format = ?` equality beside the literal tokens' single
// `format IN (?, …)`. The whole disjunction is parameterized — no
// token ever reaches the SQL text. An unknown token or an unknown word
// shape is rejected before any SQL.
//
// CURSOR: the caller passes the last window's row id, and the store
// resolves it to that row's stored (origin rank, name) — the same
// in-store resolution ListMatchesPage does (one driver path, and a
// cursor row that vanished between two windows is ErrNotFound instead of
// a silently mis-placed page). The cursor row may sit OUTSIDE a
// filtered set (a builtin cursor on a "user,plugin" walk): it still
// resolves, because the predicate is the row's stored key, not membership.
//
// KEYSET PREDICATE: `(rank, name) > (?, ?)` — SQLite's row-value
// comparison is lexicographic over the pair, which is exactly what
// `ORDER BY rank, name ASC` needs, and it keeps the CASE expression
// spelled once instead of the three-fold composite expansion. The
// composite key is unique (metrics.name is UNIQUE across origins), so
// no id tie-break is needed: windows can neither skip nor duplicate a
// row, and each origin stays contiguous across window boundaries — the
// view renders its Builtins/Custom/Plugins headers from those runs.
func (s *Store) ListMetricsPage(query string, originFilter string, formatFilter string, afterID int64, limit int) (*models.MetricListPage, error) {
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
	// narrowing (origin filter, format filter, search, cursor) rides the same
	// clause, so they compose in any order and none can silently bypass
	// another.
	addWhere := func(pred string, a ...any) {
		if where.Len() == 0 {
			where.WriteString(" WHERE ")
		} else {
			where.WriteString(" AND ")
		}
		where.WriteString(pred)
		args = append(args, a...)
	}
	// The origin subset goes first (the coarsest narrowing). "none" is
	// a constant-false predicate rather than a view-side short-circuit
	// so all-off keeps the ONE read path (same cache key shape, same
	// cursor semantics as every other window); every other word is the
	// canonical comma-subset originFilterPredicate renders — its
	// rejection happens there, before any SQL.
	switch originFilter {
	case "": // no predicate — the whole catalog
	case "none":
		addWhere(`0 = 1`)
	default:
		pred, a, err := originFilterPredicate(originFilter)
		if err != nil {
			return nil, err
		}
		addWhere(pred, a...)
	}
	// The format subset (see the FORMAT FILTER note above): "none" is
	// the empty set like origin's, and every other non-empty word is
	// the canonical comma-subset formatFilterPredicate renders — its
	// rejection happens there, before any SQL.
	switch formatFilter {
	case "": // no predicate — every format
	case "none":
		addWhere(`0 = 1`)
	default:
		pred, a, err := formatFilterPredicate(formatFilter)
		if err != nil {
			return nil, err
		}
		addWhere(pred, a...)
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
		return nil, fmt.Errorf("couldn't load the metrics: %w", err)
	}
	defer rows.Close()
	page := &models.MetricListPage{Rows: []models.MetricRow{}}
	for rows.Next() {
		m, err := scanMetric(rows)
		if err != nil {
			return nil, fmt.Errorf("couldn't load the metrics: %w", err)
		}
		page.Rows = append(page.Rows, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load the metrics: %w", err)
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
		return "", nil, fmt.Errorf("couldn't load the metrics: %w", ErrNotFound)
	}
	if err != nil {
		return "", nil, fmt.Errorf("couldn't load the metrics: %w", err)
	}
	return `(` + metricOriginRank + `, name) > (?, ?)`, []any{rank, name}, nil
}

// GetMetric returns one definition by id (ErrNotFound when absent).
func (s *Store) GetMetric(id int64) (models.MetricRow, error) {
	return getMetricRow(s.db, id)
}

// GetMetricByName returns one definition by its UNIQUE name (ErrNotFound
// when absent). metrics.name is UNIQUE across every origin, so name→id
// resolution is TOTAL — this is the lookup behind metric() references
// (design §2 identity: the name IS the expression's identity).
func (s *Store) GetMetricByName(name string) (models.MetricRow, error) {
	m, err := scanMetric(s.db.QueryRow(
		`SELECT `+metricColumns+` FROM metrics WHERE name = ?`, scrub(name),
	))
	if errors.Is(err, sql.ErrNoRows) {
		return models.MetricRow{}, ErrNotFound
	}
	if err != nil {
		return models.MetricRow{}, fmt.Errorf("couldn't load the metric: %w", err)
	}
	return m, nil
}

// metricsExec is the statement surface a metrics write runs on: the
// store's single write handle (the plain Create/Update paths) or the
// open transaction SaveMetricWithDeps wraps its writes in. Reads ride
// the same surface — the store is capped at ONE connection, so a
// transaction must do its own reads (a s.db read while the tx holds the
// connection would block on it).
type metricsExec interface {
	Exec(query string, args ...any) (sql.Result, error)
	QueryRow(query string, args ...any) *sql.Row
	Query(query string, args ...any) (*sql.Rows, error)
}

// getMetricRow is GetMetric over an arbitrary statement surface (the
// write handle or an open transaction).
func getMetricRow(q metricsExec, id int64) (models.MetricRow, error) {
	m, err := scanMetric(q.QueryRow(`SELECT `+metricColumns+` FROM metrics WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return models.MetricRow{}, ErrNotFound
	}
	if err != nil {
		return models.MetricRow{}, fmt.Errorf("couldn't load the metric: %w", err)
	}
	return m, nil
}

// insertMetric is CreateMetric's INSERT: the plain path calls it on the
// write handle, the atomic save on its transaction.
func insertMetric(q metricsExec, m models.MetricRow) (int64, error) {
	res, err := q.Exec(
		`INSERT INTO metrics (name, title, short_name, expr, run_expr, format, doc, origin, plugin_id, touched, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		scrub(m.Name), scrub(m.Title), scrub(m.ShortName), scrub(m.Expr), scrub(m.RunExpr),
		scrub(m.Format), scrub(m.Doc), scrub(m.Origin), scrub(m.PluginID),
		touchedColumn(m.Touched), time.Now(),
	)
	if err != nil {
		if isUniqueErr(err) {
			return 0, fmt.Errorf("a metric named %q already exists", scrub(m.Name))
		}
		return 0, fmt.Errorf("couldn't save the metric: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("couldn't save the metric: %w", err)
	}
	return id, nil
}

// updateMetric is UpdateMetric's UPDATE plus its origin gate (the plain
// path calls it on the write handle, the atomic save on its transaction
// — the gate reads the stored row through the SAME surface, so it sees
// the transaction's own view).
func updateMetric(q metricsExec, m models.MetricRow, builtinEdit bool) error {
	existing, err := getMetricRow(q, m.ID)
	if err != nil {
		return err
	}
	if existing.Origin != "user" && (!builtinEdit || existing.Origin != "builtin") {
		return fmt.Errorf("the %s metric %q cannot be modified", existing.Origin, existing.Name)
	}
	// A built-in keeps its name: other metrics and components compose it by name.
	if existing.Origin == "builtin" && m.Name != existing.Name {
		return fmt.Errorf("the built-in metric %q can't be renamed", existing.Name)
	}
	// A rename must not leave a component using the old name dangling.
	if m.Name != existing.Name {
		if err := refuseIfReferenced(q, "metric", existing.Name, ""); err != nil {
			return err
		}
	}
	if _, err := q.Exec(
		`UPDATE metrics SET name = ?, title = ?, short_name = ?, expr = ?, run_expr = ?, format = ?,
			doc = ?, plugin_id = ?, touched = ? WHERE id = ?`,
		scrub(m.Name), scrub(m.Title), scrub(m.ShortName), scrub(m.Expr), scrub(m.RunExpr),
		scrub(m.Format), scrub(m.Doc), scrub(m.PluginID), touchedColumn(m.Touched), m.ID,
	); err != nil {
		if isUniqueErr(err) {
			return fmt.Errorf("a metric named %q already exists", scrub(m.Name))
		}
		return fmt.Errorf("couldn't update the metric: %w", err)
	}
	return nil
}

// CreateMetric inserts a definition and returns the stored row. A name
// already used by ANY origin (including builtins) yields a user-facing
// uniqueness error — API saves can never shadow a builtin. scope is
// written from the row; version is NOT in the INSERT (column DEFAULT 1 —
// the counter starts at 1 and only the semantic-edit bump moves it).
func (s *Store) CreateMetric(m models.MetricRow) (models.MetricRow, error) {
	// Every row carries its run form: the sweep executes run_expr. A row written without one
	// (a direct store write) gets the expansion of its macro form here, as the save gate writes.
	if m.RunExpr == "" {
		run, err := ExpandMetricMacros(m.Expr)
		if err != nil {
			return models.MetricRow{}, err
		}
		m.RunExpr = run
	}
	id, err := insertMetric(s.db, m)
	if err != nil {
		return models.MetricRow{}, err
	}
	return s.GetMetric(id)
}

// UpdateMetric replaces one definition (id must exist). Builtin and plugin
// rows are immutable through this path — the plugin loader writes its own
// rows via ReplacePluginMetrics, and builtins are schema-seeded. scope is
// written from the row; version is deliberately NOT touched here — the
// +1 bump on semantic edits (expr/scope, with the
// transitive-dependent cascade) lives in SaveMetricWithDeps' save
// transaction (stored-metrics design §4), which is THE save path the
// service routes through; this plain overwrite stays the raw store API
// (no-history model — no shadow rows, no versioned copies).
func (s *Store) UpdateMetric(m models.MetricRow) (models.MetricRow, error) {
	if m.RunExpr == "" {
		run, err := ExpandMetricMacros(m.Expr)
		if err != nil {
			return models.MetricRow{}, err
		}
		m.RunExpr = run
	}
	if err := updateMetric(s.db, m, false); err != nil {
		return models.MetricRow{}, err
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
		return fmt.Errorf("the built-in metric %q can't be deleted", existing.Name)
	}
	if err := refuseIfReferenced(s.db, "metric", existing.Name, ""); err != nil {
		return err
	}
	res, err := s.db.Exec(`DELETE FROM metrics WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("couldn't delete the metric: %w", err)
	}
	return affectedOrNotFound(res, "deleting the metric")
}

// DependentRewrite is ONE dependent metric's rename splice (design §2):
// the SERVICE prepares it — parse the dependent's expr, replace its
// metric('old') literal spans, re-parse and re-compile-validate the
// result, re-extract its refs — and the store applies it inside
// SaveMetricWithDeps' transaction. Nothing is written until every
// rewrite has validated, and a write failure rolls the whole save back.
type DependentRewrite struct {
	ID   int64
	Expr string
	Deps []string
}

// SaveMetricWithDeps upserts one definition AND re-derives its
// metric_deps edges wholesale from the caller-extracted refs (design §2
// no-history rule: edges always describe the CURRENT expression, so no
// edge ever points at a superseded one), optionally applying dependents'
// rename splices — ALL in ONE transaction, so a failed save (a name
// collision, a rewrite that cannot land) leaves every row untouched.
//
// semanticBump is design §4's version-axis marking: when the save
// changed the metric's SEMANTICS (expr / scope — the
// caller decides by comparing against the stored row, the
// analyticservice.go SetConfig no-op pattern), the same transaction
// bumps the metric's version AND every transitive dependent's
// (bumpMetricAndDependents), so after commit nothing is partially
// behind and the behind set IS the remaining work. Display-only edits,
// no-op saves and renames pass false: no bump, no recompute (a rename
// changes no semantics). The bump writes NOTHING into metric_values —
// deleting outdated rows is the sweep's alone.
//
// The edges are keyed by NAME, never by id: metrics.name is the
// expression's identity and ids churn on plugin replace
// (ReplacePluginMetrics deletes + re-inserts). dep_name deliberately
// has NO foreign key — a system-removed upstream (plugin disable) must
// leave the edge so the compute pass resolves-or-fails it honestly;
// metric_id's ON DELETE CASCADE is the backstop for the metric's OWN
// edges (pinned by TestMetricDepsCascadeOnDelete).
//
// ReplacePluginMetrics never routes through here (it owns its own
// transaction and never parses exprs), so this method's edge
// maintenance can never block a plugin replace.
func (s *Store) SaveMetricWithDeps(m models.MetricRow, deps []string, rewrites []DependentRewrite, semanticBump bool) (models.MetricRow, error) {
	return s.saveMetricWithOverride(m, deps, rewrites, semanticBump, nil)
}

// MetricOverrideWrite is the builtin_overrides change a builtin metric's
// save carries in its own transaction (owner ruling 44). An edit stores the
// saved expr as the override, keeping Shipped (the shipped SQL) for restore;
// a restore deletes the override and the saved expr is the shipped SQL.
type MetricOverrideWrite struct {
	Restore bool
	Shipped string
}

// SaveBuiltinMetric saves a builtin metric's edited definition (or its
// restored one) and its override in ONE transaction, with the same dependency
// rewrite and semantic-bump cascade as SaveMetricWithDeps.
func (s *Store) SaveBuiltinMetric(m models.MetricRow, deps []string, semanticBump bool, ov MetricOverrideWrite) (models.MetricRow, error) {
	return s.saveMetricWithOverride(m, deps, nil, semanticBump, &ov)
}

func (s *Store) saveMetricWithOverride(m models.MetricRow, deps []string, rewrites []DependentRewrite, semanticBump bool, ov *MetricOverrideWrite) (models.MetricRow, error) {
	// A row always carries its run form (see CreateMetric): the change walk reads it to tell
	// which unit a dependent is bound to, so an empty one would read as unbound.
	if m.RunExpr == "" {
		run, err := ExpandMetricMacros(m.Expr)
		if err != nil {
			return models.MetricRow{}, err
		}
		m.RunExpr = run
	}
	tx, err := s.db.Begin()
	if err != nil {
		return models.MetricRow{}, fmt.Errorf("couldn't save the metric: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var id int64
	if m.ID > 0 {
		if err := updateMetric(tx, m, ov != nil); err != nil {
			return models.MetricRow{}, err
		}
		id = m.ID
	} else {
		if id, err = insertMetric(tx, m); err != nil {
			return models.MetricRow{}, err
		}
	}
	if err := replaceMetricDeps(tx, id, deps); err != nil {
		return models.MetricRow{}, err
	}
	if ov != nil {
		if err := writeMetricOverride(tx, m, *ov); err != nil {
			return models.MetricRow{}, err
		}
	}
	for _, r := range rewrites {
		run, err := ExpandMetricMacros(r.Expr)
		if err != nil {
			return models.MetricRow{}, fmt.Errorf("couldn't update the dependent metric: %w", err)
		}
		res, err := tx.Exec(`UPDATE metrics SET expr = ?, run_expr = ? WHERE id = ?`, scrub(r.Expr), scrub(run), r.ID)
		if err != nil {
			return models.MetricRow{}, fmt.Errorf("couldn't update the dependent metric: %w", err)
		}
		if err := affectedOrNotFound(res, "updating the dependent metric"); err != nil {
			return models.MetricRow{}, err
		}
		if err := replaceMetricDeps(tx, r.ID, r.Deps); err != nil {
			return models.MetricRow{}, err
		}
	}
	// The cascade bump runs LAST inside the same tx (order is irrelevant
	// — atomic): by now the graph the walk sees is the post-save one
	// (edges replaced, rename splices applied).
	if semanticBump && m.ID > 0 {
		if err := bumpMetricAndDependents(tx, id); err != nil {
			return models.MetricRow{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return models.MetricRow{}, fmt.Errorf("couldn't save the metric: %w", err)
	}
	return s.GetMetric(id)
}

// writeMetricOverride keeps builtin_overrides in step with a builtin
// metric's save, inside the save's transaction: an edit upserts the saved
// expr as the override (the shipped SQL is kept from the existing row, or
// from the row's expr before the edit), a restore deletes it.
func writeMetricOverride(q builtinOverrideExec, m models.MetricRow, ov MetricOverrideWrite) error {
	key := MetricOverridePrefix + m.Name
	if ov.Restore {
		if _, err := q.Exec(`DELETE FROM builtin_overrides WHERE id = ?`, scrub(key)); err != nil {
			return fmt.Errorf("couldn't restore the builtin metric: %w", err)
		}
		return nil
	}
	return writeBuiltinOverride(q, key, m.Expr, ov.Shipped)
}

// replaceMetricDeps rewrites ONE metric's edge set from the extracted
// refs: delete every current row, then insert the new set
// (deduplicated — metric_deps is a SET keyed (metric_id, dep_name),
// while the extractor legitimately lists a name once per occurrence).
func replaceMetricDeps(q metricsExec, metricID int64, deps []string) error {
	if _, err := q.Exec(`DELETE FROM metric_deps WHERE metric_id = ?`, metricID); err != nil {
		return fmt.Errorf("couldn't save the metric dependencies: %w", err)
	}
	seen := make(map[string]bool, len(deps))
	for _, d := range deps {
		if seen[d] {
			continue
		}
		seen[d] = true
		if _, err := q.Exec(
			`INSERT INTO metric_deps (metric_id, dep_name) VALUES (?, ?)`, metricID, scrub(d),
		); err != nil {
			return fmt.Errorf("couldn't save the metric dependencies: %w", err)
		}
	}
	return nil
}

// MetricDeps returns the metric's stored edges (the reference names its
// CURRENT expression holds), sorted — the round-trip read: after every
// save shape the rows equal the distinct metrics.MetricRefs of the
// stored expression.
func (s *Store) MetricDeps(metricID int64) ([]string, error) {
	rows, err := s.db.Query(`SELECT dep_name FROM metric_deps WHERE metric_id = ? ORDER BY dep_name`, metricID)
	if err != nil {
		return nil, fmt.Errorf("couldn't load the metric dependencies: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("couldn't load the metric dependencies: %w", err)
		}
		out = append(out, name)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load the metric dependencies: %w", err)
	}
	return out, nil
}

// MetricDependents returns every metric whose expression references
// `name` as a full row (name ASC), served by the dep_name-leading index
// — the delete-block read and the rename splice's work list.
func (s *Store) MetricDependents(name string) ([]models.MetricRow, error) {
	rows, err := s.db.Query(
		`SELECT `+metricColumns+` FROM metrics WHERE id IN
			(SELECT metric_id FROM metric_deps WHERE dep_name = ?) ORDER BY name ASC`,
		scrub(name),
	)
	if err != nil {
		return nil, fmt.Errorf("couldn't load the metric dependents: %w", err)
	}
	defer rows.Close()
	var out []models.MetricRow
	for rows.Next() {
		m, err := scanMetric(rows)
		if err != nil {
			return nil, fmt.Errorf("couldn't load the metric dependents: %w", err)
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load the metric dependents: %w", err)
	}
	return out, nil
}

// ListMetricEdges returns the whole dependency graph keyed by metric
// name (name → the names its expression references), both levels sorted
// — the pure cycle check's input (design §2: a save walks {existing
// edges} ∪ {the saved metric's new refs}).
func (s *Store) ListMetricEdges() (map[string][]string, error) {
	rows, err := s.db.Query(
		`SELECT m.name, d.dep_name FROM metric_deps d
		 JOIN metrics m ON m.id = d.metric_id
		 ORDER BY m.name ASC, d.dep_name ASC`,
	)
	if err != nil {
		return nil, fmt.Errorf("couldn't load the metric dependency graph: %w", err)
	}
	defer rows.Close()
	out := map[string][]string{}
	for rows.Next() {
		var from, to string
		if err := rows.Scan(&from, &to); err != nil {
			return nil, fmt.Errorf("couldn't load the metric dependency graph: %w", err)
		}
		out[from] = append(out[from], to)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("couldn't load the metric dependency graph: %w", err)
	}
	return out, nil
}
