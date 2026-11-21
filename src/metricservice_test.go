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
		Name: "w2_rate", Title: "W2 rate", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE :steam_id <> ''",
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
			Name: "bad_scope", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id", Format: "int", Scope: bad,
		})
		if err == nil || !strings.Contains(err.Error(), "unknown scope") {
			t.Errorf("scope %q: err = %v, want the friendly unknown-scope error", bad, err)
		}
	}

	// ValidateExpr: the W2 arity (expr only) — the anchor reports on the
	// live check too, identically to a save.
	ok, ee, err := svc.ValidateExpr("SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id", "player", "", "match")
	if err != nil || !ok || ee.Message != "" {
		t.Errorf("ValidateExpr = (%v, %+v, %v), want ok", ok, ee, err)
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

	for _, format := range []string{"", "int", "float1", "float2", "percent", "currency", "identity"} {
		saved, err := svc.SaveMetric(models.MetricRow{
			Name: "fmt_" + orName(format), Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id",
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
		Name: "fmt_bad", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id", Format: "float3", Scope: "match",
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

// TestSaveMetricShortNameCap pins the SIX-character short-name cap (N3):
// it counts RUNES, never bytes (a short label is a width-constrained
// header — 'σσσσσσ' is six characters, not twelve), an empty one stays
// legal (the display fallback covers it), and an over-limit value is
// REJECTED with a friendly service error rather than silently
// truncated — the seeded built-ins honor the same cap (schema.sql).
func TestSaveMetricShortNameCap(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "short-name.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.CloseRO(); _ = st.Close() })
	svc := &MetricsService{st: st}

	base := func(short string) models.MetricRow {
		return models.MetricRow{
			Name: "cap_" + strings.Map(func(r rune) rune {
				if r == ' ' || r == '%' {
					return '_'
				}
				return r
			}, short),
			Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id", Format: "int", Scope: "match",
			Origin: "user", ShortName: short,
		}
	}

	// Empty (the fallback case) and exactly six characters round-trip.
	for _, short := range []string{"", "Trade%"} {
		m := base(short)
		if short == "" {
			m.Name = "cap_empty"
		}
		saved, err := svc.SaveMetric(m)
		if err != nil {
			t.Errorf("SaveMetric(short=%q): %v (empty and six characters must save)", short, err)
			continue
		}
		if saved.ShortName != short {
			t.Errorf("short name %q round-tripped as %q", short, saved.ShortName)
		}
	}

	// Rune count, not byte count: six multibyte characters pass, seven
	// fail — a byte cap would answer the opposite way.
	if _, err := svc.SaveMetric(base("σσσσσσ")); err != nil {
		t.Errorf("six multibyte characters rejected: %v (the cap counts runes)", err)
	}
	over := base("σσσσσσσ")
	over.Name = "cap_seven_multibyte"
	_, err = svc.SaveMetric(over)
	if err == nil {
		t.Fatal("seven characters saved — the cap must reject")
	}
	if !strings.Contains(err.Error(), "short name") || !strings.Contains(err.Error(), "6") {
		t.Errorf("over-limit err = %v, want the friendly short-name copy naming the cap", err)
	}
	if strings.Contains(err.Error(), "metricservice") {
		t.Errorf("over-limit err = %v, must carry no package prefix (user-facing copy)", err)
	}
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
		Name: builtin.Name, Title: "Shadow", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id",
		Scope: "match", Doc: "d", Origin: "user",
	})
	if err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Errorf("builtin-name collision err = %v, want the uniqueness error", err)
	} else if strings.Contains(err.Error(), "built-in metrics can't") {
		t.Errorf("collision misreported as an edit: %v (a create must keep the uniqueness error)", err)
	}

	// (4) A user metric stays fully writable: create, edit, delete.
	user, err := svc.SaveMetric(models.MetricRow{
		Name: "my_rate", Title: "My rate", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id",
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
		{Name: "plug_x", Title: "Plugin X", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id"},
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

// TestListMetricsPageArity pins the service passthrough: all EIGHT
// arguments reach the store in their positions — the five filter words
// (origin, scope, subject, format) included — since a dropped,
// defaulted or reordered arg would select a different window than the
// one asserted here. The filter vocabulary is the store's: each unknown
// word comes back as the store's own pre-SQL rejection (which is only
// reachable when the argument lands at all).
func TestListMetricsPageArity(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "list-page.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.CloseRO(); _ = st.Close() })
	svc := &MetricsService{st: st}

	if _, err := svc.SaveMetric(models.MetricRow{
		Name: "per_round_rate", Title: "Per round rate", Expr: "SELECT '' AS subject_key, '' AS dim, 1.0*SUM(kills)/NULLIF(SUM(rounds_played), 0) AS value FROM player_stats WHERE match_id = :match_id",
		Scope: "match", Format: "float1", Doc: "Formula: kills / rounds played",
		Origin: "user",
	}); err != nil {
		t.Fatalf("SaveMetric(match/rounds): %v", err)
	}
	if _, err := svc.SaveMetric(models.MetricRow{
		Name: "career_rate", Title: "Career rate", Expr: "SELECT '' AS subject_key, '' AS dim, AVG(adr) AS value FROM player_stats WHERE :steam_id <> ''",
		Scope: "profile", Format: "float1", Doc: "Formula: mean ADR", Origin: "user",
	}); err != nil {
		t.Fatalf("SaveMetric(profile): %v", err)
	}

	all, err := svc.ListMetrics()
	if err != nil {
		t.Fatalf("ListMetrics: %v", err)
	}
	if len(all) < 3 {
		t.Fatalf("catalog = %d rows, want the seeded builtins + 2 users", len(all))
	}

	// Every filter empty = the whole canonical list — the six filter
	// slots really are the filters (a stray value would narrow this).
	// The limit is explicit: the seed count now exceeds the store's
	// default window (the 2026-11-18 view-aggregate relocation re-pin,
	// ME8 audit — 109 rows > 100), so
	// limit 0's default window could no longer hold the whole list.
	page, err := svc.ListMetricsPage("", "", "", "", "", 0, len(all))
	if err != nil {
		t.Fatalf("ListMetricsPage(all empty): %v", err)
	}
	if len(page.Rows) != len(all) {
		t.Errorf("unfiltered window = %d rows, want the whole list (%d)", len(page.Rows), len(all))
	}
	for i, m := range page.Rows {
		if m.ID != all[i].ID {
			t.Fatalf("unfiltered window diverges from ListMetrics order at %d: %d vs %d", i, m.ID, all[i].ID)
		}
	}

	// The five filters in one call: origin 'user,plugin' + scope 'match' +
	// subject 'player' + format 'float1' selects exactly the one
	// seeded user row (the plugin's/other users' rows differ on a
	// predicate, the builtins are excluded by origin) — so every filter
	// word landed where it belongs.
	page, err = svc.ListMetricsPage("", "user,plugin", "match", "player", "float1", 0, 0)
	if err != nil {
		t.Fatalf("ListMetricsPage(mine, match, rounds, float1): %v", err)
	}
	if len(page.Rows) != 1 || page.Rows[0].Name != "per_round_rate" ||
		page.Rows[0].Scope != "match" ||
		page.Rows[0].Format != "float1" {
		got := make([]string, 0, len(page.Rows))
		for _, m := range page.Rows {
			got = append(got, m.Name+"("+m.Scope+"/"+m.Format+")")
		}
		t.Errorf("mine+match+float1 = %v, want [per_round_rate(match/float1)]", got)
	}

	// The format word answers in ITS position (arg 5): both seeded user
	// rows are float1, so float1 keeps every mine row while percent
	// narrows the same call to nothing — counts derived from the
	// catalog above, never pinned.
	var mineFloat1, minePercent int
	for _, m := range all {
		if m.Origin == "builtin" {
			continue
		}
		switch m.Format {
		case "float1":
			mineFloat1++
		case "percent":
			minePercent++
		}
	}
	if mineFloat1 == 0 {
		t.Fatalf("fixture has no float1 mine row — the format narrowing check would be vacuous")
	}
	f1, err := svc.ListMetricsPage("", "user,plugin", "", "", "float1", 0, 0)
	if err != nil {
		t.Fatalf("ListMetricsPage(mine, format=float1): %v", err)
	}
	if len(f1.Rows) != mineFloat1 {
		t.Errorf("mine+float1 = %d rows, want every float1 mine row (%d)", len(f1.Rows), mineFloat1)
	}
	pc, err := svc.ListMetricsPage("", "user,plugin", "", "", "percent", 0, 0)
	if err != nil {
		t.Fatalf("ListMetricsPage(mine, format=percent): %v", err)
	}
	if len(pc.Rows) != minePercent {
		t.Errorf("mine+percent = %d rows, want every percent mine row (%d)", len(pc.Rows), minePercent)
	}

	// The cursor (arg 6): the first row as afterID drops it and keeps
	// the rest, in order — the explicit limit again (the list outgrew
	// the store's default window with the partition addendum).
	cursored, err := svc.ListMetricsPage("", "", "", "", "", all[0].ID, len(all))
	if err != nil {
		t.Fatalf("ListMetricsPage(cursor): %v", err)
	}
	if len(cursored.Rows) != len(all)-1 || cursored.Rows[0].ID != all[1].ID {
		t.Errorf("cursor window = %d rows (first %d), want the %d rows after %d",
			len(cursored.Rows), cursored.Rows[0].ID, len(all)-1, all[0].ID)
	}

	// The limit (arg 8): 1 row + the has-next probe.
	limited, err := svc.ListMetricsPage("", "", "", "", "", 0, 1)
	if err != nil {
		t.Fatalf("ListMetricsPage(limit 1): %v", err)
	}
	if len(limited.Rows) != 1 || !limited.HasNext {
		t.Errorf("limit 1 → %d rows (HasNext=%v), want 1, true", len(limited.Rows), limited.HasNext)
	}

	// Each filter slot answers in ITS position: the store's pre-SQL
	// rejection names the argument that carried the bad word — an arg
	// dropped or shifted on the way down would surface as "" and pass.
	for _, tc := range []struct{ slot, word, want string }{
		{"origin", "everything", `unknown origin filter "everything"`},
		{"scope", "career", `unknown scope filter "career"`},
		{"subject", "map", `unknown subject filter "map"`},
		{"subject", "player,team,match", `unknown subject filter "player,team,match"`},
		{"format", "huge", `unknown format filter "huge"`},
	} {
		var err error
		switch tc.slot {
		case "origin":
			_, err = svc.ListMetricsPage("", tc.word, "", "", "", 0, 100)
		case "scope":
			_, err = svc.ListMetricsPage("", "", tc.word, "", "", 0, 100)
		case "subject":
			_, err = svc.ListMetricsPage("", "", "", tc.word, "", 0, 100)
		case "format":
			_, err = svc.ListMetricsPage("", "", "", "", tc.word, 0, 100)
		}
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s filter %q: err = %v, want the store's %s", tc.slot, tc.word, err, tc.want)
		}
	}
}
