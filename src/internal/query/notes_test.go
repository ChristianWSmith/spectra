package query

import "testing"

// TestNoteFallbacks pins the schema-browser contract: unknown tables and
// columns keep Note "" (package doc).
func TestNoteFallbacks(t *testing.T) {
	if got := tableNotes["definitely_not_a_table"]; got != "" {
		t.Errorf("unknown table note = %q, want \"\"", got)
	}
	if got := columnNote("definitely_not_a_table", "x"); got != "" {
		t.Errorf("unknown table column note = %q, want \"\"", got)
	}
	if got := columnNote("matches", "no_such_column"); got != "" {
		t.Errorf("unknown column note = %q, want \"\"", got)
	}
	if got := tableNotes["events"]; got == "" {
		t.Error("known table has no note")
	}
}

// TestStoredMetricsNotes pins the stored-metrics note set: both new
// tables and the metrics.scope column carry a purpose note, and the
// INTERNAL-ONLY stamp columns carry none — the console is a user surface,
// so no version/stamp language may reach it (owner ruling; a stamp column
// must not gain a note without that ruling changing).
func TestStoredMetricsNotes(t *testing.T) {
	for _, table := range []string{"metric_values", "metric_deps"} {
		if got := tableNotes[table]; got == "" {
			t.Errorf("table %s has no note", table)
		}
	}
	if got := columnNote("metrics", "scope"); got == "" {
		t.Error("metrics.scope has no note")
	}
	// Stamps are internal-only: NO column note on any of them.
	for _, c := range []struct{ table, col string }{
		{"metrics", "version"},
		{"metric_values", "metric_version"},
		{"metric_values", "rule_version"},
	} {
		if got := columnNote(c.table, c.col); got != "" {
			t.Errorf("%s.%s note = %q, want \"\" (stamps are internal-only — no version language in the console)", c.table, c.col, got)
		}
	}
}
