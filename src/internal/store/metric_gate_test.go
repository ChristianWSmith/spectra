package store

import (
	"reflect"
	"strings"
	"testing"
)

// TestMetricReadableClassifiesEverySchemaTable is the allowlist pin: every
// table the schema creates is classified readable or denied in
// metricReadable, and every classified name is a schema table. A new table
// fails here until someone classifies it — it can never become readable by
// accident.
func TestMetricReadableClassifiesEverySchemaTable(t *testing.T) {
	s := openMem(t)
	rows, err := s.db.Query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			t.Fatal(err)
		}
		names = append(names, n)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if un := UnclassifiedTables(names); len(un) != 0 {
		t.Errorf("schema tables not classified in metricReadable (readable or denied) — classify them: %v", un)
	}
	inSchema := map[string]bool{}
	for _, n := range names {
		inSchema[n] = true
	}
	for n := range metricReadable {
		if !inSchema[n] {
			t.Errorf("metricReadable classifies %q, which is not a schema table", n)
		}
	}
}

// TestUnclassifiedTablesFlagsANewTable proves the pin's failure mode: a
// table the allowlist has never seen is reported, classified names and
// sqlite_* are not.
func TestUnclassifiedTablesFlagsANewTable(t *testing.T) {
	got := UnclassifiedTables([]string{"players", "sqlite_sequence", "brand_new_fact", "matches"})
	if !reflect.DeepEqual(got, []string{"brand_new_fact"}) {
		t.Fatalf("UnclassifiedTables = %v, want [brand_new_fact]", got)
	}
}

// TestMetricReadableSettledList pins the classification itself
// (dogfood/03-QUERIES.md §3.2).
func TestMetricReadableSettledList(t *testing.T) {
	readable := []string{"events", "engagements", "rounds", "player_stats", "player_round_stats",
		"round_economy", "clutches", "utility_events", "chat", "match_trade_opps",
		"round_classifications", "round_side_classes", "round_player_sides", "matches", "players",
		"PLAYER_STATS"}
	denied := []string{"sqlite_master", "sqlite_schema", "sqlite_sequence", "generic_events", "metric_values",
		"round_player_money", "teams", "sound_events", "jobs", "query_history", "saved_queries",
		"saved_filters", "report_templates", "plugins", "analysis_config", "layout_placements",
		"metrics", "metric_deps", "voice_presence", "warnings", "player_career", "no_such_table"}
	for _, n := range readable {
		if !metricReadableTable(n) {
			t.Errorf("%q must be readable", n)
		}
	}
	for _, n := range denied {
		if metricReadableTable(n) {
			t.Errorf("%q must be denied", n)
		}
	}
}

// TestMetricGateRefusals pins one refusal per rule.
func TestMetricGateRefusals(t *testing.T) {
	cases := []struct {
		name, q, want string
	}{
		{"multi-statement", "SELECT 1 FROM players; SELECT 2 FROM players", "single statement"},
		{"write verb", "DELETE FROM players", "delete statements are not allowed"},
		{"write verb in CTE", "WITH x AS (SELECT 1) INSERT INTO players SELECT * FROM x", "insert statements are not allowed"},
		{"create view", "CREATE VIEW v AS SELECT * FROM players", "create statements are not allowed"},
		{"create table", "CREATE TABLE x (a)", "create statements are not allowed"},
		{"pragma lead", "PRAGMA table_info(players)", "one SELECT or WITH statement"},
		{"explain lead", "EXPLAIN SELECT * FROM players", "one SELECT or WITH statement"},
		{"values lead", "VALUES (1)", "one SELECT or WITH statement"},
		{"denied table", "SELECT COUNT(*) FROM jobs", `metrics can't read "jobs"`},
		{"raw payload table", "SELECT * FROM generic_events", `metrics can't read "generic_events"`},
		{"metric store direct", "SELECT value FROM metric_values", `metrics can't read "metric_values"`},
		{"sqlite master", "SELECT name FROM sqlite_master", `metrics can't read "sqlite_master"`},
		{"sqlite schema mixed case", "SELECT name FROM SQLite_Schema", `metrics can't read "sqlite_schema"`},
		{"voice", "SELECT * FROM voice_presence", `metrics can't read "voice_presence"`},
		{"unknown table", "SELECT * FROM nope", `metrics can't read "nope"`},
		{"pragma function", "SELECT * FROM pragma_table_info('players')", "pragma_table_info() can't be read"},
		{"other schema", "SELECT * FROM temp.players", "only the library's own tables"},
		{"metric() bad arg", "SELECT * FROM metric(kills)", "metric() takes one quoted metric name"},
		{"cte shadows table", "WITH players AS (SELECT 1) SELECT * FROM players", `the WITH name "players" is already a table name`},
		{"cte shadows denied table", `WITH "jobs" AS (SELECT 1 FROM players) SELECT * FROM jobs`, `the WITH name "jobs" is already a table name`},
		{"unbalanced", "SELECT (1 FROM players", "unbalanced parentheses"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, gerr := AnalyzeMetricSQL(c.q, nil)
			if gerr == nil {
				t.Fatalf("%q passed the gate, want refusal %q", c.q, c.want)
			}
			if !strings.Contains(gerr.Message, c.want) {
				t.Fatalf("%q refused with %q, want %q", c.q, gerr.Message, c.want)
			}
		})
	}
}

