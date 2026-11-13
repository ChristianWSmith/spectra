package metrics

import (
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/query"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// TestSchemaConsistency is the cross-package drift tripwire (G1):
//
//	a) every source the metrics whitelist exposes — and every column of it —
//	   exists in the store's real schema (Store.Schema over the embedded
//	   baseline schema.sql), so a schema/DDL change cannot silently
//	   invalidate a compiled metric;
//	b) the SQL console's schema browser annotates every metrics source
//	   (query.Session.Schema notes ⊇ whitelist sources), so a source the
//	   expression grammar accepts is documented where users browse it;
//	c) the subject map the anchor validates against ⊆ the column
//	   whitelist (every source carries a subject decision — rounds and
//	   round_economy have none — and the anchor error's player list is
//	   exactly its key set), and both denominator unit maps (the
//	   match-scope scalar, the profile-scope career correlation) name
//	   real tables under the same {rounds, matches} aliases.
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
		// The fixed join dimensions (sourceDims) must only reference
		// whitelisted columns of their own source.
		for token, col := range sourceDims[src] {
			if !cols[col] {
				t.Errorf("sourceDims[%s][%q] = %q is not a whitelisted column", src, token, col)
			}
		}
	}

	// The subject map (the anchor Compile validates against) is a SUBSET
	// of the column whitelist — a subject that is not a whitelisted
	// column of its own source would compile SQL the grammar cannot
	// validate — and every source carries a subject DECISION: exactly
	// rounds and round_economy have none (round-grain / side-grained).
	for src, col := range sourceSubject {
		cols, ok := sourceColumns[src]
		if !ok {
			t.Errorf("sourceSubject names non-source %q", src)
			continue
		}
		if !cols[col] {
			t.Errorf("sourceSubject[%s] = %q is not a whitelisted column", src, col)
		}
	}
	for _, src := range sources {
		_, has := sourceSubject[src]
		want := src != "rounds" && src != "round_economy"
		if has != want {
			t.Errorf("source %q subject presence = %v, want %v (round-grain sources have no subject)", src, has, want)
		}
	}
	// The anchor error's verbatim player list (playerSources) names
	// exactly the subject-bearing sources — the copy in Compile and the
	// map it reads cannot drift apart.
	listed := map[string]bool{}
	for _, s := range strings.Split(playerSources, ", ") {
		listed[s] = true
	}
	if len(listed) != len(sourceSubject) {
		t.Errorf("playerSources lists %d sources, sourceSubject declares %d — same set required",
			len(listed), len(sourceSubject))
	}
	for src := range sourceSubject {
		if !listed[src] {
			t.Errorf("sourceSubject source %q missing from the anchor error list", src)
		}
	}
	for src := range listed {
		if _, ok := sourceSubject[src]; !ok {
			t.Errorf("anchor error list names %q, which has no subject", src)
		}
	}

	// Denominator subquery sources are real tables, and the set is
	// EXACTLY {rounds, matches} (owner ruling: the player_rounds alias
	// was retired — player_round_stats stays a metric SOURCE; only the
	// denominator option is gone).
	if len(denominatorTables) != 2 {
		t.Errorf("denominatorTables has %d entries, want exactly 2 (rounds, matches)", len(denominatorTables))
	}
	for alias, want := range map[string]string{"rounds": "rounds", "matches": "matches"} {
		if got, ok := denominatorTables[alias]; !ok || got != want {
			t.Errorf("denominatorTables[%q] = %q, ok=%v — want %q (the two surviving values)", alias, got, ok, want)
		}
	}
	if _, retired := denominatorTables["player_rounds"]; retired {
		t.Error("denominatorTables still carries the retired player_rounds alias")
	}
	for alias, table := range denominatorTables {
		if _, ok := haveTable[table]; !ok {
			t.Errorf("denominator %q maps to table %q, which is not in the store schema", alias, table)
		}
	}
	// The profile-scope (career) denominator maps the SAME two aliases to
	// real tables — one rule, two units (whitelist.go
	// denominatorCareerTables): rounds → the subject's player_round_stats
	// rows, matches → its player_stats rows.
	if len(denominatorCareerTables) != len(denominatorTables) {
		t.Errorf("denominatorCareerTables has %d entries, want %d (the same aliases)", len(denominatorCareerTables), len(denominatorTables))
	}
	for alias, table := range denominatorCareerTables {
		if denominatorTables[alias] == "" {
			t.Errorf("career denominator %q has no match-scope alias", alias)
		}
		if _, ok := haveTable[table]; !ok {
			t.Errorf("career denominator %q maps to table %q, which is not in the store schema", alias, table)
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

// TestJoinKeyDeclarationsMatchSchema pins the join declarations
// (whitelist.go) against the real DDL — the TestSchemaConsistency
// pattern for the join criterion:
//
//	a) every source declares a uniqueness key and a population (no
//	   orphan declarations), every source carries the `match` dimension,
//	   and every declared key column is whitelisted;
//	b) each declared uniqueness key IS a real PK/UNIQUE of the table in
//	   the store schema — joinKey's fan-out guard rests on DDL truth;
//	c) match_trade_opps is declared humans-only (the first member of the
//	   population split).
func TestJoinKeyDeclarationsMatchSchema(t *testing.T) {
	// RunReadOnly is file-backed only, so this test opens a temp file
	// (not :memory:) — the pragma reads ride the read-only session.
	st, err := store.Open(filepath.Join(t.TempDir(), "joinkeys.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	// ---- (a) coverage: sources == keys == populations ----
	if len(sourceUniqueKeys) != len(sources) || len(sourcePopulation) != len(sources) {
		t.Errorf("coverage: %d sources, %d keys, %d populations — same set required",
			len(sources), len(sourceUniqueKeys), len(sourcePopulation))
	}
	known := make(map[string]bool, len(sources))
	for _, src := range sources {
		known[src] = true
		if _, ok := sourceUniqueKeys[src]; !ok {
			t.Errorf("source %q has no declared uniqueness key", src)
		}
		if _, ok := sourcePopulation[src]; !ok {
			t.Errorf("source %q has no declared population", src)
		}
		if !sourceColumns[src]["match_id"] {
			t.Errorf("source %q does not carry the match dimension (match_id)", src)
		}
		for _, col := range sourceUniqueKeys[src] {
			if !sourceColumns[src][col] {
				t.Errorf("source %q key column %q is not whitelisted", src, col)
			}
		}
	}
	for src := range sourceUniqueKeys {
		if !known[src] {
			t.Errorf("uniqueness key declared for non-source %q", src)
		}
	}
	for src := range sourcePopulation {
		if !known[src] {
			t.Errorf("population declared for non-source %q", src)
		}
	}

	// ---- (b) declared keys ⊆ real PK/UNIQUE sets ----
	for _, src := range sources {
		actual := tableKeySets(t, st, src)
		decl := strings.Join(sortedStrings(sourceUniqueKeys[src]), ",")
		if !actual[decl] {
			t.Errorf("source %q declared key [%s] is not a PK/UNIQUE of the table (real keys: %v)", src, decl, actual)
		}
	}

	// ---- (c) population pin ----
	if sourcePopulation["match_trade_opps"] != popHumansOnly {
		t.Errorf("match_trade_opps population = %v, want popHumansOnly", sourcePopulation["match_trade_opps"])
	}
}

// tableKeySets returns every real key (PK + UNIQUE constraint/index,
// non-partial) of a table as a canonical comma-joined column set.
func tableKeySets(t *testing.T, st *store.Store, table string) map[string]bool {
	t.Helper()
	sets := map[string]bool{}
	res, err := st.RunReadOnly(
		`SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk`,
		[]any{table}, 64, 5000,
	)
	if err != nil {
		t.Fatalf("table_info %s: %v", table, err)
	}
	var pk []string
	for _, r := range res.Rows {
		pk = append(pk, r[0].(string))
	}
	if len(pk) > 0 {
		sets[strings.Join(sortedStrings(pk), ",")] = true
	}
	res, err = st.RunReadOnly(
		`SELECT name FROM pragma_index_list(?) WHERE "unique" = 1 AND origin IN ('pk','u') AND partial = 0`,
		[]any{table}, 64, 5000,
	)
	if err != nil {
		t.Fatalf("index_list %s: %v", table, err)
	}
	for _, r := range res.Rows {
		idx, _ := r[0].(string)
		cols, err := st.RunReadOnly(
			`SELECT name FROM pragma_index_info(?) ORDER BY seqno`,
			[]any{idx}, 64, 5000,
		)
		if err != nil {
			t.Fatalf("index_info %s: %v", idx, err)
		}
		var names []string
		for _, cr := range cols.Rows {
			names = append(names, cr[0].(string))
		}
		if len(names) > 0 {
			sets[strings.Join(sortedStrings(names), ",")] = true
		}
	}
	return sets
}

// sortedStrings returns a sorted copy (canonical key comparison).
func sortedStrings(in []string) []string {
	out := append([]string(nil), in...)
	sort.Strings(out)
	return out
}
