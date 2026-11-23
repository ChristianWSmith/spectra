package main

import (
	"database/sql"
	"strconv"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// scopedStateOf returns one metric's GetMetricStates entry for a unit.
func scopedStateOf(t *testing.T, svc *MetricsService, scope, id string, metricID int64) MetricComputeState {
	t.Helper()
	states, err := svc.GetMetricStates(scope, id)
	if err != nil {
		t.Fatalf("GetMetricStates(%s, %s): %v", scope, id, err)
	}
	for _, s := range states {
		if s.MetricID == metricID {
			return s
		}
	}
	t.Fatalf("metric %d missing from %s %s states", metricID, scope, id)
	return MetricComputeState{}
}

// dropRun removes one unit's run record, making that unit behind.
func dropRun(t *testing.T, path string, metricID int64, where string, arg any) {
	t.Helper()
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open conn: %v", err)
	}
	defer func() { _ = db.Close() }()
	q := `DELETE FROM metric_runs WHERE metric_id = ? AND ` + where
	if _, err := db.Exec(q, metricID, arg); err != nil {
		t.Fatalf("delete run record: %v", err)
	}
}

// TestMatchStateIsPerMatch: a per-match metric behind for match one and fresh
// for match two reads behind for one and fresh for two through GetMetricStates,
// while the library word stays behind (any match behind). The scoped read
// answers the requested unit only.
func TestMatchStateIsPerMatch(t *testing.T) {
	f := newSeededFixture(t)
	m := f.save(t, models.MetricRow{
		Name: "match_state_per_match",
		Expr: "SELECT steam_id AS subject_key, '' AS dim, :match_id AS value FROM players WHERE match_id = :match_id AND is_bot = 0",
	})
	if _, err := f.svc.runSweep(t.Context(), nil); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	ids := readyMatchIDs(t, f.st)
	if len(ids) < 2 {
		t.Fatalf("need two ready matches, have %v", ids)
	}
	one, two := ids[0], ids[1]
	oneID, twoID := strconv.FormatInt(one, 10), strconv.FormatInt(two, 10)
	if s := scopedStateOf(t, f.svc, "match", oneID, m.ID); s.State != MetricStateFresh {
		t.Fatalf("match one before the stale run: state = %q, want fresh", s.State)
	}

	dropRun(t, f.path, m.ID, "match_id = ?", one)

	if s := scopedStateOf(t, f.svc, "match", oneID, m.ID); s.State != MetricStateBehind {
		t.Errorf("match one (behind) state = %q, want behind", s.State)
	}
	if s := scopedStateOf(t, f.svc, "match", twoID, m.ID); s.State != MetricStateFresh {
		t.Errorf("match two (fresh) state = %q, want fresh", s.State)
	}
	// The library word is unchanged: any match behind makes it behind.
	if s := stateOf(t, f.svc, m.ID); s.State != MetricStateBehind {
		t.Errorf("library word = %q, want behind (any match behind)", s.State)
	}
	if _, err := f.svc.GetMetricStates("round", twoID); err == nil {
		t.Error("an unknown scope was accepted")
	}
}

// TestPlayerStateIsPerPlayer: a career metric behind for one player and fresh
// for the others reads per player through GetMetricStates("player", steam).
func TestPlayerStateIsPerPlayer(t *testing.T) {
	f := newSeededFixture(t)
	m := f.save(t, models.MetricRow{
		Name:  "player_state_career",
		Expr:  "SELECT :steam_id AS subject_key, '' AS dim, COUNT(*) AS value FROM players WHERE steam_id = :steam_id AND is_bot = 0",
		Scope: "profile",
	})
	if _, err := f.svc.runSweep(t.Context(), nil); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	res, err := f.st.RunReadOnly(`SELECT DISTINCT steam_id FROM players WHERE is_bot = 0 ORDER BY steam_id`, nil, 100, 5000)
	if err != nil {
		t.Fatalf("humans: %v", err)
	}
	if len(res.Rows) < 2 {
		t.Fatalf("need two human players, have %d", len(res.Rows))
	}
	behindSteam, _ := res.Rows[0][0].(string)
	freshSteam, _ := res.Rows[1][0].(string)

	dropRun(t, f.path, m.ID, "match_id = 0 AND scope_steam_id = ?", behindSteam)

	if s := scopedStateOf(t, f.svc, "player", behindSteam, m.ID); s.State != MetricStateBehind {
		t.Errorf("behind player state = %q, want behind", s.State)
	}
	if s := scopedStateOf(t, f.svc, "player", freshSteam, m.ID); s.State != MetricStateFresh {
		t.Errorf("fresh player state = %q, want fresh", s.State)
	}
}
