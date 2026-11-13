package models

import "time"

// M5 (custom metrics + read-only SQL console) row vocabulary. These types
// flow between internal/store (persistence), internal/metrics +
// internal/query (engines) and the M5 services; models stays the shared
// vocabulary (package docs). The SQL-console rows (schema, result, saved
// queries, history) and the metric definitions are served as-is — their
// JSON tags ARE the frontend contract (MetricsService and PlatformService
// return MetricRow directly; no service-side twin).
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
	ShortName   string    `json:"shortName"` // optional; read only at width-constrained metric column headers
	Expr        string    `json:"expr"`      // grammar: `from <table>[, <secondary>...]: <aggregations>` (doc.go)
	Scope       string    `json:"scope"`     // match|profile — where the metric is addressed (DDL CHECK)
	Format      string    `json:"format"`    // ""|int|float1|percent|currency
	Doc         string    `json:"doc"`
	Origin      string    `json:"origin"` // builtin|user|plugin
	PluginID    string    `json:"pluginId"`
	Denominator string    `json:"denominator"` // ""|rounds|matches
	Version     int       `json:"-"`           // internal staleness stamp (metrics.version) — never marshalled to the frontend
	CreatedAt   time.Time `json:"createdAt"`   // nullable column → zero when NULL
}

// MetricListPage is one keyset window of the metric-definition list (the
// Builder's "Load more" pagination): Rows is the window, in ListMetrics'
// canonical builtin→user→plugin/name order, and HasNext reports whether
// another window follows it. Shape mirrors models.MatchListPage (the
// library list's window) minus the roster side channel.
type MetricListPage struct {
	Rows    []MetricRow `json:"rows"`
	HasNext bool        `json:"hasNext"`
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
// Name is the display label; Description is the muted second line under
// it (both required by the QueryService save/update validation).
type SavedQueryRow struct {
	ID          int64     `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	SQL         string    `json:"sql"`
	CreatedAt   time.Time `json:"createdAt"`
}

// SavedQueryPage is one keyset window of the saved-query list (the SQL
// console's "Load more" pagination): Rows is the window in name ASC
// order, HasNext reports whether another window follows it (the store's
// limit+1 probe). The cursor is the last row's NAME — saved_queries.name
// is UNIQUE, so a name alone positions the next window with no id
// tie-break (see store.ListSavedQueriesPage).
type SavedQueryPage struct {
	Rows    []SavedQueryRow `json:"rows"`
	HasNext bool            `json:"hasNext"`
}

// SchemaColumnRow is one table column from PRAGMA table_info (store shape).
// Note is NOT a column: internal/query attaches the provenance note and the
// store leaves it "" (see package docs — models is the shared vocabulary).
type SchemaColumnRow struct {
	Name string `json:"name"`
	Type string `json:"type"`
	Note string `json:"note"`
}

// SchemaTableRow is one user table plus its columns (store shape). Note is
// the table-level provenance note, attached the same way as the column
// notes ("" from the store, "" for tables internal/query does not know).
type SchemaTableRow struct {
	Name    string            `json:"name"`
	Note    string            `json:"note"`
	Columns []SchemaColumnRow `json:"columns"`
}

// QueryResult is one SQL-console run: columns + row-major JSON-scalar
// values + the grid's timing/truncation metadata. Err is a STRING (not a
// rejected call) so the run can land in history as ok=false — the console
// contract. The store's ROResult stays the pure execution result (row cap
// and timing without history semantics, shared with the metrics preview).
type QueryResult struct {
	Columns   []string `json:"columns"`
	Rows      [][]any  `json:"rows"`
	RowCount  int      `json:"rowCount"`  // returned rows (≤ cap)
	Truncated bool     `json:"truncated"` // hit the cap
	MS        int64    `json:"ms"`
	Err       string   `json:"err,omitempty"`
}
