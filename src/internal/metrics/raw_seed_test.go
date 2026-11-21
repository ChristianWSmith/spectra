package metrics

import (
	"database/sql"
	"math"
	"strconv"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/store"
)

// rawPreviewRows runs one raw statement at a scope through the raw path's
// own steps: the gate with the binds the scope supplies (RunRaw's rule),
// the read-only run with those binds, and the reserved-column read
// (rawResultRows). It stores nothing; the stored path is RunRaw and the
// sweep. Scope "match:<id>" binds :match_id; "" runs unbound.
func rawPreviewRows(t *testing.T, st *store.Store, expr, scope string) []store.RawMetricRow {
	t.Helper()
	rs := store.RawScope{MatchID: parseTestScope(t, scope)}
	g, gperr, err := GateSQL(expr, rawExists(st), rawSuppliedFor(rs))
	if err != nil {
		t.Fatalf("gate %q: %v", expr, err)
	}
	if gperr != nil {
		t.Fatalf("gate %q (scope %q): %s", expr, scope, gperr.Message)
	}
	var args []any
	for _, b := range g.Binds {
		if b == rawBindMatch {
			args = append(args, sql.Named("match_id", rs.MatchID))
		}
	}
	res, err := st.QueryMetric(t.Context(), expr, args)
	if err != nil {
		t.Fatalf("run %q (scope %q): %v", expr, scope, err)
	}
	rows, err := rawResultRows(res)
	if err != nil {
		t.Fatalf("result %q (scope %q): %v", expr, scope, err)
	}
	return rows
}

// botSteamID is the synthetic 0xFF-prefixed identity extract gives bots
// (extract.isBotKey) — the same spelling the store tests use.
const botSteamID = "18374686479671623692"

// rawValue is a raw row's stored value as a float; NULL is NaN, so a
// comparison against any expected number fails rather than reading 0.
func rawValue(r store.RawMetricRow) float64 {
	if r.Value == nil {
		return math.NaN()
	}
	return *r.Value
}

// toFloat coerces a query-oracle cell to float64 (NULL and text read 0).
// The oracles here are plain SQL the test runs itself; their numbers come
// back as int64 or float64.
func toFloat(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case int64:
		return float64(t)
	}
	return 0
}

// seedRow is one row of a raw run, keyed by its subject group (the
// reserved subject_key column) and its partition (dim). NULL is NaN.
type seedRow struct {
	Group string
	Dim   string
	Value float64
}

// previewRowsFor runs one statement at a scope and returns its rows.
func previewRowsFor(t *testing.T, st *store.Store, expr, scope string) []seedRow {
	t.Helper()
	var out []seedRow
	for _, r := range rawPreviewRows(t, st, expr, scope) {
		out = append(out, seedRow{Group: r.SubjectKey, Dim: r.Dim, Value: rawValue(r)})
	}
	return out
}

// parseTestScope reads a test scope: "" is the library-wide run (0) and
// "match:<id>" binds that match.
func parseTestScope(t *testing.T, scope string) int64 {
	t.Helper()
	if scope == "" {
		return 0
	}
	if !strings.HasPrefix(scope, "match:") {
		t.Fatalf("scope %q: want \"\" or \"match:<id>\"", scope)
	}
	id, err := strconv.ParseInt(strings.TrimPrefix(scope, "match:"), 10, 64)
	if err != nil {
		t.Fatalf("scope %q: %v", scope, err)
	}
	return id
}
