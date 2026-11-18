package metrics

import (
	"strings"
	"testing"
)

// The next() round-window pins (plan §8's next-round construct): one
// written message per illegal shape (the argmax_test.go pattern), the
// round-grain criterion behind the window's legality, the primary-only
// column rule and the value-position denials — plus the SEMANTIC pins
// over testdata/seed.sql, whose strictly alternating winners make every
// adjacent pair a flip and every hand-count exact.

// TestNextWindowRefusals pins one written message per non-legal shape.
func TestNextWindowRefusals(t *testing.T) {
	// The round-grain criterion (whitelist.go roundGrain): a side-
	// grained, event-grained or player-grained primary would offer
	// several candidate rows for "the next round" — each of the three
	// refusals runs through the same copy, naming the offending source.
	refuse(t, "from round_economy: count(where next(equip_value) > 100)",
		Address{Subject: "match"}, "next() needs a round-grain source — primary source \"round_economy\"")
	refuse(t, "from events: count(where next(tick) > tick)",
		Address{Subject: "match"}, "next() needs a round-grain source — primary source \"events\"")
	refuse(t, "from player_round_stats: count(where next(kills) > 0)",
		Address{}, "next() needs a round-grain source — primary source \"player_round_stats\"")

	// The message's source list is computed from the declarations —
	// pinned here so roundGrainSourcesMsg cannot drift silently.
	_, perr := Compile("from round_economy: count(where next(equip_value) > 100)", "", "",
		Address{Subject: "match"})
	if perr == nil {
		t.Fatal("round_economy window compiled, want refusal")
	}
	if !strings.Contains(perr.Message, "round-grain sources: rounds, round_classifications") {
		t.Errorf("round-grain list = %q, want the worked pair", perr.Message)
	}

	// The window scans the PRIMARY's own table: a joined secondary's
	// column refuses with its own message (round_classifications IS
	// round-grain — it is the join partner, not the window's source).
	refuse(t, "from rounds, round_classifications: count(where next(label) = 'pistol')",
		Address{Subject: "match"},
		"next() reads a column of the primary source \"rounds\" — \"label\" belongs to another source in the join")

	// The column still validates against the whitelist.
	refuse(t, "from rounds: count(where next(not_a_column) = 1)",
		Address{Subject: "match"}, `unknown column "not_a_column" for source rounds`)

	// Every VALUE position refuses with the ONE nextValueMsg: a window
	// is a condition, never this row's value.
	const valueMsg = "next() is a round window — it can only appear where a condition is accepted"
	for _, expr := range []string{
		"from rounds: next(winner)",                     // top-level aggregation
		"from rounds: ratio(next(winner), count())",     // ratio() operand
		"from rounds: avg(next(winner))",                // column argument
		"from rounds: sum(number + next(winner))",       // additive chain term
		"from rounds: max(sum(number), next(winner))",   // scalar min/max term
	} {
		_, perr := Compile(expr, "", "", Address{Subject: "match"})
		if perr == nil {
			t.Errorf("%s compiled, want nextValueMsg refusal", expr)
			continue
		}
		if !strings.Contains(perr.Message, valueMsg) {
			t.Errorf("%s refusal = %q, want nextValueMsg", expr, perr.Message)
		}
	}

	// The LEGAL control beside them: the where filter is exactly where
	// next() lives (the value-position list cannot silently grow to
	// swallow it).
	if _, perr := Compile("from rounds: avg(where next(winner) = winner, number)", "",
		"", Address{Subject: "match"}); perr != nil {
		t.Errorf("filter-position next() = %v, want compile", perr)
	}

	// One level only.
	refuse(t, "from rounds: count(where next(next(winner)) = winner)",
		Address{Subject: "match"}, "next() cannot be nested inside next()")

	// Not inside exists(): the subquery scans other rows; the window
	// always correlates to the row being tested.
	refuse(t, "from rounds: count(where exists(winner = 'ct' and next(winner) = outer.winner))",
		Address{Subject: "match"}, "next() cannot appear inside exists()")

	// Arity: a column, exactly one.
	refuse(t, "from rounds: count(where next() = winner)",
		Address{Subject: "match"}, "next() takes a column name (next(<column>))")
	refuse(t, "from rounds: count(where next(winner, number) = winner)",
		Address{Subject: "match"}, "next() takes exactly one column")

	// A ref never reaches the window's column (conditions admit no ref
	// at all; the copy names next() like every other column position).
	refuse(t, "from rounds: count(where next(metric('x')) = winner)",
		Address{Subject: "match"}, "metric() is a value reference — it cannot appear inside next()")
}

// TestNextWindowCorpus is THE semantic pin over the committed corpus
// (3 identical matches × 24 rounds, winner strictly alternating by
// round parity — seed.sql header): the window reads the next STORED
// round regardless of the per-agg filter, and the last round's next is
// NULL (unknown — the row never counts).
func TestNextWindowCorpus(t *testing.T) {
	st := seededStore(t)

	cases := []struct {
		expr string
		want float64
		n    int
		why  string
	}{
		// 23 adjacent pairs, every one a flip (alternating winners);
		// round 24 has no next round → NULL → not counted.
		{"from rounds: count(where next(winner) != winner)", 23, 24,
			"all 23 adjacent pairs flip; round 24's unknown next never counts"},
		// …and its complement never fires on this corpus.
		{"from rounds: count(where next(winner) = winner)", 0, 24,
			"strict alternation: no round's winner repeats next round"},
		// The filter must NOT narrow the window: of the 12 t-win rows
		// only the last (round 24) lacks a next round — if the window
		// saw only the FILTERED rows (next t-win row), every next()
		// winner would equal this row's and the count would be 0.
		{"from rounds: count(where winner = 't' and next(winner) != winner)", 11, 24,
			"filter-independent window: 12 t-win rows, round 24 excluded by NULL"},
		// Round-number targeting: exactly one row has next round 13.
		{"from rounds: count(where next(number) = 13)", 1, 24,
			"only round 12's window reads 13"},
		// A structural window (always true while a next round exists):
		// 23 again, independent of any column semantics.
		{"from rounds: count(where next(number) > number)", 23, 24,
			"round numbers strictly ascend within the match"},
	}
	for _, c := range cases {
		pv, perr, err := RunPreview(st, Def{Expr: c.expr, Subject: "match"}, "", 50)
		if perr != nil {
			t.Fatalf("RunPreview(%q): %v", c.expr, perr)
		}
		if err != nil {
			t.Fatalf("RunPreview(%q): %v", c.expr, err)
		}
		if len(pv.Rows) != 3 {
			t.Errorf("%s rows = %d, want 3 (one per match)", c.expr, len(pv.Rows))
			continue
		}
		for _, r := range pv.Rows {
			if r.Value != c.want {
				t.Errorf("%s match %d value = %v, want %v (%s)", c.expr, r.MatchID, r.Value, c.want, c.why)
			}
			if r.N != c.n {
				t.Errorf("%s match %d N = %d, want %d (%s)", c.expr, r.MatchID, r.N, c.n, c.why)
			}
		}
	}
}
