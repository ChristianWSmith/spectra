package models

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestMetricRowJSONContract pins the MetricRow binding shape (stored
// metrics W1): scope IS part of the frontend contract, while Version is
// an INTERNAL-ONLY stamp — marshalling must never emit a "version" key
// ANYWHERE (row or list envelope: the owner ruling is that no stamp ever
// reaches an app surface), and the retired groupBy key must not come
// back either (the column is gone).
func TestMetricRowJSONContract(t *testing.T) {
	row := MetricRow{ID: 7, Name: "m", Scope: "match", Version: 42}
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
		if !strings.Contains(s, `"scope":"match"`) {
			t.Errorf("MetricRow JSON (%s) missing the scope key: %s", name, s)
		}
	}
}
