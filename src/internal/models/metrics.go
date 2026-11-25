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
	ID        int64  `json:"id"`
	Name      string `json:"name"` // UNIQUE across all origins
	Title     string `json:"title"`
	ShortName string `json:"shortName"` // optional; read only at width-constrained metric column headers
	Expr      string `json:"expr"`      // one SELECT or WITH statement, in its macro form (what the editor shows; raw SQL; internal/metrics raw.go)
	// RunExpr is the expanded form of Expr: the plain SQL every run, dependency and scope read uses.
	// Written by the save gate (metrics.CheckRawSave); internal, never marshalled.
	RunExpr string `json:"-"`
	// Scope is DERIVED from the expr's binds (store.ScopeOfExpr), never
	// stored: match|profile, profile when the statement reads :steam_id.
	Scope    string `json:"scope"`
	Format   string `json:"format"` // ""|int|float1|float2|percent|currency|identity
	Doc      string `json:"doc"`
	Origin   string `json:"origin"` // builtin|user|plugin
	PluginID string `json:"pluginId"`
	// Touched is the physical tables the metric's compiled statement reads
	// (sorted), derived by the save gate and stored as metrics.touched.
	// nil = not derived. Internal until freshness reads it.
	Touched   []string  `json:"-"`
	Version   int       `json:"-"`         // internal staleness stamp (metrics.version) — never marshalled to the frontend
	CreatedAt time.Time `json:"createdAt"` // nullable column → zero when NULL
	// Edited is set on a builtin whose override is in place (owner ruling 44):
	// the Builder shows the edited chip and Restore to default. Service-set;
	// the store never reads it.
	Edited bool `json:"edited"`
}

// MetricValue is ONE stored metric value the canonical read serves
// (stored-metrics design §5) — the frontend contract for a value slot,
// at either grain (match rows at match_id > 0, career rows at 0):
// exactly {metricId, subjectKey, dim, value, valueKey}. subjectKey is
// the row's subject: a player's SteamID64, a team key, or ” (match
// subject / career bucket). valueKey is the IDENTITY slot (§3.3): the
// argmax winner's player key on an identity row, ” on every numeric
// row — the surface renders it as a name (unresolved ⇒ dash, never the
// raw key). Deliberately carries NO stamp: metric_version /
// rule_version / computed_at are INTERNAL-ONLY and never leave the
// store, so no view, tooltip or export can render one.
type MetricValue struct {
	MetricID   int64    `json:"metricId"`
	SubjectKey string   `json:"subjectKey"` // player SteamID64 | team key ('ct'/'t') | ''
	Dim        string   `json:"dim"`        // the statement's dim column ('' = unpartitioned — §6.5)
	Value      *float64 `json:"value"`      // nil = no data (raw SQL NULL, ruling 23): a dash, never 0
	ValueKey   string   `json:"valueKey"`   // identity winner's key (identity rows only; '' otherwise)
}

// MetricSeriesPoint is ONE fresh stored match-grain value carrying the
// match's trend-position fields (store.GetPlayerMetricSeries): the value
// plus Patch and ExtractedAt — the sparkline's x axis and its tooltip's
// "when" (CS2 patch order, import time as the within-patch tiebreaker;
// see store.GetTrend's doc). Like MetricValue it carries NO stamps:
// metric_version / rule_version / computed_at stay internal, while
// patch/imported-at are MATCH facts (already public on every match DTO),
// never metric-version state.
type MetricSeriesPoint struct {
	MetricID    int64     `json:"metricId"`
	MatchID     int64     `json:"matchId"`
	Value       float64   `json:"value"`
	Patch       int       `json:"patch"`
	ExtractedAt time.Time `json:"extractedAt"` // the match's import time
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
