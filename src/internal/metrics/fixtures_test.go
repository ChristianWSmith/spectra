package metrics

import (
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/store"
)

// seededStore opens a file-backed store and loads the synthetic corpus
// (golden library fixture): a second short-lived write connection
// next to the store handle — WAL tolerates it. The metrics fixture,
// property and perf suites share it.
func seededStore(t *testing.T) *store.Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "seed.db")
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
	if err := LoadSeed(db); err != nil {
		t.Fatalf("LoadSeed: %v", err)
	}
	_ = db.Close()
	return st
}

// builtinSeed maps the ONE schema-seeded builtin (schema.sql —
// name/expr/scope/denominator/doc are LOCKED to the baseline seed by
// this table) onto its hand-computed seed expectation. interpretation
// records how the seeded expression states the metric (never silently —
// the formula and any proxy/deviation live in the row's doc).
// groupBy is the ENGINE preview input only: the stored group_by column
// is gone (stored-metrics W1 — the seed locks scope instead) and the
// groupBy parameter itself retires with the W2 grammar wave; keeping it
// here preserves the per-player seed-value shape this test proves.
var builtinSeed = []struct {
	name           string
	expr           string
	scope          string
	groupBy        string
	denominator    string
	interpretation string
	rows           int
	wantValues     []float64 // per group, ORDER BY grp ASC (nil → wantAll)
	wantAll        float64
	wantN          int    // expected N per row (0 = don't assert)
	wantLabels     string // expected labels joined ("" = don't assert)
}{
	{
		name:        "trade_rate",
		expr:        "from player_stats, match_trade_opps: ratio(sum(trade_kills), sum(opps))",
		scope:       "match",
		groupBy:     "player",
		denominator: "",
		interpretation: "trade successes / total trade opportunities over the engine-derived LEFT JOIN " +
			"(match_id, steam_id) — a ratio, not a share, so it may exceed 100% (profile TradeRate note)",
		// join_test.go TestJoinedAcceptanceRatio's seed math: ratio =
		// 3i/30i = 0.1 for i ≤ 6; Grace's stored opps = 0 and Heidi's
		// absent row both surface as Value 0 beside N.
		rows: 8, wantValues: []float64{0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0, 0}, wantN: 3,
		wantLabels: "Alice,Bob,Carol,Dave,Eve,Frank,Grace,Heidi",
	},
}

// TestBuiltinSeedMetrics is the acceptance test: the schema-seeded
// builtin must (a) exist with a seeded expr matching this table, (b)
// compile, (c) return the hand-computed seed values with labels and
// sample sizes, and (d) carry formula documentation.
func TestBuiltinSeedMetrics(t *testing.T) {
	st := seededStore(t)

	// (a) Lock the schema-seeded builtin row(s) to this table. The
	// group_by column no longer exists (stored-metrics W1): the lock is
	// scope now, per the schema.sql coordination-contract header.
	res, err := st.RunReadOnly(
		`SELECT name, expr, scope, denominator, doc FROM metrics WHERE origin = 'builtin' ORDER BY name`,
		nil, 100, 5000,
	)
	if err != nil {
		t.Fatalf("read builtins: %v", err)
	}
	got := map[string][4]string{}
	for _, r := range res.Rows {
		got[r[0].(string)] = [4]string{r[1].(string), r[2].(string), r[3].(string), r[4].(string)}
	}
	if len(got) != len(builtinSeed) {
		t.Errorf("builtin count = %d, want %d", len(got), len(builtinSeed))
	}
	for _, f := range builtinSeed {
		row, ok := got[f.name]
		if !ok {
			t.Errorf("builtin %q missing from the schema seed", f.name)
			continue
		}
		if row[0] != f.expr || row[1] != f.scope || row[2] != f.denominator {
			t.Errorf("builtin %q seeded row = expr %q scope %q denom %q, want expr %q scope %q denom %q",
				f.name, row[0], row[1], row[2], f.expr, f.scope, f.denominator)
		}
		if row[3] == "" {
			t.Errorf("builtin %q has empty doc (every metric documents its formula)", f.name)
		}
	}

	// (b)+(c)+(d) compile → run → assert values, sample sizes, labels.
	for _, f := range builtinSeed {
		t.Run(f.name, func(t *testing.T) {
			if perr := Validate(f.expr, f.groupBy); perr != nil {
				t.Fatalf("Validate: %v", perr)
			}
			pv, perr, err := RunPreview(st, Def{Expr: f.expr, GroupBy: f.groupBy, Denominator: f.denominator}, "", 500)
			if perr != nil {
				t.Fatalf("parse: %v", perr)
			}
			if err != nil {
				t.Fatalf("run: %v (sql: %s)", err, pv.SQL)
			}
			if len(pv.Rows) != f.rows {
				t.Fatalf("rows = %d, want %d (%+v)", len(pv.Rows), f.rows, pv.Rows)
			}
			for i, r := range pv.Rows {
				want := f.wantAll
				if f.wantValues != nil {
					want = f.wantValues[i]
				}
				if r.Value != want {
					t.Errorf("row %d value = %v, want %v", i, r.Value, want)
				}
				if f.wantN != 0 && r.N != f.wantN {
					t.Errorf("row %d N = %d, want %d", i, r.N, f.wantN)
				}
			}
			if f.wantLabels != "" {
				var labels []string
				for _, r := range pv.Rows {
					labels = append(labels, r.Label)
				}
				joined := joinComma(labels)
				if joined != f.wantLabels {
					t.Errorf("labels = %q, want %q", joined, f.wantLabels)
				}
			}
		})
	}
}

