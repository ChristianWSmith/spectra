package metrics

import (
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/store"
)

// seededStore opens a file-backed store and loads the synthetic corpus
// (plan §5 golden library fixture): a second short-lived write connection
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

// prdFixtures maps each PRD §5.16 example query (plan §5: "treat them as
// acceptance fixtures") onto its builtin metric row (005_metrics.sql —
// expr/groupBy/denominator are LOCKED to the migration by this table) plus
// the hand-computed seed expectation. interpretation records how v1
// expresses examples the frozen grammar cannot state literally (DoD:
// "demonstrably expressible" — never silently).
var prdFixtures = []struct {
	prdExample     string
	name           string
	expr           string
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
		prdExample:  "How many deaths did a player suffer without being traded?",
		name:        "untraded_deaths",
		expr:        "from player_round_stats: count(where deaths=1 and traded=0)",
		groupBy:     "player",
		denominator: "rounds",
		interpretation: "count(player_round_stats rows deaths=1 traded=0) / count(rounds): per-round rate " +
			"(×10 for the per-10-rounds display form — v1 has no scale factor, documented deviation)",
		rows: 8, wantAll: 0.125, wantN: 72,
		wantLabels: "Alice,Bob,Carol,Dave,Eve,Frank,Grace,Heidi",
	},
	{
		prdExample:     "How often did a player successfully trade within a configurable time window?",
		name:           "successful_trades",
		expr:           "from player_stats: sum(trade_kills)",
		groupBy:        "player",
		interpretation: "sum(player_stats.trade_kills) per player; the window is the configured trade window (M1/M3 rule)",
		rows:           8,
		wantValues:     []float64{3, 6, 9, 12, 15, 18, 21, 24},
		wantN:          3,
		wantLabels:     "Alice,Bob,Carol,Dave,Eve,Frank,Grace,Heidi",
	},
	{
		prdExample: "How many kills followed a teammate's flash?",
		name:       "flash_assisted_kills",
		expr:       "from events: count(where kind='kill' and assisted_flash)",
		groupBy:    "player",
		interpretation: "proxy: kill rows flagged assisted_flash (flash assist landed on the victim); " +
			"the specific teammate throw is not linked per kill (cross-event join → v2)",
		rows: 8,
		// P1, P4 (odd rounds) and P5, P8 (even rounds) land the i∈{0,3}
		// flash-assisted kills: 12/round-parity × 3 matches = 36 each.
		wantValues: []float64{36, 0, 0, 36, 36, 0, 0, 36},
	},
	{
		prdExample:  "How much utility value was spent per round?",
		name:        "utility_value_per_round",
		expr:        "from round_economy: sum(equip_value)",
		denominator: "rounds",
		interpretation: "sum(round_economy.equip_value)/count(rounds) = average both-sides buy value per round " +
			"(equip_value includes utility; itemized utility-only spend is not extracted — proxy)",
		rows: 1, wantAll: 4500, wantN: 144,
	},
	{
		prdExample: "How often did a team convert a man advantage?",
		name:       "round_win_rate",
		expr:       "from rounds: ratio(count(where winner='ct'), count())",
		interpretation: "man-advantage tagging needs per-tick alive counts (not stored in v1); " +
			"closest expressible definition = CT round win share",
		rows: 1, wantAll: 0.5, wantN: 72,
	},
	{
		prdExample: "How frequently did a player die while isolated from teammates?",
		name:       "isolated_deaths",
		expr:       "from player_round_stats: ratio(count(where deaths=1 and traded=0), count(where deaths=1))",
		groupBy:    "player",
		interpretation: "spatial isolation lives in position sidecars; v1 SQL proxy = share of a player's " +
			"deaths that went untraded",
		rows: 8, wantAll: 0.5, wantN: 72,
		wantLabels: "Alice,Bob,Carol,Dave,Eve,Frank,Grace,Heidi",
	},
	{
		prdExample: "What percentage of opening kills resulted in round wins?",
		name:       "opening_kill_round_win_pct",
		expr:       "from engagements: ratio(count(where kind='opening' and won_by='ct'), count(where kind='opening'))",
		interpretation: "rounds.first_kill_steam carries no side, so opener→round-winner is not a single-source " +
			"join in v1; proxy = share of opening engagements won by CT",
		rows: 1, wantAll: 0.5, wantN: 216,
	},
}

// TestPRDFixtureMetrics is the plan §5 acceptance test: every PRD §5.16
// example must (a) exist as a builtin whose migration expr matches this
// table, (b) compile, (c) return the hand-computed seed values with labels
// and sample sizes, and (d) carry formula documentation.
func TestPRDFixtureMetrics(t *testing.T) {
	st := seededStore(t)

	// (a) Lock the migration's builtin rows to this table.
	res, err := st.RunReadOnly(
		`SELECT name, expr, group_by, denominator, doc FROM metrics WHERE origin = 'builtin' ORDER BY name`,
		nil, 100, 5000,
	)
	if err != nil {
		t.Fatalf("read builtins: %v", err)
	}
	got := map[string][4]string{}
	for _, r := range res.Rows {
		got[r[0].(string)] = [4]string{r[1].(string), r[2].(string), r[3].(string), r[4].(string)}
	}
	if len(got) != len(prdFixtures) {
		t.Errorf("builtin count = %d, want %d", len(got), len(prdFixtures))
	}
	for _, f := range prdFixtures {
		row, ok := got[f.name]
		if !ok {
			t.Errorf("builtin %q missing from migration", f.name)
			continue
		}
		if row[0] != f.expr || row[1] != f.groupBy || row[2] != f.denominator {
			t.Errorf("builtin %q migration row = expr %q group %q denom %q, want expr %q group %q denom %q",
				f.name, row[0], row[1], row[2], f.expr, f.groupBy, f.denominator)
		}
		if row[3] == "" {
			t.Errorf("builtin %q has empty doc (PRD §5.16 formula documentation)", f.name)
		}
	}

	// (b)+(c)+(d) compile → run → assert values, sample sizes, labels.
	for _, f := range prdFixtures {
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
		"engagements": 216, "utility_events": 216, "voice_chunks": 36,
		"chat": 12,
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

// TestRowCapAndTruncation pins preview caps (plan §2.2: preview has a row
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
