package metrics

import (
	"strings"
	"testing"
)

// The frozen v1 grammar in positive form — every example must parse and
// compile (whitelist + group rules) without error.
func TestParseAndCompileValid(t *testing.T) {
	// The task's canonical multi-aggregation example (doc.go header).
	const canonical = "from events: count() , sum(dmg) , avg(distance) , " +
		"ratio(count(headshot), count()) , stddev(dmg) , percentile(0.95, dmg) , " +
		"min(tick), max(tick)"
	cases := []struct {
		name, expr, groupBy, denom, scope string
		mode                              PlanMode
	}{
		{"canonical multi-agg", canonical, "", "", "", ModePlain},
		{"filter count", "from events: count(where kind='kill' and headshot)", "", "", "", ModePlain},
		{"implicit truthiness", "from events: count(headshot)", "", "", "", ModePlain},
		{"sum with filter", "from player_stats: sum(where side='ct', total_damage)", "", "", "", ModePlain},
		{"avg grouped", "from rounds: avg(duration_s)", "round", "", "", ModeGrouped},
		{"stddev grouped", "from player_round_stats: stddev(dmg)", "player", "", "", ModeGrouped},
		{"percentile", "from events: percentile(0.95, dmg)", "", "", "", ModePercentile},
		{"median sugar", "from events: median(dmg)", "", "", "", ModePercentile},
		{"percentile with filter", "from events: percentile(where kind='damage', 0.5, dmg)", "", "", "", ModePercentile},
		{"percentile first of many", "from events: percentile(0.5, dmg), avg(dmg), count()", "", "", "", ModePercentile},
		{"ratio nested filter", "from engagements: ratio(count(where kind='trade'), count(where kind='opening'))", "", "", "", ModePlain},
		{"denominator rate", "from player_round_stats: count(where deaths=1 and traded=0)", "player", "rounds", "", ModeGrouped},
		{"matches denom", "from rounds: count()", "", "matches", "", ModePlain},
		{"rounds denom on player_round_stats", "from player_round_stats: avg(kast)", "", "rounds", "", ModePlain},
		{"map group", "from events: count()", "map", "", "", ModeGrouped},
		{"match scope", "from events: count()", "", "", "match:3", ModePlain},
		{"team group", "from player_stats: avg(adr)", "team", "", "", ModeGrouped},
		{"side group", "from round_economy: sum(equip_value)", "side", "", "", ModeGrouped},
		{"weapon group", "from events: count()", "weapon", "", "", ModeGrouped},
		{"none group token", "from events: count()", "none", "", "", ModePlain},
		{"operator set", "from events: count(where dmg >= 50 and dmg < 100 or not headshot)", "", "", "", ModePlain},
		{"not-equal + parens", "from rounds: count(where not (winner != 'ct'))", "", "", "", ModePlain},
		{"bool literals", "from events: count(where headshot = true)", "", "", "", ModePlain},
		{"negative number", "from events: count(where dmg > -1)", "", "", "", ModePlain},
		{"alias", "from events: count() AS total", "", "", "", ModePlain},
		{"semicolon-free provenance", "from events: count()", "", "", "", ModePlain},
		// Plugin manifest exprs (internal/plugin coordination contract).
		{"plugin plug_count", "from events: count()", "none", "", "", ModePlain},
		{"plugin plug_dmg", "from events: sum(dmg)", "player", "", "", ModeGrouped},
		// Multi-source joins (owner design (c)) — engine-derived ON.
		{"joined acceptance ratio", "from player_stats, match_trade_opps: ratio(sum(trade_kills), sum(opps))", "player", "", "", ModeGrouped},
		{"n:1 join", "from engagements, rounds: count()", "", "", "", ModePlain},
		{"n:1 join grouped", "from engagements, rounds: count()", "round", "", "", ModeGrouped},
		{"join with secondary condition", "from engagements, rounds: count(where winner='ct')", "", "", "", ModePlain},
		{"percentile over join (day one)", "from player_stats, match_trade_opps: percentile(0.5, opps)", "", "", "", ModePercentile},
		{"join + scope", "from player_stats, match_trade_opps: count()", "player", "", "match:3", ModeGrouped},
		{"join + denominator", "from player_stats, match_trade_opps: sum(trade_kills)", "player", "rounds", "", ModeGrouped},
		{"reversed 1:1 pair (secondary value column allowed)", "from match_trade_opps, player_stats: sum(kills)", "", "", "", ModePlain},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			plan, perr := Compile(c.expr, c.groupBy, c.denom, c.scope)
			if perr != nil {
				t.Fatalf("Compile(%q): %v", c.expr, perr)
			}
			if plan.Mode != c.mode {
				t.Errorf("mode = %v, want %v (sql: %s)", plan.Mode, c.mode, plan.SQL)
			}
			if strings.Contains(plan.SQL, ";") {
				t.Errorf("compiled SQL must be one statement: %s", plan.SQL)
			}
		})
	}
}

