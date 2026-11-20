package metrics

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/ChristianWSmith/spectra/internal/store"
)

func lookupOf(names ...string) RefLookup {
	set := map[string]bool{}
	for _, n := range names {
		set[n] = true
	}
	return func(name string) (bool, error) { return set[name], nil }
}

// TestGateSQLRefusals pins the gate's refusal per rule over author SQL.
func TestGateSQLRefusals(t *testing.T) {
	cases := []struct{ name, q, want string }{
		{"multi-statement", "SELECT 1 FROM players; SELECT 1 FROM players", "single statement"},
		{"write verb", "UPDATE players SET name = ''", "update statements are not allowed"},
		{"create view", "CREATE VIEW v AS SELECT * FROM players", "create statements are not allowed"},
		{"ddl drop", "DROP TABLE players", "drop statements are not allowed"},
		{"table not on the allowlist", "SELECT * FROM players JOIN jobs ON 1", `metrics can't read "jobs"`},
		{"raw payload table", "SELECT * FROM generic_events", `metrics can't read "generic_events"`},
		{"sqlite table", "SELECT * FROM sqlite_master", `metrics can't read "sqlite_master"`},
		{"metric() to a missing metric", "SELECT * FROM metric('kills') k, metric('nope') n", `unknown metric reference "nope"`},
		{"positional bind", "SELECT * FROM players WHERE steam_id = ?", "bind ? isn't available"},
		{"unreserved named bind", "SELECT * FROM players WHERE steam_id = :who", "bind :who isn't available"},
		{"reserved bind not supplied", "SELECT * FROM players WHERE steam_id = :steam_id", "bind :steam_id isn't supplied"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, perr, err := GateSQL(c.q, lookupOf("kills"), nil)
			if err != nil {
				t.Fatal(err)
			}
			if perr == nil || !strings.Contains(perr.Message, c.want) {
				t.Fatalf("%q: got %v, want refusal %q", c.q, perr, c.want)
			}
		})
	}
	// The missing-reference refusal points at the quoted name.
	q := "SELECT * FROM metric('nope')"
	_, perr, _ := GateSQL(q, lookupOf(), nil)
	if perr == nil || perr.Pos != strings.Index(q, "'nope'") {
		t.Fatalf("missing-ref position: %+v", perr)
	}
}

// TestGateSQLAccepts pins the accepted shape: touched tables, refs, and the
// reserved binds the engine supplies.
func TestGateSQLAccepts(t *testing.T) {
	q := "WITH k AS (SELECT steam_id, kills FROM player_stats WHERE match_id = :match_id) SELECT k.steam_id, k.kills / m.value FROM k, metric('rounds_played') m, players p WHERE p.steam_id = k.steam_id"
	g, perr, err := GateSQL(q, lookupOf("rounds_played"), map[string]bool{":match_id": true})
	if err != nil || perr != nil {
		t.Fatalf("refused: %v %v", perr, err)
	}
	if !reflect.DeepEqual(g.Touched, []string{"player_stats", "players"}) {
		t.Fatalf("touched = %v", g.Touched)
	}
	if len(g.Refs) != 1 || g.Refs[0].Name != "rounds_played" {
		t.Fatalf("refs = %+v", g.Refs)
	}
	boom := errors.New("catalog down")
	if _, _, err := GateSQL("SELECT * FROM metric('x')", func(string) (bool, error) { return false, boom }, nil); !errors.Is(err, boom) {
		t.Fatalf("lookup failure not surfaced: %v", err)
	}
}

// TestGatePlanFailsClosed: a compiled statement the gate cannot resolve is
// an engine defect and refuses the plan — it is never saved with a short
// touched set.
func TestGatePlanFailsClosed(t *testing.T) {
	for _, sql := range []string{
		"SELECT * FROM jobs",
		"SELECT * FROM [players]",
		"SELECT * FROM generic_events g, rounds",
	} {
		p := Plan{SQL: sql}
		if perr := gatePlan(&p, nil); perr == nil {
			t.Errorf("gatePlan passed %q", sql)
		}
	}
	p := Plan{SQL: "SELECT * FROM rounds r JOIN metric_values md0 ON md0.metric_id = ?", Secondary: "SELECT 1 FROM players"}
	if perr := gatePlan(&p, map[string]string{"x": "md0"}); perr != nil {
		t.Fatalf("aliased ref join refused: %v", perr)
	}
	if !reflect.DeepEqual(p.Touched, []string{"players", "rounds"}) {
		t.Fatalf("touched = %v", p.Touched)
	}
}

// TestCompiledExpressionTouchedSet: a sugar expression's compiled plan
// carries the physical tables it reads — its sources, its denominator
// table and the humans-only lookup — and a metric() reference adds none.
func TestCompiledExpressionTouchedSet(t *testing.T) {
	addr := Address{Subject: "player"}
	p, perr := CompileRefs("from player_stats: sum(kills)", "", "", addr, nil)
	if perr != nil {
		t.Fatalf("compile: %v", perr)
	}
	if want := []string{"player_stats", "players"}; !reflect.DeepEqual(p.Touched, want) {
		t.Fatalf("touched = %v, want %v", p.Touched, want)
	}
	// Scope "" is the career statement: its rounds denominator counts the
	// subject's player_round_stats rows (03 §3 denominator rule), so that
	// table — not the rounds table — is what the statement reads.
	p, perr = CompileRefs("from player_stats: sum(kills)", "rounds", "", addr, nil)
	if perr != nil {
		t.Fatalf("compile: %v", perr)
	}
	if want := []string{"player_round_stats", "player_stats", "players"}; !reflect.DeepEqual(p.Touched, want) {
		t.Fatalf("career rounds-denominator touched = %v, want %v", p.Touched, want)
	}
}

// TestEveryBuiltinPassesTheGate: every builtin compiles through the gate at
// the library shape, and each derived touched set contains its sources.
func TestEveryBuiltinPassesTheGate(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	ms, err := st.ListMetrics()
	if err != nil {
		t.Fatal(err)
	}
	if len(ms) == 0 {
		t.Fatal("no builtins")
	}
	for _, m := range ms {
		spec, perr := Parse(m.Expr)
		if perr != nil {
			t.Fatalf("%s: %v", m.Name, perr)
		}
		refs := map[string]RefTarget{}
		for _, r := range MetricRefs(spec) {
			row, err := st.GetMetricByName(r.Name)
			if err != nil {
				t.Fatalf("%s: ref %s: %v", m.Name, r.Name, err)
			}
			refs[r.Name] = RefTarget{ID: row.ID, Scope: row.Scope, Subject: row.Subject, Version: row.Version}
		}
		addr := Address{Subject: m.Subject, Partition: m.Partition, Profile: m.Scope == "profile"}
		plan, perr := CompileRefs(m.Expr, m.Denominator, "", addr, refs)
		if perr != nil {
			t.Fatalf("%s: compile refused by the gate: %v", m.Name, perr)
		}
		if len(plan.Touched) == 0 {
			t.Errorf("%s: touched set not derived", m.Name)
		}
		for _, src := range spec.Sources {
			if !contains(plan.Touched, tableFor(src.Name)) {
				t.Errorf("%s: touched %v misses source table %s", m.Name, plan.Touched, tableFor(src.Name))
			}
		}
	}
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}
