package main

import (
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/metrics"
	"github.com/ChristianWSmith/spectra/internal/models"
)

// W4 — the read-path oracle (design §7's "equivalence at the read"):
// the rows a VIEW gets from the canonical reads must equal W3's
// stored==computed oracle for the same fixture — i.e. the view path
// (MetricsService.GetMetricValuesForMatch / GetMetricValuesForPlayer)
// serves exactly what the compute pass stored and exactly what the
// query-time engine would have calculated, in canonical order, with no
// extra or missing rows. Plus the no-execution compile pin: the
// provenance SQL a clean-saved preview shows is compiled, never run.

// viewMatchRead merges the canonical MATCH read over every ready match
// into the (match, subject) key space the oracles use.
func viewMatchRead(t *testing.T, f *depsFixture, metricID int64) map[eqKey]eqVal {
	t.Helper()
	out := map[eqKey]eqVal{}
	for _, mid := range readyMatchIDs(t, f.st) {
		rows, err := f.svc.GetMetricValuesForMatch(mid, []int64{metricID})
		if err != nil {
			t.Fatalf("GetMetricValuesForMatch(%d): %v", mid, err)
		}
		for _, r := range rows {
			key := eqKey{matchID: mid, steam: r.SteamID}
			if _, dup := out[key]; dup {
				t.Errorf("duplicate view row for %+v", key)
			}
			out[key] = eqVal{value: r.Value, n: r.N}
		}
	}
	return out
}

// viewCareerRead is the canonical PROFILE read (the whole career bucket
// — the same call PlayerProfile's panel and Builder's saved preview
// make) in the same key space (match 0).
func viewCareerRead(t *testing.T, f *depsFixture, metricID int64) map[eqKey]eqVal {
	t.Helper()
	rows, err := f.svc.GetMetricValuesForPlayer("", []int64{metricID})
	if err != nil {
		t.Fatalf("GetMetricValuesForPlayer: %v", err)
	}
	out := map[eqKey]eqVal{}
	for _, r := range rows {
		key := eqKey{matchID: 0, steam: r.SteamID}
		if _, dup := out[key]; dup {
			t.Errorf("duplicate view row for %+v", key)
		}
		out[key] = eqVal{value: r.Value, n: r.N}
	}
	return out
}

// TestMetricReadViewPathEqualsOracle pins the W4 read contract for both
// grains: save → sweep → the canonical read a view calls equals the
// stored rows (W3's data oracle) AND the query-time evaluation (W3's
// computed oracle), row for row — so switching a view from preview-time
// calculation to the stored read cannot change a single number.
func TestMetricReadViewPathEqualsOracle(t *testing.T) {
	f := newSeededFixture(t)
	cases := []struct {
		name  string
		expr  string
		denom string
		scope string
	}{
		{"rd01_count_match", "from events: count()", "", "match"},
		{"rd02_count_rounds_match", "from events: count()", "rounds", "match"},
		{"rd03_sum_profile", "from player_stats: sum(kills)", "matches", "profile"},
		{"rd04_joined_match", "from player_stats, match_trade_opps: ratio(sum(trade_kills), sum(opps))", "", "match"},
		{"rd05_p95_match", "from events: percentile(0.95, dmg)", "", "match"},
		{"rd06_median_profile", "from events: median(dmg)", "", "profile"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := f.save(t, models.MetricRow{Name: tc.name, Expr: tc.expr, Scope: tc.scope, Denominator: tc.denom})
			res, err := f.svc.runSweep(t.Context(), nil)
			if err != nil {
				t.Fatalf("sweep: %v", err)
			}
			if len(res.Failed) > 0 || len(res.Skipped) > 0 {
				t.Fatalf("sweep failures=%v skipped=%v", res.Failed, res.Skipped)
			}

			stored := storedOracle(t, f.st, m.ID)
			want := previewOracle(t, f.st, metrics.Def{Expr: tc.expr, Denominator: tc.denom}, tc.scope)
			var got map[eqKey]eqVal
			if tc.scope == "profile" {
				got = viewCareerRead(t, f, m.ID)
			} else {
				got = viewMatchRead(t, f, m.ID)
			}
			compareOracles(t, tc.name+" view==stored", got, stored)
			compareOracles(t, tc.name+" view==computed", got, want)

			// Absent-row honesty at the read: every key the view serves
			// is a real stored row (no synthesized zeros) — compareOracles
			// above already fails on any extra/missing key; this pins the
			// count so an all-empty read cannot pass vacuously.
			if len(got) == 0 {
				t.Errorf("%s: view read is empty — fixture/sweep broken", tc.name)
			}
		})
	}
}

