package main

import (
	"database/sql"
	"fmt"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/metrics"
	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// refSource is a per-match source metric whose value is its match id for
// each human player, so a reader can tell which match a value came from.
const refSource = "SELECT steam_id AS subject_key, '' AS dim, :match_id AS value FROM players WHERE match_id = :match_id AND is_bot = 0"

// (a) A statement reads metric('x') for the bound match and returns that
// match's stored value, carried with subject_key and dim.
func TestMetricRefReadsStoredValueForBoundMatch(t *testing.T) {
	f := newSeededFixture(t)
	x := f.save(t, models.MetricRow{Name: "ref_source_a", Expr: refSource})
	y := f.save(t, models.MetricRow{
		Name: "ref_reader_a",
		Expr: "SELECT subject_key, dim, value + 1000 AS value FROM metric('ref_source_a') WHERE :match_id > 0",
	})
	if _, err := metrics.Sweep(t.Context(), f.st, nil, nil); err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	xRows, yRows := rawStored(t, f.st, x.ID), rawStored(t, f.st, y.ID)
	if len(yRows) == 0 || len(yRows) != len(xRows) {
		t.Fatalf("reader rows = %d, source rows = %d; want equal and non-zero", len(yRows), len(xRows))
	}
	for _, r := range yRows {
		if r.Value == nil || *r.Value != float64(r.Match)+1000 {
			t.Fatalf("reader row %+v: want the match's stored value + 1000", r)
		}
	}
}

// (b) A reference to a missing metric is refused at save, naming it.
func TestMetricRefMissingNameRefusedAtSave(t *testing.T) {
	f := newSeededFixture(t)
	_, err := f.svc.SaveMetric(models.MetricRow{
		Name: "ref_missing_b", Expr: "SELECT subject_key, dim, value FROM metric('no_such_metric')",
		Format: "int",
	})
	if err == nil || !strings.Contains(err.Error(), `"no_such_metric"`) || !strings.Contains(err.Error(), "no metric has that name") {
		t.Fatalf("save error = %v, want a missing-metric refusal naming no_such_metric", err)
	}
	if _, gerr := f.st.GetMetricByName("ref_missing_b"); gerr == nil {
		t.Fatal("a refused metric row was written")
	}
}

// (c) A self-reference, and a two-metric loop, are refused as cycles.
func TestMetricRefSelfAndLoopRefusedAsCycle(t *testing.T) {
	f := newSeededFixture(t)
	x := f.save(t, models.MetricRow{Name: "ref_self_c", Expr: refSource})
	_, err := f.svc.SaveMetric(models.MetricRow{
		ID: x.ID, Name: x.Name, Format: "int",
		Expr: "SELECT subject_key, dim, value FROM metric('ref_self_c')",
	})
	if err == nil || !strings.Contains(err.Error(), "cycle") {
		t.Fatalf("self-reference error = %v, want a cycle refusal", err)
	}
	y := f.save(t, models.MetricRow{
		Name: "ref_loop_c_reader", Expr: "SELECT subject_key, dim, value FROM metric('ref_self_c')",
	})
	_, err = f.svc.SaveMetric(models.MetricRow{
		ID: x.ID, Name: x.Name, Format: "int",
		Expr: fmt.Sprintf("SELECT subject_key, dim, value FROM metric('%s')", y.Name),
	})
	if err == nil || !strings.Contains(err.Error(), "cycle") {
		t.Fatalf("loop error = %v, want a cycle refusal", err)
	}
	if got, _ := f.st.GetMetric(x.ID); got.Expr != refSource {
		t.Fatalf("refused save changed the stored expression to %q", got.Expr)
	}
}

// (e) A stored value that is behind, or missing, reads as NULL for its unit,
// never as 0.
func TestMetricRefBehindOrMissingReadsNull(t *testing.T) {
	f := newSeededFixture(t)
	x := f.save(t, models.MetricRow{Name: "ref_source_e", Expr: refSource})
	y := f.save(t, models.MetricRow{
		Name: "ref_reader_e",
		Expr: "SELECT p.steam_id AS subject_key, '' AS dim, " +
			"(SELECT v.value FROM metric('ref_source_e') v WHERE v.subject_key = p.steam_id) AS value " +
			"FROM players p WHERE p.match_id = :match_id AND p.is_bot = 0",
	})
	rule := ruleVersionOf(t, f.st)
	match := readyMatchIDs(t, f.st)[0]
	if err := metrics.RunRaw(t.Context(), f.st, x.ID, x.Version, rule, x.RunExpr, store.RawScope{MatchID: match}); err != nil {
		t.Fatalf("RunRaw source: %v", err)
	}

	db, err := sql.Open("sqlite", f.path+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	var behind, missing string
	if err := db.QueryRow(`SELECT steam_id FROM players WHERE match_id = ? AND is_bot = 0 ORDER BY steam_id LIMIT 1`, match).Scan(&behind); err != nil {
		t.Fatalf("pick behind player: %v", err)
	}
	if err := db.QueryRow(`SELECT steam_id FROM players WHERE match_id = ? AND is_bot = 0 ORDER BY steam_id LIMIT 1 OFFSET 1`, match).Scan(&missing); err != nil {
		t.Fatalf("pick missing player: %v", err)
	}
	if _, err := db.Exec(`UPDATE metric_values SET metric_version = 0 WHERE metric_id = ? AND match_id = ? AND subject_key = ?`, x.ID, match, behind); err != nil {
		t.Fatalf("make behind: %v", err)
	}
	if _, err := db.Exec(`DELETE FROM metric_values WHERE metric_id = ? AND match_id = ? AND subject_key = ?`, x.ID, match, missing); err != nil {
		t.Fatalf("make missing: %v", err)
	}

	if err := metrics.RunRaw(t.Context(), f.st, y.ID, y.Version, rule, y.RunExpr, store.RawScope{MatchID: match}); err != nil {
		t.Fatalf("RunRaw reader: %v", err)
	}
	seen := map[string]*float64{}
	for _, r := range rawStored(t, f.st, y.ID) {
		seen[r.Key] = r.Value
	}
	if v, ok := seen[behind]; !ok || v != nil {
		t.Errorf("behind player %s: value %v (present %v), want NULL", behind, v, ok)
	}
	if v, ok := seen[missing]; !ok || v != nil {
		t.Errorf("missing player %s: value %v (present %v), want NULL", missing, v, ok)
	}
	for k, v := range seen {
		if k == behind || k == missing {
			continue
		}
		if v == nil || *v != float64(match) {
			t.Errorf("fresh player %s: value %v, want %d", k, v, match)
		}
	}
}

// (f) An author statement that reads metric_values directly is refused.
func TestMetricRefAuthorCannotReadMetricValues(t *testing.T) {
	f := newSeededFixture(t)
	for name, expr := range map[string]string{
		"direct": "SELECT subject_key, dim, value FROM metric_values",
		"join":   "SELECT v.subject_key AS subject_key, '' AS dim, v.value AS value FROM players p JOIN metric_values v ON v.match_id = p.match_id",
	} {
		if _, err := f.svc.SaveMetric(models.MetricRow{Name: "ref_author_" + name, Expr: expr, Format: "int"}); err == nil {
			t.Errorf("%s: saved %q, want a refusal", name, expr)
		}
	}
}
