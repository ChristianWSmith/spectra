package store

import (
	"errors"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// metricColumnsContract is the coordination contract with
// platform_store.go (its metricsTableDDL must stay column-compatible).
// The pragma order below IS the migration's column order — drift breaks
// the plugin writer's explicit INSERT list.
var metricColumnsContract = []string{
	"id", "name", "title", "expr", "group_by", "format", "doc", "origin",
	"plugin_id", "denominator", "created_at",
}

// TestMigration005Metrics reopens a file store (migrations must be
// idempotent) and asserts the M5 tables, the metrics column contract, and
// the seven PRD §5.16 builtin fixtures.
func TestMigration005Metrics(t *testing.T) {
	s, path := openFileStore(t)
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	s2, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	t.Cleanup(func() {
		_ = s2.CloseRO()
		_ = s2.Close()
	})

	for _, table := range []string{"metrics", "query_history", "saved_queries"} {
		var name string
		if err := s2.db.QueryRow(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table,
		).Scan(&name); err != nil {
			t.Fatalf("table %s missing: %v", table, err)
		}
	}
	var applied int
	if err := s2.db.QueryRow(
		`SELECT COUNT(*) FROM schema_version WHERE name = '005_metrics.sql'`,
	).Scan(&applied); err != nil || applied != 1 {
		t.Fatalf("005_metrics.sql applied rows = %d (err %v), want 1", applied, err)
	}

	// Column contract (platform_store.go coordination).
	rows, err := s2.db.Query(`SELECT name FROM pragma_table_info('metrics')`)
	if err != nil {
		t.Fatalf("pragma_table_info: %v", err)
	}
	var got []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			t.Fatalf("scan: %v", err)
		}
		got = append(got, n)
	}
	rows.Close()
	if len(got) != len(metricColumnsContract) {
		t.Fatalf("metrics columns = %v, want %v", got, metricColumnsContract)
	}
	for i, n := range got {
		if n != metricColumnsContract[i] {
			t.Errorf("metrics column %d = %q, want %q", i, n, metricColumnsContract[i])
		}
	}

	// The seven builtins, names + doc present (values validated by
	// internal/metrics fixture tests).
	list, err := s2.ListMetrics()
	if err != nil {
		t.Fatalf("ListMetrics: %v", err)
	}
	if len(list) != 7 {
		t.Fatalf("builtin count = %d, want 7", len(list))
	}
	want := map[string]bool{
		"untraded_deaths": true, "successful_trades": true,
		"flash_assisted_kills": true, "utility_value_per_round": true,
		"round_win_rate": true, "isolated_deaths": true,
		"opening_kill_round_win_pct": true,
	}
	for _, m := range list {
		if m.Origin != "builtin" {
			t.Errorf("metric %q origin = %q, want builtin", m.Name, m.Origin)
		}
		if !want[m.Name] {
			t.Errorf("unexpected builtin %q", m.Name)
		}
		if m.Doc == "" {
			t.Errorf("builtin %q has empty doc", m.Name)
		}
		if !strings.HasPrefix(m.Expr, "from ") {
			t.Errorf("builtin %q expr %q missing source clause", m.Name, m.Expr)
		}
	}
}

