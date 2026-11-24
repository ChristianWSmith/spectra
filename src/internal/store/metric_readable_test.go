package store

import (
	"sort"
	"testing"
)

// MetricReadableTables is the readable side of the allowlist, sorted: the
// Builder's completions show exactly what the save gate accepts.
func TestMetricReadableTablesMatchTheAllowlist(t *testing.T) {
	got := MetricReadableTables()
	if !sort.StringsAreSorted(got) {
		t.Errorf("not sorted: %v", got)
	}
	want := 0
	for _, ok := range metricReadable {
		if ok {
			want++
		}
	}
	if len(got) != want || want == 0 {
		t.Fatalf("got %d tables, allowlist has %d readable", len(got), want)
	}
	for _, name := range got {
		if !metricReadable[name] {
			t.Errorf("%s is listed but not readable", name)
		}
	}
	has := map[string]bool{}
	for _, name := range got {
		has[name] = true
	}
	if !has["player_stats"] {
		t.Errorf("player_stats (a fact table) is not listed")
	}
	if has["metrics"] {
		t.Errorf("the app's own metric definitions table is listed as readable")
	}
}
