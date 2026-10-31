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
		{"all denominators", "from rounds: count()", "", "matches", "", ModePlain},
		{"player_rounds denom", "from player_round_stats: avg(kast)", "", "player_rounds", "", ModePlain},
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