// Negative cases: every failure must be a positioned *ParseError (the
// ExprError contract) and must never reach execution.
func TestParseAndCompileInvalid(t *testing.T) {
	cases := []struct {
		name, expr, groupBy, denom, scope string
		wantMsg                           string
		wantPos                           bool // expect Pos > 0
	}{
		{"empty", "", "", "", "", "empty expression", false},
		{"missing from", "count()", "", "", "", "expected \"from <table>:\"", false},
		{"unknown source", "from sqlite_master: count()", "", "", "", "unknown source table", true},
		{"no colon", "from events count()", "", "", "", "expected \":\"", true},
		{"unknown op", "from events: mode(dmg)", "", "", "", "unknown aggregation", true},
		{"unknown column", "from events: sum(nope)", "", "", "", "unknown column", true},
		{"unknown cond column", "from rounds: count(where nope = 1)", "", "", "", "unknown column", true},
		{"cross-source column", "from rounds: count(where dmg > 0)", "", "", "", "unknown column", true},
		{"unknown group", "from events: count()", "banana", "", "", "unknown groupBy", false},
		{"unmapped group", "from round_economy: count()", "player", "", "", "not supported for source", false},
		{"unmapped team on events", "from events: count()", "team", "", "", "not supported for source", false},
		{"percentile grouped", "from events: percentile(0.5, dmg)", "player", "", "", "requires groupBy", true},
		{"median grouped", "from events: median(dmg)", "round", "", "", "requires groupBy", true},
		{"bad percentile p", "from events: percentile(1.5, dmg)", "", "", "", "must be in [0,1]", true},
		{"bad denominator", "from rounds: count()", "", "roundss", "", "unknown denominator", false},
		{"nested ratio", "from events: ratio(ratio(count(), count()), count())", "", "", "", "cannot be nested", true},
		{"nested percentile in ratio", "from events: ratio(percentile(0.5, dmg), count())", "", "", "", "cannot be nested", true},
		{"bad scope", "from events: count()", "", "", "match:abc", "invalid scope", false},
		{"bad scope prefix", "from events: count()", "", "", "match=3", "invalid scope", false},
		{"unterminated string", "from events: count(where kind='kill)", "", "", "", "unterminated string", true},
		{"missing comma", "from events: count() count()", "", "", "", "expected \",\"", true},
		{"keyword as column", "from events: sum(and)", "", "", "", "keyword", true},
		{"dangling operator", "from events: count(where dmg >)", "", "", "", "expected a column or literal", true},
		{"empty agg list", "from events:", "", "", "", "expected aggregation", true},
		{"ratio missing arg", "from events: ratio(count())", "", "", "", "expected \",\"", true},
		// Multi-source joins — malformed lists, key criterion, ambiguity,
		// value-column rule (owner design (c)).
		{"unknown second source", "from events, sqlite_master: count()", "", "", "", "unknown source table", true},
		{"duplicate source", "from events, events: count()", "", "", "", "duplicate source", true},
		{"missing source after comma", "from events, : count()", "", "", "", "expected source table name", true},
		{"ambiguous column across sources", "from player_stats, match_trade_opps: sum(match_id)", "", "", "", "ambiguous column", true},
		{"group token not on primary", "from player_stats, match_trade_opps: count()", "round", "", "", "not supported for source player_stats", false},
		{"non-unique secondary", "from rounds, events: count()", "", "", "", "not unique", true},
		{"secondary value column under n:1", "from engagements, rounds: sum(duration_s)", "", "", "", "not 1:1", true},
		{"retired player_rounds denominator", "from rounds: count()", "", "player_rounds", "", "valid: rounds, matches", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, perr := Compile(c.expr, c.groupBy, c.denom, c.scope)
			if perr == nil {
				t.Fatalf("Compile(%q) succeeded, want error containing %q", c.expr, c.wantMsg)
			}
			if !strings.Contains(perr.Message, c.wantMsg) {
				t.Errorf("message = %q, want substring %q", perr.Message, c.wantMsg)
			}
			if c.wantPos && perr.Pos <= 0 {
				t.Errorf("Pos = %d, want > 0", perr.Pos)
			}
		})
	}
}

