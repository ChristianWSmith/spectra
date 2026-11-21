package metrics

import (
	"context"
	"reflect"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// unitMatch is a minimal match with n players (one per row of the players
// table), so a per-match count tells the matches apart.
func unitMatch(n int) *models.ExtractedMatch {
	em := &models.ExtractedMatch{
		Match: models.Match{Map: "de_dust2", TickRate: 64},
	}
	for i := 0; i < n; i++ {
		id := string(rune('1' + i))
		em.Players = append(em.Players, models.Player{SteamID: "7656119800000000" + id, Name: "p" + id, Side: "ct"})
	}
	return em
}

// unitValues reads one match's fresh stored values for a metric.
func unitValues(t *testing.T, st *store.Store, matchID, metricID int64) []models.MetricValue {
	t.Helper()
	vals, err := st.GetMetricValuesForMatch(matchID, []int64{metricID})
	if err != nil {
		t.Fatalf("GetMetricValuesForMatch(%d): %v", matchID, err)
	}
	return vals
}

// TestImportingMatchLeavesOtherMatchesFresh (test (a) and (b)): a sweep that
// computes a newly imported match C leaves matches A and B's match-scope values
// fresh and unchanged, both while the sweep runs and after it, and deletes none
// of their rows.
func TestImportingMatchLeavesOtherMatchesFresh(t *testing.T) {
	st := combatStore(t)
	expr := "SELECT steam_id AS subject_key, '' AS dim, COUNT(*) AS value FROM players WHERE match_id = :match_id GROUP BY steam_id"
	g, perr, err := CheckRawSave(st, expr)
	if err != nil || perr != nil {
		t.Fatalf("CheckRawSave: perr=%v err=%v", perr, err)
	}
	m, err := st.CreateMetric(models.MetricRow{
		Name: "unit_players", Title: "unit_players", Expr: expr,
		Scope: RawScopeOf(g.Binds), Origin: "user", Touched: g.Touched,
	})
	if err != nil {
		t.Fatalf("CreateMetric: %v", err)
	}
	a := saveCombatMatch(t, st, "unit-sweep-a", unitMatch(2))
	b := saveCombatMatch(t, st, "unit-sweep-b", unitMatch(2))
	if _, err := Sweep(context.Background(), st, nil, nil); err != nil {
		t.Fatalf("Sweep (A, B): %v", err)
	}
	beforeA := unitValues(t, st, a, m.ID)
	beforeB := unitValues(t, st, b, m.ID)
	if len(beforeA) != 2 || len(beforeB) != 2 {
		t.Fatalf("A, B fresh rows = %d, %d; want 2 each", len(beforeA), len(beforeB))
	}

	// The import of C: a new match whose unit has never been computed.
	c := saveCombatMatch(t, st, "unit-sweep-c", unitMatch(3))
	check := func(when string) {
		t.Helper()
		if got := unitValues(t, st, a, m.ID); !reflect.DeepEqual(got, beforeA) {
			t.Errorf("%s: match A's values changed: %v, want %v", when, got, beforeA)
		}
		if got := unitValues(t, st, b, m.ID); !reflect.DeepEqual(got, beforeB) {
			t.Errorf("%s: match B's values changed: %v, want %v", when, got, beforeB)
		}
	}
	res, err := Sweep(context.Background(), st, func(SweepProgress) { check("during the sweep") }, nil)
	if err != nil {
		t.Fatalf("Sweep (C): %v", err)
	}
	if len(res.Failed) != 0 {
		t.Fatalf("sweep failures: %v", res.Failed)
	}
	check("after the sweep")
	if got := unitValues(t, st, c, m.ID); len(got) != 3 {
		t.Errorf("C's fresh rows = %d, want 3", len(got))
	}
	cfg, err := st.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	// A's and B's run records were never reset by C's sweep.
	for _, id := range []int64{a, b} {
		ok, err := st.UnitFresh(m.ID, m.Version, g.Touched, cfg.RuleVersion, store.RawScope{MatchID: id})
		if err != nil || !ok {
			t.Errorf("match %d run record reset by C's sweep: %v, %v", id, ok, err)
		}
	}
	cov, err := st.MetricCoverage(cfg.RuleVersion)
	if err != nil {
		t.Fatalf("MetricCoverage: %v", err)
	}
	for _, c0 := range cov {
		if c0.MetricID == m.ID && (c0.Behind || len(c0.BehindMatches) != 0) {
			t.Errorf("metric behind after the sweep: %+v", c0)
		}
	}
}
