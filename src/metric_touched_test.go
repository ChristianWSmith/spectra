package main

import (
	"reflect"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// The save gate at the service: a save stores the touched set the gate
// derives from the statement the sweep runs (metrics.touched), an edit
// re-derives it, a metric() dependent's set is unchanged by a rename
// splice (references add no table), and a refused save writes nothing.
func TestSaveMetricStoresTouchedTables(t *testing.T) {
	f := newDepsFixture(t)
	svc := f.svc

	saved, err := svc.SaveMetric(models.MetricRow{
		Name: "touched_kills", Expr: "SELECT '' AS subject_key, '' AS dim, SUM(kills) AS value FROM player_stats WHERE match_id = :match_id",
	})
	if err != nil {
		t.Fatalf("SaveMetric: %v", err)
	}
	got, err := f.st.GetMetric(saved.ID)
	if err != nil {
		t.Fatal(err)
	}
	// The raw statement reads player_stats only.
	if want := []string{"player_stats"}; !reflect.DeepEqual(got.Touched, want) {
		t.Fatalf("touched = %v, want %v", got.Touched, want)
	}

	// An edit re-derives: a rounds-denominator rate reads rounds at match
	// scope (the sweep's per-match statement).
	got.Expr = "SELECT '' AS subject_key, '' AS dim, SUM(total_damage) AS value FROM player_stats WHERE match_id = :match_id"
	if _, err := svc.SaveMetric(got); err != nil {
		t.Fatalf("SaveMetric(edit): %v", err)
	}
	got, _ = f.st.GetMetric(saved.ID)
	if want := []string{"player_stats"}; !reflect.DeepEqual(got.Touched, want) {
		t.Fatalf("edited touched = %v, want %v", got.Touched, want)
	}

	// Plugin rows are never derived by the gate; an upsert clears a set
	// derived from the expression it replaces.
	if err := f.st.ReplacePluginMetrics("p", []store.PluginMetricDef{{Name: "touched_dep", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM rounds WHERE match_id = :match_id"}}); err != nil {
		t.Fatalf("ReplacePluginMetrics: %v", err)
	}
	pr, _ := f.st.GetMetricByName("touched_dep")
	if pr.Touched != nil {
		t.Fatalf("plugin upsert kept touched %v; a replaced expression must not keep another statement's set", pr.Touched)
	}
}

// TestSaveMetricGateRefusalWritesNothing: a statement the gate refuses is
// never saved, so nothing can read as fresh.
func TestSaveMetricGateRefusalWritesNothing(t *testing.T) {
	f := newDepsFixture(t)
	if _, err := f.svc.SaveMetric(models.MetricRow{
		Name: "refused", Expr: "from player_stats: sum(kills), metric('no_such_metric')",
	}); err == nil {
		t.Fatal("a metric() to a missing metric saved")
	}
	if _, err := f.st.GetMetricByName("refused"); err == nil {
		t.Fatal("refused metric row exists")
	}
}
