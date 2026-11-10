package store

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
)

// TestValidateReadOnlySQL is the console statement policy (layer 1):
// tokenizer-aware (a ';' inside a string literal is fine), single
// statement only, read-only leading keyword, no write verbs anywhere,
// PRAGMA limited to the read allowlist. This rejects BEFORE execution.
func TestValidateReadOnlySQL(t *testing.T) {
	ok := []string{
		"SELECT 1",
		"select * from matches",
		"SELECT 1;",                     // trailing terminator
		"SELECT 1; -- trailing comment", // ';' still the last token
		"SELECT ';' AS s",               // semicolon inside a string
		`SELECT "a;b" AS s`,             // semicolon inside a quoted ident
		"SELECT name FROM matches WHERE path LIKE '%;%'",
		"SELECT replace(path, 'a', 'b') FROM matches", // replace() function
		"WITH x AS (SELECT 1) SELECT * FROM x",
		"EXPLAIN SELECT * FROM matches",
		"PRAGMA table_info('matches')",
		"PRAGMA page_count",
		"(SELECT 1) UNION ALL SELECT 2",
		"", // handled below — empty is rejected, listed to keep intent clear
	}
	for _, q := range ok[:len(ok)-1] {
		if err := ValidateReadOnlySQL(q); err != nil {
			t.Errorf("ValidateReadOnlySQL(%q) = %v, want nil", q, err)
		}
	}
	bad := []struct{ q, want string }{
		{"", "empty statement"},
		{"   -- only a comment", "empty statement"},
		{"SELECT 1; DROP TABLE matches", "single statement"},
		{"SELECT 1; SELECT 2", "single statement"},
		{"SELECT 1;;", "single statement"},
		{";SELECT 1", "single statement"},
		{"INSERT INTO matches (path, sha256) VALUES ('x', 'y')", "insert"},
		{"UPDATE matches SET map = 'x'", "update"},
		{"DELETE FROM matches", "delete"},
		{"DROP TABLE matches", "drop"},
		{"CREATE TABLE evil (x)", "create"},
		{"ALTER TABLE matches ADD COLUMN x INT", "alter"},
		{"ATTACH DATABASE '/tmp/evil.db' AS evil", "attach"},
		{"DETACH evil", "detach"},
		{"VACUUM INTO '/tmp/out.db'", "vacuum"},
		{"REINDEX", "reindex"},
		{"ANALYZE", "analyze"},
		{"BEGIN", "begin"},
		{"COMMIT", "commit"},
		{"ROLLBACK", "rollback"},
		{"WITH x AS (SELECT 1) INSERT INTO matches SELECT 1", "insert"},
		{"EXPLAIN INSERT INTO matches VALUES (1)", "insert"},
		{"PRAGMA journal_mode=DELETE", "not allowed"},
		{"PRAGMA query_only=0", "not allowed"},
		{"PRAGMA user_version=9", "not allowed"},
		{"PRAGMA wal_checkpoint", "not allowed"},
		{"SELECT load_extension('x')", "load_extension"},
		{"SELECT writefile('/tmp/x', 'y')", "writefile"},
		{"SELECT 'unterminated", "unterminated"},
		{"DROP--comment\nTABLE matches", "drop"}, // verb after comment
	}
	for _, c := range bad {
		err := ValidateReadOnlySQL(c.q)
		if err == nil {
			t.Errorf("ValidateReadOnlySQL(%q) accepted, want error containing %q", c.q, c.want)
			continue
		}
		if !strings.Contains(err.Error(), c.want) {
			t.Errorf("ValidateReadOnlySQL(%q) = %v, want substring %q", c.q, err, c.want)
		}
	}
}

// openROFileStore is openFileStore plus read-only handle cleanup (the
// side table outlives Close otherwise; matters on Windows temp removal).
func openROFileStore(t *testing.T) *Store {
	t.Helper()
	s, _ := openFileStore(t)
	t.Cleanup(func() { _ = s.CloseRO() })
	return s
}

// seedROData fills a little data through the write handle (test-internal)
// so rejection tests can prove tables stay intact.
func seedROData(t *testing.T, s *Store) (matches, events int) {
	t.Helper()
	for i := 0; i < 5; i++ {
		if _, err := s.db.Exec(
			`INSERT INTO matches (path, sha256, map, status) VALUES (?, ?, 'de_mirage', 'ready')`,
			"/x.dem", "sha-"+string(rune('a'+i)),
		); err != nil {
			t.Fatalf("seed match: %v", err)
		}
	}
	if _, err := s.db.Exec(
		`INSERT INTO events (match_id, seq, tick, kind) VALUES (1, 0, 100, 'kill')`,
	); err != nil {
		t.Fatalf("seed event: %v", err)
	}
	return 5, 1
}

