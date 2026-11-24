package store

import (
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// A built-in metric keeps its name for good: it is composed by name (other metrics and
// components reference it), so even the builtin-edit path may change its expression but never
// its name.
func TestBuiltinMetricCannotBeRenamed(t *testing.T) {
	s := openMem(t)
	all, err := s.ListMetrics()
	if err != nil {
		t.Fatalf("ListMetrics: %v", err)
	}
	var b models.MetricRow
	for _, m := range all {
		if m.Origin == "builtin" {
			b = m
			break
		}
	}
	if b.ID == 0 {
		t.Fatal("no builtin metric seeded")
	}
	const expr = "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id"
	err = updateMetric(s.db, models.MetricRow{ID: b.ID, Name: b.Name + "_renamed", Title: b.Title, Expr: expr, Format: b.Format}, true)
	if err == nil || !strings.Contains(err.Error(), "can't be renamed") {
		t.Fatalf("builtin rename through the builtin-edit path: err = %v, want the rename refusal", err)
	}
	// An expression-only edit of the same builtin still goes through.
	if err := updateMetric(s.db, models.MetricRow{ID: b.ID, Name: b.Name, Title: b.Title, Expr: expr, Format: b.Format}, true); err != nil {
		t.Fatalf("builtin expression edit: %v", err)
	}
}
