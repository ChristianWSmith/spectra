package store

import (
	"os"
	"regexp"
	"testing"
)

// TestMetricValuesHasNoNColumn pins B6 (dogfood/PLAN.md ruling 2): a metric
// value carries no sample size. The column is gone from the schema, so no
// writer can store it and no reader can select it.
func TestMetricValuesHasNoNColumn(t *testing.T) {
	s := openMem(t)
	cols, err := s.schemaColumns("metric_values")
	if err != nil {
		t.Fatalf("schemaColumns(metric_values): %v", err)
	}
	for _, c := range cols {
		if c.Name == "n" {
			t.Fatalf("metric_values still has the retired sample-size column %q", c.Name)
		}
	}
}

// TestNoMetricValueNReaderRemains is the grep pin for B6: the metric value
// readers, writers and DTOs name no sample-size field. A reader selecting
// `v.n`, a writer listing `value_key, n`, a `json:"n"` tag or an `N int`
// field fails here, so the column cannot return through a side door.
func TestNoMetricValueNReaderRemains(t *testing.T) {
	banned := []*regexp.Regexp{
		regexp.MustCompile(`\bv\.n\b`),
		regexp.MustCompile(`value_key,\s*n\b`),
		regexp.MustCompile(`json:"n"`),
		regexp.MustCompile(`\bN\s+int\b`),
	}
	files := []string{
		"metric_values_store.go",
		"metrics_store.go",
		"metric_gate.go",
		"metric_scope.go",
		"analytics.go",
		"../models/metrics.go",
		"../query/schema.go",
		"../../metricservice.go",
	}
	for _, f := range files {
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("read %s: %v", f, err)
		}
		for _, re := range banned {
			if loc := re.FindIndex(src); loc != nil {
				t.Errorf("%s matches %s near %q", f, re, src[loc[0]:loc[1]])
			}
		}
	}
}