func roCount(t *testing.T, s *Store, table string) int {
	t.Helper()
	res, err := s.RunReadOnly("SELECT COUNT(*) FROM "+table, nil, 1, 5000)
	if err != nil {
		t.Fatalf("count %s: %v", table, err)
	}
	return int(res.Rows[0][0].(int64))
}

// TestRunReadOnlyRejectsWrites: every write verb fails (layer 1) and the
// tables are untouched afterwards.
func TestRunReadOnlyRejectsWrites(t *testing.T) {
	s := openROFileStore(t) // validation runs before the RO handle opens
	matches, events := seedROData(t, s)

	writes := []string{
		"INSERT INTO matches (path, sha256) VALUES ('evil', 'evil')",
		"UPDATE matches SET map = 'pwned'",
		"DELETE FROM matches",
		"DELETE FROM events",
		"DROP TABLE matches",
		"CREATE TABLE pwned (x)",
		"ALTER TABLE matches ADD COLUMN pwned INT",
		"REPLACE INTO matches (id, path, sha256) VALUES (1, 'x', 'y')",
		"ATTACH DATABASE '" + filepath.Join(t.TempDir(), "evil.db") + "' AS evil",
		"VACUUM INTO '" + filepath.Join(t.TempDir(), "vac.db") + "'",
		"WITH x AS (SELECT 1) DELETE FROM events",
		"PRAGMA journal_mode=DELETE",
	}
	for _, q := range writes {
		if _, err := s.RunReadOnly(q, nil, 100, 5000); err == nil {
			t.Errorf("RunReadOnly(%q) succeeded, want rejection", q)
		}
	}
	if n := roCount(t, s, "matches"); n != matches {
		t.Errorf("matches rows = %d after write attempts, want %d", n, matches)
	}
	if n := roCount(t, s, "events"); n != events {
		t.Errorf("events rows = %d after write attempts, want %d", n, events)
	}
}

