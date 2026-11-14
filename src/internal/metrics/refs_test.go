package metrics

import (
	"reflect"
	"strings"
	"testing"
)

// W2b — metric() reference syntax (design §2): the two legal positions,
// the three denied positions (exact copy + position), the extraction
// walk, the ref→metric_values join shape, the cycle walk and the rename
// splice.

// refTargets is a resolution map covering every name the tests below
// reference: "a" match-grain, "b" profile-grain.
func refTargets() map[string]RefTarget {
	return map[string]RefTarget{
		"a": {ID: 7, Scope: "match", Version: 3, RuleVersion: 5},
		"b": {ID: 9, Scope: "profile", Version: 1, RuleVersion: 5},
	}
}

// TestRefLegalPositions pins the ref's TWO legal positions (design §2):
// a top-level aggregation in the agg list, and a ratio() numerator or
// denominator operand — both compile (through CompileRefs, which is what
// carries the resolution) into a subject-grouped plan.
func TestRefLegalPositions(t *testing.T) {
	cases := []struct {
		name, expr string
		mode       PlanMode
	}{
		{"top-level agg", "from events: metric('a')", ModeGrouped},
		{"top-level among others", "from events: count(), metric('a')", ModeGrouped},
		{"ratio numerator", "from events: ratio(metric('a'), count())", ModeGrouped},
		{"ratio denominator", "from events: ratio(count(), metric('a'))", ModeGrouped},
		{"ratio both operands", "from events: ratio(metric('a'), metric('b'))", ModeGrouped},
		{"ref as the only value column", "from player_stats: metric('a')", ModeGrouped},
		{"joined sources + ref", "from player_stats, match_trade_opps: ratio(sum(opps), metric('b'))", ModeGrouped},
		{"percentile first, ref second", "from events: percentile(0.5, dmg), metric('a')", ModePercentile},
		{"ref first, percentile second", "from events: metric('a'), percentile(0.5, dmg)", ModeGrouped},
		{"aliased ref", "from events: metric('a') AS ref", ModeGrouped},
		{"scoped ref", "from events: metric('a')", ModeGrouped},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			plan, perr := CompileRefs(c.expr, "", "match:7", refTargets())
			if perr != nil {
				t.Fatalf("CompileRefs(%q): %v", c.expr, perr)
			}
			if !strings.Contains(plan.SQL, "INNER JOIN metric_values") {
				t.Errorf("plan carries no ref join:\n%s", plan.SQL)
			}
			if plan.Mode != c.mode {
				t.Errorf("mode = %v, want %v", plan.Mode, c.mode)
			}
		})
	}
}

// TestRefDeniedPositions pins each denied position's EXACT copy and its
// byte position (the ExprError contract): inside a value aggregation
// (named per op as written — median reports as median), inside a
// condition/filter, and nested inside metric(). Criterion: a ref may
// appear only where a computed value may appear.
func TestRefDeniedPositions(t *testing.T) {
	const (
		inside = "metric() is a value reference — it cannot appear inside %s()"
		inCond = "metric() is a value reference — it cannot appear in a condition or filter (they are row-level predicates over source columns)"
		nested = "metric() cannot be nested inside metric()"
	)
	cases := []struct {
		name, expr, needle, want string
		delta                    int
	}{
		// Denied inside every value aggregation (the op as WRITTEN).
		{"sum", "from events: sum(metric('a'))", "metric('a')", "metric() is a value reference — it cannot appear inside sum()", 0},
		{"avg", "from events: avg(metric('a'))", "metric('a')", "metric() is a value reference — it cannot appear inside avg()", 0},
		{"min", "from events: min(metric('a'))", "metric('a')", "metric() is a value reference — it cannot appear inside min()", 0},
		{"max", "from events: max(metric('a'))", "metric('a')", "metric() is a value reference — it cannot appear inside max()", 0},
		{"stddev", "from events: stddev(metric('a'))", "metric('a')", "metric() is a value reference — it cannot appear inside stddev()", 0},
		{"percentile", "from events: percentile(0.5, metric('a'))", "metric('a')", "metric() is a value reference — it cannot appear inside percentile()", 0},
		{"median (as written)", "from events: median(metric('a'))", "metric('a')", "metric() is a value reference — it cannot appear inside median()", 0},
		{"column-form arg", "from events: sum(metric)", "sum(metric)", "metric() is a value reference — it cannot appear inside sum()", len("sum(")},
		// The `where <cond>,` filter prefix parses BEFORE the value
		// column — a filter IS a condition, so this is the condition
		// denial, not the sum() one.
		{"filtered aggregation", "from events: sum(where metric('a'), dmg)", "metric('a')", inCond, 0},
		// Denied in conditions/filters.
		{"filter form", "from events: count(where metric('a'))", "metric('a')", inCond, 0},
		{"truthy operand", "from events: count(metric('a'))", "metric('a')", inCond, 0},
		{"comparison rhs", "from events: count(where dmg > metric('a'))", "metric('a')", inCond, 0},
		{"chained predicate", "from events: count(where dmg > 0 and metric('a'))", "metric('a')", inCond, 0},
		{"bare ident in condition", "from events: count(where metric)", "count(where metric)", inCond, len("count(where ")},
		// Denied nested in metric().
		{"nested ref", "from events: metric(metric('a'))", "metric('a')", nested, 0},
		{"nested ref in ratio", "from events: ratio(metric(metric('a')), count())", "metric('a')", nested, 0},
		// Lexical rejections on the ref's own argument.
		{"empty name", "from events: metric('')", "metric('')", "metric() reference name is empty", len("metric(")},
		{"non-string argument", "from events: metric(dmg)", "metric(dmg)", `expected a metric name string in metric(...) (got "dmg")`, len("metric(")},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, perr := Compile(c.expr, "", "")
			if perr == nil {
				t.Fatalf("Compile(%q) succeeded, want %q", c.expr, c.want)
			}
			if perr.Message != c.want {
				t.Errorf("message =\n%s\nwant\n%s", perr.Message, c.want)
			}
			wantPos := strings.Index(c.expr, c.needle) + c.delta
			if wantPos < 0 {
				t.Fatalf("test bug: needle %q not in %q", c.needle, c.expr)
			}
			if perr.Pos != wantPos {
				t.Errorf("Pos = %d, want %d (the offending token)", perr.Pos, wantPos)
			}
		})
	}
}

