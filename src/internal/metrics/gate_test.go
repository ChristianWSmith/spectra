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
		{"raw payload table", "SELECT * FROM saved_queries", `metrics can't read "saved_queries"`},
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

// TestEveryBuiltinPassesTheGate: every builtin passes the save gate, and
// each derived touched set is non-empty.
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
		g, perr, err := CheckRawSave(st, m.Expr)
		if err != nil {
			t.Fatalf("%s: %v", m.Name, err)
		}
		if perr != nil {
			t.Fatalf("%s: refused by the gate: %s", m.Name, perr.Message)
		}
		if len(g.Touched) == 0 {
			t.Errorf("%s: touched set not derived", m.Name)
		}
	}
}

// TestGateRefusesNonSelect: a statement that is not one SELECT or WITH is
// refused at the gate with the clear message, never parsed as anything else.
func TestGateRefusesNonSelect(t *testing.T) {
	for _, q := range []string{
		"from events: count()",
		"DELETE FROM players",
		"PRAGMA table_info(players)",
	} {
		_, perr, err := GateSQL(q, lookupOf(), nil)
		if err != nil {
			t.Fatalf("%q: %v", q, err)
		}
		if perr == nil {
			t.Errorf("%q: accepted, want refused", q)
		}
	}
	_, perr, _ := GateSQL("from events: count()", lookupOf(), nil)
	if perr == nil || !strings.Contains(perr.Message, "SELECT or WITH") {
		t.Errorf("sugar text refusal = %+v, want the SELECT or WITH message", perr)
	}
}