// TestMetricGateResolution pins table resolution across the shapes a naive
// scan would skip: comma joins, CTEs, subqueries (FROM, WHERE, select-list,
// JOIN), quoted names and `IN <table>`. A denied table in any of them
// refuses; the readable forms derive the full touched set.
func TestMetricGateResolution(t *testing.T) {
	refused := []struct{ name, q, table string }{
		{"comma join second", "SELECT * FROM players, jobs", "jobs"},
		{"comma join third", "SELECT * FROM players p, events e, metrics m WHERE p.match_id = e.match_id", "metrics"},
		{"comma after join", "SELECT * FROM players p JOIN events e ON p.match_id = e.match_id, jobs j", "jobs"},
		{"comma join generic", "SELECT * FROM rounds r, generic_events g", "generic_events"},
		{"cte body", "WITH x AS (SELECT * FROM jobs) SELECT * FROM x", "jobs"},
		{"second cte", "WITH a AS (SELECT 1 FROM players), b AS (SELECT * FROM saved_queries) SELECT * FROM a, b", "saved_queries"},
		{"recursive cte", "WITH RECURSIVE r(n) AS (SELECT 1 FROM plugins UNION ALL SELECT n+1 FROM r) SELECT * FROM r", "plugins"},
		{"subquery in from", "SELECT * FROM (SELECT * FROM jobs) s", "jobs"},
		{"subquery in where", "SELECT * FROM players WHERE EXISTS (SELECT 1 FROM metric_deps)", "metric_deps"},
		{"subquery in select list", "SELECT (SELECT COUNT(*) FROM query_history) FROM players", "query_history"},
		{"subquery join", "SELECT * FROM players p LEFT JOIN (SELECT * FROM saved_filters) f ON 1", "saved_filters"},
		{"double-quoted", `SELECT * FROM "jobs"`, "jobs"},
		{"double-quoted join", `SELECT * FROM players JOIN "Metric_Values" ON 1`, "metric_values"},
		{"in table", "SELECT * FROM players WHERE steam_id IN jobs", "jobs"},
		{"union arm", "SELECT steam_id FROM players UNION SELECT name FROM metrics", "metrics"},
		{"main-qualified", "SELECT * FROM main.jobs", "jobs"},
	}
	for _, c := range refused {
		t.Run("refused/"+c.name, func(t *testing.T) {
			_, gerr := AnalyzeMetricSQL(c.q, nil)
			if gerr == nil || !strings.Contains(gerr.Message, `"`+c.table+`"`) {
				t.Fatalf("%q: got %v, want a refusal naming %q", c.q, gerr, c.table)
			}
		})
	}
	unresolvable := []struct{ name, q string }{
		{"bracket-quoted", "SELECT * FROM [players]"},
		{"backtick-quoted", "SELECT * FROM `players`"},
		{"string-literal table", "SELECT * FROM 'players'"},
		{"parenthesized join list", "SELECT * FROM (players JOIN events ON 1)"},
		{"missing table", "SELECT * FROM"},
		{"comma then nothing", "SELECT * FROM players,"},
	}
	for _, c := range unresolvable {
		t.Run("unresolvable/"+c.name, func(t *testing.T) {
			if _, gerr := AnalyzeMetricSQL(c.q, nil); gerr == nil {
				t.Fatalf("%q passed the gate; an unresolvable read must refuse", c.q)
			}
		})
	}
	resolved := []struct {
		name, q string
		want    []string
	}{
		{"plain", "SELECT COUNT(*) FROM players;", []string{"players"}},
		{"no table", "SELECT 1", []string{}},
		{"comma join", "SELECT * FROM players p, events e, rounds", []string{"events", "players", "rounds"}},
		{"joins", "SELECT * FROM player_stats ps LEFT OUTER JOIN players AS p ON p.steam_id = ps.steam_id INNER JOIN rounds r USING (match_id)", []string{"player_stats", "players", "rounds"}},
		{"cte", "WITH k AS (SELECT steam_id FROM events), d AS (SELECT * FROM k) SELECT * FROM d JOIN players ON 1", []string{"events", "players"}},
		{"subqueries", "SELECT (SELECT COUNT(*) FROM rounds), x.a FROM (SELECT 1 AS a FROM chat) x WHERE EXISTS (SELECT 1 FROM clutches) AND 1 IN (SELECT 1 FROM matches)", []string{"chat", "clutches", "matches", "rounds"}},
		{"quoted", `SELECT * FROM "Players" "p" JOIN main."events" ON 1`, []string{"events", "players"}},
		{"in table", "SELECT * FROM players WHERE match_id IN matches", []string{"matches", "players"}},
		{"json_each", "SELECT j.value FROM rounds r, json_each('[1,2]') j", []string{"rounds"}},
		{"distinct from", "SELECT * FROM players WHERE name IS NOT DISTINCT FROM steam_id", []string{"players"}},
		{"string mentions", "SELECT 'FROM jobs' AS x FROM players -- FROM jobs", []string{"players"}},
		{"window", "SELECT ROW_NUMBER() OVER (PARTITION BY match_id ORDER BY kills) FROM player_stats", []string{"player_stats"}},
		{"engagements alias", "SELECT * FROM engagements e JOIN round_player_sides s ON 1", []string{"engagements", "round_player_sides"}},
	}
	for _, c := range resolved {
		t.Run("resolved/"+c.name, func(t *testing.T) {
			st, gerr := AnalyzeMetricSQL(c.q, nil)
			if gerr != nil {
				t.Fatalf("%q refused: %s", c.q, gerr.Message)
			}
			if !reflect.DeepEqual(st.Touched, c.want) {
				t.Fatalf("%q touched = %v, want %v", c.q, st.Touched, c.want)
			}
		})
	}
}

