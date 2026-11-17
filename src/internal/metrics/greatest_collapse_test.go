package metrics

import (
	"strings"
	"testing"
)

// TestScalarMaxCoversGreatestContexts is ME1's Phase-1 reconciliation pin
// (metrics-expansion plan §6.1/§12). The plan called for a `greatest(a, b)`
// operator so the KDA seed could floor both ratio halves — but w13e
// (ab22181) shipped the scalar min/max value form the same day, and its
// semantics ARE greatest(): numeric-only value terms, ≥2 arity, existing
// nesting depth, legal in both ratio() halves (ratioNestedOps carries
// min/max) and as a top-level finished-value operand. Adding `greatest`
// would be a second operator doing exactly what `max` already does (one
// canonical way), so Phase 1 COLLAPSED: no new grammar — this file is the
// confirmation pin instead.
//
// What this pins that TestScalarMinMaxMatrix does not:
//   - the ratio NUMERATOR half floored (the plan's exact KDA shape with
//     max spelling both halves — the matrix only pins the denominator);
//   - the shipped `kda` seed expression still compiles as written;
//   - `greatest` is NOT a function in the language — `max` is THE
//     spelling; a future deliberate rename must update this pin.
//
// The plan's numerator floor (`greatest(sum(kills + assists), 0)`) is a
// tautology — kills and assists are non-negative counts — so the shipped
// seed keeps the unfloored numerator: the floor would add a bind and
// change nothing, and byte-identical display (ME0's
// TestKDAZeroDeathDisplay) is pinned against the shipped spelling.
func TestScalarMaxCoversGreatestContexts(t *testing.T) {
	accept := []struct{ name, expr string }{
		{"plan KDA shape, max spelling", "from player_stats: ratio(max(sum(kills + assists), 0), max(sum(deaths), 1))"},
		{"numerator half floored", "from player_stats: ratio(max(sum(kills + assists), 0), sum(deaths))"},
		{"shipped kda seed", "from player_stats: ratio(sum(kills + assists), max(sum(deaths), 1))"},
		{"top-level finished value", "from player_stats: max(sum(deaths), 1)"},
	}
	for _, c := range accept {
		t.Run("accept "+c.name, func(t *testing.T) {
			if perr := Validate(c.expr); perr != nil {
				t.Fatalf("Validate(%q): %v", c.expr, perr)
			}
			if _, perr := Compile(c.expr, "", "", Address{}); perr != nil {
				t.Fatalf("Compile(%q): %v", c.expr, perr)
			}
		})
	}

	// `greatest` never joined the language: the collapse means max() is
	// the one floor/greatest spelling.
	t.Run("reject greatest()", func(t *testing.T) {
		expr := "from player_stats: greatest(sum(deaths), 1)"
		perr := Validate(expr)
		if perr == nil {
			if _, cerr := Compile(expr, "", "", Address{}); cerr == nil {
				t.Fatalf("Compile(%q) unexpectedly accepted — greatest() must not exist beside max()", expr)
			} else {
				perr = cerr
			}
		}
		t.Logf("greatest() rejection message: %q", perr.Message)
		if !strings.Contains(perr.Message, "greatest") {
			t.Errorf("message = %q, want it to name the offending word", perr.Message)
		}
		if perr.Pos <= 0 {
			t.Errorf("Pos = %d, want a positioned error", perr.Pos)
		}
	})
}