// TestMetricRefsExtraction pins the pure walk (design §2): every ref's
// name + literal span, in textual order, over both legal positions —
// spans are what the rename splice rewrites, so an off-by-one here
// would corrupt stored expressions.
func TestMetricRefsExtraction(t *testing.T) {
	const expr = "from events: count(where kind='kill'), ratio(metric('first'), count()), metric('second'), metric('first')"
	spec, perr := Parse(expr)
	if perr != nil {
		t.Fatalf("Parse: %v", perr)
	}
	refs := MetricRefs(spec)
	want := []MetricRef{
		{Name: "first", Pos: strings.Index(expr, "'first'"), End: strings.Index(expr, "'first'") + len("'first'")},
		{Name: "second", Pos: strings.Index(expr, "'second'"), End: strings.Index(expr, "'second'") + len("'second'")},
		{Name: "first", Pos: strings.LastIndex(expr, "'first'"), End: strings.LastIndex(expr, "'first'") + len("'first'")},
	}
	if !reflect.DeepEqual(refs, want) {
		t.Errorf("MetricRefs = %+v, want %+v", refs, want)
	}
	// The span must be the LITERAL exactly: splicing it must leave the
	// surrounding source untouched.
	for _, r := range refs {
		if got := expr[r.Pos:r.End]; got != "'"+r.Name+"'" {
			t.Errorf("span [%d:%d] = %q, want the quoted name", r.Pos, r.End, got)
		}
	}
	// Duplicates survive the walk (two refs, two spans); the edge list is
	// a SET, so DistinctNames dedupes in first-appearance order.
	if got := DistinctNames(refs); !reflect.DeepEqual(got, []string{"first", "second"}) {
		t.Errorf("DistinctNames = %v, want [first second]", got)
	}
	// Ref-free expressions extract nothing.
	plain, perr := Parse("from events: count()")
	if perr != nil {
		t.Fatalf("Parse: %v", perr)
	}
	if refs := MetricRefs(plain); len(refs) != 0 {
		t.Errorf("ref-free MetricRefs = %+v, want none", refs)
	}
}

