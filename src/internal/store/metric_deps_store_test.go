package store

import (
	"errors"
	"reflect"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// W2b — the metric_deps persistence surface (design §2): the atomic save
// (metric row + edges + dependent rewrites in ONE transaction) and both
// FK layers.

// mustSaveMetricDeps runs SaveMetricWithDeps, failing the test on error.
func mustSaveMetricDeps(t *testing.T, s *Store, m models.MetricRow, deps []string) models.MetricRow {
	t.Helper()
	saved, err := s.SaveMetricWithDeps(m, deps, nil)
	if err != nil {
		t.Fatalf("SaveMetricWithDeps(%q): %v", m.Name, err)
	}
	return saved
}

// TestSaveMetricDepsRoundTrip: the atomic save writes the edges it is
// handed (deduplicated — the extractor may list a name per occurrence,
// the table is a set), rewrites them wholesale on the next save, and
// never leaves an edge behind a deleted metric (metric_id's FK CASCADE).
func TestSaveMetricDepsRoundTrip(t *testing.T) {
	s, _ := openFileStore(t)
	t.Cleanup(func() { _ = s.CloseRO() })

	mustSaveMetricDeps(t, s, models.MetricRow{
		Name: "deps_up", Title: "up", Expr: "from events: count()", Scope: "match", Origin: "user",
	}, nil)
	dep := mustSaveMetricDeps(t, s, models.MetricRow{
		Name: "deps_dep", Title: "dep", Expr: "from events: metric('deps_up')",
		Scope: "match", Origin: "user",
	}, []string{"deps_up", "deps_up", "other_up"})
	got, err := s.MetricDeps(dep.ID)
	if err != nil {
		t.Fatalf("MetricDeps: %v", err)
	}
	if !reflect.DeepEqual(got, []string{"deps_up", "other_up"}) {
		t.Errorf("edges = %v, want the deduplicated set [deps_up other_up]", got)
	}

	// Wholesale rewrite: the previous edge set is replaced, not merged.
	if _, err := s.SaveMetricWithDeps(models.MetricRow{
		ID: dep.ID, Name: dep.Name, Title: dep.Title, Expr: "from events: count()",
		Scope: "match", Origin: "user",
	}, nil, nil); err != nil {
		t.Fatalf("SaveMetricWithDeps(update): %v", err)
	}
	if got, err := s.MetricDeps(dep.ID); err != nil || len(got) != 0 {
		t.Errorf("edges after a ref-free save = %v, %v; want none", got, err)
	}
	// Put the edge back (wholesale again, this time the other way) — the
	// store takes the edge list the caller derived from the expression;
	// derivation itself is the service's (design §2).
	if _, err := s.SaveMetricWithDeps(models.MetricRow{
		ID: dep.ID, Name: dep.Name, Title: dep.Title, Expr: "from events: metric('deps_up')",
		Scope: "match", Origin: "user",
	}, []string{"deps_up"}, nil); err != nil {
		t.Fatalf("SaveMetricWithDeps(restore edges): %v", err)
	}

	// FK CASCADE: deleting a metric removes ITS OWN edges (metric_deps
	// has no rows keyed to a metric id that no longer exists).
	mustSaveMetricDeps(t, s, models.MetricRow{
		Name: "deps_dep2", Title: "dep2", Expr: "from events: metric('deps_up')",
		Scope: "match", Origin: "user",
	}, []string{"deps_up"})
	if err := s.DeleteMetric(mustMetricID(t, s, "deps_dep2")); err != nil {
		t.Fatalf("DeleteMetric: %v", err)
	}
	rows, err := s.ListMetricEdges()
	if err != nil {
		t.Fatalf("ListMetricEdges: %v", err)
	}
	if _, ok := rows["deps_dep2"]; ok {
		t.Errorf("deleted metric still carries edges: %v", rows["deps_dep2"])
	}
	if !reflect.DeepEqual(rows["deps_dep"], []string{"deps_up"}) {
		t.Errorf("surviving caller's edges = %v, want [deps_up]", rows["deps_dep"])
	}
	// The upstream's dependents lookup only ever sees live dependents.
	dependents, err := s.MetricDependents("deps_up")
	if err != nil {
		t.Fatalf("MetricDependents: %v", err)
	}
	if len(dependents) != 1 || dependents[0].Name != "deps_dep" {
		t.Errorf("dependents = %+v, want just deps_dep", dependents)
	}
}

// mustMetricID resolves a metric name to its id.
func mustMetricID(t *testing.T, s *Store, name string) int64 {
	t.Helper()
	m, err := s.GetMetricByName(name)
	if err != nil {
		t.Fatalf("GetMetricByName(%q): %v", name, err)
	}
	return m.ID
}

// TestSaveMetricWithDepsRollsBackAtomically pins the ONE-transaction
// contract: a failure part-way through (a rewrite pointing at a metric
// that is not there, a name collision) leaves EVERY row exactly as it
// was — the metric's own write and every already-applied rewrite included
// (that is what makes the rename splice's "nothing written" guarantee
// mechanical rather than best-effort).
func TestSaveMetricWithDepsRollsBackAtomically(t *testing.T) {
	s, _ := openFileStore(t)
	t.Cleanup(func() { _ = s.CloseRO() })

	mustSaveMetricDeps(t, s, models.MetricRow{
		Name: "atomic_up", Title: "up", Expr: "from events: count()", Scope: "match", Origin: "user",
	}, nil)
	dep := mustSaveMetricDeps(t, s, models.MetricRow{
		Name: "atomic_dep", Title: "dep", Expr: "from events: metric('atomic_up')",
		Scope: "match", Origin: "user",
	}, []string{"atomic_up"})
	other := mustSaveMetricDeps(t, s, models.MetricRow{
		Name: "atomic_other", Title: "other", Expr: "from events: count()", Scope: "match", Origin: "user",
	}, nil)

	// (1) The dependent's rewrite targets a metric that does not exist:
	// the tx has already rewritten atomic_dep's row and edges by the time
	// it fails.
	_, err := s.SaveMetricWithDeps(models.MetricRow{
		ID: dep.ID, Name: dep.Name, Title: "rewritten", Expr: "from events: count()",
		Scope: "match", Origin: "user",
	}, nil, []DependentRewrite{
		{ID: other.ID, Expr: "from events: sum(dmg)", Deps: nil},
		{ID: 999999, Expr: "from events: count()", Deps: nil},
	})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want store.ErrNotFound (the failing rewrite)", err)
	}
	still, err := s.GetMetric(dep.ID)
	if err != nil {
		t.Fatalf("GetMetric: %v", err)
	}
	if still.Expr != "from events: metric('atomic_up')" || still.Title != "dep" {
		t.Errorf("after rollback dep = %+v, want the ORIGINAL row (no partial write)", still)
	}
	if got, err := s.MetricDeps(dep.ID); err != nil || !reflect.DeepEqual(got, []string{"atomic_up"}) {
		t.Errorf("edges after rollback = %v, %v; want the original [atomic_up]", got, err)
	}
	if got, err := s.MetricDeps(other.ID); err != nil || len(got) != 0 {
		t.Errorf("other's edges after rollback = %v, %v; want none", got, err)
	}

	// (2) The metric's OWN write rolls back too: a create whose rewrite
	// fails leaves no row and no edges behind.
	_, err = s.SaveMetricWithDeps(models.MetricRow{
		Name: "atomic_new", Title: "new", Expr: "from events: count()",
		Scope: "match", Origin: "user",
	}, []string{"atomic_up"}, []DependentRewrite{
		{ID: 999999, Expr: "from events: count()", Deps: nil},
	})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("create+bad rewrite err = %v, want store.ErrNotFound", err)
	}
	if _, err := s.GetMetricByName("atomic_new"); !errors.Is(err, ErrNotFound) {
		t.Errorf("rolled-back create left a row: %v", err)
	}
	rows, err := s.ListMetricEdges()
	if err != nil {
		t.Fatalf("ListMetricEdges: %v", err)
	}
	if _, ok := rows["atomic_new"]; ok {
		t.Errorf("rolled-back create left edges: %v", rows["atomic_new"])
	}
	if !reflect.DeepEqual(rows["atomic_dep"], []string{"atomic_up"}) {
		t.Errorf("atomic_dep edges = %v, want the original [atomic_up]", rows["atomic_dep"])
	}
}
