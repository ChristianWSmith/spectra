package store

import (
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// unitRows is one fresh value row for a match-scope run.
func unitRows(v float64) []RawMetricRow {
	return []RawMetricRow{{SubjectKey: "76561198000000001", Value: &v}}
}

// TestMatchUnitCoverageIsPerMatch: a match with no fresh run record is the
// only behind unit of a :match_id metric. The metric's other matches keep
// their fresh rows, and the coverage names the behind match alone.
func TestMatchUnitCoverageIsPerMatch(t *testing.T) {
	s, _ := openFileStore(t)
	a := seedReadyMatch(t, s, "unit-cov-a")
	b := seedReadyMatch(t, s, "unit-cov-b")
	c := seedReadyMatch(t, s, "unit-cov-c")
	m := seedValueMetric(t, s, "unit_cov", "match")
	cfg, err := s.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	for _, id := range []int64{a, b} {
		if err := s.ReplaceRawMetricValues(m.ID, m.Version, cfg.RuleVersion, RawScope{MatchID: id}, unitRows(1)); err != nil {
			t.Fatalf("ReplaceRawMetricValues(%d): %v", id, err)
		}
	}
	cov := coverageOf(t, s, m.ID, cfg.RuleVersion)
	if !cov.Behind {
		t.Fatalf("metric with an unrun match C must be behind")
	}
	if len(cov.BehindMatches) != 1 || cov.BehindMatches[0] != c {
		t.Fatalf("BehindMatches = %v, want [%d] (only the unrun match)", cov.BehindMatches, c)
	}
	if cov.FreshRows != 2 {
		t.Errorf("FreshRows = %d, want 2 (A and B stay fresh)", cov.FreshRows)
	}
	for _, id := range []int64{a, b} {
		ok, err := s.UnitFresh(m.ID, m.Version, m.Touched, cfg.RuleVersion, RawScope{MatchID: id})
		if err != nil || !ok {
			t.Errorf("UnitFresh(match %d) = %v, %v; want true", id, ok, err)
		}
	}
	if err := s.ReplaceRawMetricValues(m.ID, m.Version, cfg.RuleVersion, RawScope{MatchID: c}, unitRows(3)); err != nil {
		t.Fatalf("ReplaceRawMetricValues(C): %v", err)
	}
	cov = coverageOf(t, s, m.ID, cfg.RuleVersion)
	if cov.Behind || len(cov.BehindMatches) != 0 {
		t.Errorf("after C's run: Behind=%v BehindMatches=%v, want fresh", cov.Behind, cov.BehindMatches)
	}
}

// TestClearMetricUnitsDeletesOnlyItsUnits (test (b)): phase 1 of a sweep of
// match C removes C's rows and run record and NOTHING of A or B.
func TestClearMetricUnitsDeletesOnlyItsUnits(t *testing.T) {
	s, _ := openFileStore(t)
	a := seedReadyMatch(t, s, "unit-clr-a")
	b := seedReadyMatch(t, s, "unit-clr-b")
	c := seedReadyMatch(t, s, "unit-clr-c")
	m := seedValueMetric(t, s, "unit_clr", "match")
	cfg, err := s.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	for _, id := range []int64{a, b, c} {
		if err := s.ReplaceRawMetricValues(m.ID, m.Version, cfg.RuleVersion, RawScope{MatchID: id}, unitRows(float64(id))); err != nil {
			t.Fatalf("ReplaceRawMetricValues(%d): %v", id, err)
		}
	}
	if err := s.ClearMetricUnits(m.ID, []RawScope{{MatchID: c}}); err != nil {
		t.Fatalf("ClearMetricUnits(C): %v", err)
	}
	for _, id := range []int64{a, b} {
		vals, err := s.GetMetricValuesForMatch(id, []int64{m.ID})
		if err != nil {
			t.Fatalf("GetMetricValuesForMatch(%d): %v", id, err)
		}
		if len(vals) != 1 {
			t.Errorf("match %d fresh rows after clearing C = %d, want 1", id, len(vals))
		}
		ok, err := s.UnitFresh(m.ID, m.Version, m.Touched, cfg.RuleVersion, RawScope{MatchID: id})
		if err != nil || !ok {
			t.Errorf("match %d run record gone after clearing C: %v, %v", id, ok, err)
		}
	}
	if vals, _ := s.GetMetricValuesForMatch(c, []int64{m.ID}); len(vals) != 0 {
		t.Errorf("C's rows after clearing C = %d, want 0", len(vals))
	}
	if n := storedCount(t, s, m.ID); n != 2 {
		t.Errorf("stored rows after clearing C = %d, want 2", n)
	}
}

// TestLibraryWideRunReplacesWholeResult (test (c)): an unbound metric's run
// replaces its whole stored result, so a row the new result omits is gone.
func TestLibraryWideRunReplacesWholeResult(t *testing.T) {
	s, _ := openFileStore(t)
	m, err := s.CreateMetric(models.MetricRow{
		Name: "lib_whole", Title: "lib_whole", Origin: "user",
		Expr: "SELECT 'x' AS subject_key, '' AS dim, 1 AS value",
	})
	if err != nil {
		t.Fatalf("CreateMetric: %v", err)
	}
	markTouched(t, s, m.ID)
	cfg, err := s.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	one, two := 1.0, 2.0
	if err := s.ReplaceRawMetricValues(m.ID, m.Version, cfg.RuleVersion, RawScope{},
		[]RawMetricRow{{SubjectKey: "old", Value: &one}, {SubjectKey: "kept", Value: &one}}); err != nil {
		t.Fatalf("first run: %v", err)
	}
	if err := s.ReplaceRawMetricValues(m.ID, m.Version, cfg.RuleVersion, RawScope{},
		[]RawMetricRow{{SubjectKey: "kept", Value: &two}}); err != nil {
		t.Fatalf("second run: %v", err)
	}
	if n := storedCount(t, s, m.ID); n != 1 {
		t.Fatalf("stored rows after the library-wide re-run = %d, want 1 (whole result replaced)", n)
	}
	res, err := s.QueryWrite(t.Context(),
		`SELECT subject_key, value FROM metric_values WHERE metric_id = ?`, []any{m.ID}, 10)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(res.Rows) != 1 || res.Rows[0][0] != "kept" || res.Rows[0][1] != 2.0 {
		t.Errorf("rows after re-run = %v, want [kept 2]", res.Rows)
	}
}
