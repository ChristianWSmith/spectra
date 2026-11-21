package models

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestMetricRowJSONContract pins the MetricRow binding shape (stored
// metrics W1): scope IS part of the frontend contract (derived from the
// binds, never stored, ruling 51), while Version is
// an INTERNAL-ONLY stamp — marshalling must never emit a "version" key
// ANYWHERE (row or list envelope: the owner ruling is that no stamp ever
// reaches an app surface), and the retired groupBy key must not come
// back either (the column is gone).
func TestMetricRowJSONContract(t *testing.T) {
	row := MetricRow{ID: 7, Name: "m", Version: 42}
	envelopes := map[string]any{
		"row":  row,
		"list": MetricListPage{Rows: []MetricRow{row}},
	}
	for name, v := range envelopes {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatalf("marshal %s: %v", name, err)
		}
		s := string(b)
		if strings.Contains(s, `"version"`) {
			t.Errorf("MetricRow JSON (%s) carries a version key — stamps are internal-only: %s", name, s)
		}
		if strings.Contains(s, `"groupBy"`) {
			t.Errorf("MetricRow JSON (%s) carries the retired groupBy key: %s", name, s)
		}
		if !strings.Contains(s, `"scope":`) {
			t.Errorf("MetricRow JSON (%s) missing the scope key: %s", name, s)
		}
	}
}

// TestMetricValueJSONContract pins the canonical-read DTO (stored
// metrics W5/§5, identity slot §3.3, partition dim §6.5): exactly
// {metricId, subjectKey, dim, value, valueKey} — the fields a value
// slot renders, and NOTHING else. dim is the partition value (empty on
// every unpartitioned row) so a partitioned read can tell its rows
// apart; valueKey is the identity winner's key (identity rows; the
// empty string on every numeric row). No stamp key of any
// kind (metricVersion / ruleVersion / computedAt are internal-only and
// must not even be expressible here), so no view, tooltip or export can
// render a version number by construction (design §5's no-version pin).
func TestMetricValueJSONContract(t *testing.T) {
	ptr := func(x float64) *float64 { return &x }
	b, err := json.Marshal(MetricValue{MetricID: 7, SubjectKey: "76561198000000001", Value: ptr(1.5)})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	want := []string{"metricId", "subjectKey", "dim", "value", "valueKey"}
	if len(got) != len(want) {
		t.Errorf("MetricValue JSON keys = %d, want exactly %d: %s", len(got), len(want), b)
	}
	for _, k := range want {
		if _, ok := got[k]; !ok {
			t.Errorf("MetricValue JSON missing %q: %s", k, b)
		}
	}
	for _, forbidden := range []string{"version", "metricVersion", "ruleVersion", "computedAt", "stamps"} {
		if _, ok := got[forbidden]; ok {
			t.Errorf("MetricValue JSON carries the internal-only key %q: %s", forbidden, b)
		}
	}
}