// Validate mirrors Compile's checks without producing a plan (builder
// live-check path).
func TestValidate(t *testing.T) {
	if perr := Validate("from events: count()", "player"); perr != nil {
		t.Fatalf("valid expr rejected: %v", perr)
	}
	perr := Validate("from events: sum(dmg)", "map")
	// map IS valid for events — the failure must come from something else.
	if perr != nil {
		t.Fatalf("groupBy=map on events unexpectedly rejected: %v", perr)
	}
	perr = Validate("from events: sum(whatever)", "")
	if perr == nil {
		t.Fatal("unknown column accepted by Validate")
	}
}

// Scope parsing boundaries.
func TestParseScope(t *testing.T) {
	if id, perr := ParseScope(""); perr != nil || id != 0 {
		t.Errorf("empty scope → (%d, %v), want (0, nil)", id, perr)
	}
	if id, perr := ParseScope("match:42"); perr != nil || id != 42 {
		t.Errorf("match:42 → (%d, %v), want (42, nil)", id, perr)
	}
	for _, bad := range []string{"match:0", "match:-1", "match:", "x:1", "42"} {
		if _, perr := ParseScope(bad); perr == nil {
			t.Errorf("ParseScope(%q) accepted", bad)
		}
	}
}

// Compiled SQL is fully parameterized: no string/number literal from the
// expression survives into the statement text (identifiers come only from
// the whitelists).
func TestCompiledSQLIsParameterized(t *testing.T) {
	plan, perr := Compile("from events: count(where kind='kill' and dmg >= 50)", "", "", "match:7")
	if perr != nil {
		t.Fatalf("compile: %v", perr)
	}
	for _, forbidden := range []string{"'kill'", "50", "7"} {
		if strings.Contains(plan.SQL, forbidden) {
			t.Errorf("SQL leaks literal %q: %s", forbidden, plan.SQL)
		}
	}
	if len(plan.Args) != 3 { // 'kill', 50, match id
		t.Errorf("args = %v, want 3 binds", plan.Args)
	}
	if plan.Args[0] != "kill" || plan.Args[1] != float64(50) || plan.Args[2] != int64(7) {
		t.Errorf("args = %v, want [kill 50 7]", plan.Args)
	}
}

// TestJoinedSQLIsParameterized extends the parameterization/injection
// property to joined plans: no literal from the expression survives into
// the statement text, binds keep textual order (condition literals
// before the scope id — joins contribute no binds), there is no
// statement separator, and only the expression's own whitelisted tables
// appear in the FROM/JOIN positions.
func TestJoinedSQLIsParameterized(t *testing.T) {
	const expr = "from player_stats, match_trade_opps: count(where kills > 5 and opps >= 10)"
	plan, perr := Compile(expr, "", "", "match:7")
	if perr != nil {
		t.Fatalf("compile: %v", perr)
	}
	for _, forbidden := range []string{"5", "10", "7", "'", ";"} {
		if strings.Contains(plan.SQL, forbidden) {
			t.Errorf("SQL leaks %q: %s", forbidden, plan.SQL)
		}
	}
	if len(plan.Args) != 3 { // kills > 5, opps >= 10, match id (textual order)
		t.Errorf("args = %v, want 3 binds", plan.Args)
	}
	if plan.Args[0] != float64(5) || plan.Args[1] != float64(10) || plan.Args[2] != int64(7) {
		t.Errorf("args = %v, want [5 10 7]", plan.Args)
	}
	// The engine-chosen shape: primary first, LEFT JOIN secondary on the
	// derived key, scope bound on the primary.
	wantJoin := "FROM player_stats LEFT JOIN match_trade_opps ON " +
		"player_stats.match_id = match_trade_opps.match_id AND " +
		"player_stats.steam_id = match_trade_opps.steam_id"
	if !strings.Contains(plan.SQL, wantJoin) {
		t.Errorf("SQL missing join shape %q:\n%s", wantJoin, plan.SQL)
	}
	if !strings.Contains(plan.SQL, "WHERE player_stats.match_id = ?") {
		t.Errorf("scope not bound on the primary:\n%s", plan.SQL)
	}
	// Only whitelisted tables in FROM/JOIN positions: every other known
	// source must not appear anywhere in the statement.
	for _, src := range sources {
		if src == "player_stats" || src == "match_trade_opps" {
			continue
		}
		if strings.Contains(plan.SQL, src) {
			t.Errorf("SQL mentions non-source table %q: %s", src, plan.SQL)
		}
	}
}
