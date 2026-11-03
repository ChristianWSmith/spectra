package metrics

import (
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/query"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// TestSchemaConsistency is the cross-package drift tripwire (G1):
//
//	a) every source the metrics whitelist exposes — and every column of it —
//	   exists in the store's real schema (Store.Schema over the embedded
//	   migrations), so a migration/DDL change cannot silently invalidate a
//	   compiled metric;
//	b) the SQL console's schema browser annotates every metrics source
//	   (query.Session.Schema notes ⊇ whitelist sources), so a source the
//	   expression grammar accepts is documented where users browse it.
//
// The whitelist itself stays a hand-curated copy (a different concern:
// JSON/blob payload columns are deliberately excluded — see whitelist.go).
func TestSchemaConsistency(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	// ---- (a) whitelist ⊆ store schema ----
	schema, err := st.Schema()
	if err != nil {
		t.Fatalf("Schema: %v", err)
	}
	haveTable := make(map[string]map[string]bool, len(schema))
	for _, tb := range schema {
		cols := make(map[string]bool, len(tb.Columns))
		for _, c := range tb.Columns {
			cols[c.Name] = true
		}
		haveTable[tb.Name] = cols
	}

	// The `sources` message list and the sourceColumns keys are the same set
	// (knownSource() reads one, the error text prints the other).
	if len(sources) != len(sourceColumns) {
		t.Errorf("sources has %d entries, sourceColumns %d — same set required", len(sources), len(sourceColumns))
	}
	for _, src := range sources {
		if _, ok := sourceColumns[src]; !ok {
			t.Errorf("source %q is listed in `sources` but missing from sourceColumns", src)
		}
	}

	for src, cols := range sourceColumns {
		tableCols, ok := haveTable[src]
		if !ok {
			t.Errorf("metrics source %q has no table in the store schema", src)
			continue
		}
		for c := range cols {
			if !tableCols[c] {
				t.Errorf("metrics whitelists %s.%s — not in the store schema", src, c)
			}
		}
		// groupColumns must only reference whitelisted sources, and its
		// plain (non-subquery) column expressions must exist too.
		for token, col := range groupColumns[src] {
			if _, ok := cols[col]; !ok && !strings.Contains(col, "(") {
				t.Errorf("groupColumns[%s][%q] = %q is not a whitelisted column", src, token, col)
			}
		}
	}

	// Denominator subquery sources are real tables (player_rounds maps to
	// player_round_stats — the contract's alias).
	for alias, table := range denominatorTables {
		if _, ok := haveTable[table]; !ok {
			t.Errorf("denominator %q maps to table %q, which is not in the store schema", alias, table)
		}
	}

	// ---- (b) schema-browser notes ⊇ metrics sources ----
	tables, err := query.New(st).Schema()
	if err != nil {
		t.Fatalf("query schema: %v", err)
	}
	notes := make(map[string]string, len(tables))
	for _, tb := range tables {
		notes[tb.Name] = tb.Note
	}
	for _, src := range sources {
		if strings.TrimSpace(notes[src]) == "" {
			t.Errorf("metrics source %q has no note in the SQL console schema browser", src)
		}
	}
}
