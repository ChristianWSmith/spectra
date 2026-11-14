package metrics

import "strings"

// Metric() references (design §2): a ref is a VALUE term the grammar
// admits in exactly two positions — a top-level aggregation in the agg
// list and a ratio() numerator/denominator operand (the criterion: a ref
// may appear only where a computed value may appear; parse.go holds the
// two legal positions and the three denied-position errors). This file
// is the ref surface: extraction (the source metric_deps rows are
// re-derived from), the compile-time resolution handle, and the rename
// splice (the one rewrite that may touch a stored expression).

// MetricRef is one metric() reference found in a Spec: the referenced
// metric's name plus the byte span of its '...' literal (Pos inclusive,
// End exclusive) — the span the rename splice replaces.
type MetricRef struct {
	Name string
	Pos  int
	End  int
}

// MetricRefs is THE pure extraction walk (design §2): every metric()
// reference in spec's aggregation list, in textual order. It is the one
// source the save path derives metric_deps edges from (round-trip
// contract: after EVERY save the stored edges equal the distinct refs of
// the CURRENT expression) and the cycle check's out-edges.
//
// The grammar admits a ref in exactly two positions, so the walk covers
// the top-level list and ratio()'s two operands and nothing else can
// hold one — a ref may appear only where a computed value may appear.
// Duplicates are kept (two occurrences of metric('a') are two refs, two
// spans); edges are a SET, so callers that persist or compare dedupe.
func MetricRefs(spec Spec) []MetricRef {
	var out []MetricRef
	var walk func(a *Agg)
	walk = func(a *Agg) {
		if a == nil {
			return
		}
		switch a.Op {
		case "metric":
			out = append(out, MetricRef{Name: a.RefName, Pos: a.RefPos, End: a.RefEnd})
		case "ratio":
			walk(a.Num)
			walk(a.Den)
		}
	}
	for i := range spec.Aggs {
		walk(&spec.Aggs[i])
	}
	return out
}

// DistinctNames renders refs as the SET of names (first-appearance
// order) — the metric_deps edge list and the cycle graph's out-edges.
func DistinctNames(refs []MetricRef) []string {
	seen := make(map[string]bool, len(refs))
	out := make([]string, 0, len(refs))
	for _, r := range refs {
		if seen[r.Name] {
			continue
		}
		seen[r.Name] = true
		out = append(out, r.Name)
	}
	return out
}

// RefTarget is one RESOLVED metric() reference — what Compile binds for
// a ref's name. Compile stays pure (no DB): the SERVICE fills the map
// from the catalog (metrics.name is UNIQUE across origins, so name→id
// resolution is total).
//
//	Scope       the referenced metric's grain — decides the join's row key:
//	            "profile" → d.match_id = 0 (the career grain), anything
//	            else → d.match_id = the row's match (the store's omitted-
//	            scope rule: only 'match'/'profile' exist).
//	Version     the referenced metric's live metrics.version.
//	RuleVersion the live analysis_config.rule_version.
//
// Both stamps make the ref join read ONLY fresh upstream rows: an
// outdated upstream drops the dependent's row (INNER — absent = unknown,
// never 0; design §2).
type RefTarget struct {
	ID          int64
	Scope       string
	Version     int
	RuleVersion int
}

// RenameRefs rewrites expr's metric('old') literals to metric('new')
// using the parse's own literal spans (design §2 rename splice): spans
// are replaced back-to-front so earlier offsets stay valid, a quote in
// the new name is escaped the way the lexer reads it, and the result is
// re-parsed before it is returned — a rewrite that does not parse back
// fails HERE, so the save can abort with nothing written.
//
// Returns the rewritten source unchanged when no ref names oldName, or a
// *ParseError carrying the dependent's own position.
func RenameRefs(expr, oldName, newName string) (string, *ParseError) {
	spec, perr := Parse(expr)
	if perr != nil {
		return "", perr
	}
	refs := MetricRefs(spec)
	out := expr
	replaced := false
	for i := len(refs) - 1; i >= 0; i-- {
		r := refs[i]
		if r.Name != oldName {
			continue
		}
		replaced = true
		lit := "'" + strings.ReplaceAll(newName, "'", "''") + "'"
		out = out[:r.Pos] + lit + out[r.End:]
	}
	if !replaced {
		return expr, nil
	}
	if _, perr := Parse(out); perr != nil {
		return "", perr
	}
	return out, nil
}
