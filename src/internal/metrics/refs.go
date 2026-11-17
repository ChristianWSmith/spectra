package metrics

import "strings"

// Metric() references (design §2): a ref is a VALUE term the grammar
// admits in exactly two positions — a top-level aggregation in the agg
// list and a ratio() numerator/denominator operand (the criterion: a ref
// may appear only where a computed value may appear; parse.go holds the
// two legal positions and the denied-position errors, the min()/max()
// scalar argument list among them). This file
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
// The min()/max() SCALAR argument list is a DENIED ref position, not a
// third legal one: parse.go's parseScalarTerm refuses `metric` before
// any node is built, so no scalar argument can ever carry a ref for this
// walk to miss (admitting refs there later — a deliberate FUTURE option,
// not an oversight — would extend this walk in the same change).
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
	ID    int64
	Scope string
	// Subject is the referenced metric's declared subject (metrics
	// expansion §3 — player | match | team; "" reads as the historical
	// player default): it decides the ref join's subject_key key and
	// gates the §3.1 containment rule (the SERVICE fills it from the
	// catalog row, beside Scope).
	Subject     string
	Version     int
	RuleVersion int
}

// refSubjectContained is THE subject × subject ref rule (metrics
// expansion §3.1 key containment): the DEPENDENT's stored row key must
// supply every key column of the dependency's row key, so a reference
// may point at the same subject or one the reading metric's rows
// already pinpoint:
//
//	ref player   only a player dependent (its subject key IS a SteamID64)
//	ref match    any dependent (every stored key carries match_id — a
//	             CAREER dependent is additionally refused by the save's
//	             cross-scope rule: match_id 0 pins no match)
//	ref team     only a team dependent (only its key carries the team)
//
// Both the compile-time join refusal (compile.go) and the save-time
// validation (metricservice resolveRefs) read this ONE spelling; their
// messages differ only in copy style (positioned ExprError vs the
// §3.1 service copy).
func RefSubjectContained(depSubject, refSubject string) bool {
	switch refSubject {
	case "player":
		return depSubject == "player"
	case "match":
		return true
	case "team":
		return depSubject == "team"
	}
	return false
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
