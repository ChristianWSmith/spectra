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