// TestRefJoinShape pins the ref→engine-derived INNER JOIN (design §2):
// the ON's five conjuncts, the grain key (0 for a profile dependency,
// the row's match for a match dependency), the subject correlation, the
// two live stamps, the forced column qualification, one join per DISTINCT
// name, and the binds' textual order.
func TestRefJoinShape(t *testing.T) {
	const upstream = "INNER JOIN metric_values md0 ON md0.metric_id = ? AND md0.match_id = %s AND md0.steam_id = events.attacker AND md0.metric_version = ? AND md0.rule_version = ?"
	cases := []struct {
		name, expr, scope, wantMatch string
		wantArgs                     []any
	}{
		{"match grain correlates on the row's match", "from events: metric('a')", "",
			"events.match_id", []any{int64(7), 3, 5}},
		{"profile grain reads the career key", "from events: metric('a')", "",
			"0", []any{int64(7), 3, 5}},
		{"match scope keeps the correlation", "from events: metric('a')", "match:7",
			"events.match_id", []any{int64(7), 3, 5, int64(7)}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			targets := refTargets()
			if c.wantMatch == "0" {
				t2 := targets["a"]
				t2.Scope = "profile"
				targets["a"] = t2
			}
			plan, perr := CompileRefs(c.expr, "", c.scope, targets)
			if perr != nil {
				t.Fatalf("CompileRefs(%q): %v", c.expr, perr)
			}
			want := "FROM events " + strings.Replace(upstream, "%s", c.wantMatch, 1)
			if !strings.Contains(plan.SQL, want) {
				t.Errorf("SQL missing join\n%s\nin:\n%s", want, plan.SQL)
			}
			if !reflect.DeepEqual(plan.Args, c.wantArgs) {
				t.Errorf("args = %v, want %v (id, stamps, then the scope id)", plan.Args, c.wantArgs)
			}
			// A ref-bearing statement must qualify every primary column:
			// metric_values shares match_id/steam_id with the source, so
			// an unqualified reference would be ambiguous.
			if !strings.Contains(plan.SQL, "events.attacker <> ''") {
				t.Errorf("subject addressing not qualified:\n%s", plan.SQL)
			}
			if c.scope != "" && !strings.Contains(plan.SQL, "WHERE events.match_id =") {
				t.Errorf("scope predicate not qualified:\n%s", plan.SQL)
			}
		})
	}

	t.Run("one join per distinct name, aliases in first-appearance order", func(t *testing.T) {
		plan, perr := CompileRefs("from events: metric('b'), metric('a'), metric('b')", "", "", refTargets())
		if perr != nil {
			t.Fatalf("CompileRefs: %v", perr)
		}
		if got := strings.Count(plan.SQL, "INNER JOIN metric_values"); got != 2 {
			t.Errorf("join count = %d, want 2 (b, a — the repeat is one join)", got)
		}
		if !strings.Contains(plan.SQL, "md0.value") || !strings.Contains(plan.SQL, "md1.value") {
			t.Errorf("value columns not aliased per ref:\n%s", plan.SQL)
		}
		want := []any{int64(9), 1, 5, int64(7), 3, 5} // b first, then a
		if !reflect.DeepEqual(plan.Args, want) {
			t.Errorf("args = %v, want %v", plan.Args, want)
		}
	})

	t.Run("ref-free plans stay byte-stable (no join, no forced qualification)", func(t *testing.T) {
		plan, perr := Compile("from events: count(where kind='kill')", "", "")
		if perr != nil {
			t.Fatalf("Compile: %v", perr)
		}
		if strings.Contains(plan.SQL, "metric_values") {
			t.Errorf("ref-free plan gained a ref join:\n%s", plan.SQL)
		}
		// Single-source base form stays byte-stable: unqualified columns.
		if !strings.Contains(plan.SQL, "(kind = ?)") ||
			!strings.Contains(plan.SQL, "WHERE attacker <> ''") {
			t.Errorf("ref-free statement lost its single-source form:\n%s", plan.SQL)
		}
	})
}

// TestUnknownMetricReference pins the resolution failure: a name the
// caller did not resolve is a positioned friendly error, and Compile
// (the ref-free entry point, nil map) reports it identically — a draft, a
// preview and a save can never disagree about a reference.
func TestUnknownMetricReference(t *testing.T) {
	const expr = "from events: metric('ghost')"
	wantPos := strings.Index(expr, "'ghost'")
	if _, perr := Compile(expr, "", ""); perr == nil {
		t.Fatal("Compile (nil refs) accepted a reference")
	} else if perr.Message != `unknown metric reference "ghost"` || perr.Pos != wantPos {
		t.Errorf("Compile error = (%q, %d), want (%q, %d)", perr.Message, perr.Pos, `unknown metric reference "ghost"`, wantPos)
	}
	// A partially filled map fails on the MISSING name only.
	targets := refTargets()
	delete(targets, "a")
	if _, perr := CompileRefs(expr, "", "", targets); perr == nil || perr.Pos != wantPos {
		t.Errorf("CompileRefs with a partial map = %v, want the missing name at %d", perr, wantPos)
	}
}

