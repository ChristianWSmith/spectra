package metrics

import (
	"database/sql"
	"path/filepath"
	"strings"
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

// builtinSeed maps the SIXTEEN schema-seeded builtins (schema.sql —
// name/expr/scope/format/short_name/denominator are LOCKED to the
// baseline seed by this table) onto their hand-computed seed
// expectations. interpretation records how the seeded expression states
// the metric (never silently — the formula and any proxy/deviation
// live in the row's doc). There is no groupBy input: since W2 every
// statement is subject-grouped by the engine, which is exactly the
// per-player shape this test proves.
//
// The expectations are hand-computed over the committed corpus
// (testdata/seed.sql — 3 identical matches × 8 players × 24 rounds;
// formulas in its header): player_stats carries kills = 2i, deaths = i,
// headshots = i, total_damage = 100i, adr = 50+5i, rounds_played = 24,
// trade_kills = i per match for player i (1..8), entry_kills /
// utility_damage / enemies_flashed are absent → 0, and every player has
// 72 player_round_stats rows with a 0.5 KAST mean (36 of 72). The
// corpus has NO clutches and no player_round_stats surprises, which is
// what makes the N values (COUNT(*) behind each aggregate) exact.
var builtinSeed = []struct {
	name           string
	expr           string
	scope          string
	format         string
	shortName      string
	denominator    string
	interpretation string
	rows           int
	wantValues     []float64 // per subject, ORDER BY grp ASC (nil → wantAll)
	wantAll        float64
	wantN          int    // expected N per row (0 = don't assert)
	wantLabels     string // expected labels joined ("" = don't assert)
}{
	{
		name:        "trade_rate",
		expr:        "from player_stats, match_trade_opps: ratio(sum(trade_kills), sum(opps))",
		scope:       "match",
		format:      "percent",
		shortName:   "",
		denominator: "",
		interpretation: "trade successes / total trade opportunities over the engine-derived LEFT JOIN " +
			"(match_id, steam_id) — a ratio, not a share, so it may exceed 100% (profile TradeRate note)",
		// join_test.go TestJoinedAcceptanceRatio's seed math: ratio =
		// 3i/30i = 0.1 for i ≤ 6; Grace's stored opps = 0 and Heidi's
		// absent row both surface as Value 0 beside N.
		rows: 8, wantValues: []float64{0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0, 0}, wantN: 3,
		wantLabels: eightLabels,
	},
	{
		// D1: sum(total_damage)/sum(rounds_played) = 300i/72 per player
		// across the three identical matches — NOT the corpus's
		// hand-written adr column (an independent gradient for the
		// avg(adr)/stddev fixtures; see scoreboard_equivalence_test.go).
		name: "adr", expr: "from player_stats: ratio(sum(total_damage), sum(rounds_played))",
		scope: "match", format: "float1", shortName: "ADR", denominator: "",
		interpretation: "damage per round re-computed from raw inputs (extract's adr formula)",
		rows:           8,
		wantValues:     []float64{300.0 / 72, 600.0 / 72, 900.0 / 72, 1200.0 / 72, 1500.0 / 72, 1800.0 / 72, 2100.0 / 72, 2400.0 / 72},
		wantN:          3, wantLabels: eightLabels,
	},
	{
		// D7: entry_kills is absent from the corpus's INSERTs → 0 for
		// everyone; the denominator (72 rounds) is non-NULL, so the
		// ratio is a plain 0, not NULL-beside-N.
		name: "entry_rate", expr: "from player_stats: ratio(sum(entry_kills), sum(rounds_played))",
		scope: "match", format: "percent", shortName: "Entry%", denominator: "",
		interpretation: "first-bloods per round played (0 — the corpus records no entry kills)",
		rows:           8, wantAll: 0, wantN: 3, wantLabels: eightLabels,
	},
	{
		// D4: sum(headshots)/sum(kills) = 3i/6i = 0.5 for every player.
		name: "hs_pct", expr: "from player_stats: ratio(sum(headshots), sum(kills))",
		scope: "match", format: "percent", shortName: "HS%", denominator: "",
		interpretation: "headshot share of kills (corpus: headshots = kills/2 → 0.5)",
		rows:           8, wantAll: 0.5, wantN: 3, wantLabels: eightLabels,
	},
	{
		// D6: AVG over the player's 72 player_round_stats rows — 36
		// KAST rounds each → 0.5, N = 72 (the source rows, not matches).
		name: "kast", expr: "from player_round_stats: avg(kast)",
		scope: "match", format: "percent", shortName: "KAST%", denominator: "",
		interpretation: "per-round KAST flag mean (36/72 per player)",
		rows:           8, wantAll: 0.5, wantN: 72, wantLabels: eightLabels,
	},
	{
		// D5: sum(kills)/sum(deaths) = 6i/3i = 2 for every player (no
		// zero-death subject here — Q1's NULLIF edge is the doc note).
		name: "kd", expr: "from player_stats: ratio(sum(kills), sum(deaths))",
		scope: "match", format: "float2", shortName: "K/D", denominator: "",
		interpretation: "kills per death (corpus: kills = 2×deaths → 2)",
		rows:           8, wantAll: 2, wantN: 3, wantLabels: eightLabels,
	},
	{
		// D8: sum(trade_kills)/sum(deaths) = 3i/3i = 1 (100%) — a ratio
		// over OWN deaths, unlike trade_rate's opportunities denominator.
		name: "trade_rate_deaths", expr: "from player_stats: ratio(sum(trade_kills), sum(deaths))",
		scope: "match", format: "percent", shortName: "Trade%", denominator: "",
		interpretation: "trades as a share of the player's own deaths (corpus: equal → 1)",
		rows:           8, wantAll: 1, wantN: 3, wantLabels: eightLabels,
	},
	{
		// D2: AVG over the three identical per-match adr rows → the
		// corpus's adr column itself (50+5i).
		name: "career_adr", expr: "from player_stats: avg(adr)",
		scope: "profile", format: "float1", shortName: "ADR", denominator: "",
		interpretation: "mean of per-match ADR (owner ruling Q2: mean-of-ratios, never pooled)",
		rows:           8,
		wantValues:     []float64{55, 60, 65, 70, 75, 80, 85, 90},
		wantN:          3, wantLabels: eightLabels,
	},
	{
		// D3: population σ over three IDENTICAL values → exactly 0
		// (the sqrt(max(…,0)) idiom clamps float noise).
		name: "career_adr_sigma", expr: "from player_stats: stddev(adr)",
		scope: "profile", format: "float1", shortName: "ADR σ", denominator: "",
		interpretation: "population stddev of per-match ADR (constant series → 0)",
		rows:           8, wantAll: 0, wantN: 3, wantLabels: eightLabels,
	},
	{
		// D11: enemies_flashed absent from the corpus's INSERTs → 0.
		name: "career_avg_enemies_flashed", expr: "from player_stats: avg(enemies_flashed)",
		scope: "profile", format: "float1", shortName: "Avg enemies flashed", denominator: "",
		interpretation: "mean enemies flashed per match (0 — the corpus records none)",
		rows:           8, wantAll: 0, wantN: 3, wantLabels: eightLabels,
	},
	{
		// D12: utility_damage absent from the corpus's INSERTs → 0.
		name: "career_avg_util_damage", expr: "from player_stats: avg(utility_damage)",
		scope: "profile", format: "float1", shortName: "Avg util damage", denominator: "",
		interpretation: "mean utility damage per match (0 — the corpus records none)",
		rows:           8, wantAll: 0, wantN: 3, wantLabels: eightLabels,
	},
	{
		// D10: the corpus records NO clutches (see TestSyntheticCorpus-
		// Counts), so a subject-grouped statement produces no groups →
		// zero rows. Honest empty, never a fabricated 0 row.
		name: "career_clutch_win_rate", expr: "from clutches: avg(won)",
		scope: "profile", format: "percent", shortName: "Clutch win %", denominator: "",
		interpretation: "share of the player's clutches won (clutchless corpus → no rows)",
		rows:           0,
	},
	{
		// D4p: same pooled shape as hs_pct at profile scope (the corpus
		// is three identical matches, so pooled == per-match).
		name: "career_hs_pct", expr: "from player_stats: ratio(sum(headshots), sum(kills))",
		scope: "profile", format: "percent", shortName: "HS%", denominator: "",
		interpretation: "career pooled headshot share (0.5 — identical to the match seed here)",
		rows:           8, wantAll: 0.5, wantN: 3, wantLabels: eightLabels,
	},
	{
		// D6p: all 72 career rows — same mean as the match seed here
		// (three identical matches), N the career row count.
		name: "career_kast", expr: "from player_round_stats: avg(kast)",
		scope: "profile", format: "percent", shortName: "KAST%", denominator: "",
		interpretation: "career KAST mean over every stored round (0.5 — 36/72)",
		rows:           8, wantAll: 0.5, wantN: 72, wantLabels: eightLabels,
	},
	{
		// D5p: pooled kills/deaths over the whole career — 2, the same
		// shape as kdCareerSQL (sums, never a mean of ratios).
		name: "career_kd", expr: "from player_stats: ratio(sum(kills), sum(deaths))",
		scope: "profile", format: "float2", shortName: "K/D", denominator: "",
		interpretation: "career pooled kills per death (6i/3i = 2)",
		rows:           8, wantAll: 2, wantN: 3, wantLabels: eightLabels,
	},
	{
		// D9: byte-identical expr to trade_rate at PROFILE scope — the
		// cross-scope ref ban forbids referencing the match seed, so the
		// join recomputes from the sources; same numbers here.
		name: "career_trade_rate", expr: "from player_stats, match_trade_opps: ratio(sum(trade_kills), sum(opps))",
		scope: "profile", format: "percent", shortName: "Trade rate", denominator: "",
		interpretation: "career trade opportunities ratio (recomputes the join — cross-scope ref ban)",
		rows:           8, wantValues: []float64{0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0, 0}, wantN: 3,
		wantLabels: eightLabels,
	},
}

// eightLabels is the corpus roster in subject (steam_id) ASC order —
// every grouped preview's label expectation.
const eightLabels = "Alice,Bob,Carol,Dave,Eve,Frank,Grace,Heidi"

// TestBuiltinSeedMetrics is the acceptance test: the schema-seeded
// builtins must (a) exist with seeded expr + subject-addressed doc
// matching this table, (b) compile, (c) return the hand-computed seed
// values with labels and sample sizes, and (d) carry formula
// documentation.
func TestBuiltinSeedMetrics(t *testing.T) {
	st := seededStore(t)

	// (a) Lock the schema-seeded builtin rows to this table. The
	// group_by column no longer exists (stored-metrics W1) and the
	// groupBy parameter retired with W2: the lock is scope + format +
	// short_name + the subject-addressed doc, per the schema.sql
	// coordination-contract header. The doc reword moves WITH this lock
	// (schema.sql's seed doc is prose-only — no DDL structure change):
	// the retired "grouped by player" phrasing must be gone and the
	// subject-addressed one present — "addressed per player" for every
	// seed, with the join wording ("over the joined sources") required
	// of exactly the multi-source exprs (the criterion that partitions
	// the two phrasings).
	res, err := st.RunReadOnly(
		`SELECT name, expr, scope, denominator, doc, format, short_name FROM metrics WHERE origin = 'builtin' ORDER BY name`,
		nil, 100, 5000,
	)
	if err != nil {
		t.Fatalf("read builtins: %v", err)
	}
	type seedRow struct{ expr, scope, denom, doc, format, shortName string }
	got := map[string]seedRow{}
	for _, r := range res.Rows {
		got[r[0].(string)] = seedRow{
			expr: r[1].(string), scope: r[2].(string), denom: r[3].(string),
			doc: r[4].(string), format: r[5].(string), shortName: r[6].(string),
		}
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
		if row.expr != f.expr || row.scope != f.scope || row.denom != f.denominator {
			t.Errorf("builtin %q seeded row = expr %q scope %q denom %q, want expr %q scope %q denom %q",
				f.name, row.expr, row.scope, row.denom, f.expr, f.scope, f.denominator)
		}
		if row.format != f.format {
			t.Errorf("builtin %q format = %q, want %q", f.name, row.format, f.format)
		}
		if row.shortName != f.shortName {
			t.Errorf("builtin %q short_name = %q, want %q", f.name, row.shortName, f.shortName)
		}
		if row.doc == "" {
			t.Errorf("builtin %q has empty doc (every metric documents its formula)", f.name)
		}
		if strings.Contains(row.doc, "grouped by player") {
			t.Errorf("builtin %q doc still carries the retired groupBy phrasing: %s", f.name, row.doc)
		}
		if !strings.Contains(row.doc, "addressed per player") {
			t.Errorf("builtin %q doc missing the subject-addressed phrasing: %s", f.name, row.doc)
		}
		// The join wording is required of exactly the MULTI-SOURCE
		// exprs — the source clause (up to the ":") carries the comma,
		// never a function-argument list.
		srcClause := f.expr
		if i := strings.Index(f.expr, ":"); i >= 0 {
			srcClause = f.expr[:i]
		}
		if strings.Contains(srcClause, ",") && !strings.Contains(row.doc, "over the joined sources") {
			t.Errorf("builtin %q doc missing the joined-source phrasing: %s", f.name, row.doc)
		}
	}

	// (b)+(c)+(d) compile → run → assert values, sample sizes, labels.
	for _, f := range builtinSeed {
		t.Run(f.name, func(t *testing.T) {
			if perr := Validate(f.expr); perr != nil {
				t.Fatalf("Validate: %v", perr)
			}
			pv, perr, err := RunPreview(st, Def{Expr: f.expr, Denominator: f.denominator}, "", 500)
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
// source (648 events/match): every statement is subject-addressed, so
// the scoped run returns one row PER SUBJECT and their counts sum to the
// match total; an unknown-but-well-formed match has no subject rows, so
// the preview has no rows at all (a group the statement did not produce
// has no row).
func TestScopePreview(t *testing.T) {
	st := seededStore(t)
	pv, perr, err := RunPreview(st, Def{Expr: "from events: count()"}, "match:2", 100)
	if perr != nil || err != nil {
		t.Fatalf("preview: %v %v", perr, err)
	}
	if len(pv.Rows) != 8 {
		t.Fatalf("scoped rows = %d, want 8 (one per subject) (%+v)", len(pv.Rows), pv.Rows)
	}
	total := 0
	for _, r := range pv.Rows {
		total += r.N
	}
	if total != 648 {
		t.Errorf("per-subject counts total %d, want 648 (the match's events)", total)
	}
	if _, perr, _ := RunPreview(st, Def{Expr: "from events: count()"}, "match:99", 10); perr != nil {
		t.Fatalf("compile: %v", perr)
	}
	// Unknown-but-well-formed match → no rows (no subject in scope).
	pv, _, err = RunPreview(st, Def{Expr: "from events: count(where kind='kill')"}, "match:99", 10)
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if len(pv.Rows) != 0 {
		t.Fatalf("empty-scope preview = %+v, want no rows", pv.Rows)
	}
}

// subjectStat is one subject's oracle row (subjectStats).
type subjectStat struct {
	n        int
	min, max float64
}

// subjectStats is the independent oracle for the partition pins: per
// subject, the stored row count and value range of that subject's
// events — plain SQL over the seed, no engine code involved. where is an
// optional filter ("" = every event).
func subjectStats(t *testing.T, st *store.Store, where string) map[string]subjectStat {
	t.Helper()
	q := "SELECT attacker, COUNT(*), MIN(dmg), MAX(dmg) FROM events"
	if where != "" {
		q += " WHERE " + where
	}
	q += " GROUP BY attacker"
	res, err := st.RunReadOnly(q, nil, 100, 5000)
	if err != nil {
		t.Fatalf("oracle query: %v", err)
	}
	out := map[string]subjectStat{}
	for _, r := range res.Rows {
		out[r[0].(string)] = subjectStat{
			n:   int(r[1].(int64)),
			min: toFloat(r[2]),
			max: toFloat(r[3]),
		}
	}
	return out
}

// TestPercentilePreview covers the Go-side percentile path — now
// PARTITIONED BY SUBJECT: one row per subject, each value the p-quantile
// of THAT subject's rows (N and the value range are pinned against the
// independent oracle above, so a partition that collapsed into a
// library-wide quantile fails here). Hand-computable expectations live
// in metrics_test.go's TestPercentilePartitionsBySubject; the
// denominator case is exact because percentile(1.0, ·) is the subject's
// max (100 — every player lands a kill) over the subject's career
// rounds (72 = 3 matches × 24 player_round_stats rows).
func TestPercentilePreview(t *testing.T) {
	st := seededStore(t)
	cases := []struct {
		name, expr, filter string
	}{
		{"p95 per subject", "from events: percentile(0.95, dmg)", ""},
		{"median per subject", "from events: median(dmg)", ""},
		{"filtered median per subject", "from events: percentile(where kind='damage', 0.5, dmg)", "kind = 'damage'"},
		{"percentile first of many", "from events: percentile(0.5, dmg), avg(dmg), count()", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			pv, perr, err := RunPreview(st, Def{Expr: c.expr}, "", 500)
			if perr != nil || err != nil {
				t.Fatalf("preview %q: %v %v", c.expr, perr, err)
			}
			oracle := subjectStats(t, st, c.filter)
			if len(pv.Rows) != len(oracle) {
				t.Fatalf("rows = %d, want %d (one per subject)", len(pv.Rows), len(oracle))
			}
			seen := 0
			for _, r := range pv.Rows {
				want, ok := oracle[r.Group]
				if !ok {
					t.Errorf("row group %q is not a subject of the oracle", r.Group)
					continue
				}
				seen++
				if r.N != want.n {
					t.Errorf("subject %s N = %d, want %d (its own rows)", r.Group, r.N, want.n)
				}
				if r.Value < want.min || r.Value > want.max {
					t.Errorf("subject %s value %v outside its own [%v, %v]", r.Group, r.Value, want.min, want.max)
				}
			}
			if seen != len(oracle) {
				t.Errorf("matched %d subjects, want %d", seen, len(oracle))
			}
		})
	}

	// Percentile + denominator: profile scope correlates the denominator
	// on the subject — 100 (every subject's max) / 72 (its career
	// rounds), exact for all eight subjects.
	pv, perr, err := RunPreview(st, Def{Expr: "from events: percentile(1.0, dmg)", Denominator: "rounds"}, "", 100)
	if perr != nil || err != nil {
		t.Fatalf("preview with denom: %v %v", perr, err)
	}
	if len(pv.Rows) != 8 {
		t.Fatalf("denominated percentile rows = %d, want 8 (%+v)", len(pv.Rows), pv.Rows)
	}
	want := 100.0 / 72.0
	for _, r := range pv.Rows {
		if r.Value != want {
			t.Errorf("subject %s denominated max = %v, want %v (100 / 72 career rounds)", r.Group, r.Value, want)
		}
		if r.N == 0 {
			t.Errorf("subject %s N = 0, want its event count", r.Group)
		}
	}
}

// TestRowCapAndTruncation pins preview caps (preview has a row
// cap over the SUBJECT rows it returns; Truncated reports hitting it).
func TestRowCapAndTruncation(t *testing.T) {
	st := seededStore(t)
	pv, perr, err := RunPreview(st, Def{Expr: "from events: count()"}, "", 3)
	if perr != nil || err != nil {
		t.Fatalf("preview: %v %v", perr, err)
	}
	if len(pv.Rows) != 3 || !pv.Truncated {
		t.Fatalf("rows = %d truncated = %v, want 3 rows capped", len(pv.Rows), pv.Truncated)
	}
	pv, _, err = RunPreview(st, Def{Expr: "from events: count()"}, "", 500)
	if err != nil || pv.Truncated {
		t.Fatalf("uncapped preview truncated = %v (err %v)", pv.Truncated, err)
	}
	if len(pv.Rows) != 8 {
		t.Fatalf("uncapped rows = %d, want 8 (one per subject)", len(pv.Rows))
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
