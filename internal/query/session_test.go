package query_test

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/metrics"
	"github.com/ChristianWSmith/spectra/internal/query"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// seededStore opens a file store with the synthetic corpus (metrics.
// LoadSeed — the shared seed loader, exercised here exactly as the SQL
// console would meet a real library).
func seededStore(t *testing.T) *store.Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "console.db")
	st, err := store.Open(path)
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() {
		_ = st.CloseRO()
		_ = st.Close()
	})
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open seed conn: %v", err)
	}
	if err := metrics.LoadSeed(db); err != nil {
		t.Fatalf("LoadSeed: %v", err)
	}
	_ = db.Close()
	return st
}

func TestSessionRunHappyPath(t *testing.T) {
	st := seededStore(t)
	s := query.New(st)

	res := s.Run(`SELECT kind, COUNT(*) AS n FROM events GROUP BY kind ORDER BY kind`, 0, 0)
	if res.Err != "" {
		t.Fatalf("run error: %s", res.Err)
	}
	if len(res.Columns) != 2 || res.Columns[0] != "kind" {
		t.Errorf("columns = %v", res.Columns)
	}
	if res.RowCount != 3 { // damage | blind | kill
		t.Errorf("rowCount = %d, want 3", res.RowCount)
	}
	if res.MS <= 0 {
		t.Logf("MS = %d (fast host — 0 is legal)", res.MS)
	}
	if res.Truncated {
		t.Errorf("truncated on 3 rows")
	}

	// History recorded the successful run.
	hist, err := st.ListQueryHistory(10)
	if err != nil || len(hist) != 1 {
		t.Fatalf("history = %d (err %v), want 1", len(hist), err)
	}
	if !hist[0].OK || hist[0].Rows != 3 || !strings.Contains(hist[0].SQL, "GROUP BY kind") {
		t.Errorf("history entry = %+v", hist[0])
	}
}

// TestSessionRejectsMultiStatement: `SELECT 1; DROP TABLE matches` must be
// rejected BEFORE execution — the table survives and history logs ok=false.
func TestSessionRejectsMultiStatement(t *testing.T) {
	st := seededStore(t)
	s := query.New(st)

	res := s.Run(`SELECT 1; DROP TABLE matches`, 0, 0)
	if res.Err == "" {
		t.Fatal("multi-statement input accepted, want rejection")
	}
	if !strings.Contains(res.Err, "single statement") {
		t.Errorf("err = %q, want single-statement message", res.Err)
	}
	// Table intact (the DROP never ran).
	if res := mustScalar(t, st, `SELECT COUNT(*) FROM matches`); res != int64(3) {
		t.Fatalf("matches rows = %v after rejected run, want 3", res)
	}
	// Failure recorded.
	hist, _ := st.ListQueryHistory(10)
	if len(hist) != 1 || hist[0].OK {
		t.Fatalf("history = %+v, want one failed entry", hist)
	}
}

// TestSessionRejectsWrites: write verbs fail with an error result (grid
// shows Err), data untouched, history ok=false.
func TestSessionRejectsWrites(t *testing.T) {
	st := seededStore(t)
	s := query.New(st)
	for _, q := range []string{
		"INSERT INTO matches (path, sha256) VALUES ('x','y')",
		"DELETE FROM events",
		"DROP TABLE rounds",
		"UPDATE players SET name = 'pwned'",
		"ATTACH DATABASE 'evil.db' AS evil",
	} {
		res := s.Run(q, 0, 0)
		if res.Err == "" {
			t.Errorf("Run(%q) accepted, want rejection", q)
		}
	}
	if n := mustScalar(t, st, `SELECT COUNT(*) FROM matches`); n != int64(3) {
		t.Errorf("matches rows = %v, want 3", n)
	}
	if n := mustScalar(t, st, `SELECT COUNT(*) FROM events`); n != int64(1944) {
		t.Errorf("events rows = %v, want 1944", n)
	}
	hist, _ := st.ListQueryHistory(0)
	if len(hist) != 5 {
		t.Errorf("history = %d entries, want 5 (all failures)", len(hist))
	}
	for _, h := range hist {
		if h.OK {
			t.Errorf("failure recorded as ok: %+v", h)
		}
	}
}

// TestSessionTimeout: the default-less explicit timeout interrupts the
// recursive-CTE bomb (driver progress handler) within slack.
func TestSessionTimeout(t *testing.T) {
	st := seededStore(t)
	s := query.New(st)
	const timeout = 400
	start := time.Now()
	res := s.Run(
		`WITH RECURSIVE c(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM c) SELECT COUNT(*) FROM c`,
		0, timeout,
	)
	el := time.Since(start)
	if res.Err == "" {
		t.Fatal("CTE bomb finished without error, want timeout")
	}
	if !strings.Contains(res.Err, "timeout") {
		t.Errorf("err = %q, want timeout", res.Err)
	}
	if el > timeout+1000*time.Millisecond {
		t.Errorf("wall %s > timeout %dms + 1s", el, timeout)
	}
	t.Logf("console bomb interrupted after %s (timeout %dms)", el.Round(time.Millisecond), timeout)
}

