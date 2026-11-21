package store

import (
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// Import freshness for the per-player profile metrics (dogfood/PLAN.md ruling
// 48). An import of one match marks behind only that match's players for the
// profile metrics it feeds, and leaves every other player's career values
// fresh. The chain runs match-bound per-match metric -> metric_deps ->
// :steam_id career metric, through the scope-aware cascade (B4).

// profileRewrittenNames are the library-wide profile metrics ruling 48
// converted to per-player metrics. side_adr is not among them: its snapshot
// values differ by the ratified damage-basis change (Q7), so it stays
// library-wide until that is settled.
var profileRewrittenNames = []string{
	"career_adr", "career_clutch_win_rate", "career_clutches", "career_kast", "career_matches",
	"career_mvps", "career_opener_wins", "career_opening_rate", "career_openings", "career_trade_rate",
	"map_adr", "map_kd", "map_matches", "map_win_pct", "map_wins", "side_kast", "side_kd",
	"side_rounds", "side_win_pct", "weapon_damage", "weapon_headshots", "weapon_kills", "win_pct",
}

// setBuiltinTouched gives every builtin the touched set the sweep's first pass
// would store (the statement's tables, plus metric_values when it reads a
// metric() reference), so the write-side hook sees the builtins as roots.
func setBuiltinTouched(t *testing.T, s *Store) {
	t.Helper()
	rows, err := s.db.Query(`SELECT id, expr FROM metrics WHERE origin = 'builtin'`)
	if err != nil {
		t.Fatalf("builtins: %v", err)
	}
	type row struct {
		id   int64
		expr string
	}
	var all []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.expr); err != nil {
			rows.Close()
			t.Fatalf("scan: %v", err)
		}
		all = append(all, r)
	}
	rows.Close()
	for _, r := range all {
		st, gerr := AnalyzeMetricSQL(r.expr, nil)
		if gerr != nil {
			t.Fatalf("builtin %d does not pass the gate: %s", r.id, gerr.Message)
		}
		touched := st.Touched
		if len(st.Refs) > 0 {
			touched = append(touched, "metric_values")
		}
		if err := s.SetMetricTouched(r.id, touched); err != nil {
			t.Fatalf("SetMetricTouched: %v", err)
		}
	}
}

// saveMatchPlayers writes the match's roster (the players rows the write-side
// hook fans out over).
func saveMatchPlayers(t *testing.T, s *Store, matchID int64, steamIDs ...string) {
	t.Helper()
	em := &models.ExtractedMatch{}
	for _, p := range steamIDs {
		em.Players = append(em.Players, models.Player{MatchID: matchID, SteamID: p, Name: p})
	}
	if err := s.SaveExtracted(matchID, em); err != nil {
		t.Fatalf("SaveExtracted: %v", err)
	}
}

func TestImportMarksOnlyMatchPlayersBehindForProfileMetrics(t *testing.T) {
	s := mustOpenMemory(t)
	cfg, err := s.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	live := cfg.RuleVersion
	setBuiltinTouched(t, s)

	const a, b, c = "76561198000000001", "76561198000000002", "76561198000000003"
	m1 := seedReadyMatch(t, s, "prof-fresh-1")
	saveMatchPlayers(t, s, m1, a, b)
	m2 := seedReadyMatch(t, s, "prof-fresh-2")
	// Before the import under test: a sweep has run, so every player's career
	// run is fresh. Simulated by stamping each career unit at the live versions.
	type metricRef struct {
		id      int64
		version int
		touched []string
	}
	refs := map[string]metricRef{}
	for _, name := range profileRewrittenNames {
		m, err := s.GetMetricByName(name)
		if err != nil {
			t.Fatalf("GetMetricByName(%s): %v", name, err)
		}
		st, gerr := AnalyzeMetricSQL(m.Expr, nil)
		if gerr != nil {
			t.Fatalf("%s does not pass the gate: %s", name, gerr.Message)
		}
		touched := st.Touched
		if len(st.Refs) > 0 {
			touched = append(touched, "metric_values")
		}
		refs[name] = metricRef{m.ID, m.Version, touched}
		for _, p := range []string{a, b, c} {
			if err := s.ReplaceRawMetricValues(m.ID, m.Version, live, RawScope{SteamID: p}, nil); err != nil {
				t.Fatalf("stamp %s for %s: %v", name, p, err)
			}
		}
	}
	behind := func(name, p string) bool {
		r := refs[name]
		fresh, err := s.UnitFresh(r.id, r.version, r.touched, live, RawScope{SteamID: p})
		if err != nil {
			t.Fatalf("UnitFresh(%s, %s): %v", name, p, err)
		}
		return !fresh
	}
	for _, name := range profileRewrittenNames {
		for _, p := range []string{a, b, c} {
			if behind(name, p) {
				t.Fatalf("%s for %s is behind before the import", name, p)
			}
		}
	}

	// The import under test: match 2 has players b and c only.
	saveMatchPlayers(t, s, m2, b, c)

	for _, name := range profileRewrittenNames {
		if behind(name, a) {
			t.Errorf("%s for player a (not in match 2) went behind, want fresh", name)
		}
		if !behind(name, b) {
			t.Errorf("%s for player b (in match 2) stayed fresh, want behind", name)
		}
		if !behind(name, c) {
			t.Errorf("%s for player c (in match 2) stayed fresh, want behind", name)
		}
	}
}
