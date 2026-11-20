package metrics

import (
	"sort"

	"github.com/ChristianWSmith/spectra/internal/store"
)

// The metric gate — THE one validation every metric statement passes
// (dogfood/03-QUERIES.md §2–§3), serving the Builder's live check, save,
// preview and the sweep. Every one of those reaches the gate through
// compileRefs, which calls gatePlan on the plan it is about to return, so
// none of them can compile a statement the gate has not seen, and each
// compile (the sweep recompiles at run time) re-checks it. The gate:
//
//  1. one statement, read-only (SELECT or WITH lead), no write verb, so
//     no CREATE and no CREATE VIEW — the console's ValidateReadOnlySQL;
//  2. every table read resolves to the metric-readable allowlist
//     (store.AnalyzeMetricSQL), through comma joins, CTEs, subqueries and
//     quoted names; an unresolvable read refuses, it is never skipped;
//  3. every metric('…') reference names an existing metric;
//  4. the touched set (the physical tables read) is derived and returned.
//
// GateSQL gates author SQL text (the full rule set, binds included).
// gatePlan gates what an expression compiles to: its binds are the
// engine's own positional markers, supplied by Plan.Args, so only the
// statement and table rules apply to it.
//
// A refusal is a *ParseError (the ExprError contract), positioned at the
// offending token where the gate knows one.

// reservedBinds are the only bind names an author statement may use; the
// engine supplies each one when the metric runs (GateSQL's supplied set).
var reservedBinds = map[string]bool{":match_id": true, ":steam_id": true, ":round": true}

// Gate is what an accepted author statement yields.
type Gate struct {
	// Touched is the physical tables read: lower-case, sorted, distinct.
	// Empty (non-nil) when the statement reads none.
	Touched []string
	// Refs is every metric('…') reference in textual order (Pos is the
	// quoted literal's offset).
	Refs []MetricRef
}

// RefLookup reports whether a metric with this name exists (any origin).
type RefLookup func(name string) (bool, error)

// GateSQL gates one author SQL statement. supplied names the binds the
// engine provides for this run (a subset of the reserved binds). Returns
// (*ParseError, nil) for a refusal and (nil, err) for a lookup failure.
//
// Bind rule: an author statement may carry only the reserved binds
// :match_id, :steam_id and :round. Positional `?` and any other name are
// refused, and a reserved bind the engine does not supply is refused.
func GateSQL(sql string, exists RefLookup, supplied map[string]bool) (Gate, *ParseError, error) {
	st, gerr := store.AnalyzeMetricSQL(sql, nil)
	if gerr != nil {
		return Gate{}, &ParseError{Message: gerr.Message, Pos: gerr.Pos}, nil
	}
	for _, b := range st.Binds {
		if !reservedBinds[b] {
			return Gate{}, errf(0, "bind %s isn't available in a metric (the bind names are :match_id, :steam_id and :round)", b), nil
		}
		if !supplied[b] {
			return Gate{}, errf(0, "bind %s isn't supplied by this metric's run", b), nil
		}
	}
	g := Gate{Touched: st.Touched}
	for _, r := range st.Refs {
		ok, err := exists(r.Name)
		if err != nil {
			return Gate{}, nil, err
		}
		if !ok {
			// The same copy the expression compiler reports.
			return Gate{}, errf(r.Pos, "unknown metric reference %q", r.Name), nil
		}
		g.Refs = append(g.Refs, MetricRef{Name: r.Name, Pos: r.Pos})
	}
	return g, nil, nil
}

// gatePlan gates a compiled plan's statements (SQL and the companion
// Secondary when present), records their touched set on the plan and
// refuses any statement it cannot resolve. refAliases is the compiler's
// ref name → join alias map: the aliases under which the statement reads
// stored values for references the compiler has already resolved.
func gatePlan(plan *Plan, refAliases map[string]string) *ParseError {
	aliases := make(map[string]bool, len(refAliases))
	for _, a := range refAliases {
		aliases[a] = true
	}
	touched := map[string]bool{}
	for _, q := range []string{plan.SQL, plan.Secondary} {
		if q == "" {
			continue
		}
		st, gerr := store.AnalyzeMetricSQL(q, aliases)
		if gerr != nil {
			// The grammar only emits allowlisted sources, so this is an
			// engine defect, reported statement-level (the offset is in
			// the compiled text, not the expression).
			return errf(0, "this metric's statement can't be checked: %s", gerr.Message)
		}
		if len(st.Refs) > 0 {
			return errf(0, "this metric's statement can't be checked: unexpected metric() in the compiled text")
		}
		for _, t := range st.Touched {
			touched[t] = true
		}
	}
	plan.Touched = make([]string, 0, len(touched))
	for t := range touched {
		plan.Touched = append(plan.Touched, t)
	}
	sort.Strings(plan.Touched)
	return nil
}
