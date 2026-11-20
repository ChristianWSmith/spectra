package metrics

import (
	"strings"
	"testing"
)

// The diff() row-difference pins (plan §8's winner-minus-loser
// construct): one written message per illegal shape (the argmax_test.go
// pattern), the same-row/primary operand rule, the reduce-position rule
// (sum/avg only) — and the load-bearing denial beside them: aggregate
// arithmetic is STILL not grammar, `sum(a) - sum(b)` refuses exactly as
// it did before diff() existed. The semantic pins run over
// testdata/seed.sql: equip 2500 ct / 2000 t every round with strictly
// alternating winners, so round-number filters break the alternation
// symmetry into hand-computable non-zero means (a NULL-beside-N fill or
// an orientation bug cannot land on them).

// TestRowDifferenceRefusals pins one written message per non-legal
// shape.
func TestRowDifferenceRefusals(t *testing.T) {
	const shape = "diff() is a row difference — it appears only as sum()'s or avg()'s argument"

	// Not an aggregation itself: top level, ratio() operand, scalar
	// term, condition — the ONE diffPosMsg everywhere.
	for _, expr := range []string{
		"from rounds: diff(equip_ct, equip_t, winner = 'ct')",
		"from rounds: ratio(diff(equip_ct, equip_t, winner = 'ct'), count())",
		"from rounds: max(sum(number), diff(equip_ct, equip_t, winner = 'ct'))",
		"from rounds: count(where diff(equip_ct, equip_t, winner = 'ct') > 0)",
	} {
		_, perr := Compile(expr, "", "", Address{Subject: "match"})
		if perr == nil {
			t.Errorf("%s compiled, want diffPosMsg refusal", expr)
			continue
		}
		if !strings.Contains(perr.Message, shape) {
			t.Errorf("%s refusal = %q, want diffPosMsg", expr, perr.Message)
		}
	}

	// Reduced ONLY by sum()/avg(): every other column op names itself
	// in the refusal.
	for _, expr := range []string{
		"from rounds: min(diff(equip_ct, equip_t, winner = 'ct'))",
		"from rounds: max(diff(equip_ct, equip_t, winner = 'ct'))",
		"from rounds: stddev(diff(equip_ct, equip_t, winner = 'ct'))",
		"from rounds: percentile(0.5, diff(equip_ct, equip_t, winner = 'ct'))",
		"from rounds: argmax(diff(equip_ct, equip_t, winner = 'ct'))",
	} {
		_, perr := Compile(expr, "", "", Address{Subject: "match"})
		if perr == nil {
			t.Errorf("%s compiled, want the reduce-position refusal", expr)
			continue
		}
		if !strings.Contains(perr.Message, "diff() is reduced only inside sum() or avg()") {
			t.Errorf("%s refusal = %q, want the reduce-position copy", expr, perr.Message)
		}
	}

	// The additive chain stays column-only: diff() IS the row
	// subtraction, it cannot ride another.
	refuse(t, "from rounds: sum(equip_ct + diff(equip_ct, equip_t, winner = 'ct'))",
		Address{Subject: "match"},
		"diff() cannot appear in sum()'s additive chain — it is itself the row subtraction")

	// Arity: two columns and the orientation condition — every count
	// miss, one message.
	for _, expr := range []string{
		"from rounds: avg(diff())",
		"from rounds: avg(diff(equip_ct))",
		"from rounds: avg(diff(equip_ct, equip_t))",
		"from rounds: avg(diff(equip_ct, equip_t, winner = 'ct', number))",
	} {
		_, perr := Compile(expr, "", "", Address{Subject: "match"})
		if perr == nil {
			t.Errorf("%s compiled, want diffArityMsg", expr)
			continue
		}
		if !strings.Contains(perr.Message, "diff() takes exactly three arguments") {
			t.Errorf("%s refusal = %q, want diffArityMsg", expr, perr.Message)
		}
	}

	// Operand kinds, each with its own column-position copy.
	refuse(t, "from rounds: avg(diff(metric('x'), equip_t, winner = 'ct'))",
		Address{Subject: "match"}, "metric() is a value reference — it cannot appear inside diff()")
	refuse(t, "from rounds: avg(diff(next(winner), equip_t, winner = 'ct'))",
		Address{Subject: "match"}, nextValueMsg)
	refuse(t, "from rounds: avg(diff(diff(equip_ct, equip_t, winner = 'ct'), equip_t, winner = 'ct'))",
		Address{Subject: "match"}, "diff() cannot be nested inside diff()")

	// exists() belongs to the aggregation's own where/count position,
	// never the orientation condition.
	refuse(t, "from rounds: avg(diff(equip_ct, equip_t, exists(number = outer.number)))",
		Address{Subject: "match"}, diffExistsMsg)

	// SAME-ROW operands: the primary owns both columns — a secondary's
	// column refuses with its own message (the incompatible-subjects
	// refusal), an unknown column keeps the unknown-column copy.
	refuse(t, "from rounds, round_classifications: avg(diff(label, equip_ct, winner = 'ct'))",
		Address{Subject: "match"},
		`diff() subtracts two values of the same row of the primary source "rounds" — "label" belongs to "round_classifications"`)
	refuse(t, "from rounds: avg(diff(not_a_column, equip_t, winner = 'ct'))",
		Address{Subject: "match"}, `unknown column "not_a_column" for source rounds`)

	// THE LOAD-BEARING DENIAL, unchanged by diff(): aggregate-minus-
	// aggregate is still not grammar. `sum(a) - sum(b)` refuses at the
	// aggregation boundary with the SAME pinned boundary copy
	// metrics_test.go pins for its `+` twin, and a diff() does not
	// open the door either.
	refuse(t, "from rounds: sum(equip_ct) - sum(equip_t)",
		Address{Subject: "match"}, "or end of expression")
	refuse(t, "from rounds: sum(equip_ct) + sum(equip_t)",
		Address{Subject: "match"}, "or end of expression")
	refuse(t, "from rounds: ratio(sum(equip_ct) - sum(equip_t), count())",
		Address{Subject: "match"}, `expected "," (got`)
	refuse(t, "from rounds: avg(diff(equip_ct, equip_t, winner = 'ct')) - avg(diff(equip_ct, equip_t, winner = 'ct'))",
		Address{Subject: "match"}, "or end of expression")
}

