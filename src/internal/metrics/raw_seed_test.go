package metrics

import (
	"database/sql"
	"math"
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
	matchID, perr := ParseScope(scope)
	if perr != nil {
		t.Fatalf("scope %q: %v", scope, perr.Message)
	}
	rs := store.RawScope{MatchID: matchID}
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

// rawValue is a raw row's stored value as a float; NULL is NaN, so a
// comparison against any expected number fails rather than reading 0.
func rawValue(r store.RawMetricRow) float64 {
	if r.Value == nil {
		return math.NaN()
	}
	return *r.Value
}

// previewRowsFor previews one seed expression at a scope and returns its
// rows keyed by subject group. A raw seed runs through the raw path
// (rawPreviewRows); a sugar expression keeps RunPreview.
func previewRowsFor(t *testing.T, st *store.Store, expr, subject, scope string) []PreviewRow {
	t.Helper()
	if IsRawSQL(expr) {
		var out []PreviewRow
		for _, r := range rawPreviewRows(t, st, expr, scope) {
			out = append(out, PreviewRow{Group: r.SubjectKey, Value: rawValue(r)})
		}
		return out
	}
	pv, perr, err := RunPreview(t.Context(), st, Def{Expr: expr, Subject: subject}, scope, 10)
	if perr != nil {
		t.Fatalf("compile %q: %v", expr, perr)
	}
	if err != nil {
		t.Fatalf("run %q: %v (sql %s)", expr, err, pv.SQL)
	}
	return pv.Rows
}
