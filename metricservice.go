package main

import (
	"errors"
	"fmt"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/ChristianWSmith/spectra/internal/metrics"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// MetricsService is M5 §2.1: the custom-metric engine. Definitions live in
// the `metrics` table (origin builtin|user|plugin). Expressions are parsed
// into a validated AST (whitelisted tables/columns/ops — never interpolated
// user SQL) and compiled to parameterized SQL. Preview runs against the
// whole library with a row cap; pinned metrics appear as scoreboard/profile
// columns (frontend composes via groupBy=player previews).

// MetricDef is one metric definition (stored row + runtime handle).
type MetricDef struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`     // unique, slug-ish (used as column key)
	Title    string `json:"title"`    // display label
	Expr     string `json:"expr"`     // expression source (grammar below)
	GroupBy  string `json:"groupBy"`  // ""|player|round|team|weapon|side|map|none — validated
	Format   string `json:"format"`   // ""|int|float1|percent|currency
	Doc      string `json:"doc"`      // formula documentation (PRD §5.16)
	Origin   string `json:"origin"`   // builtin|user|plugin
	PluginID string `json:"pluginId"` // origin=plugin
	// Denominator, when set, is a scalar subquery (e.g. rounds played) so
	// rates like "trades per round" compile to one SQL statement.
	Denominator string `json:"denominator,omitempty"`
}

// MetricPreviewRow is one preview result row.
type MetricPreviewRow struct {
	Group string  `json:"group"` // group key ("" for none)
	Label string  `json:"label"` // display name (player name etc when resolvable)
	Value float64 `json:"value"`
	N     int     `json:"n"` // sample size behind the value (PRD §5.16)
}

// MetricPreview is a preview response.
type MetricPreview struct {
	Metric    MetricDef          `json:"metric"`
	Rows      []MetricPreviewRow `json:"rows"`
	MS        int64              `json:"ms"`
	SQL       string             `json:"sql"` // compiled SQL (debug/provenance view)
	Truncated bool               `json:"truncated"`
}

// ExprError describes a validation failure (line/col when parseable).
type ExprError struct {
	Message string `json:"message"`
	Pos     int    `json:"pos"`
}

// ---- metric expression grammar (v1 — FROZEN; full spec: internal/metrics package doc) ----
//
// An expression is a single source clause plus a comma-separated
// aggregation list:
//
//	from <table>: <op>(<args>) [AS alias] , ...
//
// <table> must be one of the ten v1 sources (events, engagements, rounds,
// player_stats, player_round_stats, round_economy, clutches,
// utility_events, chat, voice_chunks) — no other table names are ever
// accepted, and every column an expression mentions is checked against a
// per-source whitelist before compilation (unknown → ExprError with byte
// position; nothing is interpolated into SQL — literals bind as `?`).
// Aggregations: count() / count(<cond>) / count(where <cond>),
// sum|avg|min|max|stddev(<col>) with an optional `where <cond>,` filter
// prefix, percentile(<p>, <col>) and median(<col>) (percentile requires
// groupBy "" — computed in Go over all rows), and ratio(<a1>, <a2>).
// Conditions: whitelisted columns, numbers, 'strings', true/false, the
// operators = != > >= < <= AND OR NOT and parentheses; a bare operand is
// SQLite-truthy (count(headshot) counts flagged rows). Optional
// Denominator ∈ {rounds, matches, player_rounds} divides the value by a
// scalar COUNT(*) subquery over the same scope; scope "" = library-wide,
// "match:<id>" binds match_id. groupBy maps through a fixed per-source
// table (player|round|team|weapon|side|map|none; unmapped → ExprError).

// MetricsService — see doc comment above.
type MetricsService struct {
	st  *store.Store
	app *application.App
}

// exprError converts a metrics.ParseError into the ExprError contract and
// a plain error for call paths that only return error.
func exprError(perr *metrics.ParseError) ExprError {
	return ExprError{Message: perr.Message, Pos: perr.Pos}
}

func exprErrorErr(perr *metrics.ParseError) error {
	return fmt.Errorf("metrics: %s (at byte %d)", perr.Message, perr.Pos)
}

// defFromRow / rowFromDef map the stored row onto the frontend contract.
func defFromRow(r models.MetricRow) MetricDef {
	return MetricDef{
		ID: r.ID, Name: r.Name, Title: r.Title, Expr: r.Expr, GroupBy: r.GroupBy,
		Format: r.Format, Doc: r.Doc, Origin: r.Origin, PluginID: r.PluginID,
		Denominator: r.Denominator,
	}
}

func rowFromDef(m MetricDef) models.MetricRow {
	return models.MetricRow{
		ID: m.ID, Name: m.Name, Title: m.Title, Expr: m.Expr, GroupBy: m.GroupBy,
		Format: m.Format, Doc: m.Doc, Origin: m.Origin, PluginID: m.PluginID,
		Denominator: m.Denominator,
	}
}

// metricFormats are the accepted MetricDef.Format values (contract).
var metricFormats = map[string]bool{"": true, "int": true, "float1": true, "percent": true, "currency": true}

// ListMetrics returns all definitions (builtin first).
func (s *MetricsService) ListMetrics() ([]MetricDef, error) {
	rows, err := s.st.ListMetrics()
	if err != nil {
		return nil, err
	}
	out := make([]MetricDef, len(rows))
	for i, r := range rows {
		out[i] = defFromRow(r)
	}
	return out, nil
}

// GetMetric returns one by id (or name).
func (s *MetricsService) GetMetric(id int64) (MetricDef, error) {
	if id <= 0 {
		return MetricDef{}, errors.New("metrics: metric id is required")
	}
	r, err := s.st.GetMetric(id)
	if errors.Is(err, store.ErrNotFound) {
		return MetricDef{}, fmt.Errorf("metrics: no metric with id %d", id)
	}
	if err != nil {
		return MetricDef{}, err
	}
	return defFromRow(r), nil
}

// SaveMetric validates + upserts (origin forced to user for API saves;
// plugin metrics are written by the plugin loader). Duplicate name → error.
func (s *MetricsService) SaveMetric(m MetricDef) (MetricDef, error) {
	m.Name = strings.TrimSpace(m.Name)
	if m.Name == "" {
		return MetricDef{}, errors.New("metrics: metric name is required")
	}
	m.Title = strings.TrimSpace(m.Title)
	if m.Title == "" {
		m.Title = m.Name
	}
	m.Format = strings.TrimSpace(m.Format)
	if !metricFormats[m.Format] {
		return MetricDef{}, fmt.Errorf("metrics: unknown format %q (valid: int, float1, percent, currency)", m.Format)
	}
	// API path: origin forced to user; plugin rows are the loader's
	// territory (platform_store.ReplacePluginMetrics) and cannot be
	// created or hijacked through here.
	m.Origin = "user"
	m.PluginID = ""
	// Validate expression + groupBy (+denominator) BEFORE any write.
	if _, perr := metrics.Compile(m.Expr, m.GroupBy, m.Denominator, ""); perr != nil {
		return MetricDef{}, exprErrorErr(perr)
	}
	if strings.TrimSpace(m.Doc) == "" {
		m.Doc = "Formula: " + m.Expr // PRD §5.16: formula documentation on every metric
	}
	var (
		saved models.MetricRow
		err   error
	)
	if m.ID > 0 {
		saved, err = s.st.UpdateMetric(rowFromDef(m))
	} else {
		saved, err = s.st.CreateMetric(rowFromDef(m))
	}
	if err != nil {
		return MetricDef{}, err
	}
	return defFromRow(saved), nil
}

// DeleteMetric removes a user metric (builtin protected).
func (s *MetricsService) DeleteMetric(id int64) error { return s.st.DeleteMetric(id) }

// PreviewMetric compiles expr (empty expr → use id) and runs it.
// scope: "" = whole library; scope="match:<id>" limits single-match sources.
func (s *MetricsService) PreviewMetric(id int64, expr string, groupBy string, scope string, limit int) (MetricPreview, error) {
	var (
		def  metrics.Def
		echo MetricDef
	)
	if strings.TrimSpace(expr) == "" {
		full, err := s.GetMetric(id)
		if err != nil {
			return MetricPreview{}, err
		}
		gb := full.GroupBy
		if strings.TrimSpace(groupBy) != "" {
			gb = groupBy // explicit groupBy overrides the stored one ("none" → ungrouped)
		}
		def = metrics.Def{Expr: full.Expr, GroupBy: gb, Denominator: full.Denominator}
		echo = full
		echo.GroupBy = gb
	} else {
		// Ad-hoc expression: no denominator (rates are a property of the
		// saved definition); groupBy used as given.
		def = metrics.Def{Expr: expr, GroupBy: groupBy}
		echo = MetricDef{ID: id, Expr: expr, GroupBy: groupBy}
	}
	if limit <= 0 {
		limit = metrics.PreviewDefaultRow
	}
	pv, perr, err := metrics.RunPreview(s.st, def, scope, limit)
	if perr != nil {
		return MetricPreview{}, exprErrorErr(perr)
	}
	if err != nil {
		return MetricPreview{Metric: echo, MS: pv.MS, SQL: pv.SQL}, err
	}
	rows := make([]MetricPreviewRow, len(pv.Rows))
	for i, r := range pv.Rows {
		rows[i] = MetricPreviewRow{Group: r.Group, Label: r.Label, Value: r.Value, N: r.N}
	}
	return MetricPreview{
		Metric: echo, Rows: rows, MS: pv.MS, SQL: pv.SQL, Truncated: pv.Truncated,
	}, nil
}

// ValidateExpr parses without executing (builder live-check).
func (s *MetricsService) ValidateExpr(expr string, groupBy string) (bool, ExprError, error) {
	if perr := metrics.Validate(expr, groupBy); perr != nil {
		return false, exprError(perr), nil
	}
	return true, ExprError{}, nil
}
