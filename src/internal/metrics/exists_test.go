package metrics

import (
	"math"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ChristianWSmith/spectra/internal/models"
	"github.com/ChristianWSmith/spectra/internal/store"
)

// ---- me2: the EXISTS condition construct (plan §6.2 / D4 / D7) ----

// TestExistsMatrix is THE me2 accept/reject matrix — the condition-
// position contract pinned mechanically (sibling of
// TestScalarMinMaxMatrix): EXISTS may appear exactly where a condition
// may appear (count()'s argument, a where filter), never in a value
// position; its condition reads the INNER candidate row through bare
// columns and the row being tested through outer.<column>; nesting,
// non-whitelisted columns (either side), a qualifier naming the
// expression's own source, metric() and the arity edges each fail with
// their OWN positioned message. A regression that quietly widens any of
// those boundaries fails here.
func TestExistsMatrix(t *testing.T) {
	accept := []struct{ name, expr string }{
		// The N2 shape: damage rows whose kill is on the same tick,
		// attacker and victim (analytics.go GetCombatStats' correlated
		// split, spelled in the grammar).
		{"n2 kill-conversion condition",
			"from events: count(where kind = 'damage' and exists(kind = 'kill' and tick = outer.tick and attacker = outer.attacker and victim = outer.victim))"},
		// NOT EXISTS — the damage-without-kill half.
		{"not exists",
			"from events: sum(where kind = 'damage' and not exists(kind = 'kill' and tick = outer.tick and attacker = outer.attacker and victim = outer.victim), dmg)"},
		// count() takes a condition, so exists() is legal without a
		// where prefix too.
		{"count argument position", "from events: count(exists(kind = 'kill'))"},
		// The optional where prefix mirrors count()'s filter form.
		{"where prefix inside exists", "from events: count(where exists(where kind = 'kill'))"},
		{"grouping inside exists",
			"from events: count(where exists((kind = 'kill' or headshot) and tick = outer.tick))"},
		{"outer on the left of a comparison",
			"from events: count(where exists(outer.tick > 0 and kind = 'kill'))"},
		{"case-insensitive keywords",
			"from events: count(where EXISTS(kind = 'kill' and tick = OUTER.tick))"},
		// A joined expression: the inner scan is the PRIMARY's table
		// (bare columns), outer.<column> resolves through the outer
		// row's owners (tick is events-only here).
		{"joined statement",
			"from events, player_round_stats: count(where exists(kind = 'kill' and tick = outer.tick))"},
		// The where-filter prefix of every filtering op routes through
		// the same condition grammar (percentile's phase-2 fetch
		// included).
		{"percentile filter",
			"from events: percentile(where kind = 'damage' and exists(kind = 'kill'), 0.5, dmg)"},
		// M3's full kill-conversion ratio, compile shape only.
		{"kill conversion ratio",
			"from events: ratio(sum(where kind = 'damage' and exists(kind = 'kill' and tick = outer.tick and attacker = outer.attacker and victim = outer.victim), dmg), sum(where kind = 'damage', dmg))"},
	}
	for _, c := range accept {
		t.Run("accept "+c.name, func(t *testing.T) {
			if perr := Validate(c.expr); perr != nil {
				t.Fatalf("Validate(%q): %v", c.expr, perr)
			}
			for _, scope := range []string{"", "match:3"} {
				if _, perr := Compile(c.expr, "", scope); perr != nil {
					t.Fatalf("Compile(%q, scope %q): %v", c.expr, scope, perr)
				}
			}
		})
	}
	reject := []struct{ name, expr, want string }{
		// Condition position ONLY (plan §6.2): never an aggregation
		// operand, at any of the value positions the grammar has.
		{"top-level aggregation", "from events: exists(kind = 'kill')",
			"is a condition, not a value"},
		{"ratio operand", "from events: ratio(exists(kind = 'kill'), count())",
			"is a condition, not a value"},
		{"sum column argument", "from events: sum(exists(kind = 'kill'))",
			"is a condition, not a value"},
		{"scalar min/max term", "from events: max(sum(dmg), exists(kind = 'kill'))",
			"is a condition, not a value"},
		{"additive chain term", "from events: sum(dmg + exists(kind = 'kill'))",
			"is a condition, not a value"},
		// Arity: exactly one condition.
		{"empty argument list", "from events: count(where exists())",
			"takes a condition"},
		{"second argument", "from events: count(where exists(kind = 'kill', headshot))",
			"takes exactly one condition"},
		// Nesting restriction: one level of subquery, ever.
		{"nested exists",
			"from events: count(where exists(kind = 'kill' and exists(headshot)))",
			"cannot be nested inside exists()"},
		{"nested exists behind not",
			"from events: count(where exists(not exists(headshot)))",
			"cannot be nested inside exists()"},
		// Non-whitelisted columns, each side with its own resolution:
		// the inner scan is the PRIMARY's table, the outer reference
		// resolves through the statement's owners.
		{"inner unknown column", "from events: count(where exists(nope = 1))",
			`unknown column "nope" for source events`},
		{"outer unknown column",
			"from events: count(where exists(kind = 'kill' and tick = outer.nope))",
			`unknown column "nope"`},
		// A qualifier naming the expression's own source is a
		// self-reference: the subquery already scans it, so the name
		// cannot disambiguate a row — outer.<column> is the one
		// spelling for the row being tested.
		{"self-reference to the lead's own alias",
			"from events: count(where exists(kind = 'kill' and tick = events.tick))",
			`cannot reference "events" inside exists()`},
		{"qualifier naming another source",
			"from events: count(where exists(kind = 'kill' and tick = rounds.tick))",
			`unknown qualifier "rounds" inside exists()`},
		// outer is a contextual keyword of the construct: it needs the
		// column form inside, and is refused as a keyword outside.
		{"outer without a column", "from events: count(where exists(tick = outer))",
			`expected a column after "outer."`},
		{"outer outside exists", "from events: count(where outer.tick = 1)",
			`got keyword "outer"`},
		// exists() must be called with a condition.
		{"exists without an argument list", "from events: count(where exists = 1)",
			`expected "(" after "exists"`},
		// metric() keeps its condition-position denial inside exists.
		{"metric() inside exists", "from events: count(where exists(metric('x') = 1))",
			"cannot appear in a condition or filter"},
		// exists is a contextual keyword everywhere else.
		{"exists as a source name", "from exists: count()",
			"got keyword \"exists\""},
	}
	for _, c := range reject {
		t.Run("reject "+c.name, func(t *testing.T) {
			// A compile-level rejection counts too — Validate runs
			// Compile.
			perr := Validate(c.expr)
			if perr == nil {
				if _, cerr := Compile(c.expr, "", ""); cerr == nil {
					t.Fatalf("Compile(%q) unexpectedly accepted", c.expr)
				} else {
					perr = cerr
				}
			}
			if !strings.Contains(perr.Message, c.want) {
				t.Errorf("message = %q, want substring %q", perr.Message, c.want)
			}
			if perr.Pos <= 0 {
				t.Errorf("Pos = %d, want a positioned error", perr.Pos)
			}
		})
	}
}

