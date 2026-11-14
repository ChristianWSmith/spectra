package store

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// metricColumnsContract is the coordination contract with
// platform_store.go (its metricsTableDDL must stay column-compatible).
// The pragma order below IS the schema.sql column order — drift breaks
// the plugin writer's explicit INSERT list.
//
// NO-HISTORY ruling (stored-metrics owner ruling, 2026-11-13): definitions
// are ONE current row — this list must gain NO shadow/last-expression
// column, no history table's worth of copies. A future "keep the old
// expression" column (or any other definition-history column) is a
// CONTRACT VIOLATION and must fail this test; computed values keep only
// their current generation (metric_values), never definitions.
var metricColumnsContract = []string{
	"id", "name", "title", "short_name", "expr", "scope", "format", "doc", "origin",
	"plugin_id", "denominator", "version", "created_at",
}

// schemaSeededBuiltins is the schema.sql seed's per-row contract: every
// builtin's scope, format and short_name (design §3.0's candidates→
// seeds table — 7 match / 9 profile; trade_rate is the one row that
// ships an empty short_name). The fixture VALUES/exprs live in
// internal/metrics' fixture test; this map is the store-side pin that
// every row lands with the shape the seed declares.
var schemaSeededBuiltins = map[string]struct{ scope, format, shortName string }{
	// match scope (7) — trade_rate + the scoreboard/Combat conversions.
	"trade_rate":        {"match", "percent", ""},
	"adr":               {"match", "float1", "ADR"},
	"entry_rate":        {"match", "percent", "Entry%"},
	"hs_pct":            {"match", "percent", "HS%"},
	"kast":              {"match", "percent", "KAST%"},
	"kd":                {"match", "float2", "K/D"},
	"trade_rate_deaths": {"match", "percent", "Trade%"},
	// profile scope (9) — the career set, inert until W3 switches the
	// profile surface to it.
	"career_adr":                 {"profile", "float1", "ADR"},
	"career_adr_sigma":           {"profile", "float1", "ADR σ"},
	"career_avg_enemies_flashed": {"profile", "float1", "Avg enemies flashed"},
	"career_avg_util_damage":     {"profile", "float1", "Avg util damage"},
	"career_clutch_win_rate":     {"profile", "percent", "Clutch win %"},
	"career_hs_pct":              {"profile", "percent", "HS%"},
	"career_kast":                {"profile", "percent", "KAST%"},
	"career_kd":                  {"profile", "float2", "K/D"},
	"career_trade_rate":          {"profile", "percent", "Trade rate"},
}