// TestCompileMetricIsNoExecution pins design §5's no-execution Compile:
// the provenance SQL a clean-saved preview shows compiles the SAME
// statement PreviewMetric would run, without executing it (no rows are
// written, no result set is returned — a saved read never calculates).
func TestCompileMetricIsNoExecution(t *testing.T) {
	f := newSeededFixture(t)
	m := f.save(t, models.MetricRow{
		Name: "compile_me", Expr: "from events: count()", Scope: "match",
	})

	sql, err := f.svc.CompileMetric(m.ID, "", "")
	if err != nil {
		t.Fatalf("CompileMetric: %v", err)
	}
	if sql == "" || !strings.Contains(strings.ToUpper(sql), "SELECT") {
		t.Fatalf("CompileMetric returned no SELECT statement: %q", sql)
	}

	// Coverage is UNCHANGED by the compile (it is behind — never
	// computed — and a compile must not move it in either direction).
	cfg, err := f.st.GetConfig()
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	coverageBefore, err := f.st.MetricCoverage(cfg.RuleVersion)
	if err != nil {
		t.Fatalf("MetricCoverage: %v", err)
	}
	for _, c := range coverageBefore {
		if c.MetricID != m.ID {
			continue
		}
		if !c.Behind || c.FreshRows != 0 {
			t.Fatalf("fixture metric not in the never-computed state: %+v", c)
		}
	}

	// The SAME statement PreviewMetric would have run (identical
	// provenance), and the compile wrote NOTHING: no metric_values row,
	// no coverage movement — the sweep is still the only writer.
	pv, err := f.svc.PreviewMetric(m.ID, "", "", 10)
	if err != nil {
		t.Fatalf("PreviewMetric: %v", err)
	}
	if pv.SQL != sql {
		t.Errorf("compiled SQL != executed SQL\ncompile: %s\npreview: %s", sql, pv.SQL)
	}
	coverageAfter, err := f.st.MetricCoverage(cfg.RuleVersion)
	if err != nil {
		t.Fatalf("MetricCoverage (after): %v", err)
	}
	for i, c := range coverageAfter {
		if coverageBefore[i] != c {
			t.Errorf("compile moved coverage: %+v -> %+v (a read never writes)", coverageBefore[i], c)
		}
	}
	res, err := f.st.QueryWrite(t.Context(),
		`SELECT COUNT(*) FROM metric_values WHERE metric_id = ?`, []any{m.ID}, 1)
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if n := res.Rows[0][0].(int64); n != 0 {
		t.Errorf("metric_values rows after compile = %d, want 0 (compile never executes)", n)
	}

	// Ad-hoc expression: same no-execution contract (a draft's
	// provenance compiles without calculating).
	if _, err := f.svc.CompileMetric(0, "from player_stats: sum(kills)", ""); err != nil {
		t.Fatalf("CompileMetric ad-hoc: %v", err)
	}
	// A bad expression errors exactly like the preview path.
	if _, err := f.svc.CompileMetric(m.ID, "from nope: count()", ""); err == nil {
		t.Error("CompileMetric accepted an unknown source, want the positioned error")
	}
}