// TestExistsRespectsConditionDepth pins the plan's "bounded (row cap +
// depth limits as today)": exists() counts toward maxCondDepth exactly
// like a parenthesized group, so the 64-level ceiling still fires — with
// the same message, at a position inside the construct.
func TestExistsRespectsConditionDepth(t *testing.T) {
	expr := "from events: count(where exists(" +
		strings.Repeat("(", 70) + "kind = 'kill'" + strings.Repeat(")", 70) + "))"
	perr := Validate(expr)
	if perr == nil {
		t.Fatalf("Validate(%q) unexpectedly accepted", expr)
	}
	if !strings.Contains(perr.Message, "condition nesting too deep") {
		t.Errorf("message = %q, want substring %q", perr.Message, "condition nesting too deep")
	}
	if perr.Pos <= 0 {
		t.Errorf("Pos = %d, want a positioned error", perr.Pos)
	}
}

// TestExistsEmissionAndBinds pins the compiled shape (the load-bearing
// SQLite claims) and parameterization:
//
//   - the inner scan is ALIASED (x0) so an outer reference can never
//     resolve to it — the emitDenom rule for a subquery over the same
//     table the outer query reads;
//   - the engine correlates the inner scan on the row's match
//     (x0.match_id = <primary>.match_id) with NO user text — a
//     match-scoped predicate can never bleed across matches;
//   - bare inner columns emit x0-qualified (a joined statement's
//     res.qualify would otherwise bind them to the OUTER row);
//   - outer.<column> always emits owner-qualified;
//   - every literal binds as ? in strict textual order — none reaches
//     the statement text.
func TestExistsEmissionAndBinds(t *testing.T) {
	plan, perr := Compile(
		"from events: count(where kind = 'damage' and exists(kind = 'kill' and tick = outer.tick and dmg > 42))",
		"", "match:7")
	if perr != nil {
		t.Fatalf("compile: %v", perr)
	}
	fragments := []string{
		"EXISTS (SELECT 1 FROM events AS x0 WHERE x0.match_id = events.match_id AND",
		"x0.kind = ?",
		"x0.tick = events.tick",
		"x0.dmg > ?",
	}
	for _, f := range fragments {
		if !strings.Contains(plan.SQL, f) {
			t.Errorf("SQL missing %q:\n%s", f, plan.SQL)
		}
	}
	for _, lit := range []string{"'kill'", "'damage'", "42"} {
		if strings.Contains(plan.SQL, lit) {
			t.Errorf("SQL leaks the literal %s: %s", lit, plan.SQL)
		}
	}
	want := []any{"damage", "kill", float64(42), int64(7)}
	if !reflect.DeepEqual(plan.Args, want) {
		t.Errorf("args = %v, want %v (outer filter, inner filter, inner literal, scope id — textual order)", plan.Args, want)
	}
}