// TestSessionRowCap: limit parameter + Truncated flag; ≤0 → default 5000.
func TestSessionRowCap(t *testing.T) {
	st := seededStore(t)
	s := query.New(st)

	res := s.Run(`SELECT id, tick FROM events ORDER BY id`, 25, 0)
	if res.Err != "" {
		t.Fatalf("err: %s", res.Err)
	}
	if res.RowCount != 25 || !res.Truncated {
		t.Fatalf("rows=%d truncated=%v, want 25 + truncated", res.RowCount, res.Truncated)
	}
	res = s.Run(`SELECT id FROM events ORDER BY id`, 0, 0) // default 5000 < 1944? no: 1944 < 5000
	if res.Err != "" {
		t.Fatalf("err: %s", res.Err)
	}
	if res.RowCount != 1944 || res.Truncated {
		t.Fatalf("default-cap rows=%d truncated=%v, want 1944 untruncated", res.RowCount, res.Truncated)
	}
}

// TestSessionSchema: notes on known tables/columns, "" fallbacks.
func TestSessionSchema(t *testing.T) {
	st := seededStore(t)
	tables, err := query.New(st).Schema()
	if err != nil {
		t.Fatalf("Schema: %v", err)
	}
	byName := map[string]query.Table{}
	for _, tb := range tables {
		byName[tb.Name] = tb
	}
	matches, ok := byName["matches"]
	if !ok || matches.Note == "" {
		t.Fatalf("matches note = %q, want provenance string", matches.Note)
	}
	events := byName["events"]
	if events.Note == "" {
		t.Error("events note empty")
	}
	var kindNote, pathNote string
	for _, c := range events.Columns {
		if c.Name == "kind" {
			kindNote = c.Note
		}
	}
	for _, c := range matches.Columns {
		if c.Name == "path" {
			pathNote = c.Note
		}
	}
	if kindNote == "" {
		t.Error("events.kind column note empty")
	}
	if pathNote != "" {
		t.Errorf("unnoted column note = %q, want \"\" (contract)", pathNote)
	}
	if byName["metrics"].Note == "" {
		t.Error("metrics table note empty")
	}
}

// TestConsoleTypicalQuery measures console latency on the seed
// (bounded by timeout; target ms-level for typical queries).
func TestConsoleTypicalQuery(t *testing.T) {
	st := seededStore(t)
	s := query.New(st)
	queries := []string{
		"SELECT kind, COUNT(*) FROM events GROUP BY kind",
		"SELECT p.name, SUM(ps.kills) AS k FROM player_stats ps JOIN players p ON p.match_id = ps.match_id AND p.steam_id = ps.steam_id GROUP BY ps.steam_id ORDER BY k DESC",
		"SELECT round, COUNT(*) FROM engagements WHERE kind = 'opening' GROUP BY round ORDER BY round",
	}
	for _, q := range queries {
		start := time.Now()
		res := s.Run(q, 5000, 0)
		el := time.Since(start)
		if res.Err != "" {
			t.Fatalf("query %q: %s", q, res.Err)
		}
		t.Logf("console query rows=%-4d %s :: %s", res.RowCount, el.Round(time.Millisecond), q)
		if el >= time.Second {
			t.Errorf("typical query took %s, want ms-level (< 1s)", el)
		}
	}
}

// TestSavedQueriesAndHistoryServiceFlow exercises the store CRUD the
// QueryService body wraps (kept here so the console package documents the
// full loop: run → history → save).
func TestSavedQueriesAndHistoryServiceFlow(t *testing.T) {
	st := seededStore(t)
	s := query.New(st)

	s.Run(`SELECT 1`, 0, 0)
	s.Run(`SELECT * FROM no_such_table`, 0, 0) // failed → history ok=false
	hist, err := st.ListQueryHistory(0)
	if err != nil || len(hist) != 2 {
		t.Fatalf("history = %d (err %v), want 2", len(hist), err)
	}
	if hist[0].OK || !hist[1].OK {
		t.Errorf("history ok flags = %v,%v want false,true", hist[0].OK, hist[1].OK)
	}

	q, err := st.SaveQuery("kinds", "SELECT kind, COUNT(*) FROM events GROUP BY kind")
	if err != nil {
		t.Fatalf("SaveQuery: %v", err)
	}
	if _, err := st.SaveQuery("kinds", "SELECT 1"); err == nil {
		t.Error("duplicate saved name accepted")
	}
	list, err := st.ListSavedQueries()
	if err != nil || len(list) != 1 || list[0].ID != q.ID {
		t.Fatalf("list = %+v (err %v)", list, err)
	}
	if err := st.ClearHistory(); err != nil {
		t.Fatalf("ClearHistory: %v", err)
	}
	if hist, _ := st.ListQueryHistory(0); len(hist) != 0 {
		t.Fatalf("history after clear = %d", len(hist))
	}
}

// mustScalar runs a scalar SELECT through the read-only session.
func mustScalar(t *testing.T, st *store.Store, q string) any {
	t.Helper()
	res, err := st.RunReadOnly(q, nil, 1, 5000)
	if err != nil {
		t.Fatalf("scalar %q: %v", q, err)
	}
	if len(res.Rows) != 1 || len(res.Rows[0]) != 1 {
		t.Fatalf("scalar %q returned %v", q, res.Rows)
	}
	return res.Rows[0][0]
}
