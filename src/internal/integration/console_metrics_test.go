package integration_test

// M5 §2.1–2.2 acceptance composition (added file — existing fixtures stay
// untouched): the metric engine + read-only SQL console over one real
// store lifecycle: the baseline schema (metrics/saved_queries/query_history
// + plugins tables) → synthetic library seed → builtin metric previews →
// console session safety (multi-statement rejection, write rejection,
// timeout). No demo bytes: the corpus is internal/metrics'
// committed SQL seed.

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

func openSeededLibrary(t *testing.T) *store.Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "m5.db")
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
		t.Fatalf("seed conn: %v", err)
	}
	if err := metrics.LoadSeed(db); err != nil {
		t.Fatalf("metrics.LoadSeed: %v", err)
	}
	_ = db.Close()
	return st
}

// TestBuiltinMetricsPreview: the one-hundred-four schema-seeded builtins
// (trade_rate + the dogfooding set + the inferred set + the plan §7 M3
// combat-damage addendum + the owner Option A count addendum + the
// subject-axis addendum — plan §8 (M8/M4 rows), 2026-11-17 re-pin + the
// identity addendum — plan §8 (M1 identity row), 2026-11-17 re-pin + the
// partition addendum — plan §8 (M5/M6 rows), 2026-11-17 re-pin + the
// weapon addendum — plan §8 (M7 row) behind the M7 gate, 2026-11-17
// re-pin) each compile and run on a fresh library — the
// DoD "demonstrably expressible" loop end to end.
func TestBuiltinMetricsPreview(t *testing.T) {
	st := openSeededLibrary(t)
	// group_by is gone from the DDL (stored-metrics W1) and the groupBy
	// parameter with the W2 grammar wave: the row is locked by scope and
	// every preview is subject-addressed by the engine (one row per
	// player the statement produced).
	res, err := st.RunReadOnly(
		`SELECT name, expr, scope, partition, denominator, subject, id, version FROM metrics WHERE origin = 'builtin' ORDER BY name`,
		nil, 200, 5000,
	)
	if err != nil {
		t.Fatalf("list builtins: %v", err)
	}
	if len(res.Rows) != 142 {
		t.Fatalf("builtins = %d, want 142 (109 sugar builtins + 33 raw-SQL fold seeds F2; trade_rate + the dogfooding set + the 42-row inferred set + the w13d kda row + the plan §7 M3 dmg_no_kill/kill_conversion pair + the owner Option A count addendum + the subject-axis addendum + the identity addendum + the side/map partition addendum + the M7 weapon addendum + the grammar addendum + the M7 weapon-damage flip + the view-aggregate relocation addendum — the 2026-11-17/18 re-pins, plan §8 (M8/M4 rows), §8 (M1 identity row), §8 (M5/M6 rows), §8 (M7 row), §8 (M8 rows) and the ME8 exception audit)", len(res.Rows))
	}
	scopes := map[string]int{}
	// A seed over an EMPTY primary or an empty corpus table honestly
	// returns no rows at all: the clutchless corpus (the seven clutch
	// seeds) and the corpus's two unwritten analysis tables (the five
	// side_class seeds) produce no subject groups — a subject-grouped
	// statement over an empty table never fabricates a 0 row. Every
	// other seed has subjects to address.
	emptyOK := map[string]bool{
		"clutches": true, "clutch_win_rate": true, "clutch_avg_size": true,
		"clutch_avg_hp": true, "clutch_avg_equip": true,
		"career_clutches": true, "career_clutch_win_rate": true,
	}
	for _, r := range res.Rows {
		name, expr, scope, subject := r[0].(string), r[1].(string), r[2].(string), r[5].(string)
		id, version := r[6].(int64), r[7].(int64)
		scopes[scope]++
		t.Run(name, func(t *testing.T) {
			if scope != "match" && scope != "profile" {
				t.Fatalf("builtin scope = %q, want match|profile", scope)
			}
			if subject != "player" && subject != "match" && subject != "team" {
				t.Fatalf("builtin subject = %q, want player|match|team", subject)
			}
			// Builtins are raw SQL (ruling 22). They run through the raw
			// path: the save gate, then one RunRaw per scope the statement's
			// binds select, then the stored rows.
			if !metrics.IsRawSQL(expr) {
				t.Fatalf("builtin is not raw SQL: %q", expr)
			}
			g, perr, err := metrics.CheckRawSave(st, expr)
			if perr != nil || err != nil {
				t.Fatalf("save gate: %v %v", perr, err)
			}
			scopesToRun, err := metrics.RawScopes(st, g.Binds)
			if err != nil {
				t.Fatalf("scopes: %v", err)
			}
			for _, sc := range scopesToRun {
				if err := metrics.RunRaw(t.Context(), st, id, int(version), 0, expr, sc); err != nil {
					t.Fatalf("run (scope %+v): %v", sc, err)
				}
			}
			res, err := st.RunReadOnly(`SELECT COUNT(*) FROM metric_values WHERE metric_id = ?`, []any{id}, 1, 5000)
			if err != nil {
				t.Fatalf("count stored rows: %v", err)
			}
			if n := res.Rows[0][0].(int64); n == 0 && !emptyOK[name] {
				t.Fatalf("raw run stored no rows")
			}
		})
	}
	// The scope split is part of the seed contract: 76 match / 33 (+ 33 F2 match)
	// profile (w13d's kda row, the plan §7 M3 combat pair, the Option A
	// count addendum's 16 raw-count rows, the subject-axis
	// addendum's 3 economy rows, the identity addendum's 5 M1 rows,
	// the grammar addendum's 2 M8 rows and the view-aggregate
	// relocation addendum's 2 force-count rows are match scope; the
	// partition addendum's 10 side/map rows and the
	// M7 weapon addendum's 3 rows are profile — the 2026-11-17/18
	// re-pins, plan §8 (M8/M4 rows), §8 (M1 identity row), §8 (M5/M6
	// rows), §8 (M7 row), §8 (M8 rows) and the ME8 exception audit).
	// + 33 raw fold seeds (F2), all match scope.
	if scopes["match"] != 109 || scopes["profile"] != 33 {
		t.Errorf("scope split = %d match / %d profile, want 109 / 33", scopes["match"], scopes["profile"])
	}
}