// TestRowDifferenceCorpus is THE semantic pin over the committed
// corpus: equip 2500 ct / 2000 t on every round, winner strictly
// alternating (odd ct / even t), all 24 rounds decided. Round-number
// filters slice the alternation into hand-computable means — the
// orientation (which side the condition selects as the subtrahend) and
// the reduction both have to be right to land on them.
func TestRowDifferenceCorpus(t *testing.T) {
	st := seededStore(t)

	cases := []struct {
		expr string
		want float64
		why  string
	}{
		// Rounds 1-3: ct win (+500), t win (−500), ct win (+500).
		{"from rounds: avg(where number <= 3, diff(equip_ct, equip_t, winner = 'ct'))",
			500.0 / 3.0, "(500 − 500 + 500) / 3 — orientation picks a−b exactly on ct wins"},
		// The ORIENTATION FLIPS the subtraction: the same slice with
		// the t side as the addend mirrors every round.
		{"from rounds: avg(where number <= 3, diff(equip_ct, equip_t, winner = 't'))",
			-500.0 / 3.0, "(−500 + 500 − 500) / 3 — the mirrored orientation"},
		// A single decided round: the whole value is one row's
		// difference (a NULL-beside-N fill could never read 500).
		{"from rounds: sum(where number = 1, diff(equip_ct, equip_t, winner = 'ct'))",
			500, "round 1 only: 2500 − 2000"},
		// Joined sources: both diff operands are the primary's, the
		// where reads the secondary — the emission must qualify each
		// without ambiguity to keep the slice's mean.
		{"from rounds, round_classifications: avg(where number <= 3, diff(equip_ct, equip_t, winner = 'ct'))",
			500.0 / 3.0, "same slice over the join (LEFT side keeps every round)"},
	}
	for _, c := range cases {
		pv, perr, err := RunPreview(t.Context(), st, Def{Expr: c.expr, Subject: "match"}, "", 50)
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
			approx(t, r.Value, c.want, c.expr+" match "+strings.TrimSpace(r.Group))
			if r.N != 24 {
				t.Errorf("%s N = %d, want 24 (every round of the match)", c.expr, r.N)
			}
		}
	}
}