// existsFixture stores two matches over alice/bob:
//
//	match 1: seq0 damage a→b t100 d40 · seq1 kill a→b t100   → converted
//	         seq2 damage a→b t200 d30                        → no kill at t200
//	         seq3 damage a→b t300 d20 · seq4 kill b→a t300   → different actor pair
//	         seq5 damage a→b t400 d10 · seq6 kill a→b t401   → different tick
//	match 2: seq0 damage a→b t100 d50                        → same tick as match 1's
//	                                                          kill, but NO kill in
//	                                                          match 2 — the match
//	                                                          correlation pin
func existsFixture(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "exists.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	type ev struct {
		seq              int
		tick             int
		kind             string
		attacker, victim string
		dmg              int
	}
	match1 := []ev{
		{0, 100, "damage", aliceID, bobID, 40},
		{1, 100, "kill", aliceID, bobID, 0},
		{2, 200, "damage", aliceID, bobID, 30},
		{3, 300, "damage", aliceID, bobID, 20},
		{4, 300, "kill", bobID, aliceID, 0},
		{5, 400, "damage", aliceID, bobID, 10},
		{6, 401, "kill", aliceID, bobID, 0},
	}
	match2 := []ev{
		{0, 100, "damage", aliceID, bobID, 50},
	}
	for m, events := range [][]ev{match1, match2} {
		n := m + 1
		id, err := st.CreateMatchRow("/d/ex"+string(rune('0'+n))+".dem", "sha-ex"+string(rune('0'+n)), 1)
		if err != nil {
			t.Fatalf("CreateMatchRow: %v", err)
		}
		em := &models.ExtractedMatch{
			Match: models.Match{
				Path: "/d/ex" + string(rune('0'+n)) + ".dem", SHA256: "sha-ex" + string(rune('0'+n)),
				Map: "de_dust2", TickRate: 64, ExtractedAt: time.Now(),
			},
			Players: []models.Player{
				{SteamID: aliceID, Name: "alice", Side: "ct"},
				{SteamID: bobID, Name: "bob", Side: "t"},
			},
			PlayerStats: []models.PlayerStats{
				{SteamID: aliceID, Name: "alice", Side: "ct", RoundsPlayed: 1},
				{SteamID: bobID, Name: "bob", Side: "t", RoundsPlayed: 1},
			},
		}
		for _, e := range events {
			em.Events = append(em.Events, models.Event{
				Seq: e.seq, Tick: e.tick, Round: 1, Kind: e.kind,
				Attacker: e.attacker, Victim: e.victim, Weapon: "ak47", Dmg: e.dmg,
			})
		}
		if err := st.SaveExtracted(id, em); err != nil {
			t.Fatalf("SaveExtracted: %v", err)
		}
	}
	return st
}

