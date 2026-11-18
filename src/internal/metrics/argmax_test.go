package metrics

import (
	"strings"
	"testing"
)

// The argmax/identity pins (metrics expansion §6.4 / §3.3): every
// refusal message (plan §6's per-capability rule), the emitted row
// shape, the corpus identity expectations (who leads each stat over
// testdata/seed.sql), N = the pool (incl. a filtered pool), the
// deterministic tie-break, and DASH = EMPTY POOL (no row — never a
// fabricated identity).

// TestArgmaxRefusals pins one written message per illegal shape:
// profile scope, the subject rule, the player-anchored lead, the
// denominator, the whole-expression rule, the ratio/scalar-nesting
// copies and the ref-inside-argmax denial.
func TestArgmaxRefusals(t *testing.T) {
	// Profile scope (§6.4 v1): its OWN message, whatever the declared
	// subject — the refusal fires before the subject × scope matrix can
	// rephrase it.
	for _, addr := range []Address{
		{Subject: "player", Profile: true},
		{Profile: true}, // subject "" — still the argmax copy
		{Subject: "match", Profile: true},
	} {
		_, perr := Compile("from player_stats: argmax(kills)", "", "", addr)
		if perr == nil {
			t.Fatalf("profile argmax with %+v succeeded, want refusal", addr)
		}
		if !strings.Contains(perr.Message, "profile scope computes over a career, which has no match pool to choose from") {
			t.Errorf("profile argmax refusal = %q, want the §6.4 career-pool copy", perr.Message)
		}
	}

	// subject='match' only — a player- or team-subject statement has no
	// place for a per-match identity.
	for _, subject := range []string{"player", "team"} {
		_, perr := Compile("from player_stats: argmax(kills)", "", "", Address{Subject: subject})
		if perr == nil {
			t.Fatalf("argmax with subject %q succeeded, want refusal", subject)
		}
		if !strings.Contains(perr.Message, `argmax() needs subject "match"`) {
			t.Errorf("argmax/%s refusal = %q, want the subject-match copy", subject, perr.Message)
		}
	}

	// The lead must be player-anchored — the pool is its players.
	refuse(t, "from rounds: argmax(duration_s)", Address{Subject: "match"},
		"argmax() needs a player-anchored lead")

	// No denominator: N is the pool, never a divisor.
	_, perr := Compile("from player_stats: argmax(kills)", "rounds", "", Address{Subject: "match"})
	if perr == nil || !strings.Contains(perr.Message, "argmax() takes no denominator") {
		t.Errorf("argmax+denominator refusal = %v, want the no-denominator copy", perr)
	}

	// The sole-aggregation rule: argmax is the WHOLE expression.
	refuse(t, "from player_stats: argmax(kills), count()", Address{Subject: "match"},
		"argmax() is the whole expression")
	refuse(t, "from player_stats: count(), argmax(kills)", Address{Subject: "match"},
		"argmax() is the whole expression")

	// Nesting rides the shared per-op copy (argmax is not a
	// ratio/scalar value term).
	refuse(t, "from player_stats: ratio(argmax(kills), count())", Address{Subject: "match"},
		"argmax() cannot be nested inside ratio()")
	refuse(t, "from player_stats: max(argmax(kills), 1)", Address{Subject: "match"},
		"argmax() cannot be nested inside max()")

	// A ref is a computed value, never an argument — the per-op copy
	// names argmax like every other column op.
	refuse(t, "from player_stats: argmax(metric('x'))", Address{Subject: "match"},
		"metric() is a value reference — it cannot appear inside argmax()")
}

