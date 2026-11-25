package store

import (
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

const toggleExpr = "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id"

// mustToggleMetric saves a user metric that reads deps, failing the test on error.
func mustToggleMetric(t *testing.T, s *Store, name string, deps ...string) models.MetricRow {
	t.Helper()
	m, err := s.SaveMetricWithDeps(models.MetricRow{Name: name, Title: name, Expr: toggleExpr, Origin: "user"}, deps, nil, false)
	if err != nil {
		t.Fatalf("SaveMetricWithDeps(%q): %v", name, err)
	}
	return m
}

func mustEnabled(t *testing.T, s *Store, id int64) bool {
	t.Helper()
	m, err := s.GetMetric(id)
	if err != nil {
		t.Fatalf("GetMetric(%d): %v", id, err)
	}
	return m.Enabled
}

// TestSetMetricEnabledDependencyRules pins the switch rules: a metric can go off only when no
// enabled metric reads it, and can come on only when every metric it reads is on.
func TestSetMetricEnabledDependencyRules(t *testing.T) {
	s := openMem(t)
	up := mustToggleMetric(t, s, "tg_up")
	dep := mustToggleMetric(t, s, "tg_dep", "tg_up")

	err := s.SetMetricEnabled(up.ID, false)
	if err == nil || !strings.Contains(err.Error(), "tg_dep") {
		t.Fatalf("disabling a metric an enabled one reads: err = %v, want it to name tg_dep", err)
	}
	if !mustEnabled(t, s, up.ID) {
		t.Fatal("a refused disable changed the row")
	}

	// dep is read by nothing, so it can go off; then up can too, since its only reader is off.
	if err := s.SetMetricEnabled(dep.ID, false); err != nil {
		t.Fatalf("disable dep: %v", err)
	}
	if err := s.SetMetricEnabled(up.ID, false); err != nil {
		t.Fatalf("disable up while its only reader is off: %v", err)
	}

	// dep reads a disabled metric, so it cannot come on until up does.
	err = s.SetMetricEnabled(dep.ID, true)
	if err == nil || !strings.Contains(err.Error(), "tg_up") {
		t.Fatalf("enabling a metric over a disabled dependency: err = %v, want it to name tg_up", err)
	}
	if err := s.SetMetricEnabled(up.ID, true); err != nil {
		t.Fatalf("enable up: %v", err)
	}
	if err := s.SetMetricEnabled(dep.ID, true); err != nil {
		t.Fatalf("enable dep: %v", err)
	}
	if !mustEnabled(t, s, dep.ID) || !mustEnabled(t, s, up.ID) {
		t.Fatal("both metrics should be enabled at the end")
	}
}

// TestSetMetricEnabledComponentBlocks: a component that reads a metric keeps it on, the same as
// it keeps the metric from being deleted.
func TestSetMetricEnabledComponentBlocks(t *testing.T) {
	s := openMem(t)
	up := mustToggleMetric(t, s, "tg_comp_up")
	if _, err := s.SaveComponent("", "tg_widget", "<p/>", ComponentRefs{Metrics: []string{"tg_comp_up"}}); err != nil {
		t.Fatalf("SaveComponent: %v", err)
	}
	err := s.SetMetricEnabled(up.ID, false)
	if err == nil || !strings.Contains(err.Error(), "tg_widget") {
		t.Fatalf("disabling a metric a component reads: err = %v, want it to name tg_widget", err)
	}
	if !mustEnabled(t, s, up.ID) {
		t.Fatal("a refused disable changed the row")
	}
}

// TestMetricToggleBlocksMatchRules: the list's switch reasons follow the same rules as the setter.
func TestMetricToggleBlocksMatchRules(t *testing.T) {
	s := openMem(t)
	up := mustToggleMetric(t, s, "tb_up")
	dep := mustToggleMetric(t, s, "tb_dep", "tb_up")

	blocks, err := s.MetricToggleBlocks()
	if err != nil {
		t.Fatalf("MetricToggleBlocks: %v", err)
	}
	if b := blocks[up.ID]; !strings.Contains(b.DisableBlock, "tb_dep") {
		t.Errorf("up's disable block = %q, want it to name tb_dep", b.DisableBlock)
	}
	if b, ok := blocks[dep.ID]; ok {
		t.Errorf("dep should be switchable, got %+v", b)
	}

	// With dep off, up is switchable.
	if err := s.SetMetricEnabled(dep.ID, false); err != nil {
		t.Fatalf("disable dep: %v", err)
	}
	blocks, err = s.MetricToggleBlocks()
	if err != nil {
		t.Fatalf("MetricToggleBlocks: %v", err)
	}
	if b := blocks[up.ID]; b.DisableBlock != "" {
		t.Errorf("up should be switchable once its reader is off, got %q", b.DisableBlock)
	}

	// Off both ways: dep cannot come on while up is off.
	if err := s.SetMetricEnabled(up.ID, false); err != nil {
		t.Fatalf("disable up: %v", err)
	}
	blocks, err = s.MetricToggleBlocks()
	if err != nil {
		t.Fatalf("MetricToggleBlocks: %v", err)
	}
	if b := blocks[dep.ID]; !strings.Contains(b.EnableBlock, "tb_up") {
		t.Errorf("dep's enable block = %q, want it to name tb_up", b.EnableBlock)
	}
}

// TestMetricCoverageDisabledNeverBehind: with a ready match that has no values, an enabled metric is
// behind; the same metric disabled reads as neither behind nor enabled.
func TestMetricCoverageDisabledNeverBehind(t *testing.T) {
	s := openMem(t)
	m := mustToggleMetric(t, s, "tc_m")
	mid, err := s.CreateMatchRow("/d/tc.dem", "sha-tc", 1)
	if err != nil {
		t.Fatalf("CreateMatchRow: %v", err)
	}
	if _, err := s.db.Exec(`UPDATE matches SET status = 'ready' WHERE id = ?`, mid); err != nil {
		t.Fatalf("mark match ready: %v", err)
	}
	coverageOf := func() MetricCoverage {
		t.Helper()
		cov, err := s.MetricCoverage(0)
		if err != nil {
			t.Fatalf("MetricCoverage: %v", err)
		}
		for _, c := range cov {
			if c.MetricID == m.ID {
				return c
			}
		}
		t.Fatalf("no coverage row for metric %d", m.ID)
		return MetricCoverage{}
	}
	if c := coverageOf(); !c.Enabled || !c.Behind {
		t.Fatalf("enabled metric with a ready match and no values: %+v, want enabled and behind", c)
	}
	if err := s.SetMetricEnabled(m.ID, false); err != nil {
		t.Fatalf("disable: %v", err)
	}
	if c := coverageOf(); c.Enabled || c.Behind {
		t.Fatalf("disabled metric: %+v, want not enabled and not behind", c)
	}
}
