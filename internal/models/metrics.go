package models

import "time"

// M5 (custom metrics + read-only SQL console) row vocabulary. These types
// flow between internal/store (persistence), internal/metrics +
// internal/query (engines) and the M5 services; models stays the shared
// vocabulary (package docs). The service layer maps them onto its
// frontend-facing frozen contract types.
//
// MetricRow mirrors the `metrics` table whose DDL is fixed by the
// coordination contract with internal/store/platform_store.go (005_metrics
// creates it; the plugin registry may re-create it defensively with the
// identical column list — keep both in sync).

// MetricRow is one `metrics` table row (origin builtin|user|plugin).
type MetricRow struct {
	ID          int64     `json:"id"`
	Name        string    `json:"name"` // UNIQUE across all origins
	Title       string    `json:"title"`
	Expr        string    `json:"expr"` // grammar: `from <table>: <aggregations>`
	GroupBy     string    `json:"groupBy"`
	Format      string    `json:"format"` // ""|int|float1|percent|currency
	Doc         string    `json:"doc"`
	Origin      string    `json:"origin"` // builtin|user|plugin
	PluginID    string    `json:"pluginId"`
	Denominator string    `json:"denominator"` // ""|rounds|matches|player_rounds
	CreatedAt   time.Time `json:"createdAt"`   // nullable column → zero when NULL
}

// QueryHistoryRow is one SQL console run (query_history, capped).
type QueryHistoryRow struct {
	ID    int64     `json:"id"`
	SQL   string    `json:"sql"`
	MS    int64     `json:"ms"`
	Rows  int       `json:"rows"`
	OK    bool      `json:"ok"`
	RanAt time.Time `json:"ranAt"`
}

// SavedQueryRow is one named console query (saved_queries, unique name).
type SavedQueryRow struct {
	ID        int64     `json:"id"`
	Name      string    `json:"name"`
	SQL       string    `json:"sql"`
	CreatedAt time.Time `json:"createdAt"`
}

// SchemaColumnRow is one table column from PRAGMA table_info (raw shape;
// notes are attached by internal/query).
type SchemaColumnRow struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// SchemaTableRow is one user table plus its columns (raw shape; notes are
// attached by internal/query).
type SchemaTableRow struct {
	Name    string            `json:"name"`
	Columns []SchemaColumnRow `json:"columns"`
}