// TestArgmaxEmissionShape pins the compiled statement: the windowed
// inner rank + outer winner filter, the idkey/v/n column order the row
// adapters read, the deterministic tie-break ORDER, and the batched
// (pass) vs preview shapes.
func TestArgmaxEmissionShape(t *testing.T) {
	batch, perr := CompilePassMatch("from player_stats: argmax(kills)", "", Address{Subject: "match"}, nil)
	if perr != nil {
		t.Fatalf("CompilePassMatch(argmax): %v", perr.Message)
	}
	if !batch.Identity {
		t.Fatal("argmax plan.Identity = false, want true")
	}
	if batch.Mode != ModeGrouped || batch.MatchAddress != true {
		t.Errorf("plan = mode %v MatchAddress %v, want grouped + match address", batch.Mode, batch.MatchAddress)
	}
	for _, want := range []string{
		"SELECT mid, grp, idkey, v, n FROM (SELECT match_id AS mid, match_id AS grp, steam_id AS idkey, kills AS v, ",
		"ROW_NUMBER() OVER (PARTITION BY match_id ORDER BY kills DESC, steam_id ASC) AS rn",
		"COUNT(*) OVER (PARTITION BY match_id) AS n",
		") WHERE rn = 1 ORDER BY mid, grp",
		"steam_id <> ''", // no empty identity key ever becomes a winner
	} {
		if !strings.Contains(batch.SQL, want) {
			t.Errorf("batched argmax SQL lacks %q:\n%s", want, batch.SQL)
		}
	}
	// The pass binds only the humans-only lookup (no scope id at library
	// batch): the statement stays parameterized, never literal.
	if len(batch.Args) != 0 {
		t.Errorf("batched argmax args = %v, want none", batch.Args)
	}

	// Preview shape: no leading mid column (the non-batched match
	// subject groups by the row's match address alone).
	prev, perr := Compile("from player_stats: argmax(kills)", "", "", Address{Subject: "match"})
	if perr != nil {
		t.Fatalf("Compile(argmax): %v", perr.Message)
	}
	if !prev.Identity || !strings.HasPrefix(prev.SQL, "SELECT grp, idkey, v, n FROM (") {
		t.Errorf("preview argmax shape wrong (Identity=%v):\n%s", prev.Identity, prev.SQL)
	}
	// Scoped preview binds the scope id inside the inner statement.
	scoped, perr := Compile("from player_stats: argmax(kills)", "", "match:7", Address{Subject: "match"})
	if perr != nil {
		t.Fatalf("Compile(scoped argmax): %v", perr.Message)
	}
	if len(scoped.Args) != 1 || scoped.Args[0] != int64(7) {
		t.Errorf("scoped argmax args = %v, want [7]", scoped.Args)
	}
}

// TestArgmaxCorpusIdentities is the hand-computed identity expectation
// over the committed 3-match corpus (seed.sql header): who leads each
// M1 stat per match, the companion value, and N = the pool (8 players —
// every player_stats row of the match passes humans-only). Corpus
// math: kills = 2i and adr = 50+5i rise with i, so Heidi (i=8) leads
// both outright; utility_damage is absent (= 0) and mvps is 1 for
// everyone, so those two TIE and the deterministic
// tie-break (player key ASC) names Alice (…001); entry_kills = i (the
// 2026-11-18 swap of the retired opening_kills column) has Heidi
// leading at 8.
func TestArgmaxCorpusIdentities(t *testing.T) {
	st := seededStore(t)
	const heidi = "76561198000000008"
	const alice = "76561198000000001"
	cases := []struct {
		expr  string
		key   string
		name  string
		value float64
	}{
		{"from player_stats: argmax(kills)", heidi, "Heidi", 16},
		{"from player_stats: argmax(adr)", heidi, "Heidi", 90},
		{"from player_stats: argmax(utility_damage)", alice, "Alice", 0},
		{"from player_stats: argmax(entry_kills)", heidi, "Heidi", 8},
		{"from player_stats: argmax(mvps)", alice, "Alice", 1},
	}
	for _, c := range cases {
		t.Run(c.expr, func(t *testing.T) {
			pv, perr, err := RunPreview(st, Def{Expr: c.expr, Subject: "match"}, "", 500)
			if perr != nil {
				t.Fatalf("compile: %v", perr.Message)
			}
			if err != nil {
				t.Fatalf("run: %v (sql: %s)", err, pv.SQL)
			}
			if len(pv.Rows) != 3 {
				t.Fatalf("rows = %d, want 3 (one per match) (%+v)", len(pv.Rows), pv.Rows)
			}
			for i, r := range pv.Rows {
				if r.MatchID != int64(i+1) || r.Group != string(rune('1'+i)) {
					t.Errorf("row %d address = match %d/%q, want match %d", i, r.MatchID, r.Group, i+1)
				}
				if r.ValueKey != c.key {
					t.Errorf("row %d ValueKey = %q, want %q (the winner)", i, r.ValueKey, c.key)
				}
				if r.Value != c.value {
					t.Errorf("row %d companion value = %v, want %v", i, r.Value, c.value)
				}
				if r.N != 8 {
					t.Errorf("row %d N = %d, want 8 (the pool the argmax chose from)", i, r.N)
				}
				if r.Label != c.name {
					t.Errorf("row %d Label = %q, want the winner's name %q", i, r.Label, c.name)
				}
			}
		})
	}
}

