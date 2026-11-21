package store

import "testing"

// (d) A change to a referenced metric x marks the statement that reads
// metric('x') behind for the changed match only (scope-aware cascade,
// dogfood/PLAN.md B4 and ruling 20).
func TestMetricRefChangeMarksReaderBehindForOneMatch(t *testing.T) {
	s := mustOpenMemory(t)
	cfg, err := s.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	live := cfg.RuleVersion
	m1 := seedReadyMatch(t, s, "ref-d1")
	m2 := seedReadyMatch(t, s, "ref-d2")
	x := touchedMetric(t, s, "ref_source_d", "match", rawMatchExpr, []string{"events"})
	y := touchedMetric(t, s, "ref_reader_d", "match",
		"SELECT subject_key, dim, value FROM metric('ref_source_d') WHERE :match_id > 0",
		[]string{"metric_values"}, "ref_source_d")

	row := []RawMetricRow{{SubjectKey: "", Dim: "", Value: ptrFloat(1)}}
	for _, mid := range []int64{m1, m2} {
		if err := s.ReplaceRawMetricValues(x.ID, x.Version, live, RawScope{MatchID: mid}, row); err != nil {
			t.Fatalf("source run %d: %v", mid, err)
		}
		if err := s.ReplaceRawMetricValues(y.ID, y.Version, live, RawScope{MatchID: mid}, row); err != nil {
			t.Fatalf("reader run %d: %v", mid, err)
		}
	}
	if rows, _ := s.GetMetricValuesForMatch(m1, []int64{y.ID}); len(rows) != 1 {
		t.Fatalf("match 1 reader rows before the change = %d, want 1", len(rows))
	}

	// Match 1's events change: the source goes behind for match 1, and the
	// reader follows it for match 1 only.
	tx, err := s.db.Begin()
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if err := markMatchWritesBehind(tx, m1, []string{"events"}, nil); err != nil {
		_ = tx.Rollback()
		t.Fatalf("markMatchWritesBehind: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if rows, _ := s.GetMetricValuesForMatch(m1, []int64{y.ID}); len(rows) != 0 {
		t.Errorf("match 1 reader rows after the change = %d, want 0 (behind)", len(rows))
	}
	if rows, _ := s.GetMetricValuesForMatch(m2, []int64{y.ID}); len(rows) != 1 {
		t.Errorf("match 2 reader rows after a match-1 change = %d, want 1 (fresh)", len(rows))
	}
}
