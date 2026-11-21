package query

import (
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/store"
)

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
// tables carry a purpose note, and the INTERNAL-ONLY stamp columns carry
// none — the console is a user surface,
// so no version/stamp language may reach it (owner ruling; a stamp column
// must not gain a note without that ruling changing).
func TestStoredMetricsNotes(t *testing.T) {
	for _, table := range []string{"metric_values", "metric_deps"} {
		if got := tableNotes[table]; got == "" {
			t.Errorf("table %s has no note", table)
		}
	}
	// metrics has no scope column (dogfood/PLAN.md ruling 51), so there is
	// nothing to annotate: a note here would describe a column that is gone.
	if got := columnNote("metrics", "scope"); got != "" {
		t.Errorf("metrics.scope has a note but the column is gone: %q", got)
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

// TestEverySchemaTableHasNote is the note-coverage assertion (C3): the
// sidebar reads its schema LIVE (sqlite_master + pragma_table_info on the
// app's own database — never the embedded baseline schema.sql), and the
// prose notes are the only thing this package hard-codes about it. Every
// table the baseline ships must carry one, so a table added to
// schema.sql without a note fails here instead of reaching users as a
// bare name (plugin/unknown tables keep "" — TestNoteFallbacks).
func TestEverySchemaTableHasNote(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	// The same read the console's sidebar does (Session.Schema over the
	// store's live schema).
	tables, err := New(st).Schema()
	if err != nil {
		t.Fatalf("Schema: %v", err)
	}
	if len(tables) == 0 {
		t.Fatal("schema read returned no tables — the coverage loop would pass vacuously")
	}
	for _, tb := range tables {
		if strings.TrimSpace(tb.Note) == "" {
			t.Errorf("table %s has no note in the SQL console schema browser", tb.Name)
		}
	}
}
