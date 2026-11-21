package main

import (
	"reflect"
	"strings"
	"testing"

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

// TestCompileMetricIsNoExecution pins design §5's no-execution Compile:
// the provenance SQL a clean-saved preview shows compiles the SAME
// statement PreviewMetric would run, without executing it (no rows are
// written, no result set is returned — a saved read never calculates).
func TestCompileMetricIsNoExecution(t *testing.T) {
	f := newSeededFixture(t)
	m := f.save(t, models.MetricRow{
		Name: "compile_me", Expr: "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM events WHERE match_id = :match_id", Scope: "match",
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
	shown, err := f.svc.CompileMetric(m.ID, "", "")
	if err != nil {
		t.Fatalf("CompileMetric: %v", err)
	}
	if shown != sql {
		t.Errorf("shown SQL != stored SQL\nshown: %s\nstored: %s", shown, sql)
	}
	coverageAfter, err := f.st.MetricCoverage(cfg.RuleVersion)
	if err != nil {
		t.Fatalf("MetricCoverage (after): %v", err)
	}
	for i, c := range coverageAfter {
		if !reflect.DeepEqual(coverageBefore[i], c) {
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
	if _, err := f.svc.CompileMetric(0, "SELECT '' AS subject_key, '' AS dim, SUM(kills) AS value FROM player_stats WHERE match_id = :match_id", ""); err != nil {
		t.Fatalf("CompileMetric ad-hoc: %v", err)
	}
	// A bad expression errors exactly like the preview path.
	if _, err := f.svc.CompileMetric(m.ID, "SELECT '' AS subject_key, '' AS dim, COUNT(*) AS value FROM nope WHERE match_id = :match_id", ""); err == nil {
		t.Error("CompileMetric accepted an unknown source, want the positioned error")
	}
}
