package metrics

import (
	"testing"
)

// TestRawFoldSeeds runs every F2 raw-SQL fold seed (schema.sql, dogfood/PLAN.md
// F2) through the sweep's own unit on the synthetic corpus. Each statement
// must gate, run for every scope it needs, and store at least one row. The
// snapshot equality check is recorded in spectra-verify/f2/RESULTS-raw.md.
func TestRawFoldSeeds(t *testing.T) {
	st := seededStore(t)

	res, err := st.RunReadOnly(
		`SELECT name FROM metrics WHERE origin = 'builtin' AND name LIKE 'raw\_%' ESCAPE '\' ORDER BY name`,
		nil, 200, 5000,
	)
	if err != nil {
		t.Fatalf("list raw fold seeds: %v", err)
	}
	if len(res.Rows) != 16 {
		t.Fatalf("raw seeds = %d, want 16 (the 23 F2 twins of the builtins were retired by F3; 16 remain)", len(res.Rows))
	}
	for _, r := range res.Rows {
		name := r[0].(string)
		t.Run(name, func(t *testing.T) {
			m, err := st.GetMetricByName(name)
			if err != nil {
				t.Fatalf("GetMetricByName: %v", err)
			}
			if err := runRawMetric(t.Context(), st, m, 0); err != nil {
				t.Fatalf("runRawMetric: %v", err)
			}
			cnt, err := st.RunReadOnly(
				`SELECT COUNT(*) FROM metric_values WHERE metric_id = ?`, []any{m.ID}, 1, 5000)
			if err != nil {
				t.Fatalf("count values: %v", err)
			}
			if n := cnt.Rows[0][0].(int64); n == 0 {
				t.Errorf("%s stored no rows on the synthetic corpus", name)
			}
		})
	}
}
