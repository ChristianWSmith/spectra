package metrics

import (
	"math"
	"strings"
	"testing"
)

// TestInlineArgsWritesValuesIn pins the DISPLAY-side literal inlining:
// values land in the statement as SQLite reads them back (numbers bare,
// text quoted with ” escapes), the plan's own text and binds are never
// touched, and every disagreement falls back to the ORIGINAL statement —
// never a half-rendered one.
func TestInlineArgsWritesValuesIn(t *testing.T) {
	cases := []struct {
		name string
		sql  string
		args []any
		want string // "" = the input must come back unchanged
	}{
		{
			"match id and a filter value",
			"SELECT grp FROM t WHERE match_id = ? AND kind = ? GROUP BY grp",
			[]any{int64(4567), "kill"},
			"SELECT grp FROM t WHERE match_id = 4567 AND kind = 'kill' GROUP BY grp",
		},
		{"no values", "SELECT ? AS x", nil, "SELECT ? AS x"},
		{
			"a bound value containing ? renders as text, not a marker",
			"SELECT '%' || ? AS x",
			[]any{"a?b"},
			"SELECT '%' || 'a?b' AS x",
		},
		{
			"quote escaping in a bound string",
			"SELECT ? AS x",
			[]any{"it's a 'test'"},
			"SELECT 'it''s a ''test''' AS x",
		},
		{
			"integers and exact floats render bare",
			"SELECT ? AS a, ? AS b, ? AS c",
			[]any{int64(7), 2.0, 0.412},
			"SELECT 7 AS a, 2 AS b, 0.412 AS c",
		},
		{"booleans and nil", "SELECT ? AS a, ? AS b", []any{true, nil}, "SELECT 1 AS a, NULL AS b"},
		{
			// A companion statement's markers (its binds are not carried)
			// stay `?` — honestly uninlined rather than filled in wrong.
			"a companion statement's markers stay uninlined",
			"SELECT ? AS a\nSELECT ? AS b",
			[]any{int64(3)},
			"SELECT 3 AS a\nSELECT ? AS b",
		},
		{"more values than markers → unchanged", "SELECT ? AS a", []any{1, 2}, ""},
		{"a value SQL cannot render → unchanged", "SELECT ? AS a", []any{math.NaN()}, ""},
		{"an unknown value type → unchanged", "SELECT ? AS a", []any{struct{}{}}, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := InlineArgs(c.sql, c.args)
			want := c.want
			if want == "" {
				want = c.sql
			}
			if got != want {
				t.Errorf("InlineArgs = %q, want %q", got, want)
			}
		})
	}
}

// TestInlineArgsLeavesLiteralsAndCommentsAlone: a `?` inside a quoted
// region or a comment is copied verbatim (only real markers are values).
func TestInlineArgsLeavesLiteralsAndCommentsAlone(t *testing.T) {
	sql := "SELECT 'a?b' AS s /* ? */ , ? AS x -- ?\nFROM t"
	got := InlineArgs(sql, []any{5})
	want := "SELECT 'a?b' AS s /* ? */ , 5 AS x -- ?\nFROM t"
	if got != want {
		t.Errorf("InlineArgs = %q, want %q", got, want)
	}
}

// TestDisplaySQLInlineMatchesAcrossPaths: the Builder's provenance text
// is ONE byte string whichever leg produced it — the no-execution
// Compile (Plan.DisplaySQL) and the preview's own copy
// (Preview.DisplaySQL, which walks the already-concatenated text) must
// agree, or the service's compile/preview comparison would drift. The
// plan keeps its binds: display never feeds execution.
func TestDisplaySQLInlineMatchesAcrossPaths(t *testing.T) {
	cases := []struct {
		name, expr string
	}{
		{"scoped single statement", "from events: count()"},
		{"scoped filter", "from events: count(where dmg >= 50)"},
		{"percentile with a companion", "from events: percentile(0.5, dmg), count()"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			plan, perr := Compile(c.expr, "", "match:4567")
			if perr != nil {
				t.Fatalf("Compile(%q): %v", c.expr, perr)
			}
			if !strings.Contains(plan.SQL, "?") {
				t.Fatalf("expected a bound scope id in the plan: %s", plan.SQL)
			}
			compileSide := plan.DisplaySQL()
			// Mirror RunPreview's own copy: the preview's SQL already has
			// the companion appended (preview.go) before DisplaySQL runs.
			concat := plan.SQL
			if plan.Secondary != "" {
				concat += "\n" + plan.Secondary
			}
			previewSide := Preview{SQL: concat, Args: plan.Args}.DisplaySQL()
			if compileSide != previewSide {
				t.Errorf("compile != preview display\ncompile: %s\npreview: %s", compileSide, previewSide)
			}
			// The values are WRITTEN IN — the primary statement the user
			// copies carries no marker left.
			primary := compileSide
			if plan.Secondary != "" {
				primary = strings.TrimSuffix(compileSide, "\n"+plan.Secondary)
			}
			if strings.Contains(primary, "?") {
				t.Errorf("primary markers not inlined:\n%s", primary)
			}
			if !strings.Contains(compileSide, "match_id = 4567") {
				t.Errorf("scope id not inlined:\n%s", compileSide)
			}
			// Execution never sees the display text: the plan still binds.
			if !strings.Contains(plan.SQL, "match_id = ?") {
				t.Errorf("plan text changed:\n%s", plan.SQL)
			}
			if len(plan.Args) == 0 {
				t.Error("plan args dropped")
			}
			// The companion (when present) keeps its markers, honestly.
			if plan.Secondary != "" && !strings.Contains(compileSide, plan.Secondary) {
				t.Errorf("companion not appended verbatim:\n%s", compileSide)
			}
		})
	}
}
