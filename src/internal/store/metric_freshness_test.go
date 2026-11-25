package store

import (
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// Freshness at the store: unknown touched sets read
// behind, raw runs are covered by their run records, and the builtins'
// touched sets are derived at Open through the statement gate.

// TestUnknownTouchedReadsBehind: a metric whose touched set is unknown (”)
// is never fresh, even with rows stamped at the live versions. Once its set
// is known, the same rows read fresh.
func TestUnknownTouchedReadsBehind(t *testing.T) {
	s := mustOpenMemory(t)
	cfg, err := s.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	live := cfg.RuleVersion
	matchID := seedReadyMatch(t, s, "unknown-touched")
	m, err := s.CreateMetric(models.MetricRow{
		Name: "unknown_touched", Title: "unknown_touched",
		Expr: rawCountSQL("events", "match"), Origin: "user",
	})
	if err != nil {
		t.Fatalf("CreateMetric: %v", err)
	}
	if err := s.InsertMetricValues(m.ID, m.Version, live, []MetricValueRow{
		{MatchID: matchID, SubjectKey: "76561198000000001", Value: 1},
	}); err != nil {
		t.Fatalf("InsertMetricValues: %v", err)
	}
	stampRun(t, s, m.ID, matchID, m.Version, live)
	if c := coverageOf(t, s, m.ID, live); !c.Behind || c.FreshRows != 1 {
		t.Fatalf("unknown touched = %+v, want behind with its row counted", c)
	}
	markTouched(t, s, m.ID)
	if c := coverageOf(t, s, m.ID, live); c.Behind {
		t.Fatalf("known touched = %+v, want fresh", c)
	}
}

// TestRawRunRecordsCoverTheirUnits: a raw run with zero rows is covered by
// its run record (fresh, no row), a version bump makes it behind, and a
// library-wide raw metric never reads behind after its own run.
func TestRawRunRecordsCoverTheirUnits(t *testing.T) {
	s := mustOpenMemory(t)
	cfg, err := s.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	live := cfg.RuleVersion
	m, err := s.CreateMetric(models.MetricRow{
		Name: "lib_raw", Title: "lib_raw", Origin: "user",
		Expr:    "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE 1 = 0",
		Touched: []string{"events"},
	})
	if err != nil {
		t.Fatalf("CreateMetric: %v", err)
	}
	if c := coverageOf(t, s, m.ID, live); c.Behind {
		t.Fatalf("empty library = %+v, want not behind (no unit yet)", c)
	}
	seedReadyMatch(t, s, "lib-raw")
	if c := coverageOf(t, s, m.ID, live); !c.Behind {
		t.Fatalf("never run on a ready library = %+v, want behind", c)
	}
	if err := s.ReplaceRawMetricValues(m.ID, m.Version, live, RawScope{}, nil); err != nil {
		t.Fatalf("ReplaceRawMetricValues: %v", err)
	}
	if c := coverageOf(t, s, m.ID, live); c.Behind || c.FreshRows != 0 {
		t.Fatalf("after a zero-row library run = %+v, want fresh with no rows", c)
	}
	if _, err := s.db.Exec(`UPDATE metrics SET version = version + 1 WHERE id = ?`, m.ID); err != nil {
		t.Fatalf("bump: %v", err)
	}
	if c := coverageOf(t, s, m.ID, live); !c.Behind {
		t.Fatalf("after a version bump = %+v, want behind", c)
	}
}

// TestRawRoundScopeCoveredWhenMatchHasNoRounds: a ready match with no round
// rows contributes no round unit, so a round-grain raw metric reads no-data
// (fresh, no row) for it, not behind. A round that does exist needs its own
// run record.
func TestRawRoundScopeCoveredWhenMatchHasNoRounds(t *testing.T) {
	s := mustOpenMemory(t)
	cfg, err := s.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	live := cfg.RuleVersion
	bare := seedReadyMatch(t, s, "no-rounds")
	m, err := s.CreateMetric(models.MetricRow{
		Name: "round_raw", Title: "round_raw", Origin: "user",
		Expr:    "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM rounds WHERE match_id = :match_id AND number = :round",
		Touched: []string{"rounds"},
	})
	if err != nil {
		t.Fatalf("CreateMetric: %v", err)
	}
	if c := coverageOf(t, s, m.ID, live); c.Behind {
		t.Fatalf("ready match with no rounds = %+v, want no-data (not behind)", c)
	}
	if _, err := s.db.Exec(`INSERT INTO rounds (match_id, number) VALUES (?, 1)`, bare); err != nil {
		t.Fatalf("insert round: %v", err)
	}
	if c := coverageOf(t, s, m.ID, live); !c.Behind {
		t.Fatalf("round with no run record = %+v, want behind", c)
	}
	if err := s.ReplaceRawMetricValues(m.ID, m.Version, live, RawScope{MatchID: bare, Round: 1}, nil); err != nil {
		t.Fatalf("ReplaceRawMetricValues: %v", err)
	}
	if c := coverageOf(t, s, m.ID, live); c.Behind {
		t.Fatalf("round after its run = %+v, want fresh", c)
	}
}

// TestBuiltinsDeriveTouchedAtOpen: every builtin is stored with the touched
// set the statement gate derives from its own SQL, the set is never empty
// (every builtin reads a table), and it is derived at Open, before any sweep.
func TestBuiltinsDeriveTouchedAtOpen(t *testing.T) {
	s := mustOpenMemory(t)
	all, err := s.ListMetrics()
	if err != nil {
		t.Fatalf("ListMetrics: %v", err)
	}
	n := 0
	for _, m := range all {
		if m.Origin != "builtin" {
			continue
		}
		n++
		if len(m.Touched) == 0 {
			t.Errorf("builtin %s has no touched set after Open", m.Name)
			continue
		}
		st, gerr := AnalyzeMetricSQL(m.RunExpr, nil)
		if gerr != nil {
			t.Errorf("builtin %s is refused by the gate: %s", m.Name, gerr.Message)
			continue
		}
		if !equalStrings(m.Touched, StoredTouched(st.Touched, len(st.Refs) > 0)) {
			t.Errorf("builtin %s touched = %v, gate derives %v", m.Name, m.Touched, st.Touched)
		}
	}
	if n != 147 {
		t.Fatalf("builtins = %d, want 147 (127 + raw_player_round_deaths, ruling 41, + 18 per-match seeds, ruling 48, + match_side_dmg, ruling 49)", n)
	}
	tr, err := s.GetMetricByName("trade_rate")
	if err != nil {
		t.Fatalf("GetMetricByName: %v", err)
	}
	// The bot guard is the is_bot_key predicate (a function of steam_id), so the
	// statement no longer reads the players table.
	if !equalStrings(tr.Touched, []string{"match_trade_opps", "player_stats"}) {
		t.Fatalf("trade_rate touched = %v", tr.Touched)
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func mustOpenMemory(t *testing.T) *Store {
	t.Helper()
	s, err := Open(":memory:")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}
