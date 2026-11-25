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
	// The table closes on its own line; a ");" inside a comment is not the end.
	end := strings.Index(schemaSQL[start:], "\n);")
	if end < 0 {
		t.Fatal("metrics DDL block not terminated")
	}
	// Through the closing ')' — metricsTableDDL carries no trailing ';'.
	block := schemaSQL[start : start+end+2]
	if block != metricsTableDDL {
		t.Fatalf("metricsTableDDL drifted from schema.sql\n--- schema.sql ---\n%s\n--- metricsTableDDL ---\n%s", block, metricsTableDDL)
	}
	t.Log("byte-equal: True")
}

func TestPluginMetricsRows(t *testing.T) {
	s := openMem(t)
	defs := []PluginMetricDef{
		{Name: "plug_count", Title: "Plug count", Expr: "SELECT :steam_id AS subject_key, '' AS dim, COUNT(*) AS value FROM events"},
		{Name: "plug_dmg", Title: "Plug dmg", Expr: "SELECT '' AS subject_key, '' AS dim, SUM(dmg) AS value FROM events WHERE match_id = :match_id"},
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
	// No scope column (ruling 51): the scope is derived from the binds, so
	// the career-bound plug_count reads profile and the match-bound one match.
	byName := map[string]string{}
	all, err := s.ListMetrics()
	if err != nil {
		t.Fatalf("ListMetrics: %v", err)
	}
	for _, m := range all {
		byName[m.Name] = m.Scope
	}
	if byName["plug_count"] != "profile" {
		t.Errorf("plug_count scope = %q, want profile (derived from :steam_id)", byName["plug_count"])
	}
	if byName["plug_dmg"] != "match" {
		t.Errorf("plug_dmg scope = %q, want match (derived from :match_id)", byName["plug_dmg"])
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
		{Name: "plug_count", Title: "Plug count v2", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id"},
		{Name: "plug_new", Title: "New", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id"},
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

// TestReplacePluginMetricsRefusesBuiltinCollision pins the w23
// install-side guard: a bundled metric naming a BUILT-IN is refused
// BEFORE any write (the by-name upsert would overwrite the immutable
// built-in row — it only comes back on a wipe), the refusal names the
// problem in user copy, and nothing is mutated — no plugin rows land and
// the built-in row keeps its origin. A fresh name still lands through the
// same writer (the guard partitions by origin, it does not gate plugin
// metrics wholesale).
func TestReplacePluginMetricsRefusesBuiltinCollision(t *testing.T) {
	s := openMem(t)
	// Fixture sanity: trade_rate is one of the schema-seeded builtins.
	builtin, err := s.GetMetricByName("trade_rate")
	if err != nil {
		t.Fatalf("GetMetricByName(trade_rate): %v", err)
	}
	if builtin.Origin != "builtin" {
		t.Fatalf("trade_rate origin = %q, want builtin", builtin.Origin)
	}

	err = s.ReplacePluginMetrics("p1", []PluginMetricDef{
		{Name: "plug_ok", Title: "Ok", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id"},
		{Name: "trade_rate", Title: "Hijack", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id"},
	})
	if err == nil {
		t.Fatal("ReplacePluginMetrics with a builtin name succeeded, want the collision refusal")
	}
	if !strings.Contains(err.Error(), "built-in") || !strings.Contains(err.Error(), "rename") {
		t.Errorf("collision error = %q, want user copy naming the built-in and the fix", err)
	}
	// Nothing was written — the refusal runs before the transaction: no
	// rows for the plugin (not even the non-colliding def beside it) …
	if n, err := s.CountPluginMetrics("p1"); err != nil || n != 0 {
		t.Fatalf("plugin rows after refusal = %d, %v, want 0", n, err)
	}
	// … and the built-in row is untouched.
	after, err := s.GetMetricByName("trade_rate")
	if err != nil {
		t.Fatalf("GetMetricByName(after refusal): %v", err)
	}
	if after.Origin != "builtin" || after.ID != builtin.ID {
		t.Fatalf("builtin row after refusal = %+v, want the untouched seeded row", after)
	}

	// A fresh name still lands through the same writer.
	if err := s.ReplacePluginMetrics("p1", []PluginMetricDef{
		{Name: "plug_ok", Title: "Ok", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id"},
	}); err != nil {
		t.Fatalf("ReplacePluginMetrics(fresh name): %v", err)
	}
	if n, err := s.CountPluginMetrics("p1"); err != nil || n != 1 {
		t.Fatalf("plugin rows after a fresh name = %d, %v, want 1", n, err)
	}
}
