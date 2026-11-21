package metrics

import (
	"context"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// TestRawScopesReadFreshAfterOneSweep: raw metrics saved the way a user
// saves them (CheckRawSave's touched set, RawScopeOf's scope) are fresh after
// one sweep in every scope shape: library-wide (including a statement that
// returns no rows), :steam_id, :match_id and :match_id with :round. A
// library-wide metric is not behind after its own run,
// and a version bump makes it behind again.
func TestRawScopesReadFreshAfterOneSweep(t *testing.T) {
	st, _ := characterizationFixture(t)
	ctx := context.Background()
	saved := map[string]int64{}
	for name, expr := range map[string]string{
		"fresh_lib_count": "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events",
		"fresh_lib_empty": "SELECT '' AS subject_key, '' AS dim, 1.0 AS value FROM events WHERE 1 = 0",
		"fresh_steam":     "SELECT steam_id AS subject_key, '' AS dim, SUM(entry_kills) AS value FROM player_stats WHERE steam_id = :steam_id GROUP BY steam_id",
		"fresh_match":     "SELECT steam_id AS subject_key, '' AS dim, SUM(entry_kills) AS value FROM player_stats WHERE match_id = :match_id GROUP BY steam_id",
		"fresh_round":     "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM rounds WHERE match_id = :match_id AND number = :round",
	} {
		g, perr, err := CheckRawSave(st, expr)
		if err != nil || perr != nil {
			t.Fatalf("CheckRawSave(%s): perr=%v err=%v", name, perr, err)
		}
		m, err := st.CreateMetric(models.MetricRow{
			Name: name, Title: name, Expr: expr,
			Origin: "user", Touched: g.Touched,
		})
		if err != nil {
			t.Fatalf("CreateMetric(%s): %v", name, err)
		}
		saved[name] = m.ID
	}
	if _, err := Sweep(ctx, st, nil, nil); err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	cfg, err := st.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	cov, err := st.MetricCoverage(cfg.RuleVersion)
	if err != nil {
		t.Fatalf("MetricCoverage: %v", err)
	}
	byID := map[int64]store.MetricCoverage{}
	for _, c := range cov {
		byID[c.MetricID] = c
	}
	for name, id := range saved {
		if byID[id].Behind {
			t.Errorf("%s reads behind after its sweep (fresh rows %d)", name, byID[id].FreshRows)
		}
	}
	if byID[saved["fresh_lib_count"]].FreshRows == 0 {
		t.Errorf("library-wide count stored no rows")
	}

	// The version axis still applies: a definition bump makes it behind.
	row, err := st.GetMetric(saved["fresh_lib_count"])
	if err != nil {
		t.Fatalf("GetMetric: %v", err)
	}
	if _, err := st.SaveMetricWithDeps(row, nil, nil, true); err != nil {
		t.Fatalf("SaveMetricWithDeps (semantic bump): %v", err)
	}
	cov, err = st.MetricCoverage(cfg.RuleVersion)
	if err != nil {
		t.Fatalf("MetricCoverage after bump: %v", err)
	}
	for _, c := range cov {
		if c.MetricID == saved["fresh_lib_count"] && !c.Behind {
			t.Errorf("library-wide metric not behind after its version bump")
		}
	}
}
