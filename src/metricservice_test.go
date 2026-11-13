package main

import (
	"path/filepath"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// TestSaveMetricW1Compat pins the stored-metrics W1 compatibility rule:
// the pre-W2 UI still sends payloads WITHOUT a scope field (and with a
// groupBy field the Go model no longer decodes), so SaveMetric must keep
// working end to end — writing scope 'match' (the DDL-DEFAULT equivalent
// of the missing field) and version 1 — while PreviewMetric and
// ValidateExpr keep their existing signatures with the groupBy argument
// IGNORED (its retirement lands with the W2 form change).
func TestSaveMetricW1Compat(t *testing.T) {
	// File-backed: PreviewMetric runs on the read-only session, which
	// requires a file-backed database.
	st, err := store.Open(filepath.Join(t.TempDir(), "metricservice.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.CloseRO(); _ = st.Close() })
	svc := &MetricsService{st: st}

	// Create: the pre-W2 payload shape — no Scope (and a groupBy key the
	// model no longer carries) — still saves.
	saved, err := svc.SaveMetric(models.MetricRow{
		Name: "w1_rate", Title: "W1 rate", Expr: "from events: count()",
		Format: "int", Origin: "user",
	})
	if err != nil {
		t.Fatalf("SaveMetric(create): %v", err)
	}
	if saved.Scope != "match" {
		t.Errorf("saved scope = %q, want match (W1 writes 'match' for every API save)", saved.Scope)
	}
	if saved.Version != 1 {
		t.Errorf("saved version = %d, want 1 (INSERT default — no bump logic until the later wave)", saved.Version)
	}
	if saved.Origin != "user" || saved.Doc == "" {
		t.Errorf("saved row = %+v, want origin user + formula doc", saved)
	}

	// Update: still 'match', still version 1 (UpdateMetric does not bump).
	saved.Title = "W1 rate renamed"
	updated, err := svc.SaveMetric(saved)
	if err != nil {
		t.Fatalf("SaveMetric(update): %v", err)
	}
	if updated.Title != "W1 rate renamed" || updated.Scope != "match" || updated.Version != 1 {
		t.Errorf("updated = %+v, want renamed title + scope match + version 1", updated)
	}

	// PreviewMetric signature unchanged; the groupBy argument is ignored
	// (a group token the engine would reject in W1's ungrouped validation
	// must not fail the call).
	pv, err := svc.PreviewMetric(saved.ID, "", "banana", "", 10)
	if err != nil {
		t.Fatalf("PreviewMetric: %v", err)
	}
	if len(pv.Rows) == 0 {
		t.Errorf("preview rows = 0, want the scalar count row")
	}

	// ValidateExpr likewise: groupBy ignored, not validated.
	ok, ee, err := svc.ValidateExpr("from events: count()", "banana")
	if err != nil {
		t.Fatalf("ValidateExpr: %v", err)
	}
	if !ok || ee.Message != "" {
		t.Errorf("ValidateExpr = (%v, %+v), want ok with ignored groupBy", ok, ee)
	}
}