// TestMetricsSchemaFreshOpen: a fresh Open creates the M5 tables and
// seeds the sixteen builtin metrics; a second Open re-applies the
// baseline as a no-op — the seed INSERT is idempotent, so no builtin
// rows are duplicated — and the metrics column contract plus the
// builtin set still hold.
func TestMetricsSchemaFreshOpen(t *testing.T) {
	s, path := openFileStore(t)
	for _, table := range []string{"metrics", "metric_values", "metric_deps", "query_history", "saved_queries"} {
		var name string
		if err := s.db.QueryRow(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table,
		).Scan(&name); err != nil {
			t.Fatalf("table %s missing on fresh Open: %v", table, err)
		}
	}
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

	for _, table := range []string{"metrics", "metric_values", "metric_deps", "query_history", "saved_queries"} {
		var name string
		if err := s2.db.QueryRow(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table,
		).Scan(&name); err != nil {
			t.Fatalf("table %s missing after reopen: %v", table, err)
		}
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

	// The sixteen builtins, name + doc present — still exactly sixteen
	// AFTER the reopen, so the baseline's seed did not duplicate rows
	// (values validated by internal/metrics fixture tests). Scope split
	// (7 match / 9 profile) and short_name/format are PER-SEED asserts
	// (the old blanket "all match / all short_name empty" held only when
	// there was one row — design §3.4's pin table).
	list, err := s2.ListMetrics()
	if err != nil {
		t.Fatalf("ListMetrics: %v", err)
	}
	if len(list) != len(schemaSeededBuiltins) {
		t.Fatalf("builtin count after reopen = %d, want %d (no duplicate seed rows)",
			len(list), len(schemaSeededBuiltins))
	}
	want := map[string]bool{}
	for name := range schemaSeededBuiltins {
		want[name] = true
	}
	for _, m := range list {
		if m.Origin != "builtin" {
			t.Errorf("metric %q origin = %q, want builtin", m.Name, m.Origin)
		}
		seeded, ok := schemaSeededBuiltins[m.Name]
		if !ok {
			t.Errorf("unexpected builtin %q", m.Name)
			continue
		}
		if !want[m.Name] {
			t.Errorf("unexpected builtin %q", m.Name)
		}
		if m.Doc == "" {
			t.Errorf("builtin %q has empty doc", m.Name)
		}
		if m.ShortName != seeded.shortName {
			t.Errorf("builtin %q short_name = %q, want %q (per-seed: trade_rate ships empty, the dogfooding set its header label)",
				m.Name, m.ShortName, seeded.shortName)
		}
		if m.Scope != seeded.scope {
			t.Errorf("builtin %q scope = %q, want %q (the seed writes the per-row scope — 7 match / 9 profile)",
				m.Name, m.Scope, seeded.scope)
		}
		if m.Format != seeded.format {
			t.Errorf("builtin %q format = %q, want %q", m.Name, m.Format, seeded.format)
		}
		if m.Version != 1 {
			t.Errorf("builtin %q version = %d, want 1 (the seed omits the column — DEFAULT 1)", m.Name, m.Version)
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
		Name: "my_rate", Title: "My rate", ShortName: "MR", Expr: "from events: count()",
		Scope: "profile", Format: "int", Doc: "d", Origin: "user",
	})
	if err != nil {
		t.Fatalf("CreateMetric: %v", err)
	}
	if created.ID == 0 || created.CreatedAt.IsZero() {
		t.Fatalf("created row = %+v, want id + created_at set", created)
	}
	if created.ShortName != "MR" {
		t.Fatalf("created short_name = %q, want %q (round-trip through the new column)", created.ShortName, "MR")
	}
	if created.Scope != "profile" {
		t.Fatalf("created scope = %q, want %q (round-trip through the new column — not the DEFAULT)", created.Scope, "profile")
	}
	if created.Version != 1 {
		t.Fatalf("created version = %d, want 1 (INSERT omits the column — DEFAULT 1)", created.Version)
	}

	// Uniqueness across ALL origins: colliding with a builtin is rejected
	// with the friendly message (SaveMetric's builtin-collision rule).
	if _, err := s.CreateMetric(models.MetricRow{Name: "trade_rate", Expr: "from rounds: count()", Origin: "user"}); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Errorf("builtin-name collision err = %v, want friendly uniqueness error", err)
	}
	if _, err := s.CreateMetric(models.MetricRow{Name: "my_rate", Expr: "from events: count()", Origin: "user"}); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Errorf("duplicate-name err = %v, want friendly uniqueness error", err)
	}

	// List: builtins first (all sixteen schema-seeded rows), then user
	// rows.
	all, err := s.ListMetrics()
	if err != nil {
		t.Fatalf("ListMetrics: %v", err)
	}
	if len(all) != len(schemaSeededBuiltins)+1 {
		t.Fatalf("list len = %d, want %d (16 builtins + my_rate)", len(all), len(schemaSeededBuiltins)+1)
	}
	for i, m := range all[:len(schemaSeededBuiltins)] {
		if m.Origin != "builtin" {
			t.Fatalf("list position %d = %s/%s, want the builtin group first", i, m.Origin, m.Name)
		}
	}
	if last := all[len(all)-1]; last.Name != "my_rate" || last.Origin != "user" {
		t.Fatalf("list order wrong: last = %s/%s, want user/my_rate", last.Origin, last.Name)
	}

	// Update user metric (scope is written through; version is NOT bumped
	// by the store in W1 — the semantic-edit bump lands with the
	// save-side cascade wave).
	updated, err := s.UpdateMetric(models.MetricRow{
		ID: created.ID, Name: "my_rate", Title: "Renamed", ShortName: "MR2", Expr: "from rounds: count()",
		Scope: "match", Origin: "user",
	})
	if err != nil {
		t.Fatalf("UpdateMetric: %v", err)
	}
	if updated.Title != "Renamed" || updated.Expr != "from rounds: count()" || updated.ShortName != "MR2" {
		t.Fatalf("updated = %+v", updated)
	}
	if updated.Scope != "match" {
		t.Fatalf("updated scope = %q, want match (UPDATE writes scope through)", updated.Scope)
	}
	if updated.Version != 1 {
		t.Fatalf("updated version = %d, want 1 (no bump on update in W1)", updated.Version)
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
	if err := s.ReplacePluginMetrics("p1", []PluginMetricDef{{Name: "plug_a", Title: "A", Expr: "from events: count()"}}); err != nil {
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
	if pluginMetric.ShortName != "" {
		t.Errorf("plugin metric short_name = %q, want empty (ReplacePluginMetrics omits the column — DEFAULT '')", pluginMetric.ShortName)
	}
	if pluginMetric.Scope != "match" {
		t.Errorf("plugin metric scope = %q, want match (plugin manifests carry no scope yet — the INSERT omits the column, DEFAULT 'match')", pluginMetric.Scope)
	}
	if pluginMetric.Version != 1 {
		t.Errorf("plugin metric version = %d, want 1 (the INSERT omits the column — DEFAULT 1)", pluginMetric.Version)
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

// --- ListMetricsPage (the Builder list's keyset "Load more" window) ---------

// seedUserMetric creates a user metric (title defaults to the name) and
// returns its id.
func seedUserMetric(t *testing.T, s *Store, name, title string) int64 {
	t.Helper()
	if title == "" {
		title = name
	}
	m, err := s.CreateMetric(models.MetricRow{
		Name: name, Title: title, Expr: "from events: count()", Origin: "user",
	})
	if err != nil {
		t.Fatalf("CreateMetric(%s): %v", name, err)
	}
	return m.ID
}

// metricRowsRef reads the unbounded ListMetrics list — the reference
// every window walk is compared against (same canonical order).
func metricRowsRef(t *testing.T, s *Store) []models.MetricRow {
	t.Helper()
	return mustList(t, s)
}

// metricIDs is the rows' ids in order.
func metricIDs(rows []models.MetricRow) []int64 {
	ids := make([]int64, 0, len(rows))
	for _, m := range rows {
		ids = append(ids, m.ID)
	}
	return ids
}

// walkMetricPage drains every window from afterID for query under the
// origin filter, returning each window's row count and the concatenated
// rows in order. Fails on a runaway loop (a cursor that never advances
// would spin).
func walkMetricPage(t *testing.T, s *Store, query string, originFilter string, afterID int64, limit int) (sizes []int, rows []models.MetricRow) {
	t.Helper()
	seen := 0
	for {
		page, err := s.ListMetricsPage(query, originFilter, afterID, limit)
		if err != nil {
			t.Fatalf("ListMetricsPage(query=%q, origin=%q, after=%d): %v", query, originFilter, afterID, err)
		}
		sizes = append(sizes, len(page.Rows))
		rows = append(rows, page.Rows...)
		if !page.HasNext {
			return sizes, rows
		}
		if len(page.Rows) == 0 {
			t.Fatalf("window after=%d reported HasNext with no rows", afterID)
		}
		afterID = page.Rows[len(page.Rows)-1].ID
		if seen++; seen > 1000 {
			t.Fatalf("paging did not terminate after 1000 windows")
		}
	}
}

// originRank mirrors metricOriginRank for the contiguity assertion.
func originRank(origin string) int {
	switch origin {
	case "builtin":
		return 0
	case "user":
		return 1
	default:
		return 2
	}
}

// filterMetricRef is ListMetricsPage's search predicate as the Go-side
// reference (LIKE over name/title, ASCII case-insensitive) — the filtered
// list every filtered walk is compared against.
func filterMetricRef(rows []models.MetricRow, query string) []models.MetricRow {
	q := strings.ToLower(query)
	var out []models.MetricRow
	for _, m := range rows {
		if strings.Contains(strings.ToLower(m.Name), q) || strings.Contains(strings.ToLower(m.Title), q) {
			out = append(out, m)
		}
	}
	return out
}

// TestListMetricsPageWindowsTileListOrder: 249 definitions (16
// schema-seeded builtins + 230 user + 3 plugin) must tile into
// 100/100/49 windows that concatenate to ListMetrics' exact order, every
// id exactly once, with each origin group CONTIGUOUS across window
// boundaries — the Builder renders its Builtins/Yours/Plugins headers
// from those runs, so a boundary splitting a group must not reorder rows.
func TestListMetricsPageWindowsTileListOrder(t *testing.T) {
	s := openMem(t)
	for i := range 230 {
		seedUserMetric(t, s, fmt.Sprintf("u%03d_metric", i), "")
	}
	if err := s.ReplacePluginMetrics("p1", []PluginMetricDef{
		{Name: "plug_a", Title: "Plugin A", Expr: "from events: count()"},
		{Name: "plug_b", Title: "Plugin B", Expr: "from events: count()"},
		{Name: "plug_c", Title: "Plugin C", Expr: "from events: count()"},
	}); err != nil {
		t.Fatalf("ReplacePluginMetrics: %v", err)
	}

	ref := metricRowsRef(t, s)
	if len(ref) != 249 {
		t.Fatalf("reference list = %d rows, want 249 (16 builtins + 230 user + 3 plugin)", len(ref))
	}
	sizes, got := walkMetricPage(t, s, "", "", 0, ListMetricsPageSize)
	if len(sizes) != 3 || sizes[0] != 100 || sizes[1] != 100 || sizes[2] != 49 {
		t.Errorf("window sizes = %v, want [100 100 49]", sizes)
	}
	if !sameIDs(metricIDs(got), metricIDs(ref)) {
		t.Errorf("paged ids diverge from the ListMetrics reference order")
	}
	seen := map[int64]int{}
	for _, m := range got {
		seen[m.ID]++
	}
	for id, n := range seen {
		if n != 1 {
			t.Errorf("id %d appeared %d times across windows", id, n)
		}
	}

	// Group-ordered walk: ranks never decrease, so each origin is exactly
	// one contiguous run (the view's header suppression rule).
	prev := -1
	for _, m := range got {
		r := originRank(m.Origin)
		if r < prev {
			t.Fatalf("origin %q (id %d) reopened an earlier group — the walk must stay group-ordered", m.Origin, m.ID)
		}
		prev = r
	}
}

// TestListMetricsPageWindowBoundaries pins the exact boundary: 100 rows
// (16 builtins + 84 users) is ONE window with HasNext false (the limit+1
// probe found no row), 101 rows splits 100/1 with HasNext flipping
// correctly, and limit 0 selects the default window size.
func TestListMetricsPageWindowBoundaries(t *testing.T) {
	s := openMem(t)
	for i := range 84 {
		seedUserMetric(t, s, fmt.Sprintf("b%03d", i), "")
	}

	page, err := s.ListMetricsPage("", "", 0, 0)
	if err != nil {
		t.Fatalf("ListMetricsPage: %v", err)
	}
	if len(page.Rows) != 100 || page.HasNext {
		t.Errorf("100 rows → %d rows, HasNext=%v; want 100, false", len(page.Rows), page.HasNext)
	}

	// The 101st row: the first window now reports a successor.
	seedUserMetric(t, s, "b084", "")
	ref := metricIDs(metricRowsRef(t, s))
	if len(ref) != 101 {
		t.Fatalf("reference = %d rows, want 101", len(ref))
	}
	first, err := s.ListMetricsPage("", "", 0, ListMetricsPageSize)
	if err != nil {
		t.Fatalf("ListMetricsPage(first): %v", err)
	}
	if len(first.Rows) != 100 || !first.HasNext {
		t.Fatalf("101 rows → first window %d rows, HasNext=%v; want 100, true", len(first.Rows), first.HasNext)
	}
	if !sameIDs(metricIDs(first.Rows), ref[:100]) {
		t.Errorf("first window = %v…, want the first 100 reference ids", metricIDs(first.Rows)[:3])
	}
	cursor := first.Rows[len(first.Rows)-1].ID
	second, err := s.ListMetricsPage("", "", cursor, ListMetricsPageSize)
	if err != nil {
		t.Fatalf("ListMetricsPage(second): %v", err)
	}
	if len(second.Rows) != 1 || second.HasNext {
		t.Errorf("101 rows → second window %d rows, HasNext=%v; want 1, false", len(second.Rows), second.HasNext)
	}
	if !sameIDs(metricIDs(second.Rows), ref[100:]) {
		t.Errorf("second window = %v, want the final reference id %v", metricIDs(second.Rows), ref[100:])
	}
}

// TestListMetricsPageCursorPositions covers a cursor into the middle of
// the list, a cursor at the very last row (empty window, HasNext false,
// non-nil rows — never an error), and a cursor row that no longer exists
// (ErrNotFound, never a silently mis-placed page).
func TestListMetricsPageCursorPositions(t *testing.T) {
	s := openMem(t)
	for i := range 250 {
		seedUserMetric(t, s, fmt.Sprintf("c%03d", i), "")
	}
	ref := metricIDs(metricRowsRef(t, s)) // 16 builtins + 250 users

	// Cursor at the 100th row in order → the remaining 166.
	page, err := s.ListMetricsPage("", "", ref[99], 200)
	if err != nil {
		t.Fatalf("ListMetricsPage(mid): %v", err)
	}
	if len(page.Rows) != 166 || page.HasNext {
		t.Errorf("mid cursor → %d rows, HasNext=%v; want 166, false", len(page.Rows), page.HasNext)
	}
	if !sameIDs(metricIDs(page.Rows), ref[100:]) {
		t.Errorf("mid cursor rows = %v…, want the 166 ids after the cursor", metricIDs(page.Rows)[:3])
	}

	// Cursor at the last row → an empty window, no successor.
	last := ref[len(ref)-1]
	page, err = s.ListMetricsPage("", "", last, 200)
	if err != nil {
		t.Fatalf("ListMetricsPage(end): %v", err)
	}
	if len(page.Rows) != 0 || page.HasNext {
		t.Errorf("end cursor → %d rows, HasNext=%v; want 0, false", len(page.Rows), page.HasNext)
	}
	if page.Rows == nil {
		t.Error("empty window rows = nil, want an empty (non-nil) slice for the JSON []")
	}

	// A cursor row that was deleted → ErrNotFound.
	if _, err := s.ListMetricsPage("", "", 999999, 200); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing cursor err = %v, want store.ErrNotFound", err)
	}
}

// TestListMetricsPageSearch pins the server-side filter: a
// case-insensitive LIKE over name AND title (the store.ListPlayers
// spelling), applied in the SAME WHERE as the cursor so a filtered walk
// tiles the filtered reference exactly; an empty query is the unfiltered
// list, and a query matching nothing is an empty non-nil window.
func TestListMetricsPageSearch(t *testing.T) {
	s := openMem(t)
	seedUserMetric(t, s, "kd_ratio", "K/D ratio")
	seedUserMetric(t, s, "adr_per_round", "ADR per round")
	seedUserMetric(t, s, "win_rate", "Win rate")
	if err := s.ReplacePluginMetrics("p1", []PluginMetricDef{
		{Name: "plug_kd", Title: "Plugin K/D", Expr: "from events: count()"},
	}); err != nil {
		t.Fatalf("ReplacePluginMetrics: %v", err)
	}
	ref := metricRowsRef(t, s)

	// Name substring, ASCII case-insensitive: "adr" and "ADR" hit the
	// SAME four rows — the three builtins whose name/title carries the
	// substring (adr, career_adr, career_adr_sigma — the dogfooding set
	// landed with W2) plus the user's adr_per_round — in the canonical
	// group order (builtins name-ASC, then user).
	for _, q := range []string{"adr", "ADR"} {
		page, err := s.ListMetricsPage(q, "", 0, 100)
		if err != nil {
			t.Fatalf("ListMetricsPage(%q): %v", q, err)
		}
		if len(page.Rows) != 4 || page.HasNext {
			t.Errorf("query %q → %d rows (HasNext=%v), want 4 (3 builtins + adr_per_round)",
				q, len(page.Rows), page.HasNext)
			continue
		}
		if page.Rows[0].Name != "adr" {
			t.Errorf("query %q first row = %q, want the builtin adr (builtins sort first)", q, page.Rows[0].Name)
		}
		if want := metricIDs(filterMetricRef(ref, q)); !sameIDs(metricIDs(page.Rows), want) {
			t.Errorf("query %q ids = %v, want the filtered reference %v", q, metricIDs(page.Rows), want)
		}
	}

	// Title-only substring: "K/D" appears in no name, but in four
	// titles — the two K/D builtins (career_kd, kd — name-ASC), the
	// user's "K/D ratio" then the plugin's "Plugin K/D" (the canonical
	// group order still holds).
	page, err := s.ListMetricsPage("K/D", "", 0, 100)
	if err != nil {
		t.Fatalf("ListMetricsPage(K/D): %v", err)
	}
	if got := metricIDs(page.Rows); len(got) != 4 || page.HasNext {
		t.Fatalf("title query → %d rows (HasNext=%v), want 4", len(got), page.HasNext)
	} else if want := metricIDs(filterMetricRef(ref, "K/D")); !sameIDs(got, want) {
		t.Errorf("title query ids = %v, want %v", got, want)
	}

	// The filtered walk (windows of 1) tiles the filtered reference
	// exactly — the cursor resolves inside the filtered set too.
	sizes, walked := walkMetricPage(t, s, "k/d", "", 0, 1)
	want := filterMetricRef(ref, "k/d")
	if len(sizes) != len(want) {
		t.Errorf("filtered walk = %d windows for %d matches, want one window per match", len(sizes), len(want))
	}
	if !sameIDs(metricIDs(walked), metricIDs(want)) {
		t.Errorf("filtered walk ids = %v, want %v", metricIDs(walked), metricIDs(want))
	}

	// No match: an empty (non-nil) window, no successor.
	page, err = s.ListMetricsPage("zz_no_such_metric", "", 0, 100)
	if err != nil {
		t.Fatalf("ListMetricsPage(no match): %v", err)
	}
	if len(page.Rows) != 0 || page.HasNext {
		t.Errorf("no-match query → %d rows (HasNext=%v), want 0, false", len(page.Rows), page.HasNext)
	}
	if page.Rows == nil {
		t.Error("no-match window rows = nil, want an empty (non-nil) slice for the JSON []")
	}

	// Empty query = the whole unfiltered list.
	page, err = s.ListMetricsPage("", "", 0, 1000)
	if err != nil {
		t.Fatalf("ListMetricsPage(empty): %v", err)
	}
	if !sameIDs(metricIDs(page.Rows), metricIDs(ref)) {
		t.Errorf("empty-query window = %v…, want the full reference order", metricIDs(page.Rows)[:3])
	}
}

// originFilterMetricRef applies ListMetricsPage's origin filter as the
// Go-side reference — the SAME partition the SQL spells ("" = all,
// "builtin" = origin == builtin, "mine" = everything else, "none" =
// empty) — derived here independently of the store's WHERE builder, so
// every filtered walk below is compared against a list the test computed
// for itself.
func originFilterMetricRef(rows []models.MetricRow, filter string) []models.MetricRow {
	switch filter {
	case "builtin":
		var out []models.MetricRow
		for _, m := range rows {
			if m.Origin == "builtin" {
				out = append(out, m)
			}
		}
		return out
	case "mine":
		var out []models.MetricRow
		for _, m := range rows {
			if m.Origin != "builtin" {
				out = append(out, m)
			}
		}
		return out
	case "none":
		return []models.MetricRow{}
	default:
		return rows
	}
}

// TestListMetricsPageOriginFilter pins the built-in partition filter —
// the server-side predicate behind the Builder's Built-in / My metrics
// toggles: each filter value selects exactly its side of the partition
// (a client-side filter over a page window would be wrong, so the
// partition is asserted over KEYSET WINDOWS too), "none" (both toggles
// off) is a legal empty read with a non-nil window, and an unknown value
// is rejected before any SQL.
func TestListMetricsPageOriginFilter(t *testing.T) {
	s := openMem(t)
	for i := range 5 {
		seedUserMetric(t, s, fmt.Sprintf("u%d_metric", i), "")
	}
	if err := s.ReplacePluginMetrics("p1", []PluginMetricDef{
		{Name: "plug_a", Title: "Plugin A", Expr: "from events: count()"},
		{Name: "plug_b", Title: "Plugin B", Expr: "from events: count()"},
	}); err != nil {
		t.Fatalf("ReplacePluginMetrics: %v", err)
	}
	ref := metricRowsRef(t, s) // 16 builtins + 5 user + 2 plugin
	if len(ref) != 23 {
		t.Fatalf("reference = %d rows, want 23 (16 builtins + 5 user + 2 plugin)", len(ref))
	}

	// Every filter value in ONE window: exactly its partition, in the
	// canonical order, with no successor beyond it.
	for _, filter := range []string{"", "builtin", "mine", "none"} {
		want := originFilterMetricRef(ref, filter)
		page, err := s.ListMetricsPage("", filter, 0, 100)
		if err != nil {
			t.Fatalf("ListMetricsPage(origin=%q): %v", filter, err)
		}
		if !sameIDs(metricIDs(page.Rows), metricIDs(want)) {
			t.Errorf("origin=%q window = %v, want the partition ids %v", filter, metricIDs(page.Rows), metricIDs(want))
		}
		if page.HasNext {
			t.Errorf("origin=%q reported HasNext for its %d rows in one window", filter, len(want))
		}
		if filter == "none" && page.Rows == nil {
			t.Error("both-off window rows = nil, want an empty (non-nil) slice for the JSON []")
		}
	}

	// The partition holds ACROSS keyset windows: "mine" in windows of 2
	// tiles the mine reference exactly — sizes, order, no duplicates —
	// and no builtin row ever leaks into a mine window.
	sizes, got := walkMetricPage(t, s, "", "mine", 0, 2)
	wantMine := originFilterMetricRef(ref, "mine") // 7 rows → [2 2 2 1]
	if len(sizes) != 4 || sizes[0] != 2 || sizes[1] != 2 || sizes[2] != 2 || sizes[3] != 1 {
		t.Errorf("mine window sizes = %v, want [2 2 2 1]", sizes)
	}
	if !sameIDs(metricIDs(got), metricIDs(wantMine)) {
		t.Errorf("mine walk ids = %v, want %v", metricIDs(got), metricIDs(wantMine))
	}
	for _, m := range got {
		if m.Origin == "builtin" {
			t.Errorf("builtin %q leaked into a mine window", m.Name)
		}
	}

	// Unknown filter value: rejected before any SQL (no window).
	if _, err := s.ListMetricsPage("", "everything", 0, 100); err == nil ||
		!strings.Contains(err.Error(), `unknown origin filter "everything"`) {
		t.Errorf("unknown filter err = %v, want the friendly pre-SQL rejection", err)
	}
}

// TestListMetricsPageOriginFilterSearchAndCursor pins the filter
// COMPOSING with the search (both ride the SAME WHERE — a query that
// matches a builtin AND a user row is partitioned, never unioned) and
// with the cursor (a cursor row OUTSIDE the filtered set still resolves
// to its stored key, so a walk starting from it continues exactly; the
// Builder itself resets to cursor 0 on every toggle).
func TestListMetricsPageOriginFilterSearchAndCursor(t *testing.T) {
	s := openMem(t)
	seedUserMetric(t, s, "my_trade_rate", "My trade rate")
	seedUserMetric(t, s, "adr_per_round", "ADR per round")
	ref := metricRowsRef(t, s) // 16 builtins (incl. trade_rate + career_trade_rate) + 2 users

	// "trade rate" matches TWO builtin titles (trade_rate — the original
	// seed — and career_trade_rate — the profile twin the dogfooding set
	// added) and the user's title — one term spanning both sides of the
	// partition.
	hit := filterMetricRef(ref, "trade rate")
	if len(hit) != 3 {
		t.Fatalf(`query fixture: "trade rate" matched %d rows, want 3 (2 builtins + user)`, len(hit))
	}
	for _, tc := range []struct {
		filter string
		want   int
	}{
		{"", 3}, {"builtin", 2}, {"mine", 1}, {"none", 0},
	} {
		page, err := s.ListMetricsPage("trade rate", tc.filter, 0, 100)
		if err != nil {
			t.Fatalf("ListMetricsPage(q, origin=%q): %v", tc.filter, err)
		}
		want := originFilterMetricRef(hit, tc.filter)
		if len(page.Rows) != tc.want || !sameIDs(metricIDs(page.Rows), metricIDs(want)) {
			t.Errorf("q+origin=%q → %d rows (%v), want %d (%v)",
				tc.filter, len(page.Rows), metricIDs(page.Rows), tc.want, metricIDs(want))
		}
	}
	// Case-insensitive on BOTH sides: an upper-case term partitions the
	// same way (SQLite LIKE's ASCII folding).
	page, err := s.ListMetricsPage("TRADE RATE", "mine", 0, 100)
	if err != nil {
		t.Fatalf("ListMetricsPage(upper, mine): %v", err)
	}
	if wantIDs := metricIDs(originFilterMetricRef(hit, "mine")); !sameIDs(metricIDs(page.Rows), wantIDs) {
		t.Errorf("upper-case q+mine = %v, want %v", metricIDs(page.Rows), wantIDs)
	}

	// The composed filtered walk (windows of 1) tiles the composed
	// reference exactly — filter AND search inside one WHERE.
	sizes, walked := walkMetricPage(t, s, "trade rate", "mine", 0, 1)
	want := originFilterMetricRef(hit, "mine")
	if len(sizes) != len(want) {
		t.Errorf("composed walk = %d windows for %d matches, want one window per match", len(sizes), len(want))
	}
	if !sameIDs(metricIDs(walked), metricIDs(want)) {
		t.Errorf("composed walk ids = %v, want %v", metricIDs(walked), metricIDs(want))
	}

	// CURSOR outside the filtered set: the builtin row is the cursor of
	// a "mine" walk — it resolves to its stored (rank, name) and every
	// mine row sorts after it, so the walk returns the whole mine side
	// (never an error, never the builtin itself).
	var builtinID int64
	for _, m := range ref {
		if m.Origin == "builtin" {
			builtinID = m.ID
		}
	}
	page, err = s.ListMetricsPage("", "mine", builtinID, 100)
	if err != nil {
		t.Fatalf("ListMetricsPage(mine, builtin cursor): %v", err)
	}
	if !sameIDs(metricIDs(page.Rows), metricIDs(originFilterMetricRef(ref, "mine"))) {
		t.Errorf("mine walk from a builtin cursor = %v, want the whole mine side", metricIDs(page.Rows))
	}

	// A cursor on the FIRST mine row continues after it (the mid-list
	// cursor, mine side): only the row that follows survives.
	mine := originFilterMetricRef(ref, "mine")
	page, err = s.ListMetricsPage("", "mine", mine[0].ID, 100)
	if err != nil {
		t.Fatalf("ListMetricsPage(mine, mid cursor): %v", err)
	}
	if !sameIDs(metricIDs(page.Rows), metricIDs(mine[1:])) {
		t.Errorf("mine walk after %d = %v, want %v", mine[0].ID, metricIDs(page.Rows), metricIDs(mine[1:]))
	}
}
