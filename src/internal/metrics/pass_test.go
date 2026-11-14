package metrics

import (
	"strings"
	"testing"
)

// W3 — the PASS-ONLY address mode (stored-metrics design §3): the
// batched match-scope statement CompilePassMatch must group by
// (match_id, subject), carry no scope predicate, correlate a match
// denominator on the ROW's match (always primary-qualified — an
// unqualified match_id inside the subquery would resolve to the inner
// table and count the whole table), and mark Plan.MatchAddress so the
// pass's row adapter knows the leading column. The preview shapes stay
// byte-identical (MatchAddress false) — pinned here so the two modes
// can never drift into each other.

// TestCompilePassMatchAddressMode pins the batched emission.
func TestCompilePassMatchAddressMode(t *testing.T) {
	// Single-source batch: unqualified leading address column, grouped
	// by (mid, grp), NO scope predicate (one statement, whole library).
	plan, perr := CompilePassMatch("from events: count()", "", nil)
	if perr != nil {
		t.Fatalf("compile: %v", perr)
	}
	if !plan.MatchAddress {
		t.Error("MatchAddress = false, want true (pass-only batched mode)")
	}
	if !strings.Contains(plan.SQL, "SELECT match_id AS mid, attacker AS grp") {
		t.Errorf("batched select missing the leading address column:\n%s", plan.SQL)
	}
	if !strings.Contains(plan.SQL, "GROUP BY mid, grp ORDER BY mid, grp") {
		t.Errorf("batched GROUP BY missing (match_id, subject):\n%s", plan.SQL)
	}
	if strings.Contains(plan.SQL, "WHERE match_id = ?") {
		t.Errorf("batched statement binds a scope id (it must cover every match):\n%s", plan.SQL)
	}
	if len(plan.Args) != 0 {
		t.Errorf("args = %v, want none (no scope, no denominator, no literal)", plan.Args)
	}

	// Joined source: the address column is primary-qualified (the join
	// forces qualification — match_id is ambiguous across sources).
	joined, perr := CompilePassMatch("from player_stats, match_trade_opps: ratio(sum(trade_kills), sum(opps))", "", nil)
	if perr != nil {
		t.Fatalf("compile joined: %v", perr)
	}
	if !strings.Contains(joined.SQL, "SELECT player_stats.match_id AS mid, player_stats.steam_id AS grp") {
		t.Errorf("joined batched select not primary-qualified:\n%s", joined.SQL)
	}

	// Match denominator: the SAME match count, correlated on the row's
	// match — primary-qualified (the shadowing guard) and never bound.
	denom, perr := CompilePassMatch("from events: count()", "rounds", nil)
	if perr != nil {
		t.Fatalf("compile denom: %v", perr)
	}
	if !strings.Contains(denom.SQL, "(SELECT COUNT(*) FROM rounds WHERE match_id = events.match_id)") {
		t.Errorf("denominator not correlated on the row's match (qualified):\n%s", denom.SQL)
	}
	if len(denom.Args) != 0 {
		t.Errorf("denom args = %v, want none (correlated, not bound)", denom.Args)
	}

	// Percentile: the RAW fetch carries the same leading address column
	// (the pass partitions (match_id, subject)).
	pctl, perr := CompilePassMatch("from events: percentile(0.95, dmg)", "", nil)
	if perr != nil {
		t.Fatalf("compile percentile: %v", perr)
	}
	if pctl.Mode != ModePercentile || !pctl.MatchAddress {
		t.Fatalf("percentile batch = (mode %d, addr %v), want (ModePercentile, true)", pctl.Mode, pctl.MatchAddress)
	}
	if !strings.Contains(pctl.SQL, "SELECT match_id AS mid, attacker AS grp, dmg AS x") {
		t.Errorf("percentile raw fetch missing the address column:\n%s", pctl.SQL)
	}
}

// TestCompileRefsPreviewShapesUnchanged pins the other side of the
// boundary: the preview compiles (scoped match + library) keep
// MatchAddress false and their exact shapes — the pass-only mode must
// not leak into RunPreview's statements.
func TestCompileRefsPreviewShapesUnchanged(t *testing.T) {
	scoped, perr := Compile("from events: count()", "", "match:7")
	if perr != nil {
		t.Fatalf("compile scoped: %v", perr)
	}
	if scoped.MatchAddress {
		t.Error("scoped preview plan marked MatchAddress — the batched mode leaked into previews")
	}
	if !strings.Contains(scoped.SQL, "WHERE match_id = ?") || !strings.Contains(scoped.SQL, "GROUP BY grp ORDER BY grp") {
		t.Errorf("scoped preview shape changed:\n%s", scoped.SQL)
	}
	if len(scoped.Args) != 1 || scoped.Args[0] != int64(7) {
		t.Errorf("scoped args = %v, want [7]", scoped.Args)
	}

	library, perr := Compile("from events: count()", "", "")
	if perr != nil {
		t.Fatalf("compile library: %v", perr)
	}
	if library.MatchAddress {
		t.Error("library preview plan marked MatchAddress — profile computes through the UNBATCHED library statement")
	}
	if strings.Contains(library.SQL, "AS mid") {
		t.Errorf("library statement carries the batched address column:\n%s", library.SQL)
	}
}

// TestBatchedExecutionRowShape pins what the pass's adapter consumes:
// the batched statement's rows are [match_id, subject, value, n] over
// the seeded corpus — the layout valuesFromPlan reads (and the reason
// the equivalence test's stored rows key on (match_id, subject)).
func TestBatchedExecutionRowShape(t *testing.T) {
	st := seededStore(t)
	plan, perr := CompilePassMatch("from events: count()", "", nil)
	if perr != nil {
		t.Fatalf("compile: %v", perr)
	}
	res, err := st.QueryWrite(t.Context(), plan.SQL, plan.Args, 1000)
	if err != nil {
		t.Fatalf("run: %v (sql: %s)", err, plan.SQL)
	}
	if len(res.Rows) == 0 {
		t.Fatal("no rows from the seeded corpus")
	}
	seenMatch := map[int64]bool{}
	for _, r := range res.Rows {
		if len(r) != 4 {
			t.Fatalf("row shape = %d cells (%v), want 4 [mid grp v n]", len(r), r)
		}
		mid, ok := r[0].(int64)
		if !ok || mid <= 0 {
			t.Errorf("address cell = %#v, want a positive match id", r[0])
		}
		seenMatch[mid] = true
		subject, _ := r[1].(string)
		if subject == "" {
			t.Errorf("empty subject in %v (subject <> '' must hold)", r)
		}
	}
	// The batch covers every seeded match in ONE statement (3 matches).
	if len(seenMatch) != 3 {
		t.Errorf("matches covered = %d, want 3 (batched over the whole library)", len(seenMatch))
	}
}
