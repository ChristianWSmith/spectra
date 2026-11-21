package store

import (
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// Scope-aware freshness (dogfood/PLAN.md B4, 03-QUERIES.md §4-§6): the rule
// axis gates on analysis-touching metrics, a rule-value edit recalculates
// exactly the metrics that touch its analysis table (and their dependents),
// and a dependency's change marks behind only the dependents bound to the
// changed unit.

const (
	rawMatchExpr = "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id"
	rawSteamExpr = "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE attacker = :steam_id"
	rawLibExpr   = "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events"
)

// touchedMetric creates a sugar-or-raw definition with a known touched set,
// and wires its dependency edges (the service derives them from the text).
func touchedMetric(t *testing.T, s *Store, name, scope, expr string, touched []string, deps ...string) models.MetricRow {
	t.Helper()
	m := mustSaveMetricDeps(t, s, models.MetricRow{
		Name: name, Title: name, Expr: expr, Scope: scope, Origin: "user",
	}, deps)
	if err := s.SetMetricTouched(m.ID, touched); err != nil {
		t.Fatalf("SetMetricTouched(%s): %v", name, err)
	}
	return m
}

// insertFreshMatchRow stores one fresh sugar row for a match at the given
// stamps.
func insertFreshMatchRow(t *testing.T, s *Store, m models.MetricRow, matchID int64, rule int) {
	t.Helper()
	if err := s.InsertMetricValues(m.ID, m.Version, rule, []MetricValueRow{
		{MatchID: matchID, SubjectKey: "76561198000000001", Value: 1},
	}); err != nil {
		t.Fatalf("InsertMetricValues(%s): %v", m.Name, err)
	}
	stampRun(t, s, m.ID, matchID, m.Version, rule)
}

// TestFactOnlyMetricStaysFreshAcrossAnalysisCodeBump (a): an analysis code
// bump (the rule stamp moves, no value changes) marks analysis-touching
// metrics behind and leaves a fact-only metric fresh. player_stats counts as
// analysis.
func TestFactOnlyMetricStaysFreshAcrossAnalysisCodeBump(t *testing.T) {
	s := mustOpenMemory(t)
	cfg, err := s.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	live := cfg.RuleVersion
	matchID := seedReadyMatch(t, s, "scope-a")
	facts := touchedMetric(t, s, "facts_only", "match", rawCountSQL("events", "match"), []string{"events", "matches", "players"})
	analysis := touchedMetric(t, s, "analysis_touch", "match", rawCountSQL("events", "match"), []string{"player_stats", "players"})
	insertFreshMatchRow(t, s, facts, matchID, live)
	insertFreshMatchRow(t, s, analysis, matchID, live)
	if c := coverageOf(t, s, facts.ID, live); c.Behind {
		t.Fatalf("before the bump: fact-only = %+v, want fresh", c)
	}

	bumped := live + 1 // an analysis code bump: the stamp moves, nothing else
	if c := coverageOf(t, s, facts.ID, bumped); c.Behind || c.FreshRows != 1 {
		t.Errorf("fact-only across the bump = %+v, want fresh with its row", c)
	}
	if c := coverageOf(t, s, analysis.ID, bumped); !c.Behind || c.FreshRows != 0 {
		t.Errorf("analysis-touching across the bump = %+v, want behind", c)
	}
}

// TestRuleValueEditRecalculatesExactlyTheAffected (b): an edit to one rule
// value makes behind the metrics that touch that rule's analysis table and
// their dependents through metric_deps, and nothing else. The rows of the
// untouched analysis metric are restamped, so they stay fresh.
func TestRuleValueEditRecalculatesExactlyTheAffected(t *testing.T) {
	type fixture struct {
		s                   *Store
		live                int
		trade, tradeDep     models.MetricRow
		eco, facts, distOne models.MetricRow
		matchID             int64
	}
	build := func(t *testing.T) fixture {
		s := mustOpenMemory(t)
		cfg, err := s.GetConfig()
		if err != nil {
			t.Fatalf("GetConfig: %v", err)
		}
		f := fixture{s: s, live: cfg.RuleVersion}
		f.matchID = seedReadyMatch(t, s, "scope-b")
		f.trade = touchedMetric(t, s, "trade_kills_rate", "match", rawCountSQL("player_stats", "match"), []string{"player_stats", "players"})
		f.tradeDep = touchedMetric(t, s, "trade_dependent", "match", rawCountSQL("events", "match"),
			[]string{"events"}, "trade_kills_rate")
		f.eco = touchedMetric(t, s, "eco_class", "match", rawCountSQL("round_classifications", "match"), []string{"round_classifications"})
		f.facts = touchedMetric(t, s, "events_count", "match", rawCountSQL("events", "match"), []string{"events"})
		f.distOne = touchedMetric(t, s, "trade_opps", "match", rawCountSQL("match_trade_opps", "match"), []string{"match_trade_opps"})
		for _, m := range []models.MetricRow{f.trade, f.tradeDep, f.eco, f.facts, f.distOne} {
			insertFreshMatchRow(t, s, m, f.matchID, f.live)
		}
		return f
	}
	// edit stores the rules with one value changed and the rule stamp bumped,
	// as AnalyticsService.SetConfig does.
	edit := func(t *testing.T, f fixture, change func(*models.AnalysisConfig)) {
		t.Helper()
		cur, err := f.s.GetConfig()
		if err != nil {
			t.Fatalf("GetConfig: %v", err)
		}
		next := cur
		change(&next)
		next.RuleVersion = cur.RuleVersion + 1
		if _, err := f.s.SetConfig(next); err != nil {
			t.Fatalf("SetConfig: %v", err)
		}
	}

	t.Run("trade window reaches player_stats, engagements and their dependents", func(t *testing.T) {
		f := build(t)
		edit(t, f, func(c *models.AnalysisConfig) { c.TradeWindowS += 1 })
		next := f.live + 1
		for _, tc := range []struct {
			m      models.MetricRow
			behind bool
		}{
			{f.trade, true}, {f.tradeDep, true}, // the table and its dependent
			{f.eco, false}, {f.facts, false}, {f.distOne, false}, // nothing else moves
		} {
			if c := coverageOf(t, f.s, tc.m.ID, next); c.Behind != tc.behind {
				t.Errorf("%s behind = %v, want %v (%+v)", tc.m.Name, c.Behind, tc.behind, c)
			}
		}
	})

	t.Run("eco threshold reaches the round classes only", func(t *testing.T) {
		f := build(t)
		edit(t, f, func(c *models.AnalysisConfig) { c.EcoForce -= 1000 })
		next := f.live + 1
		for _, tc := range []struct {
			m      models.MetricRow
			behind bool
		}{
			{f.eco, true}, {f.trade, false}, {f.tradeDep, false}, {f.facts, false}, {f.distOne, false},
		} {
			if c := coverageOf(t, f.s, tc.m.ID, next); c.Behind != tc.behind {
				t.Errorf("%s behind = %v, want %v (%+v)", tc.m.Name, c.Behind, tc.behind, c)
			}
		}
	})

	t.Run("trade-opportunity distance reaches match_trade_opps only", func(t *testing.T) {
		f := build(t)
		edit(t, f, func(c *models.AnalysisConfig) { c.TradeOppDistance += 100 })
		next := f.live + 1
		for _, tc := range []struct {
			m      models.MetricRow
			behind bool
		}{
			{f.distOne, true}, {f.trade, false}, {f.tradeDep, false}, {f.eco, false}, {f.facts, false},
		} {
			if c := coverageOf(t, f.s, tc.m.ID, next); c.Behind != tc.behind {
				t.Errorf("%s behind = %v, want %v (%+v)", tc.m.Name, c.Behind, tc.behind, c)
			}
		}
	})
}

// TestMatchBoundChangeLeavesOtherMatchesFresh (c): a change to one match marks
// only the match-bound dependent's rows for that match. Other matches stay
// readable and fresh.
func TestMatchBoundChangeLeavesOtherMatchesFresh(t *testing.T) {
	s := mustOpenMemory(t)
	cfg, err := s.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	live := cfg.RuleVersion
	m1 := seedReadyMatch(t, s, "scope-c1")
	m2 := seedReadyMatch(t, s, "scope-c2")
	x := touchedMetric(t, s, "match_source", "match", rawMatchExpr, []string{"events"})
	d := touchedMetric(t, s, "match_dependent", "match", rawMatchExpr, []string{"events"}, "match_source")

	row := []RawMetricRow{{SubjectKey: "", Dim: "", Value: ptrFloat(1)}}
	for _, mid := range []int64{m1, m2} {
		if err := s.ReplaceRawMetricValues(x.ID, x.Version, live, RawScope{MatchID: mid}, row); err != nil {
			t.Fatalf("source run %d: %v", mid, err)
		}
		if err := s.ReplaceRawMetricValues(d.ID, d.Version, live, RawScope{MatchID: mid}, row); err != nil {
			t.Fatalf("dependent run %d: %v", mid, err)
		}
	}
	if c := coverageOf(t, s, d.ID, live); c.Behind {
		t.Fatalf("dependent after its runs = %+v, want fresh", c)
	}

	// The source changes for match 1 only.
	if err := s.ReplaceRawMetricValues(x.ID, x.Version, live, RawScope{MatchID: m1}, row); err != nil {
		t.Fatalf("source change: %v", err)
	}
	if c := coverageOf(t, s, d.ID, live); !c.Behind {
		t.Errorf("dependent after a match-1 change = %+v, want behind", c)
	}
	if rows, _ := s.GetMetricValuesForMatch(m2, []int64{d.ID}); len(rows) != 1 {
		t.Errorf("match 2's dependent rows = %d, want 1 (fresh)", len(rows))
	}
	if rows, _ := s.GetMetricValuesForMatch(m1, []int64{d.ID}); len(rows) != 0 {
		t.Errorf("match 1's dependent rows = %d, want 0 (stale rows hidden)", len(rows))
	}
	// Re-running the dependent for match 1 closes the gap.
	if err := s.ReplaceRawMetricValues(d.ID, d.Version, live, RawScope{MatchID: m1}, row); err != nil {
		t.Fatalf("dependent rerun: %v", err)
	}
	if c := coverageOf(t, s, d.ID, live); c.Behind {
		t.Errorf("dependent after its match-1 rerun = %+v, want fresh", c)
	}
}

// TestPlayerBoundChangeLeavesOtherPlayersFresh (d): a change to one player
// marks only that player's rows of a player-bound dependent.
func TestPlayerBoundChangeLeavesOtherPlayersFresh(t *testing.T) {
	s := mustOpenMemory(t)
	cfg, err := s.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	live := cfg.RuleVersion
	const p1, p2 = "76561198000000001", "76561198000000002"
	x := touchedMetric(t, s, "player_source", "profile", rawSteamExpr, []string{"events"})
	d := touchedMetric(t, s, "player_dependent", "profile", rawSteamExpr, []string{"events"}, "player_source")

	row := []RawMetricRow{{SubjectKey: "", Dim: "", Value: ptrFloat(1)}}
	for _, p := range []string{p1, p2} {
		if err := s.ReplaceRawMetricValues(x.ID, x.Version, live, RawScope{SteamID: p}, row); err != nil {
			t.Fatalf("source run: %v", err)
		}
		own := []RawMetricRow{{SubjectKey: p, Dim: "", Value: ptrFloat(2)}}
		if err := s.ReplaceRawMetricValues(d.ID, d.Version, live, RawScope{SteamID: p}, own); err != nil {
			t.Fatalf("dependent run: %v", err)
		}
	}

	if err := s.ReplaceRawMetricValues(x.ID, x.Version, live, RawScope{SteamID: p1}, row); err != nil {
		t.Fatalf("source change: %v", err)
	}
	// No ready match means no player unit to enumerate, so the freshness
	// observable here is the read surface: player 1's stale rows are hidden
	// and player 2's stay visible.
	if rows, _ := s.GetMetricValuesForPlayer(p2, []int64{d.ID}); len(rows) != 1 {
		t.Errorf("player 2's dependent rows = %d, want 1 (fresh)", len(rows))
	}
	if rows, _ := s.GetMetricValuesForPlayer(p1, []int64{d.ID}); len(rows) != 0 {
		t.Errorf("player 1's dependent rows = %d, want 0 (stale rows hidden)", len(rows))
	}
}

// TestUnboundDependentGoesBehindWhenDependencyChanges (e): a dependent with
// no binds is downstream of every unit, so any change to a dependency marks
// it behind.
func TestUnboundDependentGoesBehindWhenDependencyChanges(t *testing.T) {
	s := mustOpenMemory(t)
	cfg, err := s.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	live := cfg.RuleVersion
	m1 := seedReadyMatch(t, s, "scope-e")
	x := touchedMetric(t, s, "unit_source", "match", rawMatchExpr, []string{"events"})
	d := touchedMetric(t, s, "library_dependent", "match", rawLibExpr, []string{"events"}, "unit_source")

	row := []RawMetricRow{{SubjectKey: "", Dim: "", Value: ptrFloat(1)}}
	if err := s.ReplaceRawMetricValues(x.ID, x.Version, live, RawScope{MatchID: m1}, row); err != nil {
		t.Fatalf("source run: %v", err)
	}
	// The dependency's first run is itself a change to its unit, so the
	// dependent is read at its version after that run, as the sweep does.
	if err := s.ReplaceRawMetricValues(x.ID, x.Version, live, RawScope{MatchID: m1}, row); err != nil {
		t.Fatalf("source run: %v", err)
	}
	if err := s.ReplaceRawMetricValues(d.ID, currentVersion(t, s, d.ID), live, RawScope{}, row); err != nil {
		t.Fatalf("dependent run: %v", err)
	}
	if c := coverageOf(t, s, d.ID, live); c.Behind || c.FreshRows != 1 {
		t.Fatalf("dependent after its run = %+v, want fresh", c)
	}
	if err := s.ReplaceRawMetricValues(x.ID, x.Version, live, RawScope{MatchID: m1}, row); err != nil {
		t.Fatalf("source change: %v", err)
	}
	if c := coverageOf(t, s, d.ID, live); !c.Behind || c.FreshRows != 0 {
		t.Errorf("unbound dependent after a dependency change = %+v, want behind with its rows hidden", c)
	}
}

// TestCareerRebuildInvalidatesOnlyChangedPlayers: a per-player career metric
// keeps the values of players the rebuild did not touch.
func TestCareerRebuildInvalidatesOnlyChangedPlayers(t *testing.T) {
	s := mustOpenMemory(t)
	cfg, err := s.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	live := cfg.RuleVersion
	const p1, p2 = "76561198000000001", "76561198000000002"
	career := touchedMetric(t, s, "career_player", "profile", rawSteamExpr, []string{"events"})
	for _, p := range []string{p1, p2} {
		own := []RawMetricRow{{SubjectKey: p, Dim: "", Value: ptrFloat(1)}}
		if err := s.ReplaceRawMetricValues(career.ID, career.Version, live, RawScope{SteamID: p}, own); err != nil {
			t.Fatalf("run: %v", err)
		}
	}
	if err := s.RebuildCareerFor([]string{p1}); err != nil {
		t.Fatalf("RebuildCareerFor: %v", err)
	}
	if rows, _ := s.GetMetricValuesForPlayer(p2, []int64{career.ID}); len(rows) != 1 {
		t.Errorf("untouched player's career rows = %d, want 1", len(rows))
	}
	if rows, _ := s.GetMetricValuesForPlayer(p1, []int64{career.ID}); len(rows) != 0 {
		t.Errorf("changed player's career rows = %d, want 0", len(rows))
	}
}

func ptrFloat(v float64) *float64 { return &v }

// currentVersion reads a metric's version as the store holds it now.
func currentVersion(t *testing.T, s *Store, id int64) int {
	t.Helper()
	m, err := s.GetMetric(id)
	if err != nil {
		t.Fatalf("GetMetric(%d): %v", id, err)
	}
	return m.Version
}
