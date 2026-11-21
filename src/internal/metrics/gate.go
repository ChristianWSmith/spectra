package metrics

import (
	"fmt"

	"github.com/ChristianWSmith/spectra/internal/store"
)

// The metric gate — THE one validation every metric statement passes
// (dogfood/03-QUERIES.md §2–§3), serving the Builder's live check, save
// and the sweep. Every expression is one raw SQL statement; the gate:
//
//  1. one statement, read-only (SELECT or WITH lead), no write verb, so
//     no CREATE and no CREATE VIEW — the console's ValidateReadOnlySQL;
//  2. every table read resolves to the metric-readable allowlist
//     (store.AnalyzeMetricSQL), through comma joins, CTEs, subqueries and
//     quoted names; an unresolvable read refuses, it is never skipped;
//  3. the reserved binds are the only binds, and the run supplies each
//     one the statement uses;
//  4. the touched set (the physical tables read) is derived and returned.
//
// A refusal is a *GateError (the ExprError contract), positioned at the
// offending token where the gate knows one.

// reservedBinds are the only bind names an author statement may use; the
// engine supplies each one when the metric runs (GateSQL's supplied set).
var reservedBinds = map[string]bool{":match_id": true, ":steam_id": true, ":round": true}

// GateError is a gate refusal: a user-facing message plus the byte offset
// it points at (0 = the statement as a whole).
type GateError struct {
	Message string
	Pos     int
}

func (e *GateError) Error() string { return e.Message }

// gateErr builds a positioned refusal.
func gateErr(pos int, format string, args ...any) *GateError {
	return &GateError{Message: fmt.Sprintf(format, args...), Pos: pos}
}

// Gate is what an accepted statement yields.
type Gate struct {
	// Touched is the physical tables read: lower-case, sorted, distinct.
	// Empty (non-nil) when the statement reads none.
	Touched []string
	// Refs is every metric('…') reference in textual order (Pos is the
	// quoted literal's offset).
	Refs []store.MetricSQLRef
	// Binds is every reserved bind the statement uses, in textual order.
	Binds []string
}

// RefLookup reports whether a metric with this name exists (any origin).
type RefLookup func(name string) (bool, error)

// GateSQL gates one statement. supplied names the binds the engine
// provides for this run (a subset of the reserved binds). Returns
// (*GateError, nil) for a refusal and (nil, err) for a lookup failure.
//
// Bind rule: a statement may carry only the reserved binds :match_id,
// :steam_id and :round. Positional `?` and any other name are refused,
// and a reserved bind the engine does not supply is refused.
func GateSQL(sql string, exists RefLookup, supplied map[string]bool) (Gate, *GateError, error) {
	st, gerr := store.AnalyzeMetricSQL(sql, nil)
	if gerr != nil {
		return Gate{}, &GateError{Message: gerr.Message, Pos: gerr.Pos}, nil
	}
	for _, b := range st.Binds {
		if !reservedBinds[b] {
			return Gate{}, gateErr(0, "bind %s isn't available in a metric (the bind names are :match_id, :steam_id and :round)", b), nil
		}
		if !supplied[b] {
			return Gate{}, gateErr(0, "bind %s isn't supplied by this metric's run", b), nil
		}
	}
	g := Gate{Touched: st.Touched, Binds: st.Binds}
	for _, r := range st.Refs {
		ok, err := exists(r.Name)
		if err != nil {
			return Gate{}, nil, err
		}
		if !ok {
			return Gate{}, gateErr(r.Pos, "unknown metric reference %q", r.Name), nil
		}
		g.Refs = append(g.Refs, r)
	}
	return g, nil, nil
}
