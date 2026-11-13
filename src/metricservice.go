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

// MetricPreviewRow is one preview result row.
type MetricPreviewRow struct {
	Group string  `json:"group"` // group key ("" for none)
	Label string  `json:"label"` // display name (player name etc when resolvable)
	Value float64 `json:"value"`
	N     int     `json:"n"` // sample size behind the value (PRD §5.16)
}

// MetricPreview is a preview response. Metric is models.MetricRow — the
// stored-definition shape (definitions are served and saved as rows; no
// service twin).
type MetricPreview struct {
	Metric    models.MetricRow   `json:"metric"`
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

// ---- metric expression grammar (widened — spec lives in ONE place) ----
//
// The full spec (source clause — single-source base form, comma-list
// join extension — plus the aggregation list, the op table, condition
// grammar, GroupBy/Denominator/Scope rules, join/population semantics,
// percentile and preview semantics) lives in ONE place: the
// internal/metrics package doc (doc.go). This service only forwards
// expressions to metrics.Compile / metrics.RunPreview and maps their
// ParseError onto the ExprError binding shape — no grammar knowledge of
// its own, so the two can never drift.

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

// metricFormats are the accepted Format values (contract).
var metricFormats = map[string]bool{"": true, "int": true, "float1": true, "percent": true, "currency": true}

// ListMetrics returns all definitions (builtin first).
func (s *MetricsService) ListMetrics() ([]models.MetricRow, error) {
	return s.st.ListMetrics()
}

// GetMetric returns one by id (or name).
func (s *MetricsService) GetMetric(id int64) (models.MetricRow, error) {
	if id <= 0 {
		return models.MetricRow{}, errors.New("metrics: metric id is required")
	}
	r, err := s.st.GetMetric(id)
	if errors.Is(err, store.ErrNotFound) {
		return models.MetricRow{}, fmt.Errorf("metrics: no metric with id %d", id)
	}
	if err != nil {
		return models.MetricRow{}, err
	}
	return r, nil
}

// SaveMetric validates + upserts (origin forced to user for API saves;
// plugin metrics are written by the plugin loader). Duplicate name → error.
// The frontend echoes rows back as-is; CreatedAt is store-owned (stamped
// on create, untouched on update).
func (s *MetricsService) SaveMetric(m models.MetricRow) (models.MetricRow, error) {
	m.Name = strings.TrimSpace(m.Name)
	if m.Name == "" {
		return models.MetricRow{}, errors.New("metrics: metric name is required")
	}
	m.Title = strings.TrimSpace(m.Title)
	if m.Title == "" {
		m.Title = m.Name
	}
	m.Format = strings.TrimSpace(m.Format)
	if !metricFormats[m.Format] {
		return models.MetricRow{}, fmt.Errorf("metrics: unknown format %q (valid: int, float1, percent, currency)", m.Format)
	}
	// API path: origin forced to user; plugin rows are the loader's
	// territory (platform_store.ReplacePluginMetrics) and cannot be
	// created or hijacked through here.
	m.Origin = "user"
	m.PluginID = ""
	// Validate expression + groupBy (+denominator) BEFORE any write.
	if _, perr := metrics.Compile(m.Expr, m.GroupBy, m.Denominator, ""); perr != nil {
		return models.MetricRow{}, exprErrorErr(perr)
	}
	if strings.TrimSpace(m.Doc) == "" {
		m.Doc = "Formula: " + m.Expr // PRD §5.16: formula documentation on every metric
	}
	var (
		saved models.MetricRow
		err   error
	)
	if m.ID > 0 {
		saved, err = s.st.UpdateMetric(m)
	} else {
		saved, err = s.st.CreateMetric(m)
	}
	if err != nil {
		return models.MetricRow{}, err
	}
	return saved, nil
}

// DeleteMetric removes a user metric (builtin protected).
func (s *MetricsService) DeleteMetric(id int64) error { return s.st.DeleteMetric(id) }

// PreviewMetric compiles expr (empty expr → use id) and runs it.
// scope: "" = whole library; scope="match:<id>" limits single-match sources.
func (s *MetricsService) PreviewMetric(id int64, expr string, groupBy string, scope string, limit int) (MetricPreview, error) {
	var (
		def  metrics.Def
		echo models.MetricRow
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
		echo = models.MetricRow{ID: id, Expr: expr, GroupBy: groupBy}
	}
	// limit ≤0 is normalized inside metrics.RunPreview — the one canonical
	// default (PreviewDefaultRow), never here.
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