// TestFindCycle pins the pure graph walk (design §2): self-reference,
// pair, chain, the {existing} ∪ {new} union, and the reachability rule
// (only cycles reachable from the metric being saved matter).
func TestFindCycle(t *testing.T) {
	cases := []struct {
		name  string
		from  string
		edges map[string][]string
		want  []string
	}{
		{"self reference", "a", map[string][]string{"a": {"a"}}, []string{"a", "a"}},
		{"pair", "a", map[string][]string{"a": {"b"}, "b": {"a"}}, []string{"a", "b", "a"}},
		{"chain", "a", map[string][]string{"a": {"b"}, "b": {"c"}, "c": {"a"}}, []string{"a", "b", "c", "a"}},
		{"chain entered mid-way", "b", map[string][]string{"a": {"b"}, "b": {"c"}, "c": {"a"}}, []string{"b", "c", "a", "b"}},
		// {existing edges} ∪ {new refs}: b→c and c→a pre-exist, a→b is
		// the edit under test — the union is what closes the loop.
		{"existing union new", "a", map[string][]string{"a": {"b"}, "b": {"c"}, "c": {"a"}}, []string{"a", "b", "c", "a"}},
		{"cycle below the entry", "a", map[string][]string{"a": {"b"}, "b": {"c"}, "c": {"b"}}, []string{"b", "c", "b"}},
		{"no cycle", "a", map[string][]string{"a": {"b"}, "b": {"c"}}, nil},
		{"diamond", "a", map[string][]string{"a": {"b", "c"}, "b": {"d"}, "c": {"d"}, "d": {}}, nil},
		{"unreachable cycle ignored", "a", map[string][]string{"x": {"x"}}, nil},
		{"missing node", "a", nil, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := FindCycle(c.from, c.edges); !reflect.DeepEqual(got, c.want) {
				t.Errorf("FindCycle(%q) = %v, want %v", c.from, got, c.want)
			}
		})
	}
}

// TestRenameRefs pins the span rewrite: only the target literals move,
// spans splice back-to-front (earlier offsets stay valid), a quote in
// the new name is escaped the way the lexer reads it, an absent target
// is a no-op, and a rewrite that would not parse back fails instead of
// landing a broken expression.
func TestRenameRefs(t *testing.T) {
	t.Run("rewrites only the target refs", func(t *testing.T) {
		const expr = "from events: ratio(metric('old'), count()), metric('keep')"
		got, perr := RenameRefs(expr, "old", "new")
		if perr != nil {
			t.Fatalf("RenameRefs: %v", perr)
		}
		want := "from events: ratio(metric('new'), count()), metric('keep')"
		if got != want {
			t.Errorf("got  %s\nwant %s", got, want)
		}
		spec, perr := Parse(got)
		if perr != nil {
			t.Fatalf("rewritten expr does not parse: %v", perr)
		}
		if names := DistinctNames(MetricRefs(spec)); !reflect.DeepEqual(names, []string{"new", "keep"}) {
			t.Errorf("refs = %v, want [new keep]", names)
		}
	})

	t.Run("repeated refs all move (back-to-front splices)", func(t *testing.T) {
		const expr = "from events: metric('old'), count(), metric('old')"
		got, perr := RenameRefs(expr, "old", "new")
		if perr != nil {
			t.Fatalf("RenameRefs: %v", perr)
		}
		want := "from events: metric('new'), count(), metric('new')"
		if got != want {
			t.Errorf("got  %s\nwant %s", got, want)
		}
	})

	t.Run("absent target is a no-op", func(t *testing.T) {
		const expr = "from events: metric('other')"
		got, perr := RenameRefs(expr, "old", "new")
		if perr != nil || got != expr {
			t.Errorf("RenameRefs = (%q, %v), want the expression untouched", got, perr)
		}
	})

	t.Run("quote in the new name round-trips through the lexer", func(t *testing.T) {
		got, perr := RenameRefs("from events: metric('old')", "old", "o'brien")
		if perr != nil {
			t.Fatalf("RenameRefs: %v", perr)
		}
		if got != "from events: metric('o''brien')" {
			t.Errorf("got %s, want the escaped literal", got)
		}
		spec, perr := Parse(got)
		if perr != nil {
			t.Fatalf("rewritten expr does not parse: %v", perr)
		}
		if refs := MetricRefs(spec); len(refs) != 1 || refs[0].Name != "o'brien" {
			t.Errorf("refs = %+v, want the unescaped name back", refs)
		}
	})

	t.Run("a rewrite that would not parse back fails", func(t *testing.T) {
		if _, perr := RenameRefs("from events: metric('old')", "old", ""); perr == nil {
			t.Fatal("empty new name accepted — the splice must fail instead of landing a broken expression")
		}
	})
}
