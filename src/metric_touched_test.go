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
		Name: "touched_kills", Expr: "from player_stats: sum(kills)", Scope: "match",
	})
	if err != nil {
		t.Fatalf("SaveMetric: %v", err)
	}
	got, err := f.st.GetMetric(saved.ID)
	if err != nil {
		t.Fatal(err)
	}
	// players: the humans-only lookup every subject statement carries.
	if want := []string{"player_stats", "players"}; !reflect.DeepEqual(got.Touched, want) {
		t.Fatalf("touched = %v, want %v", got.Touched, want)
	}

	// An edit re-derives: a rounds-denominator rate reads rounds at match
	// scope (the sweep's per-match statement).
	got.Expr = "from player_stats: sum(total_damage)"
	got.Denominator = "rounds"
	if _, err := svc.SaveMetric(got); err != nil {
		t.Fatalf("SaveMetric(edit): %v", err)
	}
	got, _ = f.st.GetMetric(saved.ID)
	if want := []string{"player_round_stats", "player_stats", "players"}; !reflect.DeepEqual(got.Touched, want) {
		t.Fatalf("edited touched = %v, want %v", got.Touched, want)
	}

	// A dependent reads stored values through metric(); that adds no table.
	dep, err := svc.SaveMetric(models.MetricRow{
		Name: "touched_dep", Expr: "from events: count(), metric('touched_kills')", Scope: "match",
	})
	if err != nil {
		t.Fatalf("SaveMetric(dep): %v", err)
	}
	depRow, _ := f.st.GetMetric(dep.ID)
	wantDep := depRow.Touched
	if !reflect.DeepEqual(wantDep, []string{"events", "players"}) {
		t.Fatalf("dependent touched = %v (stored values are reached through metric(), never a touched table)", wantDep)
	}
	got.Name = "touched_kills_renamed"
	if _, err := svc.SaveMetric(got); err != nil {
		t.Fatalf("SaveMetric(rename): %v", err)
	}
	depRow, _ = f.st.GetMetric(dep.ID)
	if !reflect.DeepEqual(depRow.Touched, wantDep) {
		t.Fatalf("dependent touched after rename = %v, want %v", depRow.Touched, wantDep)
	}

	// Plugin rows are never derived by the gate; an upsert clears a set
	// derived from the expression it replaces.
	if err := f.st.ReplacePluginMetrics("p", []store.PluginMetricDef{{Name: "touched_dep", Expr: "from rounds: count()"}}); err != nil {
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
		Name: "refused", Expr: "from player_stats: sum(kills), metric('no_such_metric')", Scope: "match",
	}); err == nil {
		t.Fatal("a metric() to a missing metric saved")
	}
	if _, err := f.st.GetMetricByName("refused"); err == nil {
		t.Fatal("refused metric row exists")
	}
}