// TestMetricCRUD covers create/list ordering/uniqueness/update
// protection/delete protection — the API surface metricservice wraps.
func TestMetricCRUD(t *testing.T) {
	s := openMem(t)

	created, err := s.CreateMetric(models.MetricRow{
		Name: "my_rate", Title: "My rate", Expr: "from events: count()",
		GroupBy: "player", Format: "int", Doc: "d", Origin: "user",
	})
	if err != nil {
		t.Fatalf("CreateMetric: %v", err)
	}
	if created.ID == 0 || created.CreatedAt.IsZero() {
		t.Fatalf("created row = %+v, want id + created_at set", created)
	}

	// Uniqueness across ALL origins: colliding with a builtin is rejected
	// with the friendly message (SaveMetric's builtin-collision rule).
	if _, err := s.CreateMetric(models.MetricRow{Name: "round_win_rate", Expr: "from rounds: count()", Origin: "user"}); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Errorf("builtin-name collision err = %v, want friendly uniqueness error", err)
	}
	if _, err := s.CreateMetric(models.MetricRow{Name: "my_rate", Expr: "from events: count()", Origin: "user"}); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Errorf("duplicate-name err = %v, want friendly uniqueness error", err)
	}

	// List: builtins first, then user rows.
	all, err := s.ListMetrics()
	if err != nil {
		t.Fatalf("ListMetrics: %v", err)
	}
	if len(all) != 8 {
		t.Fatalf("list len = %d, want 8 (7 builtins + my_rate)", len(all))
	}
	if all[0].Origin != "builtin" || all[7].Name != "my_rate" || all[7].Origin != "user" {
		t.Fatalf("list order wrong: first = %s/%s, last = %s/%s", all[0].Origin, all[0].Name, all[7].Origin, all[7].Name)
	}

	// Update user metric.
	updated, err := s.UpdateMetric(models.MetricRow{
		ID: created.ID, Name: "my_rate", Title: "Renamed", Expr: "from rounds: count()",
		GroupBy: "round", Origin: "user",
	})
	if err != nil {
		t.Fatalf("UpdateMetric: %v", err)
	}
	if updated.Title != "Renamed" || updated.Expr != "from rounds: count()" {
		t.Fatalf("updated = %+v", updated)
	}

	// Builtin + plugin rows are immutable through Update/Delete.
	var builtinID int64
	for _, m := range all {
		if m.Origin == "builtin" {
			builtinID = m.ID
			break
		}
	}
	if _, err := s.UpdateMetric(models.MetricRow{ID: builtinID, Name: "x", Expr: "from events: count()"}); err == nil || !strings.Contains(err.Error(), "cannot be modified") {
		t.Errorf("builtin update err = %v, want immutability error", err)
	}
	if err := s.DeleteMetric(builtinID); err == nil || !strings.Contains(err.Error(), "cannot be deleted") {
		t.Errorf("builtin delete err = %v, want protection error", err)
	}
	if err := s.ReplacePluginMetrics("p1", []PluginMetricDef{{Name: "plug_a", Title: "A", Expr: "from events: count()", GroupBy: "none"}}); err != nil {
		t.Fatalf("ReplacePluginMetrics: %v", err)
	}
	var pluginMetric models.MetricRow
	for _, m := range mustList(t, s) {
		if m.Origin == "plugin" {
			pluginMetric = m
		}
	}
	if pluginMetric.ID == 0 {
		t.Fatal("plugin metric row missing from ListMetrics")
	}
	if _, err := s.UpdateMetric(models.MetricRow{ID: pluginMetric.ID, Name: "hijack", Expr: "from events: count()"}); err == nil || !strings.Contains(err.Error(), "cannot be modified") {
		t.Errorf("plugin update err = %v, want immutability error", err)
	}
	// Plugin rows ARE deletable via the generic path (host re-seeds on enable).
	if err := s.DeleteMetric(pluginMetric.ID); err != nil {
		t.Errorf("plugin delete: %v", err)
	}

	// Delete user metric; unknown id → ErrNotFound.
	if err := s.DeleteMetric(created.ID); err != nil {
		t.Fatalf("DeleteMetric: %v", err)
	}
	if _, err := s.GetMetric(created.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetMetric after delete = %v, want ErrNotFound", err)
	}
	if err := s.DeleteMetric(999999); !errors.Is(err, ErrNotFound) {
		t.Errorf("DeleteMetric(unknown) = %v, want ErrNotFound", err)
	}
	if err := s.DeleteMetric(builtinID); err == nil {
		t.Error("builtin still deletable after user delete")
	}
}

func mustList(t *testing.T, s *Store) []models.MetricRow {
	t.Helper()
	rows, err := s.ListMetrics()
	if err != nil {
		t.Fatalf("ListMetrics: %v", err)
	}
	return rows
}