// aliceRow finds alice's preview row (Group is the subject key).
func aliceRow(t *testing.T, pv Preview) PreviewRow {
	t.Helper()
	for _, r := range pv.Rows {
		if r.Group == aliceID {
			return r
		}
	}
	t.Fatalf("no alice row in %+v", pv.Rows)
	return PreviewRow{}
}

func mustExistsPreview(t *testing.T, st *store.Store, expr, scope string) Preview {
	t.Helper()
	pv, perr, err := RunPreview(st, Def{Expr: expr}, scope, 50)
	if perr != nil {
		t.Fatalf("RunPreview(%q): %v", expr, perr)
	}
	if err != nil {
		t.Fatalf("RunPreview(%q): %v", expr, err)
	}
	return pv
}

func approx(t *testing.T, got, want float64, what string) {
	t.Helper()
	if math.Abs(got-want) > 1e-9 {
		t.Errorf("%s = %v, want %v", what, got, want)
	}
}

// TestExistsCorrelatesTheMatchingRow is THE semantic pin for the
// construct: the N2 split executed on a real store, hand-computed from
// existsFixture. It proves the three correlation rules at once —
// same-tick+actor-pair conversion (40 of alice's 150 damage converts;
// the b→a kill on the same tick and the a→b kill on the next tick do
// NOT), NOT EXISTS carries the complement (110), and the engine's match
// correlation stops match 1's tick-100 kill from converting match 2's
// tick-100 damage (match:2 converts 0 — the cross-match bleed the
// uncorrelated subquery would allow).
func TestExistsCorrelatesTheMatchingRow(t *testing.T) {
	st := existsFixture(t)
	const inner = "kind = 'kill' and tick = outer.tick and attacker = outer.attacker and victim = outer.victim"
	converted := "from events: sum(where kind = 'damage' and exists(" + inner + "), dmg)"
	unconverted := "from events: sum(where kind = 'damage' and not exists(" + inner + "), dmg)"
	ratio := "from events: ratio(sum(where kind = 'damage' and exists(" + inner + "), dmg), sum(where kind = 'damage', dmg))"

	cases := []struct {
		name, scope, expr string
		want              float64
		wantN             int
	}{
		{"library converted", "", converted, 40, 7},
		{"library unconverted", "", unconverted, 110, 7},
		{"library conversion ratio", "", ratio, 40.0 / 150.0, 7},
		{"match 1 converted", "match:1", converted, 40, 6},
		{"match 1 unconverted", "match:1", unconverted, 60, 6},
		{"match 1 ratio", "match:1", ratio, 0.4, 6},
		// The cross-match bleed pin: match 1 has a kill a→b at tick
		// 100; match 2's damage at tick 100 must NOT convert.
		{"match 2 converted", "match:2", converted, 0, 1},
		{"match 2 unconverted", "match:2", unconverted, 50, 1},
		{"match 2 ratio", "match:2", ratio, 0, 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			row := aliceRow(t, mustExistsPreview(t, st, c.expr, c.scope))
			approx(t, row.Value, c.want, "value")
			if row.N != c.wantN {
				t.Errorf("N = %d, want %d (source rows behind the aggregate)", row.N, c.wantN)
			}
		})
	}
}