// TestSyntheticCorpusCounts pins the seed row counts the property tests
// and the fixture math rely on (formulas in testdata/seed.sql header).
func TestSyntheticCorpusCounts(t *testing.T) {
	st := seededStore(t)
	for table, want := range map[string]int{
		"matches": 3, "players": 24, "player_stats": 24, "rounds": 72,
		"events": 1944, "player_round_stats": 576, "round_economy": 144,
		"engagements": 216, "utility_events": 216,
		"chat": 12,
		// Join fixtures: 3 matches × 7 rows (opps = 10i for i ≤ 6,
		// Grace stored-zero; Heidi absent — seed.sql header).
		"match_trade_opps": 21,
	} {
		res, err := st.RunReadOnly("SELECT COUNT(*) FROM "+table, nil, 1, 5000)
		if err != nil {
			t.Fatalf("count %s: %v", table, err)
		}
		if n := int(res.Rows[0][0].(int64)); n != want {
			t.Errorf("%s rows = %d, want %d", table, n, want)
		}
	}
}

// TestScopePreview proves scope="match:<id>" binding on a single-match
// source (648 events/match) and the denominator scoping.
func TestScopePreview(t *testing.T) {
	st := seededStore(t)
	pv, perr, err := RunPreview(st, Def{Expr: "from events: count()"}, "match:2", 10)
	if perr != nil || err != nil {
		t.Fatalf("preview: %v %v", perr, err)
	}
	if len(pv.Rows) != 1 || pv.Rows[0].Value != 648 {
		t.Fatalf("scoped count = %+v, want single row 648", pv.Rows)
	}
	if _, perr, _ := RunPreview(st, Def{Expr: "from events: count()"}, "match:99", 10); perr != nil {
		t.Fatalf("compile: %v", perr)
	}
	// Unknown-but-well-formed match → count 0 (scalar aggregates keep one
	// row with N=0 so the UI gets its missing-data indicator).
	pv, _, err = RunPreview(st, Def{Expr: "from events: count(where kind='kill')"}, "match:99", 10)
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if len(pv.Rows) != 1 || pv.Rows[0].Value != 0 || pv.Rows[0].N != 0 {
		t.Fatalf("empty-scope preview = %+v, want single row 0/0", pv.Rows)
	}
}

// TestPercentilePreview covers the Go-side percentile path (no group),
// including median sugar, filters, multi-aggregation lists where the
// percentile leads, and denominator division.
func TestPercentilePreview(t *testing.T) {
	st := seededStore(t)
	cases := []struct {
		expr  string
		want  float64
		wantN int
	}{
		// 1944 event dmg values: 144×0 (blind), 144 each of 10..100
		// (damage), 360×100 (kills). p95 lands in the 100 block; median
		// at position 971.5 → both neighbours 60.
		{"from events: percentile(0.95, dmg)", 100, 1944},
		{"from events: median(dmg)", 60, 1944},
		{"from events: percentile(where kind='damage', 0.5, dmg)", 55, 1440},
		{"from events: percentile(0.5, dmg), avg(dmg), count()", 60, 1944},
	}
	for _, c := range cases {
		pv, perr, err := RunPreview(st, Def{Expr: c.expr}, "", 100)
		if perr != nil || err != nil {
			t.Fatalf("preview %q: %v %v", c.expr, perr, err)
		}
		if len(pv.Rows) != 1 {
			t.Fatalf("preview %q rows = %d, want 1", c.expr, len(pv.Rows))
		}
		if pv.Rows[0].Value != c.want {
			t.Errorf("preview %q value = %v, want %v", c.expr, pv.Rows[0].Value, c.want)
		}
		if pv.Rows[0].N != c.wantN {
			t.Errorf("preview %q N = %d, want %d", c.expr, pv.Rows[0].N, c.wantN)
		}
	}
	// Percentile + denominator: median(dmg)/count(rounds) = 60/72.
	pv, perr, err := RunPreview(st, Def{Expr: "from events: median(dmg)", Denominator: "rounds"}, "", 100)
	if perr != nil || err != nil {
		t.Fatalf("preview with denom: %v %v", perr, err)
	}
	if want := 60.0 / 72.0; pv.Rows[0].Value != want {
		t.Errorf("denominated median = %v, want %v", pv.Rows[0].Value, want)
	}
}

// TestRowCapAndTruncation pins preview caps (preview has a row
// cap; Truncated reports hitting it).
func TestRowCapAndTruncation(t *testing.T) {
	st := seededStore(t)
	pv, perr, err := RunPreview(st, Def{Expr: "from events: count()", GroupBy: "player"}, "", 3)
	if perr != nil || err != nil {
		t.Fatalf("preview: %v %v", perr, err)
	}
	if len(pv.Rows) != 3 || !pv.Truncated {
		t.Fatalf("rows = %d truncated = %v, want 3 rows capped", len(pv.Rows), pv.Truncated)
	}
	pv, _, err = RunPreview(st, Def{Expr: "from events: count()", GroupBy: "player"}, "", 500)
	if err != nil || pv.Truncated {
		t.Fatalf("uncapped preview truncated = %v (err %v)", pv.Truncated, err)
	}
}

// joinComma renders label expectations readably.
func joinComma(ss []string) string {
	out := ""
	for i, s := range ss {
		if i > 0 {
			out += ","
		}
		out += s
	}
	return out
}