// TestMetricGateRefs pins the metric('…') construct's extraction (name,
// quoting, position) — resolution against the catalog is the metrics
// package's half of the gate — and that a ref adds no touched table.
func TestMetricGateRefs(t *testing.T) {
	q := "SELECT a.value / b.value FROM metric('kills') a JOIN metric('it''s') b ON 1"
	st, gerr := AnalyzeMetricSQL(q, nil)
	if gerr != nil {
		t.Fatal(gerr.Message)
	}
	want := []MetricSQLRef{{Name: "kills", Pos: strings.Index(q, "'kills'")}, {Name: "it's", Pos: strings.Index(q, "'it''s'")}}
	if !reflect.DeepEqual(st.Refs, want) {
		t.Fatalf("refs = %+v, want %+v", st.Refs, want)
	}
	if len(st.Touched) != 0 {
		t.Fatalf("metric() refs add no touched table, got %v", st.Touched)
	}
}

// TestMetricGateCompilerRefAliases pins the one sanctioned stored-value
// read: the expression compiler's own join for a metric() it has already
// resolved, under the alias it names. Any other alias, and the same text
// without the alias set, refuses.
func TestMetricGateCompilerRefAliases(t *testing.T) {
	q := "SELECT * FROM player_stats INNER JOIN metric_values md0 ON md0.metric_id = ?"
	st, gerr := AnalyzeMetricSQL(q, map[string]bool{"md0": true})
	if gerr != nil {
		t.Fatalf("compiler ref join refused: %s", gerr.Message)
	}
	if !reflect.DeepEqual(st.Touched, []string{"player_stats"}) {
		t.Fatalf("touched = %v", st.Touched)
	}
	if _, gerr := AnalyzeMetricSQL(q, nil); gerr == nil {
		t.Fatal("a stored-value read without the compiler's alias passed")
	}
	if _, gerr := AnalyzeMetricSQL(q, map[string]bool{"md1": true}); gerr == nil {
		t.Fatal("a stored-value read under another alias passed")
	}
}

// TestMetricGateBinds pins bind collection: every marker is reported as
// written, and a marker inside a string literal, a quoted identifier or a
// comment is text, not a bind.
func TestMetricGateBinds(t *testing.T) {
	st, gerr := AnalyzeMetricSQL("SELECT * FROM players WHERE steam_id = :steam_id AND match_id = :match_id AND 1 = :round OR x = ? OR y = @n OR z = $m", nil)
	if gerr != nil {
		t.Fatal(gerr.Message)
	}
	want := []string{":steam_id", ":match_id", ":round", "?", "@n", "$m"}
	if !reflect.DeepEqual(st.Binds, want) {
		t.Fatalf("binds = %v, want %v", st.Binds, want)
	}
	st, gerr = AnalyzeMetricSQL("SELECT '?:x' AS a, \"?\" FROM players -- :round", nil)
	if gerr != nil {
		t.Fatal(gerr.Message)
	}
	if len(st.Binds) != 0 {
		t.Fatalf("text marked as binds: %v", st.Binds)
	}
}