// TestConsoleSafety composes the console session against the same
// library: reads work, injection shapes die before execution, data stays
// intact, history records every run, and the timeout interrupts.
func TestConsoleSafety(t *testing.T) {
	st := openSeededLibrary(t)
	s := query.New(st)

	// Read path.
	res := s.Run(`SELECT COUNT(*) FROM events`, 0, 0)
	if res.Err != "" || res.RowCount != 1 || res.Rows[0][0].(int64) != 1944 {
		t.Fatalf("read = %+v err %q, want scalar 1944", res, res.Err)
	}

	// Injection shape: second statement must be rejected BEFORE execution.
	res = s.Run(`SELECT 1; DROP TABLE matches`, 0, 0)
	if !strings.Contains(res.Err, "single statement") {
		t.Fatalf("multi-statement err = %q", res.Err)
	}
	if n := s.Run(`SELECT COUNT(*) FROM matches`, 0, 0); n.Err != "" || n.Rows[0][0].(int64) != 3 {
		t.Fatalf("matches table after injection attempt: %+v", n)
	}

	// Write shapes: rejected + tables intact.
	for _, q := range []string{
		"DELETE FROM events",
		"DROP TABLE rounds",
		"INSERT INTO saved_queries (name, sql, created_at) VALUES ('pwn','x',CURRENT_TIMESTAMP)",
	} {
		if r := s.Run(q, 0, 0); r.Err == "" {
			t.Errorf("write accepted: %q", q)
		}
	}
	if n := s.Run(`SELECT COUNT(*) FROM events`, 0, 0); n.Rows[0][0].(int64) != 1944 {
		t.Errorf("events count changed: %v", n.Rows[0][0])
	}
	// saved_queries untouched by the rejected INSERT (write handle owns it).
	if r := s.Run(`SELECT COUNT(*) FROM saved_queries`, 0, 0); r.Err != "" || r.Rows[0][0].(int64) != 0 {
		t.Fatalf("saved_queries after rejected INSERT: %+v", r)
	}

	// History: every run above logged — count: initial read, injection,
	// post-injection count, 3 write rejections, events re-count,
	// saved_queries count = 8 entries, 4 of them failed.
	hist, err := st.ListQueryHistory(0)
	if err != nil || len(hist) != 8 {
		t.Fatalf("history = %d (err %v), want 8 entries", len(hist), err)
	}
	failed := 0
	for _, h := range hist {
		if !h.OK {
			failed++
		}
	}
	if failed != 4 {
		t.Errorf("failed history entries = %d, want 4", failed)
	}

	// Timeout interrupts a runaway statement.
	start := time.Now()
	r := s.Run(`WITH RECURSIVE c(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM c) SELECT COUNT(*) FROM c`, 0, 300)
	el := time.Since(start)
	if !strings.Contains(r.Err, "timeout") || el > 1300*time.Millisecond {
		t.Fatalf("bomb: err %q after %s", r.Err, el)
	}

	// Schema browser has notes on known tables.
	tbls, err := s.Schema()
	if err != nil || len(tbls) == 0 {
		t.Fatalf("schema: %v (%d tables)", err, len(tbls))
	}
	found := false
	for _, tb := range tbls {
		if tb.Name == "events" && tb.Note != "" {
			found = true
		}
	}
	if !found {
		t.Error("events table note missing from schema")
	}
}