// TestArgmaxFilteredPoolN pins N = THE POOL under a per-argmax filter:
// the filter shapes the candidate rows, so the pool shrinks with it
// (the corpus's four CT players) and the winner comes from inside it.
func TestArgmaxFilteredPoolN(t *testing.T) {
	st := seededStore(t)
	pv, perr, err := RunPreview(st, Def{
		Expr: "from player_stats: argmax(where side = 'ct', kills)", Subject: "match",
	}, "", 500)
	if perr != nil {
		t.Fatalf("compile: %v", perr.Message)
	}
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if len(pv.Rows) != 3 {
		t.Fatalf("rows = %d, want 3", len(pv.Rows))
	}
	for _, r := range pv.Rows {
		if r.N != 4 {
			t.Errorf("filtered pool N = %d, want 4 (the CT half of the roster)", r.N)
		}
		if r.ValueKey != "76561198000000004" || r.Value != 8 || r.Label != "Dave" {
			t.Errorf("filtered winner = %+v, want Dave (…004) with 8 kills", r)
		}
	}
}

// TestArgmaxEmptyPoolNoRows pins DASH = EMPTY POOL (§3.3): a pool with
// no rows emits NO row — the surface's dash is "no rows", never a
// fabricated identity (the clutchless corpus: clutches is a legal
// player-anchored lead, it simply has no rows).
func TestArgmaxEmptyPoolNoRows(t *testing.T) {
	st := seededStore(t)
	pv, perr, err := RunPreview(st, Def{Expr: "from clutches: argmax(size)", Subject: "match"}, "", 500)
	if perr != nil {
		t.Fatalf("compile: %v", perr.Message)
	}
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if len(pv.Rows) != 0 {
		t.Fatalf("empty-pool preview = %+v, want no rows (never a fabricated identity)", pv.Rows)
	}
}

// TestValuesFromPlanIdentityMapping pins the pass's identity row
// adapter: idkey → ValueKey beside the companion Value, N trailing,
// the match subject's stored subject_key staying ”; a numeric plan
// never writes ValueKey, and a row too short for the identity shape is
// skipped.
func TestValuesFromPlanIdentityMapping(t *testing.T) {
	plan := Plan{Mode: ModeGrouped, MatchAddress: true, Subject: "match", Identity: true}
	rows, err := valuesFromPlan(plan, [][]any{
		{int64(3), int64(3), "76561198000000008", float64(16), int64(8)},
		{int64(4), int64(4), "76561198000000001"}, // too short — skipped
	})
	if err != nil {
		t.Fatalf("valuesFromPlan(identity): %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1 (the short row skipped)", len(rows))
	}
	r := rows[0]
	if r.MatchID != 3 || r.SubjectKey != "" || r.Dim != "" ||
		r.ValueKey != "76561198000000008" || r.Value != 16 || r.N != 8 {
		t.Errorf("identity row = %+v, want {MatchID 3 SubjectKey \"\" ValueKey …008 Value 16 N 8}", r)
	}

	// A numeric plan keeps the slot ”.
	num := Plan{Mode: ModeGrouped, Subject: "player"}
	nrows, err := valuesFromPlan(num, [][]any{{"76561198000000001", float64(2), int64(3)}})
	if err != nil {
		t.Fatalf("valuesFromPlan(numeric): %v", err)
	}
	if len(nrows) != 1 || nrows[0].ValueKey != "" || nrows[0].Value != 2 {
		t.Errorf("numeric row = %+v, want ValueKey \"\" with the value", nrows)
	}
}
