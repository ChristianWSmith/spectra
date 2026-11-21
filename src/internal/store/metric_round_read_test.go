package store

import "testing"

// TestGetMetricValuesForRoundScopesToOneRound pins the round-grain read: a
// round's fresh rows come back for that round only, never another round's,
// never a match-grain row, and an absent round reads nothing (a dash, never
// a zero). The match read must in turn never see a round-grain row
// (scope_round = 0 on the match read).
func TestGetMetricValuesForRoundScopesToOneRound(t *testing.T) {
	s, _ := openFileStore(t)
	t.Cleanup(func() { _ = s.CloseRO() })
	cfg, err := s.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	live := cfg.RuleVersion
	match := seedReadyMatch(t, s, "round-read")
	m := seedOrderMetric(t, s, "round_side_probe", "builtin")

	for _, round := range []int{1, 2} {
		val := float64(round * 10)
		if err := s.ReplaceRawMetricValues(m.ID, m.Version, live, RawScope{MatchID: match, Round: round}, []RawMetricRow{
			{SubjectKey: "ct", Value: &val, RowJSON: "{}"},
		}); err != nil {
			t.Fatalf("store round %d: %v", round, err)
		}
	}
	// A match-grain row for the same match must never appear in a round read.
	if err := s.InsertMetricValues(m.ID, m.Version, live, []MetricValueRow{
		{MatchID: match, SubjectKey: "t", Value: 99},
	}); err != nil {
		t.Fatalf("insert match row: %v", err)
	}

	rows, err := s.GetMetricValuesForRound(match, 2, nil)
	if err != nil {
		t.Fatalf("GetMetricValuesForRound: %v", err)
	}
	if len(rows) != 1 || rows[0].SubjectKey != "ct" || rows[0].Value == nil || *rows[0].Value != 20 {
		t.Fatalf("round 2 rows = %+v, want one ct row valued 20", rows)
	}
	none, err := s.GetMetricValuesForRound(match, 7, nil)
	if err != nil {
		t.Fatalf("absent round: %v", err)
	}
	if len(none) != 0 {
		t.Fatalf("absent round rows = %+v, want none", none)
	}
	if _, err := s.GetMetricValuesForRound(0, 1, nil); err == nil {
		t.Error("match 0 accepted, want the match-id guard")
	}
	if _, err := s.GetMetricValuesForRound(match, 0, nil); err == nil {
		t.Error("round 0 accepted, want the round guard")
	}

	// The match read sees the match row only, never the round rows.
	mrows, err := s.GetMetricValuesForMatch(match, nil)
	if err != nil {
		t.Fatalf("GetMetricValuesForMatch: %v", err)
	}
	if len(mrows) != 1 || mrows[0].SubjectKey != "t" {
		t.Fatalf("match rows = %+v, want only the match-grain t row", mrows)
	}
}
