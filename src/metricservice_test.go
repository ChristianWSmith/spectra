package main

import (
	"errors"
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
		t.Errorf("saved version = %d, want 1 (INSERT default — a create never bumps; W3 bumps semantic EDITS only)", saved.Version)
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

// TestSaveMetricFormatEnum pins the Format contract (the Format pattern
// TestSaveMetricScope cites): every tag the Builder select offers —
// including float2 (Q6, the K/D seeds' two-decimal tag) — round-trips
// through SaveMetric, and an unknown tag is the friendly pre-write
// rejection listing the valid set.
func TestSaveMetricFormatEnum(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "format-enum.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.CloseRO(); _ = st.Close() })
	svc := &MetricsService{st: st}

	for _, format := range []string{"", "int", "float1", "float2", "percent", "currency"} {
		saved, err := svc.SaveMetric(models.MetricRow{
			Name: "fmt_" + orName(format), Expr: "from events: count()",
			Format: format, Scope: "match", Origin: "user",
		})
		if err != nil {
			t.Errorf("SaveMetric(format=%q): %v (every enum tag must save)", format, err)
			continue
		}
		if saved.Format != format {
			t.Errorf("format %q round-tripped as %q", format, saved.Format)
		}
	}
	if _, err := svc.SaveMetric(models.MetricRow{
		Name: "fmt_bad", Expr: "from events: count()", Format: "float3", Scope: "match",
	}); err == nil || !strings.Contains(err.Error(), "unknown format") ||
		!strings.Contains(err.Error(), "float2") {
		t.Errorf("float3 err = %v, want the friendly unknown-format copy naming float2", err)
	}
}

// orName makes a stable metric name for an enum tag ("" → auto).
func orName(format string) string {
	if format == "" {
		return "auto"
	}
	return format
}

// TestSaveMetricBuiltinGuards pins the service-level built-in
// immutability (owner wave): an EXISTING builtin row can be neither
// edited nor deleted through the API, judged by the STORED row's origin
// — a payload claiming origin "user" changes nothing — while the CREATE
// that merely COLLIDES with a builtin name keeps reporting the store's
// uniqueness error (the distinct path: the immutability copy there would
// mislabel a create as an edit). User rows stay fully writable, plugin
// rows keep their pre-existing behaviour (deletable; an edit attempt is
// the store's origin!=user rejection, never the builtin copy), and
// ReplacePluginMetrics — the loader's writer, internal/plugin/manager.go
// calls the STORE directly and never SaveMetric — bypasses these guards
// by construction.
func TestSaveMetricBuiltinGuards(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "builtin-guards.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.CloseRO(); _ = st.Close() })
	svc := &MetricsService{st: st}

	list, err := svc.ListMetrics()
	if err != nil {
		t.Fatalf("ListMetrics: %v", err)
	}
	var builtin models.MetricRow
	for _, m := range list {
		if m.Origin == "builtin" {
			builtin = m
		}
	}
	if builtin.ID == 0 {
		t.Fatal("schema-seeded builtin missing from ListMetrics")
	}

	// (1) Edit rejected with the friendly service copy — even though the
	// payload claims origin "user" (the caller's origin is never the
	// judge), and even though this expression would NOT compile: the
	// guard sits BEFORE the compile (cheapest-first), which this pins.
	_, err = svc.SaveMetric(models.MetricRow{
		ID: builtin.ID, Name: builtin.Name, Title: "Hijacked", ShortName: "H",
		Expr: "not even an expression", Scope: "match", Format: "int",
		Doc: "d", Origin: "user",
	})
	if err == nil || !strings.Contains(err.Error(), "built-in metrics can't be edited") {
		t.Errorf("builtin edit err = %v, want the friendly immutability copy", err)
	}
	after, err := svc.GetMetric(builtin.ID)
	if err != nil {
		t.Fatalf("GetMetric: %v", err)
	}
	if after.Title != builtin.Title || after.Expr != builtin.Expr {
		t.Errorf("builtin row changed by the rejected edit: %+v", after)
	}

	// (2) Delete rejected with its own friendly copy.
	if err := svc.DeleteMetric(builtin.ID); err == nil ||
		!strings.Contains(err.Error(), "built-in metrics can't be deleted") {
		t.Errorf("builtin delete err = %v, want the friendly immutability copy", err)
	}
	// The unknown-id contract is untouched by the guard's up-front read:
	// still the store's ErrNotFound.
	if err := svc.DeleteMetric(999999); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("delete unknown id err = %v, want store.ErrNotFound", err)
	}

	// (3) The DISTINCT path: a NEW metric whose name collides with the
	// builtin still reports the uniqueness error — never the edit copy.
	_, err = svc.SaveMetric(models.MetricRow{
		Name: builtin.Name, Title: "Shadow", Expr: "from events: count()",
		Scope: "match", Doc: "d", Origin: "user",
	})
	if err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Errorf("builtin-name collision err = %v, want the uniqueness error", err)
	} else if strings.Contains(err.Error(), "built-in metrics can't") {
		t.Errorf("collision misreported as an edit: %v (a create must keep the uniqueness error)", err)
	}

	// (4) A user metric stays fully writable: create, edit, delete.
	user, err := svc.SaveMetric(models.MetricRow{
		Name: "my_rate", Title: "My rate", Expr: "from events: count()",
		Scope: "match", Doc: "Formula: count()", Origin: "user",
	})
	if err != nil {
		t.Fatalf("SaveMetric(create user): %v", err)
	}
	user.Title = "My rate renamed"
	if edited, err := svc.SaveMetric(user); err != nil || edited.Title != "My rate renamed" {
		t.Errorf("user edit = (%+v, %v), want the rename to land", edited, err)
	}
	if err := svc.DeleteMetric(user.ID); err != nil {
		t.Errorf("user delete: %v", err)
	}

	// (5) Plugin rows: seeded by the loader (ReplacePluginMetrics talks
	// to the STORE directly — the guards above never gate it),
	// deletable through the API, and an edit attempt is NOT judged by the
	// builtin copy — the store's pre-existing origin!=user rejection
	// still owns that path (plugin rows are the loader's territory).
	if err := st.ReplacePluginMetrics("p1", []store.PluginMetricDef{
		{Name: "plug_x", Title: "Plugin X", Expr: "from events: count()"},
	}); err != nil {
		t.Fatalf("ReplacePluginMetrics: %v", err)
	}
	list, err = svc.ListMetrics()
	if err != nil {
		t.Fatalf("ListMetrics(after plugin seed): %v", err)
	}
	var plugin models.MetricRow
	for _, m := range list {
		if m.Origin == "plugin" {
			plugin = m
		}
	}
	if plugin.ID == 0 {
		t.Fatal("plugin metric missing from ListMetrics")
	}
	plugin.Title = "Renamed through the API"
	if _, err := svc.SaveMetric(plugin); err == nil {
		t.Error("plugin edit through the API: want the store's rejection")
	} else {
		if strings.Contains(err.Error(), "built-in") {
			t.Errorf("plugin edit misjudged by the BUILTIN guard: %v", err)
		}
		if !strings.Contains(err.Error(), "cannot be modified") {
			t.Errorf("plugin edit err = %v, want the store's pre-existing origin rejection", err)
		}
	}
	if err := svc.DeleteMetric(plugin.ID); err != nil {
		t.Errorf("plugin delete: %v", err)
	}
}
