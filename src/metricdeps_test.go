package main

import (
	"path/filepath"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// W2b — the metric() reference GRAPH at the service level (design §2):
// deps round-trip after every save shape, the delete block, the
// cross-scope matrix, cycle rejection, the rename splice (including an
// identical evaluation on seed data) and its no-bump rule, plus the
// system-path verifications (plugin replace never routes through
// DeleteMetric; metric_deps.metric_id's FK CASCADE is the backstop).

// depsFixture is a MetricsService over a file-backed store (file-backed
// because previews run on the read-only session).
type depsFixture struct {
	svc  *MetricsService
	st   *store.Store
	path string
}

func newDepsFixture(t *testing.T) *depsFixture {
	t.Helper()
	path := filepath.Join(t.TempDir(), "metricdeps.db")
	st, err := store.Open(path)
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.CloseRO(); _ = st.Close() })
	return &depsFixture{svc: &MetricsService{st: st}, st: st, path: path}
}

// save runs SaveMetric with the field defaults every fixture row wants.
func (f *depsFixture) save(t *testing.T, m models.MetricRow) models.MetricRow {
	t.Helper()
	if m.Format == "" {
		m.Format = "int"
	}
	if m.Scope == "" {
		m.Scope = "match"
	}
	if m.Doc == "" {
		m.Doc = "Formula: " + m.Expr
	}
	saved, err := f.svc.SaveMetric(m)
	if err != nil {
		t.Fatalf("SaveMetric(%q): %v", m.Name, err)
	}
	return saved
}

// mustID resolves a name to its id, failing the test when absent.
func mustID(t *testing.T, st *store.Store, name string) int64 {
	t.Helper()
	m, err := st.GetMetricByName(name)
	if err != nil {
		t.Fatalf("GetMetricByName(%q): %v", name, err)
	}
	return m.ID
}
