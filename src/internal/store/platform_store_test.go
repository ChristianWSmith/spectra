package store

import (
	"path/filepath"
	"strings"
	"testing"
)

// TestPluginsTableReopen: a fresh Open creates the plugins registry; a
// second Open re-applies the baseline as a no-op and the registry still
// answers.
func TestPluginsTableReopen(t *testing.T) {
	s, path := openFileStore(t)
	if _, err := s.ListPluginRows(); err != nil {
		t.Fatalf("ListPluginRows on fresh db: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	s2, err := Open(path)
	if err != nil {
		t.Fatalf("reopen %s: %v", filepath.Base(path), err)
	}
	defer func() { _ = s2.Close() }()
	if _, err := s2.ListPluginRows(); err != nil {
		t.Fatalf("ListPluginRows after reopen: %v", err)
	}
}

func TestPluginRowsRoundTrip(t *testing.T) {
	s := openMem(t)
	if _, err := s.GetPluginRow("nope"); err == nil {
		t.Fatal("GetPluginRow(missing) succeeded, want ErrNotFound")
	}
	row := PluginRow{ID: "test-plug", Name: "Test", Version: "1.0.0", Path: "/x/test-plug", Hash: "abc", Enabled: true}
	if err := s.UpsertPlugin(row); err != nil {
		t.Fatalf("UpsertPlugin: %v", err)
	}
	got, err := s.GetPluginRow("test-plug")
	if err != nil {
		t.Fatalf("GetPluginRow: %v", err)
	}
	if got.Name != "Test" || !got.Enabled || got.Hash != "abc" {
		t.Fatalf("round trip mismatch: %+v", got)
	}
	// Replace + toggle.
	row.Version = "1.1.0"
	row.Enabled = false
	if err := s.UpsertPlugin(row); err != nil {
		t.Fatalf("UpsertPlugin(replace): %v", err)
	}
	if err := s.SetPluginEnabledRow("test-plug", true); err != nil {
		t.Fatalf("SetPluginEnabledRow: %v", err)
	}
	rows, err := s.ListPluginRows()
	if err != nil || len(rows) != 1 {
		t.Fatalf("ListPluginRows: %v, %+v", err, rows)
	}
	if rows[0].Version != "1.1.0" || !rows[0].Enabled {
		t.Fatalf("replaced row mismatch: %+v", rows[0])
	}
	if err := s.DeletePluginRow("test-plug"); err != nil {
		t.Fatalf("DeletePluginRow: %v", err)
	}
	if _, err := s.GetPluginRow("test-plug"); err == nil {
		t.Fatal("GetPluginRow after delete succeeded, want ErrNotFound")
	}
}

// TestMetricsTableDDLByteEqual pins the coordination contract's byte
// level: metricsTableDDL (this file's defensive ensureMetricsTable copy,
// mirrored in its file-doc contract block) must be BYTE-IDENTICAL to the
// metrics CREATE in the embedded baseline schema. Column compatibility
// alone (metricColumnsContract) is not enough — a CHECK/DEFAULT/position
// drift would fork two definitions of the same table. The extraction
// mirrors TestAnalysisConfigDDLDefaultsMatchGoSeed's schemaSQL walk.
func TestMetricsTableDDLByteEqual(t *testing.T) {
	start := strings.Index(schemaSQL, "CREATE TABLE IF NOT EXISTS metrics (")
	if start < 0 {
		t.Fatal("metrics DDL missing from schema.sql")
	}
	end := strings.Index(schemaSQL[start:], ");")
	if end < 0 {
		t.Fatal("metrics DDL block not terminated")
	}
	// Through the closing ')' — metricsTableDDL carries no trailing ';'.
	block := schemaSQL[start : start+end+1]
	if block != metricsTableDDL {
		t.Fatalf("metricsTableDDL drifted from schema.sql\n--- schema.sql ---\n%s\n--- metricsTableDDL ---\n%s", block, metricsTableDDL)
	}
	t.Log("byte-equal: True")
}

func TestPluginMetricsRows(t *testing.T) {
	s := openMem(t)
	defs := []PluginMetricDef{
		{Name: "plug_count", Title: "Plug count", Expr: "from events: count()", Scope: "profile"},
		{Name: "plug_dmg", Title: "Plug dmg", Expr: "from events: sum(dmg)"},
	}
	if err := s.ReplacePluginMetrics("p1", defs); err != nil {
		t.Fatalf("ReplacePluginMetrics: %v", err)
	}
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM metrics WHERE plugin_id = 'p1' AND origin = 'plugin'`).Scan(&n); err != nil {
		t.Fatalf("count metrics: %v", err)
	}
	if n != 2 {
		t.Fatalf("metrics rows = %d, want 2", n)
	}
	// scope is WRITTEN THROUGH (W2): the declared profile scope lands,
	// an omitted scope normalizes to the DDL DEFAULT 'match' (the store's
	// omitted-field rule — same as CreateMetric), version stays DEFAULT 1.
	var scope string
	if err := s.db.QueryRow(`SELECT scope FROM metrics WHERE name = 'plug_count'`).Scan(&scope); err != nil {
		t.Fatalf("select scope: %v", err)
	}
	if scope != "profile" {
		t.Errorf("plug_count scope = %q, want profile (the manifest's scope written through)", scope)
	}
	if err := s.db.QueryRow(`SELECT scope FROM metrics WHERE name = 'plug_dmg'`).Scan(&scope); err != nil {
		t.Fatalf("select scope: %v", err)
	}
	if scope != "match" {
		t.Errorf("plug_dmg scope = %q, want match (omitted scope → the DDL default)", scope)
	}
	var version int
	if err := s.db.QueryRow(`SELECT version FROM metrics WHERE name = 'plug_count'`).Scan(&version); err != nil {
		t.Fatalf("select version: %v", err)
	}
	if version != 1 {
		t.Errorf("plug_count version = %d, want 1 (version stays the column DEFAULT)", version)
	}
	// Upsert keyed by name: re-replace with one changed row + one new name.
	if err := s.ReplacePluginMetrics("p1", []PluginMetricDef{
		{Name: "plug_count", Title: "Plug count v2", Expr: "from events: count()"},
		{Name: "plug_new", Title: "New", Expr: "from events: count()"},
	}); err != nil {
		t.Fatalf("ReplacePluginMetrics(replace): %v", err)
	}
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM metrics WHERE plugin_id = 'p1'`).Scan(&n); err != nil {
		t.Fatalf("count metrics: %v", err)
	}
	if n != 2 {
		t.Fatalf("after replace rows = %d, want 2 (upsert by name)", n)
	}
	var title string
	if err := s.db.QueryRow(`SELECT title FROM metrics WHERE name = 'plug_count'`).Scan(&title); err != nil {
		t.Fatalf("select title: %v", err)
	}
	if title != "Plug count v2" {
		t.Fatalf("title = %q, want upserted value", title)
	}
	// Disable path: delete only this plugin's rows.
	if err := s.DeletePluginMetrics("p1"); err != nil {
		t.Fatalf("DeletePluginMetrics: %v", err)
	}
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM metrics WHERE plugin_id = 'p1'`).Scan(&n); err != nil {
		t.Fatalf("count metrics: %v", err)
	}
	if n != 0 {
		t.Fatalf("after delete rows = %d, want 0", n)
	}
}
