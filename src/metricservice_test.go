package main

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// TestSaveMetricScope pins W2's SaveMetric contract: scope is a REAL
// field — validated ∈ {match, profile} with a friendly service error
// (the Format pattern), written through (the W1 forced scope 'match' is
// retired) — and every compile path enforces the player anchor, so a
// round-grain definition never lands. PreviewMetric and ValidateExpr
// carry the W2 signatures (the groupBy argument is gone with the wave).
func TestSaveMetricScope(t *testing.T) {
	// File-backed: PreviewMetric runs on the read-only session, which
	// requires a file-backed database.
	st, err := store.Open(filepath.Join(t.TempDir(), "metricservice.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.CloseRO(); _ = st.Close() })
	svc := &MetricsService{st: st}

	// Create with a real scope: profile round-trips.
	saved, err := svc.SaveMetric(models.MetricRow{
		Name: "w2_rate", Title: "W2 rate", Expr: "from events: count()",
		Format: "int", Origin: "user", Scope: "profile",
	})
	if err != nil {
		t.Fatalf("SaveMetric(create): %v", err)
	}
	if saved.Scope != "profile" {
		t.Errorf("saved scope = %q, want profile (the API writes the real scope)", saved.Scope)
	}
	if saved.Version != 1 {
		t.Errorf("saved version = %d, want 1 (INSERT default — no bump logic until a later wave)", saved.Version)
	}
	if saved.Origin != "user" || saved.Doc == "" {
		t.Errorf("saved row = %+v, want origin user + formula doc", saved)
	}

	// Update keeps the scope it was given.
	saved.Title = "W2 rate renamed"
	updated, err := svc.SaveMetric(saved)
	if err != nil {
		t.Fatalf("SaveMetric(update): %v", err)
	}
	if updated.Title != "W2 rate renamed" || updated.Scope != "profile" {
		t.Errorf("updated = %+v, want renamed title + scope profile", updated)
	}

	// An omitted or unknown scope is a friendly service error — the API
	// always writes a real scope now (the W1 '' → 'match' force is gone).
	for _, bad := range []string{"", "career", "MATCH", "player"} {
		_, err := svc.SaveMetric(models.MetricRow{
			Name: "bad_scope", Expr: "from events: count()", Format: "int", Scope: bad,
		})
		if err == nil || !strings.Contains(err.Error(), "unknown scope") {
			t.Errorf("scope %q: err = %v, want the friendly unknown-scope error", bad, err)
		}
	}

	// The player anchor reaches the save path like any invalid expression.
	_, err = svc.SaveMetric(models.MetricRow{
		Name: "no_anchor", Expr: "from rounds: count()", Format: "int", Scope: "match",
	})
	if err == nil || !strings.Contains(err.Error(), "not player-anchored") {
		t.Errorf("round-grain save err = %v, want the anchor rejection", err)
	}

	// PreviewMetric: the W2 arity (id, expr, scope, limit) — an empty
	// expr runs the saved definition, and the preview is subject-grouped.
	pv, err := svc.PreviewMetric(saved.ID, "", "", 10)
	if err != nil {
		t.Fatalf("PreviewMetric: %v", err)
	}
	if !strings.Contains(pv.SQL, "attacker AS grp") {
		t.Errorf("preview SQL not subject-grouped:\n%s", pv.SQL)
	}

	// ValidateExpr: the W2 arity (expr only) — the anchor reports on the
	// live check too, identically to a save.
	ok, ee, err := svc.ValidateExpr("from events: count()")
	if err != nil || !ok || ee.Message != "" {
		t.Errorf("ValidateExpr = (%v, %+v, %v), want ok", ok, ee, err)
	}
	ok, ee, _ = svc.ValidateExpr("from rounds: count()")
	if ok || !strings.Contains(ee.Message, "not player-anchored") {
		t.Errorf("ValidateExpr(round-grain) = (%v, %+v), want the anchor rejection", ok, ee)
	}
}
