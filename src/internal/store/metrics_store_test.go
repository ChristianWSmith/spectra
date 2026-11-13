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
var metricColumnsContract = []string{
	"id", "name", "title", "expr", "group_by", "format", "doc", "origin",
	"plugin_id", "denominator", "created_at",
}

// TestMetricsSchemaFreshOpen: a fresh Open creates the M5 tables and
// seeds the seven builtin metrics; a second Open re-applies the baseline
// as a no-op — the seed INSERT is idempotent, so no builtin rows are
// duplicated — and the metrics column contract plus the builtin set still
// hold.
func TestMetricsSchemaFreshOpen(t *testing.T) {
	s, path := openFileStore(t)
	for _, table := range []string{"metrics", "query_history", "saved_queries"} {
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

	for _, table := range []string{"metrics", "query_history", "saved_queries"} {
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

	// The seven builtins, names + doc present — still exactly seven
	// AFTER the reopen, so the baseline's seed did not duplicate rows
	// (values validated by internal/metrics fixture tests).
	list, err := s2.ListMetrics()
	if err != nil {
		t.Fatalf("ListMetrics: %v", err)
	}
	if len(list) != 7 {
		t.Fatalf("builtin count after reopen = %d, want 7 (no duplicate seed rows)", len(list))
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

// walkMetricPage drains every window from afterID for query, returning
// each window's row count and the concatenated rows in order. Fails on a
// runaway loop (a cursor that never advances would spin).
func walkMetricPage(t *testing.T, s *Store, query string, afterID int64, limit int) (sizes []int, rows []models.MetricRow) {
	t.Helper()
	seen := 0
	for {
		page, err := s.ListMetricsPage(query, afterID, limit)
		if err != nil {
			t.Fatalf("ListMetricsPage(query=%q, after=%d): %v", query, afterID, err)
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

// TestListMetricsPageWindowsTileListOrder: 240 definitions (7
// schema-seeded builtins + 230 user + 3 plugin) must tile into
// 100/100/40 windows that concatenate to ListMetrics' exact order, every
// id exactly once, with each origin group CONTIGUOUS across window
// boundaries — the Builder renders its Builtins/Yours/Plugins headers
// from those runs, so a boundary splitting a group must not reorder rows.
func TestListMetricsPageWindowsTileListOrder(t *testing.T) {
	s := openMem(t)
	for i := range 230 {
		seedUserMetric(t, s, fmt.Sprintf("u%03d_metric", i), "")
	}
	if err := s.ReplacePluginMetrics("p1", []PluginMetricDef{
		{Name: "plug_a", Title: "Plugin A", Expr: "from events: count()", GroupBy: "none"},
		{Name: "plug_b", Title: "Plugin B", Expr: "from events: count()", GroupBy: "none"},
		{Name: "plug_c", Title: "Plugin C", Expr: "from events: count()", GroupBy: "none"},
	}); err != nil {
		t.Fatalf("ReplacePluginMetrics: %v", err)
	}

	ref := metricRowsRef(t, s)
	if len(ref) != 240 {
		t.Fatalf("reference list = %d rows, want 240 (7 builtins + 230 user + 3 plugin)", len(ref))
	}
	sizes, got := walkMetricPage(t, s, "", 0, ListMetricsPageSize)
	if len(sizes) != 3 || sizes[0] != 100 || sizes[1] != 100 || sizes[2] != 40 {
		t.Errorf("window sizes = %v, want [100 100 40]", sizes)
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
// (7 builtins + 93 users) is ONE window with HasNext false (the limit+1
// probe found no row), 101 rows splits 100/1 with HasNext flipping
// correctly, and limit 0 selects the default window size.
func TestListMetricsPageWindowBoundaries(t *testing.T) {
	s := openMem(t)
	for i := range 93 {
		seedUserMetric(t, s, fmt.Sprintf("b%03d", i), "")
	}

	page, err := s.ListMetricsPage("", 0, 0)
	if err != nil {
		t.Fatalf("ListMetricsPage: %v", err)
	}
	if len(page.Rows) != 100 || page.HasNext {
		t.Errorf("100 rows → %d rows, HasNext=%v; want 100, false", len(page.Rows), page.HasNext)
	}

	// The 101st row: the first window now reports a successor.
	seedUserMetric(t, s, "b093", "")
	ref := metricIDs(metricRowsRef(t, s))
	if len(ref) != 101 {
		t.Fatalf("reference = %d rows, want 101", len(ref))
	}
	first, err := s.ListMetricsPage("", 0, ListMetricsPageSize)
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
	second, err := s.ListMetricsPage("", cursor, ListMetricsPageSize)
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
	ref := metricIDs(metricRowsRef(t, s)) // 7 builtins + 250 users

	// Cursor at the 100th row in order → the remaining 157.
	page, err := s.ListMetricsPage("", ref[99], 200)
	if err != nil {
		t.Fatalf("ListMetricsPage(mid): %v", err)
	}
	if len(page.Rows) != 157 || page.HasNext {
		t.Errorf("mid cursor → %d rows, HasNext=%v; want 157, false", len(page.Rows), page.HasNext)
	}
	if !sameIDs(metricIDs(page.Rows), ref[100:]) {
		t.Errorf("mid cursor rows = %v…, want the 157 ids after the cursor", metricIDs(page.Rows)[:3])
	}

	// Cursor at the last row → an empty window, no successor.
	last := ref[len(ref)-1]
	page, err = s.ListMetricsPage("", last, 200)
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
	if _, err := s.ListMetricsPage("", 999999, 200); !errors.Is(err, ErrNotFound) {
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
		{Name: "plug_kd", Title: "Plugin K/D", Expr: "from events: count()", GroupBy: "none"},
	}); err != nil {
		t.Fatalf("ReplacePluginMetrics: %v", err)
	}
	ref := metricRowsRef(t, s)

	// Name substring, ASCII case-insensitive: "adr" and "ADR" hit the
	// same single row (no builtin title/name carries "adr").
	for _, q := range []string{"adr", "ADR"} {
		page, err := s.ListMetricsPage(q, 0, 100)
		if err != nil {
			t.Fatalf("ListMetricsPage(%q): %v", q, err)
		}
		if len(page.Rows) != 1 || page.Rows[0].Name != "adr_per_round" || page.HasNext {
			t.Errorf("query %q → %d rows (HasNext=%v), want exactly adr_per_round", q, len(page.Rows), page.HasNext)
		}
	}

	// Title-only substring: "K/D" appears in no name, but in two titles
	// (user then plugin — the canonical group order still holds).
	page, err := s.ListMetricsPage("K/D", 0, 100)
	if err != nil {
		t.Fatalf("ListMetricsPage(K/D): %v", err)
	}
	if got := metricIDs(page.Rows); len(got) != 2 || page.HasNext {
		t.Fatalf("title query → %d rows (HasNext=%v), want 2", len(got), page.HasNext)
	} else if want := metricIDs(filterMetricRef(ref, "K/D")); !sameIDs(got, want) {
		t.Errorf("title query ids = %v, want %v", got, want)
	}

	// The filtered walk (windows of 1) tiles the filtered reference
	// exactly — the cursor resolves inside the filtered set too.
	sizes, walked := walkMetricPage(t, s, "k/d", 0, 1)
	want := filterMetricRef(ref, "k/d")
	if len(sizes) != len(want) {
		t.Errorf("filtered walk = %d windows for %d matches, want one window per match", len(sizes), len(want))
	}
	if !sameIDs(metricIDs(walked), metricIDs(want)) {
		t.Errorf("filtered walk ids = %v, want %v", metricIDs(walked), metricIDs(want))
	}

	// No match: an empty (non-nil) window, no successor.
	page, err = s.ListMetricsPage("zz_no_such_metric", 0, 100)
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
	page, err = s.ListMetricsPage("", 0, 1000)
	if err != nil {
		t.Fatalf("ListMetricsPage(empty): %v", err)
	}
	if !sameIDs(metricIDs(page.Rows), metricIDs(ref)) {
		t.Errorf("empty-query window = %v…, want the full reference order", metricIDs(page.Rows)[:3])
	}
}