// TestRunReadOnlyConnectionIsImmutable exercises layer 2 directly: the
// handle's mode=ro + query_only connection refuses writes even when the
// validator is bypassed (mirrors roDSN — the handle itself is otherwise
// unreachable: roDB is unexported and RunReadOnly validates first).
func TestRunReadOnlyConnectionIsImmutable(t *testing.T) {
	s, path := openFileStore(t)
	seedROData(t, s)

	db, err := sql.Open("sqlite", roDSN(path))
	if err != nil {
		t.Fatalf("open ro: %v", err)
	}
	defer func() { _ = db.Close() }()
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		t.Fatalf("ping ro: %v", err)
	}
	var qo int
	if err := db.QueryRow(`PRAGMA query_only`).Scan(&qo); err != nil || qo != 1 {
		t.Fatalf("query_only = %d (err %v), want 1", qo, err)
	}

	attempts := []string{
		"INSERT INTO matches (path, sha256) VALUES ('evil', 'evil')",
		"UPDATE matches SET map = 'pwned'",
		"DELETE FROM matches",
		"DROP TABLE events",
		"CREATE TABLE pwned (x)",
		"CREATE TEMP TABLE tpwned (x)",                                // query_only refuses temp writes
		"VACUUM INTO '" + filepath.Join(t.TempDir(), "vac2.db") + "'", // query_only refuses output writes
		"ATTACH DATABASE '" + filepath.Join(t.TempDir(), "evil2.db") + "' AS e; CREATE TABLE e.t (x)", // chained: script leg 2 fails
	}
	for _, q := range attempts {
		if _, err := db.Exec(q); err == nil {
			t.Errorf("ro connection accepted %q, want SQLITE_READONLY", q)
		}
	}
	// Flipping query_only off does not help: mode=ro is enforced by the VFS.
	if _, err := db.Exec(`PRAGMA query_only=0`); err != nil {
		t.Fatalf("reset query_only: %v", err)
	}
	if _, err := db.Exec("INSERT INTO matches (path, sha256) VALUES ('evil', 'evil')"); err == nil {
		t.Error("ro connection wrote after query_only=0, mode=ro must still refuse")
	}
	// Reads work.
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM matches`).Scan(&n); err != nil || n != 5 {
		t.Fatalf("ro read matches = %d (err %v), want 5", n, err)
	}
}

// TestRunReadOnlyTimeout: the recursive-CTE bomb is interrupted server-side
// (driver progress handler + sqlite3_interrupt on ctx deadline — see the
// file doc of query_store.go) around the timeout, far under the +1 s slack.
func TestRunReadOnlyTimeout(t *testing.T) {
	s := openROFileStore(t)
	const timeout = 500
	start := time.Now()
	_, err := s.RunReadOnly(
		`WITH RECURSIVE c(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM c) SELECT COUNT(*) FROM c`,
		nil, 1, timeout,
	)
	el := time.Since(start)
	if err == nil {
		t.Fatal("CTE bomb completed, want timeout error")
	}
	if !strings.Contains(err.Error(), "timeout") {
		t.Errorf("err = %v, want timeout message", err)
	}
	if el > timeout+1000*time.Millisecond {
		t.Errorf("interrupt took %s, want ≤ %dms + 1s slack", el, timeout)
	}
	t.Logf("recursive-CTE bomb interrupted after %s (timeout %dms)", el.Round(time.Millisecond), timeout)
}

// TestRunReadOnlyRowCap: default cap 5000 semantics (here: explicit
// limits), Truncated only when more rows existed.
func TestRunReadOnlyRowCap(t *testing.T) {
	s := openROFileStore(t)
	seedROData(t, s)
	for i := 0; i < 50; i++ {
		if _, err := s.db.Exec(
			`INSERT INTO events (match_id, seq, tick, kind) VALUES (1, ?, ?, 'damage')`, i+1, 200+i,
		); err != nil {
			t.Fatalf("seed events: %v", err)
		}
	}
	total := roCount(t, s, "events") // 51

	res, err := s.RunReadOnly(`SELECT tick FROM events ORDER BY tick`, nil, 10, 5000)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if len(res.Rows) != 10 || !res.Truncated {
		t.Fatalf("rows = %d truncated = %v, want 10 + truncated", len(res.Rows), res.Truncated)
	}
	res, err = s.RunReadOnly(`SELECT tick FROM events ORDER BY tick`, nil, total, 5000)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if len(res.Rows) != total || res.Truncated {
		t.Fatalf("rows = %d truncated = %v, want all %d untruncated", len(res.Rows), res.Truncated, total)
	}
	// limit ≤0 → DefaultRowLimit (5000): plenty for these rows, no cap hit.
	res, err = s.RunReadOnly(`SELECT tick FROM events`, nil, 0, 5000)
	if err != nil || len(res.Rows) != total || res.Truncated {
		t.Fatalf("default limit run: rows=%d truncated=%v err=%v", len(res.Rows), res.Truncated, err)
	}
}

// TestRunReadOnlyReads: the console happy path — SELECT, strings carrying
// semicolons, PRAGMA from the read allowlist, and multi-row scan values.
func TestRunReadOnlyReads(t *testing.T) {
	s := openROFileStore(t)
	seedROData(t, s)

	res, err := s.RunReadOnly(`SELECT id, map FROM matches ORDER BY id`, nil, 10, 5000)
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	if len(res.Columns) != 2 || res.Columns[0] != "id" || len(res.Rows) != 5 {
		t.Fatalf("columns=%v rows=%d", res.Columns, len(res.Rows))
	}
	if res.MS < 0 {
		t.Errorf("MS = %d", res.MS)
	}
	// Semicolon inside a literal passes validation and returns the value.
	res, err = s.RunReadOnly(`SELECT 'a;b' AS s`, nil, 10, 5000)
	if err != nil {
		t.Fatalf("literal semicolon: %v", err)
	}
	if v := res.Rows[0][0].(string); v != "a;b" {
		t.Errorf("value = %q, want a;b", v)
	}
	// Allowed PRAGMA returns rows.
	res, err = s.RunReadOnly(`PRAGMA table_info('matches')`, nil, 100, 5000)
	if err != nil {
		t.Fatalf("pragma: %v", err)
	}
	if len(res.Rows) < 20 {
		t.Errorf("table_info rows = %d, want the matches columns", len(res.Rows))
	}
}

// TestSchema: every user table with columns (pragma_table_info binding
// works), sqlite internals excluded, metrics present.
func TestSchema(t *testing.T) {
	s, _ := openFileStore(t)
	tables, err := s.Schema()
	if err != nil {
		t.Fatalf("Schema: %v", err)
	}
	byName := map[string][]string{}
	for _, tb := range tables {
		if tb.Name == "sqlite_sequence" || strings.HasPrefix(tb.Name, "sqlite_") {
			t.Errorf("sqlite internal table %q leaked into schema", tb.Name)
		}
		for _, c := range tb.Columns {
			byName[tb.Name] = append(byName[tb.Name], c.Name)
		}
	}
	for _, want := range []string{"matches", "events", "rounds", "metrics", "query_history", "saved_queries", "plugins"} {
		if _, ok := byName[want]; !ok {
			t.Errorf("schema missing table %q", want)
		}
	}
	if cols := byName["matches"]; !contains(cols, "map") || !contains(cols, "enc_messages") {
		t.Errorf("matches columns = %v, want map + enc_messages", cols)
	}
	if cols := byName["events"]; !contains(cols, "pos_x") || !contains(cols, "assisted_flash") {
		t.Errorf("events columns = %v, want pos_x + assisted_flash", cols)
	}
}

// TestQueryHistoryFIFO: append success + failure rows, cap at 100 newest,
// clear.
func TestQueryHistoryFIFO(t *testing.T) {
	s := openMem(t)
	for i := 0; i < 120; i++ {
		if err := s.AppendQueryHistory(modelsQueryHistory(i)); err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
	}
	all, err := s.ListQueryHistory(0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all) != QueryHistoryCap {
		t.Fatalf("history len = %d, want %d", len(all), QueryHistoryCap)
	}
	if all[0].ID != 120 { // newest first
		t.Errorf("newest id = %d, want 120", all[0].ID)
	}
	// Trim keeps the NEWEST cap: oldest recorded id still present = 21.
	if all[len(all)-1].ID != 21 {
		t.Errorf("oldest kept id = %d, want 21", all[len(all)-1].ID)
	}
	if all[0].OK != (119%2 == 0) {
		t.Errorf("ok flag round-trip wrong: %+v", all[0])
	}
	// Page limit.
	page, err := s.ListQueryHistory(10)
	if err != nil || len(page) != 10 {
		t.Fatalf("page len = %d (err %v), want 10", len(page), err)
	}
	if err := s.ClearHistory(); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if all, _ := s.ListQueryHistory(0); len(all) != 0 {
		t.Fatalf("history after clear = %d rows", len(all))
	}
}

// TestSavedQueries: unique names + CRUD.
func TestSavedQueries(t *testing.T) {
	s := openMem(t)
	q, err := s.SaveQuery("openings", "SELECT * FROM engagements WHERE kind = 'opening'")
	if err != nil {
		t.Fatalf("SaveQuery: %v", err)
	}
	if q.ID == 0 || q.Name != "openings" || q.CreatedAt.IsZero() {
		t.Fatalf("saved = %+v", q)
	}
	if _, err := s.SaveQuery("openings", "SELECT 1"); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Errorf("duplicate err = %v, want friendly uniqueness error", err)
	}
	if _, err := s.SaveQuery("second", "SELECT 2"); err != nil {
		t.Fatalf("SaveQuery: %v", err)
	}
	list, err := s.ListSavedQueries()
	if err != nil || len(list) != 2 {
		t.Fatalf("list = %d (err %v), want 2", len(list), err)
	}
	if list[0].Name != "openings" || list[1].Name != "second" { // name ASC
		t.Errorf("order = %q,%q", list[0].Name, list[1].Name)
	}
	if err := s.DeleteQuery(q.ID); err != nil {
		t.Fatalf("DeleteQuery: %v", err)
	}
	if err := s.DeleteQuery(q.ID); err == nil {
		t.Error("second delete succeeded, want ErrNotFound")
	}
	if list, _ := s.ListSavedQueries(); len(list) != 1 {
		t.Fatalf("list after delete = %d", len(list))
	}
}

// modelsQueryHistory builds history rows for the FIFO test.
func modelsQueryHistory(i int) models.QueryHistoryRow {
	return models.QueryHistoryRow{
		SQL:  fmt.Sprintf("SELECT %d", i),
		MS:   int64(i),
		Rows: i,
		OK:   i%2 == 0,
	}
}

func contains(ss []string, want string) bool {
	for _, s := range ss {
		if s == want {
			return true
		}
	}
	return false
}
